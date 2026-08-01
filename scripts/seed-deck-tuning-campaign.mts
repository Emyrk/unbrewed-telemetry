/**
 * Seed a DECK-TUNING campaign set — one campaign per candidate version of a
 * deck, each against a shared opponent pool plus a mirror, with an optional
 * pool-calibration campaign. Runs client-side against DATABASE_URL, exactly
 * like seed-sim-campaign.mts (its sibling; the mission plan is untouched).
 *
 *   DATABASE_URL=postgres://… npm run sim:seed-deck-tuning
 *
 * First subject: Doppelgänger round 1 (engine Emyrk/unbrewed-engine#320) — the
 * first consumer of the per-seat `deck_rules_hash` / `rules_canonical` archive
 * (#44/#46), so a win rate here is attributable to an exact rules fingerprint.
 *
 * Dials (all optional; defaults = Doppelgänger round 1):
 *   TUNE_CANDIDATES   doppelganger,doppelganger-cand-c   candidate deck ids
 *   TUNE_OPPONENTS    the four reflavored baselines       opponent pool
 *   TUNE_GAMES        40                                  games per pairing
 *   TUNE_SEED_BASE    900000                              shared seed base
 *   TUNE_SEED_STRIDE  1000                                seed slot stride
 *   TUNE_BOT          bot:expert(3000,600s)               pilot for BOTH seats
 *   TUNE_MAP          mended-drum
 *   TUNE_PREFIX       dopp-tune-r1                        campaign name prefix
 *   TUNE_TIER         -1                                  priority tier
 *   TUNE_CALIBRATION  unset                               '1' adds the calib campaign
 *
 * IDEMPOTENT on the same contract as the mission seeder: a job is created only
 * when neither a job nor a completed game exists for that (campaign,
 * game_index), and an existing campaign is never re-tiered and never has its
 * `sim_jobs` rewritten. Re-running tops up; it does not duplicate or resurrect.
 *
 * The PLAN (pairings, seeds, specs, tiers) lives in lib/deck-tuning-plan.mts
 * and the DB writes in lib/sim-campaign-seed.mts (shared with the mission
 * seeder), both unit-tested — see test/deck-tuning-plan.test.ts and
 * test/deck-tuning-seed.test.ts.
 */

import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { createDeckTuningPlan } from './lib/deck-tuning-plan.mjs';
import { seedCampaigns, tierDrift } from './lib/sim-campaign-seed.mjs';

loadEnvFile();

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL });
  try {
    const { steps, dials } = createDeckTuningPlan();
    const width = Math.max(...steps.map((s) => s.name.length));
    const results = await seedCampaigns(pool, steps);

    for (const r of results) {
      console.log(`  ${r.name.padEnd(width)} campaign ${r.id} · tier ${r.tier} · ${r.plannedJobs} planned · ${r.inserted} inserted · ${r.specUpdated} spec-template updated · ${r.failedReset} failed→pending`);
    }
    console.log('');
    console.log(`Dials: ${Object.entries(dials).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`Total: ${results.reduce((n, r) => n + r.plannedJobs, 0)} games across ${results.length} campaigns`);

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
    console.log('Run these with the engine worker, PINNED to these campaigns so it never');
    console.log('claims mission jobs (or another team\'s) off the shared control plane, and');
    console.log('with the deck-rules hash ON — that is the whole point of the campaign.');
    console.log('In the unbrewed-pro-server checkout, on the candidate campaign branch:');
    console.log('');
    console.log(`  export SIM_CAMPAIGN_ID=${pin}`);
    console.log('  TELEMETRY_DECK_RULES_HASH=1 \\');
    console.log('    TELEMETRY_URL=<origin> TELEMETRY_API_KEY=<ubk_…> \\');
    console.log('    npm run sim:worker -- --campaign "$SIM_CAMPAIGN_ID"');
    console.log('');
    console.log('Every candidate deck id above must be REGISTERED on that branch; an');
    console.log('unknown deck id terminally-fails every job in its campaign.');
    console.log('');
    console.log('Seeds are a function of (pairing, repetition) only, so candidate campaigns');
    console.log('are seed-matched game-for-game: compare candidates PAIRWISE at equal');
    console.log('repetition, and group results by deck_rules_hash (not by deck id).');
  } finally {
    await pool.end();
  }
}

void main();
