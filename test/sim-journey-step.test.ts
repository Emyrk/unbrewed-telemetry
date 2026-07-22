/**
 * Expanded per-step journey detail (#248 follow-up) — DB-backed, gated on
 * TEST_DATABASE_URL. Uses a MULTI-HOST fixture (two credentials completing games)
 * so the contributor rows and the chunk strip render with 2 hosts, plus the arm1
 * gate math. Public, no auth, experiment aggregates only.
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

describeDb('journey step detail (multi-host)', () => {
  let pool: Pool;
  let cp: ControlPlaneRepository;
  let server: Server;
  let baseUrl: string;
  const now = new Date('2026-07-22T12:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    server = createServer(createApp({ repo: new PgTelemetryRepository(pool), cpRepo: cp = new ControlPlaneRepository(pool), config: appConfig(now) }));
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

  async function completeWith(key: string, campaignId: string, count: number, base: number): Promise<number> {
    const claim = await fetch(`${baseUrl}/v1/sim/claim`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ campaignId, count }) });
    const { jobs } = (await claim.json()) as { jobs: Array<{ id: string; gameIndex: number; leaseToken: string }> };
    let ok = 0;
    for (const job of jobs) {
      const win = (base + job.gameIndex) % 3 === 0 ? 1 : 0; // ismcts wins ~2/3
      const game = sampleGame({
        gameId: `g-${campaignId.slice(0, 4)}-${job.gameIndex}`, stateHash: `s-${campaignId.slice(0, 4)}-${job.gameIndex}`,
        teams: [{ seats: [{ deck: 'king-kong@0.1.0', pilot: 'bot:ismcts', runtimePlayerId: 'p1', heroId: 'king-kong', finalHealth: win === 0 ? 5 : 0 }] },
                { seats: [{ deck: 'thrall@0.1.0', pilot: 'bot:mc', runtimePlayerId: 'p2', heroId: 'thrall', finalHealth: win === 1 ? 5 : 0 }] }],
        winner: win,
      });
      const r = await fetch(`${baseUrl}/v1/sim/complete`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken, game }) });
      if (r.ok) ok++;
    }
    return ok;
  }

  it('renders per-host contributors, a chunk strip, and the gate math with two hosts', async () => {
    const src = await cp.createSource('sim-fleet', null, 't');
    const credA = await cp.createCredential(src.id, 'sim-fleet:host-a', ['sim:claim', 'sim:complete', 'games:submit'], 't');
    const credB = await cp.createCredential(src.id, 'sim-fleet:host-b', ['sim:claim', 'sim:complete', 'games:submit'], 't');
    const arm1 = await cp.createCampaign({ name: 'arm1', spec: {}, baseSeed: 20000, games: Array.from({ length: 24 }, () => ({ spec: {} })), createdBy: 't' });

    const a = await completeWith(credA.fullKey, arm1.id, 8, 0);
    const b = await completeWith(credB.fullKey, arm1.id, 6, 1);
    // Leave a few jobs leased (in-flight) by host-a.
    await fetch(`${baseUrl}/v1/sim/claim`, { method: 'POST', headers: { authorization: `Bearer ${credA.fullKey}` }, body: JSON.stringify({ campaignId: arm1.id, count: 4 }) });
    expect(a + b).toBe(14);

    const res = await fetch(`${baseUrl}/v1/sim/public/journey/step?campaign=arm1`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as {
      ok: boolean; found: boolean; completedGames: number; leasedJobs: number;
      hero: { pilot: string } | null; chunkStrip: Array<{ done: number; total: number }>;
      hosts: Array<{ host: string; gamesDone: number; sharePct: number }>;
      gate: { needGames: number; currentGames: number; sentence: string } | null;
      contentVersions: string[];
    };
    expect(d.found).toBe(true);
    expect(d.completedGames).toBe(14);
    expect(d.leasedJobs).toBe(4);
    expect(d.hero?.pilot).toBe('bot:ismcts');
    // Two contributing hosts, labelled by credential.
    expect(d.hosts.map((h) => h.host).sort()).toEqual(['sim-fleet:host-a', 'sim-fleet:host-b']);
    expect(d.hosts.reduce((s, h) => s + h.gamesDone, 0)).toBe(14);
    expect(Math.round(d.hosts.reduce((s, h) => s + h.sharePct, 0))).toBe(100);
    // Chunk strip has squares with some done and some pending/leased.
    expect(d.chunkStrip.length).toBeGreaterThan(0);
    expect(d.chunkStrip.reduce((s, c) => s + c.done, 0)).toBe(14);
    // Gate math sentence for arm1.
    expect(d.gate?.needGames).toBe(1000);
    expect(d.gate?.currentGames).toBe(14);
    expect(d.gate?.sentence).toContain('≥1000 games');
  });

  it('missing campaign returns not-found detail; missing param is 400', async () => {
    const res = await fetch(`${baseUrl}/v1/sim/public/journey/step?campaign=nope`);
    const d = (await res.json()) as { ok: boolean; found: boolean };
    expect(res.status).toBe(200);
    expect(d.found).toBe(false);
    const bad = await fetch(`${baseUrl}/v1/sim/public/journey/step`);
    expect(bad.status).toBe(400);
  });
});
