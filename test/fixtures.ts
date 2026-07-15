import type { GameSubmission } from '../src/types.js';

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
