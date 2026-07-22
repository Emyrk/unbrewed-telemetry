/**
 * Seed the ISMCTS-mission sim campaigns + jobs WITHOUT the Discord admin UI
 * (#248, Dean's constraint) — the campaign half of the no-admin bootstrap, a
 * sibling to seed-sim-credentials.mts. Runs client-side against DATABASE_URL.
 *
 *   DATABASE_URL=postgres://… npm run sim:seed-campaign
 *
 * Creates one campaign per mission step (grid + arm1/arm2/arm3/arm5/mirror) and
 * its per-game `sim_jobs` rows, with EXPLICIT seeds matching the unbrewed-engine
 * campaign plan (so the fleet's local-store games flush onto the exact jobs) and
 * duel specs the engine spec-bridge can run. IDEMPOTENT: a job is only created
 * when neither a job nor a completed game already exists for that
 * (campaign, game_index), so re-running tops up rather than duplicating or
 * resurrecting finished work.
 *
 * Dials (defaults = what Dean runs): GRID_GAMES=500, GRID_VARIANTS excludes
 * sims-1024, ARM3_WINNER_SIMB=512, arms 1000 each, mirror 200. Override via env.
 *
 * NOTE: the plan (pairings, seed formulas, variant order) mirrors the engine's
 * scripts/lib/simPlan.ts + ai-knob-grid.mts. Keep them in sync; a drift moves the
 * seeds and the flush would stop matching.
 *
 * Two things a RE-RUN does NOT do, on purpose: (1) it never rewrites `sim_jobs`
 * for an existing campaign (a live arm owns those; per-job specs are already
 * correct) — only `sim_campaigns.spec` (the admin-UI pool description) is updated
 * in place; (2) pairings interleave by game_index for jobs seeded from here on,
 * so interim win rates sample all matchups. Campaigns seeded before that ran
 * pairing-blocked, so their first ~ARM_GAMES/|PAIRINGS| games per arm are skewed
 * to one matchup — only the final all-games rates are matchup-balanced.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';

loadEnvFile();

const num = (v: string | undefined, d: number): number => (v && v.trim() !== '' ? Number(v) : d);
const GRID_GAMES = num(process.env.GRID_GAMES, 500);
const GRID_SEED = num(process.env.GRID_SEED, 232_000);
const ARM_GAMES = num(process.env.ARM_GAMES, 1000);
const MIRROR_GAMES = num(process.env.MIRROR_GAMES, 200);
const MS = num(process.env.MS, 600_000);
const ARM1_ITERS = num(process.env.ARM1_ITERS, 3000);
const ARM2_ITERS = num(process.env.ARM2_ITERS, 1000);
const ARM5_ITERS = num(process.env.ARM5_ITERS, 3000);
const MIRROR_ITERS = num(process.env.MIRROR_ITERS, 1000);
const HARD_SIMB = num(process.env.HARD_SIMB, 64);
const ARM5_SIMB = num(process.env.ARM5_SIMB, 256);
const ARM3_WINNER_SIMB = num(process.env.ARM3_WINNER_SIMB, 512);
const MAP = process.env.SIM_MAP ?? 'mended-drum';

// Full knob-grid variant order — the index seeds every grid game (ai-knob-grid).
const GRID_VARIANTS_ALL = ['sims-64', 'sims-128', 'sims-256', 'sims-512', 'sims-1024', 'eps-5', 'eps-20', 'depth-80'];
const gridVariants = (process.env.GRID_VARIANTS ?? 'sims-64,sims-128,sims-256,sims-512,eps-5,eps-20,depth-80')
  .split(',').map((s) => s.trim()).filter(Boolean);

// mixed pairing corpus (arena.mts PAIRINGS.mixed): [seat-A hero, seat-B hero].
const PAIRINGS: Array<[string, string]> = [
  ['king-kong', 'king-kong'],
  ['thrall', 'king-kong'],
  ['the-mandalorian', 'thrall'],
  ['the-mandalorian', 'king-kong'],
];

// CANONICAL PILOT FORM (Emyrk's convention — verified against ai/registry.ts
// parseSimulationDifficulty + PR #250 sim-game.ts): `bot:<difficulty>(<sims>,<secs>s)`.
// The `bot:` prefix is what his dashboards classify human-vs-bot by, and the
// duration is in SECONDS. His runner strips `bot:` and accepts either unit, so
// this parses on both sides; using it keeps our flushed games correctly labelled.
const SECS = Math.round(MS / 1000);
const expert = (iters: number): string => `bot:expert(${iters},${SECS}s)`;
const hard = (simCap: number): string => `bot:hard(${simCap},${SECS}s)`;
// Grid variant pilot (publish-only; not a resolvable difficulty). bot:-prefixed so
// it still classifies as a bot and distinguishes variants in per-variant stats.
const variantPilot = (variantId: string): string => `bot:mc(${variantId})`;

interface JobRow {
  gameIndex: number;
  seed: bigint;
  spec: unknown;
}

/**
 * duel spec: seat0 = {heroA, pilotA}, seat1 = {heroB, pilotB}.
 *
 * DIALECT NOTE (for the #250 reconciliation): Emyrk's worker (PR #250,
 * scripts/sim-game.ts `ExactGameSpec`) REQUIRES a top-level `format` field
 * ('duel' | 'team-2v2' | '2v2') — without it his runner throws
 * `Unsupported format "undefined"` and terminally-fails the job (the collision we
 * hit). So every spec here carries `format: 'duel'`. His runner resolves pilots
 * with the same `parseSimulationDifficulty`, so our ARM pilots (`expert(iters)` /
 * `hard(simB)`) run cleanly on his side too; GRID variant pilots (`mc(sims-512)`,
 * `mc(eps-5)`, …) do NOT resolve for him — grid is publish-only (completed by the
 * engine boot flush from banked results). Cross-fleet safety therefore relies on
 * BOTH fleets PINNING to their own campaigns (SIM_CAMPAIGN_ID); see below.
 */
function duel(heroA: string, pilotA: string, heroB: string, pilotB: string): Record<string, unknown> {
  return { format: 'duel', map: MAP, teams: [{ seats: [{ deck: heroA, pilot: pilotA }] }, { seats: [{ deck: heroB, pilot: pilotB }] }] };
}

/** Arm jobs: seed 20000 + global index; the ISMCTS pilot alternates seats per game.
 *  `step` is stamped into the spec so the boot flush matches by (step, seed) — arm
 *  campaigns deliberately SHARE the 20000+ seed space, so seed alone is ambiguous. */
function armJobs(step: string, botAIters: number, botBSimB: number, games: number, mirror = false): JobRow[] {
  const perPair = Math.max(2, Math.floor(games / PAIRINGS.length));
  const jobs: JobRow[] = [];
  let gi = 0;
  // Interleave pairings in game_index order (i OUTER, pairing INNER) so the first
  // N games sample ALL matchups rather than N games of pairing 0. A pairing-blocked
  // order skews interim win rates to a single matchup for the first ~perPair games.
  // The SEED per (pairing, i) is unchanged, so seed identity (and any flush match)
  // holds; only the game_index→pairing assignment interleaves.
  for (let i = 0; i < perPair; i++) {
    for (let p = 0; p < PAIRINGS.length; p++) {
      const [hA, hB] = PAIRINGS[p]!;
      const seed = BigInt(20_000 + p * perPair + i);
      const aPilot = expert(botAIters);
      const bPilot = mirror ? expert(MIRROR_ITERS) : hard(botBSimB);
      // ISMCTS on seat0 for even global index, seat1 for odd (seat alternation).
      const spec = { ...(gi % 2 === 0 ? duel(hA, aPilot, hB, bPilot) : duel(hA, bPilot, hB, aPilot)), step };
      jobs.push({ gameIndex: gi, seed, spec });
      gi++;
    }
  }
  return jobs;
}

/** Grid jobs: variant vs control (sims-64). Seeds match ai-knob-grid exactly.
 *  These are NOT run by the fleet (variant knobs aren't runnable pilots) — they
 *  are completed by the boot flush from the already-banked grid results. */
function gridJobs(): JobRow[] {
  const perPairing = Math.max(2, Math.floor(GRID_GAMES / PAIRINGS.length));
  const jobs: JobRow[] = [];
  let gi = 0;
  for (const variantId of gridVariants) {
    const vIdx = GRID_VARIANTS_ALL.indexOf(variantId);
    if (vIdx < 0) throw new Error(`unknown grid variant "${variantId}"`);
    // Interleave pairings in game_index order (see armJobs); seeds are unchanged.
    for (let i = 0; i < perPairing; i++) {
      for (let p = 0; p < PAIRINGS.length; p++) {
        const [hA, hB] = PAIRINGS[p]!;
        const seed = BigInt(GRID_SEED + vIdx * 1_000_000 + p * 100_000 + i);
        const spec = { ...duel(hA, variantPilot(variantId), hB, hard(HARD_SIMB)), variantId, step: 'grid' };
        jobs.push({ gameIndex: gi, seed, spec });
        gi++;
      }
    }
  }
  return jobs;
}

async function upsertCampaign(pool: Pool, name: string, spec: unknown, baseSeed: bigint, totalGames: number): Promise<string> {
  const existing = await pool.query<{ id: string }>('SELECT id FROM sim_campaigns WHERE name = $1 ORDER BY created_at DESC LIMIT 1', [name]);
  if (existing.rowCount && existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO sim_campaigns (id, name, description, spec, base_seed, total_games, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'seed-sim-campaign')`,
    [id, name, `ISMCTS mission — ${name} (#248)`, JSON.stringify(spec), baseSeed.toString(), totalGames],
  );
  return id;
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

/** The corpus deck pool (both seats draw from it) — arena.mts mixed pairings.
 *  Order-preserving union of PAIRINGS, so the admin UI describes an arm by the
 *  whole matchup set, not just pairing 0. */
const DECK_POOL: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [a, b] of PAIRINGS) for (const h of [a, b]) if (!seen.has(h)) { seen.add(h); out.push(h); }
  return out;
})();

/**
 * A campaign-level spec in Emyrk's pool shape (his admin UI renders
 * `campaign.spec` as format/maps/teams with `decks`/`pilots` POOLS — the sets a
 * seat may draw from, not one fixed matchup). BOTH seats therefore carry the full
 * corpus deck pool (king-kong / thrall / the-mandalorian); the exact per-game
 * pairing + seat alternation lives in each job's override spec, per his
 * games-array pattern. Our internal {kind,a,b} shorthand is kept under the
 * `x-ismcts` extension key so nothing we rely on is lost.
 */
function campaignSpec(pilotA: string, pilotB: string, x: Record<string, unknown>): Record<string, unknown> {
  return {
    format: 'duel',
    maps: [MAP],
    teams: [
      { seats: [{ decks: DECK_POOL, pilots: [pilotA] }] },
      { seats: [{ decks: DECK_POOL, pilots: [pilotB] }] },
    ],
    'x-ismcts': x,
  };
}

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

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL });
  try {
    const steps: Array<{ name: string; baseSeed: bigint; jobs: JobRow[]; spec: Record<string, unknown> }> = [
      { name: 'grid', baseSeed: BigInt(GRID_SEED), jobs: gridJobs(), spec: campaignSpec(variantPilot(gridVariants[0] ?? 'sims-64'), hard(HARD_SIMB), { kind: 'grid', variants: gridVariants }) },
      { name: 'arm1', baseSeed: 20_000n, jobs: armJobs('arm1', ARM1_ITERS, HARD_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM1_ITERS), hard(HARD_SIMB), { kind: 'arm', a: expert(ARM1_ITERS), b: hard(HARD_SIMB) }) },
      { name: 'arm2', baseSeed: 20_000n, jobs: armJobs('arm2', ARM2_ITERS, HARD_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM2_ITERS), hard(HARD_SIMB), { kind: 'arm', a: expert(ARM2_ITERS), b: hard(HARD_SIMB) }) },
      { name: 'arm3', baseSeed: 20_000n, jobs: armJobs('arm3', ARM1_ITERS, ARM3_WINNER_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM1_ITERS), hard(ARM3_WINNER_SIMB), { kind: 'arm', a: expert(ARM1_ITERS), b: hard(ARM3_WINNER_SIMB) }) },
      { name: 'arm5', baseSeed: 20_000n, jobs: armJobs('arm5', ARM5_ITERS, ARM5_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM5_ITERS), hard(ARM5_SIMB), { kind: 'arm', a: expert(ARM5_ITERS), b: hard(ARM5_SIMB) }) },
      { name: 'mirror', baseSeed: 20_000n, jobs: armJobs('mirror', MIRROR_ITERS, 0, MIRROR_GAMES, true), spec: campaignSpec(expert(MIRROR_ITERS), expert(MIRROR_ITERS), { kind: 'mirror', a: expert(MIRROR_ITERS) }) },
    ];
    const ids: string[] = [];
    for (const s of steps) {
      const id = await upsertCampaign(pool, s.name, s.spec, s.baseSeed, s.jobs.length);
      // TEMPLATE-ONLY migration: update the campaign-level spec (the admin-UI pool
      // description) in place. This is the ONLY thing a re-run mutates on an
      // existing campaign — it deliberately does NOT touch `sim_jobs`, because a
      // live arm is claiming/running them and the per-job override specs are
      // already correct. New campaigns still get their jobs via insertJobs below
      // (a no-op for any that already exist).
      const spec = await pool.query('UPDATE sim_campaigns SET spec = $2::jsonb WHERE id = $1 AND spec IS DISTINCT FROM $2::jsonb', [id, JSON.stringify(s.spec)]);
      const reset = await resetFailedJobs(pool, id);
      const ins = await insertJobs(pool, id, s.jobs);
      ids.push(id);
      console.log(`  ${s.name.padEnd(7)} campaign ${id} · ${s.jobs.length} planned · ${ins} inserted · ${spec.rowCount ?? 0} spec-template updated · ${reset} failed→pending`);
    }
    const pin = ids.join(',');
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
    console.log('STATS CAVEAT: campaigns seeded BEFORE this fix ran pairings in blocks (all of');
    console.log('pairing 0, then pairing 1, …), so their interim win rates over the first');
    console.log(`~${Math.max(2, Math.floor(ARM_GAMES / PAIRINGS.length))} games per arm are skewed to a single matchup. Games seeded from now on`);
    console.log('interleave pairings by game_index, so interim rates sample all matchups. Only');
    console.log('the FINAL, all-games rates are matchup-balanced regardless.');
  } finally {
    await pool.end();
  }
}

void main();
