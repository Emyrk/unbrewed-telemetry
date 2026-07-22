/**
 * Public "Road to Expert+" journey (#248) — DB-backed, gated on TEST_DATABASE_URL.
 * Proves the endpoint needs NO auth, returns experiment aggregates only, folds a
 * campaign's games into a hero win rate + Wilson CI, and that the page serves.
 */

import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { sampleGame } from './fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const appConfig = (now: Date) => ({
  telemetrySecret: 'unused', allowUnauthenticatedIngest: true, bodyLimitBytes: 1024 * 1024, now: () => now,
  discordClientId: '', discordClientSecret: '', discordRedirectUri: '', adminDiscordIds: [], secureCookies: false,
});

describeDb('public journey', () => {
  let pool: Pool;
  let cp: ControlPlaneRepository;
  let repo: PgTelemetryRepository;
  let server: Server;
  let baseUrl: string;
  const now = new Date('2026-07-22T12:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    cp = new ControlPlaneRepository(pool);
    server = createServer(createApp({ repo, cpRepo: cp, config: appConfig(now) }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const a = server.address();
    if (!a || typeof a === 'string') throw new Error('expected TCP');
    baseUrl = `http://127.0.0.1:${a.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE sim_campaigns, telemetry_sources, game_submissions CASCADE');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await pool.end();
  });

  it('serves the journey with NO auth, folding campaign games into a hero win rate + CI', async () => {
    // arm1 campaign with 2 completed games (ismcts beats mc both times).
    const src = await cp.createSource('sim-fleet-journey', null, 't');
    const cred = await cp.createCredential(src.id, 'h', ['sim:claim', 'sim:complete', 'games:submit'], 't');
    const arm1 = await cp.createCampaign({ name: 'arm1', spec: {}, baseSeed: 20000, games: [{ spec: {} }, { spec: {} }], createdBy: 't' });
    const claim = await fetch(`${baseUrl}/v1/sim/claim`, { method: 'POST', headers: { authorization: `Bearer ${cred.fullKey}` }, body: JSON.stringify({ campaignId: arm1.id, count: 2 }) });
    const { jobs } = (await claim.json()) as { jobs: Array<{ id: string; leaseToken: string }> };
    for (let i = 0; i < jobs.length; i++) {
      const game = sampleGame({
        gameId: `j-${i}`, stateHash: `j-${i}`,
        teams: [{ seats: [{ deck: 'king-kong@0.1.0', pilot: 'bot:ismcts', runtimePlayerId: 'p1', heroId: 'king-kong', finalHealth: 5 }] },
                { seats: [{ deck: 'thrall@0.1.0', pilot: 'bot:mc', runtimePlayerId: 'p2', heroId: 'thrall', finalHealth: 0 }] }],
        winner: 0,
      });
      await fetch(`${baseUrl}/v1/sim/complete`, { method: 'POST', headers: { authorization: `Bearer ${cred.fullKey}` }, body: JSON.stringify({ jobId: jobs[i]!.id, leaseToken: jobs[i]!.leaseToken, game }) });
    }

    // NO Authorization header — the journey is public.
    const res = await fetch(`${baseUrl}/v1/sim/public/journey`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; steps: Array<{ name: string; found: boolean; hero: { pilot: string; wins: number; games: number; wilson95: [number, number] } | null; completedGames: number }> };
    expect(body.ok).toBe(true);
    // default mission order includes grid, arm1, arm2, arm3, arm5, mirror, cost
    expect(body.steps.map((s) => s.name)).toEqual(['grid', 'arm1', 'arm2', 'arm3', 'arm5', 'mirror', 'cost']);
    const g = body.steps.find((s) => s.name === 'grid')!;
    expect(g.found).toBe(false); // no grid campaign yet → pending
    const a1 = body.steps.find((s) => s.name === 'arm1')!;
    expect(a1.completedGames).toBe(2);
    expect(a1.hero?.pilot).toBe('bot:ismcts');
    expect(a1.hero?.wins).toBe(2);
    expect(a1.hero?.wilson95).toHaveLength(2);
  });

  it('accepts a custom ?campaigns list and serves the static page', async () => {
    const res = await fetch(`${baseUrl}/v1/sim/public/journey?campaigns=arm1,mirror`);
    const body = (await res.json()) as { steps: Array<{ name: string }> };
    expect(body.steps.map((s) => s.name)).toEqual(['arm1', 'mirror']);

    const page = await fetch(`${baseUrl}/road-to-expert`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Road to Expert+');
  });
});
