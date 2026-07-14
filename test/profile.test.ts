import { describe, expect, it } from 'vitest';
import { buildDeckProfile } from '../src/stats/profile.js';

describe('buildDeckProfile', () => {
  it('returns null with no plays', () => {
    expect(buildDeckProfile({})).toBeNull();
    expect(buildDeckProfile({ attack: 0, defense: 0 })).toBeNull();
  });

  it('computes shares that sum to one', () => {
    const profile = buildDeckProfile({ attack: 5, defense: 3, scheme: 1, boost: 1 });
    expect(profile).not.toBeNull();
    const { attack, defense, scheme, boost, other, plays } = profile!;
    expect(plays).toBe(10);
    expect(attack + defense + scheme + boost + other).toBeCloseTo(1);
    expect(attack).toBeCloseTo(0.5);
  });

  it('folds discard into the other bucket', () => {
    const profile = buildDeckProfile({ attack: 2, discard: 2 });
    expect(profile!.other).toBeCloseTo(0.5);
  });

  it('labels lean by attack-vs-defense gap', () => {
    expect(buildDeckProfile({ attack: 8, defense: 2 })!.lean).toBe('Offensive');
    expect(buildDeckProfile({ attack: 2, defense: 8 })!.lean).toBe('Defensive');
    expect(buildDeckProfile({ attack: 5, defense: 5 })!.lean).toBe('Balanced');
  });
});
