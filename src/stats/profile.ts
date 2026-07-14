import type { CardContextBucket, DeckProfile } from '../types.js';

export type CardBucketCounts = Partial<Record<CardContextBucket, number>>;

/**
 * Turn raw card-context play counts into a normalized deck profile.
 * Shares are fractions of total plays. `lean` compares attack vs defense
 * share and mirrors the "Offensive / Defensive / Balanced" label from the mock.
 */
export function buildDeckProfile(counts: CardBucketCounts): DeckProfile | null {
  const attack = counts.attack ?? 0;
  const defense = counts.defense ?? 0;
  const scheme = counts.scheme ?? 0;
  const boost = counts.boost ?? 0;
  const other = (counts.discard ?? 0) + (counts.other ?? 0);
  const plays = attack + defense + scheme + boost + other;
  if (plays === 0) return null;

  const attackShare = attack / plays;
  const defenseShare = defense / plays;
  const diff = attackShare - defenseShare;
  const lean = diff > 0.1 ? 'Offensive' : diff < -0.1 ? 'Defensive' : 'Balanced';

  return {
    plays,
    attack: attackShare,
    defense: defenseShare,
    scheme: scheme / plays,
    boost: boost / plays,
    other: other / plays,
    lean,
  };
}
