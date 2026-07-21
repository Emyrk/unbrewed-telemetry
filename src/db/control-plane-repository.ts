/**
 * Control-plane database operations: admin sessions, telemetry sources,
 * source credentials, simulation campaigns, and simulation jobs.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashSecret, verifySecret, generateCredential, type Scope } from '../http/bearer-auth.js';

// ============================================================================
// Admin sessions
// ============================================================================

export interface AdminSession {
  id: string;
  discordId: string;
  discordUsername: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface CreateSessionArgs {
  discordId: string;
  discordUsername: string;
  ttlMs?: number;
}

// ============================================================================
// Telemetry sources & credentials
// ============================================================================

export interface TelemetrySource {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  createdBy: string;
  credentials: CredentialSummary[];
}

export interface CredentialSummary {
  id: string;
  label: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface CreateCredentialResult {
  id: string;
  fullKey: string;
  label: string;
  scopes: string[];
}

export interface CredentialRow {
  id: string;
  source_id: string;
  source_name: string;
  scopes: string[];
  hash: string;
  salt: string;
  revoked_at: string | null;
}

// ============================================================================
// Simulation campaigns
// ============================================================================

export interface SimCampaign {
  id: string;
  name: string;
  description: string | null;
  spec: unknown;
  baseSeed: number;
  contentVersion: string | null;
  totalGames: number;
  completedGames: number;
  failedGames: number;
  status: string;
  createdAt: string;
  createdBy: string;
  cancelledAt: string | null;
  completedAt: string | null;
}

export interface CreateCampaignArgs {
  name: string;
  description?: string | undefined;
  spec: unknown;
  baseSeed?: number | undefined;
  contentVersion?: string | undefined;
  games: CampaignGameSpec[];
  createdBy: string;
}

export interface CampaignGameSpec {
  spec?: unknown;
}

// ============================================================================
// Simulation jobs
// ============================================================================

export interface SimJob {
  id: string;
  campaignId: string;
  gameIndex: number;
  seed: number;
  spec: unknown;
  status: string;
  leaseToken: string | null;
  leasedBy: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

export interface ClaimResult {
  jobs: SimJob[];
}

// ============================================================================
// Repository
// ============================================================================

export class ControlPlaneRepository {
  constructor(private readonly pool: Pool) {}

  // ---------- Admin sessions ----------

  async createSession(args: CreateSessionArgs): Promise<AdminSession> {
    const id = randomUUID();
    const ttl = args.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl);
    await this.pool.query(
      `INSERT INTO admin_sessions (id, discord_id, discord_username, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, args.discordId, args.discordUsername, now, expiresAt],
    );
    return { id, discordId: args.discordId, discordUsername: args.discordUsername, createdAt: now, expiresAt };
  }

  async getSession(id: string): Promise<AdminSession | null> {
    const result = await this.pool.query<{
      id: string;
      discord_id: string;
      discord_username: string;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, discord_id, discord_username, created_at, expires_at
       FROM admin_sessions WHERE id = $1 AND expires_at > now()`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      discordId: row.discord_id,
      discordUsername: row.discord_username,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query('DELETE FROM admin_sessions WHERE id = $1', [id]);
  }

  async cleanExpiredSessions(): Promise<number> {
    const result = await this.pool.query('DELETE FROM admin_sessions WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }

  // ---------- Telemetry sources ----------

  async createSource(name: string, description: string | null, createdBy: string): Promise<TelemetrySource> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO telemetry_sources (id, name, description, created_by)
       VALUES ($1, $2, $3, $4)`,
      [id, name, description, createdBy],
    );
    return { id, name, description, createdAt: new Date().toISOString(), createdBy, credentials: [] };
  }

  async listSources(): Promise<TelemetrySource[]> {
    const sources = await this.pool.query<{
      id: string; name: string; description: string | null;
      created_at: Date; created_by: string;
    }>(`SELECT id, name, description, created_at, created_by FROM telemetry_sources ORDER BY created_at`);

    const creds = await this.pool.query<{
      id: string; source_id: string; label: string; scopes: string[];
      created_at: Date; revoked_at: Date | null; last_used_at: Date | null;
    }>(`SELECT id, source_id, label, scopes, created_at, revoked_at, last_used_at
        FROM source_credentials ORDER BY created_at`);

    const credsBySource = new Map<string, CredentialSummary[]>();
    for (const c of creds.rows) {
      const list = credsBySource.get(c.source_id) ?? [];
      list.push({
        id: c.id,
        label: c.label,
        scopes: c.scopes,
        createdAt: c.created_at.toISOString(),
        revokedAt: c.revoked_at?.toISOString() ?? null,
        lastUsedAt: c.last_used_at?.toISOString() ?? null,
      });
      credsBySource.set(c.source_id, list);
    }

    return sources.rows.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      createdAt: s.created_at.toISOString(),
      createdBy: s.created_by,
      credentials: credsBySource.get(s.id) ?? [],
    }));
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM telemetry_sources WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ---------- Source credentials ----------

  async createCredential(
    sourceId: string,
    label: string,
    scopes: Scope[],
    createdBy: string,
  ): Promise<CreateCredentialResult> {
    const keyIdShort = randomBytes(8).toString('hex');
    const keyId = `ubk_${keyIdShort}`;
    const { fullKey, secret } = generateCredential(keyIdShort);
    const hashed = hashSecret(secret);

    await this.pool.query(
      `INSERT INTO source_credentials (id, source_id, label, scopes, hash, salt, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [keyId, sourceId, label, scopes, hashed.hash, hashed.salt, createdBy],
    );

    return { id: keyId, fullKey, label, scopes };
  }

  async revokeCredential(credentialId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE source_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [credentialId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Look up a credential by its key ID for bearer auth verification.
   * Returns null if not found; caller must verify the secret.
   */
  async lookupCredential(keyId: string): Promise<CredentialRow | null> {
    const result = await this.pool.query<CredentialRow>(
      `SELECT sc.id, sc.source_id, ts.name AS source_name, sc.scopes, sc.hash, sc.salt, sc.revoked_at
       FROM source_credentials sc
       JOIN telemetry_sources ts ON ts.id = sc.source_id
       WHERE sc.id = $1`,
      [keyId],
    );
    return result.rows[0] ?? null;
  }

  async touchCredentialLastUsed(credentialId: string): Promise<void> {
    await this.pool.query(
      `UPDATE source_credentials SET last_used_at = now() WHERE id = $1`,
      [credentialId],
    );
  }

  // ---------- Simulation campaigns ----------

  async createCampaign(args: CreateCampaignArgs): Promise<SimCampaign> {
    const id = randomUUID();
    const baseSeed = args.baseSeed ?? 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO sim_campaigns (id, name, description, spec, base_seed, content_version, total_games, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [id, args.name, args.description ?? null, JSON.stringify(args.spec), baseSeed,
         args.contentVersion ?? null, args.games.length, args.createdBy],
      );

      const jobIds: string[] = [];
      const gameIndexes: number[] = [];
      const seeds: number[] = [];
      const specs: string[] = [];
      for (let i = 0; i < args.games.length; i++) {
        jobIds.push(randomUUID());
        gameIndexes.push(i);
        seeds.push(baseSeed + i);
        specs.push(JSON.stringify(args.games[i]!.spec ?? args.spec));
      }
      await client.query(
        `INSERT INTO sim_jobs (id, campaign_id, game_index, seed, spec)
         SELECT jobs.id, $1, jobs.game_index, jobs.seed, jobs.spec::jsonb
         FROM unnest($2::text[], $3::integer[], $4::bigint[], $5::text[])
           AS jobs(id, game_index, seed, spec)`,
        [id, jobIds, gameIndexes, seeds, specs],
      );

      await client.query('COMMIT');
      return {
        id, name: args.name, description: args.description ?? null,
        spec: args.spec, baseSeed, contentVersion: args.contentVersion ?? null,
        totalGames: args.games.length, completedGames: 0, failedGames: 0,
        status: 'active', createdAt: new Date().toISOString(), createdBy: args.createdBy,
        cancelledAt: null, completedAt: null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listCampaigns(): Promise<SimCampaign[]> {
    const result = await this.pool.query<{
      id: string; name: string; description: string | null; spec: unknown;
      base_seed: string; content_version: string | null;
      total_games: number; completed_games: number; failed_games: number;
      status: string; created_at: Date; created_by: string;
      cancelled_at: Date | null; completed_at: Date | null;
    }>(
      `SELECT * FROM sim_campaigns ORDER BY created_at DESC`,
    );
    return result.rows.map(r => ({
      id: r.id, name: r.name, description: r.description, spec: r.spec,
      baseSeed: Number(r.base_seed), contentVersion: r.content_version,
      totalGames: r.total_games, completedGames: r.completed_games, failedGames: r.failed_games,
      status: r.status, createdAt: r.created_at.toISOString(), createdBy: r.created_by,
      cancelledAt: r.cancelled_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
    }));
  }

  async getCampaign(id: string): Promise<(SimCampaign & { jobs: SimJob[]; remainingJobs: number }) | null> {
    const result = await this.pool.query<{
      id: string; name: string; description: string | null; spec: unknown;
      base_seed: string; content_version: string | null;
      total_games: number; completed_games: number; failed_games: number;
      status: string; created_at: Date; created_by: string;
      cancelled_at: Date | null; completed_at: Date | null;
    }>(
      `SELECT * FROM sim_campaigns WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;

    const jobsResult = await this.pool.query<{
      id: string; campaign_id: string; game_index: number; seed: string;
      spec: unknown; status: string; lease_token: string | null;
      leased_by: string | null; leased_at: Date | null; lease_expires_at: Date | null;
      attempts: number; max_attempts: number; last_error: string | null;
    }>(
      `SELECT * FROM sim_jobs WHERE campaign_id = $1 ORDER BY game_index LIMIT 500`,
      [id],
    );
    const remainingResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sim_jobs WHERE campaign_id = $1`,
      [id],
    );

    return {
      id: row.id, name: row.name, description: row.description, spec: row.spec,
      baseSeed: Number(row.base_seed), contentVersion: row.content_version,
      totalGames: row.total_games, completedGames: row.completed_games, failedGames: row.failed_games,
      status: row.status, createdAt: row.created_at.toISOString(), createdBy: row.created_by,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      remainingJobs: Number(remainingResult.rows[0]?.count ?? 0),
      jobs: jobsResult.rows.map(j => ({
        id: j.id, campaignId: j.campaign_id, gameIndex: j.game_index,
        seed: Number(j.seed), spec: j.spec, status: j.status,
        leaseToken: j.lease_token, leasedBy: j.leased_by,
        leasedAt: j.leased_at?.toISOString() ?? null,
        leaseExpiresAt: j.lease_expires_at?.toISOString() ?? null,
        attempts: j.attempts, maxAttempts: j.max_attempts, lastError: j.last_error,
      })),
    };
  }

  async cancelCampaign(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE sim_campaigns SET status = 'cancelled', cancelled_at = now()
         WHERE id = $1 AND status IN ('active', 'paused')`,
        [id],
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      // Remove pending/leased jobs
      await client.query(
        `DELETE FROM sim_jobs WHERE campaign_id = $1 AND status IN ('pending', 'leased')`,
        [id],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ---------- Simulation jobs (runner) ----------

  /**
   * Claim a batch of pending jobs. Reaps expired leases first, then
   * selects pending rows with FOR UPDATE SKIP LOCKED.
   */
  async claimJobs(
    campaignId: string | null,
    count: number,
    leasedBy: string,
    leaseDurationMs: number = 5 * 60 * 1000,
  ): Promise<SimJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Reap terminal expired leases and account for them exactly once.
      await client.query(
        `WITH expired AS (
           UPDATE sim_jobs
           SET status = 'failed', lease_token = NULL, leased_by = NULL,
               leased_at = NULL, lease_expires_at = NULL,
               last_error = COALESCE(last_error, 'lease expired after maximum attempts')
           WHERE status = 'leased' AND lease_expires_at < now() AND attempts >= max_attempts
           RETURNING campaign_id
         ), counts AS (
           SELECT campaign_id, COUNT(*)::int AS failed_count
           FROM expired
           GROUP BY campaign_id
         )
         UPDATE sim_campaigns sc
         SET failed_games = sc.failed_games + counts.failed_count
         FROM counts
         WHERE sc.id = counts.campaign_id`,
      );
      await client.query(
        `UPDATE sim_jobs
         SET status = 'pending', lease_token = NULL, leased_by = NULL,
             leased_at = NULL, lease_expires_at = NULL,
             last_error = COALESCE(last_error, 'lease expired')
         WHERE status = 'leased' AND lease_expires_at < now() AND attempts < max_attempts`,
      );
      await client.query(
        `UPDATE sim_campaigns
         SET status = 'completed', completed_at = now()
         WHERE status = 'active' AND completed_games + failed_games >= total_games`,
      );

      const params: (string | number)[] = [count];
      let campaignFilter = '';
      if (campaignId) {
        params.push(campaignId);
        campaignFilter = `AND sj.campaign_id = $${params.length}`;
      }

      // Also ensure campaign is active
      const jobRows = await client.query<{
        id: string; campaign_id: string; game_index: number; seed: string;
        spec: unknown; attempts: number; max_attempts: number;
      }>(
        `SELECT sj.id, sj.campaign_id, sj.game_index, sj.seed, sj.spec, sj.attempts, sj.max_attempts
         FROM sim_jobs sj
         JOIN sim_campaigns sc ON sc.id = sj.campaign_id AND sc.status = 'active'
         WHERE sj.status = 'pending' ${campaignFilter}
         ORDER BY sj.campaign_id, sj.game_index
         FOR UPDATE OF sj SKIP LOCKED
         LIMIT $1`,
        params,
      );

      if (jobRows.rows.length === 0) {
        await client.query('COMMIT');
        return [];
      }

      const leaseToken = randomBytes(16).toString('hex');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + leaseDurationMs);
      const ids = jobRows.rows.map(j => j.id);

      await client.query(
        `UPDATE sim_jobs
         SET status = 'leased', lease_token = $1, leased_by = $2, leased_at = $3, lease_expires_at = $4,
             attempts = attempts + 1
         WHERE id = ANY($5)`,
        [leaseToken, leasedBy, now, expiresAt, ids],
      );

      await client.query('COMMIT');

      return jobRows.rows.map(j => ({
        id: j.id,
        campaignId: j.campaign_id,
        gameIndex: j.game_index,
        seed: Number(j.seed),
        spec: j.spec,
        status: 'leased',
        leaseToken,
        leasedBy,
        leasedAt: now.toISOString(),
        leaseExpiresAt: expiresAt.toISOString(),
        attempts: j.attempts + 1,
        maxAttempts: j.max_attempts,
        lastError: null,
      }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease(
    jobId: string,
    leaseToken: string,
    leasedBy: string,
    leaseDurationMs: number,
  ): Promise<Date | null> {
    const expiresAt = new Date(Date.now() + leaseDurationMs);
    const result = await this.pool.query<{ lease_expires_at: Date }>(
      `UPDATE sim_jobs
       SET lease_expires_at = $4
       WHERE id = $1
         AND status = 'leased'
         AND lease_token = $2
         AND leased_by = $3
         AND lease_expires_at > now()
       RETURNING lease_expires_at`,
      [jobId, leaseToken, leasedBy, expiresAt],
    );
    return result.rows[0]?.lease_expires_at ?? null;
  }

  /**
   * Complete a job: validate lease token, atomically delete the job,
   * increment campaign completed counter, and return the campaign_id
   * + game_index for provenance on the ingested game.
   */
  async completeJob(
    jobId: string,
    leaseToken: string,
  ): Promise<{ campaignId: string; gameIndex: number; seed: number } | null> {
    const completed = await this.completeJobWith(jobId, leaseToken, async () => undefined);
    return completed?.provenance ?? null;
  }

  /**
   * Complete a job and run the supplied operation in the same transaction.
   * This is used to make telemetry ingest, queue deletion, and campaign counters atomic.
   */
  async completeJobWith<T>(
    jobId: string,
    leaseToken: string,
    operation: (
      client: PoolClient,
      provenance: { campaignId: string; gameIndex: number; seed: number },
    ) => Promise<T>,
    leasedBy?: string,
  ): Promise<{ provenance: { campaignId: string; gameIndex: number; seed: number }; result: T } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jobResult = await client.query<{
        id: string; campaign_id: string; game_index: number; seed: string;
        lease_token: string | null; leased_by: string | null; status: string;
      }>(
        `SELECT id, campaign_id, game_index, seed, lease_token, leased_by, status
         FROM sim_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      const job = jobResult.rows[0];
      if (!job || job.status !== 'leased' || job.lease_token !== leaseToken || (leasedBy && job.leased_by !== leasedBy)) {
        await client.query('ROLLBACK');
        return null;
      }

      const provenance = {
        campaignId: job.campaign_id,
        gameIndex: job.game_index,
        seed: Number(job.seed),
      };
      const result = await operation(client, provenance);

      await client.query('DELETE FROM sim_jobs WHERE id = $1', [jobId]);
      await client.query(
        `UPDATE sim_campaigns SET completed_games = completed_games + 1 WHERE id = $1`,
        [job.campaign_id],
      );
      await client.query(
        `UPDATE sim_campaigns SET status = 'completed', completed_at = now()
         WHERE id = $1 AND completed_games + failed_games >= total_games AND status = 'active'`,
        [job.campaign_id],
      );

      await client.query('COMMIT');
      return { provenance, result };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Fail a job: requeue if attempts < max, otherwise mark terminal failed.
   */
  async failJob(jobId: string, leaseToken: string, errorMessage: string, leasedBy?: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const jobResult = await client.query<{
        id: string; campaign_id: string; lease_token: string | null; leased_by: string | null; status: string;
        attempts: number; max_attempts: number;
      }>(
        `SELECT id, campaign_id, lease_token, leased_by, status, attempts, max_attempts
         FROM sim_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      const job = jobResult.rows[0];
      if (!job || job.status !== 'leased' || job.lease_token !== leaseToken || (leasedBy && job.leased_by !== leasedBy)) {
        await client.query('ROLLBACK');
        return false;
      }

      if (job.attempts >= job.max_attempts) {
        // Terminal failure
        await client.query(
          `UPDATE sim_jobs SET status = 'failed', lease_token = NULL, leased_by = NULL,
                  leased_at = NULL, lease_expires_at = NULL, last_error = $2
           WHERE id = $1`,
          [jobId, errorMessage],
        );
        // Increment failed counter exactly once
        await client.query(
          `UPDATE sim_campaigns SET failed_games = failed_games + 1 WHERE id = $1`,
          [job.campaign_id],
        );
        // Check if campaign is now done
        await client.query(
          `UPDATE sim_campaigns SET status = 'completed', completed_at = now()
           WHERE id = $1 AND completed_games + failed_games >= total_games AND status = 'active'`,
          [job.campaign_id],
        );
      } else {
        // Requeue
        await client.query(
          `UPDATE sim_jobs SET status = 'pending', lease_token = NULL, leased_by = NULL,
                  leased_at = NULL, lease_expires_at = NULL, last_error = $2
           WHERE id = $1`,
          [jobId, errorMessage],
        );
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
