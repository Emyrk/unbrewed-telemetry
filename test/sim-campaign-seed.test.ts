/**
 * The campaign seeder's IDEMPOTENCY contract (#39) — DB-backed, gated on
 * TEST_DATABASE_URL like the rest of the suite.
 *
 * Dean runs `npm run sim:seed-campaign` by hand against the shared production
 * control plane, where six completed campaigns and another team's paused sweep
 * already live. A re-run that duplicated jobs, resurrected finished games, or
 * reshuffled priority tiers would destroy real work, so the guarantees are
 * pinned here against a real Postgres rather than argued from the SQL.
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPlan } from '../scripts/lib/sim-campaign-plan.mjs';
import { seedCampaigns, tierDrift } from '../scripts/lib/sim-campaign-seed.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

/** A small plan — same code path, far fewer rows than the real 8,200. */
const smallPlan = () => createPlan({ GRID_GAMES: '8', ARM_GAMES: '8', MIRROR_GAMES: '8', ARM6_GAMES: '8' });
const arm6 = ['arm6a', 'arm6b', 'arm6c'];

describeDb('seed-sim-campaign idempotency', () => {
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

  it('creates arm6a/b/c with their full job set at tiers 0/1/2', async () => {
    const results = await seedCampaigns(pool, smallPlan().steps);

    for (const [i, name] of arm6.entries()) {
      const r = results.find((x) => x.name === name)!;
      expect(r.created).toBe(true);
      expect(r.inserted).toBe(r.plannedJobs);

      const row = await pool.query<{ priority_tier: number; total_games: number; base_seed: string; jobs: string }>(
        `SELECT c.priority_tier, c.total_games, c.base_seed,
                (SELECT count(*) FROM sim_jobs j WHERE j.campaign_id = c.id) AS jobs
         FROM sim_campaigns c WHERE c.name = $1`, [name],
      );
      expect(row.rows[0]!.priority_tier).toBe(i);          // cheapest budget first
      expect(row.rows[0]!.base_seed).toBe('20000');        // shared arm seed base
      expect(Number(row.rows[0]!.jobs)).toBe(r.plannedJobs);
      expect(row.rows[0]!.total_games).toBe(r.plannedJobs);
    }
  });

  it('inserts ZERO jobs on a second run and creates no duplicate campaigns', async () => {
    const first = await seedCampaigns(pool, smallPlan().steps);
    const jobsAfterFirst = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sim_jobs');

    const second = await seedCampaigns(pool, smallPlan().steps);

    expect(second.every((r) => r.inserted === 0)).toBe(true);
    expect(second.every((r) => !r.created)).toBe(true);
    // Same campaign rows, not a second generation of them.
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
    const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sim_jobs');
    expect(after.rows[0]!.n).toBe(jobsAfterFirst.rows[0]!.n);
    const campaigns = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sim_campaigns');
    expect(campaigns.rows[0]!.n).toBe(String(first.length));
    // The spec template is already current, so even that write is a no-op.
    expect(second.every((r) => r.specUpdated === 0)).toBe(true);
  });

  it('does not resurrect completed work whose job row is gone', async () => {
    const steps = smallPlan().steps;
    await seedCampaigns(pool, steps);
    const arm6a = await pool.query<{ id: string }>(`SELECT id FROM sim_campaigns WHERE name = 'arm6a'`);
    const campaignId = arm6a.rows[0]!.id;

    // Simulate a finished game at game_index 3 whose job row has been pruned.
    await pool.query(
      `INSERT INTO game_submissions (id, idempotency_key, payload, validation_status)
       VALUES ('sub-3', 'idem-3', '{}'::jsonb, 'valid')`,
    );
    await pool.query(
      `INSERT INTO games (id, submission_id, schema_version, received_at, source, format, map,
                          winner_team, payload, campaign_id, campaign_game_index)
       VALUES ('done-3', 'sub-3', 1, now(), 'test', 'duel', 'mended-drum', 0, '{}'::jsonb, $1, 3)`,
      [campaignId],
    );
    await pool.query('DELETE FROM sim_jobs WHERE campaign_id = $1 AND game_index = 3', [campaignId]);

    const again = await seedCampaigns(pool, steps);

    expect(again.find((r) => r.name === 'arm6a')!.inserted).toBe(0);
    const revived = await pool.query('SELECT 1 FROM sim_jobs WHERE campaign_id = $1 AND game_index = 3', [campaignId]);
    expect(revived.rowCount).toBe(0);
  });

  it('tops up only the genuinely missing indexes', async () => {
    const steps = smallPlan().steps;
    await seedCampaigns(pool, steps);
    const arm6b = await pool.query<{ id: string }>(`SELECT id FROM sim_campaigns WHERE name = 'arm6b'`);
    await pool.query('DELETE FROM sim_jobs WHERE campaign_id = $1 AND game_index IN (1, 2)', [arm6b.rows[0]!.id]);

    const again = await seedCampaigns(pool, steps);

    expect(again.find((r) => r.name === 'arm6b')!.inserted).toBe(2);
    for (const r of again.filter((x) => x.name !== 'arm6b')) expect(r.inserted).toBe(0);
  });

  it('preserves the seeded seeds and pairing interleave on disk', async () => {
    const steps = smallPlan().steps;
    await seedCampaigns(pool, steps);
    const planned = steps.find((s) => s.name === 'arm6a')!.jobs;

    const rows = await pool.query<{ game_index: number; seed: string }>(
      `SELECT j.game_index, j.seed::text AS seed FROM sim_jobs j
       JOIN sim_campaigns c ON c.id = j.campaign_id AND c.name = 'arm6a'
       ORDER BY j.game_index`,
    );
    expect(rows.rows.map((r) => r.seed)).toEqual(planned.map((j) => j.seed.toString()));
    expect(rows.rows.map((r) => r.game_index)).toEqual(planned.map((j) => j.gameIndex));
  });

  it('never re-tiers an existing campaign, and reports the drift as runnable SQL', async () => {
    const steps = smallPlan().steps;
    await seedCampaigns(pool, steps);
    // An operator moves arm6a out of the way by hand.
    await pool.query(`UPDATE sim_campaigns SET priority_tier = 7 WHERE name = 'arm6a'`);

    const again = await seedCampaigns(pool, steps);

    const stored = await pool.query<{ priority_tier: number }>(`SELECT priority_tier FROM sim_campaigns WHERE name = 'arm6a'`);
    expect(stored.rows[0]!.priority_tier).toBe(7); // the seeder did NOT stomp it
    expect(tierDrift(again)).toEqual([{ name: 'arm6a', want: 0, have: 7 }]);
  });

  it('requeues terminally-failed jobs without duplicating them', async () => {
    const steps = smallPlan().steps;
    await seedCampaigns(pool, steps);
    const arm6c = await pool.query<{ id: string }>(`SELECT id FROM sim_campaigns WHERE name = 'arm6c'`);
    const id = arm6c.rows[0]!.id;
    await pool.query(`UPDATE sim_jobs SET status = 'failed' WHERE campaign_id = $1 AND game_index < 2`, [id]);

    const again = await seedCampaigns(pool, steps);

    expect(again.find((r) => r.name === 'arm6c')!.failedReset).toBe(2);
    expect(again.find((r) => r.name === 'arm6c')!.inserted).toBe(0);
    const pending = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sim_jobs WHERE campaign_id = $1 AND status = 'pending'`, [id],
    );
    expect(pending.rows[0]!.n).toBe(String(steps.find((s) => s.name === 'arm6c')!.jobs.length));
  });
});
