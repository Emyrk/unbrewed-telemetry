/**
 * The DECK-TUNING campaign PLAN — pure, DB-free, deterministic.
 *
 * A sibling of sim-campaign-plan.mts (same split: plan here, DB writes in
 * lib/sim-campaign-seed.mts, CLI in seed-deck-tuning-campaign.mts). The mission
 * plan measures BOTS against each other; this one measures DECKS: one campaign
 * per candidate version of a deck, each candidate playing the same opponent pool
 * plus a mirror, so a change to the deck's rules can be read as a win-rate move
 * attributable to a specific `deck_rules_hash` (#44/#46 schema).
 *
 * First subject: Doppelgänger round 1 (engine #320). Nothing here is
 * Doppelgänger-specific except the defaults — the shape is "candidates × pool".
 *
 * THE ONE PROPERTY THAT MATTERS: a game's seed is a function of
 * (pairing slot, repetition index) and NOTHING ELSE — in particular not of the
 * candidate. Candidate A's game against `thetis` at repetition 7 therefore runs
 * the exact same seed as candidate B's, so candidate-vs-candidate is a PAIRED
 * comparison (common random numbers) rather than two independent samples. At 40
 * games per pairing that difference is most of the resolving power.
 *
 * SPEC DIALECT: the job specs must be what the engine spec-bridge resolves —
 * `scripts/lib/controlPlaneGame.ts` in unbrewed-pro-server reads a top-level
 * `map` (or `mapId`) and `teams[].seats[]` with `heroId | hero | deck` +
 * `pilot | difficulty`, and Emyrk's worker additionally requires a top-level
 * `format`. Pilot strings must parse through `ai/registry.ts`
 * `parseSimulationDifficulty` — `bot:<tier>(<sims>,<secs>s)`. Verified against
 * that source, not guessed.
 */

import type { JobRow, PlanStep } from './sim-campaign-plan.mjs';

export type { JobRow, PlanStep };

export interface DeckTuningPlan {
  steps: PlanStep[];
  dials: Readonly<Record<string, number | string>>;
}

/** One seed slot: the unit that (with the repetition index) determines a seed. */
export interface PairingSlot {
  /** The `p` in `seed = base + p*stride + i`. Stable across candidates. */
  slot: number;
  /** Recorded in the job spec so results can be grouped without re-deriving. */
  label: string;
  kind: 'opponent' | 'mirror' | 'calibration';
  /** For calibration only: the two pool decks. */
  decks?: [string, string];
}

const num = (v: string | undefined, d: number): number => (v && v.trim() !== '' ? Number(v) : d);
const list = (v: string | undefined, d: string): string[] =>
  (v && v.trim() !== '' ? v : d).split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The shared seed base for the whole deck-tuning family. Like ARM_BASE_SEED,
 * every campaign in the family deliberately SHARES it — that is what makes the
 * candidates seed-matched. Never mint a new base for a new candidate; a new
 * ROUND (different games/pairings) may take a new one via TUNE_SEED_BASE.
 *
 * 900,000 sits clear of both mission seed spaces (arms at 20,000+, grid at
 * 232,000 + variant*1e6 up to ~7.5M is the only overlap risk and it is a
 * different campaign set anyway), so a seed read off a job is unambiguous
 * about which family it came from.
 */
export const TUNE_BASE_SEED = 900_000n;

/**
 * Seed stride per pairing slot — PINNED, not derived from TUNE_GAMES.
 *
 * Same lesson as the mission plan's `seedGames`: if the stride tracked this
 * round's game count, a round 2 at 200 games/pairing would stride by 200 while
 * round 1 strode by 40, and the two rounds' repetition 0..39 would land on
 * different seeds — the paired comparison across rounds would be lost silently.
 * A fixed 1,000 keeps every round seed-matched up to 1,000 games per pairing;
 * beyond that the plan throws rather than aliasing slot p's tail onto slot p+1.
 */
export const TUNE_SEED_STRIDE = 1_000;

/** Round 1 opponent pool: the four `tier: 'reflavored'` decks (engine content.ts). */
export const DEFAULT_OPPONENTS = 'king-taranis,thetis,piper-of-the-underroads,hollow-oak';

/**
 * Round-1 candidates. `doppelganger` is the as-designed E0; `doppelganger-cand-c`
 * is probe C (engine #320). The third slot (`doppelganger-cand-d`) is Dean's
 * call on values and is NOT defaulted on purpose — seeding a campaign for a deck
 * id the engine registry does not know would terminally-fail every one of its
 * jobs. Add it via TUNE_CANDIDATES once it is registered.
 */
export const DEFAULT_CANDIDATES = 'doppelganger,doppelganger-cand-c';

/**
 * Expert-tier ISMCTS, both seats. 3,000 iterations on a 600 s clock is the
 * configuration every committed expert artifact was measured at (engine
 * `SIM_PRESET_OVERRIDES.expert` = simCap 3,000; the ladder arms all pass
 * `600s`), so a rate measured here is comparable with them. The clock is a
 * backstop — strength is iteration-bound (#271).
 *
 * Recorded VERBATIM in `sim_campaigns.spec` (both as the seat `pilots` pool and
 * under `x-deck-tuning.bot`) because engine#247's structured bot metadata has
 * not landed: the string is the only durable record of what ran.
 */
export const DEFAULT_BOT = 'bot:expert(3000,600s)';

/** All cross-pairings of the pool, no mirrors — `i < j`, pool order preserved. */
export function calibrationPairs(opponents: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < opponents.length; i++) {
    for (let j = i + 1; j < opponents.length; j++) out.push([opponents[i]!, opponents[j]!]);
  }
  return out;
}

/**
 * The seed slots a CANDIDATE campaign runs: one per opponent, then the mirror.
 * Identical for every candidate — that is the seed-sharing contract.
 */
export function candidateSlots(opponents: readonly string[]): PairingSlot[] {
  const slots: PairingSlot[] = opponents.map((o, i) => ({ slot: i, label: o, kind: 'opponent' }));
  slots.push({ slot: opponents.length, label: 'mirror', kind: 'mirror' });
  return slots;
}

/**
 * The seed slots the CALIBRATION campaign runs. They start after the candidate
 * slots so the two campaign kinds never share a seed: a seed collision would be
 * harmless to the fleet but makes "same seed → same game" false when reading
 * results by hand.
 */
export function calibrationSlots(opponents: readonly string[]): PairingSlot[] {
  const base = opponents.length + 1;
  return calibrationPairs(opponents).map(([a, b], k) => ({
    slot: base + k, label: `${a} vs ${b}`, kind: 'calibration', decks: [a, b] as [string, string],
  }));
}

export function createDeckTuningPlan(env: NodeJS.ProcessEnv = process.env): DeckTuningPlan {
  const candidates = list(env.TUNE_CANDIDATES, DEFAULT_CANDIDATES);
  const opponents = list(env.TUNE_OPPONENTS, DEFAULT_OPPONENTS);
  const games = num(env.TUNE_GAMES, 40);
  const seedBase = BigInt(env.TUNE_SEED_BASE && env.TUNE_SEED_BASE.trim() !== '' ? env.TUNE_SEED_BASE : TUNE_BASE_SEED);
  const stride = num(env.TUNE_SEED_STRIDE, TUNE_SEED_STRIDE);
  const bot = env.TUNE_BOT && env.TUNE_BOT.trim() !== '' ? env.TUNE_BOT.trim() : DEFAULT_BOT;
  const map = env.TUNE_MAP ?? 'mended-drum';
  const prefix = env.TUNE_PREFIX && env.TUNE_PREFIX.trim() !== '' ? env.TUNE_PREFIX.trim() : 'dopp-tune-r1';
  const calibration = env.TUNE_CALIBRATION === '1';
  /**
   * Negative on purpose. `claimJobs` serves MIN(priority_tier) among ACTIVE
   * campaigns with pending jobs, and the mission arms sit at tiers 0/1/2 while
   * still `active` — several of them are effectively dormant (nobody is running
   * that fleet) but a dormant ACTIVE campaign with pending jobs still wins the
   * MIN, so a tuning campaign at tier 3 would never be claimed at all. -1 puts
   * this family strictly ahead of the whole mission without pausing anything.
   */
  const tier = num(env.TUNE_TIER, -1);

  if (candidates.length === 0) throw new Error('TUNE_CANDIDATES is empty');
  if (opponents.length === 0) throw new Error('TUNE_OPPONENTS is empty');
  if (new Set(candidates).size !== candidates.length) throw new Error(`TUNE_CANDIDATES has duplicates: ${candidates.join(',')}`);
  if (new Set(opponents).size !== opponents.length) throw new Error(`TUNE_OPPONENTS has duplicates: ${opponents.join(',')}`);
  if (!Number.isInteger(games) || games < 1) throw new Error(`TUNE_GAMES must be a positive integer, got ${String(env.TUNE_GAMES)}`);
  // A stride shorter than the repetition count aliases slot p's tail onto slot
  // p+1's head — duplicate seeds inside one campaign. Fail loudly.
  if (games > stride) throw new Error(`TUNE_GAMES=${games} needs a seed stride ≥ ${games}, got ${stride}`);

  const duel = (deckA: string, deckB: string, step: string, pairing: string): Record<string, unknown> => ({
    // `format` is REQUIRED by Emyrk's worker (scripts/sim-game.ts ExactGameSpec);
    // without it the job terminally-fails with `Unsupported format "undefined"`.
    format: 'duel',
    map,
    teams: [
      { seats: [{ deck: deckA, pilot: bot }] },
      { seats: [{ deck: deckB, pilot: bot }] },
    ],
    step,
    pairing,
  });

  /**
   * Seat order for repetition `i`. Alternating on the REPETITION index (not on
   * the global game_index) is deliberate: with pairings interleaved, game_index
   * is `i*|slots| + slot`, so `game_index % 2` degenerates to `slot % 2` when
   * |slots| is even — every pairing would then be locked to one seat for the
   * whole campaign and first-player advantage would ride entirely on the
   * matchup. Alternating on `i` gives every pairing an exact 50/50 seat split
   * whenever TUNE_GAMES is even, and is still a function of (slot, i) only, so
   * the seed-sharing contract holds.
   */
  const orient = (i: number, a: string, b: string): [string, string] => (i % 2 === 0 ? [a, b] : [b, a]);

  /**
   * Jobs for one campaign. Pairings INTERLEAVE by game_index (i outer, slot
   * inner) for the same reason the mission arms do: `claimJobs` ranks by
   * game_index, so a pairing-blocked order would make the first ~TUNE_GAMES
   * completed games all one matchup and every interim win rate a lie. The seed
   * of (slot, i) is unaffected by the interleave.
   */
  const jobsFor = (slots: PairingSlot[], step: string, decksFor: (s: PairingSlot) => [string, string]): JobRow[] => {
    const jobs: JobRow[] = [];
    let gi = 0;
    for (let i = 0; i < games; i++) {
      for (const s of slots) {
        const [a, b] = decksFor(s);
        const [deckA, deckB] = orient(i, a, b);
        jobs.push({
          gameIndex: gi,
          seed: seedBase + BigInt(s.slot * stride + i),
          spec: duel(deckA, deckB, step, s.label),
        });
        gi++;
      }
    }
    return jobs;
  };

  /**
   * Campaign-level spec in Emyrk's POOL shape (his admin UI renders
   * `campaign.spec` as format/maps/teams whose seats carry `decks`/`pilots`
   * pools — the sets a seat may draw from, not one fixed matchup). Both seats
   * carry the whole pool because seats alternate per repetition. The exact
   * per-game matchup lives in the job override spec. Our own bookkeeping goes
   * under the `x-deck-tuning` extension key so nothing is lost.
   */
  const campaignSpec = (decks: string[], x: Record<string, unknown>): Record<string, unknown> => ({
    format: 'duel',
    maps: [map],
    teams: [
      { seats: [{ decks, pilots: [bot] }] },
      { seats: [{ decks, pilots: [bot] }] },
    ],
    'x-deck-tuning': { round: prefix, bot, gamesPerPairing: games, seedBase: seedBase.toString(), seedStride: stride, ...x },
  });

  const slots = candidateSlots(opponents);
  const steps: PlanStep[] = candidates.map((candidate) => {
    const name = `${prefix}-${candidate}`;
    return {
      name,
      priorityTier: tier,
      baseSeed: seedBase,
      description: `deck tuning ${prefix} — candidate ${candidate} vs ${opponents.length}-deck pool + mirror @ ${bot}`,
      createdBy: 'seed-deck-tuning-campaign',
      jobs: jobsFor(slots, name, (s) => (s.kind === 'mirror' ? [candidate, candidate] : [candidate, s.label])),
      spec: campaignSpec([candidate, ...opponents], {
        kind: 'candidate', candidate, opponents,
        pairings: slots.map((s) => ({ slot: s.slot, label: s.label, kind: s.kind })),
      }),
    };
  });

  /**
   * The pool's own win-rate spread at this bot tier. Nothing above `mc` has a
   * committed baseline, so without it a candidate's 55% against the pool cannot
   * be told apart from the pool being 55%-able at expert. Off by default — it is
   * 6 pairings of pure context and the candidates are the point.
   */
  if (calibration) {
    // A one-deck pool has no cross-pairings; seeding the empty campaign would
    // create a 0-game row the completion sweep instantly marks `completed`.
    if (opponents.length < 2) throw new Error(`TUNE_CALIBRATION=1 needs at least 2 opponents, got ${opponents.length}`);
    const calSlots = calibrationSlots(opponents);
    const name = `${prefix}-calib`;
    steps.push({
      name,
      priorityTier: tier,
      baseSeed: seedBase,
      description: `deck tuning ${prefix} — opponent-pool calibration (${calSlots.length} cross-pairings) @ ${bot}`,
      createdBy: 'seed-deck-tuning-campaign',
      jobs: jobsFor(calSlots, name, (s) => s.decks!),
      spec: campaignSpec([...opponents], {
        kind: 'calibration', opponents,
        pairings: calSlots.map((s) => ({ slot: s.slot, label: s.label, kind: s.kind })),
      }),
    });
  }

  return {
    steps,
    dials: {
      TUNE_CANDIDATES: candidates.join(','),
      TUNE_OPPONENTS: opponents.join(','),
      TUNE_GAMES: games,
      TUNE_SEED_BASE: seedBase.toString(),
      TUNE_SEED_STRIDE: stride,
      TUNE_BOT: bot,
      TUNE_MAP: map,
      TUNE_PREFIX: prefix,
      TUNE_TIER: tier,
      TUNE_CALIBRATION: calibration ? 1 : 0,
    },
  };
}
