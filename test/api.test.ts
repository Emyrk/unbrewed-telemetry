import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { signBody } from '../src/http/auth.js';
import { fingerprintFor, sampleBotExecution, sampleCanonicalRules, sampleGame } from './fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('telemetry api with postgres', () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let cpRepo: ControlPlaneRepository;
  const secret = 'test-secret';
  const now = new Date('2026-07-14T16:30:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    const repo = new PgTelemetryRepository(pool);
    cpRepo = new ControlPlaneRepository(pool);
    server = createServer(createApp({
      repo,
      cpRepo,
      config: {
        telemetrySecret: secret,
        allowUnauthenticatedIngest: false,
        bodyLimitBytes: 1024 * 1024,
        now: () => now,
        discordClientId: '',
        discordClientSecret: '',
        discordRedirectUri: '',
        adminDiscordIds: ['admin-123'],
        secureCookies: false,
        accountsReadToken: '',
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE game_submissions, deck_definitions CASCADE');
    await pool.query('TRUNCATE admin_sessions, telemetry_sources, source_credentials, sim_campaigns, sim_jobs CASCADE');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it('serves healthz', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it('serves the dashboard shell and assets', async () => {
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('Deck Balance Tracker');

    const page = await fetch(`${baseUrl}/dashboard`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Deck Balance Tracker');

    const script = await fetch(`${baseUrl}/assets/dashboard.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
  });

  it('requires signatures for ingest', async () => {
    const response = await fetch(`${baseUrl}/v1/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleGame()),
    });
    expect(response.status).toBe(401);
  });

  it('protects admin APIs with an allowlisted Discord session', async () => {
    const denied = await fetch(`${baseUrl}/v1/admin/sources`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(denied.status).toBe(401);

    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const allowed = await fetch(`${baseUrl}/v1/admin/sources`, {
      headers: { cookie: `session=${session.id}` },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ ok: true, sources: [] });
  });

  it('tracks idle heartbeats and exposes the admin fleet dashboard', async () => {
    const source = await cpRepo.createSource('fleet-api', null, 'test-admin');
    const credential = await cpRepo.createCredential(
      source.id,
      'worker-api',
      ['games:submit', 'sim:claim', 'sim:complete'],
      'test-admin',
    );

    const heartbeat = await fetch(`${baseUrl}/v1/sim/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ concurrency: 2, workerVersion: 'worker-test-1' }),
    });
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = await heartbeat.json() as { sessionId: string; leaseExpiresAt: string | null };
    expect(heartbeatBody.sessionId).toBeTruthy();
    expect(heartbeatBody.leaseExpiresAt).toBeNull();

    await pool.query(
      `UPDATE sim_worker_sessions SET started_at = $2 WHERE id = $1`,
      [heartbeatBody.sessionId, new Date(now.getTime() - 30 * 60 * 1000)],
    );
    const campaign = await cpRepo.createCampaign({
      name: 'Fleet API Campaign', spec: { format: 'duel' }, games: [{}, {}], createdBy: 'test-admin',
    });
    const claim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, count: 2, sessionId: heartbeatBody.sessionId, concurrency: 2 }),
    });
    const claimBody = await claim.json() as { sessionId: string; jobs: Array<{ id: string; leaseToken: string }> };
    expect(claimBody.sessionId).toBe(heartbeatBody.sessionId);
    expect(claimBody.jobs).toHaveLength(2);

    const complete = await fetch(`${baseUrl}/v1/sim/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: claimBody.jobs[0]!.id,
        leaseToken: claimBody.jobs[0]!.leaseToken,
        game: sampleGame({ gameId: 'fleet-game', stateHash: 'fleet-state' }),
      }),
    });
    expect(complete.status).toBe(201);

    const denied = await fetch(`${baseUrl}/v1/admin/fleet`);
    expect(denied.status).toBe(401);
    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const allowed = await fetch(`${baseUrl}/v1/admin/fleet`, {
      headers: { cookie: `session=${session.id}` },
    });
    expect(allowed.status).toBe(200);
    const fleet = await allowed.json() as any;
    expect(fleet).toMatchObject({
      ok: true,
      liveWorkers: 1,
      workingWorkers: 1,
      idleWorkers: 0,
      activeJobs: 1,
      totalConcurrency: 2,
      gamesLastHour: 1,
    });
    expect(fleet.workers[0]).toMatchObject({
      workerLabel: 'worker-api',
      workerVersion: 'worker-test-1',
      gamesSubmitted: 1,
      gamesLastHour: 1,
      activeJobs: 1,
      reportedConcurrency: 2,
      campaigns: [{ campaignId: campaign.id, campaignName: 'Fleet API Campaign', jobs: 1 }],
    });
    expect(fleet.workers[0].gamesPerHour).toBeCloseTo(2, 3);

    const page = await fetch(`${baseUrl}/fleet`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Fleet Dashboard');
  });

  it('lets an admin edit campaign JSON and regenerates unfinished jobs', async () => {
    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const campaign = await cpRepo.createCampaign({
      name: 'Malformed API campaign',
      spec: { maps: ['mended-drum'] },
      baseSeed: 800,
      games: [{}, {}],
      createdBy: 'test-admin',
    });

    const response = await fetch(`${baseUrl}/v1/admin/campaign`, {
      method: 'PATCH',
      headers: { cookie: `session=${session.id}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        campaignId: campaign.id,
        name: 'Fixed API campaign',
        description: 'Restored the runner format',
        spec: { format: 'duel', maps: ['mended-drum'] },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      kind: 'updated',
      regeneratedJobs: 2,
      requeuedFailedJobs: 0,
      campaign: { name: 'Fixed API campaign', status: 'active' },
    });

    const detail = await cpRepo.getCampaign(campaign.id);
    expect(detail!.jobs).toHaveLength(2);
    expect(detail!.jobs[0]!.spec).toMatchObject({ format: 'duel', map: 'mended-drum' });
  });

  it('returns campaign bucket counts and paginated idle jobs', async () => {
    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const campaign = await cpRepo.createCampaign({
      name: 'Bucket API campaign',
      spec: { format: 'duel' },
      baseSeed: 300,
      games: [{}, {}, {}],
      createdBy: 'test-admin',
    });
    await cpRepo.claimJobs(campaign.id, 1, 'runner');

    const detail = await fetch(`${baseUrl}/v1/admin/campaign?id=${campaign.id}`, {
      headers: { cookie: `session=${session.id}` },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      ok: true,
      campaign: {
        jobs: [],
        jobCounts: { succeeded: 0, failed: 0, leased: 1, idle: 2 },
      },
    });

    const idle = await fetch(`${baseUrl}/v1/admin/campaign/items?id=${campaign.id}&bucket=idle&page=2&pageSize=1`, {
      headers: { cookie: `session=${session.id}` },
    });
    expect(idle.status).toBe(200);
    expect(await idle.json()).toMatchObject({
      ok: true,
      bucket: 'idle',
      page: 2,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      items: [{ gameIndex: 2, status: 'idle', seed: '302' }],
    });
  });

  it('lets an admin arrange priority and round-robin campaign tiers', async () => {
    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const first = await cpRepo.createCampaign({
      name: 'Priority API first', spec: { format: 'duel' }, games: [{}], createdBy: 'test-admin',
    });
    const peerA = await cpRepo.createCampaign({
      name: 'Priority API peer A', spec: { format: 'duel' }, games: [{}], createdBy: 'test-admin',
    });
    const peerB = await cpRepo.createCampaign({
      name: 'Priority API peer B', spec: { format: 'duel' }, games: [{}], createdBy: 'test-admin',
    });

    const response = await fetch(`${baseUrl}/v1/admin/campaign/schedule`, {
      method: 'PUT',
      headers: { cookie: `session=${session.id}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tiers: [[peerA.id, peerB.id], [first.id]] }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; campaigns: { id: string; priorityTier: number; priorityPosition: number }[] };
    expect(payload.ok).toBe(true);
    expect(payload.campaigns.filter(c => [peerA.id, peerB.id, first.id].includes(c.id)).map(c => [c.id, c.priorityTier, c.priorityPosition])).toEqual([
      [peerA.id, 0, 0],
      [peerB.id, 0, 1],
      [first.id, 1, 0],
    ]);
  });

  it('lets an admin toggle a campaign inactive and active', async () => {
    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const campaign = await cpRepo.createCampaign({
      name: 'Toggle API campaign',
      spec: { format: 'duel' },
      games: [{}],
      createdBy: 'test-admin',
    });

    const pause = await fetch(`${baseUrl}/v1/admin/campaign/active`, {
      method: 'POST',
      headers: { cookie: `session=${session.id}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, active: false }),
    });
    expect(pause.status).toBe(200);
    expect(await pause.json()).toMatchObject({ ok: true, active: false, status: 'paused' });
    expect((await cpRepo.getCampaign(campaign.id))!.jobs).toHaveLength(1);

    const resume = await fetch(`${baseUrl}/v1/admin/campaign/active`, {
      method: 'POST',
      headers: { cookie: `session=${session.id}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, active: true }),
    });
    expect(resume.status).toBe(200);
    expect(await resume.json()).toMatchObject({ ok: true, active: true, status: 'active' });
  });

  it('uses a named bearer credential as the trusted game source', async () => {
    const source = await cpRepo.createSource('runner-alpha', null, 'test-admin');
    const credential = await cpRepo.createCredential(source.id, 'games', ['games:submit'], 'test-admin');
    const payload = sampleGame({ gameId: 'bearer-game-001', stateHash: 'bearer-state-001', source: 'spoofed-source' });
    const response = await fetch(`${baseUrl}/v1/games`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.fullKey}`,
        'content-type': 'application/json',
        'idempotency-key': 'bearer-game-001',
      },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(201);

    const stored = await pool.query<{ source: string; auth_key_id: string; source_id: string }>(
      `SELECT source, auth_key_id, source_id FROM game_submissions WHERE idempotency_key = $1`,
      ['bearer-game-001'],
    );
    expect(stored.rows[0]).toEqual({ source: 'runner-alpha', auth_key_id: credential.id, source_id: source.id });
  });

  it('uses a scoped bearer credential for deck source attribution', async () => {
    const source = await cpRepo.createSource('deck-publisher', null, 'test-admin');
    const credential = await cpRepo.createCredential(source.id, 'decks', ['decks:submit'], 'test-admin');
    const payload = sampleDeckBatch() as { source?: string };
    payload.source = 'spoofed-source';
    const response = await fetch(`${baseUrl}/v1/decks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    const stored = await pool.query<{ source: string }>(
      `SELECT source FROM deck_definitions WHERE deck_id = 'king-kong' AND version = '0.1.0'`,
    );
    expect(stored.rows[0]?.source).toBe('deck-publisher');
  });

  it('claims and atomically completes simulation jobs through bearer APIs', async () => {
    const source = await cpRepo.createSource('sim-runner', null, 'test-admin');
    const credential = await cpRepo.createCredential(
      source.id,
      'worker',
      ['sim:claim', 'sim:complete'],
      'test-admin',
    );
    const campaign = await cpRepo.createCampaign({
      name: 'API campaign',
      spec: { format: 'duel' },
      baseSeed: 900,
      games: [{}],
      createdBy: 'test-admin',
    });

    const claim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, count: 1 }),
    });
    expect(claim.status).toBe(200);
    const claimed = await claim.json() as { jobs: { id: string; leaseToken: string }[] };
    expect(claimed.jobs).toHaveLength(1);

    const releaseCampaign = await cpRepo.createCampaign({
      name: 'Release API campaign',
      spec: { format: 'duel' },
      games: [{}],
      createdBy: 'test-admin',
    });
    const releaseClaim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: releaseCampaign.id, count: 1 }),
    });
    const releaseJob = (await releaseClaim.json() as { jobs: { id: string; leaseToken: string }[] }).jobs[0]!;
    const release = await fetch(`${baseUrl}/v1/sim/release`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: releaseJob.id, leaseToken: releaseJob.leaseToken }),
    });
    expect(release.status).toBe(200);
    expect(await release.json()).toEqual({ ok: true });
    expect((await cpRepo.getCampaign(releaseCampaign.id))!.jobs[0]).toMatchObject({ status: 'pending', attempts: 0 });

    const heartbeat = await fetch(`${baseUrl}/v1/sim/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: claimed.jobs[0]!.id,
        leaseToken: claimed.jobs[0]!.leaseToken,
        leaseDurationMs: 60_000,
      }),
    });
    expect(heartbeat.status).toBe(200);

    const completedGame = sampleGame({ gameId: 'sim-api-game-001', stateHash: 'sim-api-state-001', source: 'spoofed' });
    completedGame.teams[0]!.seats[0]!.botExecution = sampleBotExecution();
    const complete = await fetch(`${baseUrl}/v1/sim/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: claimed.jobs[0]!.id,
        leaseToken: claimed.jobs[0]!.leaseToken,
        game: completedGame,
      }),
    });
    expect(complete.status).toBe(201);

    const execution = await pool.query<{ bot_execution: unknown }>(
      `SELECT bot_execution FROM game_seats
       WHERE game_id = 'sim-api-game-001' AND team_index = 0 AND seat_index = 0`,
    );
    expect(execution.rows[0]?.bot_execution).toEqual(sampleBotExecution());

    const detail = await cpRepo.getCampaign(campaign.id);
    expect(detail).toMatchObject({ completedGames: 1, failedGames: 0, status: 'completed' });
    expect(detail?.jobs).toHaveLength(0);
    const game = await pool.query<{ source: string; campaign_id: string; campaign_game_index: number }>(
      `SELECT source, campaign_id, campaign_game_index FROM games WHERE id = 'sim-api-game-001'`,
    );
    expect(game.rows[0]).toEqual({ source: 'sim-runner', campaign_id: campaign.id, campaign_game_index: 0 });
  });

  it('paginates succeeded campaign games from stored telemetry', async () => {
    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const source = await cpRepo.createSource('success-list-runner', null, 'test-admin');
    const credential = await cpRepo.createCredential(source.id, 'worker', ['sim:claim', 'sim:complete'], 'test-admin');
    const campaign = await cpRepo.createCampaign({
      name: 'Succeeded list campaign',
      spec: { format: 'duel' },
      games: [{}],
      createdBy: 'test-admin',
    });
    const [job] = await cpRepo.claimJobs(campaign.id, 1, credential.id);
    const complete = await fetch(`${baseUrl}/v1/sim/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: job!.id,
        leaseToken: job!.leaseToken,
        game: sampleGame({ gameId: 'bucket-success-001', stateHash: 'bucket-success-state-001' }),
      }),
    });
    expect(complete.status).toBe(201);

    const succeeded = await fetch(`${baseUrl}/v1/admin/campaign/items?id=${campaign.id}&bucket=succeeded&page=1&pageSize=50`, {
      headers: { cookie: `session=${session.id}` },
    });
    expect(succeeded.status).toBe(200);
    expect(await succeeded.json()).toMatchObject({
      ok: true,
      bucket: 'succeeded',
      total: 1,
      items: [{ gameIndex: 0, status: 'succeeded', gameId: 'bucket-success-001' }],
    });
  });

  it('groups completed campaign submissions by source and credential label', async () => {
    const session = await cpRepo.createSession({ discordId: 'admin-123', discordUsername: 'test-admin' });
    const source = await cpRepo.createSource('campaign-workers', null, 'test-admin');
    const desktop = await cpRepo.createCredential(source.id, 'desktop', ['sim:claim', 'sim:complete'], 'test-admin');
    const laptop = await cpRepo.createCredential(source.id, 'laptop', ['sim:claim', 'sim:complete'], 'test-admin');
    const campaign = await cpRepo.createCampaign({
      name: 'Submission attribution campaign',
      spec: { format: 'duel' },
      games: [{}, {}],
      createdBy: 'test-admin',
    });
    const otherCampaign = await cpRepo.createCampaign({
      name: 'Other campaign',
      spec: { format: 'duel' },
      games: [{}],
      createdBy: 'test-admin',
    });

    const completeOne = async (campaignId: string, credential: { id: string; fullKey: string }, gameId: string) => {
      const [job] = await cpRepo.claimJobs(campaignId, 1, credential.id);
      const response = await fetch(`${baseUrl}/v1/sim/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: job!.id,
          leaseToken: job!.leaseToken,
          game: sampleGame({ gameId, stateHash: `${gameId}-state` }),
        }),
      });
      expect(response.status).toBe(201);
      await response.json();
    };

    await completeOne(campaign.id, desktop, 'campaign-source-desktop');
    await completeOne(campaign.id, laptop, 'campaign-source-laptop');
    await completeOne(otherCampaign.id, desktop, 'other-campaign-source-desktop');

    const response = await fetch(`${baseUrl}/v1/admin/campaign/submissions?id=${campaign.id}`, {
      headers: { cookie: `session=${session.id}` },
    });
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalSubmissions: number;
      sources: Array<{
        source: string;
        submissions: number;
        credentials: Array<{ credentialId: string | null; label: string; submissions: number }>;
      }>;
    };
    expect(json.totalSubmissions).toBe(2);
    expect(json.sources).toEqual([{
      source: 'campaign-workers',
      submissions: 2,
      lastReceivedAt: expect.any(String),
      credentials: [
        expect.objectContaining({ credentialId: desktop.id, label: 'desktop', submissions: 1 }),
        expect.objectContaining({ credentialId: laptop.id, label: 'laptop', submissions: 1 }),
      ],
    }]);
  });

  it('stores heartbeat checkpoints and returns them verbatim on reclaim (crash resume)', async () => {
    const source = await cpRepo.createSource('sim-checkpoint-runner', null, 'test-admin');
    const credential = await cpRepo.createCredential(source.id, 'worker', ['sim:claim'], 'test-admin');
    const campaign = await cpRepo.createCampaign({
      name: 'Checkpoint campaign',
      spec: { format: 'duel' },
      games: [{}, {}],
      createdBy: 'test-admin',
    });

    const claim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, count: 2 }),
    });
    expect(claim.status).toBe(200);
    const claimed = await claim.json() as { jobs: { id: string; leaseToken: string; checkpoint?: unknown }[] };
    expect(claimed.jobs).toHaveLength(2);
    expect('checkpoint' in claimed.jobs[0]!).toBe(false);

    const checkpoint = {
      engineVersion: '1.4.2',
      journal: { actions: ['a1', 'a2'], prng: { main: '999' } },
    };
    const heartbeat = await fetch(`${baseUrl}/v1/sim/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: claimed.jobs[0]!.id,
        leaseToken: claimed.jobs[0]!.leaseToken,
        checkpoint,
      }),
    });
    expect(heartbeat.status).toBe(200);

    // Hard-kill the worker: expire both leases, then reclaim.
    await pool.query(`UPDATE sim_jobs SET lease_expires_at = now() - interval '1 second' WHERE campaign_id = $1`, [campaign.id]);
    const reclaim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, count: 2 }),
    });
    expect(reclaim.status).toBe(200);
    const reclaimed = await reclaim.json() as { jobs: { id: string; checkpoint?: unknown }[] };
    expect(reclaimed.jobs).toHaveLength(2);
    const withCheckpoint = reclaimed.jobs.find((j) => j.id === claimed.jobs[0]!.id)!;
    const withoutCheckpoint = reclaimed.jobs.find((j) => j.id === claimed.jobs[1]!.id)!;
    expect(withCheckpoint.checkpoint).toEqual(checkpoint);
    expect('checkpoint' in withoutCheckpoint).toBe(false);
  });

  it('preserves the checkpoint across a graceful stop: checkpoint → release → reclaim (issue #35)', async () => {
    const source = await cpRepo.createSource('sim-graceful-runner', null, 'test-admin');
    const credential = await cpRepo.createCredential(source.id, 'worker', ['sim:claim'], 'test-admin');
    const campaign = await cpRepo.createCampaign({
      name: 'Graceful stop campaign',
      spec: { format: 'duel' },
      games: [{}],
      createdBy: 'test-admin',
    });

    const claim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, count: 1 }),
    });
    expect(claim.status).toBe(200);
    const claimed = await claim.json() as { jobs: { id: string; leaseToken: string; attempts: number }[] };
    expect(claimed.jobs).toHaveLength(1);
    const job = claimed.jobs[0]!;

    // The engine's graceful stop (engine #258): final checkpoint heartbeat, then release.
    const checkpoint = {
      engineVersion: '1.4.2',
      journal: { actions: ['a1', 'a2', 'a3'], prng: { main: '31337' } },
    };
    const heartbeat = await fetch(`${baseUrl}/v1/sim/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken, checkpoint }),
    });
    expect(heartbeat.status).toBe(200);

    const release = await fetch(`${baseUrl}/v1/sim/release`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, leaseToken: job.leaseToken }),
    });
    expect(release.status).toBe(200);
    expect(await release.json()).toMatchObject({ ok: true });

    const released = await pool.query<{ status: string; checkpoint: unknown; attempts: number }>(
      `SELECT status, checkpoint, attempts FROM sim_jobs WHERE id = $1`, [job.id],
    );
    expect(released.rows[0]).toMatchObject({ status: 'pending', checkpoint, attempts: 0 });

    const reclaim = await fetch(`${baseUrl}/v1/sim/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ campaignId: campaign.id, count: 1 }),
    });
    expect(reclaim.status).toBe(200);
    const reclaimed = await reclaim.json() as { jobs: { id: string; checkpoint?: unknown; attempts: number }[] };
    expect(reclaimed.jobs).toHaveLength(1);
    expect(reclaimed.jobs[0]!.id).toBe(job.id);
    expect(reclaimed.jobs[0]!.checkpoint).toEqual(checkpoint);
    // Release refunded the attempt, so the reclaim counts as the first again.
    expect(reclaimed.jobs[0]!.attempts).toBe(1);
  });

  it('rejects oversize and malformed checkpoints without touching job or lease', async () => {
    const source = await cpRepo.createSource('sim-checkpoint-limits', null, 'test-admin');
    const credential = await cpRepo.createCredential(source.id, 'worker', ['sim:claim'], 'test-admin');
    const campaign = await cpRepo.createCampaign({
      name: 'Checkpoint limits',
      spec: {},
      games: [{}],
      createdBy: 'test-admin',
    });
    const [job] = await cpRepo.claimJobs(campaign.id, 1, credential.id);
    const before = await pool.query<{ checkpoint: unknown; lease_expires_at: Date }>(
      `SELECT checkpoint, lease_expires_at FROM sim_jobs WHERE id = $1`, [job!.id],
    );

    const oversize = await fetch(`${baseUrl}/v1/sim/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: job!.id,
        leaseToken: job!.leaseToken,
        checkpoint: { engineVersion: '1.0.0', journal: 'x'.repeat(256 * 1024) },
      }),
    });
    expect(oversize.status).toBe(413);
    expect(await oversize.json()).toMatchObject({ ok: false, code: 'CHECKPOINT_TOO_LARGE' });

    const malformed = await fetch(`${baseUrl}/v1/sim/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job!.id, leaseToken: job!.leaseToken, checkpoint: { journal: {} } }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: 'INVALID_CHECKPOINT' });

    const wrongLease = await fetch(`${baseUrl}/v1/sim/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.fullKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: job!.id,
        leaseToken: 'not-the-lease-token',
        checkpoint: { engineVersion: '1.0.0', journal: {} },
      }),
    });
    expect(wrongLease.status).toBe(409);

    const after = await pool.query<{ checkpoint: unknown; lease_expires_at: Date }>(
      `SELECT checkpoint, lease_expires_at FROM sim_jobs WHERE id = $1`, [job!.id],
    );
    expect(after.rows[0]!.checkpoint).toBeNull();
    expect(after.rows[0]!.lease_expires_at.toISOString()).toBe(before.rows[0]!.lease_expires_at.toISOString());
  });

  it('rolls back job completion when telemetry ingest fails', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'sim-conflict', stateHash: 'existing-state' }), 'existing-sim-conflict');
    const source = await cpRepo.createSource('sim-rollback-runner', null, 'test-admin');
    const credential = await cpRepo.createCredential(source.id, 'worker', ['sim:claim', 'sim:complete'], 'test-admin');
    const campaign = await cpRepo.createCampaign({
      name: 'Rollback campaign',
      spec: {},
      games: [{}],
      createdBy: 'test-admin',
    });
    const [job] = await cpRepo.claimJobs(campaign.id, 1, credential.id);

    const response = await fetch(`${baseUrl}/v1/sim/complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.fullKey}`,
        'content-type': 'application/json',
        'idempotency-key': 'new-idempotency-key',
      },
      body: JSON.stringify({
        jobId: job!.id,
        leaseToken: job!.leaseToken,
        game: sampleGame({ gameId: 'sim-conflict', stateHash: 'different-state' }),
      }),
    });
    expect(response.status).toBe(500);

    const detail = await cpRepo.getCampaign(campaign.id);
    expect(detail).toMatchObject({ completedGames: 0, status: 'active' });
    expect(detail?.jobs).toHaveLength(1);
    expect(detail?.jobs[0]?.status).toBe('leased');
  });

  it('ingests valid games idempotently and reports deck stats', async () => {
    const first = await postGame(baseUrl, secret, sampleGame({ gameId: 'api-game-001', stateHash: 'api-state-001' }), 'api-game-001');
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false, gameId: 'api-game-001' });

    const duplicate = await postGame(baseUrl, secret, sampleGame({ gameId: 'api-game-001', stateHash: 'api-state-001' }), 'api-game-001');
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true, gameId: 'api-game-001' });

    const startingRows = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM game_starting_cards WHERE game_id = $1', ['api-game-001']);
    expect(Number(startingRows.rows[0]?.count ?? 0)).toBe(10);

    const stats = await fetch(`${baseUrl}/v1/stats/decks?format=duel&pilots=bot:hard`);
    expect(stats.status).toBe(200);
    const json = await stats.json() as {
      totalGames: number;
      avgTurns: number;
      decks: { deck: string; games: number; wins: number; winRate: number }[];
    };
    expect(json.totalGames).toBe(1);
    expect(json.avgTurns).toBe(13);
    expect(json.decks).toHaveLength(2);
    expect(json.decks.find((deck) => deck.deck === 'king-kong@0.1.0')).toMatchObject({ games: 1, wins: 1, winRate: 1 });
    expect(json.decks.find((deck) => deck.deck === 'the-mandalorian@0.1.0')).toMatchObject({ games: 1, wins: 0, winRate: 0 });
  });

  it('persists structured bot execution metadata per seat', async () => {
    const game = sampleGame({ gameId: 'bot-execution-001', stateHash: 'bot-execution-state-001' });
    game.teams[0]!.seats[0]!.botVersion = 'mc-v1';
    game.teams[0]!.seats[0]!.botExecution = sampleBotExecution();

    const response = await postGame(baseUrl, secret, game, 'bot-execution-001');
    expect(response.status).toBe(201);

    const stored = await pool.query<{ bot_version: string | null; bot_execution: unknown }>(
      `SELECT bot_version, bot_execution
       FROM game_seats
       WHERE game_id = $1 AND team_index = 0 AND seat_index = 0`,
      ['bot-execution-001'],
    );
    expect(stored.rows[0]).toEqual({
      bot_version: 'mc-v1',
      bot_execution: sampleBotExecution(),
    });

    const stats = await fetch(`${baseUrl}/v1/stats/bot-execution?pilot=bot%3Ahard&deck=king-kong%400.1.0`);
    expect(stats.status).toBe(200);
    expect(await stats.json()).toEqual({
      ok: true,
      pilot: 'bot:hard',
      deck: 'king-kong@0.1.0',
      rows: [{
        pilot: 'bot:hard',
        botVersion: 'mc-v1',
        msPerMove: 2000,
        iterationCap: 64,
        games: 1,
        decisions: 42,
        completedIterationsMean: 61.5,
        clockTruncatedDecisions: 3,
        earlyStoppedDecisions: 0,
        clockTruncatedRate: 3 / 42,
        earlyStoppedRate: 0,
      }],
    });
  });

  it('supports MUST pilot filters', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'must-hard-001', stateHash: 'must-hard-state-001' }), 'must-hard-001');
    await postGame(baseUrl, secret, sampleGame({
      gameId: 'must-human-001',
      stateHash: 'must-human-state-001',
      teams: [
        {
          seats: [{
            deck: 'king-kong@0.1.0',
            pilot: 'human',
            runtimePlayerId: 'p1',
            heroId: 'king-kong',
            finalHealth: 7,
          }],
        },
        {
          seats: [{
            deck: 'the-mandalorian@0.1.0',
            pilot: 'bot:hard',
            runtimePlayerId: 'p2',
            heroId: 'the-mandalorian',
            botDifficulty: 'hard',
            finalHealth: 0,
          }],
        },
      ],
    }), 'must-human-001');

    const broad = await fetch(`${baseUrl}/v1/stats/decks?format=duel&pilots=human,bot:hard`);
    expect(broad.status).toBe(200);
    expect((await broad.json() as { totalGames: number }).totalGames).toBe(2);

    const mustHuman = await fetch(`${baseUrl}/v1/stats/decks?format=duel&pilots=human,bot:hard,must:human`);
    expect(mustHuman.status).toBe(200);
    const json = await mustHuman.json() as { totalGames: number; decks: { deck: string; games: number }[] };
    expect(json.totalGames).toBe(1);
    expect(json.decks.find((deck) => deck.deck === 'king-kong@0.1.0')).toMatchObject({ games: 1 });
  });

  it('returns dashboard aggregates for the UI', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'dash-game-001', stateHash: 'dash-state-001' }), 'dash-game-001');

    const response = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      totalSubmissions: number;
      formats: { format: string; games: number }[];
      decks: { deck: string; label: string; games: number; wins: number; profile: { attack: number; lean: string } | null }[];
      matchups: { rowDeck: string; colDeck: string; games: number; wins: number; avgWinTurns: number | null; avgLossTurns: number | null }[];
      firstPlayer: { games: number; wins: number; winRate: number };
    };
    expect(json.totalGames).toBe(1);
    expect(json.totalSubmissions).toBe(1);
    expect(json.formats).toContainEqual(expect.objectContaining({ format: 'duel', games: 1 }));
    const king = json.decks.find((deck) => deck.deck === 'king-kong@0.1.0');
    expect(king).toMatchObject({ label: 'king-kong', games: 1, wins: 1 });
    // king-kong played 2 attack / 1 defense / 1 scheme -> attack-leaning play mix.
    expect(king?.profile).toMatchObject({ attack: 0.5, lean: 'Offensive' });
    expect(json.matchups).toContainEqual(expect.objectContaining({ rowDeck: 'king-kong', rowDeckId: 'king-kong', colDeck: 'the-mandalorian', colDeckId: 'the-mandalorian', games: 1, wins: 1, avgTurns: 13, avgWinTurns: 13, avgLossTurns: null, avgFinalHealth: 7 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ rowDeck: 'the-mandalorian', rowDeckId: 'the-mandalorian', colDeck: 'king-kong', colDeckId: 'king-kong', games: 1, wins: 0, avgTurns: 13, avgWinTurns: null, avgLossTurns: 13 }));
    expect(json.firstPlayer).toMatchObject({ games: 1, wins: 1, winRate: 1 });
  });

  it('omits pilots with no games in the selected format', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'duel-pilots-001', stateHash: 'duel-pilots-state-001' }), 'duel-pilots-001');
    await postGame(baseUrl, secret, sampleGame({
      gameId: 'team-pilots-001',
      stateHash: 'team-pilots-state-001',
      format: 'team-2v2',
      formatLabel: '2v2 Teams',
      teams: [
        { seats: [{ deck: 'king-kong@0.1.0', pilot: 'bot:easy', runtimePlayerId: 'p1', heroId: 'king-kong', botDifficulty: 'easy', finalHealth: 7 }] },
        { seats: [{ deck: 'the-mandalorian@0.1.0', pilot: 'bot:easy', runtimePlayerId: 'p2', heroId: 'the-mandalorian', botDifficulty: 'easy', finalHealth: 0 }] },
      ],
    }), 'team-pilots-001');

    const response = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel`);
    expect(response.status).toBe(200);
    const json = await response.json() as { pilots: { pilot: string; seats: number; games: number }[] };
    expect(json.pilots).toContainEqual(expect.objectContaining({ pilot: 'bot:hard', seats: 2, games: 1 }));
    expect(json.pilots).not.toContainEqual(expect.objectContaining({ pilot: 'bot:easy' }));
  });

  it('serves deck detail with card influence and matchups', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'detail-game-001', stateHash: 'detail-state-001' }), 'detail-game-001');

    const response = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      deck: string;
      games: number;
      winRate: number;
      profile: { lean: string } | null;
      avgFinalHealth: number | null;
      firstPlayer: { first: { games: number; wins: number; winRate: number | null }; second: { games: number; winRate: number | null } };
      formats: { format: string; winRate: number }[];
      matchups: { deck: string; games: number; winRate: number }[];
      cards: { card: string; contextBucket: string; influence: number; baselineWinRate: number }[];
      startingCards: { card: string; influence: number; baselineWinRate: number; gamesWith: number }[];
    };
    expect(json).toMatchObject({ deck: 'king-kong@0.1.0', games: 1, winRate: 1 });
    expect(json.profile?.lean).toBe('Offensive');
    // fixture: king-kong final health 7, went first (firstPlayerTeam 0) and won.
    expect(json.avgFinalHealth).toBe(7);
    expect(json.firstPlayer.first).toMatchObject({ games: 1, wins: 1, winRate: 1 });
    expect(json.firstPlayer.second).toMatchObject({ games: 0, winRate: null });
    expect(json.formats).toContainEqual(expect.objectContaining({ format: 'duel', winRate: 1 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ deck: 'the-mandalorian@0.1.0', games: 1, winRate: 1 }));
    const crushing = json.cards.find((card) => card.card === 'crushing-blow');
    expect(crushing).toMatchObject({ contextBucket: 'attack', baselineWinRate: 1, influence: 0 });
    const openingCrushing = json.startingCards.find((card) => card.card === 'crushing-blow');
    expect(openingCrushing).toMatchObject({ gamesWith: 1, baselineWinRate: 1, influence: 0 });
  });

  it('filters 1v1 deck detail by hero and opponent pilot assignments', async () => {
    const matchupGame = (
      gameId: string,
      heroPilot: string,
      opponentPilot: string,
      winner: number,
      opponentDeck = 'the-mandalorian@0.1.0',
    ) => sampleGame({
      gameId,
      stateHash: `${gameId}-state`,
      teams: [
        {
          seats: [{
            deck: 'king-kong@0.1.0',
            pilot: heroPilot,
            runtimePlayerId: 'p1',
            heroId: 'king-kong',
            botDifficulty: 'hard',
            finalHealth: winner === 0 ? 7 : 0,
          }],
        },
        {
          seats: [{
            deck: opponentDeck,
            pilot: opponentPilot,
            runtimePlayerId: 'p2',
            heroId: opponentDeck.split('@')[0] ?? opponentDeck,
            botDifficulty: 'hard',
            finalHealth: winner === 1 ? 7 : 0,
          }],
        },
      ],
      winner,
    });

    await postGame(baseUrl, secret, matchupGame('pilot-compare-001', 'bot:hard(64,2s)', 'bot:hard', 0), 'pilot-compare-001');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-002', 'bot:hard(64,2s)', 'bot:hard', 0), 'pilot-compare-002');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-003', 'bot:hard', 'bot:hard(64,2s)', 1), 'pilot-compare-003');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-004', 'bot:hard', 'bot:hard', 0), 'pilot-compare-004');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-005', 'bot:hard(64,2s)', 'bot:hard', 0, 'batman@0.1.0'), 'pilot-compare-005');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-006', 'bot:hard', 'bot:hard', 1, 'batman@0.1.0'), 'pilot-compare-006');

    const selected = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&opponent=the-mandalorian@0.1.0&heroPilot=bot%3Ahard%2864%2C2s%29&opponentPilot=bot%3Ahard`);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ games: 2, wins: 2, winRate: 1 });

    const swapped = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&opponent=the-mandalorian@0.1.0&heroPilot=bot%3Ahard&opponentPilot=bot%3Ahard%2864%2C2s%29`);
    expect(swapped.status).toBe(200);
    expect(await swapped.json()).toMatchObject({ games: 1, wins: 0, winRate: 0 });

    const matchupMatrix = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilot=bot%3Ahard&heroPilot=bot%3Ahard%2864%2C2s%29&opponentPilot=bot%3Ahard`);
    expect(matchupMatrix.status).toBe(200);
    const matchupJson = await matchupMatrix.json() as {
      matchups: { rowDeckId: string; colDeckId: string; games: number; wins: number }[];
    };
    expect(matchupJson.matchups).toContainEqual(expect.objectContaining({
      rowDeckId: 'king-kong',
      colDeckId: 'the-mandalorian',
      games: 2,
      wins: 2,
    }));
    expect(matchupJson.matchups).toContainEqual(expect.objectContaining({
      rowDeckId: 'the-mandalorian',
      colDeckId: 'king-kong',
      games: 1,
      wins: 1,
    }));

    const heroTable = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilot=bot%3Ahard%2864%2C2s%29&pilot=bot%3Ahard&heroPilot=bot%3Ahard%2864%2C2s%29&opponentPilotAllowed=bot%3Ahard`);
    expect(heroTable.status).toBe(200);
    const heroTableJson = await heroTable.json() as {
      totalGames: number;
      decks: { deck: string; games: number; wins: number }[];
    };
    expect(heroTableJson.totalGames).toBe(4);
    expect(heroTableJson.decks.find((deck) => deck.deck === 'king-kong@0.1.0')).toMatchObject({ games: 3, wins: 3 });

    const comparison = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=bot%3Ahard%2864%2C2s%29&pilotB=bot%3Ahard&opponentPilot=bot%3Ahard&opponent=the-mandalorian%400.1.0`);
    expect(comparison.status).toBe(200);
    const comparisonJson = await comparison.json() as {
      pilotA: string;
      pilotB: string;
      rows: {
        deckId: string;
        pilotA: { games: number; wins: number; winRate: number };
        pilotB: { games: number; wins: number; winRate: number };
        winRateDelta: number | null;
      }[];
    };
    expect(comparisonJson).toMatchObject({ pilotA: 'bot:hard(64,2s)', pilotB: 'bot:hard' });
    expect(comparisonJson.rows).toContainEqual(expect.objectContaining({
      deckId: 'king-kong',
      pilotA: expect.objectContaining({ games: 2, wins: 2, winRate: 1 }),
      pilotB: expect.objectContaining({ games: 1, wins: 1, winRate: 1 }),
      winRateDelta: 0,
    }));

    const heroComparison = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=bot%3Ahard%2864%2C2s%29&pilotB=bot%3Ahard&hero=king-kong%400.1.0&opponentPilot=bot%3Ahard&opponent=the-mandalorian%400.1.0`);
    expect(heroComparison.status).toBe(200);
    const heroComparisonJson = await heroComparison.json() as {
      hero: string | null;
      rows: { deck: string; deckId: string }[];
    };
    expect(heroComparisonJson.hero).toBe('king-kong@0.1.0');
    expect(heroComparisonJson.rows).toEqual([
      expect.objectContaining({ deck: 'the-mandalorian@0.1.0', deckId: 'the-mandalorian' }),
    ]);

    const allOpponents = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=bot%3Ahard%2864%2C2s%29&pilotB=bot%3Ahard&hero=king-kong%400.1.0&opponentPilot=bot%3Ahard`);
    expect(allOpponents.status).toBe(200);
    const allOpponentsJson = await allOpponents.json() as {
      rows: { deckId: string; pilotA: { winRate: number }; pilotB: { winRate: number }; winRateDelta: number | null }[];
    };
    expect(allOpponentsJson.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ deckId: 'the-mandalorian' }),
      expect.objectContaining({
        deck: 'king-kong@0.1.0',
        deckId: 'king-kong',
        pilotA: expect.objectContaining({ games: 0 }),
        pilotB: expect.objectContaining({ games: 0 }),
        winRateDelta: null,
      }),
      expect.objectContaining({
        deckId: 'batman',
        pilotA: expect.objectContaining({ winRate: 1 }),
        pilotB: expect.objectContaining({ winRate: 0 }),
        winRateDelta: 1,
      }),
    ]));

    const samePilot = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=bot%3Ahard&pilotB=bot%3Ahard&opponentPilot=bot%3Ahard`);
    expect(samePilot.status).toBe(400);
    expect(await samePilot.json()).toMatchObject({ code: 'SAME_PILOT' });

    const missing = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&opponent=the-mandalorian@0.1.0&heroPilot=human&opponentPilot=bot%3Ahard`);
    expect(missing.status).toBe(404);
  });

  it('404s deck detail for an unknown deck', async () => {
    const response = await fetch(`${baseUrl}/v1/stats/deck?deck=does-not-exist@9.9.9`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: 'DECK_NOT_FOUND' });
  });

  it('reports boss-side win rate for boss formats', async () => {
    const bossGame = sampleGame({
      gameId: 'boss-game-001',
      stateHash: 'boss-state-001',
      format: 'two-v-one-boss',
      formatLabel: '2v1 Boss',
      boss: 'marrow-king',
      teams: [
        { role: 'boss', seats: [{ deck: 'marrow-king@0.1.0', pilot: 'bot:hard', runtimePlayerId: 'p1', heroId: 'marrow-king' }] },
        {
          seats: [
            { deck: 'king-kong@0.1.0', pilot: 'bot:hard', runtimePlayerId: 'p2', heroId: 'king-kong' },
            { deck: 'the-mandalorian@0.1.0', pilot: 'bot:hard', runtimePlayerId: 'p3', heroId: 'the-mandalorian' },
          ],
        },
      ],
      winner: 0,
    });
    await postGame(baseUrl, secret, bossGame, 'boss-game-001');

    const response = await fetch(`${baseUrl}/v1/stats/dashboard`);
    const json = await response.json() as {
      formats: { format: string; bossGames: number; bossWinRate: number | null; bosses: { boss: string; winRate: number }[] }[];
    };
    const bossFormat = json.formats.find((format) => format.format === 'two-v-one-boss');
    expect(bossFormat).toMatchObject({ bossGames: 1, bossWinRate: 1 });
    expect(bossFormat?.bosses).toContainEqual(expect.objectContaining({ boss: 'marrow-king', winRate: 1 }));
  });

  it('adds the deck rules hash columns additively and is safe to re-apply', async () => {
    // migrate() already ran 001..011 in beforeAll; re-running the file by hand
    // must be a no-op, the way an operator would retry a half-finished deploy.
    const sql = await readFile(new URL('../migrations/011_deck_rules_hash.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    await pool.query(sql);

    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE (table_name = 'game_seats' AND column_name = 'deck_rules_hash')
          OR (table_name = 'deck_definitions' AND column_name = 'rules_hash')
       ORDER BY table_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: 'deck_definitions', column_name: 'rules_hash', data_type: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'game_seats', column_name: 'deck_rules_hash', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);

    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'game_seats_deck_rules_hash_idx'`,
    );
    expect(index.rowCount).toBe(1);

    const rerun = await migrate(pool);
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toContain('011_deck_rules_hash.sql');
  });

  it('persists the deck rules fingerprint per seat and leaves it null without one', async () => {
    const withHash = sampleGame({ gameId: 'rules-hash-001', stateHash: 'rules-hash-state-001' });
    withHash.teams[0]!.seats[0]!.deckRulesHash = 'fp1-9c3a17b40e21';
    expect((await postGame(baseUrl, secret, withHash, 'rules-hash-001')).status).toBe(201);

    const stored = await pool.query<{ seat_index: number; team_index: number; deck: string; deck_rules_hash: string | null }>(
      `SELECT team_index, seat_index, deck, deck_rules_hash
       FROM game_seats WHERE game_id = $1 ORDER BY team_index`,
      ['rules-hash-001'],
    );
    expect(stored.rows).toEqual([
      { team_index: 0, seat_index: 0, deck: 'king-kong@0.1.0', deck_rules_hash: 'fp1-9c3a17b40e21' },
      { team_index: 1, seat_index: 0, deck: 'the-mandalorian@0.1.0', deck_rules_hash: null },
    ]);

    // A producer that has not enabled the flag stores exactly as before.
    const without = sampleGame({ gameId: 'rules-hash-002', stateHash: 'rules-hash-state-002' });
    expect((await postGame(baseUrl, secret, without, 'rules-hash-002')).status).toBe(201);
    const legacy = await pool.query<{ deck_rules_hash: string | null; deck_version: string }>(
      `SELECT deck_rules_hash, deck_version FROM game_seats WHERE game_id = $1 ORDER BY team_index`,
      ['rules-hash-002'],
    );
    expect(legacy.rows).toEqual([
      { deck_rules_hash: null, deck_version: '0.1.0' },
      { deck_rules_hash: null, deck_version: '0.1.0' },
    ]);

    // Both games still render on the read paths that existed before this column.
    const recent = await fetch(`${baseUrl}/v1/stats/recent?limit=10`);
    const recentJson = await recent.json() as {
      games: { gameId: string; teams: { seats: { deck: string; deckRulesHash: string | null }[] }[] }[];
    };
    const hashed = recentJson.games.find((game) => game.gameId === 'rules-hash-001');
    const plain = recentJson.games.find((game) => game.gameId === 'rules-hash-002');
    expect(hashed?.teams[0]?.seats[0]?.deckRulesHash).toBe('fp1-9c3a17b40e21');
    expect(hashed?.teams[1]?.seats[0]?.deckRulesHash).toBeNull();
    expect(plain?.teams[0]?.seats[0]).toMatchObject({ deck: 'king-kong@0.1.0', deckRulesHash: null });
  });

  it('rejects a malformed deck rules fingerprint without storing the game', async () => {
    const game = sampleGame({ gameId: 'rules-hash-bad-001', stateHash: 'rules-hash-bad-state-001' });
    game.teams[0]!.seats[0]!.deckRulesHash = 'sha256-nothex';

    const response = await postGame(baseUrl, secret, game, 'rules-hash-bad-001');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });

    const seats = await pool.query(`SELECT 1 FROM game_seats WHERE game_id = $1`, ['rules-hash-bad-001']);
    expect(seats.rowCount).toBe(0);
  });

  it('upserts deck definitions with and without a rules fingerprint', async () => {
    // Pushed the way producers push today: no rulesHash at all.
    expect((await postDecks(baseUrl, secret, sampleDeckBatch())).status).toBe(200);
    const before = await pool.query<{ rules_hash: string | null; card_count: number }>(
      `SELECT rules_hash, card_count FROM deck_definitions WHERE deck_id = $1 AND version = $2`,
      ['king-kong', '0.1.0'],
    );
    expect(before.rows[0]).toEqual({ rules_hash: null, card_count: 30 });

    // Re-pushing the same version with a fingerprint adopts it.
    expect((await postDecks(baseUrl, secret, sampleDeckBatch({ rulesHash: 'fp1-9c3a17b40e21' }))).status).toBe(200);
    const after = await pool.query<{ rules_hash: string | null; card_count: number }>(
      `SELECT rules_hash, card_count FROM deck_definitions WHERE deck_id = $1 AND version = $2`,
      ['king-kong', '0.1.0'],
    );
    expect(after.rows[0]).toEqual({ rules_hash: 'fp1-9c3a17b40e21', card_count: 30 });

    await postGame(baseUrl, secret, sampleGame({ gameId: 'rules-comp-001', stateHash: 'rules-comp-state-001' }), 'rules-comp-001');
    const dash = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    const dashJson = await dash.json() as { decks: { deck: string; composition: { rulesHash: string | null } | null }[] };
    expect(dashJson.decks.find((deck) => deck.deck === 'king-kong@0.1.0')?.composition)
      .toMatchObject({ rulesHash: 'fp1-9c3a17b40e21' });
  });

  it('rejects a deck definition with a malformed rules fingerprint', async () => {
    const response = await postDecks(baseUrl, secret, sampleDeckBatch({ rulesHash: 'fp1-XYZ' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('adds the canonical deck rules columns additively and is safe to re-apply', async () => {
    // migrate() already ran 001..012 in beforeAll; re-running the file by hand
    // must be a no-op, the way an operator would retry a half-finished deploy.
    const sql = await readFile(new URL('../migrations/012_deck_rules_canonical.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    await pool.query(sql);

    const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'deck_definitions' AND column_name IN ('rules_canonical', 'rules')
       ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'rules', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
      { column_name: 'rules_canonical', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);

    const index = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'deck_definitions_rules_hash_idx'`,
    );
    expect(index.rowCount).toBe(1);

    const rerun = await migrate(pool);
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toContain('012_deck_rules_canonical.sql');
  });

  it('leaves rows written before the archive untouched: no backfill, lossy cards kept', async () => {
    // A row as 011 left it: cards payload, fingerprint, nothing else.
    await pool.query(
      `INSERT INTO deck_definitions (deck_id, version, cards, card_count, rules_hash)
       VALUES ('legacy-deck', '0.0.1', $1::jsonb, 30, 'fp1-9c3a17b40e21')`,
      [JSON.stringify([{ type: 'attack', value: 5, quantity: 30 }])],
    );
    await migrate(pool);

    const row = await pool.query<{ cards: unknown; card_count: number; rules_hash: string; rules_canonical: string | null; rules: unknown }>(
      `SELECT cards, card_count, rules_hash, rules_canonical, rules FROM deck_definitions WHERE deck_id = 'legacy-deck'`,
    );
    expect(row.rows[0]).toEqual({
      cards: [{ type: 'attack', value: 5, quantity: 30 }],
      card_count: 30,
      rules_hash: 'fp1-9c3a17b40e21',
      rules_canonical: null,
      rules: null,
    });
  });

  it('archives canonical deck rules and re-archives them on conflict', async () => {
    // A push the way producers push today leaves both new columns NULL.
    expect((await postDecks(baseUrl, secret, sampleDeckBatch())).status).toBe(200);
    expect((await archivedRules(pool)).rows[0]).toMatchObject({ rules_canonical: null, rules: null, card_count: 30 });

    const canonical = sampleCanonicalRules();
    const push = await postDecks(baseUrl, secret, sampleDeckBatch({
      rulesCanonical: canonical,
      rulesHash: fingerprintFor(canonical),
    }));
    expect(push.status).toBe(200);

    // Same (deck_id, version): the ON CONFLICT path must adopt the archive.
    const stored = (await archivedRules(pool)).rows[0]!;
    expect(stored.rules_canonical).toBe(canonical);
    expect(stored.rules_hash).toBe(fingerprintFor(canonical));
    expect(stored.rules).toMatchObject({ hero: { id: 'king-kong', health: 18 } });
    expect((stored.rules as { cards: unknown[] }).cards).toHaveLength(4);
    expect(stored.card_count).toBe(30);

    // Re-pushing identical content stays a no-op on (deck_id, version).
    expect((await postDecks(baseUrl, secret, sampleDeckBatch({
      rulesCanonical: canonical,
      rulesHash: fingerprintFor(canonical),
    }))).status).toBe(200);
    const rows = await pool.query(`SELECT 1 FROM deck_definitions WHERE deck_id = 'king-kong'`);
    expect(rows.rowCount).toBe(1);
  });

  it('rejects rules whose digest disagrees with the fingerprint they are filed under', async () => {
    const canonical = sampleCanonicalRules();
    const response = await postDecks(baseUrl, secret, sampleDeckBatch({
      rulesCanonical: canonical,
      // The fingerprint of a *different* balance of the same deck.
      rulesHash: fingerprintFor(sampleCanonicalRules({ attackValue: 6 })),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });

    const stored = await pool.query(`SELECT 1 FROM deck_definitions WHERE deck_id = 'king-kong'`);
    expect(stored.rowCount).toBe(0);
  });

  it('stores rules under an unknown algorithm prefix unverified instead of rejecting', async () => {
    // The engine may ship fp2 before this service learns to verify it. Rejecting
    // would break every deck push on that day; storing keeps the archive going.
    const response = await postDecks(baseUrl, secret, sampleDeckBatch({
      rulesCanonical: 'fp2|hero={"id":"king-kong"}|cards=[{"quantity":30,"type":"attack"}]',
      rulesHash: 'fp2-0123456789abcdef',
    }));
    expect(response.status).toBe(200);

    const stored = (await archivedRules(pool)).rows[0]!;
    expect(stored.rules_hash).toBe('fp2-0123456789abcdef');
    expect(stored.rules_canonical).toBe('fp2|hero={"id":"king-kong"}|cards=[{"quantity":30,"type":"attack"}]');
  });

  it('keeps two versions of one deck diffable down to values, quantities, effects and stats', async () => {
    const before = sampleCanonicalRules();
    const after = sampleCanonicalRules({
      heroHealth: 17,
      sidekickHealth: 7,
      attackValue: 6,
      attackQuantity: 10,
      attackEffect: [{ op: 'damage', value: 3 }],
    });
    expect((await postDecks(baseUrl, secret, sampleDeckBatch({
      version: '0.1.0', rulesCanonical: before, rulesHash: fingerprintFor(before),
    }))).status).toBe(200);
    expect((await postDecks(baseUrl, secret, sampleDeckBatch({
      version: '0.2.0', rulesCanonical: after, rulesHash: fingerprintFor(after),
    }))).status).toBe(200);

    const repo = new PgTelemetryRepository(pool);
    const versions = await repo.deckRulesArchive({ deckId: 'king-kong' });
    expect(versions).toHaveLength(2);
    expect(versions.map((row) => row.version).sort()).toEqual(['0.1.0', '0.2.0']);
    expect(versions.every((row) => row.rulesCanonical !== null && row.rules !== null)).toBe(true);

    // Fingerprint -> rules: the lookup a balancing run makes from a seat's hash.
    const byFingerprint = await repo.deckRulesArchive({ rulesHash: fingerprintFor(after) });
    expect(byFingerprint).toHaveLength(1);
    expect(byFingerprint[0]).toMatchObject({ deckId: 'king-kong', version: '0.2.0', rulesCanonical: after });

    const heroOf = (version: string) => versions.find((row) => row.version === version)!.rules!.hero as {
      health: number; sidekick: { health: number };
    };
    expect(heroOf('0.1.0').health).toBe(18);
    expect(heroOf('0.2.0').health).toBe(17);
    expect(heroOf('0.1.0').sidekick.health).toBe(8);
    expect(heroOf('0.2.0').sidekick.health).toBe(7);

    const attackOf = (version: string) => (versions.find((row) => row.version === version)!.rules!.cards as {
      id: string; value: number; quantity: number; effects: unknown[];
    }[]).find((card) => card.id === 'king-kong/a')!;
    expect(attackOf('0.1.0')).toMatchObject({ value: 5, quantity: 12, effects: [{ op: 'damage', value: 2 }] });
    expect(attackOf('0.2.0')).toMatchObject({ value: 6, quantity: 10, effects: [{ op: 'damage', value: 3 }] });

    // Same facts are reachable in SQL, without parsing text.
    const sql = await pool.query<{ version: string; hero_health: number; attack_value: number }>(
      `SELECT version,
              (rules -> 'hero' ->> 'health')::int AS hero_health,
              (card ->> 'value')::int AS attack_value
       FROM deck_definitions, jsonb_array_elements(rules -> 'cards') AS card
       WHERE deck_id = 'king-kong' AND card ->> 'id' = 'king-kong/a'
       ORDER BY version`,
    );
    expect(sql.rows).toEqual([
      { version: '0.1.0', hero_health: 18, attack_value: 5 },
      { version: '0.2.0', hero_health: 17, attack_value: 6 },
    ]);
  });

  it('does not disturb the dashboard composition read path when rules are archived', async () => {
    const canonical = sampleCanonicalRules();
    expect((await postDecks(baseUrl, secret, sampleDeckBatch({
      rulesCanonical: canonical, rulesHash: fingerprintFor(canonical),
    }))).status).toBe(200);
    await postGame(baseUrl, secret, sampleGame({ gameId: 'rules-arch-001', stateHash: 'rules-arch-state-001' }), 'rules-arch-001');

    const dash = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    const dashJson = await dash.json() as { decks: { deck: string; composition: Record<string, unknown> | null }[] };
    const composition = dashJson.decks.find((deck) => deck.deck === 'king-kong@0.1.0')?.composition;
    expect(composition).toMatchObject({ cardCount: 30, attack: 12, rulesHash: fingerprintFor(canonical) });
    // The multi-kilobyte archive stays off the dashboard payload.
    expect(composition).not.toHaveProperty('rulesCanonical');
    expect(composition).not.toHaveProperty('rules');
  });

  it('requires a signature to push deck definitions', async () => {
    const response = await fetch(`${baseUrl}/v1/decks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleDeckBatch()),
    });
    expect(response.status).toBe(401);
  });

  it('ingests deck definitions and exposes real composition on the dashboard', async () => {
    const push = await postDecks(baseUrl, secret, sampleDeckBatch());
    expect(push.status).toBe(200);
    expect(await push.json()).toMatchObject({ ok: true, upserted: 1 });

    await postGame(baseUrl, secret, sampleGame({ gameId: 'comp-game-001', stateHash: 'comp-state-001' }), 'comp-game-001');

    const dash = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    const dashJson = await dash.json() as { decks: { deck: string; composition: { cardCount: number; attack: number; lean: string } | null }[] };
    const king = dashJson.decks.find((deck) => deck.deck === 'king-kong@0.1.0');
    expect(king?.composition).toMatchObject({ cardCount: 30, attack: 12, lean: 'Offensive' });

    const detail = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&pilots=bot:hard`);
    const detailJson = await detail.json() as { composition: { cardCount: number; defenseValue: number } | null };
    expect(detailJson.composition).toMatchObject({ cardCount: 30 });
  });

  it('falls back to the latest version when the exact deck version is unknown', async () => {
    await postDecks(baseUrl, secret, sampleDeckBatch({ version: '9.9.9' }));
    await postGame(baseUrl, secret, sampleGame({ gameId: 'ver-game-001', stateHash: 'ver-state-001' }), 'ver-game-001');

    const dash = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    const dashJson = await dash.json() as { decks: { deck: string; composition: { version: string } | null }[] };
    const king = dashJson.decks.find((deck) => deck.deck === 'king-kong@0.1.0');
    // game deck is @0.1.0, registry only has @9.9.9 -> latest fallback.
    expect(king?.composition?.version).toBe('9.9.9');
  });

  it('rejects malformed deck definitions', async () => {
    const response = await postDecks(baseUrl, secret, { schemaVersion: 1, decks: [{ deckId: 'x', version: '1', cards: [{ type: 'bogus', quantity: 1 }] }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('serves 2v2 overall and partner performance on deck detail', async () => {
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-a', ['alpha', 'bravo', 'charlie', 'delta']), 'deck-2v2-a');
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-b', ['alpha', 'bravo', 'echo', 'foxtrot']), 'deck-2v2-b');
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-c', ['alpha', 'charlie', 'bravo', 'delta'], 1), 'deck-2v2-c');
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-d', ['alpha', 'charlie', 'echo', 'foxtrot'], 1), 'deck-2v2-d');

    const response = await fetch(`${baseUrl}/v1/stats/deck?deck=alpha@1.0.0&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      twoVTwo: {
        games: number;
        wins: number;
        winRate: number;
        partners: {
          deck: string;
          games: number;
          wins: number;
          winRate: number;
          delta: number;
          rawDelta: number;
          adjustedDelta: number;
          expectedWinRate: number;
        }[];
      };
    };
    expect(json.twoVTwo).toMatchObject({ games: 4, wins: 2, winRate: 0.5 });
    const bravo = json.twoVTwo.partners.find((p) => p.deck === 'bravo@1.0.0');
    expect(bravo).toMatchObject({ games: 2, wins: 2, winRate: 1, delta: 0.5, rawDelta: 0.5 });
    expect(bravo?.expectedWinRate).toBeCloseTo(0.5227, 4);
    expect(bravo?.adjustedDelta).toBeCloseTo(0.4773, 4);
    const charlie = json.twoVTwo.partners.find((p) => p.deck === 'charlie@1.0.0');
    expect(charlie).toMatchObject({ games: 2, wins: 0, winRate: 0, delta: -0.5, rawDelta: -0.5 });
    expect(charlie?.expectedWinRate).toBeCloseTo(0.4773, 4);
    expect(charlie?.adjustedDelta).toBeCloseTo(-0.4773, 4);
  });

  it('explores 2v2 scenarios with opponent-adjusted partner suggestions', async () => {
    await postGame(baseUrl, secret, twoVtwoGame('scenario-a', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-a');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-b', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-b');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-c', ['alpha', 'charlie', 'bravo', 'delta'], 1), 'scenario-c');

    const response = await fetch(`${baseUrl}/v1/stats/scenario?format=team-2v2&deck=alpha@1.0.0&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      partners: { deck: string; games: number; wins: number; winRate: number; expectedWinRate: number; adjustedDelta: number }[];
    };
    expect(json.totalGames).toBe(3);
    const bravo = json.partners.find((p) => p.deck === 'bravo@1.0.0');
    const charlie = json.partners.find((p) => p.deck === 'charlie@1.0.0');
    expect(bravo).toMatchObject({ games: 2, wins: 2, winRate: 1 });
    expect(charlie).toMatchObject({ games: 1, wins: 0, winRate: 0 });
    expect(bravo!.adjustedDelta).toBeGreaterThan(charlie!.adjustedDelta);
  });

  it('enumerates opponent matchups when a scenario partner is selected', async () => {
    await postGame(baseUrl, secret, twoVtwoGame('scenario-match-a', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-match-a');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-match-b', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-match-b');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-match-c', ['alpha', 'bravo', 'echo', 'foxtrot'], 1), 'scenario-match-c');

    const response = await fetch(`${baseUrl}/v1/stats/scenario?format=team-2v2&deck=alpha@1.0.0&partner=bravo@1.0.0&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      partners: { deck: string; games: number }[];
      matchups: { opponentA: string; opponentB: string; games: number; wins: number; winRate: number; expectedWinRate: number; adjustedDelta: number }[];
    };
    expect(json.totalGames).toBe(3);
    expect(json.partners).toContainEqual(expect.objectContaining({ deck: 'bravo@1.0.0', games: 3 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ opponentA: 'charlie@1.0.0', opponentB: 'delta@1.0.0', games: 2, wins: 2, winRate: 1 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ opponentA: 'echo@1.0.0', opponentB: 'foxtrot@1.0.0', games: 1, wins: 0, winRate: 0 }));
  });

  it('reports 2v2 synergy pair matchups (opposing pairs and decks)', async () => {
    // alpha+bravo win both games, vs charlie+delta and vs echo+foxtrot.
    await postGame(baseUrl, secret, twoVtwoGame('syn-a', ['alpha', 'bravo', 'charlie', 'delta']), 'syn-a');
    await postGame(baseUrl, secret, twoVtwoGame('syn-b', ['alpha', 'bravo', 'echo', 'foxtrot']), 'syn-b');

    const response = await fetch(`${baseUrl}/v1/stats/synergy?deckA=alpha@1.0.0&deckB=bravo@1.0.0`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      pairs: { deckA: string; deckB: string; games: number; wins: number; winRate: number }[];
      decks: { deck: string; games: number; winRate: number }[];
    };
    expect(json.totalGames).toBe(2);
    expect(json.pairs).toContainEqual(expect.objectContaining({ deckA: 'charlie@1.0.0', deckB: 'delta@1.0.0', games: 1, wins: 1, winRate: 1 }));
    expect(json.pairs).toContainEqual(expect.objectContaining({ deckA: 'echo@1.0.0', deckB: 'foxtrot@1.0.0', games: 1, wins: 1 }));
    expect(json.decks).toContainEqual(expect.objectContaining({ deck: 'echo@1.0.0', games: 1, winRate: 1 }));
    expect(json.decks.find((d) => d.deck === 'charlie@1.0.0')).toMatchObject({ games: 1, winRate: 1 });
  });

  it('400s synergy matchups without a pair', async () => {
    const response = await fetch(`${baseUrl}/v1/stats/synergy?deckA=alpha@1.0.0`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'MISSING_PAIR' });
  });

  it('lists recent games with teams and seats', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'recent-001', stateHash: 'recent-001' }), 'recent-001');
    const response = await fetch(`${baseUrl}/v1/stats/recent?limit=10`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      games: { gameId: string; format: string; winnerTeam: number | null; teams: { won: boolean; seats: { deckId: string; won: boolean }[] }[] }[];
    };
    const game = json.games.find((g) => g.gameId === 'recent-001');
    expect(game).toBeTruthy();
    expect(game).toMatchObject({ format: 'duel', winnerTeam: 0 });
    expect(game!.teams).toHaveLength(2);
    expect(game!.teams[0]).toMatchObject({ won: true });
    expect(game!.teams[0]!.seats[0]!.deckId).toBe('king-kong');
    expect(game!.teams[1]).toMatchObject({ won: false });
  });

  it('groups submissions by source', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'source-001', stateHash: 'source-001', source: 'engine' }), 'source-001');
    await postGame(baseUrl, secret, sampleGame({ gameId: 'source-002', stateHash: 'source-002', source: 'steven:laptop:lab' }), 'source-002');
    await postGame(baseUrl, secret, sampleGame({ gameId: 'source-003', stateHash: 'source-003', source: 'steven:laptop:lab' }), 'source-003');

    const response = await fetch(`${baseUrl}/v1/stats/sources`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalSubmissions: number;
      sources: {
        source: string;
        submissions: number;
        lastReceivedAt: string | null;
        credentials: { credentialId: string | null; label: string; submissions: number; lastReceivedAt: string | null }[];
      }[];
    };
    expect(json.totalSubmissions).toBe(3);
    expect(json.sources[0]).toMatchObject({ source: 'steven:laptop:lab', submissions: 2 });
    expect(json.sources).toContainEqual(expect.objectContaining({ source: 'engine', submissions: 1 }));
    expect(json.sources[0]!.lastReceivedAt).toBeTruthy();
  });

  it('splits a named source by bearer credential label', async () => {
    const source = await cpRepo.createSource('Steven', null, 'test-admin');
    const desktop = await cpRepo.createCredential(source.id, 'desktop', ['games:submit'], 'test-admin');
    const laptop = await cpRepo.createCredential(source.id, 'laptop', ['games:submit'], 'test-admin');

    const submit = async (credential: string, gameId: string) => fetch(`${baseUrl}/v1/games`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        'idempotency-key': gameId,
      },
      body: JSON.stringify(sampleGame({ gameId, stateHash: `${gameId}-state`, source: 'spoofed' })),
    });
    expect((await submit(desktop.fullKey, 'source-desktop-1')).status).toBe(201);
    expect((await submit(desktop.fullKey, 'source-desktop-2')).status).toBe(201);
    expect((await submit(laptop.fullKey, 'source-laptop-1')).status).toBe(201);

    const response = await fetch(`${baseUrl}/v1/stats/sources`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      sources: {
        source: string;
        submissions: number;
        credentials: { credentialId: string | null; label: string; submissions: number }[];
      }[];
    };
    const steven = json.sources.find(row => row.source === 'Steven');
    expect(steven).toMatchObject({ submissions: 3 });
    expect(steven!.credentials).toEqual([
      expect.objectContaining({ credentialId: desktop.id, label: 'desktop', submissions: 2 }),
      expect.objectContaining({ credentialId: laptop.id, label: 'laptop', submissions: 1 }),
    ]);
  });

  it('serves cached hourly recent game buckets', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'recent-hourly-001', stateHash: 'recent-hourly-001' }), 'recent-hourly-001');
    const response = await fetch(`${baseUrl}/v1/stats/recent/hourly`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('max-age=300');
    const json = await response.json() as {
      totals: { format: string; games: number }[];
      buckets: { hour: string; total: number; formats: { format: string; games: number }[] }[];
    };
    expect(json.totals).toContainEqual(expect.objectContaining({ format: 'duel', games: 1 }));
    expect(json.buckets).toHaveLength(24);
    const currentHour = json.buckets.at(-1);
    expect(currentHour?.hour).toBe('2026-07-14T16:00:00.000Z');
    expect(currentHour).toMatchObject({ total: 1 });
    expect(currentHour?.formats).toContainEqual(expect.objectContaining({ format: 'duel', games: 1 }));
  });

  it('stores invalid submissions and returns validation errors', async () => {
    const response = await postRaw(baseUrl, secret, { schemaVersion: 1, format: 'duel', map: 'mended-drum', teams: [], winner: 0 }, 'bad-game-001');
    expect(response.status).toBe(400);
    const json = await response.json() as { code: string; submissionId: string; errors: string[] };
    expect(json.code).toBe('VALIDATION_FAILED');
    expect(json.submissionId).toBeTruthy();
    const stored = await pool.query('SELECT validation_status FROM game_submissions WHERE id = $1', [json.submissionId]);
    expect(stored.rows[0]?.validation_status).toBe('invalid');
  });
});

function sampleDeckBatch(
  overrides: { version?: string; rulesHash?: string; rulesCanonical?: string } = {},
): unknown {
  return {
    schemaVersion: 1,
    source: 'test',
    contentVersion: '0.1.0',
    decks: [
      {
        deckId: 'king-kong',
        version: overrides.version ?? '0.1.0',
        ...(overrides.rulesHash === undefined ? {} : { rulesHash: overrides.rulesHash }),
        ...(overrides.rulesCanonical === undefined ? {} : { rulesCanonical: overrides.rulesCanonical }),
        name: 'King Kong',
        tier: 'community',
        cards: [
          { id: 'king-kong/a', title: 'A', type: 'attack', value: 5, boost: 2, quantity: 12 },
          { id: 'king-kong/d', title: 'D', type: 'defense', value: 2, boost: 2, quantity: 6 },
          { id: 'king-kong/v', title: 'V', type: 'versatile', value: 3, boost: 2, quantity: 8 },
          { id: 'king-kong/s', title: 'S', type: 'scheme', value: null, boost: 2, quantity: 4 },
        ],
      },
    ],
  };
}

function archivedRules(pool: Pool) {
  return pool.query<{
    rules_hash: string | null;
    rules_canonical: string | null;
    rules: unknown;
    card_count: number;
  }>(
    `SELECT rules_hash, rules_canonical, rules, card_count
     FROM deck_definitions WHERE deck_id = 'king-kong' ORDER BY version`,
  );
}

async function postDecks(baseUrl: string, secret: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signBody(secret, body, '2026-07-14T16:30:00.000Z');
  return fetch(`${baseUrl}/v1/decks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unbrewed-timestamp': timestamp,
      'x-unbrewed-signature': signature,
    },
    body,
  });
}

function twoVtwoGame(id: string, decks: [string, string, string, string], winner = 0): unknown {
  const seat = (deck: string, player: string) => ({ deck: `${deck}@1.0.0`, pilot: 'bot:hard', runtimePlayerId: player, heroId: deck });
  return sampleGame({
    gameId: id,
    stateHash: id,
    format: 'team-2v2',
    formatLabel: '2v2',
    teams: [
      { seats: [seat(decks[0], 'p1'), seat(decks[1], 'p2')] },
      { seats: [seat(decks[2], 'p3'), seat(decks[3], 'p4')] },
    ],
    winner,
  });
}

async function postGame(baseUrl: string, secret: string, payload: unknown, idempotencyKey: string): Promise<Response> {
  return postRaw(baseUrl, secret, payload, idempotencyKey);
}

async function postRaw(baseUrl: string, secret: string, payload: unknown, idempotencyKey: string): Promise<Response> {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signBody(secret, body, '2026-07-14T16:30:00.000Z');
  return fetch(`${baseUrl}/v1/games`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-unbrewed-timestamp': timestamp,
      'x-unbrewed-signature': signature,
    },
    body,
  });
}
