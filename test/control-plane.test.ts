import { describe, expect, it } from 'vitest';
import { hashSecret, verifySecret, generateCredential, parseBearer, hasScope, type Scope } from '../src/http/bearer-auth.js';

import { unixNanoSeed } from '../src/db/control-plane-repository.js';

describe('campaign seeds', () => {
  it('builds a Unix nanosecond seed without losing integer precision', () => {
    expect(unixNanoSeed(1_000, 42)).toBe('1000000042');
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
