/**
 * Seed the ISMCTS-mission sim campaigns + jobs WITHOUT the Discord admin UI
 * (#248, Dean's constraint) — the campaign half of the no-admin bootstrap, a
 * sibling to seed-sim-credentials.mts. Runs client-side against DATABASE_URL.
 *
 *   DATABASE_URL=postgres://… npm run sim:seed-campaign
 *
 * Creates one campaign per mission step (grid + arm1/arm2/arm3/arm5/mirror +
 * arm6a/b/c) and its per-game `sim_jobs` rows, with EXPLICIT seeds matching the
 * unbrewed-engine campaign plan (so the fleet's local-store games flush onto the
 * exact jobs) and duel specs the engine spec-bridge can run. IDEMPOTENT: a job is
 * only created when neither a job nor a completed game already exists for that
 * (campaign, game_index), so re-running tops up rather than duplicating or
 * resurrecting finished work.
 *
 * Dials (defaults = what Dean runs): GRID_GAMES=500, GRID_VARIANTS excludes
 * sims-1024, ARM3_WINNER_SIMB=512, arms 1000 each, mirror 200, arm6 500 each at
 * ARM6_ITERS_LIST=128,256,512. Override via env.
 *
 * This file is only the CLI. The PLAN (pairings, seeds, specs, tiers) lives in
 * lib/sim-campaign-plan.mts and the DB writes in lib/sim-campaign-seed.mts, both
 * unit-tested — see test/sim-campaign-plan.test.ts and test/sim-campaign-seed.test.ts.
 *
 * Two things a RE-RUN does NOT do, on purpose: (1) it never rewrites `sim_jobs`
 * for an existing campaign (a live arm owns those; per-job specs are already
 * correct) — only `sim_campaigns.spec` (the admin-UI pool description) is updated
 * in place; (2) pairings interleave by game_index for jobs seeded from here on,
 * so interim win rates sample all matchups. Campaigns seeded before that ran
 * pairing-blocked, so their first ~ARM_GAMES/|PAIRINGS| games per arm are skewed
 * to one matchup — only the final all-games rates are matchup-balanced.
 */

import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { createPlan } from './lib/sim-campaign-plan.mjs';
import { seedCampaigns, tierDrift } from './lib/sim-campaign-seed.mjs';

loadEnvFile();

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL });
  try {
    const { steps, dials } = createPlan();
    const results = await seedCampaigns(pool, steps);

    for (const r of results) {
      console.log(`  ${r.name.padEnd(7)} campaign ${r.id} · tier ${r.tier} · ${r.plannedJobs} planned · ${r.inserted} inserted · ${r.specUpdated} spec-template updated · ${r.failedReset} failed→pending`);
    }
    console.log('');
    console.log(`Dials: ${Object.entries(dials).map(([k, v]) => `${k}=${v}`).join(' ')}`);

    // An existing campaign is never re-tiered automatically (see upsertCampaign),
    // so surface the exact SQL rather than letting the step be silently skipped.
    const drift = tierDrift(results);
    if (drift.length > 0) {
      console.log('');
      console.log('!! PRIORITY TIER DRIFT — these campaigns already existed and were NOT re-tiered.');
      console.log('!! Lower tiers claim first; run this by hand if the plan order is the one you want:');
      console.log('');
      for (const d of drift) {
        console.log(`  UPDATE sim_campaigns SET priority_tier = ${d.want} WHERE name = '${d.name}';  -- currently ${d.have}`);
      }
    }

    const pin = results.map((r) => r.id).join(',');
    console.log('');
    console.log('Campaigns seeded. Run them with Emyrk\'s control-plane worker (the one');
    console.log('canonical executor), PINNED to OUR campaigns so it never claims another');
    console.log("team's jobs on the shared control plane. In the unbrewed-pro-server checkout:");
    console.log('');
    console.log(`  export SIM_CAMPAIGN_ID=${pin}`);
    console.log('  TELEMETRY_URL=<origin> TELEMETRY_API_KEY=<ubk_…> \\');
    console.log('    npm run sim:worker -- --campaign "$SIM_CAMPAIGN_ID"   # or SIM_CAMPAIGN_ID env');
    console.log('');
    console.log('Runs only within these campaigns. A killed worker\'s in-flight games are');
    console.log('reclaimed and re-run. Grid jobs are already completed (backfill done); the');
    console.log('worker picks up the remaining arm/mirror games. See docs/eval/README.md.');
    console.log('');
    console.log('STATS CAVEAT: campaigns seeded BEFORE the interleave fix ran pairings in blocks');
    console.log('(all of pairing 0, then pairing 1, …), so their interim win rates over the');
    console.log('first ~250 games per arm are skewed to a single matchup. Games seeded from now');
    console.log('on interleave pairings by game_index, so interim rates sample all matchups.');
    console.log('Only the FINAL, all-games rates are matchup-balanced regardless.');
  } finally {
    await pool.end();
  }
}

void main();
