/**
 * Campaign win-rate view (#248 delta on the control plane) — DB-backed, gated on
 * TEST_DATABASE_URL like the rest of the suite. Proves the read endpoint folds a
 * campaign's completed games into per-pilot win rates with Wilson CIs, and that
 * the credential-provisioning helper mints a working bearer key end-to-end.
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
  telemetrySecret: 'unused',
  allowUnauthenticatedIngest: true,
  bodyLimitBytes: 1024 * 1024,
  now: () => now,
  discordClientId: '',
  discordClientSecret: '',
  discordRedirectUri: '',
  adminDiscordIds: [],
  secureCookies: false,
});

describeDb('campaign progress view', () => {
  let pool: Pool;
  let cpRepo: ControlPlaneRepository;
  let repo: PgTelemetryRepository;
  let server: Server;
  let baseUrl: string;
  const now = new Date('2026-07-22T12:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    cpRepo = new ControlPlaneRepository(pool);
    server = createServer(createApp({ repo, cpRepo, config: appConfig(now) }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE sim_campaigns, telemetry_sources, game_submissions CASCADE');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await pool.end();
  });

  it('provisioning mints a working bearer key; progress folds games into per-pilot Wilson CIs', async () => {
    // Provision a credential the way scripts/seed-sim-credentials.mts does.
    const source = await cpRepo.createSource('sim-fleet-test', null, 'test');
    const cred = await cpRepo.createCredential(source.id, 'sim-fleet:host', ['sim:claim', 'sim:complete', 'games:submit'], 'test');
    expect(cred.fullKey).toMatch(/^ubk_[0-9a-f]+\.[0-9a-f]+$/);

    // A campaign of two games; ISMCTS (seat A) beats MC (seat B) in both.
    const campaign = await cpRepo.createCampaign({
      name: 'arm1-test', spec: { note: 'test' }, baseSeed: 20000,
      games: [{ spec: { step: 'arm1' } }, { spec: { step: 'arm1' } }], createdBy: 'test',
    });

    // Ingest two campaign games via the bearer credential's /v1/sim/complete path:
    // claim jobs, then complete each with a full submission tagged to the campaign.
    const claim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.fullKey}` },
      body: JSON.stringify({ campaignId: campaign.id, count: 2 }),
    });
    const { jobs } = (await claim.json()) as { jobs: Array<{ id: string; leaseToken: string }> };
    expect(jobs).toHaveLength(2);

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      const game = ismctsBeatsMcGame(i);
      const res = await fetch(`${baseUrl}/v1/sim/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.fullKey}` },
        body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken, game }),
      });
      expect([200, 201]).toContain(res.status);
    }

    const prog = await fetch(`${baseUrl}/v1/sim/campaigns/${campaign.id}/progress`, {
      headers: { authorization: `Bearer ${cred.fullKey}` },
    });
    expect(prog.status).toBe(200);
    const body = (await prog.json()) as {
      ok: boolean; completedGames: number; totalGames: number; mixedContentVersion: boolean;
      pilots: Array<{ pilot: string; games: number; wins: number; wilson95: [number, number] }>;
    };
    expect(body.ok).toBe(true);
    expect(body.totalGames).toBe(2);
    expect(body.completedGames).toBe(2);
    expect(body.mixedContentVersion).toBe(false);
    const ismcts = body.pilots.find((p) => p.pilot === 'bot:ismcts')!;
    const mc = body.pilots.find((p) => p.pilot === 'bot:mc')!;
    expect(ismcts.games).toBe(2);
    expect(ismcts.wins).toBe(2);
    expect(mc.wins).toBe(0);
    expect(ismcts.wilson95).toHaveLength(2);
  });

  it('404s an unknown campaign and 401s without a key', async () => {
    const source = await cpRepo.createSource('sim-fleet-test2', null, 'test');
    const cred = await cpRepo.createCredential(source.id, 'h', ['sim:claim'], 'test');
    const missing = await fetch(`${baseUrl}/v1/sim/campaigns/nope/progress`, { headers: { authorization: `Bearer ${cred.fullKey}` } });
    expect(missing.status).toBe(404);
    const noauth = await fetch(`${baseUrl}/v1/sim/campaigns/nope/progress`);
    expect(noauth.status).toBe(401);
  });
});

/** A valid, UNIQUE submission where seat A (bot:ismcts) beats seat B (bot:mc). */
function ismctsBeatsMcGame(n: number): unknown {
  return sampleGame({
    gameId: `sim-progress-game-${n}`,
    stateHash: `sim-progress-state-${n}`,
    teams: [
      { seats: [{ deck: 'king-kong@0.1.0', pilot: 'bot:ismcts', runtimePlayerId: 'p1', heroId: 'king-kong', finalHealth: 7 }] },
      { seats: [{ deck: 'thrall@0.1.0', pilot: 'bot:mc', runtimePlayerId: 'p2', heroId: 'thrall', finalHealth: 0 }] },
    ],
    winner: 0,
  });
}
