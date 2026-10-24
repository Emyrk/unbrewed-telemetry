import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { homeActivity, quietRun } from '../src/stats/home-activity.js';
import type { GameSubmission } from '../src/types.js';
import { sampleGame } from './fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describe('homeActivity (pure)', () => {
  it('zero-fills 7x24, ranks the top 3 slots and finds the circular quiet run', () => {
    const rows = [
      { dow: 1, hour: 15, n: 5 },
      { dow: 2, hour: 15, n: 5 },
      { dow: 3, hour: 22, n: 9 },
      { dow: 4, hour: 22, n: 1 },
    ];
    const r = homeActivity(rows, 'human', new Date('2026-10-26T00:00:00Z'));
    expect(r.grid).toHaveLength(7);
    expect(r.grid.every((row) => row.length === 24)).toBe(true);
    expect(r.total).toBe(20);
    expect(r.peak).toEqual([{ dow: 3, hour: 22, n: 9 }, { dow: 1, hour: 15, n: 5 }, { dow: 2, hour: 15, n: 5 }]);
    // hours 16..21 and 23..14 are all empty; the wrap-around run 23..14 is longest (16 hours)
    expect(r.quiet).toEqual({ startHour: 23, endHour: 14, hours: 16 });
    expect(r.unit).toBe('games');
  });

  it('has no quiet run without games', () => {
    expect(quietRun(Array.from({ length: 7 }, () => new Array(24).fill(0)))).toBeNull();
  });
});

describeDb('GET /api/home/activity (#96)', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  let server: Server;
  let baseUrl: string;
  // Monday, the day after the EU DST change (2026-10-25 01:00 UTC).
  const now = new Date('2026-10-26T12:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    server = createServer(createApp({
      repo,
      cpRepo: new ControlPlaneRepository(pool),
      config: {
        telemetrySecret: '',
        accountsReadToken: 'x',
        allowUnauthenticatedIngest: true,
        bodyLimitBytes: 1024 * 1024,
        replayBodyLimitBytes: 2 * 1024 * 1024,
        now: () => now,
        discordClientId: '',
        discordClientSecret: '',
        discordRedirectUri: '',
        adminDiscordIds: [],
        secureCookies: false,
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE game_submissions, sim_campaigns CASCADE');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await pool.end();
  });

  async function ingest(id: string, endedAt: string, pilots: [string, string], campaignId: string | null = null): Promise<void> {
    const base = sampleGame({ gameId: id, stateHash: id, endedAt });
    const game: GameSubmission = {
      ...base,
      teams: base.teams.map((team, i) => ({
        seats: team.seats.map((seat) => ({ ...seat, pilot: pilots[i]!, botDifficulty: pilots[i]!.startsWith("bot:") ? pilots[i]!.slice(4) : undefined })),
      })) as unknown as GameSubmission["teams"],
    };
    const result = await repo.ingestValid({
      payload: game,
      idempotencyKey: id,
      receivedAt: new Date(endedAt),
      authKeyId: 'test',
      campaignId,
      campaignGameIndex: campaignId ? 0 : null,
    });
    expect(result.kind).toBe('created');
  }

  async function activity(query = ''): Promise<any> {
    const res = await fetch(`${baseUrl}/api/home/activity${query}`);
    expect(res.status).toBe(200);
    return res.json();
  }

  async function seed(): Promise<void> {
    await pool.query(`INSERT INTO sim_campaigns (id, name, spec, total_games, created_by) VALUES ('c1', 'c', '{}', 1, 't')`);
    // Midnight boundary: Sat 23:59:59 vs Sun 00:00:00 land on different days.
    await ingest('sat-2359', '2026-10-24T23:59:59.000Z', ['human', 'bot:hard']);
    await ingest('sun-0000', '2026-10-25T00:00:00.000Z', ['human', 'human']);
    // EU DST ends at 01:00 UTC: UTC buckets must not shift across it.
    await ingest('sun-0059', '2026-10-25T00:59:59.000Z', ['bot:hard', 'human']);
    await ingest('sun-0100', '2026-10-25T01:00:00.000Z', ['human', 'bot:hard']);
    await ingest('sun-0130', '2026-10-25T01:30:00.000Z', ['human', 'bot:hard']);
    // Bot-only and sim games: only scope=all sees them.
    await ingest('bots-mon', '2026-10-26T09:00:00.000Z', ['bot:hard', 'bot:easy']);
    await ingest('sim-mon', '2026-10-26T10:00:00.000Z', ['human', 'bot:hard'], 'c1');
    // Window edge: 28 days before `now` is in, a minute earlier is out.
    await ingest('edge-in', '2026-09-28T12:00:00.000Z', ['human', 'bot:hard']);
    await ingest('edge-out', '2026-09-28T11:59:00.000Z', ['human', 'bot:hard']);
  }

  it('buckets by UTC day-of-week and hour across a midnight boundary and a DST change', async () => {
    await seed();
    const body = await activity();
    expect(body).toMatchObject({ ok: true, scope: 'human', unit: 'games', days: 28, total: 6 });
    expect(body.grid[6][23]).toBe(1); // Saturday 23:59:59
    expect(body.grid[0][0]).toBe(2); // Sunday 00:00:00 and 00:59:59
    expect(body.grid[0][1]).toBe(2); // Sunday 01:00:00 and 01:30:00 (post-DST)
    expect(body.grid[1][12]).toBe(1); // Monday 2026-09-28 12:00 (window edge)
    expect(body.peak).toEqual([
      { dow: 0, hour: 0, n: 2 },
      { dow: 0, hour: 1, n: 2 },
      { dow: 1, hour: 12, n: 1 },
    ]);
  });

  it('excludes sim and bot-only games by default, includes them with scope=all', async () => {
    await seed();
    const all = await activity('?scope=all');
    expect(all.total).toBe(8);
    expect(all.grid[1][9]).toBe(1); // bot-only Monday 09:00
    expect(all.grid[1][10]).toBe(1); // sim Monday 10:00
    const human = await activity('?scope=human');
    expect(human.grid[1][9]).toBe(0);
    expect(human.grid[1][10]).toBe(0);
  });

  it('ignores lens parameters and rejects an unknown scope', async () => {
    await seed();
    const plain = await activity();
    const lensed = await activity('?format=2v2&deck=king-kong&map=nowhere&pilots=bot&range=7');
    expect(lensed.grid).toEqual(plain.grid);
    const bad = await fetch(`${baseUrl}/api/home/activity?scope=bogus`);
    expect(bad.status).toBe(400);
  });
});
