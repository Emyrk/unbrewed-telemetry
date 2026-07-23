/**
 * Crash-resume journal checkpoints on sim jobs (engine #255) — DB-backed,
 * gated on TEST_DATABASE_URL like the rest of the suite.
 *
 * The worker piggybacks its per-decision action journal on the lease heartbeat;
 * the control plane stores it on the job row and hands it back in the claim
 * response, so a hard-killed worker's game can be resumed by whichever
 * same-build machine claims the job next. Pinned here:
 *
 *   * heartbeat with `journal` stores it; the next claim (after lease expiry)
 *     returns it verbatim;
 *   * the journal is only accepted from the current lease holder;
 *   * oversized journals are dropped (`journalStored: false`) while the lease
 *     renewal still succeeds;
 *   * fail clears the journal (a failed game's journal may be the poison);
 *   * complete deletes the row — and the journal with it.
 */

import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';

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

const CHECKPOINT = {
  v: 1,
  workerVersion: 'build-abc',
  stateHash: '00deadbeef001234',
  entries: [
    { actor: 'p1', action: { type: 'END_TURN' }, rngAfter: 7 },
    { actor: 'p2', action: { type: 'MOVE', to: 'a1' }, rngAfter: 9 },
  ],
};

describeDb('sim job crash-resume journal (engine #255)', () => {
  let pool: Pool;
  let cpRepo: ControlPlaneRepository;
  let repo: PgTelemetryRepository;
  let server: Server;
  let baseUrl: string;
  let bearer: string;
  const now = new Date('2026-07-23T12:00:00.000Z');

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
    const source = await cpRepo.createSource('sim-journal-test', null, 'test');
    const cred = await cpRepo.createCredential(source.id, 'host', ['sim:claim', 'sim:complete'], 'test');
    bearer = cred.fullKey;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await pool.end();
  });

  async function post(path: string, body: unknown, key = bearer): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function makeCampaignWithOneJob(): Promise<string> {
    const campaign = await cpRepo.createCampaign({
      name: 'journal-test', spec: { note: 'test' }, baseSeed: 1000,
      games: [{ spec: { format: 'duel' } }], createdBy: 'test',
    });
    return campaign.id;
  }

  async function claimOne(campaignId: string, leaseDurationMs?: number): Promise<{ id: string; leaseToken: string; journal?: unknown }> {
    const { status, json } = await post('/v1/sim/claim', {
      campaignId, count: 1, ...(leaseDurationMs ? { leaseDurationMs } : {}),
    });
    expect(status).toBe(200);
    expect(json.jobs).toHaveLength(1);
    return json.jobs[0];
  }

  async function expireLease(jobId: string): Promise<void> {
    // Simulate the hard-kill aftermath: the lease runs out with no release.
    await pool.query(`UPDATE sim_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
  }

  it('stores the heartbeated journal and returns it on the next claim after a hard kill', async () => {
    const campaignId = await makeCampaignWithOneJob();
    const job = await claimOne(campaignId);
    expect(job.journal).toBeUndefined(); // first claim: nothing to resume

    const hb = await post('/v1/sim/heartbeat', { jobId: job.id, leaseToken: job.leaseToken, journal: CHECKPOINT });
    expect(hb.status).toBe(200);
    expect(hb.json.journalStored).toBe(true);

    // kill -9: no release, lease expires, another machine claims.
    await expireLease(job.id);
    const reclaimed = await claimOne(campaignId);
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.leaseToken).not.toBe(job.leaseToken);
    expect(reclaimed.journal).toEqual(CHECKPOINT);
  });

  it('a heartbeat without a journal leaves the stored checkpoint untouched', async () => {
    const campaignId = await makeCampaignWithOneJob();
    const job = await claimOne(campaignId);
    await post('/v1/sim/heartbeat', { jobId: job.id, leaseToken: job.leaseToken, journal: CHECKPOINT });
    const hb = await post('/v1/sim/heartbeat', { jobId: job.id, leaseToken: job.leaseToken });
    expect(hb.status).toBe(200);
    expect(hb.json.journalStored).toBeUndefined();

    await expireLease(job.id);
    const reclaimed = await claimOne(campaignId);
    expect(reclaimed.journal).toEqual(CHECKPOINT);
  });

  it('rejects a journal from a stale lease token (zombie worker cannot clobber the new holder)', async () => {
    const campaignId = await makeCampaignWithOneJob();
    const job = await claimOne(campaignId);
    await expireLease(job.id);
    const reclaimed = await claimOne(campaignId);

    // The zombie's heartbeat 409s and its journal is NOT stored.
    const zombie = await post('/v1/sim/heartbeat', { jobId: job.id, leaseToken: job.leaseToken, journal: CHECKPOINT });
    expect(zombie.status).toBe(409);
    const row = await pool.query('SELECT journal FROM sim_jobs WHERE id = $1', [reclaimed.id]);
    expect(row.rows[0]!.journal).toBeNull();
  });

  it('drops an oversized journal (journalStored: false) while still renewing the lease', async () => {
    const campaignId = await makeCampaignWithOneJob();
    const job = await claimOne(campaignId, 15_000);
    const before = await pool.query('SELECT lease_expires_at FROM sim_jobs WHERE id = $1', [job.id]);

    const huge = { ...CHECKPOINT, blob: 'x'.repeat(600 * 1024) };
    const hb = await post('/v1/sim/heartbeat', { jobId: job.id, leaseToken: job.leaseToken, leaseDurationMs: 60_000, journal: huge });
    expect(hb.status).toBe(200);
    expect(hb.json.journalStored).toBe(false);

    const after = await pool.query('SELECT journal, lease_expires_at FROM sim_jobs WHERE id = $1', [job.id]);
    expect(after.rows[0]!.journal).toBeNull();
    expect(new Date(after.rows[0]!.lease_expires_at).getTime()).toBeGreaterThan(new Date(before.rows[0]!.lease_expires_at).getTime());
  });

  it('fail clears the journal so a retry never inherits a possibly-poisonous checkpoint', async () => {
    const campaignId = await makeCampaignWithOneJob();
    const job = await claimOne(campaignId);
    await post('/v1/sim/heartbeat', { jobId: job.id, leaseToken: job.leaseToken, journal: CHECKPOINT });

    const fail = await post('/v1/sim/fail', { jobId: job.id, leaseToken: job.leaseToken, error: 'engine crash' });
    expect(fail.status).toBe(200);

    const reclaimed = await claimOne(campaignId);
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.journal).toBeUndefined();
  });
});
