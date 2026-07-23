/**
 * Wilson 95% score-interval math (#32 acceptance: deterministic CI tests).
 * Reference values cross-checked against the standard Wilson formula (z=1.96).
 */

import { describe, expect, it } from 'vitest';
import { wilson } from '../src/stats/wilson.js';

describe('wilson', () => {
  it('returns a degenerate zero interval for n=0', () => {
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 0 });
  });

  it('matches the textbook interval for 60 wins / 100 games', () => {
    const w = wilson(60, 100);
    expect(w.p).toBeCloseTo(0.6, 10);
    expect(w.lo).toBeCloseTo(0.5020, 3);
    expect(w.hi).toBeCloseTo(0.6906, 3);
  });

  it('stays inside [0,1] at the extremes and keeps a wide lower bound at tiny n', () => {
    const perfect = wilson(2, 2);
    expect(perfect.hi).toBeLessThanOrEqual(1);
    expect(perfect.lo).toBeCloseTo(0.3424, 3);
    const winless = wilson(0, 2);
    expect(winless.lo).toBe(0);
    expect(winless.hi).toBeCloseTo(0.6576, 3);
  });

  it('narrows monotonically with sample size at a fixed rate', () => {
    const widths = [10, 50, 100, 1000].map((n) => {
      const w = wilson(Math.round(n * 0.6), n);
      return w.hi - w.lo;
    });
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeLessThan(widths[i - 1]!);
  });

  it('excludes 50% exactly when the lead survives sampling noise (the gate check)', () => {
    expect(wilson(600, 1000).lo).toBeGreaterThan(0.5); // 60% over 1,000 games clears
    expect(wilson(30, 50).lo).toBeLessThan(0.5); // 60% over 50 games does not
  });
});
