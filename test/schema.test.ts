import { describe, expect, it } from 'vitest';
import { validateGameSubmission } from '../src/ingest/schema.js';
import { normalizeSubmission } from '../src/ingest/normalize.js';
import { wilson } from '../src/stats/wilson.js';
import { sampleGame } from './fixtures.js';

describe('game submission schema', () => {
  it('accepts a valid sample game', () => {
    const result = validateGameSubmission(sampleGame());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('rejects malformed or semantically impossible games', () => {
    const result = validateGameSubmission(sampleGame({ winner: 9 }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('/winner');
  });

  it('normalizes seats and deck versions', () => {
    const normalized = normalizeSubmission(sampleGame(), 'idem-1');
    expect(normalized.id).toBe('test-game-001');
    expect(normalized.seats[0]).toMatchObject({ deckId: 'king-kong', deckVersion: '0.1.0', pilotKind: 'bot', botId: 'hard', won: true });
    expect(normalized.seats[1]).toMatchObject({ deckId: 'the-mandalorian', won: false });
  });

  it('normalizes card-play telemetry into deck-attributed card rows', () => {
    const normalized = normalizeSubmission(sampleGame(), 'idem-1');
    expect(normalized.cards).toHaveLength(6);
    expect(normalized.cards[0]).toMatchObject({
      eventIndex: 0,
      deck: 'king-kong@0.1.0',
      deckId: 'king-kong',
      card: 'crushing-blow',
      contextBucket: 'attack',
      seatWon: true,
    });
    const loser = normalized.cards.find((card) => card.deckId === 'the-mandalorian');
    expect(loser).toMatchObject({ seatWon: false, contextBucket: 'defense' });
  });

  it('normalizes starting-hand telemetry into deck-attributed card rows', () => {
    const normalized = normalizeSubmission(sampleGame(), 'idem-1');
    expect(normalized.startingCards).toHaveLength(10);
    expect(normalized.startingCards[0]).toMatchObject({
      cardIndex: 0,
      deck: 'king-kong@0.1.0',
      deckId: 'king-kong',
      card: 'crushing-blow',
      seatWon: true,
    });
    const loser = normalized.startingCards.find((card) => card.deckId === 'the-mandalorian');
    expect(loser).toMatchObject({ seatWon: false });
  });

  it('drops card events for seats that do not exist', () => {
    const game = sampleGame();
    game.telemetry = { cardsPlayed: [{ seat: [5, 0], card: 'ghost', context: 'attack' }] };
    const normalized = normalizeSubmission(game, 'idem-1');
    expect(normalized.cards).toHaveLength(0);
  });
});

describe('wilson interval', () => {
  it('handles empty samples', () => {
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 0 });
  });

  it('centers on observed win rate', () => {
    const interval = wilson(60, 100);
    expect(interval.p).toBeCloseTo(0.6);
    expect(interval.lo).toBeGreaterThan(0.49);
    expect(interval.hi).toBeLessThan(0.7);
  });
});
