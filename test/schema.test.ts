import { describe, expect, it } from 'vitest';
import { validateGameSubmission } from '../src/ingest/schema.js';
import { validateDeckDefinitions } from '../src/ingest/deck-schema.js';
import { normalizeSubmission } from '../src/ingest/normalize.js';
import { wilson } from '../src/stats/wilson.js';
import { sampleBotExecution, sampleGame } from './fixtures.js';

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

  it('accepts and normalizes structured bot execution metadata', () => {
    const game = sampleGame();
    game.teams[0]!.seats[0]!.botVersion = 'mc-v1';
    game.teams[0]!.seats[0]!.botExecution = sampleBotExecution();

    expect(validateGameSubmission(game)).toEqual({ ok: true, errors: [] });
    expect(normalizeSubmission(game, 'idem-1').seats[0]).toMatchObject({
      pilot: 'bot:hard',
      botVersion: 'mc-v1',
      botExecution: sampleBotExecution(),
    });
  });

  it('keeps elapsed bot timing optional for existing producers', () => {
    const game = sampleGame();
    const execution = sampleBotExecution();
    const { elapsedMs: _elapsedMs, ...search } = execution.search;
    game.teams[0]!.seats[0]!.botExecution = { ...execution, search };

    expect(validateGameSubmission(game)).toEqual({ ok: true, errors: [] });
  });

  it('rejects inconsistent elapsed bot timing summaries', () => {
    const game = sampleGame();
    const execution = sampleBotExecution();
    execution.search.elapsedMs = { count: 43, mean: 250, p50: 200, p90: 190, max: 180 };
    game.teams[0]!.seats[0]!.botExecution = execution;

    const result = validateGameSubmission(game);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('count must not exceed total decisions');
    expect(result.errors.join('\n')).toContain('percentiles must satisfy p50 <= p90 <= max');
    expect(result.errors.join('\n')).toContain('mean must not exceed max');
  });

  it('rejects bot execution metadata on human seats', () => {
    const game = sampleGame();
    game.teams[0]!.seats[0]!.pilot = 'human';
    game.teams[0]!.seats[0]!.botExecution = sampleBotExecution();

    const result = validateGameSubmission(game);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('only bot pilots may report execution metadata');
  });

  it('rejects inconsistent bot execution summaries', () => {
    const game = sampleGame();
    game.teams[0]!.seats[0]!.botExecution = {
      budget: { msPerMove: 400, iterationCap: 64 },
      search: {
        decisions: 4,
        completedIterations: { mean: 65, p50: 64, p95: 63 },
        clockTruncatedDecisions: 3,
        earlyStoppedDecisions: 2,
      },
    };

    const result = validateGameSubmission(game);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('exceed total decisions');
    expect(result.errors.join('\n')).toContain('p50 must be less than or equal to p95');
    expect(result.errors.join('\n')).toContain('must not exceed budget.iterationCap');
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

describe('seat deck rules hash', () => {
  it('stays optional: a submission without it validates and normalizes to null', () => {
    const game = sampleGame();
    expect(validateGameSubmission(game)).toEqual({ ok: true, errors: [] });
    const normalized = normalizeSubmission(game, 'idem-1');
    expect(normalized.seats.map((seat) => seat.deckRulesHash)).toEqual([null, null]);
  });

  it('accepts and passes through a rules fingerprint per seat', () => {
    const game = sampleGame();
    game.teams[0]!.seats[0]!.deckRulesHash = 'fp1-9c3a17b40e21';

    expect(validateGameSubmission(game)).toEqual({ ok: true, errors: [] });
    const normalized = normalizeSubmission(game, 'idem-1');
    expect(normalized.seats[0]).toMatchObject({ deckId: 'king-kong', deckRulesHash: 'fp1-9c3a17b40e21' });
    // Sibling seats are untouched by one seat reporting a hash.
    expect(normalized.seats[1]!.deckRulesHash).toBeNull();
  });

  it('accepts a future algorithm-version prefix without a schema change', () => {
    const game = sampleGame();
    game.teams[0]!.seats[0]!.deckRulesHash = 'fp2-0123456789abcdef0123';
    expect(validateGameSubmission(game)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ['wrong prefix', 'sha256-9c3a17b40e21'],
    ['no version in prefix', 'fp-9c3a17b40e21'],
    ['non-hex digest', 'fp1-zzzzzzzzzzzz'],
    ['uppercase digest', 'fp1-9C3A17B40E21'],
    ['digest too short', 'fp1-9c3a17b'],
    ['digest too long', `fp1-${'a'.repeat(65)}`],
    ['empty', ''],
  ])('rejects a malformed fingerprint (%s)', (_label, value) => {
    const game = sampleGame();
    game.teams[0]!.seats[0]!.deckRulesHash = value;

    const result = validateGameSubmission(game);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('/teams/0/seats/0/deckRulesHash');
  });
});

describe('deck definition rules hash', () => {
  it('stays optional: a batch without it still validates', () => {
    expect(validateDeckDefinitions(deckBatch())).toEqual({ ok: true, errors: [] });
  });

  it('accepts a rules fingerprint, including a future algorithm version', () => {
    expect(validateDeckDefinitions(deckBatch('fp1-9c3a17b40e21'))).toEqual({ ok: true, errors: [] });
    expect(validateDeckDefinitions(deckBatch('fp2-0123456789abcdef'))).toEqual({ ok: true, errors: [] });
  });

  it('rejects a malformed rules fingerprint', () => {
    const result = validateDeckDefinitions(deckBatch('nope-123'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('/decks/0/rulesHash');
  });
});

function deckBatch(rulesHash?: string): unknown {
  return {
    schemaVersion: 1,
    source: 'test',
    decks: [{
      deckId: 'king-kong',
      version: '0.1.0',
      ...(rulesHash === undefined ? {} : { rulesHash }),
      cards: [{ type: 'attack', value: 5, quantity: 12 }],
    }],
  };
}

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
