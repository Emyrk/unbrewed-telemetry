/**
 * The seeded campaign PLAN (#39) — pure, no database.
 *
 * These assertions are the guard rail on the one property the arm6 campaign
 * design depends on: arm6a/b/c must be SEED-MATCHED with arm1/arm2, i.e. the
 * same game_index carries the same seed AND the same deck pairing, so the
 * 128→256→512→1000→3000 strength curve is a paired comparison rather than five
 * independent samples. A drift here silently degrades the statistics without
 * failing anything else, so it is pinned here rather than left to review.
 */

import { describe, expect, it } from 'vitest';
import { createPlan, ARM_BASE_SEED, PAIRINGS } from '../scripts/lib/sim-campaign-plan.mjs';

const plan = () => createPlan({});
const step = (name: string) => {
  const s = plan().steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step ${name}`);
  return s;
};

describe('sim campaign plan — arm6 serveable-budget sweep', () => {
  it('adds arm6a/b/c at 500 games each, tiers 0/1/2, on the shared arm seed base', () => {
    const steps = plan().steps;
    const arm6 = steps.filter((s) => s.name.startsWith('arm6'));
    expect(arm6.map((s) => s.name)).toEqual(['arm6a', 'arm6b', 'arm6c']);

    for (const s of arm6) {
      expect(s.jobs).toHaveLength(500);
      // Every arm shares 20000 — that is what makes them seed-matched.
      expect(s.baseSeed).toBe(ARM_BASE_SEED);
      expect(s.baseSeed).toBe(step('arm1').baseSeed);
    }

    // Cheapest budget claims first: claimJobs serves MIN(priority_tier) among
    // ACTIVE campaigns, so ascending tiers keep arm6a ahead of the paused
    // Hard Duel Sweep at tier 1 even if that sweep is later unpaused.
    expect(arm6.map((s) => s.priorityTier)).toEqual([0, 1, 2]);
  });

  it('pilots each arm6 campaign as expert(iters) vs the shared hard-64 control', () => {
    const iters = [128, 256, 512];
    for (const [i, name] of ['arm6a', 'arm6b', 'arm6c'].entries()) {
      const s = step(name);
      const x = s.spec['x-ismcts'] as { kind: string; a: string; b: string };
      expect(x).toEqual({ kind: 'arm', a: `bot:expert(${iters[i]},600s)`, b: 'bot:hard(64,600s)' });
      // The 600s clock is deliberate and iteration-bound (see #271): strength is
      // measured per-iteration, cost is measured separately and IS hardware-specific.
      for (const job of s.jobs) {
        const pilots = (job.spec.teams as Array<{ seats: Array<{ pilot: string }> }>).map((t) => t.seats[0]!.pilot);
        expect(pilots).toContain(`bot:expert(${iters[i]},600s)`);
        expect(pilots).toContain('bot:hard(64,600s)');
      }
    }
  });

  /** The headline property: same game_index → same seed as the 1000-game arms. */
  it('is seed-matched with arm1 and arm2 at every shared game_index', () => {
    const a1 = step('arm1').jobs;
    const a2 = step('arm2').jobs;
    for (const name of ['arm6a', 'arm6b', 'arm6c']) {
      const a6 = step(name).jobs;
      expect(a6.length).toBeLessThanOrEqual(a1.length);
      for (const job of a6) {
        expect(a1[job.gameIndex]!.seed, `${name} seed drift at game_index ${job.gameIndex}`).toBe(job.seed);
        expect(a2[job.gameIndex]!.seed).toBe(job.seed);
      }
    }
  });

  it('matches arm1 on deck pairing and seat alternation, not just on the seed number', () => {
    const decksOf = (spec: Record<string, unknown>) =>
      (spec.teams as Array<{ seats: Array<{ deck: string }> }>).map((t) => t.seats[0]!.deck);
    const a1 = step('arm1').jobs;
    for (const job of step('arm6a').jobs) {
      expect(decksOf(job.spec)).toEqual(decksOf(a1[job.gameIndex]!.spec));
    }
  });

  /** Three concrete pairs, quoted in the PR description as the seed-match proof. */
  it('pins three sample game_index → seed pairs shared by arm1/arm2/arm6a', () => {
    const samples = [0, 1, 5];
    const expected = [20_000n, 20_250n, 20_251n];
    for (const [i, gi] of samples.entries()) {
      expect(step('arm6a').jobs[gi]!.seed).toBe(expected[i]);
      expect(step('arm1').jobs[gi]!.seed).toBe(expected[i]);
      expect(step('arm2').jobs[gi]!.seed).toBe(expected[i]);
    }
  });

  it('interleaves pairings by game_index so interim rates sample all four matchups', () => {
    const jobs = step('arm6a').jobs;
    // The first |PAIRINGS| games cover every matchup exactly once.
    const firstRound = jobs.slice(0, PAIRINGS.length).map((j) => {
      const decks = (j.spec.teams as Array<{ seats: Array<{ deck: string }> }>).map((t) => t.seats[0]!.deck);
      return [...decks].sort().join(' vs ');
    });
    expect(new Set(firstRound).size).toBe(PAIRINGS.length);
    // …and game_index is dense and ordered, which is what claimJobs ranks by.
    expect(jobs.map((j) => j.gameIndex)).toEqual(jobs.map((_, i) => i));
  });

  it('never issues a duplicate seed inside one campaign', () => {
    for (const s of plan().steps) {
      const seeds = new Set(s.jobs.map((j) => j.seed.toString()));
      expect(seeds.size, `${s.name} has colliding seeds`).toBe(s.jobs.length);
    }
  });

  it('rejects a games count that would outrun its seed stride', () => {
    // 2000 arm6 games against a 1000-game stride would alias pairing p's tail
    // onto pairing p+1's head. Fail loudly rather than seed colliding seeds.
    expect(() => createPlan({ ARM6_GAMES: '2000' })).toThrow(/seed stride/);
  });
});

describe('sim campaign plan — the pre-existing steps are untouched', () => {
  it('keeps the original six campaigns, their seeds and their game counts', () => {
    const steps = plan().steps;
    expect(steps.slice(0, 6).map((s) => s.name)).toEqual(['grid', 'arm1', 'arm2', 'arm3', 'arm5', 'mirror']);
    expect(step('arm1').jobs).toHaveLength(1000);
    expect(step('arm2').jobs).toHaveLength(1000);
    expect(step('arm3').jobs).toHaveLength(1000);
    expect(step('arm5').jobs).toHaveLength(1000);
    expect(step('mirror').jobs).toHaveLength(200);
    expect(step('grid').jobs).toHaveLength(3500);
  });

  /**
   * Regression pin for the refactor that introduced the explicit seed stride:
   * mirror runs 200 games, so its stride stays floor(200/4)=50 — NOT the arms'
   * 250. These seeds are already in the production database; if this changes,
   * the seed plan has drifted away from what was actually seeded.
   */
  it('keeps mirror on its own 50-game stride', () => {
    const m = step('mirror').jobs;
    expect(m[0]!.seed).toBe(20_000n); // p=0, i=0
    expect(m[1]!.seed).toBe(20_050n); // p=1, i=0
    expect(m[2]!.seed).toBe(20_100n); // p=2, i=0
    expect(m[4]!.seed).toBe(20_001n); // p=0, i=1
  });

  it('keeps the grid seed formula (variant-major, 100k pairing stride)', () => {
    const g = step('grid').jobs;
    expect(g[0]!.seed).toBe(232_000n);          // sims-64,  p=0, i=0
    expect(g[1]!.seed).toBe(332_000n);          // sims-64,  p=1, i=0
    expect(g[500]!.seed).toBe(1_232_000n);      // sims-128, p=0, i=0
  });

  it('leaves every original campaign at tier 0', () => {
    for (const name of ['grid', 'arm1', 'arm2', 'arm3', 'arm5', 'mirror']) {
      expect(step(name).priorityTier).toBe(0);
    }
  });
});
