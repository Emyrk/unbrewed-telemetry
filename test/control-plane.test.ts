import { describe, expect, it } from 'vitest';
import { hashSecret, verifySecret, generateCredential, parseBearer, hasScope, type Scope } from '../src/http/bearer-auth.js';

import { resolveCampaignJobSpec, unixNanoSeed } from '../src/db/control-plane-repository.js';

describe('campaign seeds', () => {
  it('builds a Unix nanosecond seed without losing integer precision', () => {
    expect(unixNanoSeed(1_000, 42)).toBe('1000000042');
  });
});

describe('campaign pool resolution', () => {
  const pooledSpec = {
    format: 'duel',
    maps: ['sarpedon', 'heorot'],
    swapStartingPlayer: true,
    teams: [
      { seats: [{ decks: ['king-taranis-spice', 'thrall-spice'], pilots: ['bot:hard', 'bot:medium'] }] },
      { seats: [{ decks: ['medusa-spice'], pilots: ['bot:easy', 'bot:medium'] }] },
    ],
  };

  it('deterministically resolves pools into an exact runner specification', () => {
    const first = resolveCampaignJobSpec(pooledSpec, '12345') as any;
    const repeated = resolveCampaignJobSpec(pooledSpec, '12345') as any;
    expect(repeated).toEqual(first);
    expect(first.maps).toBeUndefined();
    expect(['sarpedon', 'heorot']).toContain(first.map);
    expect(first.teams[0].seats[0].decks).toBeUndefined();
    expect(first.teams[0].seats[0].pilots).toBeUndefined();
    expect(['king-taranis-spice', 'thrall-spice']).toContain(first.teams[0].seats[0].deck);
    expect(['bot:hard', 'bot:medium']).toContain(first.teams[0].seats[0].pilot);
    expect(first.teams[1].seats[0]).toMatchObject({ deck: 'medusa-spice' });
  });

  it('rejects empty seat pools', () => {
    expect(() => resolveCampaignJobSpec({
      format: 'duel',
      teams: [{ seats: [{ decks: [], pilots: ['bot:hard'] }] }],
    }, '1')).toThrow('campaign spec: teams[0].seats[0].decks must be a non-empty string array');
  });
});

describe('bearer-auth', () => {
  it('hashes and verifies a secret', () => {
    const secret = 'test-secret-value-abc123';
    const hashed = hashSecret(secret);
    expect(hashed.hash).toBeTruthy();
    expect(hashed.salt).toBeTruthy();
    expect(verifySecret(secret, hashed.salt, hashed.hash)).toBe(true);
    expect(verifySecret('wrong-secret', hashed.salt, hashed.hash)).toBe(false);
  });

  it('generates a credential with the correct format', () => {
    const { fullKey, secret } = generateCredential('abcdef12');
    expect(fullKey).toMatch(/^ubk_abcdef12\..{64}$/);
    expect(secret.length).toBe(64);
  });

  it('parses a valid bearer token', () => {
    const result = parseBearer({ authorization: 'Bearer ubk_abc123.secretpart' });
    expect(result).toEqual({ keyId: 'ubk_abc123', secret: 'secretpart' });
  });

  it('returns null for non-bearer auth headers', () => {
    expect(parseBearer({})).toBeNull();
    expect(parseBearer({ authorization: 'Basic dXNlcjpwYXNz' })).toBeNull();
    expect(parseBearer({ authorization: 'Bearer plain-token-no-ubk' })).toBeNull();
  });

  it('checks scopes correctly', () => {
    const scopes = ['games:submit', 'sim:claim'];
    expect(hasScope(scopes, 'games:submit')).toBe(true);
    expect(hasScope(scopes, 'sim:claim')).toBe(true);
    expect(hasScope(scopes, 'decks:submit')).toBe(false);
    expect(hasScope(scopes, 'sim:complete')).toBe(false);
  });
});

describe('credential round-trip (hash → verify)', () => {
  it('verifies a generated credential secret against its hash', () => {
    const { secret } = generateCredential('roundtrip');
    const hashed = hashSecret(secret);
    expect(verifySecret(secret, hashed.salt, hashed.hash)).toBe(true);
  });
});

// DB-backed tests
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('control-plane repository with postgres', () => {
  let pool: Pool;
  let repo: ControlPlaneRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new ControlPlaneRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE admin_sessions, telemetry_sources, source_credentials, sim_campaigns, sim_jobs CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('admin sessions', () => {
    it('creates and retrieves a session', async () => {
      const session = await repo.createSession({ discordId: '12345', discordUsername: 'testuser' });
      expect(session.id).toBeTruthy();
      expect(session.discordId).toBe('12345');

      const retrieved = await repo.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.discordUsername).toBe('testuser');
    });

    it('returns null for expired sessions', async () => {
      const session = await repo.createSession({ discordId: '12345', discordUsername: 'testuser', ttlMs: -1000 });
      const retrieved = await repo.getSession(session.id);
      expect(retrieved).toBeNull();
    });

    it('deletes a session', async () => {
      const session = await repo.createSession({ discordId: '12345', discordUsername: 'testuser' });
      await repo.deleteSession(session.id);
      const retrieved = await repo.getSession(session.id);
      expect(retrieved).toBeNull();
    });
  });

  describe('telemetry sources and credentials', () => {
    it('creates a source and lists it', async () => {
      const source = await repo.createSource('test-engine', 'Test engine source', 'admin');
      expect(source.name).toBe('test-engine');

      const sources = await repo.listSources();
      expect(sources.length).toBeGreaterThanOrEqual(1);
      expect(sources.find(s => s.name === 'test-engine')).toBeTruthy();
    });

    it('rejects duplicate source names', async () => {
      await repo.createSource('unique-name', null, 'admin');
      await expect(repo.createSource('unique-name', null, 'admin')).rejects.toThrow();
    });

    it('creates a credential and verifies it', async () => {
      const source = await repo.createSource('cred-test', null, 'admin');
      const cred = await repo.createCredential(source.id, 'test-key', ['games:submit', 'sim:claim'], 'admin');
      expect(cred.fullKey).toMatch(/^ubk_/);
      expect(cred.label).toBe('test-key');
      expect(cred.scopes).toContain('games:submit');

      // Parse the key and verify lookup
      const parsed = parseBearer({ authorization: `Bearer ${cred.fullKey}` });
      expect(parsed).not.toBeNull();
      const row = await repo.lookupCredential(parsed!.keyId);
      expect(row).not.toBeNull();
      expect(row!.source_name).toBe('cred-test');
      expect(verifySecret(parsed!.secret, row!.salt, row!.hash)).toBe(true);
    });

    it('revokes a credential', async () => {
      const source = await repo.createSource('revoke-test', null, 'admin');
      const cred = await repo.createCredential(source.id, 'to-revoke', ['games:submit'], 'admin');
      const revoked = await repo.revokeCredential(cred.id);
      expect(revoked).toBe(true);

      const row = await repo.lookupCredential(cred.id);
      expect(row!.revoked_at).not.toBeNull();

      // Double-revoke returns false
      const again = await repo.revokeCredential(cred.id);
      expect(again).toBe(false);
    });

    it('deletes source cascades credentials', async () => {
      const source = await repo.createSource('cascade-test', null, 'admin');
      await repo.createCredential(source.id, 'key1', ['games:submit'], 'admin');
      await repo.deleteSource(source.id);
      const sources = await repo.listSources();
      expect(sources.find(s => s.id === source.id)).toBeUndefined();
    });
  });

  describe('simulation worker sessions', () => {
    it('reuses a live session and starts a new one after the liveness window', async () => {
      const source = await repo.createSource('fleet-workers', null, 'admin');
      const credential = await repo.createCredential(source.id, 'worker-a', ['sim:claim'], 'admin');
      const started = new Date('2026-07-22T10:00:00.000Z');

      const sessionId = await repo.touchWorkerSession(credential.id, started, {
        concurrency: 4,
        workerVersion: 'engine-1.2.3',
      });
      const reused = await repo.touchWorkerSession(credential.id, new Date('2026-07-22T10:05:00.000Z'), {
        sessionId,
        concurrency: 6,
      });
      expect(reused).toBe(sessionId);

      const snapshot = await repo.fleetSnapshot(new Date('2026-07-22T10:06:00.000Z'));
      expect(snapshot).toMatchObject({ liveWorkers: 1, workingWorkers: 0, idleWorkers: 1, activeJobs: 0 });
      expect(snapshot.workers[0]).toMatchObject({
        sessionId,
        workerLabel: 'worker-a',
        workerVersion: 'engine-1.2.3',
        reportedConcurrency: 6,
        status: 'idle',
      });

      const restarted = await repo.touchWorkerSession(credential.id, new Date('2026-07-22T10:21:00.000Z'), { sessionId });
      expect(restarted).not.toBe(sessionId);
    });

    it('reports live leases, campaign assignments, and fleet utilization', async () => {
      const source = await repo.createSource('fleet-jobs', null, 'admin');
      const credential = await repo.createCredential(source.id, 'worker-b', ['sim:claim'], 'admin');
      const at = new Date();
      await repo.touchWorkerSession(credential.id, at, { concurrency: 4 });
      const campaign = await repo.createCampaign({
        name: 'Fleet Campaign', spec: { format: 'duel' }, games: [{}, {}], createdBy: 'admin',
      });
      await repo.claimJobs(campaign.id, 2, credential.id, 60 * 60 * 1000);

      const snapshot = await repo.fleetSnapshot(new Date(at.getTime() + 1000));
      expect(snapshot).toMatchObject({ liveWorkers: 1, workingWorkers: 1, idleWorkers: 0, activeJobs: 2, totalConcurrency: 4 });
      expect(snapshot.workers[0]).toMatchObject({
        workerLabel: 'worker-b',
        status: 'working',
        activeJobs: 2,
        reportedConcurrency: 4,
        utilization: 0.5,
        campaigns: [{ campaignId: campaign.id, campaignName: 'Fleet Campaign', jobs: 2 }],
      });
      expect(snapshot.workers[0]!.jobIds).toHaveLength(2);
    });
  });

  describe('simulation campaigns and jobs', () => {
    it('creates a campaign with jobs', async () => {
      const campaign = await repo.createCampaign({
        name: 'Test Sim',
        spec: { format: 'duel', decks: ['a', 'b'] },
        baseSeed: 42,
        games: [{}, {}, {}],
        createdBy: 'admin',
      });
      expect(campaign.totalGames).toBe(3);
      expect(campaign.completedGames).toBe(0);
      expect(campaign.status).toBe('active');

      const detail = await repo.getCampaign(campaign.id);
      expect(detail).not.toBeNull();
      expect(detail!.jobs.length).toBe(3);
      expect(campaign.baseSeed).toBe('42');
      expect(detail!.jobs[0]!.seed).toBe('42');
      expect(detail!.jobs[1]!.seed).toBe('43');
      expect(detail!.jobs[2]!.seed).toBe('44');
    });

    it('defaults campaign seeds from Unix nanoseconds', async () => {
      const campaign = await repo.createCampaign({
        name: 'Automatic Seed',
        spec: { format: 'duel' },
        games: [{}, {}],
        createdBy: 'admin',
      });
      expect(campaign.baseSeed).toMatch(/^\d{19}$/);
      const detail = await repo.getCampaign(campaign.id);
      expect(BigInt(detail!.jobs[1]!.seed) - BigInt(detail!.jobs[0]!.seed)).toBe(1n);
    });

    it('stores exact per-job assignments resolved from campaign pools', async () => {
      const campaign = await repo.createCampaign({
        name: 'Pool Campaign',
        baseSeed: '500',
        spec: {
          format: 'duel',
          maps: ['sarpedon', 'heorot'],
          teams: [
            { seats: [{ decks: ['king-taranis-spice', 'thrall-spice'], pilots: ['bot:hard'] }] },
            { seats: [{ decks: ['medusa-spice'], pilots: ['bot:medium', 'bot:easy'] }] },
          ],
        },
        games: [{}, {}, {}],
        createdBy: 'admin',
      });
      const detail = await repo.getCampaign(campaign.id);
      for (const job of detail!.jobs) {
        const spec = job.spec as any;
        expect(spec.maps).toBeUndefined();
        expect(['sarpedon', 'heorot']).toContain(spec.map);
        expect(spec.teams[0].seats[0].decks).toBeUndefined();
        expect(['king-taranis-spice', 'thrall-spice']).toContain(spec.teams[0].seats[0].deck);
        expect(spec.teams[0].seats[0].pilot).toBe('bot:hard');
        expect(spec.teams[1].seats[0].deck).toBe('medusa-spice');
        expect(['bot:medium', 'bot:easy']).toContain(spec.teams[1].seats[0].pilot);
      }
    });

    it('bulk-creates 10,000 transient game jobs', async () => {
      const campaign = await repo.createCampaign({
        name: 'Large Campaign',
        spec: { format: 'duel' },
        baseSeed: 10_000,
        games: Array.from({ length: 10_000 }, () => ({})),
        createdBy: 'admin',
      });
      expect(campaign.totalGames).toBe(10_000);
      const count = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM sim_jobs WHERE campaign_id = $1',
        [campaign.id],
      );
      expect(Number(count.rows[0]?.count ?? 0)).toBe(10_000);
    });

    it('updates campaign JSON, regenerates unfinished jobs, and requeues terminal failures', async () => {
      const campaign = await repo.createCampaign({
        name: 'Broken Campaign',
        spec: { maps: ['mended-drum'] },
        baseSeed: 700,
        games: [{}, {}],
        createdBy: 'admin',
      });

      const [failedJob] = await repo.claimJobs(campaign.id, 1, 'runner');
      await pool.query(
        `UPDATE sim_jobs SET status = 'failed', attempts = max_attempts,
                lease_token = NULL, leased_by = NULL, leased_at = NULL,
                lease_expires_at = NULL, last_error = 'missing format'
         WHERE id = $1`,
        [failedJob!.id],
      );
      await pool.query(
        `UPDATE sim_campaigns SET failed_games = 1, status = 'completed', completed_at = now()
         WHERE id = $1`,
        [campaign.id],
      );

      const result = await repo.updateCampaign(campaign.id, {
        name: 'Repaired Campaign',
        description: 'Added the missing runner format',
        contentVersion: '0.10.0',
        spec: { format: 'duel', maps: ['mended-drum'] },
      });

      expect(result.kind).toBe('updated');
      if (result.kind !== 'updated') return;
      expect(result.regeneratedJobs).toBe(2);
      expect(result.requeuedFailedJobs).toBe(1);
      expect(result.campaign).toMatchObject({
        name: 'Repaired Campaign',
        failedGames: 0,
        status: 'active',
        completedAt: null,
      });

      const detail = await repo.getCampaign(campaign.id);
      expect(detail!.jobs).toHaveLength(2);
      for (const job of detail!.jobs) {
        expect(job.status).toBe('pending');
        expect(job.attempts).toBe(0);
        expect(job.lastError).toBeNull();
        expect(job.spec).toMatchObject({ format: 'duel', map: 'mended-drum' });
      }
    });

    it('refuses to edit a campaign while a worker holds a lease', async () => {
      const campaign = await repo.createCampaign({
        name: 'Busy Campaign',
        spec: { format: 'duel' },
        games: [{}],
        createdBy: 'admin',
      });
      await repo.claimJobs(campaign.id, 1, 'runner');

      const result = await repo.updateCampaign(campaign.id, {
        name: 'Should Not Change',
        spec: { format: 'team-2v2' },
      });
      expect(result).toEqual({ kind: 'leased_jobs', leasedJobs: 1 });

      const detail = await repo.getCampaign(campaign.id);
      expect(detail!.name).toBe('Busy Campaign');
      expect(detail!.spec).toEqual({ format: 'duel' });
      expect(detail!.jobs[0]!.status).toBe('leased');
    });

    it('schedules priority tiers and round-robins campaigns side by side', async () => {
      const first = await repo.createCampaign({
        name: 'First created', spec: { format: 'duel' }, games: [{}, {}, {}], createdBy: 'admin',
      });
      const roundRobinA = await repo.createCampaign({
        name: 'Round robin A', spec: { format: 'duel' }, games: [{}, {}, {}], createdBy: 'admin',
      });
      const roundRobinB = await repo.createCampaign({
        name: 'Round robin B', spec: { format: 'duel' }, games: [{}, {}, {}], createdBy: 'admin',
      });

      expect(first.priorityTier).toBe(0);
      expect(roundRobinA.priorityTier).toBe(1);
      expect(roundRobinB.priorityTier).toBe(2);

      const scheduled = await repo.updateCampaignSchedule([
        [roundRobinA.id, roundRobinB.id],
        [first.id],
      ]);
      expect(scheduled.filter(c => c.status === 'active').map(c => [c.id, c.priorityTier, c.priorityPosition])).toEqual([
        [roundRobinA.id, 0, 0],
        [roundRobinB.id, 0, 1],
        [first.id, 1, 0],
      ]);

      const batch = await repo.claimJobs(null, 7, 'runner');
      expect(batch.map(job => job.campaignId)).toEqual([
        roundRobinA.id,
        roundRobinB.id,
        roundRobinA.id,
        roundRobinB.id,
        roundRobinA.id,
        roundRobinB.id,
      ]);
      // Lower tiers remain blocked even when every higher-tier job is leased.
      expect(await repo.claimJobs(null, 1, 'other-runner')).toEqual([]);
      for (const job of batch) await repo.completeJob(job.id, job.leaseToken!);
      const [next] = await repo.claimJobs(null, 1, 'other-runner');
      expect(next!.campaignId).toBe(first.id);
    });

    it('rotates single-job claims across campaigns in one priority tier', async () => {
      const a = await repo.createCampaign({
        name: 'A', spec: { format: 'duel' }, games: [{}, {}], createdBy: 'admin',
      });
      const b = await repo.createCampaign({
        name: 'B', spec: { format: 'duel' }, games: [{}, {}], createdBy: 'admin',
      });
      await repo.updateCampaignSchedule([[a.id, b.id]]);

      const [first] = await repo.claimJobs(null, 1, 'runner');
      expect(first!.campaignId).toBe(a.id);
      await repo.releaseJob(first!.id, first!.leaseToken!, 'runner');

      const [second] = await repo.claimJobs(null, 1, 'runner');
      expect(second!.campaignId).toBe(b.id);
      await repo.releaseJob(second!.id, second!.leaseToken!, 'runner');

      const [third] = await repo.claimJobs(null, 1, 'runner');
      expect(third!.campaignId).toBe(a.id);
    });

    it('rejects stale or duplicate campaign schedules', async () => {
      const campaign = await repo.createCampaign({
        name: 'Only', spec: { format: 'duel' }, games: [{}], createdBy: 'admin',
      });
      await expect(repo.updateCampaignSchedule([[campaign.id, campaign.id]])).rejects.toThrow('duplicate');
      await expect(repo.updateCampaignSchedule([])).rejects.toThrow('every active or paused campaign');
    });

    it('claims jobs with SKIP LOCKED exclusivity', async () => {
      const campaign = await repo.createCampaign({
        name: 'Claim Test',
        spec: { format: 'duel' },
        games: [{}, {}, {}, {}, {}],
        createdBy: 'admin',
      });

      // Claim 3 jobs
      const batch1 = await repo.claimJobs(campaign.id, 3, 'runner-1');
      expect(batch1.length).toBe(3);
      expect(batch1[0]!.leaseToken).toBeTruthy();
      expect(batch1[0]!.status).toBe('leased');

      // Claim remaining 2
      const batch2 = await repo.claimJobs(campaign.id, 10, 'runner-2');
      expect(batch2.length).toBe(2);

      // No more jobs
      const batch3 = await repo.claimJobs(campaign.id, 10, 'runner-3');
      expect(batch3.length).toBe(0);
    });

    it('summarizes jobs into buckets and paginates bucket entries', async () => {
      const campaign = await repo.createCampaign({
        name: 'Bucket Test',
        spec: { format: 'duel' },
        baseSeed: 100,
        games: [{}, {}, {}, {}, {}],
        createdBy: 'admin',
      });
      const [failedJob, leasedJob] = await repo.claimJobs(campaign.id, 2, 'runner');
      await pool.query(
        `UPDATE sim_jobs
         SET status = 'failed', lease_token = NULL, leased_by = NULL,
             leased_at = NULL, lease_expires_at = NULL, attempts = max_attempts,
             last_error = 'bad map'
         WHERE id = $1`,
        [failedJob!.id],
      );
      await pool.query('UPDATE sim_campaigns SET failed_games = 1 WHERE id = $1', [campaign.id]);

      const summary = await repo.getCampaign(campaign.id, false);
      expect(summary!.jobs).toEqual([]);
      expect(summary!.jobCounts).toEqual({ succeeded: 0, failed: 1, leased: 1, idle: 3 });
      expect(summary!.remainingJobs).toBe(5);

      const idlePage1 = await repo.listCampaignItems(campaign.id, 'idle', 1, 2);
      expect(idlePage1).toMatchObject({ bucket: 'idle', page: 1, pageSize: 2, total: 3, totalPages: 2 });
      expect(idlePage1!.items.map(item => item.gameIndex)).toEqual([2, 3]);
      const idlePage2 = await repo.listCampaignItems(campaign.id, 'idle', 2, 2);
      expect(idlePage2!.items.map(item => item.gameIndex)).toEqual([4]);

      const failed = await repo.listCampaignItems(campaign.id, 'failed', 1, 50);
      expect(failed!.items[0]).toMatchObject({ gameIndex: failedJob!.gameIndex, lastError: 'bad map' });
      const leased = await repo.listCampaignItems(campaign.id, 'leased', 1, 50);
      expect(leased!.items[0]).toMatchObject({ gameIndex: leasedJob!.gameIndex, leasedBy: 'runner' });
    });

    it('releases a lease without consuming an attempt', async () => {
      const campaign = await repo.createCampaign({
        name: 'Release Test',
        spec: { format: 'duel' },
        games: [{}],
        createdBy: 'admin',
      });
      const [job] = await repo.claimJobs(campaign.id, 1, 'runner-1');
      expect(job!.attempts).toBe(1);

      expect(await repo.releaseJob(job!.id, job!.leaseToken!, 'runner-2')).toBe(false);
      expect(await repo.releaseJob(job!.id, job!.leaseToken!, 'runner-1')).toBe(true);

      const detail = await repo.getCampaign(campaign.id);
      expect(detail!.jobs[0]).toMatchObject({
        status: 'pending',
        attempts: 0,
        leaseToken: null,
        leasedBy: null,
      });
      expect(await repo.claimJobs(campaign.id, 1, 'runner-2')).toHaveLength(1);
    });

    it('completes a job, deletes it, and increments counter', async () => {
      const campaign = await repo.createCampaign({
        name: 'Complete Test',
        spec: { format: 'duel' },
        games: [{}],
        createdBy: 'admin',
      });

      const [job] = await repo.claimJobs(campaign.id, 1, 'runner');
      expect(job).toBeTruthy();

      const provenance = await repo.completeJob(job!.id, job!.leaseToken!);
      expect(provenance).not.toBeNull();
      expect(provenance!.campaignId).toBe(campaign.id);
      expect(provenance!.gameIndex).toBe(0);

      // Job should be deleted
      const detail = await repo.getCampaign(campaign.id);
      expect(detail!.jobs.length).toBe(0);
      expect(detail!.completedGames).toBe(1);
      expect(detail!.status).toBe('completed'); // 1/1 done
    });

    it('rejects completion with wrong lease token', async () => {
      const campaign = await repo.createCampaign({
        name: 'Wrong Token',
        spec: {},
        games: [{}],
        createdBy: 'admin',
      });

      const [job] = await repo.claimJobs(campaign.id, 1, 'runner');
      const result = await repo.completeJob(job!.id, 'wrong-token');
      expect(result).toBeNull();
    });

    it('fails a job and requeues, then marks terminal on max attempts', async () => {
      const campaign = await repo.createCampaign({
        name: 'Fail Test',
        spec: {},
        games: [{}],
        createdBy: 'admin',
      });

      // First attempt
      const [job1] = await repo.claimJobs(campaign.id, 1, 'runner');
      const failed1 = await repo.failJob(job1!.id, job1!.leaseToken!, 'error 1');
      expect(failed1).toBe(true);

      // Should be requeued (attempt 1 of 3)
      let detail = await repo.getCampaign(campaign.id);
      expect(detail!.jobs[0]!.status).toBe('pending');
      expect(detail!.jobs[0]!.attempts).toBe(1);

      // Second attempt
      const [job2] = await repo.claimJobs(campaign.id, 1, 'runner');
      await repo.failJob(job2!.id, job2!.leaseToken!, 'error 2');

      // Third attempt
      const [job3] = await repo.claimJobs(campaign.id, 1, 'runner');
      await repo.failJob(job3!.id, job3!.leaseToken!, 'error 3');

      // Should be terminal failed now
      detail = await repo.getCampaign(campaign.id);
      expect(detail!.jobs[0]!.status).toBe('failed');
      expect(detail!.failedGames).toBe(1);
      expect(detail!.status).toBe('completed'); // 0 completed + 1 failed = 1 total
    });

    it('toggles a campaign inactive and active without deleting jobs', async () => {
      const campaign = await repo.createCampaign({
        name: 'Toggle Test',
        spec: { format: 'duel' },
        games: [{}, {}],
        createdBy: 'admin',
      });

      expect(await repo.setCampaignActive(campaign.id, false)).toBe('paused');
      let detail = await repo.getCampaign(campaign.id);
      expect(detail).toMatchObject({ status: 'paused', remainingJobs: 2 });
      expect(await repo.claimJobs(campaign.id, 2, 'runner')).toEqual([]);

      expect(await repo.setCampaignActive(campaign.id, true)).toBe('active');
      detail = await repo.getCampaign(campaign.id);
      expect(detail).toMatchObject({ status: 'active', remainingJobs: 2 });
      expect(await repo.claimJobs(campaign.id, 2, 'runner')).toHaveLength(2);
    });

    it('persists a heartbeat checkpoint and returns it verbatim on reclaim', async () => {
      const campaign = await repo.createCampaign({
        name: 'Checkpoint Test',
        spec: { format: 'duel' },
        games: [{}, {}],
        createdBy: 'admin',
      });

      const jobs = await repo.claimJobs(campaign.id, 2, 'runner-1');
      expect(jobs.length).toBe(2);
      expect(jobs[0]!.checkpoint).toBeUndefined();

      const checkpoint = {
        engineVersion: '1.4.2',
        journal: { actions: [{ t: 'draw', card: 'feint' }], prng: { main: '12345', shuffle: '678' } },
      };
      const renewed = await repo.renewLease(jobs[0]!.id, jobs[0]!.leaseToken!, 'runner-1', 60_000, checkpoint);
      expect(renewed).not.toBeNull();

      // Simulate a hard-killed worker: expire the lease, then reclaim from another runner.
      await pool.query(`UPDATE sim_jobs SET lease_expires_at = now() - interval '1 second' WHERE campaign_id = $1`, [campaign.id]);
      const reclaimed = await repo.claimJobs(campaign.id, 2, 'runner-2');
      expect(reclaimed.length).toBe(2);
      const withCheckpoint = reclaimed.find((j) => j.id === jobs[0]!.id);
      const withoutCheckpoint = reclaimed.find((j) => j.id === jobs[1]!.id);
      expect(withCheckpoint!.checkpoint).toEqual(checkpoint);
      // Job that never sent a checkpoint: field absent, not null.
      expect('checkpoint' in withoutCheckpoint!).toBe(false);
    });

    it('keeps the stored checkpoint on checkpoint-less heartbeats and overwrites on the next one', async () => {
      const campaign = await repo.createCampaign({
        name: 'Checkpoint LWW',
        spec: {},
        games: [{}],
        createdBy: 'admin',
      });
      const [job] = await repo.claimJobs(campaign.id, 1, 'runner');

      const first = { engineVersion: '1.0.0', journal: { seq: 1 } };
      await repo.renewLease(job!.id, job!.leaseToken!, 'runner', 60_000, first);
      // Plain heartbeat must not clear it.
      await repo.renewLease(job!.id, job!.leaseToken!, 'runner', 60_000);
      let stored = await pool.query<{ checkpoint: unknown }>(`SELECT checkpoint FROM sim_jobs WHERE id = $1`, [job!.id]);
      expect(stored.rows[0]!.checkpoint).toEqual(first);

      const second = { engineVersion: '1.0.0', journal: { seq: 2 } };
      await repo.renewLease(job!.id, job!.leaseToken!, 'runner', 60_000, second);
      stored = await pool.query<{ checkpoint: unknown }>(`SELECT checkpoint FROM sim_jobs WHERE id = $1`, [job!.id]);
      expect(stored.rows[0]!.checkpoint).toEqual(second);
    });

    it('never writes a checkpoint on an invalid or expired lease', async () => {
      const campaign = await repo.createCampaign({
        name: 'Checkpoint Guard',
        spec: {},
        games: [{}],
        createdBy: 'admin',
      });
      const [job] = await repo.claimJobs(campaign.id, 1, 'runner');

      const wrongToken = await repo.renewLease(job!.id, 'wrong-token', 'runner', 60_000, { engineVersion: 'x', journal: {} });
      expect(wrongToken).toBeNull();
      const wrongRunner = await repo.renewLease(job!.id, job!.leaseToken!, 'other-runner', 60_000, { engineVersion: 'x', journal: {} });
      expect(wrongRunner).toBeNull();

      await pool.query(`UPDATE sim_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [job!.id]);
      const expired = await repo.renewLease(job!.id, job!.leaseToken!, 'runner', 60_000, { engineVersion: 'x', journal: {} });
      expect(expired).toBeNull();

      const stored = await pool.query<{ checkpoint: unknown }>(`SELECT checkpoint FROM sim_jobs WHERE id = $1`, [job!.id]);
      expect(stored.rows[0]!.checkpoint).toBeNull();
    });

    it('keeps the checkpoint across a failed→pending requeue', async () => {
      const campaign = await repo.createCampaign({
        name: 'Checkpoint Requeue',
        spec: {},
        games: [{}],
        createdBy: 'admin',
      });
      const [job] = await repo.claimJobs(campaign.id, 1, 'runner');
      const checkpoint = { engineVersion: '2.0.0', journal: { turn: 40 } };
      await repo.renewLease(job!.id, job!.leaseToken!, 'runner', 60_000, checkpoint);

      await repo.failJob(job!.id, job!.leaseToken!, 'worker crashed mid-game');
      const [reclaimed] = await repo.claimJobs(campaign.id, 1, 'runner-2');
      expect(reclaimed!.id).toBe(job!.id);
      expect(reclaimed!.checkpoint).toEqual(checkpoint);
    });

    it('cancels a campaign and removes pending jobs', async () => {
      const campaign = await repo.createCampaign({
        name: 'Cancel Test',
        spec: {},
        games: [{}, {}],
        createdBy: 'admin',
      });

      const cancelled = await repo.cancelCampaign(campaign.id);
      expect(cancelled).toBe(true);

      const detail = await repo.getCampaign(campaign.id);
      expect(detail!.status).toBe('cancelled');
      expect(detail!.jobs.length).toBe(0);
    });
  });
});
