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

  it('folds completed games into matchup-strip cells and a bucketed gate series (#32)', async () => {
    const src = await cp.createSource('sim-fleet-strip', null, 't');
    const cred = await cp.createCredential(src.id, 'strip host', ['sim:claim', 'sim:complete', 'games:submit'], 't');
    const arm1 = await cp.createCampaign({ name: 'arm1', spec: {}, baseSeed: 1, games: [{ spec: {} }, { spec: {} }, { spec: {} }, { spec: {} }], createdBy: 't' });
    const claim = await fetch(`${baseUrl}/v1/sim/claim`, { method: 'POST', headers: { authorization: `Bearer ${cred.fullKey}` }, body: JSON.stringify({ campaignId: arm1.id, count: 4 }) });
    const { jobs } = (await claim.json()) as { jobs: Array<{ id: string; leaseToken: string }> };

    // 2× KK(ismcts) vs Thrall — both hero wins; 2× Mando(ismcts) vs KK — split.
    const plan = [
      { heroDeck: 'king-kong', oppDeck: 'thrall', heroWins: true },
      { heroDeck: 'king-kong', oppDeck: 'thrall', heroWins: true },
      { heroDeck: 'mando', oppDeck: 'king-kong', heroWins: true },
      { heroDeck: 'mando', oppDeck: 'king-kong', heroWins: false },
    ];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]!;
      const game = sampleGame({
        gameId: `strip-${i}`, stateHash: `strip-${i}`,
        teams: [{ seats: [{ deck: `${p.heroDeck}@0.1.0`, pilot: 'bot:ismcts', runtimePlayerId: 'p1', heroId: p.heroDeck, finalHealth: p.heroWins ? 5 : 0 }] },
                { seats: [{ deck: `${p.oppDeck}@0.1.0`, pilot: 'bot:mc', runtimePlayerId: 'p2', heroId: p.oppDeck, finalHealth: p.heroWins ? 0 : 5 }] }],
        winner: p.heroWins ? 0 : 1,
      });
      await fetch(`${baseUrl}/v1/sim/complete`, { method: 'POST', headers: { authorization: `Bearer ${cred.fullKey}` }, body: JSON.stringify({ jobId: jobs[i]!.id, leaseToken: jobs[i]!.leaseToken, game }) });
    }

    const res = await fetch(`${baseUrl}/v1/sim/public/journey?campaigns=arm1`);
    const body = (await res.json()) as {
      minVerdictGames: number;
      steps: Array<{
        status: string; verdictReady: boolean;
        matchups: Array<{ heroDeck: string; oppDeck: string; games: number; wins: number; rate: number; wilson95: [number, number] }>;
        gateSeries: Array<{ n: number; wins: number; rate: number; wilson95: [number, number] }>;
        hero: { games: number } | null;
      }>;
    };
    const a1 = body.steps[0]!;

    // Matchup strip: one aggregate cell per pairing, hero-side, with Wilson CIs.
    expect(a1.matchups).toHaveLength(2);
    const kkThrall = a1.matchups.find((m) => m.heroDeck === 'king-kong')!;
    expect(kkThrall).toMatchObject({ oppDeck: 'thrall', games: 2, wins: 2, rate: 1 });
    const mandoKk = a1.matchups.find((m) => m.heroDeck === 'mando')!;
    expect(mandoKk).toMatchObject({ oppDeck: 'king-kong', games: 2, wins: 1, rate: 0.5 });
    for (const m of a1.matchups) {
      expect(m.wilson95[0]).toBeGreaterThanOrEqual(0);
      expect(m.wilson95[1]).toBeLessThanOrEqual(1);
      expect(m.wilson95[0]).toBeLessThanOrEqual(m.rate);
      expect(m.wilson95[1]).toBeGreaterThanOrEqual(m.rate);
    }

    // Gate series: cumulative, ordered, capped, ends at the hero's total games.
    expect(a1.gateSeries).toHaveLength(4);
    expect(a1.gateSeries.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    const last = a1.gateSeries[a1.gateSeries.length - 1]!;
    expect(last.n).toBe(a1.hero!.games);
    expect(last.wins).toBe(3);
    expect(last.rate).toBeCloseTo(0.75, 10);
    for (let i = 1; i < a1.gateSeries.length; i++) {
      expect(a1.gateSeries[i]!.wins).toBeGreaterThanOrEqual(a1.gateSeries[i - 1]!.wins);
    }

    // 4 games < 50 → warming up, and the threshold is part of the payload.
    expect(body.minVerdictGames).toBe(50);
    expect(a1.verdictReady).toBe(false);
    // The arm is finished (all jobs consumed) yet strip + series remain served.
    expect(a1.status).toBe('completed');
  });

  it('reports the in-flight pulse from checkpoints and tolerates jobs without one (#32)', async () => {
    const src = await cp.createSource('sim-fleet-pulse', null, 't');
    const cred = await cp.createCredential(src.id, 'pulse host', ['sim:claim', 'sim:complete', 'games:submit'], 't');
    const arm1 = await cp.createCampaign({ name: 'arm1', spec: {}, baseSeed: 2, games: [{ spec: {} }, { spec: {} }, { spec: {} }], createdBy: 't' });
    const claim = await fetch(`${baseUrl}/v1/sim/claim`, { method: 'POST', headers: { authorization: `Bearer ${cred.fullKey}` }, body: JSON.stringify({ campaignId: arm1.id, count: 3 }) });
    const { jobs } = (await claim.json()) as { jobs: Array<{ id: string; leaseToken: string }> };

    const beat = (jobId: string, leaseToken: string, entries: number) =>
      fetch(`${baseUrl}/v1/sim/heartbeat`, {
        method: 'POST', headers: { authorization: `Bearer ${cred.fullKey}` },
        body: JSON.stringify({ jobId, leaseToken, checkpoint: { engineVersion: '1.0.0', journal: { entries: Array.from({ length: entries }, (_, i) => ({ i })) } } }),
      });
    await beat(jobs[0]!.id, jobs[0]!.leaseToken, 5);
    await beat(jobs[1]!.id, jobs[1]!.leaseToken, 11);
    // jobs[2] never checkpoints (just claimed / pre-checkpoint worker).

    const res = await fetch(`${baseUrl}/v1/sim/public/journey?campaigns=arm1`);
    const body = (await res.json()) as { steps: Array<{ inFlight: { jobs: number; reporting: number; medianDecisions: number | null; maxDecisions: number | null } | null; leasedJobs: number }> };
    const a1 = body.steps[0]!;
    expect(a1.leasedJobs).toBe(3);
    expect(a1.inFlight).toEqual({ jobs: 3, reporting: 2, medianDecisions: 8, maxDecisions: 11 });
  });

  it('surfaces live workers by credential label with a newest-build flag, never key ids (#32)', async () => {
    const src = await cp.createSource('sim-fleet-workers', null, 't');
    const rig = await cp.createCredential(src.id, 'gaming rig', ['sim:claim'], 't');
    const laptop = await cp.createCredential(src.id, 'old laptop', ['sim:claim'], 't');
    // laptop started first on v1; rig started later on v2 → rig is the newest build.
    await cp.touchWorkerSession(laptop.id, new Date(now.getTime() - 10 * 60 * 1000), { workerVersion: 'v1' });
    await cp.touchWorkerSession(rig.id, new Date(now.getTime() - 60 * 1000), { workerVersion: 'v2' });

    const res = await fetch(`${baseUrl}/v1/sim/public/journey?campaigns=arm1`);
    const raw = await res.text();
    expect(raw).not.toContain('ubk_');
    expect(raw).not.toContain(rig.id);
    const body = JSON.parse(raw) as { workers: Array<{ label: string; jobs: number; heartbeatAgeSeconds: number; latestBuild: boolean }> };
    expect(body.workers).toHaveLength(2);
    const byLabel = Object.fromEntries(body.workers.map((w) => [w.label, w]));
    expect(byLabel['gaming rig']).toMatchObject({ jobs: 0, latestBuild: true });
    expect(byLabel['gaming rig']!.heartbeatAgeSeconds).toBe(60);
    expect(byLabel['old laptop']).toMatchObject({ jobs: 0, latestBuild: false });
    expect(byLabel['old laptop']!.heartbeatAgeSeconds).toBe(600);

    // A session outside the 15-minute window disappears from the chips.
    await pool.query('UPDATE sim_worker_sessions SET last_heartbeat_at = $1', [new Date(now.getTime() - 16 * 60 * 1000)]);
    const gone = (await (await fetch(`${baseUrl}/v1/sim/public/journey?campaigns=arm1`)).json()) as { workers: unknown[] };
    expect(gone.workers).toEqual([]);
  });

  it('returns empty aggregates for zero games, zero workers, and unknown campaigns (#32)', async () => {
    const arm1 = await cp.createCampaign({ name: 'arm1', spec: {}, baseSeed: 3, games: [{ spec: {} }], createdBy: 't' });
    void arm1;
    const res = await fetch(`${baseUrl}/v1/sim/public/journey?campaigns=arm1,grid`);
    const body = (await res.json()) as {
      workers: unknown[];
      steps: Array<{ name: string; found: boolean; hero: unknown; verdictReady: boolean; matchups: unknown[]; gateSeries: unknown[]; inFlight: { jobs: number; medianDecisions: number | null } | null }>;
    };
    const [a1, grid] = [body.steps[0]!, body.steps[1]!];
    expect(a1.found).toBe(true);
    expect(a1.hero).toBeNull();
    expect(a1.verdictReady).toBe(false);
    expect(a1.matchups).toEqual([]);
    expect(a1.gateSeries).toEqual([]);
    expect(a1.inFlight).toEqual({ jobs: 0, reporting: 0, medianDecisions: null, maxDecisions: null });
    expect(grid.found).toBe(false);
    expect(grid.inFlight).toBeNull();
    expect(body.workers).toEqual([]);
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
