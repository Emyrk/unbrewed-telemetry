/**
 * The database half of the campaign bootstrap — separated from the CLI
 * (seed-sim-campaign.mts) so the IDEMPOTENCY contract can be tested against a
 * real Postgres instead of asserted by reading the SQL.
 *
 * The contract, in one line: seeding twice must insert nothing the second time
 * and must never resurrect finished work.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { JobRow, PlanStep } from './sim-campaign-plan.mjs';

export interface SeedResult {
  name: string;
  id: string;
  /** False when the campaign already existed (so it was NOT re-tiered). */
  created: boolean;
  /** The tier actually stored — for an existing campaign, whatever it already had. */
  tier: number;
  plannedTier: number;
  plannedJobs: number;
  inserted: number;
  specUpdated: number;
  failedReset: number;
}

/**
 * Create the campaign if absent. Returns its id plus the priority tier actually
 * stored, which is NOT necessarily the one we asked for: an existing campaign is
 * never re-tiered here (a live arm's scheduling position belongs to the operator,
 * and re-running the seed must not reshuffle the fleet's queue).
 *
 * `priority_tier` IS written on insert — before #39 it was omitted entirely and
 * every seeded campaign silently landed on the column DEFAULT of 0, which is why
 * the original arms had their tiers set out-of-band. Lower tiers claim first
 * (migration 008; claimJobs serves MIN(priority_tier) among ACTIVE campaigns).
 */
async function upsertCampaign(
  pool: Pool, name: string, spec: unknown, baseSeed: bigint, totalGames: number, priorityTier: number,
): Promise<{ id: string; created: boolean; tier: number }> {
  const existing = await pool.query<{ id: string; priority_tier: number }>(
    'SELECT id, priority_tier FROM sim_campaigns WHERE name = $1 ORDER BY created_at DESC LIMIT 1', [name],
  );
  const row = existing.rows[0];
  if (existing.rowCount && row) return { id: row.id, created: false, tier: row.priority_tier };
  const id = randomUUID();
  await pool.query(
    `INSERT INTO sim_campaigns (id, name, description, spec, base_seed, total_games, created_by, priority_tier, priority_position)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'seed-sim-campaign', $7, 0)`,
    [id, name, `ISMCTS mission — ${name} (#248)`, JSON.stringify(spec), baseSeed.toString(), totalGames, priorityTier],
  );
  return { id, created: true, tier: priorityTier };
}

/**
 * Reset terminally-FAILED jobs back to pending (idempotent recovery). A foreign
 * fleet that mis-claimed our jobs and failed them (e.g. Emyrk's #250 worker
 * failing our grid jobs on the format/pilot dialect) leaves `status='failed'`
 * rows that a plain insert (ON CONFLICT DO NOTHING) will NOT resurrect — so we
 * explicitly requeue them and un-count them from the campaign's failed tally.
 */
async function resetFailedJobs(pool: Pool, campaignId: string): Promise<number> {
  const res = await pool.query(
    `UPDATE sim_jobs
     SET status = 'pending', lease_token = NULL, leased_by = NULL, leased_at = NULL,
         lease_expires_at = NULL, attempts = 0, last_error = NULL
     WHERE campaign_id = $1 AND status = 'failed'`,
    [campaignId],
  );
  const n = res.rowCount ?? 0;
  if (n > 0) {
    await pool.query('UPDATE sim_campaigns SET failed_games = GREATEST(0, failed_games - $2), status = $3, completed_at = NULL WHERE id = $1', [campaignId, n, 'active']);
  }
  return n;
}

/**
 * Insert the planned jobs, skipping any (campaign, game_index) that already has a
 * job OR an already-COMPLETED game. The `NOT EXISTS` guard is the half that stops
 * a re-run from resurrecting finished work: a completed game whose job row was
 * pruned must not come back as pending.
 */
async function insertJobs(pool: Pool, campaignId: string, jobs: JobRow[]): Promise<number> {
  if (jobs.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < jobs.length; i += 1000) {
    const batch = jobs.slice(i, i + 1000);
    const ids = batch.map(() => randomUUID());
    const res = await pool.query(
      `INSERT INTO sim_jobs (id, campaign_id, game_index, seed, spec)
       SELECT j.id, $1, j.game_index, j.seed, j.spec::jsonb
       FROM unnest($2::text[], $3::integer[], $4::bigint[], $5::text[])
         AS j(id, game_index, seed, spec)
       WHERE NOT EXISTS (
         SELECT 1 FROM games g WHERE g.campaign_id = $1 AND g.campaign_game_index = j.game_index
       )
       ON CONFLICT (campaign_id, game_index) DO NOTHING`,
      [campaignId, ids, batch.map((b) => b.gameIndex), batch.map((b) => b.seed.toString()), batch.map((b) => JSON.stringify(b.spec))],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Seed every planned step. Safe to run repeatedly: the ONLY thing a re-run
 * mutates on an existing campaign is `sim_campaigns.spec` (the admin-UI pool
 * description). It deliberately does NOT touch `sim_jobs`, because a live arm is
 * claiming/running them and the per-job override specs are already correct.
 */
export async function seedCampaigns(pool: Pool, steps: PlanStep[]): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const s of steps) {
    const { id, created, tier } = await upsertCampaign(pool, s.name, s.spec, s.baseSeed, s.jobs.length, s.priorityTier);
    const spec = await pool.query(
      'UPDATE sim_campaigns SET spec = $2::jsonb WHERE id = $1 AND spec IS DISTINCT FROM $2::jsonb',
      [id, JSON.stringify(s.spec)],
    );
    const failedReset = await resetFailedJobs(pool, id);
    const inserted = await insertJobs(pool, id, s.jobs);
    results.push({
      name: s.name, id, created, tier, plannedTier: s.priorityTier,
      plannedJobs: s.jobs.length, inserted, specUpdated: spec.rowCount ?? 0, failedReset,
    });
  }
  return results;
}

/** Campaigns whose STORED tier disagrees with the plan (never auto-corrected). */
export function tierDrift(results: SeedResult[]): Array<{ name: string; want: number; have: number }> {
  return results
    .filter((r) => !r.created && r.tier !== r.plannedTier)
    .map((r) => ({ name: r.name, want: r.plannedTier, have: r.tier }));
}
