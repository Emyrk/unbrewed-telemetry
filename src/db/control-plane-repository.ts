/**
 * Control-plane database operations: admin sessions, telemetry sources,
 * source credentials, simulation campaigns, and simulation jobs.
 */
import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashSecret, verifySecret, generateCredential, type Scope } from '../http/bearer-auth.js';
import { wilson } from '../stats/wilson.js';
import { simJourney, type Journey } from './sim-journey.js';

export interface CampaignPilotStat {
  pilot: string;
  games: number;
  wins: number;
  rate: number;
  wilson95: [number, number];
}

export interface CampaignThroughput {
  /** Number of games completed in the trailing window. */
  recentCompletions: number;
  /** Window size in hours used for the rate calculation. */
  windowHours: number;
  /** Completions per hour over the window (0 when none). */
  gamesPerHour: number;
  /** Estimated seconds until all remaining games complete at the current rate, or null when rate is 0 or campaign is already done. */
  etaSeconds: number | null;
}

export interface CampaignProgress {
  campaignId: string;
  name: string;
  status: string;
  totalGames: number;
  completedGames: number;
  failedGames: number;
  /** True when the campaign's games span more than one engine content_version. */
  mixedContentVersion: boolean;
  contentVersions: string[];
  /** Per-pilot win rate with a Wilson 95% CI — the road-to-expert view. */
  pilots: CampaignPilotStat[];
  /** Throughput and ETA based on recent completion rate. */
  throughput: CampaignThroughput;
}

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
  baseSeed: string;
  contentVersion: string | null;
  totalGames: number;
  completedGames: number;
  failedGames: number;
  status: string;
  createdAt: string;
  createdBy: string;
  priorityTier: number;
  priorityPosition: number;
  cancelledAt: string | null;
  completedAt: string | null;
}

export interface CampaignScheduleResult {
  campaigns: SimCampaign[];
}

export interface CreateCampaignArgs {
  name: string;
  description?: string | undefined;
  spec: unknown;
  baseSeed?: string | number | undefined;
  contentVersion?: string | undefined;
  games: CampaignGameSpec[];
  createdBy: string;
}

export interface UpdateCampaignArgs {
  name: string;
  description?: string | null | undefined;
  spec: unknown;
  contentVersion?: string | null | undefined;
}

export type UpdateCampaignResult =
  | { kind: 'updated'; campaign: SimCampaign; regeneratedJobs: number; requeuedFailedJobs: number }
  | { kind: 'not_found' }
  | { kind: 'leased_jobs'; leasedJobs: number };

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
  seed: string;
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

export type CampaignItemBucket = 'succeeded' | 'failed' | 'leased' | 'idle';

export interface CampaignJobCounts {
  succeeded: number;
  failed: number;
  leased: number;
  idle: number;
}

export interface CampaignListItem {
  gameIndex: number;
  status: CampaignItemBucket;
  gameId: string | null;
  seed: string | null;
  attempts: number | null;
  maxAttempts: number | null;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  completedAt: string | null;
}

export interface CampaignItemsPage {
  bucket: CampaignItemBucket;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: CampaignListItem[];
}

export interface ClaimResult {
  jobs: SimJob[];
}

const PG_BIGINT_MIN = -(1n << 63n);
const PG_BIGINT_MAX = (1n << 63n) - 1n;

/** Current Unix time in nanoseconds with a randomized sub-millisecond component. */
export function unixNanoSeed(nowMs = Date.now(), subMillisecondNanos = randomInt(0, 1_000_000)): string {
  return (BigInt(nowMs) * 1_000_000n + BigInt(subMillisecondNanos)).toString();
}

function campaignBaseSeed(value: string | number | undefined, gameCount: number): string {
  const raw = value ?? unixNanoSeed();
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
    throw new Error('baseSeed numbers must be safe integers; send large seeds as decimal strings');
  }
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) throw new Error('baseSeed must be an integer or decimal integer string');
  const seed = BigInt(text);
  const finalSeed = seed + BigInt(Math.max(0, gameCount - 1));
  if (seed < PG_BIGINT_MIN || finalSeed > PG_BIGINT_MAX) {
    throw new Error('baseSeed and generated job seeds must fit in a signed 64-bit integer');
  }
  return seed.toString();
}

function campaignSpecError(message: string): Error {
  return new Error(`campaign spec: ${message}`);
}

function stringPool(value: unknown, path: string): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw campaignSpecError(`${path} must be a non-empty string array`);
  const values = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  if (values.length !== value.length) throw campaignSpecError(`${path} must contain only non-empty strings`);
  return [...new Set(values)];
}

function splitMix64(seed: bigint): () => bigint {
  let state = BigInt.asUintN(64, seed);
  return () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let value = state;
    value = BigInt.asUintN(64, (value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n);
    value = BigInt.asUintN(64, (value ^ (value >> 27n)) * 0x94d049bb133111ebn);
    return BigInt.asUintN(64, value ^ (value >> 31n));
  };
}

function pickFromPool(values: string[], random: () => bigint): string {
  return values[Number(random() % BigInt(values.length))]!;
}

/** Resolve campaign pools into the exact map, hero deck, and pilot a runner executes. */
export function resolveCampaignJobSpec(spec: unknown, seed: string | number | bigint): unknown {
  if (!spec || Array.isArray(spec) || typeof spec !== 'object') return spec;
  const resolved = structuredClone(spec) as Record<string, unknown>;
  const random = splitMix64(BigInt(seed));

  const maps = stringPool(resolved.maps, 'maps');
  if (maps) {
    resolved.map = pickFromPool(maps, random);
    delete resolved.maps;
  }

  if (resolved.teams !== undefined) {
    if (!Array.isArray(resolved.teams) || resolved.teams.length === 0) {
      throw campaignSpecError('teams must be a non-empty array');
    }
    resolved.teams = resolved.teams.map((team, teamIndex) => {
      if (!team || Array.isArray(team) || typeof team !== 'object') {
        throw campaignSpecError(`teams[${teamIndex}] must be an object`);
      }
      const resolvedTeam = structuredClone(team) as Record<string, unknown>;
      if (!Array.isArray(resolvedTeam.seats) || resolvedTeam.seats.length === 0) {
        throw campaignSpecError(`teams[${teamIndex}].seats must be a non-empty array`);
      }
      resolvedTeam.seats = resolvedTeam.seats.map((seat, seatIndex) => {
        if (!seat || Array.isArray(seat) || typeof seat !== 'object') {
          throw campaignSpecError(`teams[${teamIndex}].seats[${seatIndex}] must be an object`);
        }
        const resolvedSeat = structuredClone(seat) as Record<string, unknown>;
        const decks = stringPool(resolvedSeat.decks, `teams[${teamIndex}].seats[${seatIndex}].decks`);
        const pilots = stringPool(resolvedSeat.pilots, `teams[${teamIndex}].seats[${seatIndex}].pilots`);
        if (decks) {
          resolvedSeat.deck = pickFromPool(decks, random);
          delete resolvedSeat.decks;
        }
        if (pilots) {
          resolvedSeat.pilot = pickFromPool(pilots, random);
          delete resolvedSeat.pilots;
        }
        if (typeof resolvedSeat.deck !== 'string' || !resolvedSeat.deck.trim()) {
          throw campaignSpecError(`teams[${teamIndex}].seats[${seatIndex}] needs deck or decks`);
        }
        if (typeof resolvedSeat.pilot !== 'string' || !resolvedSeat.pilot.trim()) {
          throw campaignSpecError(`teams[${teamIndex}].seats[${seatIndex}] needs pilot or pilots`);
        }
        return resolvedSeat;
      });
      return resolvedTeam;
    });
  }

  return resolved;
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
    const baseSeed = campaignBaseSeed(args.baseSeed, args.games.length);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE sim_campaigns IN SHARE ROW EXCLUSIVE MODE');
      const priorityResult = await client.query<{ next_tier: number }>(
        `SELECT COALESCE(MAX(priority_tier), -1)::integer + 1 AS next_tier
         FROM sim_campaigns WHERE status IN ('active', 'paused')`,
      );
      const priorityTier = priorityResult.rows[0]?.next_tier ?? 0;
      await client.query(
        `INSERT INTO sim_campaigns (
           id, name, description, spec, base_seed, content_version, total_games, created_by,
           priority_tier, priority_position
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 0)`,
        [id, args.name, args.description ?? null, JSON.stringify(args.spec), baseSeed,
         args.contentVersion ?? null, args.games.length, args.createdBy, priorityTier],
      );

      const jobIds: string[] = [];
      const gameIndexes: number[] = [];
      const seeds: string[] = [];
      const specs: string[] = [];
      for (let i = 0; i < args.games.length; i++) {
        jobIds.push(randomUUID());
        gameIndexes.push(i);
        const seed = (BigInt(baseSeed) + BigInt(i)).toString();
        seeds.push(seed);
        specs.push(JSON.stringify(resolveCampaignJobSpec(args.games[i]!.spec ?? args.spec, seed)));
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
        priorityTier, priorityPosition: 0,
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
      priority_tier: number; priority_position: number;
      cancelled_at: Date | null; completed_at: Date | null;
    }>(
      `SELECT * FROM sim_campaigns
       ORDER BY CASE WHEN status IN ('active', 'paused') THEN 0 ELSE 1 END,
                CASE WHEN status IN ('active', 'paused') THEN priority_tier END,
                CASE WHEN status IN ('active', 'paused') THEN priority_position END,
                COALESCE(completed_at, cancelled_at, created_at) DESC`,
    );
    return result.rows.map(r => ({
      id: r.id, name: r.name, description: r.description, spec: r.spec,
      baseSeed: r.base_seed, contentVersion: r.content_version,
      totalGames: r.total_games, completedGames: r.completed_games, failedGames: r.failed_games,
      status: r.status, createdAt: r.created_at.toISOString(), createdBy: r.created_by,
      priorityTier: r.priority_tier, priorityPosition: r.priority_position,
      cancelledAt: r.cancelled_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
    }));
  }

  async getCampaign(id: string, includeJobs: boolean = true): Promise<(SimCampaign & {
    jobs: SimJob[];
    remainingJobs: number;
    jobCounts: CampaignJobCounts;
  }) | null> {
    const result = await this.pool.query<{
      id: string; name: string; description: string | null; spec: unknown;
      base_seed: string; content_version: string | null;
      total_games: number; completed_games: number; failed_games: number;
      status: string; created_at: Date; created_by: string;
      priority_tier: number; priority_position: number;
      cancelled_at: Date | null; completed_at: Date | null;
    }>(
      `SELECT * FROM sim_campaigns WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;

    const jobsResult = includeJobs
      ? await this.pool.query<{
          id: string; campaign_id: string; game_index: number; seed: string;
          spec: unknown; status: string; lease_token: string | null;
          leased_by: string | null; leased_at: Date | null; lease_expires_at: Date | null;
          attempts: number; max_attempts: number; last_error: string | null;
        }>(
          `SELECT * FROM sim_jobs WHERE campaign_id = $1 ORDER BY game_index LIMIT 500`,
          [id],
        )
      : { rows: [] };
    const countsResult = await this.pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::bigint AS count
       FROM sim_jobs WHERE campaign_id = $1 GROUP BY status`,
      [id],
    );
    const statusCounts = new Map(countsResult.rows.map(count => [count.status, Number(count.count)]));
    const jobCounts: CampaignJobCounts = {
      succeeded: row.completed_games,
      failed: statusCounts.get('failed') ?? 0,
      leased: statusCounts.get('leased') ?? 0,
      idle: statusCounts.get('pending') ?? 0,
    };

    return {
      id: row.id, name: row.name, description: row.description, spec: row.spec,
      baseSeed: row.base_seed, contentVersion: row.content_version,
      totalGames: row.total_games, completedGames: row.completed_games, failedGames: row.failed_games,
      status: row.status, createdAt: row.created_at.toISOString(), createdBy: row.created_by,
      priorityTier: row.priority_tier, priorityPosition: row.priority_position,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      remainingJobs: jobCounts.failed + jobCounts.leased + jobCounts.idle,
      jobCounts,
      jobs: jobsResult.rows.map(j => ({
        id: j.id, campaignId: j.campaign_id, gameIndex: j.game_index,
        seed: j.seed, spec: j.spec, status: j.status,
        leaseToken: j.lease_token, leasedBy: j.leased_by,
        leasedAt: j.leased_at?.toISOString() ?? null,
        leaseExpiresAt: j.lease_expires_at?.toISOString() ?? null,
        attempts: j.attempts, maxAttempts: j.max_attempts, lastError: j.last_error,
      })),
    };
  }

  async listCampaignItems(
    campaignId: string,
    bucket: CampaignItemBucket,
    page: number,
    pageSize: number,
  ): Promise<CampaignItemsPage | null> {
    const exists = await this.pool.query('SELECT 1 FROM sim_campaigns WHERE id = $1', [campaignId]);
    if ((exists.rowCount ?? 0) === 0) return null;

    const offset = (page - 1) * pageSize;
    if (bucket === 'succeeded') {
      const countResult = await this.pool.query<{ count: string }>(
        'SELECT COUNT(*)::bigint AS count FROM games WHERE campaign_id = $1',
        [campaignId],
      );
      const result = await this.pool.query<{
        id: string; campaign_game_index: number; ended_at: Date | null; received_at: Date;
      }>(
        `SELECT id, campaign_game_index, ended_at, received_at
         FROM games
         WHERE campaign_id = $1
         ORDER BY campaign_game_index
         LIMIT $2 OFFSET $3`,
        [campaignId, pageSize, offset],
      );
      const total = Number(countResult.rows[0]?.count ?? 0);
      return {
        bucket, page, pageSize, total, totalPages: Math.ceil(total / pageSize),
        items: result.rows.map(row => ({
          gameIndex: row.campaign_game_index,
          status: 'succeeded',
          gameId: row.id,
          seed: null,
          attempts: null,
          maxAttempts: null,
          leasedBy: null,
          leaseExpiresAt: null,
          lastError: null,
          completedAt: (row.ended_at ?? row.received_at).toISOString(),
        })),
      };
    }

    const jobStatus = bucket === 'idle' ? 'pending' : bucket;
    const countResult = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::bigint AS count FROM sim_jobs WHERE campaign_id = $1 AND status = $2',
      [campaignId, jobStatus],
    );
    const result = await this.pool.query<{
      game_index: number; seed: string; attempts: number; max_attempts: number;
      leased_by: string | null; lease_expires_at: Date | null; last_error: string | null;
    }>(
      `SELECT game_index, seed, attempts, max_attempts, leased_by, lease_expires_at, last_error
       FROM sim_jobs
       WHERE campaign_id = $1 AND status = $2
       ORDER BY game_index
       LIMIT $3 OFFSET $4`,
      [campaignId, jobStatus, pageSize, offset],
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    return {
      bucket, page, pageSize, total, totalPages: Math.ceil(total / pageSize),
      items: result.rows.map(row => ({
        gameIndex: row.game_index,
        status: bucket,
        gameId: null,
        seed: row.seed,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        leasedBy: row.leased_by,
        leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
        lastError: row.last_error,
        completedAt: null,
      })),
    };
  }

  /**
   * Update the editable campaign definition and regenerate every unfinished job.
   * Completed games are immutable (their job rows are already deleted). Failed
   * jobs are reset to pending so an admin can repair a malformed campaign.
   */
  async updateCampaign(id: string, args: UpdateCampaignArgs): Promise<UpdateCampaignResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const campaignResult = await client.query<{
        id: string; base_seed: string; total_games: number; completed_games: number;
        failed_games: number; status: string; created_at: Date; created_by: string;
        cancelled_at: Date | null; completed_at: Date | null;
      }>(
        `SELECT id, base_seed, total_games, completed_games, failed_games, status,
                created_at, created_by, cancelled_at, completed_at
         FROM sim_campaigns WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const campaign = campaignResult.rows[0];
      if (!campaign) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      await client.query(
        `UPDATE sim_jobs
         SET status = 'pending', lease_token = NULL, leased_by = NULL,
             leased_at = NULL, lease_expires_at = NULL,
             last_error = COALESCE(last_error, 'lease expired before campaign edit')
         WHERE campaign_id = $1 AND status = 'leased' AND lease_expires_at < now()`,
        [id],
      );

      const jobsResult = await client.query<{
        id: string; game_index: number; seed: string; status: string;
      }>(
        `SELECT id, game_index, seed, status
         FROM sim_jobs WHERE campaign_id = $1 ORDER BY game_index FOR UPDATE`,
        [id],
      );
      const leasedJobs = jobsResult.rows.filter(job => job.status === 'leased').length;
      if (leasedJobs > 0) {
        await client.query('ROLLBACK');
        return { kind: 'leased_jobs', leasedJobs };
      }

      const jobIds = jobsResult.rows.map(job => job.id);
      const resolvedSpecs = jobsResult.rows.map(job => JSON.stringify(resolveCampaignJobSpec(args.spec, job.seed)));
      const requeuedFailedJobs = jobsResult.rows.filter(job => job.status === 'failed').length;

      if (jobIds.length > 0) {
        await client.query(
          `UPDATE sim_jobs AS job
           SET spec = updates.spec::jsonb, status = 'pending', attempts = 0,
               lease_token = NULL, leased_by = NULL, leased_at = NULL,
               lease_expires_at = NULL, last_error = NULL
           FROM unnest($2::text[], $3::text[]) AS updates(id, spec)
           WHERE job.campaign_id = $1 AND job.id = updates.id`,
          [id, jobIds, resolvedSpecs],
        );
      }

      const failedGames = Math.max(0, campaign.failed_games - requeuedFailedJobs);
      const status = jobIds.length > 0 ? 'active' : campaign.status;
      const completedAt = jobIds.length > 0 ? null : campaign.completed_at;
      const updated = await client.query<{
        id: string; name: string; description: string | null; spec: unknown;
        base_seed: string; content_version: string | null;
        total_games: number; completed_games: number; failed_games: number;
        status: string; created_at: Date; created_by: string;
        priority_tier: number; priority_position: number;
        cancelled_at: Date | null; completed_at: Date | null;
      }>(
        `UPDATE sim_campaigns
         SET name = $2, description = $3, spec = $4::jsonb, content_version = $5,
             failed_games = $6, status = $7, completed_at = $8,
             cancelled_at = CASE WHEN $7 = 'active' THEN NULL ELSE cancelled_at END
         WHERE id = $1
         RETURNING *`,
        [id, args.name, args.description ?? null, JSON.stringify(args.spec),
         args.contentVersion ?? null, failedGames, status, completedAt],
      );
      await client.query('COMMIT');
      const row = updated.rows[0]!;
      return {
        kind: 'updated',
        regeneratedJobs: jobIds.length,
        requeuedFailedJobs,
        campaign: {
          id: row.id, name: row.name, description: row.description, spec: row.spec,
          baseSeed: row.base_seed, contentVersion: row.content_version,
          totalGames: row.total_games, completedGames: row.completed_games, failedGames: row.failed_games,
          status: row.status, createdAt: row.created_at.toISOString(), createdBy: row.created_by,
          priorityTier: row.priority_tier, priorityPosition: row.priority_position,
          cancelledAt: row.cancelled_at?.toISOString() ?? null,
          completedAt: row.completed_at?.toISOString() ?? null,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Replace the active/paused scheduling board. Tiers run top-to-bottom; peers round-robin. */
  async updateCampaignSchedule(tiers: string[][]): Promise<SimCampaign[]> {
    const flattened = tiers.flat();
    if (new Set(flattened).size !== flattened.length) {
      throw new Error('campaign schedule contains duplicate campaign ids');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE sim_campaigns IN SHARE ROW EXCLUSIVE MODE');
      const current = await client.query<{ id: string }>(
        `SELECT id FROM sim_campaigns
         WHERE status IN ('active', 'paused')
         ORDER BY priority_tier, priority_position, created_at
         FOR UPDATE`,
      );
      const currentIds = current.rows.map(row => row.id).sort();
      const requestedIds = [...flattened].sort();
      if (currentIds.length !== requestedIds.length || currentIds.some((id, index) => id !== requestedIds[index])) {
        throw new Error('campaign schedule must include every active or paused campaign exactly once');
      }

      if (flattened.length > 0) {
        const tierValues: number[] = [];
        const positionValues: number[] = [];
        for (const [tier, ids] of tiers.entries()) {
          for (const [position] of ids.entries()) {
            tierValues.push(tier);
            positionValues.push(position);
          }
        }
        await client.query(
          `UPDATE sim_campaigns AS campaign
           SET priority_tier = schedule.tier,
               priority_position = schedule.position
           FROM unnest($1::text[], $2::integer[], $3::integer[])
             AS schedule(id, tier, position)
           WHERE campaign.id = schedule.id`,
          [flattened, tierValues, positionValues],
        );
      }
      await client.query('COMMIT');
      return this.listCampaigns();
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Pause or resume a campaign without deleting or resetting any jobs. */
  async setCampaignActive(id: string, active: boolean): Promise<string | null> {
    const result = await this.pool.query<{ status: string }>(
      `UPDATE sim_campaigns
       SET status = CASE
             WHEN $2 AND completed_games + failed_games >= total_games THEN 'completed'
             WHEN $2 THEN 'active'
             ELSE 'paused'
           END,
           completed_at = CASE
             WHEN $2 AND completed_games + failed_games >= total_games THEN COALESCE(completed_at, now())
             WHEN $2 THEN NULL
             ELSE completed_at
           END
       WHERE id = $1 AND status IN ('active', 'paused')
       RETURNING status`,
      [id, active],
    );
    return result.rows[0]?.status ?? null;
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

      // Lower priority tiers run first. Within a tier, rank one pending job per
      // campaign per round and rotate by the campaign's last claim timestamp.
      const jobRows = await client.query<{
        id: string; campaign_id: string; game_index: number; seed: string;
        spec: unknown; attempts: number; max_attempts: number;
      }>(
        `WITH active_tier AS (
           SELECT MIN(sc.priority_tier) AS priority_tier
           FROM sim_campaigns sc
           WHERE sc.status = 'active'
             ${campaignId ? `AND sc.id = $${params.length}` : ''}
         ), ranked AS (
           SELECT sj.id,
                  sc.priority_tier,
                  sc.priority_position,
                  sc.last_claimed_at,
                  row_number() OVER (
                    PARTITION BY sj.campaign_id
                    ORDER BY sj.game_index
                  ) AS job_round,
                  sj.game_index
           FROM sim_jobs sj
           JOIN sim_campaigns sc ON sc.id = sj.campaign_id AND sc.status = 'active'
           JOIN active_tier ON active_tier.priority_tier = sc.priority_tier
           WHERE sj.status = 'pending' ${campaignFilter}
         )
         SELECT sj.id, sj.campaign_id, sj.game_index, sj.seed, sj.spec, sj.attempts, sj.max_attempts
         FROM ranked
         JOIN sim_jobs sj ON sj.id = ranked.id
         ORDER BY ranked.priority_tier,
                  ranked.job_round,
                  ranked.last_claimed_at NULLS FIRST,
                  ranked.priority_position,
                  ranked.game_index
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

      const lastSelection = new Map<string, number>();
      jobRows.rows.forEach((job, index) => lastSelection.set(job.campaign_id, index));
      if (lastSelection.size > 0) {
        const campaignIds = [...lastSelection.keys()];
        const selectionOrder = campaignIds.map(id => lastSelection.get(id)!);
        await client.query(
          `UPDATE sim_campaigns AS campaign
           SET last_claimed_at = $1::timestamptz + schedule.selection_order * interval '1 microsecond'
           FROM unnest($2::text[], $3::integer[]) AS schedule(id, selection_order)
           WHERE campaign.id = schedule.id`,
          [now, campaignIds, selectionOrder],
        );
      }

      await client.query('COMMIT');

      return jobRows.rows.map(j => ({
        id: j.id,
        campaignId: j.campaign_id,
        gameIndex: j.game_index,
        seed: j.seed,
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

  /** Release a lease without consuming an attempt so another worker can rerun it. */
  async releaseJob(jobId: string, leaseToken: string, leasedBy?: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sim_jobs
       SET status = 'pending', lease_token = NULL, leased_by = NULL,
           leased_at = NULL, lease_expires_at = NULL,
           attempts = GREATEST(attempts - 1, 0), last_error = NULL
       WHERE id = $1
         AND status = 'leased'
         AND lease_token = $2
         AND ($3::text IS NULL OR leased_by = $3)`,
      [jobId, leaseToken, leasedBy ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Complete a job: validate lease token, atomically delete the job,
   * increment campaign completed counter, and return the campaign_id
   * + game_index for provenance on the ingested game.
   */
  async completeJob(
    jobId: string,
    leaseToken: string,
  ): Promise<{ campaignId: string; gameIndex: number; seed: string } | null> {
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
      provenance: { campaignId: string; gameIndex: number; seed: string },
    ) => Promise<T>,
    leasedBy?: string,
  ): Promise<{ provenance: { campaignId: string; gameIndex: number; seed: string }; result: T } | null> {
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
        seed: job.seed,
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

  /**
   * Campaign-scoped win-rate view (#248, the ISMCTS "road-to-expert" report). The
   * control plane already banks each completed sim game into `games` with campaign
   * provenance and dedups by `(campaign_id, campaign_game_index)`; this folds those
   * games into a per-pilot win rate with a Wilson 95% CI — the read the #239 report
   * needs, which the deck-balance stats do not answer campaign-scoped. Returns null
   * for an unknown campaign.
   */
  async campaignProgress(campaignId: string, nowMs?: number): Promise<CampaignProgress | null> {
    const campaign = await this.pool.query<{
      name: string; status: string; total_games: number; completed_games: number; failed_games: number;
    }>(
      `SELECT name, status, total_games, completed_games, failed_games FROM sim_campaigns WHERE id = $1`,
      [campaignId],
    );
    if (campaign.rowCount === 0) return null;
    const c = campaign.rows[0]!;

    const WINDOW_HOURS = 6;
    const now = nowMs != null ? new Date(nowMs) : new Date();
    const windowStart = new Date(now.getTime() - WINDOW_HOURS * 3600_000);

    const [pilotRows, versionRows, recentRows] = await Promise.all([
      this.pool.query<{ pilot: string; games: string; wins: string }>(
        `SELECT gs.pilot,
                count(*)::bigint AS games,
                count(*) FILTER (WHERE gs.won)::bigint AS wins
         FROM games g
         JOIN game_seats gs ON gs.game_id = g.id
         WHERE g.campaign_id = $1
         GROUP BY gs.pilot
         ORDER BY gs.pilot`,
        [campaignId],
      ),
      this.pool.query<{ content_version: string | null }>(
        `SELECT DISTINCT content_version FROM games WHERE campaign_id = $1`,
        [campaignId],
      ),
      this.pool.query<{ cnt: string }>(
        `SELECT count(*)::bigint AS cnt
         FROM games
         WHERE campaign_id = $1 AND received_at >= $2 AND received_at <= $3`,
        [campaignId, windowStart.toISOString(), now.toISOString()],
      ),
    ]);

    const contentVersions = versionRows.rows.map((r) => r.content_version).filter((v): v is string => v !== null);

    const pilots: CampaignPilotStat[] = pilotRows.rows.map((r) => {
      const games = Number(r.games);
      const wins = Number(r.wins);
      const w = wilson(wins, games);
      return { pilot: r.pilot, games, wins, rate: games > 0 ? wins / games : 0, wilson95: [w.lo, w.hi] };
    });

    const recentCompletions = Number(recentRows.rows[0]?.cnt ?? 0);
    const gamesPerHour = recentCompletions / WINDOW_HOURS;
    const remaining = c.total_games - c.completed_games - c.failed_games;
    const etaSeconds = gamesPerHour > 0 && remaining > 0
      ? Math.round((remaining / gamesPerHour) * 3600)
      : null;

    return {
      campaignId,
      name: c.name,
      status: c.status,
      totalGames: c.total_games,
      completedGames: c.completed_games,
      failedGames: c.failed_games,
      mixedContentVersion: contentVersions.length > 1,
      contentVersions,
      pilots,
      throughput: { recentCompletions, windowHours: WINDOW_HOURS, gamesPerHour, etaSeconds },
    };
  }
  /** Public "Road to Expert+" journey view (#248) — aggregates only, no auth. */
  async journey(names: string[], nowMs: number): Promise<Journey> {
    return simJourney(this.pool, names, nowMs);
  }

}
