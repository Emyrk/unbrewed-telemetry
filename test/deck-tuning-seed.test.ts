/**
 * The deck-tuning seeder's IDEMPOTENCY contract (#49) — DB-backed, gated on
 * TEST_DATABASE_URL like the rest of the suite.
 *
 * It shares `seedCampaigns` with the mission seeder, so the general contract is
 * already covered by sim-campaign-seed.test.ts. What is pinned HERE is what the
 * sharing changed or what only this plan exercises: a re-run against live
 * campaigns inserts nothing, a negative priority tier survives the round trip
 * (it is what keeps a dormant mission from starving this family), and the
 * campaigns land labelled as deck tuning rather than as mission arms.
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createDeckTuningPlan } from '../scripts/lib/deck-tuning-plan.mjs';
import { createPlan } from '../scripts/lib/sim-campaign-plan.mjs';
import { seedCampaigns } from '../scripts/lib/sim-campaign-seed.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

/** A small plan — same code path, 3 games per pairing instead of 40. */
const smallPlan = () => createDeckTuningPlan({ TUNE_CANDIDATES: 'cand-a,cand-b', TUNE_GAMES: '3', TUNE_CALIBRATION: '1' });

describeDb('seed-deck-tuning-campaign idempotency', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE sim_campaigns, sim_jobs, telemetry_sources, game_submissions CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates one campaign per candidate plus calibration, at the shared seed base and tier -1', async () => {
    const steps = smallPlan().steps;
    const results = await seedCampaigns(pool, steps);
    expect(results.map((r) => r.name)).toEqual(['dopp-tune-r1-cand-a', 'dopp-tune-r1-cand-b', 'dopp-tune-r1-calib']);

    for (const r of results) {
      expect(r.created).toBe(true);
      expect(r.inserted).toBe(r.plannedJobs);
      const row = await pool.query<{ priority_tier: number; total_games: number; base_seed: string; created_by: string; description: string; jobs: string }>(
        `SELECT c.priority_tier, c.total_games, c.base_seed, c.created_by, c.description,
                (SELECT count(*) FROM sim_jobs j WHERE j.campaign_id = c.id) AS jobs
         FROM sim_campaigns c WHERE c.name = $1`, [r.name],
      );
      const row0 = row.rows[0]!;
      // Negative tiers are legal (`priority_tier` is a plain integer) and are the
      // point: claimJobs serves MIN(priority_tier) among ACTIVE campaigns.
      expect(row0.priority_tier).toBe(-1);
      expect(row0.base_seed).toBe('900000');
      expect(Number(row0.jobs)).toBe(r.plannedJobs);
      expect(row0.total_games).toBe(r.plannedJobs);
      expect(row0.created_by).toBe('seed-deck-tuning-campaign');
      expect(row0.description).toMatch(/^deck tuning dopp-tune-r1 —/);
    }
  });

  it('inserts ZERO jobs on a second run against the live campaigns', async () => {
    const first = await seedCampaigns(pool, smallPlan().steps);
    const jobsAfterFirst = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sim_jobs');

    const second = await seedCampaigns(pool, smallPlan().steps);

    expect(second.every((r) => r.inserted === 0)).toBe(true);
    expect(second.every((r) => !r.created)).toBe(true);
    expect(second.every((r) => r.specUpdated === 0)).toBe(true);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sim_jobs');
    expect(after.rows[0]!.n).toBe(jobsAfterFirst.rows[0]!.n);
    const campaigns = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sim_campaigns');
    expect(campaigns.rows[0]!.n).toBe(String(first.length));
  });

  it('does not touch jobs a worker has already leased or completed', async () => {
    const steps = smallPlan().steps;
    await seedCampaigns(pool, steps);
    const c = await pool.query<{ id: string }>(`SELECT id FROM sim_campaigns WHERE name = 'dopp-tune-r1-cand-a'`);
    const campaignId = c.rows[0]!.id;
    await pool.query(
      `UPDATE sim_jobs SET status = 'leased', lease_token = 'tok', leased_by = 'host-1', attempts = 1
       WHERE campaign_id = $1 AND game_index < 2`, [campaignId],
    );

    const again = await seedCampaigns(pool, steps);

    expect(again.find((r) => r.name === 'dopp-tune-r1-cand-a')!.inserted).toBe(0);
    const leased = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sim_jobs WHERE campaign_id = $1 AND status = 'leased' AND lease_token = 'tok'`, [campaignId],
    );
    expect(leased.rows[0]!.n).toBe('2');
  });

  it('preserves the shared seeds and the pairing interleave on disk', async () => {
    const steps = smallPlan().steps;
    await seedCampaigns(pool, steps);

    const seedsOf = async (name: string) => (await pool.query<{ game_index: number; seed: string }>(
      `SELECT j.game_index, j.seed::text AS seed FROM sim_jobs j
       JOIN sim_campaigns c ON c.id = j.campaign_id AND c.name = $1
       ORDER BY j.game_index`, [name],
    )).rows;

    const a = await seedsOf('dopp-tune-r1-cand-a');
    const b = await seedsOf('dopp-tune-r1-cand-b');
    const planned = steps[0]!.jobs;
    expect(a.map((r) => r.seed)).toEqual(planned.map((j) => j.seed.toString()));
    expect(a.map((r) => r.game_index)).toEqual(planned.map((j) => j.gameIndex));
    // The headline property, read back from Postgres rather than from the plan.
    expect(b).toEqual(a);
  });

  it('coexists with the mission campaigns without colliding on name or job', async () => {
    const mission = createPlan({ GRID_GAMES: '8', ARM_GAMES: '8', MIRROR_GAMES: '8', ARM6_GAMES: '8' }).steps;
    await seedCampaigns(pool, mission);
    const tuning = await seedCampaigns(pool, smallPlan().steps);

    expect(tuning.every((r) => r.created)).toBe(true);
    expect(tuning.every((r) => r.inserted === r.plannedJobs)).toBe(true);
    // Mission campaigns keep their own labels — the shared helper's defaults.
    const arm1 = await pool.query<{ created_by: string; description: string }>(
      `SELECT created_by, description FROM sim_campaigns WHERE name = 'arm1'`,
    );
    expect(arm1.rows[0]!.created_by).toBe('seed-sim-campaign');
    expect(arm1.rows[0]!.description).toBe('ISMCTS mission — arm1 (#248)');
    // …and the tuning family sorts strictly ahead of every mission tier.
    const tiers = await pool.query<{ min: number; mission_min: number }>(
      `SELECT (SELECT min(priority_tier) FROM sim_campaigns WHERE created_by = 'seed-deck-tuning-campaign') AS min,
              (SELECT min(priority_tier) FROM sim_campaigns WHERE created_by = 'seed-sim-campaign') AS mission_min`,
    );
    expect(tiers.rows[0]!.min).toBeLessThan(tiers.rows[0]!.mission_min);
  });
});
