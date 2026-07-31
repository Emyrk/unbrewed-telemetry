import { createHash } from 'node:crypto';
import type { GameSubmission } from '../src/types.js';

export interface CanonicalRulesOverrides {
  heroHealth?: number;
  sidekickHealth?: number;
  attackValue?: number;
  attackQuantity?: number;
  /** Stands in for an effect program: an ordered list, so a reorder is a change. */
  attackEffect?: unknown[];
}

/**
 * A canonical deck rules string in the engine's `fp1` framing:
 * `fp1|hero=<json>|cards=[<json>,...]`, every object's keys in sorted order and
 * the card list sorted as a multiset of canonicalized strings.
 *
 * Hand-built rather than imported from the engine on purpose: telemetry must
 * never depend on the canonicalizer: it hashes the bytes it is handed. This
 * fixture exists to produce realistic bytes, not to define them.
 */
export function sampleCanonicalRules(overrides: CanonicalRulesOverrides = {}): string {
  const hero = {
    health: overrides.heroHealth ?? 18,
    id: 'king-kong',
    sidekick: { health: overrides.sidekickHealth ?? 8, id: 'king-kong-sidekick' },
    startingSpace: 'kk-1',
  };
  const cards = [
    {
      boost: 2,
      effects: overrides.attackEffect ?? [{ op: 'damage', value: 2 }],
      id: 'king-kong/a',
      quantity: overrides.attackQuantity ?? 12,
      title: 'Crushing Blow',
      type: 'attack',
      value: overrides.attackValue ?? 5,
    },
    { boost: 2, id: 'king-kong/d', quantity: 6, title: 'Iron Guard', type: 'defense', value: 2 },
    { boost: 2, id: 'king-kong/v', quantity: 8, title: 'Skull Island', type: 'versatile', value: 3 },
    { boost: 2, id: 'king-kong/s', quantity: 4, title: 'Cruel Bargain', type: 'scheme', value: null },
  ];
  const cardJson = cards.map((card) => JSON.stringify(card)).sort();
  return `fp1|hero=${JSON.stringify(hero)}|cards=[${cardJson.join(',')}]`;
}

/**
 * The fingerprint the engine would stamp on `canonical`: 12 hex of its SHA-256.
 * Computed with node:crypto so tests never lean on the code under test.
 */
export function fingerprintFor(canonical: string, algorithm = 'fp1'): string {
  return `${algorithm}-${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)}`;
}

export function sampleBotExecution() {
  return {
    budget: { msPerMove: 2000, iterationCap: 64 },
    search: {
      decisions: 42,
      completedIterations: { mean: 61.5, p50: 64, p95: 64 },
      elapsedMs: { count: 42, mean: 125.5, p50: 110, p90: 190, max: 240 },
      clockTruncatedDecisions: 3,
      earlyStoppedDecisions: 0,
    },
  };
}

export function sampleGame(overrides: Partial<GameSubmission> = {}): GameSubmission {
  return {
    schemaVersion: 1,
    gameId: 'test-game-001',
    submittedAt: '2026-07-14T16:00:00.000Z',
    endedAt: '2026-07-14T16:12:00.000Z',
    source: 'test',
    format: 'duel',
    formatLabel: '1v1',
    map: 'mended-drum',
    teams: [
      {
        seats: [
          {
            deck: 'king-kong@0.1.0',
            pilot: 'bot:hard',
            runtimePlayerId: 'p1',
            heroId: 'king-kong',
            botDifficulty: 'hard',
            finalHealth: 7,
          },
        ],
      },
      {
        seats: [
          {
            deck: 'the-mandalorian@0.1.0',
            pilot: 'bot:hard',
            runtimePlayerId: 'p2',
            heroId: 'the-mandalorian',
            botDifficulty: 'hard',
            finalHealth: 0,
          },
        ],
      },
    ],
    winner: 0,
    endCondition: 'hero_defeated',
    turns: 13,
    durationSeconds: 720,
    firstPlayerTeam: 0,
    engine: { schemaVersion: 3, dslVersion: '0.18.0', protocolVersion: 12, contentVersion: 'test' },
    stateHash: 'test-state-hash-001',
    telemetry: {
      startingHands: [
        { seat: [0, 0], cards: ['crushing-blow', 'iron-guard', 'cruel-bargain', 'giant-slam', 'skull-island'] },
        { seat: [1, 0], cards: ['sidestep', 'sudden-lunge', 'whistling-birds', 'jetpack', 'beskar-armor'] },
      ],
      cardsPlayed: [
        { seat: [0, 0], card: 'crushing-blow', turn: 2, context: 'attack' },
        { seat: [0, 0], card: 'crushing-blow', turn: 5, context: 'attack' },
        { seat: [0, 0], card: 'iron-guard', turn: 3, context: 'defense' },
        { seat: [0, 0], card: 'cruel-bargain', turn: 6, context: 'scheme' },
        { seat: [1, 0], card: 'sidestep', turn: 2, context: 'defense' },
        { seat: [1, 0], card: 'sudden-lunge', turn: 4, context: 'attack' },
      ],
    },
    ...overrides,
  };
}
