import type { DeckComposition, DeckDefinitionCard } from '../types.js';

export interface CompositionCounts {
  cardCount: number;
  attack: number;
  defense: number;
  versatile: number;
  scheme: number;
  attackValue: number;
  defenseValue: number;
}

/** Sum a deck's card list into per-type counts and Σ printed values. */
export function countCards(cards: DeckDefinitionCard[]): CompositionCounts {
  const counts: CompositionCounts = {
    cardCount: 0,
    attack: 0,
    defense: 0,
    versatile: 0,
    scheme: 0,
    attackValue: 0,
    defenseValue: 0,
  };
  for (const card of cards) {
    const qty = card.quantity ?? 1;
    const value = (card.value ?? 0) * qty;
    counts.cardCount += qty;
    if (card.type === 'attack') { counts.attack += qty; counts.attackValue += value; }
    else if (card.type === 'defense') { counts.defense += qty; counts.defenseValue += value; }
    else if (card.type === 'versatile') { counts.versatile += qty; }
    else if (card.type === 'scheme') { counts.scheme += qty; }
  }
  return counts;
}

/** Offense/defense lean from Σ values — mirrors the design mock's threshold. */
export function leanFrom(attackValue: number, defenseValue: number): DeckComposition['lean'] {
  const diff = attackValue - defenseValue;
  if (diff > 8) return 'Offensive';
  if (diff < -8) return 'Defensive';
  return 'Balanced';
}

export function buildComposition(
  card: { version: string; name: string | null; tier: string | null; counts: CompositionCounts },
): DeckComposition {
  const { counts } = card;
  return {
    version: card.version,
    name: card.name,
    tier: card.tier,
    cardCount: counts.cardCount,
    attack: counts.attack,
    defense: counts.defense,
    versatile: counts.versatile,
    scheme: counts.scheme,
    attackValue: counts.attackValue,
    defenseValue: counts.defenseValue,
    lean: counts.cardCount > 0 ? leanFrom(counts.attackValue, counts.defenseValue) : null,
  };
}
