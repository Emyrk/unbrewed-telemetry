/**
 * The ISMCTS-mission campaign PLAN — pure, DB-free, deterministic.
 *
 * Extracted from seed-sim-campaign.mts so the plan (job counts, per-game seeds,
 * pairing order, specs, priority tiers) can be asserted in unit tests without a
 * database. seed-sim-campaign.mts is now just the I/O half: it calls
 * `createPlan()` and upserts the result.
 *
 * NOTE: the plan (pairings, seed formulas, variant order) mirrors the engine's
 * scripts/lib/simPlan.ts + ai-knob-grid.mts. Keep them in sync; a drift moves the
 * seeds and the flush would stop matching.
 */

export interface JobRow {
  gameIndex: number;
  seed: bigint;
  spec: Record<string, unknown>;
}

export interface PlanStep {
  name: string;
  baseSeed: bigint;
  jobs: JobRow[];
  spec: Record<string, unknown>;
  /** Lower tiers are claimed first; see `priority_tier` in migration 008. */
  priorityTier: number;
}

export interface Plan {
  steps: PlanStep[];
  /** Echoed in the seed output so the operator can eyeball what was planned. */
  dials: Readonly<Record<string, number | string>>;
}

const num = (v: string | undefined, d: number): number => (v && v.trim() !== '' ? Number(v) : d);

// Full knob-grid variant order — the index seeds every grid game (ai-knob-grid).
const GRID_VARIANTS_ALL = ['sims-64', 'sims-128', 'sims-256', 'sims-512', 'sims-1024', 'eps-5', 'eps-20', 'depth-80'];

// mixed pairing corpus (arena.mts PAIRINGS.mixed): [seat-A hero, seat-B hero].
export const PAIRINGS: Array<[string, string]> = [
  ['king-kong', 'king-kong'],
  ['thrall', 'king-kong'],
  ['the-mandalorian', 'thrall'],
  ['the-mandalorian', 'king-kong'],
];

/** The corpus deck pool (both seats draw from it) — arena.mts mixed pairings.
 *  Order-preserving union of PAIRINGS, so the admin UI describes an arm by the
 *  whole matchup set, not just pairing 0. */
export const DECK_POOL: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [a, b] of PAIRINGS) for (const h of [a, b]) if (!seen.has(h)) { seen.add(h); out.push(h); }
  return out;
})();

/** All arm campaigns deliberately SHARE this seed base — that is what makes them
 *  seed-matched (same pairing + same seed at the same game_index), so arm-vs-arm
 *  is a PAIRED comparison rather than independent samples. Never mint a new base
 *  for a new arm. */
export const ARM_BASE_SEED = 20_000n;

export function createPlan(env: NodeJS.ProcessEnv = process.env): Plan {
  const GRID_GAMES = num(env.GRID_GAMES, 500);
  const GRID_SEED = num(env.GRID_SEED, 232_000);
  const ARM_GAMES = num(env.ARM_GAMES, 1000);
  const MIRROR_GAMES = num(env.MIRROR_GAMES, 200);
  const MS = num(env.MS, 600_000);
  const ARM1_ITERS = num(env.ARM1_ITERS, 3000);
  const ARM2_ITERS = num(env.ARM2_ITERS, 1000);
  const ARM5_ITERS = num(env.ARM5_ITERS, 3000);
  const MIRROR_ITERS = num(env.MIRROR_ITERS, 1000);
  const HARD_SIMB = num(env.HARD_SIMB, 64);
  const ARM5_SIMB = num(env.ARM5_SIMB, 256);
  const ARM3_WINNER_SIMB = num(env.ARM3_WINNER_SIMB, 512);
  // arm6 (#39): expert at budgets we could actually SERVE to a live player.
  const ARM6_GAMES = num(env.ARM6_GAMES, 500);
  const ARM6_ITERS_LIST = (env.ARM6_ITERS_LIST ?? '128,256,512')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const MAP = env.SIM_MAP ?? 'mended-drum';

  const gridVariants = (env.GRID_VARIANTS ?? 'sims-64,sims-128,sims-256,sims-512,eps-5,eps-20,depth-80')
    .split(',').map((s) => s.trim()).filter(Boolean);

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

  /**
   * duel spec: seat0 = {heroA, pilotA}, seat1 = {heroB, pilotB}.
   *
   * DIALECT NOTE (for the #250 reconciliation): Emyrk's worker (PR #250,
   * scripts/sim-game.ts `ExactGameSpec`) REQUIRES a top-level `format` field
   * ('duel' | 'team-2v2' | '2v2') — without it his runner throws
   * `Unsupported format "undefined"` and terminally-fails the job (the collision we
   * hit). So every spec here carries `format: 'duel'`.
   */
  const duel = (heroA: string, pilotA: string, heroB: string, pilotB: string): Record<string, unknown> =>
    ({ format: 'duel', map: MAP, teams: [{ seats: [{ deck: heroA, pilot: pilotA }] }, { seats: [{ deck: heroB, pilot: pilotB }] }] });

  /**
   * Arm jobs: seed 20000 + pairing stride + i; the ISMCTS pilot alternates seats
   * per game. `step` is stamped into the spec so the boot flush matches by
   * (step, seed) — arm campaigns deliberately SHARE the 20000+ seed space, so seed
   * alone is ambiguous.
   *
   * SEED STRIDE — why it is a separate knob from `games`. The seed of game
   * (pairing p, repeat i) is `20000 + p*stride + i`, and the stride used to be
   * derived from this arm's own `games`. That silently breaks seed-matching for a
   * SHORTER arm: a 500-game arm would stride by 125 while the 1000-game arms
   * stride by 250, so identical game_index values would carry different seeds and
   * the "paired comparison" property would be lost. `seedGames` therefore pins the
   * stride to the arm family's canonical length (ARM_GAMES) independently of how
   * many games this particular arm runs. Existing steps pass nothing and keep
   * stride === floor(their own games / 4), i.e. byte-identical seeds to what is
   * already in the database.
   */
  const armJobs = (
    step: string,
    botAIters: number,
    botBSimB: number,
    games: number,
    opts: { mirror?: boolean; seedGames?: number } = {},
  ): JobRow[] => {
    const perPair = Math.max(2, Math.floor(games / PAIRINGS.length));
    const seedStride = Math.max(2, Math.floor((opts.seedGames ?? games) / PAIRINGS.length));
    // A stride shorter than the repeat count would alias pairing p's tail onto
    // pairing p+1's head — duplicate seeds inside one campaign.
    if (perPair > seedStride) {
      throw new Error(`${step}: ${games} games needs a seed stride ≥ ${perPair}, got ${seedStride} (seedGames too small)`);
    }
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
        const seed = ARM_BASE_SEED + BigInt(p * seedStride + i);
        const aPilot = expert(botAIters);
        const bPilot = opts.mirror ? expert(MIRROR_ITERS) : hard(botBSimB);
        // ISMCTS on seat0 for even global index, seat1 for odd (seat alternation).
        const spec = { ...(gi % 2 === 0 ? duel(hA, aPilot, hB, bPilot) : duel(hA, bPilot, hB, aPilot)), step };
        jobs.push({ gameIndex: gi, seed, spec });
        gi++;
      }
    }
    return jobs;
  };

  /** Grid jobs: variant vs control (sims-64). Seeds match ai-knob-grid exactly.
   *  These are NOT run by the fleet (variant knobs aren't runnable pilots) — they
   *  are completed by the boot flush from the already-banked grid results. */
  const gridJobs = (): JobRow[] => {
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
  };

  /**
   * A campaign-level spec in Emyrk's pool shape (his admin UI renders
   * `campaign.spec` as format/maps/teams with `decks`/`pilots` POOLS — the sets a
   * seat may draw from, not one fixed matchup). BOTH seats therefore carry the full
   * corpus deck pool (king-kong / thrall / the-mandalorian); the exact per-game
   * pairing + seat alternation lives in each job's override spec, per his
   * games-array pattern. Our internal {kind,a,b} shorthand is kept under the
   * `x-ismcts` extension key so nothing we rely on is lost.
   */
  const campaignSpec = (pilotA: string, pilotB: string, x: Record<string, unknown>): Record<string, unknown> => ({
    format: 'duel',
    maps: [MAP],
    teams: [
      { seats: [{ decks: DECK_POOL, pilots: [pilotA] }] },
      { seats: [{ decks: DECK_POOL, pilots: [pilotB] }] },
    ],
    'x-ismcts': x,
  });

  const steps: PlanStep[] = [
    { name: 'grid', priorityTier: 0, baseSeed: BigInt(GRID_SEED), jobs: gridJobs(), spec: campaignSpec(variantPilot(gridVariants[0] ?? 'sims-64'), hard(HARD_SIMB), { kind: 'grid', variants: gridVariants }) },
    { name: 'arm1', priorityTier: 0, baseSeed: ARM_BASE_SEED, jobs: armJobs('arm1', ARM1_ITERS, HARD_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM1_ITERS), hard(HARD_SIMB), { kind: 'arm', a: expert(ARM1_ITERS), b: hard(HARD_SIMB) }) },
    { name: 'arm2', priorityTier: 0, baseSeed: ARM_BASE_SEED, jobs: armJobs('arm2', ARM2_ITERS, HARD_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM2_ITERS), hard(HARD_SIMB), { kind: 'arm', a: expert(ARM2_ITERS), b: hard(HARD_SIMB) }) },
    { name: 'arm3', priorityTier: 0, baseSeed: ARM_BASE_SEED, jobs: armJobs('arm3', ARM1_ITERS, ARM3_WINNER_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM1_ITERS), hard(ARM3_WINNER_SIMB), { kind: 'arm', a: expert(ARM1_ITERS), b: hard(ARM3_WINNER_SIMB) }) },
    { name: 'arm5', priorityTier: 0, baseSeed: ARM_BASE_SEED, jobs: armJobs('arm5', ARM5_ITERS, ARM5_SIMB, ARM_GAMES), spec: campaignSpec(expert(ARM5_ITERS), hard(ARM5_SIMB), { kind: 'arm', a: expert(ARM5_ITERS), b: hard(ARM5_SIMB) }) },
    { name: 'mirror', priorityTier: 0, baseSeed: ARM_BASE_SEED, jobs: armJobs('mirror', MIRROR_ITERS, 0, MIRROR_GAMES, { mirror: true }), spec: campaignSpec(expert(MIRROR_ITERS), expert(MIRROR_ITERS), { kind: 'mirror', a: expert(MIRROR_ITERS) }) },
  ];

  // arm6 (#39): the SERVEABLE-budget sweep. Every expert measurement we have is at
  // 1,000+ iterations, but what we could actually run for a live player is ~128-512
  // — a range with no data at all, and the gap that blocks shipping the tier.
  //
  // Seeded at ARM_BASE_SEED with the ARM_GAMES stride, so arm6a/b/c are seed-matched
  // with arm1/arm2 game-for-game: the whole 128→256→512→1000→3000 curve is one
  // PAIRED comparison instead of five independent samples.
  //
  // Tiers ascend 0,1,2 = CHEAPEST FIRST. Two reasons: (1) all six campaigns above
  // are completed so nothing of ours is active, but the Hard Duel Sweep sits at
  // tier 1 paused — seeding arm6 above it means an unpause would starve arm6, since
  // claimJobs only serves MIN(priority_tier) among ACTIVE campaigns; (2) arm6a, the
  // budget most likely to be serveable, then reports first.
  ARM6_ITERS_LIST.forEach((iters, idx) => {
    const suffix = String.fromCharCode('a'.charCodeAt(0) + idx);
    const name = `arm6${suffix}`;
    steps.push({
      name,
      priorityTier: idx,
      baseSeed: ARM_BASE_SEED,
      jobs: armJobs(name, iters, HARD_SIMB, ARM6_GAMES, { seedGames: ARM_GAMES }),
      spec: campaignSpec(expert(iters), hard(HARD_SIMB), { kind: 'arm', a: expert(iters), b: hard(HARD_SIMB) }),
    });
  });

  return {
    steps,
    dials: {
      GRID_GAMES, GRID_SEED, ARM_GAMES, MIRROR_GAMES, MS, HARD_SIMB,
      ARM6_GAMES, ARM6_ITERS_LIST: ARM6_ITERS_LIST.join(','), SIM_MAP: MAP,
    },
  };
}
