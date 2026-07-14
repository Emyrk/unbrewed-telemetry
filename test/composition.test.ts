import { describe, expect, it } from 'vitest';
import { countCards, leanFrom, buildComposition } from '../src/stats/composition.js';
import type { DeckDefinitionCard } from '../src/types.js';

const cards: DeckDefinitionCard[] = [
  { type: 'attack', value: 8, quantity: 2 },
  { type: 'attack', value: 3, quantity: 4 },
  { type: 'defense', value: 2, quantity: 3 },
  { type: 'versatile', value: 3, quantity: 5 },
  { type: 'scheme', value: null, quantity: 2 },
];

describe('countCards', () => {
  it('sums per-type counts and Σ values weighted by quantity', () => {
    const c = countCards(cards);
    expect(c.cardCount).toBe(16);
    expect(c.attack).toBe(6);
    expect(c.defense).toBe(3);
    expect(c.versatile).toBe(5);
    expect(c.scheme).toBe(2);
    expect(c.attackValue).toBe(8 * 2 + 3 * 4); // 28
    expect(c.defenseValue).toBe(2 * 3); // 6
  });
});

describe('leanFrom', () => {
  it('labels by offense-vs-defense value gap', () => {
    expect(leanFrom(40, 20)).toBe('Offensive');
    expect(leanFrom(20, 40)).toBe('Defensive');
    expect(leanFrom(34, 30)).toBe('Balanced');
  });
});

describe('buildComposition', () => {
  it('carries counts and derives lean', () => {
    const counts = countCards(cards);
    const composition = buildComposition({ version: '1.0.0', name: 'Test', tier: 'community', counts });
    expect(composition).toMatchObject({ version: '1.0.0', name: 'Test', cardCount: 16, lean: 'Offensive' });
  });
});
