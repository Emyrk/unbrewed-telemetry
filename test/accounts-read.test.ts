/**
 * Accounts read API (#52) — DB-backed, gated on TEST_DATABASE_URL like the rest
 * of the suite.
 *
 * Proves the contract unbrewed-api's proxy (JollyGrin/unbrewed-api#14) is
 * written against: bearer auth on a third credential, sim/campaign games never
 * surfacing in a player's history, a cursor that walks the feed without overlap
 * or gap, multi-seat games splitting into one `you` and the rest, an unknown
 * player id returning empty rather than 404, and stats aggregates that match
 * hand-counted fixtures.
 */

import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import type { GameSubmission } from '../src/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const READ_TOKEN = 'accounts-read-token-for-tests';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const appConfig = (now: Date, accountsReadToken: string) => ({
  telemetrySecret: 'unused',
  accountsReadToken,
  allowUnauthenticatedIngest: true,
  bodyLimitBytes: 1024 * 1024,
  now: () => now,
  discordClientId: '',
  discordClientSecret: '',
  discordRedirectUri: '',
  adminDiscordIds: [],
  secureCookies: false,
});

interface SeatSpec {
  deck: string;
  heroId: string;
  pilot: string;
  playerId?: string;
  botDifficulty?: string;
  finalHealth?: number;
}

/** A minimal but schema-valid submission with hand-chosen seats. */
function game(options: {
  id: string;
  endedAt: string;
  map?: string;
  teams: SeatSpec[][];
  winner: number | null;
  draw?: boolean;
  turns?: number;
  durationSeconds?: number;
  endCondition?: string;
  /** Omit for a producer that never reported who went first. */
  firstPlayerTeam?: number | null;
}): GameSubmission {
  return {
    schemaVersion: 1,
    gameId: options.id,
    submittedAt: options.endedAt,
    endedAt: options.endedAt,
    source: 'test',
    format: options.teams.length === 2 && options.teams[0]!.length === 2 ? 'team-2v2' : 'duel',
    map: options.map ?? 'mended-drum',
    teams: options.teams.map((seats) => ({
      seats: seats.map((seat, index) => ({
        deck: seat.deck,
        pilot: seat.pilot,
        runtimePlayerId: `p${index + 1}`,
        heroId: seat.heroId,
        heroName: heroName(seat.heroId),
        playerId: seat.playerId,
        botDifficulty: seat.botDifficulty,
        finalHealth: seat.finalHealth ?? 0,
      })),
    })),
    winner: options.winner,
    draw: options.draw ?? false,
    endCondition: options.endCondition ?? 'hero_defeated',
    turns: options.turns ?? 10,
    durationSeconds: options.durationSeconds ?? 600,
    firstPlayerTeam: options.firstPlayerTeam === null ? undefined : options.firstPlayerTeam ?? 0,
    engine: { schemaVersion: 3, dslVersion: '0.18.0', protocolVersion: 12, contentVersion: 'test' },
    stateHash: `state-${options.id}`,
  } as GameSubmission;
}

/** The `code` of an error envelope, for asserting on failure responses. */
async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

/** The stats payload, exactly as unbrewed-api proxies it (#54 fields included). */
interface StatsBody {
  ok: true;
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  byHero: Array<{ heroId: string; heroName: string; games: number; wins: number }>;
  firstGameAt: string | null;
  lastGameAt: string | null;
  avgDurationSeconds: number | null;
  avgTurns: number | null;
  streaks: { current: number; best: number };
  recentForm: Array<'W' | 'L' | 'D'>;
  byOpponentHero: Array<{ heroId: string; heroName: string; games: number; wins: number }>;
  byMap: Array<{ map: string; games: number; wins: number }>;
  byOpponentKind: {
    human: { games: number; wins: number };
    bots: Array<{ difficulty: string; games: number; wins: number }>;
  };
  firstPlayer: { first: { games: number; wins: number }; second: { games: number; wins: number } };
}

function heroName(heroId: string): string {
  return heroId.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ');
}

describeDb('accounts read api', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  let cpRepo: ControlPlaneRepository;
  let server: Server;
  let baseUrl: string;
  const now = new Date('2026-08-06T12:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    cpRepo = new ControlPlaneRepository(pool);
    server = createServer(createApp({ repo, cpRepo, config: appConfig(now, READ_TOKEN) }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE game_submissions, sim_campaigns, telemetry_sources CASCADE');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await pool.end();
  });

  /** Ingest straight through the repository — the read API is what is under test. */
  async function ingest(submission: GameSubmission, campaignId: string | null = null): Promise<void> {
    const result = await repo.ingestValid({
      payload: submission,
      idempotencyKey: submission.gameId ?? submission.stateHash!,
      receivedAt: new Date(submission.endedAt ?? '2026-08-06T12:00:00.000Z'),
      authKeyId: 'test',
      campaignId,
      campaignGameIndex: campaignId ? 0 : null,
    });
    expect(result.kind).toBe('created');
  }

  function read(path: string, token: string | null = READ_TOKEN): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  }

  async function stats(playerId: string): Promise<StatsBody> {
    return (await (await read(`/accounts/players/${playerId}/stats`)).json()) as StatsBody;
  }

  describe('auth', () => {
    it('401s on a missing or wrong bearer token', async () => {
      const missing = await read(`/accounts/players/${ALICE}/games`, null);
      expect(missing.status).toBe(401);
      expect(await errorCode(missing)).toBe('UNAUTHORIZED');

      const wrong = await read(`/accounts/players/${ALICE}/stats`, 'not-the-token');
      expect(wrong.status).toBe(401);

      // A token that is a prefix of the real one must not pass either.
      const prefix = await read(`/accounts/players/${ALICE}/games`, READ_TOKEN.slice(0, -1));
      expect(prefix.status).toBe(401);

      // Neither does a `ubk_` bearer credential — this is a separate scheme.
      const source = await cpRepo.createSource('accounts-test', null, 'test');
      const cred = await cpRepo.createCredential(source.id, 'worker', ['games:submit'], 'test');
      const wrongScheme = await read(`/accounts/players/${ALICE}/games`, cred.fullKey);
      expect(wrongScheme.status).toBe(401);
    });

    it('503s when ACCOUNTS_READ_TOKEN is unset rather than failing open', async () => {
      const unconfigured = createServer(createApp({ repo, cpRepo, config: appConfig(now, '') }));
      await new Promise<void>((resolve) => unconfigured.listen(0, resolve));
      try {
        const address = unconfigured.address();
        if (!address || typeof address === 'string') throw new Error('expected TCP address');
        const response = await fetch(`http://127.0.0.1:${address.port}/accounts/players/${ALICE}/games`, {
          headers: { authorization: `Bearer ${READ_TOKEN}` },
        });
        expect(response.status).toBe(503);
        expect(await errorCode(response)).toBe('AUTH_NOT_CONFIGURED');
      } finally {
        await new Promise<void>((resolve, reject) => unconfigured.close((e) => (e ? reject(e) : resolve())));
      }
    });
  });

  it('returns empty results for a player id that has never played', async () => {
    await ingest(game({
      id: 'g-other',
      endedAt: '2026-08-01T10:00:00.000Z',
      teams: [
        [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: BOB }],
        [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
      ],
      winner: 0,
    }));

    const games = await (await read(`/accounts/players/${ALICE}/games`)).json();
    expect(games).toEqual({ ok: true, games: [], nextBefore: null });

    // Every aggregate is empty or null — never a 404, never a partial payload.
    expect(await stats(ALICE)).toEqual({
      ok: true,
      totalGames: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      byHero: [],
      firstGameAt: null,
      lastGameAt: null,
      avgDurationSeconds: null,
      avgTurns: null,
      streaks: { current: 0, best: 0 },
      recentForm: [],
      byOpponentHero: [],
      byMap: [],
      byOpponentKind: { human: { games: 0, wins: 0 }, bots: [] },
      firstPlayer: { first: { games: 0, wins: 0 }, second: { games: 0, wins: 0 } },
    });
  });

  it('excludes sim/campaign games from both endpoints', async () => {
    const campaign = await cpRepo.createCampaign({
      name: 'accounts-exclusion-test',
      spec: { note: 'test' },
      baseSeed: 4242,
      games: [{ spec: { step: 'test' } }],
      createdBy: 'test',
    });

    // Same player id on a campaign seat: a producer bug is the only way this
    // happens, and it still must not show up as somebody's history.
    await ingest(game({
      id: 'g-campaign',
      endedAt: '2026-08-02T10:00:00.000Z',
      teams: [
        [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:ismcts', playerId: ALICE }],
        [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:mc' }],
      ],
      winner: 0,
    }), campaign.id);

    await ingest(game({
      id: 'g-real',
      endedAt: '2026-08-03T10:00:00.000Z',
      teams: [
        [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
        [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
      ],
      winner: 0,
    }));

    const games = (await (await read(`/accounts/players/${ALICE}/games`)).json()) as {
      games: Array<{ id: string }>;
    };
    expect(games.games.map((g) => g.id)).toEqual(['g-real']);

    const body = await stats(ALICE);
    expect(body.totalGames).toBe(1);
    expect(body.wins).toBe(1);
    expect(body.firstGameAt).toBe('2026-08-03T10:00:00.000Z');
    expect(body.lastGameAt).toBe('2026-08-03T10:00:00.000Z');

    // Every #54 aggregate reflects g-real alone. The campaign game is Alice on
    // the same hero against a `bot:mc` seat with no difficulty, so a leak would
    // show up as a second game, an extra `unknown` bot row, or a longer streak.
    expect(body).toMatchObject({
      avgDurationSeconds: 600,
      avgTurns: 10,
      streaks: { current: 1, best: 1 },
      recentForm: ['W'],
      byOpponentHero: [
        { heroId: 'the-mandalorian', heroName: 'The Mandalorian', games: 1, wins: 1 },
      ],
      byMap: [{ map: 'mended-drum', games: 1, wins: 1 }],
      byOpponentKind: { human: { games: 0, wins: 0 }, bots: [{ difficulty: 'hard', games: 1, wins: 1 }] },
      firstPlayer: { first: { games: 1, wins: 1 }, second: { games: 0, wins: 0 } },
    });
  });

  it('returns one `you` seat and every other seat as an opponent in a 2v2', async () => {
    await ingest(game({
      id: 'g-2v2',
      endedAt: '2026-08-04T10:00:00.000Z',
      map: 'sarcophagus',
      turns: 17,
      durationSeconds: 1234,
      endCondition: 'hero_defeated',
      teams: [
        [
          { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE, finalHealth: 6 },
          { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB, finalHealth: 3 },
        ],
        [
          { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' },
          { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:easy', botDifficulty: 'easy' },
        ],
      ],
      winner: 0,
    }));

    const body = (await (await read(`/accounts/players/${ALICE}/games`)).json()) as {
      games: Array<{
        id: string; endedAt: string; map: string; turns: number; durationSeconds: number;
        endCondition: string; draw: boolean;
        you: { heroId: string; heroName: string; won: boolean; finalHealth: number };
        opponents: Array<{ heroId: string; heroName: string; pilot: string; botDifficulty: string | null }>;
      }>;
      nextBefore: string | null;
    };

    expect(body.games).toHaveLength(1);
    const [only] = body.games;
    expect(only).toMatchObject({
      id: 'g-2v2',
      endedAt: '2026-08-04T10:00:00.000Z',
      map: 'sarcophagus',
      turns: 17,
      durationSeconds: 1234,
      endCondition: 'hero_defeated',
      draw: false,
      you: { heroId: 'king-kong', heroName: 'King Kong', won: true, finalHealth: 6 },
    });
    // Three opponents: the teammate plus both members of the other team.
    expect(only!.opponents).toEqual([
      { heroId: 'medusa', heroName: 'Medusa', pilot: 'human', botDifficulty: null },
      { heroId: 'the-mandalorian', heroName: 'The Mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' },
      { heroId: 'bigfoot', heroName: 'Bigfoot', pilot: 'bot:easy', botDifficulty: 'easy' },
    ]);
    expect(body.nextBefore).toBeNull();

    // Bob sees the same game from his own seat.
    const bobBody = (await (await read(`/accounts/players/${BOB}/games`)).json()) as {
      games: Array<{ you: { heroId: string; finalHealth: number }; opponents: Array<{ heroId: string }> }>;
    };
    expect(bobBody.games[0]!.you).toMatchObject({ heroId: 'medusa', finalHealth: 3 });
    expect(bobBody.games[0]!.opponents.map((o) => o.heroId)).toEqual(['king-kong', 'the-mandalorian', 'bigfoot']);
  });

  it('counts one matchup row per opposing seat in a 2v2, never the teammate', async () => {
    await ingest(game({
      id: 'g-2v2-stats',
      endedAt: '2026-08-04T10:00:00.000Z',
      teams: [
        [
          { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE },
          { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB },
        ],
        [
          { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' },
          { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:easy', botDifficulty: 'easy' },
        ],
      ],
      winner: 0,
    }));

    const body = await stats(ALICE);
    // One game played, but two opponent-hero rows: matchup counts are per
    // opposing seat, so they sum to more than totalGames in team formats.
    expect(body.totalGames).toBe(1);
    expect(body.byOpponentHero).toEqual([
      { heroId: 'bigfoot', heroName: 'Bigfoot', games: 1, wins: 1 },
      { heroId: 'the-mandalorian', heroName: 'The Mandalorian', games: 1, wins: 1 },
    ]);
    // Medusa is Alice's teammate; a teammate is never an opponent-hero row.
    expect(body.byOpponentHero.map((row) => row.heroId)).not.toContain('medusa');

    // Both opposing seats are bots at different difficulties: one bot row, and
    // the alphabetically first difficulty represents the game.
    expect(body.byOpponentKind).toEqual({
      human: { games: 0, wins: 0 },
      bots: [{ difficulty: 'easy', games: 1, wins: 1 }],
    });

    // Bob shares Alice's team, so he sees the same two opposing heroes.
    const bobBody = await stats(BOB);
    expect(bobBody.byOpponentHero.map((row) => row.heroId)).toEqual(['bigfoot', 'the-mandalorian']);
    expect(bobBody.byOpponentHero.every((row) => row.wins === 1)).toBe(true);
  });

  describe('streaks and recent form', () => {
    // Chronological, oldest first. Chosen so best (4, days 1-4) and current (1,
    // day 12) differ, a draw (day 8) breaks a run that wins on both sides, and
    // the history is longer than the 10-game recentForm window.
    const outcomes = ['W', 'W', 'W', 'W', 'L', 'W', 'W', 'D', 'W', 'W', 'L', 'W'] as const;

    beforeEach(async () => {
      for (const [index, outcome] of outcomes.entries()) {
        const day = String(index + 1).padStart(2, '0');
        await ingest(game({
          id: `g-streak-${day}`,
          endedAt: `2026-06-${day}T10:00:00.000Z`,
          teams: [
            [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
            [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
          ],
          winner: outcome === 'W' ? 0 : outcome === 'L' ? 1 : null,
          draw: outcome === 'D',
        }));
      }
    });

    it('reports the longest run as best and the run ending on the newest game as current', async () => {
      const body = await stats(ALICE);
      expect(body.streaks).toEqual({ current: 1, best: 4 });
      // Newest first, capped at 10 — days 12 down to 3.
      expect(body.recentForm).toEqual(['W', 'L', 'W', 'W', 'D', 'W', 'W', 'L', 'W', 'W']);
    });

    it('treats a draw as breaking a streak rather than extending it', async () => {
      // Day 8 is a draw between two wins (day 7 and day 9). If a draw did not
      // break, days 6-7 + 9-10 would fuse into a run of 4 that ties best; the
      // run ending on the newest game would also grow past 1.
      await pool.query('TRUNCATE game_submissions CASCADE');
      for (const [index, outcome] of (['W', 'W', 'D', 'W', 'W'] as const).entries()) {
        const day = String(index + 1).padStart(2, '0');
        await ingest(game({
          id: `g-draw-${day}`,
          endedAt: `2026-05-${day}T10:00:00.000Z`,
          teams: [
            [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
            [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
          ],
          winner: outcome === 'W' ? 0 : null,
          draw: outcome === 'D',
        }));
      }

      const body = await stats(ALICE);
      expect(body.streaks).toEqual({ current: 2, best: 2 });
      expect(body.recentForm).toEqual(['W', 'W', 'D', 'W', 'W']);
    });

    it('reports current equal to best when the player is on their longest run', async () => {
      await pool.query('TRUNCATE game_submissions CASCADE');
      for (const day of ['01', '02', '03']) {
        await ingest(game({
          id: `g-run-${day}`,
          endedAt: `2026-04-${day}T10:00:00.000Z`,
          teams: [
            [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
            [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
          ],
          winner: 0,
        }));
      }

      expect((await stats(ALICE)).streaks).toEqual({ current: 3, best: 3 });
    });

    it('reports zero streaks for a player who has never won', async () => {
      await pool.query('TRUNCATE game_submissions CASCADE');
      await ingest(game({
        id: 'g-winless',
        endedAt: '2026-03-01T10:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
        ],
        winner: 1,
      }));

      const body = await stats(ALICE);
      expect(body.streaks).toEqual({ current: 0, best: 0 });
      expect(body.recentForm).toEqual(['L']);
    });
  });

  describe('opponent kind, maps, and the first-player split', () => {
    beforeEach(async () => {
      // m1: mixed opposition (one human, one bot) — classified as a bot game.
      await ingest(game({
        id: 'g-mixed',
        endedAt: '2026-07-01T10:00:00.000Z',
        map: 'sarcophagus',
        turns: 12,
        durationSeconds: 900,
        teams: [
          [
            { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE },
            { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human' },
          ],
          [
            { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'human', playerId: BOB },
            { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:hard', botDifficulty: 'hard' },
          ],
        ],
        winner: 0,
        firstPlayerTeam: 0,
      }));

      // m2: humans only, and Alice went second.
      await ingest(game({
        id: 'g-human',
        endedAt: '2026-07-02T10:00:00.000Z',
        map: 'sarcophagus',
        turns: 8,
        durationSeconds: 300,
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'human', playerId: BOB }],
        ],
        winner: 1,
        firstPlayerTeam: 1,
      }));

      // m3: a bot with no reported difficulty, and no reported first player.
      await ingest(game({
        id: 'g-bot-unknown',
        endedAt: '2026-07-03T10:00:00.000Z',
        map: 'mended-drum',
        turns: 10,
        durationSeconds: 600,
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:mc' }],
        ],
        winner: 0,
        firstPlayerTeam: null,
      }));
    });

    it('classifies a mixed human/bot opposition as a bot game', async () => {
      const body = await stats(ALICE);
      expect(body.byOpponentKind).toEqual({
        // Only g-human has an all-human opposition, and Alice lost it.
        human: { games: 1, wins: 0 },
        // g-mixed carries its bot seat's difficulty; g-bot-unknown reports none.
        bots: [
          { difficulty: 'hard', games: 1, wins: 1 },
          { difficulty: 'unknown', games: 1, wins: 1 },
        ],
      });
    });

    it('splits first-player games and drops games with no reported first player', async () => {
      const body = await stats(ALICE);
      // g-mixed first (won), g-human second (lost); g-bot-unknown has no
      // first_player_team so it is in neither bucket.
      expect(body.firstPlayer).toEqual({
        first: { games: 1, wins: 1 },
        second: { games: 1, wins: 0 },
      });
      expect(body.totalGames).toBe(3);
    });

    it('groups by map games-desc and averages duration and turns', async () => {
      const body = await stats(ALICE);
      expect(body.byMap).toEqual([
        { map: 'sarcophagus', games: 2, wins: 1 },
        { map: 'mended-drum', games: 1, wins: 1 },
      ]);
      expect(body.avgDurationSeconds).toBe(600); // (900 + 300 + 600) / 3
      expect(body.avgTurns).toBe(10); // (12 + 8 + 10) / 3
    });

    it('buckets a blank map as unknown', async () => {
      // `map` has minLength 1 in the submission schema, so a blank map cannot be
      // ingested — the bucket is defensive. Force one to prove it holds.
      await pool.query(`UPDATE games SET map = '' WHERE id = 'g-bot-unknown'`);
      const body = await stats(ALICE);
      expect(body.byMap).toEqual([
        { map: 'sarcophagus', games: 2, wins: 1 },
        { map: 'unknown', games: 1, wins: 1 },
      ]);
    });
  });

  describe('with a seeded seven-game history', () => {
    // Seven games, one per day, newest 2026-08-07. Alice's hero and result per
    // game are fixed here so the stats assertions below are hand-countable.
    const history = [
      { day: 1, hero: 'king-kong', outcome: 'win' },
      { day: 2, hero: 'king-kong', outcome: 'loss' },
      { day: 3, hero: 'king-kong', outcome: 'win' },
      { day: 4, hero: 'medusa', outcome: 'draw' },
      { day: 5, hero: 'medusa', outcome: 'win' },
      { day: 6, hero: 'bigfoot', outcome: 'loss' },
      { day: 7, hero: 'king-kong', outcome: 'win' },
    ] as const;

    beforeEach(async () => {
      for (const entry of history) {
        const won = entry.outcome === 'win';
        const draw = entry.outcome === 'draw';
        await ingest(game({
          id: `g-${entry.day}`,
          endedAt: `2026-08-0${entry.day}T10:00:00.000Z`,
          teams: [
            [{ deck: `${entry.hero}@1.0.0`, heroId: entry.hero, pilot: 'human', playerId: ALICE }],
            [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
          ],
          winner: draw ? null : won ? 0 : 1,
          draw,
        }));
      }
    });

    it('orders newest first and caps limit at 50', async () => {
      const body = (await (await read(`/accounts/players/${ALICE}/games?limit=500`)).json()) as {
        games: Array<{ id: string }>; nextBefore: string | null;
      };
      expect(body.games.map((g) => g.id)).toEqual(['g-7', 'g-6', 'g-5', 'g-4', 'g-3', 'g-2', 'g-1']);
      expect(body.nextBefore).toBeNull();
    });

    it('walks the cursor with no overlap and no gap', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? '?limit=3' : `?limit=3&before=${encodeURIComponent(cursor)}`;
        const page = (await (await read(`/accounts/players/${ALICE}/games${query}`)).json()) as {
          games: Array<{ id: string }>; nextBefore: string | null;
        };
        seen.push(...page.games.map((g) => g.id));
        cursor = page.nextBefore;
        pages++;
        expect(pages).toBeLessThan(10); // guard against a cursor that never advances
      } while (cursor !== null);

      expect(pages).toBe(3); // 3 + 3 + 1
      expect(seen).toEqual(['g-7', 'g-6', 'g-5', 'g-4', 'g-3', 'g-2', 'g-1']);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('rejects a cursor it did not issue', async () => {
      const response = await read(`/accounts/players/${ALICE}/games?before=not-a-cursor`);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('BAD_CURSOR');
    });

    it('aggregates stats to match the fixture by hand-count', async () => {
      const body = await stats(ALICE);
      // 7 games: 4 wins (days 1, 3, 5, 7), 2 losses (days 2, 6), 1 draw (day 4).
      expect(body.totalGames).toBe(7);
      expect(body.wins).toBe(4);
      expect(body.losses).toBe(2);
      expect(body.draws).toBe(1);
      expect(body.firstGameAt).toBe('2026-08-01T10:00:00.000Z');
      expect(body.lastGameAt).toBe('2026-08-07T10:00:00.000Z');
      // king-kong 4 games / 3 wins, medusa 2 / 1, bigfoot 1 / 0 — games desc.
      expect(body.byHero).toEqual([
        { heroId: 'king-kong', heroName: 'King Kong', games: 4, wins: 3 },
        { heroId: 'medusa', heroName: 'Medusa', games: 2, wins: 1 },
        { heroId: 'bigfoot', heroName: 'Bigfoot', games: 1, wins: 0 },
      ]);
    });

    it('adds the #54 aggregates over the same fixture without disturbing the #52 ones', async () => {
      const body = await stats(ALICE);
      expect(body).toEqual({
        ok: true,
        // Unchanged from the #52 payload, asserted whole so a regression in any
        // existing field fails here and not only in the test above.
        totalGames: 7,
        wins: 4,
        losses: 2,
        draws: 1,
        byHero: [
          { heroId: 'king-kong', heroName: 'King Kong', games: 4, wins: 3 },
          { heroId: 'medusa', heroName: 'Medusa', games: 2, wins: 1 },
          { heroId: 'bigfoot', heroName: 'Bigfoot', games: 1, wins: 0 },
        ],
        firstGameAt: '2026-08-01T10:00:00.000Z',
        lastGameAt: '2026-08-07T10:00:00.000Z',
        // Every game in this fixture runs 10 turns in 600 seconds.
        avgDurationSeconds: 600,
        avgTurns: 10,
        // Wins on days 1, 3, 5 and 7 are all isolated, so no run exceeds one.
        streaks: { current: 1, best: 1 },
        recentForm: ['W', 'L', 'W', 'D', 'W', 'L', 'W'],
        byOpponentHero: [
          { heroId: 'the-mandalorian', heroName: 'The Mandalorian', games: 7, wins: 4 },
        ],
        byMap: [{ map: 'mended-drum', games: 7, wins: 4 }],
        byOpponentKind: {
          human: { games: 0, wins: 0 },
          bots: [{ difficulty: 'hard', games: 7, wins: 4 }],
        },
        firstPlayer: { first: { games: 7, wins: 4 }, second: { games: 0, wins: 0 } },
      });
    });
  });
});
