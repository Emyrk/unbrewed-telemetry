/**
 * The deck-tuning campaign PLAN (#49) — pure, no database.
 *
 * The property this campaign's statistics rest on is SEED SHARING: candidate
 * campaigns must be seed-matched game-for-game, so candidate-vs-candidate is a
 * paired comparison (common random numbers) rather than two independent 200-game
 * samples. At round-1 scale (40 games per pairing) that is most of the resolving
 * power, and a drift would degrade the numbers without failing anything else —
 * so it is pinned here rather than left to review.
 */

import { describe, expect, it } from 'vitest';
import {
  createDeckTuningPlan, calibrationPairs, candidateSlots, calibrationSlots,
  TUNE_BASE_SEED, TUNE_SEED_STRIDE, DEFAULT_BOT, DEFAULT_OPPONENTS, DEFAULT_CANDIDATES,
} from '../scripts/lib/deck-tuning-plan.mjs';
import type { PlanStep } from '../scripts/lib/deck-tuning-plan.mjs';

const OPPONENTS = DEFAULT_OPPONENTS.split(',');
const plan = (env: NodeJS.ProcessEnv = {}) => createDeckTuningPlan(env);
const step = (name: string, env: NodeJS.ProcessEnv = {}): PlanStep => {
  const s = plan(env).steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step ${name}`);
  return s;
};
const decksOf = (spec: Record<string, unknown>): string[] =>
  (spec.teams as Array<{ seats: Array<{ deck: string }> }>).map((t) => t.seats[0]!.deck);
const pilotsOf = (spec: Record<string, unknown>): string[] =>
  (spec.teams as Array<{ seats: Array<{ pilot: string }> }>).map((t) => t.seats[0]!.pilot);

describe('deck-tuning plan — shape', () => {
  it('creates one campaign per candidate, named <prefix>-<candidate>, no calibration by default', () => {
    const steps = plan().steps;
    expect(steps.map((s) => s.name)).toEqual([
      'dopp-tune-r1-doppelganger',
      'dopp-tune-r1-doppelganger-cand-c',
    ]);
    expect(DEFAULT_CANDIDATES.split(',')).toHaveLength(2);
  });

  it('runs opponents × TUNE_GAMES plus one mirror pairing per candidate', () => {
    for (const s of plan().steps) {
      // 4 opponents + 1 mirror, 40 games each.
      expect(s.jobs).toHaveLength((OPPONENTS.length + 1) * 40);
    }
    // The mirror is candidate-vs-candidate, and there are exactly TUNE_GAMES of them.
    const jobs = step('dopp-tune-r1-doppelganger').jobs;
    const mirror = jobs.filter((j) => j.spec.pairing === 'mirror');
    expect(mirror).toHaveLength(40);
    for (const j of mirror) expect(decksOf(j.spec)).toEqual(['doppelganger', 'doppelganger']);
    // …and every non-mirror game is the candidate against exactly one pool deck.
    for (const j of jobs.filter((x) => x.spec.pairing !== 'mirror')) {
      const decks = decksOf(j.spec);
      expect(decks).toContain('doppelganger');
      expect(OPPONENTS).toContain(decks.find((d) => d !== 'doppelganger'));
    }
  });

  it('pilots BOTH seats with the expert-tier ISMCTS spec, recorded verbatim on the campaign', () => {
    const s = step('dopp-tune-r1-doppelganger');
    expect(DEFAULT_BOT).toBe('bot:expert(3000,600s)');
    for (const j of s.jobs) expect(pilotsOf(j.spec)).toEqual([DEFAULT_BOT, DEFAULT_BOT]);
    // engine#247 (structured bot metadata) has not landed, so the string in the
    // campaign spec is the only durable record of what ran.
    const x = s.spec['x-deck-tuning'] as Record<string, unknown>;
    expect(x.bot).toBe(DEFAULT_BOT);
    const seats = (s.spec.teams as Array<{ seats: Array<{ pilots: string[]; decks: string[] }> }>);
    expect(seats.map((t) => t.seats[0]!.pilots)).toEqual([[DEFAULT_BOT], [DEFAULT_BOT]]);
    // Pool shape (Emyrk's admin UI): both seats carry the whole pool, because
    // seats alternate per repetition.
    for (const t of seats) expect(t.seats[0]!.decks).toEqual(['doppelganger', ...OPPONENTS]);
  });

  it('emits specs in the dialect the engine spec-bridge resolves', () => {
    // controlPlaneGame.ts reads a top-level map + teams[].seats[].{deck,pilot};
    // Emyrk's worker additionally requires a top-level `format`.
    for (const s of plan({ TUNE_CALIBRATION: '1' }).steps) {
      for (const j of s.jobs) {
        expect(j.spec.format).toBe('duel');
        expect(j.spec.map).toBe('mended-drum');
        const teams = j.spec.teams as Array<{ seats: Array<{ deck: string; pilot: string }> }>;
        expect(teams).toHaveLength(2);
        for (const t of teams) {
          expect(t.seats).toHaveLength(1);
          expect(typeof t.seats[0]!.deck).toBe('string');
          // parseSimulationDifficulty: bot:<tier>(<sims>,<secs>s)
          expect(t.seats[0]!.pilot).toMatch(/^bot:(easy|medium|hard|expert)(\(\d+,\d+(\.\d+)?(ms|s)\))?$/);
        }
        expect(j.spec.step).toBe(s.name);
      }
    }
  });

  it('tiers the whole family ahead of the mission arms', () => {
    // claimJobs serves MIN(priority_tier) among ACTIVE campaigns that still have
    // pending jobs. The mission arms sit at 0/1/2 and stay `active` even when
    // nobody is running that fleet, so anything at tier ≥ 0 would be starved.
    for (const s of plan({ TUNE_CALIBRATION: '1' }).steps) expect(s.priorityTier).toBe(-1);
  });
});

describe('deck-tuning plan — seed sharing (the paired-comparison contract)', () => {
  it('gives every candidate campaign the identical seed at every game_index', () => {
    const steps = plan({ TUNE_CANDIDATES: 'cand-a,cand-b,cand-c' }).steps;
    expect(steps).toHaveLength(3);
    const [a, b, c] = steps as [PlanStep, PlanStep, PlanStep];
    expect(b.jobs.map((j) => j.seed)).toEqual(a.jobs.map((j) => j.seed));
    expect(c.jobs.map((j) => j.seed)).toEqual(a.jobs.map((j) => j.seed));
    // …and the same OPPONENT and seat side at that index, so it is a real pair
    // and not just a matching integer.
    for (const [i, job] of a.jobs.entries()) {
      expect(b.jobs[i]!.spec.pairing).toBe(job.spec.pairing);
      expect(decksOf(b.jobs[i]!.spec).map((d) => (d === 'cand-b' ? 'CAND' : d)))
        .toEqual(decksOf(job.spec).map((d) => (d === 'cand-a' ? 'CAND' : d)));
    }
  });

  it('is a function of (pairing slot, repetition) only — not of the candidate or the pool size', () => {
    const wide = plan({ TUNE_CANDIDATES: 'x', TUNE_GAMES: '3' }).steps[0]!;
    const seedAt = (slot: number, i: number) => TUNE_BASE_SEED + BigInt(slot * TUNE_SEED_STRIDE + i);
    for (const j of wide.jobs) {
      const slot = candidateSlots(OPPONENTS).find((s) => s.label === j.spec.pairing)!.slot;
      const i = Math.floor(j.gameIndex / (OPPONENTS.length + 1));
      expect(j.seed).toBe(seedAt(slot, i));
    }
    expect(wide.jobs[0]!.seed).toBe(900_000n);   // slot 0, repetition 0
    expect(wide.jobs[1]!.seed).toBe(901_000n);   // slot 1, repetition 0
    expect(wide.jobs[4]!.seed).toBe(904_000n);   // slot 4 (mirror), repetition 0
    expect(wide.jobs[5]!.seed).toBe(900_001n);   // slot 0, repetition 1
  });

  it('keeps round 1 seeds valid for a longer round 2 (pinned stride, not a derived one)', () => {
    // The stride is fixed at 1,000 rather than tracking TUNE_GAMES, so a bigger
    // round stays seed-matched with round 1 over the repetitions they share.
    const r1 = plan({ TUNE_CANDIDATES: 'x', TUNE_GAMES: '40' }).steps[0]!;
    const r2 = plan({ TUNE_CANDIDATES: 'x', TUNE_GAMES: '200' }).steps[0]!;
    const bySlotRep = (s: PlanStep) => new Map(s.jobs.map((j) => [`${String(j.spec.pairing)}#${Math.floor(j.gameIndex / 5)}`, j.seed]));
    const m2 = bySlotRep(r2);
    for (const [k, seed] of bySlotRep(r1)) expect(m2.get(k)).toBe(seed);
  });

  it('never issues a duplicate seed inside one campaign', () => {
    for (const s of plan({ TUNE_CALIBRATION: '1' }).steps) {
      const seeds = new Set(s.jobs.map((j) => j.seed.toString()));
      expect(seeds.size, `${s.name} has colliding seeds`).toBe(s.jobs.length);
    }
  });

  it('keeps the calibration seed space disjoint from the candidate one', () => {
    const steps = plan({ TUNE_CALIBRATION: '1' }).steps;
    const candSeeds = new Set(steps[0]!.jobs.map((j) => j.seed.toString()));
    const calib = steps.find((s) => s.name === 'dopp-tune-r1-calib')!;
    for (const j of calib.jobs) expect(candSeeds.has(j.seed.toString())).toBe(false);
  });

  it('rejects a games count that would outrun its seed stride', () => {
    // 1,500 games against a 1,000 stride would alias slot p's tail onto slot
    // p+1's head — duplicate seeds inside one campaign.
    expect(() => plan({ TUNE_GAMES: '1500' })).toThrow(/seed stride/);
  });
});

describe('deck-tuning plan — pairing interleave', () => {
  it('covers every pairing exactly once in the first round of game indexes', () => {
    const jobs = step('dopp-tune-r1-doppelganger').jobs;
    const first = jobs.slice(0, OPPONENTS.length + 1).map((j) => j.spec.pairing);
    expect(new Set(first).size).toBe(OPPONENTS.length + 1);
    expect(first).toEqual([...OPPONENTS, 'mirror']);
    // game_index is dense and ordered — that is what claimJobs ranks by, so the
    // interleave is what makes interim win rates sample all matchups.
    expect(jobs.map((j) => j.gameIndex)).toEqual(jobs.map((_, i) => i));
  });

  it('splits seats 50/50 within every pairing, not across pairings', () => {
    // Alternating on the REPETITION index rather than on game_index matters:
    // with an even pairing count, game_index % 2 collapses to slot % 2 and each
    // matchup would be locked to one seat for the whole campaign.
    const jobs = plan({ TUNE_CANDIDATES: 'x', TUNE_OPPONENTS: 'o1,o2,o3', TUNE_GAMES: '10' }).steps[0]!.jobs;
    const bySeat = new Map<string, number>();
    for (const j of jobs) {
      const key = String(j.spec.pairing);
      if (key === 'mirror') continue;   // x vs x has no side to balance
      bySeat.set(key, (bySeat.get(key) ?? 0) + (decksOf(j.spec)[0] === 'x' ? 1 : -1));
    }
    for (const [pairing, balance] of bySeat) expect(balance, `${pairing} is seat-biased`).toBe(0);
  });
});

describe('deck-tuning plan — calibration campaign', () => {
  it('is off unless TUNE_CALIBRATION=1', () => {
    expect(plan().steps.some((s) => s.name.endsWith('-calib'))).toBe(false);
    expect(plan({ TUNE_CALIBRATION: '1' }).steps.some((s) => s.name === 'dopp-tune-r1-calib')).toBe(true);
  });

  it('runs every cross-pairing of the pool and no mirrors', () => {
    const calib = step('dopp-tune-r1-calib', { TUNE_CALIBRATION: '1' });
    expect(calibrationPairs(OPPONENTS)).toHaveLength(6);   // C(4,2)
    expect(calib.jobs).toHaveLength(6 * 40);               // the runbook's 240 games

    const seen = new Set<string>();
    for (const j of calib.jobs) {
      const decks = decksOf(j.spec);
      expect(decks[0]).not.toBe(decks[1]);                 // no mirrors
      for (const d of decks) expect(OPPONENTS).toContain(d);  // pool only, no candidate
      seen.add([...decks].sort().join('|'));
    }
    expect(seen.size).toBe(6);
    expect(calibrationSlots(OPPONENTS).map((s) => s.label)).toEqual(
      calibrationPairs(OPPONENTS).map(([a, b]) => `${a} vs ${b}`),
    );
  });

  it('refuses a one-deck pool rather than seeding an empty campaign', () => {
    // No cross-pairings exist, and a 0-game campaign is marked `completed` by
    // the progress sweep the moment it is created.
    expect(() => plan({ TUNE_CALIBRATION: '1', TUNE_OPPONENTS: 'only-one' })).toThrow(/at least 2 opponents/);
  });

  it('uses the same bot spec as the candidate campaigns (that is what makes it a baseline)', () => {
    const calib = step('dopp-tune-r1-calib', { TUNE_CALIBRATION: '1' });
    for (const j of calib.jobs) expect(pilotsOf(j.spec)).toEqual([DEFAULT_BOT, DEFAULT_BOT]);
    expect((calib.spec['x-deck-tuning'] as { kind: string }).kind).toBe('calibration');
  });
});

describe('deck-tuning plan — determinism and validation', () => {
  it('produces byte-identical output for identical env', () => {
    const serialise = (p: { steps: PlanStep[] }) => JSON.stringify(p.steps, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const env = { TUNE_CALIBRATION: '1', TUNE_CANDIDATES: 'a,b', TUNE_GAMES: '7' };
    expect(serialise(plan(env))).toBe(serialise(plan(env)));
    // …and does not read process.env behind the caller's back.
    expect(serialise(plan({}))).toBe(serialise(plan({})));
  });

  it('echoes its dials, including the verbatim bot spec', () => {
    expect(plan().dials).toEqual({
      TUNE_CANDIDATES: DEFAULT_CANDIDATES,
      TUNE_OPPONENTS: DEFAULT_OPPONENTS,
      TUNE_GAMES: 40,
      TUNE_SEED_BASE: '900000',
      TUNE_SEED_STRIDE: 1000,
      TUNE_BOT: DEFAULT_BOT,
      TUNE_MAP: 'mended-drum',
      TUNE_PREFIX: 'dopp-tune-r1',
      TUNE_TIER: -1,
      TUNE_CALIBRATION: 0,
    });
  });

  it('rejects empty or duplicated deck lists rather than seeding a degenerate campaign', () => {
    expect(() => plan({ TUNE_CANDIDATES: ' , ' })).toThrow(/TUNE_CANDIDATES is empty/);
    expect(() => plan({ TUNE_OPPONENTS: ',' })).toThrow(/TUNE_OPPONENTS is empty/);
    expect(() => plan({ TUNE_CANDIDATES: 'a,a' })).toThrow(/duplicates/);
    expect(() => plan({ TUNE_OPPONENTS: 'a,b,a' })).toThrow(/duplicates/);
    expect(() => plan({ TUNE_GAMES: '0' })).toThrow(/positive integer/);
  });

  it('honours the prefix, map, bot and seed-base overrides', () => {
    const p = plan({ TUNE_PREFIX: 'dopp-tune-r2', TUNE_MAP: 'ravenloft', TUNE_BOT: 'bot:hard(64,600s)', TUNE_SEED_BASE: '5000', TUNE_CANDIDATES: 'z', TUNE_CALIBRATION: '1' });
    expect(p.steps.map((s) => s.name)).toEqual(['dopp-tune-r2-z', 'dopp-tune-r2-calib']);
    expect(p.steps[0]!.baseSeed).toBe(5000n);
    expect(p.steps[0]!.jobs[0]!.seed).toBe(5000n);
    expect(p.steps[0]!.jobs[0]!.spec.map).toBe('ravenloft');
    expect(pilotsOf(p.steps[0]!.jobs[0]!.spec)).toEqual(['bot:hard(64,600s)', 'bot:hard(64,600s)']);
  });

  it('labels its campaigns as deck-tuning rather than as mission arms', () => {
    for (const s of plan({ TUNE_CALIBRATION: '1' }).steps) {
      expect(s.createdBy).toBe('seed-deck-tuning-campaign');
      expect(s.description).toMatch(/^deck tuning dopp-tune-r1 —/);
    }
  });
});
