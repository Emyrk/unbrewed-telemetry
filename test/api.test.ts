import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { createApp } from '../src/http/app.js';
import { signBody } from '../src/http/auth.js';
import { sampleGame } from './fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('telemetry api with postgres', () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  const secret = 'test-secret';
  const now = new Date('2026-07-14T16:30:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    const repo = new PgTelemetryRepository(pool);
    server = createServer(createApp({
      repo,
      config: {
        telemetrySecret: secret,
        allowUnauthenticatedIngest: false,
        bodyLimitBytes: 1024 * 1024,
        now: () => now,
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE game_submissions, deck_definitions CASCADE');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it('serves healthz', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it('serves the dashboard shell and assets', async () => {
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('Deck Balance Tracker');

    const page = await fetch(`${baseUrl}/dashboard`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Deck Balance Tracker');

    const script = await fetch(`${baseUrl}/assets/dashboard.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
  });

  it('requires signatures for ingest', async () => {
    const response = await fetch(`${baseUrl}/v1/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleGame()),
    });
    expect(response.status).toBe(401);
  });

  it('ingests valid games idempotently and reports deck stats', async () => {
    const first = await postGame(baseUrl, secret, sampleGame({ gameId: 'api-game-001', stateHash: 'api-state-001' }), 'api-game-001');
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false, gameId: 'api-game-001' });

    const duplicate = await postGame(baseUrl, secret, sampleGame({ gameId: 'api-game-001', stateHash: 'api-state-001' }), 'api-game-001');
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true, gameId: 'api-game-001' });

    const startingRows = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM game_starting_cards WHERE game_id = $1', ['api-game-001']);
    expect(Number(startingRows.rows[0]?.count ?? 0)).toBe(10);

    const stats = await fetch(`${baseUrl}/v1/stats/decks?format=duel&pilots=bot:hard`);
    expect(stats.status).toBe(200);
    const json = await stats.json() as {
      totalGames: number;
      avgTurns: number;
      decks: { deck: string; games: number; wins: number; winRate: number }[];
    };
    expect(json.totalGames).toBe(1);
    expect(json.avgTurns).toBe(13);
    expect(json.decks).toHaveLength(2);
    expect(json.decks.find((deck) => deck.deck === 'king-kong@0.1.0')).toMatchObject({ games: 1, wins: 1, winRate: 1 });
    expect(json.decks.find((deck) => deck.deck === 'the-mandalorian@0.1.0')).toMatchObject({ games: 1, wins: 0, winRate: 0 });
  });

  it('supports MUST pilot filters', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'must-hard-001', stateHash: 'must-hard-state-001' }), 'must-hard-001');
    await postGame(baseUrl, secret, sampleGame({
      gameId: 'must-human-001',
      stateHash: 'must-human-state-001',
      teams: [
        {
          seats: [{
            deck: 'king-kong@0.1.0',
            pilot: 'human',
            runtimePlayerId: 'p1',
            heroId: 'king-kong',
            finalHealth: 7,
          }],
        },
        {
          seats: [{
            deck: 'the-mandalorian@0.1.0',
            pilot: 'bot:hard',
            runtimePlayerId: 'p2',
            heroId: 'the-mandalorian',
            botDifficulty: 'hard',
            finalHealth: 0,
          }],
        },
      ],
    }), 'must-human-001');

    const broad = await fetch(`${baseUrl}/v1/stats/decks?format=duel&pilots=human,bot:hard`);
    expect(broad.status).toBe(200);
    expect((await broad.json() as { totalGames: number }).totalGames).toBe(2);

    const mustHuman = await fetch(`${baseUrl}/v1/stats/decks?format=duel&pilots=human,bot:hard,must:human`);
    expect(mustHuman.status).toBe(200);
    const json = await mustHuman.json() as { totalGames: number; decks: { deck: string; games: number }[] };
    expect(json.totalGames).toBe(1);
    expect(json.decks.find((deck) => deck.deck === 'king-kong@0.1.0')).toMatchObject({ games: 1 });
  });

  it('returns dashboard aggregates for the UI', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'dash-game-001', stateHash: 'dash-state-001' }), 'dash-game-001');

    const response = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      totalSubmissions: number;
      formats: { format: string; games: number }[];
      decks: { deck: string; label: string; games: number; wins: number; profile: { attack: number; lean: string } | null }[];
      matchups: { rowDeck: string; colDeck: string; games: number; wins: number; avgWinTurns: number | null; avgLossTurns: number | null }[];
      firstPlayer: { games: number; wins: number; winRate: number };
    };
    expect(json.totalGames).toBe(1);
    expect(json.totalSubmissions).toBe(1);
    expect(json.formats).toContainEqual(expect.objectContaining({ format: 'duel', games: 1 }));
    const king = json.decks.find((deck) => deck.deck === 'king-kong@0.1.0');
    expect(king).toMatchObject({ label: 'king-kong', games: 1, wins: 1 });
    // king-kong played 2 attack / 1 defense / 1 scheme -> attack-leaning play mix.
    expect(king?.profile).toMatchObject({ attack: 0.5, lean: 'Offensive' });
    expect(json.matchups).toContainEqual(expect.objectContaining({ rowDeck: 'king-kong', rowDeckId: 'king-kong', colDeck: 'the-mandalorian', colDeckId: 'the-mandalorian', games: 1, wins: 1, avgTurns: 13, avgWinTurns: 13, avgLossTurns: null, avgFinalHealth: 7 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ rowDeck: 'the-mandalorian', rowDeckId: 'the-mandalorian', colDeck: 'king-kong', colDeckId: 'king-kong', games: 1, wins: 0, avgTurns: 13, avgWinTurns: null, avgLossTurns: 13 }));
    expect(json.firstPlayer).toMatchObject({ games: 1, wins: 1, winRate: 1 });
  });

  it('serves deck detail with card influence and matchups', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'detail-game-001', stateHash: 'detail-state-001' }), 'detail-game-001');

    const response = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      deck: string;
      games: number;
      winRate: number;
      profile: { lean: string } | null;
      avgFinalHealth: number | null;
      firstPlayer: { first: { games: number; wins: number; winRate: number | null }; second: { games: number; winRate: number | null } };
      formats: { format: string; winRate: number }[];
      matchups: { deck: string; games: number; winRate: number }[];
      cards: { card: string; contextBucket: string; influence: number; baselineWinRate: number }[];
      startingCards: { card: string; influence: number; baselineWinRate: number; gamesWith: number }[];
    };
    expect(json).toMatchObject({ deck: 'king-kong@0.1.0', games: 1, winRate: 1 });
    expect(json.profile?.lean).toBe('Offensive');
    // fixture: king-kong final health 7, went first (firstPlayerTeam 0) and won.
    expect(json.avgFinalHealth).toBe(7);
    expect(json.firstPlayer.first).toMatchObject({ games: 1, wins: 1, winRate: 1 });
    expect(json.firstPlayer.second).toMatchObject({ games: 0, winRate: null });
    expect(json.formats).toContainEqual(expect.objectContaining({ format: 'duel', winRate: 1 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ deck: 'the-mandalorian@0.1.0', games: 1, winRate: 1 }));
    const crushing = json.cards.find((card) => card.card === 'crushing-blow');
    expect(crushing).toMatchObject({ contextBucket: 'attack', baselineWinRate: 1, influence: 0 });
    const openingCrushing = json.startingCards.find((card) => card.card === 'crushing-blow');
    expect(openingCrushing).toMatchObject({ gamesWith: 1, baselineWinRate: 1, influence: 0 });
  });

  it('filters 1v1 deck detail by hero and opponent pilot assignments', async () => {
    const matchupGame = (
      gameId: string,
      heroPilot: string,
      opponentPilot: string,
      winner: number,
    ) => sampleGame({
      gameId,
      stateHash: `${gameId}-state`,
      teams: [
        {
          seats: [{
            deck: 'king-kong@0.1.0',
            pilot: heroPilot,
            runtimePlayerId: 'p1',
            heroId: 'king-kong',
            botDifficulty: 'hard',
            finalHealth: winner === 0 ? 7 : 0,
          }],
        },
        {
          seats: [{
            deck: 'the-mandalorian@0.1.0',
            pilot: opponentPilot,
            runtimePlayerId: 'p2',
            heroId: 'the-mandalorian',
            botDifficulty: 'hard',
            finalHealth: winner === 1 ? 7 : 0,
          }],
        },
      ],
      winner,
    });

    await postGame(baseUrl, secret, matchupGame('pilot-compare-001', 'bot:hard(64,2s)', 'bot:hard', 0), 'pilot-compare-001');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-002', 'bot:hard(64,2s)', 'bot:hard', 0), 'pilot-compare-002');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-003', 'bot:hard', 'bot:hard(64,2s)', 1), 'pilot-compare-003');
    await postGame(baseUrl, secret, matchupGame('pilot-compare-004', 'bot:hard', 'bot:hard', 0), 'pilot-compare-004');

    const selected = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&opponent=the-mandalorian@0.1.0&heroPilot=bot%3Ahard%2864%2C2s%29&opponentPilot=bot%3Ahard`);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ games: 2, wins: 2, winRate: 1 });

    const swapped = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&opponent=the-mandalorian@0.1.0&heroPilot=bot%3Ahard&opponentPilot=bot%3Ahard%2864%2C2s%29`);
    expect(swapped.status).toBe(200);
    expect(await swapped.json()).toMatchObject({ games: 1, wins: 0, winRate: 0 });

    const matchupMatrix = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=human&heroPilot=bot%3Ahard%2864%2C2s%29&opponentPilot=bot%3Ahard`);
    expect(matchupMatrix.status).toBe(200);
    const matchupJson = await matchupMatrix.json() as {
      matchups: { rowDeckId: string; colDeckId: string; games: number; wins: number }[];
    };
    expect(matchupJson.matchups).toContainEqual(expect.objectContaining({
      rowDeckId: 'king-kong',
      colDeckId: 'the-mandalorian',
      games: 2,
      wins: 2,
    }));
    expect(matchupJson.matchups).toContainEqual(expect.objectContaining({
      rowDeckId: 'the-mandalorian',
      colDeckId: 'king-kong',
      games: 1,
      wins: 1,
    }));

    const comparison = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=bot%3Ahard%2864%2C2s%29&pilotB=bot%3Ahard&opponentPilot=bot%3Ahard&opponent=the-mandalorian%400.1.0`);
    expect(comparison.status).toBe(200);
    const comparisonJson = await comparison.json() as {
      pilotA: string;
      pilotB: string;
      rows: {
        deckId: string;
        pilotA: { games: number; wins: number; winRate: number };
        pilotB: { games: number; wins: number; winRate: number };
        winRateDelta: number | null;
      }[];
    };
    expect(comparisonJson).toMatchObject({ pilotA: 'bot:hard(64,2s)', pilotB: 'bot:hard' });
    expect(comparisonJson.rows).toContainEqual(expect.objectContaining({
      deckId: 'king-kong',
      pilotA: expect.objectContaining({ games: 2, wins: 2, winRate: 1 }),
      pilotB: expect.objectContaining({ games: 1, wins: 1, winRate: 1 }),
      winRateDelta: 0,
    }));

    const heroComparison = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=bot%3Ahard%2864%2C2s%29&pilotB=bot%3Ahard&hero=king-kong%400.1.0&opponentPilot=bot%3Ahard&opponent=the-mandalorian%400.1.0`);
    expect(heroComparison.status).toBe(200);
    const heroComparisonJson = await heroComparison.json() as {
      hero: string | null;
      rows: { deck: string; deckId: string }[];
    };
    expect(heroComparisonJson.hero).toBe('king-kong@0.1.0');
    expect(heroComparisonJson.rows).toEqual([
      expect.objectContaining({ deck: 'king-kong@0.1.0', deckId: 'king-kong' }),
    ]);

    const samePilot = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=bot%3Ahard&pilotB=bot%3Ahard&opponentPilot=bot%3Ahard`);
    expect(samePilot.status).toBe(400);
    expect(await samePilot.json()).toMatchObject({ code: 'SAME_PILOT' });

    const missing = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&opponent=the-mandalorian@0.1.0&heroPilot=human&opponentPilot=bot%3Ahard`);
    expect(missing.status).toBe(404);
  });

  it('404s deck detail for an unknown deck', async () => {
    const response = await fetch(`${baseUrl}/v1/stats/deck?deck=does-not-exist@9.9.9`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: 'DECK_NOT_FOUND' });
  });

  it('reports boss-side win rate for boss formats', async () => {
    const bossGame = sampleGame({
      gameId: 'boss-game-001',
      stateHash: 'boss-state-001',
      format: 'two-v-one-boss',
      formatLabel: '2v1 Boss',
      boss: 'marrow-king',
      teams: [
        { role: 'boss', seats: [{ deck: 'marrow-king@0.1.0', pilot: 'bot:hard', runtimePlayerId: 'p1', heroId: 'marrow-king' }] },
        {
          seats: [
            { deck: 'king-kong@0.1.0', pilot: 'bot:hard', runtimePlayerId: 'p2', heroId: 'king-kong' },
            { deck: 'the-mandalorian@0.1.0', pilot: 'bot:hard', runtimePlayerId: 'p3', heroId: 'the-mandalorian' },
          ],
        },
      ],
      winner: 0,
    });
    await postGame(baseUrl, secret, bossGame, 'boss-game-001');

    const response = await fetch(`${baseUrl}/v1/stats/dashboard`);
    const json = await response.json() as {
      formats: { format: string; bossGames: number; bossWinRate: number | null; bosses: { boss: string; winRate: number }[] }[];
    };
    const bossFormat = json.formats.find((format) => format.format === 'two-v-one-boss');
    expect(bossFormat).toMatchObject({ bossGames: 1, bossWinRate: 1 });
    expect(bossFormat?.bosses).toContainEqual(expect.objectContaining({ boss: 'marrow-king', winRate: 1 }));
  });

  it('requires a signature to push deck definitions', async () => {
    const response = await fetch(`${baseUrl}/v1/decks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleDeckBatch()),
    });
    expect(response.status).toBe(401);
  });

  it('ingests deck definitions and exposes real composition on the dashboard', async () => {
    const push = await postDecks(baseUrl, secret, sampleDeckBatch());
    expect(push.status).toBe(200);
    expect(await push.json()).toMatchObject({ ok: true, upserted: 1 });

    await postGame(baseUrl, secret, sampleGame({ gameId: 'comp-game-001', stateHash: 'comp-state-001' }), 'comp-game-001');

    const dash = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    const dashJson = await dash.json() as { decks: { deck: string; composition: { cardCount: number; attack: number; lean: string } | null }[] };
    const king = dashJson.decks.find((deck) => deck.deck === 'king-kong@0.1.0');
    expect(king?.composition).toMatchObject({ cardCount: 30, attack: 12, lean: 'Offensive' });

    const detail = await fetch(`${baseUrl}/v1/stats/deck?deck=king-kong@0.1.0&format=duel&pilots=bot:hard`);
    const detailJson = await detail.json() as { composition: { cardCount: number; defenseValue: number } | null };
    expect(detailJson.composition).toMatchObject({ cardCount: 30 });
  });

  it('falls back to the latest version when the exact deck version is unknown', async () => {
    await postDecks(baseUrl, secret, sampleDeckBatch({ version: '9.9.9' }));
    await postGame(baseUrl, secret, sampleGame({ gameId: 'ver-game-001', stateHash: 'ver-state-001' }), 'ver-game-001');

    const dash = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilots=bot:hard`);
    const dashJson = await dash.json() as { decks: { deck: string; composition: { version: string } | null }[] };
    const king = dashJson.decks.find((deck) => deck.deck === 'king-kong@0.1.0');
    // game deck is @0.1.0, registry only has @9.9.9 -> latest fallback.
    expect(king?.composition?.version).toBe('9.9.9');
  });

  it('rejects malformed deck definitions', async () => {
    const response = await postDecks(baseUrl, secret, { schemaVersion: 1, decks: [{ deckId: 'x', version: '1', cards: [{ type: 'bogus', quantity: 1 }] }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('serves 2v2 overall and partner performance on deck detail', async () => {
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-a', ['alpha', 'bravo', 'charlie', 'delta']), 'deck-2v2-a');
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-b', ['alpha', 'bravo', 'echo', 'foxtrot']), 'deck-2v2-b');
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-c', ['alpha', 'charlie', 'bravo', 'delta'], 1), 'deck-2v2-c');
    await postGame(baseUrl, secret, twoVtwoGame('deck-2v2-d', ['alpha', 'charlie', 'echo', 'foxtrot'], 1), 'deck-2v2-d');

    const response = await fetch(`${baseUrl}/v1/stats/deck?deck=alpha@1.0.0&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      twoVTwo: {
        games: number;
        wins: number;
        winRate: number;
        partners: {
          deck: string;
          games: number;
          wins: number;
          winRate: number;
          delta: number;
          rawDelta: number;
          adjustedDelta: number;
          expectedWinRate: number;
        }[];
      };
    };
    expect(json.twoVTwo).toMatchObject({ games: 4, wins: 2, winRate: 0.5 });
    const bravo = json.twoVTwo.partners.find((p) => p.deck === 'bravo@1.0.0');
    expect(bravo).toMatchObject({ games: 2, wins: 2, winRate: 1, delta: 0.5, rawDelta: 0.5 });
    expect(bravo?.expectedWinRate).toBeCloseTo(0.5227, 4);
    expect(bravo?.adjustedDelta).toBeCloseTo(0.4773, 4);
    const charlie = json.twoVTwo.partners.find((p) => p.deck === 'charlie@1.0.0');
    expect(charlie).toMatchObject({ games: 2, wins: 0, winRate: 0, delta: -0.5, rawDelta: -0.5 });
    expect(charlie?.expectedWinRate).toBeCloseTo(0.4773, 4);
    expect(charlie?.adjustedDelta).toBeCloseTo(-0.4773, 4);
  });

  it('explores 2v2 scenarios with opponent-adjusted partner suggestions', async () => {
    await postGame(baseUrl, secret, twoVtwoGame('scenario-a', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-a');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-b', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-b');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-c', ['alpha', 'charlie', 'bravo', 'delta'], 1), 'scenario-c');

    const response = await fetch(`${baseUrl}/v1/stats/scenario?format=team-2v2&deck=alpha@1.0.0&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      partners: { deck: string; games: number; wins: number; winRate: number; expectedWinRate: number; adjustedDelta: number }[];
    };
    expect(json.totalGames).toBe(3);
    const bravo = json.partners.find((p) => p.deck === 'bravo@1.0.0');
    const charlie = json.partners.find((p) => p.deck === 'charlie@1.0.0');
    expect(bravo).toMatchObject({ games: 2, wins: 2, winRate: 1 });
    expect(charlie).toMatchObject({ games: 1, wins: 0, winRate: 0 });
    expect(bravo!.adjustedDelta).toBeGreaterThan(charlie!.adjustedDelta);
  });

  it('enumerates opponent matchups when a scenario partner is selected', async () => {
    await postGame(baseUrl, secret, twoVtwoGame('scenario-match-a', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-match-a');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-match-b', ['alpha', 'bravo', 'charlie', 'delta']), 'scenario-match-b');
    await postGame(baseUrl, secret, twoVtwoGame('scenario-match-c', ['alpha', 'bravo', 'echo', 'foxtrot'], 1), 'scenario-match-c');

    const response = await fetch(`${baseUrl}/v1/stats/scenario?format=team-2v2&deck=alpha@1.0.0&partner=bravo@1.0.0&pilots=bot:hard`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      partners: { deck: string; games: number }[];
      matchups: { opponentA: string; opponentB: string; games: number; wins: number; winRate: number; expectedWinRate: number; adjustedDelta: number }[];
    };
    expect(json.totalGames).toBe(3);
    expect(json.partners).toContainEqual(expect.objectContaining({ deck: 'bravo@1.0.0', games: 3 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ opponentA: 'charlie@1.0.0', opponentB: 'delta@1.0.0', games: 2, wins: 2, winRate: 1 }));
    expect(json.matchups).toContainEqual(expect.objectContaining({ opponentA: 'echo@1.0.0', opponentB: 'foxtrot@1.0.0', games: 1, wins: 0, winRate: 0 }));
  });

  it('reports 2v2 synergy pair matchups (opposing pairs and decks)', async () => {
    // alpha+bravo win both games, vs charlie+delta and vs echo+foxtrot.
    await postGame(baseUrl, secret, twoVtwoGame('syn-a', ['alpha', 'bravo', 'charlie', 'delta']), 'syn-a');
    await postGame(baseUrl, secret, twoVtwoGame('syn-b', ['alpha', 'bravo', 'echo', 'foxtrot']), 'syn-b');

    const response = await fetch(`${baseUrl}/v1/stats/synergy?deckA=alpha@1.0.0&deckB=bravo@1.0.0`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalGames: number;
      pairs: { deckA: string; deckB: string; games: number; wins: number; winRate: number }[];
      decks: { deck: string; games: number; winRate: number }[];
    };
    expect(json.totalGames).toBe(2);
    expect(json.pairs).toContainEqual(expect.objectContaining({ deckA: 'charlie@1.0.0', deckB: 'delta@1.0.0', games: 1, wins: 1, winRate: 1 }));
    expect(json.pairs).toContainEqual(expect.objectContaining({ deckA: 'echo@1.0.0', deckB: 'foxtrot@1.0.0', games: 1, wins: 1 }));
    expect(json.decks).toContainEqual(expect.objectContaining({ deck: 'echo@1.0.0', games: 1, winRate: 1 }));
    expect(json.decks.find((d) => d.deck === 'charlie@1.0.0')).toMatchObject({ games: 1, winRate: 1 });
  });

  it('400s synergy matchups without a pair', async () => {
    const response = await fetch(`${baseUrl}/v1/stats/synergy?deckA=alpha@1.0.0`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'MISSING_PAIR' });
  });

  it('lists recent games with teams and seats', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'recent-001', stateHash: 'recent-001' }), 'recent-001');
    const response = await fetch(`${baseUrl}/v1/stats/recent?limit=10`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      games: { gameId: string; format: string; winnerTeam: number | null; teams: { won: boolean; seats: { deckId: string; won: boolean }[] }[] }[];
    };
    const game = json.games.find((g) => g.gameId === 'recent-001');
    expect(game).toBeTruthy();
    expect(game).toMatchObject({ format: 'duel', winnerTeam: 0 });
    expect(game!.teams).toHaveLength(2);
    expect(game!.teams[0]).toMatchObject({ won: true });
    expect(game!.teams[0]!.seats[0]!.deckId).toBe('king-kong');
    expect(game!.teams[1]).toMatchObject({ won: false });
  });

  it('groups submissions by source', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'source-001', stateHash: 'source-001', source: 'engine' }), 'source-001');
    await postGame(baseUrl, secret, sampleGame({ gameId: 'source-002', stateHash: 'source-002', source: 'steven:laptop:lab' }), 'source-002');
    await postGame(baseUrl, secret, sampleGame({ gameId: 'source-003', stateHash: 'source-003', source: 'steven:laptop:lab' }), 'source-003');

    const response = await fetch(`${baseUrl}/v1/stats/sources`);
    expect(response.status).toBe(200);
    const json = await response.json() as {
      totalSubmissions: number;
      sources: { source: string; submissions: number; lastReceivedAt: string | null }[];
    };
    expect(json.totalSubmissions).toBe(3);
    expect(json.sources[0]).toMatchObject({ source: 'steven:laptop:lab', submissions: 2 });
    expect(json.sources).toContainEqual(expect.objectContaining({ source: 'engine', submissions: 1 }));
    expect(json.sources[0]!.lastReceivedAt).toBeTruthy();
  });

  it('serves cached hourly recent game buckets', async () => {
    await postGame(baseUrl, secret, sampleGame({ gameId: 'recent-hourly-001', stateHash: 'recent-hourly-001' }), 'recent-hourly-001');
    const response = await fetch(`${baseUrl}/v1/stats/recent/hourly`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('max-age=300');
    const json = await response.json() as {
      totals: { format: string; games: number }[];
      buckets: { hour: string; total: number; formats: { format: string; games: number }[] }[];
    };
    expect(json.totals).toContainEqual(expect.objectContaining({ format: 'duel', games: 1 }));
    expect(json.buckets).toHaveLength(24);
    const currentHour = json.buckets.at(-1);
    expect(currentHour?.hour).toBe('2026-07-14T16:00:00.000Z');
    expect(currentHour).toMatchObject({ total: 1 });
    expect(currentHour?.formats).toContainEqual(expect.objectContaining({ format: 'duel', games: 1 }));
  });

  it('stores invalid submissions and returns validation errors', async () => {
    const response = await postRaw(baseUrl, secret, { schemaVersion: 1, format: 'duel', map: 'mended-drum', teams: [], winner: 0 }, 'bad-game-001');
    expect(response.status).toBe(400);
    const json = await response.json() as { code: string; submissionId: string; errors: string[] };
    expect(json.code).toBe('VALIDATION_FAILED');
    expect(json.submissionId).toBeTruthy();
    const stored = await pool.query('SELECT validation_status FROM game_submissions WHERE id = $1', [json.submissionId]);
    expect(stored.rows[0]?.validation_status).toBe('invalid');
  });
});

function sampleDeckBatch(overrides: { version?: string } = {}): unknown {
  return {
    schemaVersion: 1,
    source: 'test',
    contentVersion: '0.1.0',
    decks: [
      {
        deckId: 'king-kong',
        version: overrides.version ?? '0.1.0',
        name: 'King Kong',
        tier: 'community',
        cards: [
          { id: 'king-kong/a', title: 'A', type: 'attack', value: 5, boost: 2, quantity: 12 },
          { id: 'king-kong/d', title: 'D', type: 'defense', value: 2, boost: 2, quantity: 6 },
          { id: 'king-kong/v', title: 'V', type: 'versatile', value: 3, boost: 2, quantity: 8 },
          { id: 'king-kong/s', title: 'S', type: 'scheme', value: null, boost: 2, quantity: 4 },
        ],
      },
    ],
  };
}

async function postDecks(baseUrl: string, secret: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signBody(secret, body, '2026-07-14T16:30:00.000Z');
  return fetch(`${baseUrl}/v1/decks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unbrewed-timestamp': timestamp,
      'x-unbrewed-signature': signature,
    },
    body,
  });
}

function twoVtwoGame(id: string, decks: [string, string, string, string], winner = 0): unknown {
  const seat = (deck: string, player: string) => ({ deck: `${deck}@1.0.0`, pilot: 'bot:hard', runtimePlayerId: player, heroId: deck });
  return sampleGame({
    gameId: id,
    stateHash: id,
    format: 'team-2v2',
    formatLabel: '2v2',
    teams: [
      { seats: [seat(decks[0], 'p1'), seat(decks[1], 'p2')] },
      { seats: [seat(decks[2], 'p3'), seat(decks[3], 'p4')] },
    ],
    winner,
  });
}

async function postGame(baseUrl: string, secret: string, payload: unknown, idempotencyKey: string): Promise<Response> {
  return postRaw(baseUrl, secret, payload, idempotencyKey);
}

async function postRaw(baseUrl: string, secret: string, payload: unknown, idempotencyKey: string): Promise<Response> {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signBody(secret, body, '2026-07-14T16:30:00.000Z');
  return fetch(`${baseUrl}/v1/games`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-unbrewed-timestamp': timestamp,
      'x-unbrewed-signature': signature,
    },
    body,
  });
}
