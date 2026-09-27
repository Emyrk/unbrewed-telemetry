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
const CAROL = '33333333-3333-4333-8333-333333333333';
const DAVE = '44444444-4444-4444-8444-444444444444';
const EVE = '55555555-5555-4555-8555-555555555555';

const appConfig = (now: Date, accountsReadToken: string) => ({
  telemetrySecret: 'unused',
  accountsReadToken,
  allowUnauthenticatedIngest: true,
  bodyLimitBytes: 1024 * 1024,
  replayBodyLimitBytes: 2 * 1024 * 1024,
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

/** The per-hero opponent-kind cross (#63) — five fixed buckets, always present. */
interface HeroOpponents {
  human: { games: number; wins: number };
  easy: { games: number; wins: number };
  medium: { games: number; wins: number };
  hard: { games: number; wins: number };
  expert: { games: number; wins: number };
}

const NO_HERO_OPPONENTS: HeroOpponents = {
  human: { games: 0, wins: 0 },
  easy: { games: 0, wins: 0 },
  medium: { games: 0, wins: 0 },
  hard: { games: 0, wins: 0 },
  expert: { games: 0, wins: 0 },
};

/** The zeroed block with the named buckets filled in — every assertion is whole. */
function heroOpponents(filled: Partial<HeroOpponents>): HeroOpponents {
  return { ...NO_HERO_OPPONENTS, ...filled };
}

/** The stats payload, exactly as unbrewed-api proxies it (#54 fields included). */
interface StatsBody {
  ok: true;
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  byHero: Array<{
    heroId: string;
    heroName: string;
    games: number;
    wins: number;
    byOpponent: HeroOpponents;
  }>;
  firstGameAt: string | null;
  lastGameAt: string | null;
  avgDurationSeconds: number | null;
  avgTurns: number | null;
  streaks: { current: number; best: number };
  recentForm: Array<'W' | 'L' | 'D'>;
  byOpponentHero: Array<{ heroId: string; heroName: string; games: number; wins: number }>;
  byMap: Array<{ map: string; games: number; wins: number }>;
  byOpponentKind: {
    human: { games: number; wins: number; draws: number };
    bots: Array<{ difficulty: string; games: number; wins: number; draws: number }>;
  };
  firstPlayer: {
    first: { games: number; wins: number; draws: number };
    second: { games: number; wins: number; draws: number };
  };
  clutchWins: number;
  fastestBotWinTurns: number | null;
  calendar: Array<{ date: string; games: number }>;
  byHeroOpponentHero: Array<{
    heroId: string | null;
    heroName: string | null;
    opponentHeroId: string | null;
    opponentHeroName: string | null;
    games: number;
    wins: number;
    draws: number;
  }>;
}

/** The leaderboard payload unbrewed-api ranks by XP (#56). */
interface LeaderboardBody {
  ok: true;
  players: Array<{
    playerId: string;
    gamesPlayed: number;
    wins: number;
    byOpponentKind: StatsBody['byOpponentKind'];
    mainHeroId: string | null;
    mainHeroName: string | null;
    recentForm: Array<'W' | 'L' | 'D'>;
    currentStreak: number;
    windowGames?: number;
    windowWins?: number;
  }>;
}

/** The community payload (stats dashboard contract §1a). */
interface CommunityBody {
  ok: true;
  window: 'all' | 'month';
  windowStart: string | null;
  generatedAt: string;
  totals: { games: number; human: number; hardExpert: number; casual: number; humanVsExpert: { games: number; wins: number } };
  weekly: Array<{ weekStart: string; human: number; hardExpert: number; casual: number }>;
  heroes: Array<{
    heroId: string;
    heroName: string | null;
    games: number;
    wins: number;
    draws: number;
    crown: { playerId: string; wins: number; games: number } | null;
  }>;
  matchups: Array<{ heroId: string; opponentHeroId: string; games: number; wins: number; draws: number }>;
}

/** The hero page payload (stats dashboard contract §1b). */
interface HeroBody {
  ok: true;
  heroId: string;
  heroName: string | null;
  window: 'all' | 'month';
  windowStart: string | null;
  generatedAt: string;
  games: number;
  wins: number;
  draws: number;
  totalHumanSeatGames: number;
  pilotCount: number;
  pilots: Array<{ playerId: string; games: number; wins: number; draws: number }>;
  crown: { playerId: string; games: number; wins: number; draws: number } | null;
  matchups: Array<{ opponentHeroId: string; opponentHeroName: string | null; games: number; wins: number; draws: number }>;
  byOpponentKind: { human: number; hardExpert: number; casual: number };
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
      byOpponentKind: { human: { games: 0, wins: 0, draws: 0 }, bots: [] },
      firstPlayer: {
        first: { games: 0, wins: 0, draws: 0 },
        second: { games: 0, wins: 0, draws: 0 },
      },
      clutchWins: 0,
      fastestBotWinTurns: null,
      calendar: [],
      byHeroOpponentHero: [],
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
      byOpponentKind: {
        human: { games: 0, wins: 0, draws: 0 },
        bots: [{ difficulty: 'hard', games: 1, wins: 1, draws: 0 }],
      },
      firstPlayer: {
        first: { games: 1, wins: 1, draws: 0 },
        second: { games: 0, wins: 0, draws: 0 },
      },
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
      human: { games: 0, wins: 0, draws: 0 },
      bots: [{ difficulty: 'easy', games: 1, wins: 1, draws: 0 }],
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

      // m3: a bot whose label decodes to no tier at all (a sim knob-grid sweep
      // label, the one shape #58 deliberately refuses to guess a tier for), and
      // no reported first player.
      await ingest(game({
        id: 'g-bot-unknown',
        endedAt: '2026-07-03T10:00:00.000Z',
        map: 'mended-drum',
        turns: 10,
        durationSeconds: 600,
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:mc(sims-256/eps-0.30/depth-4)' }],
        ],
        winner: 0,
        firstPlayerTeam: null,
      }));
    });

    it('classifies a mixed human/bot opposition as a bot game', async () => {
      const body = await stats(ALICE);
      expect(body.byOpponentKind).toEqual({
        // Only g-human has an all-human opposition, and Alice lost it.
        human: { games: 1, wins: 0, draws: 0 },
        // g-mixed carries a stamped `hard`; g-bot-unknown's label decodes to
        // nothing, which is the only way an `unknown` row is produced.
        bots: [
          { difficulty: 'hard', games: 1, wins: 1, draws: 0 },
          { difficulty: 'unknown', games: 1, wins: 1, draws: 0 },
        ],
      });
    });

    it('splits first-player games and drops games with no reported first player', async () => {
      const body = await stats(ALICE);
      // g-mixed first (won), g-human second (lost); g-bot-unknown has no
      // first_player_team so it is in neither bucket.
      expect(body.firstPlayer).toEqual({
        first: { games: 1, wins: 1, draws: 0 },
        second: { games: 1, wins: 0, draws: 0 },
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
      // Every game here is against the same stamped `hard` bot, so each hero's
      // whole record shows up in the `hard` bucket of its #63 breakdown.
      expect(body.byHero).toEqual([
        {
          heroId: 'king-kong', heroName: 'King Kong', games: 4, wins: 3,
          byOpponent: heroOpponents({ hard: { games: 4, wins: 3 } }),
        },
        {
          heroId: 'medusa', heroName: 'Medusa', games: 2, wins: 1,
          byOpponent: heroOpponents({ hard: { games: 2, wins: 1 } }),
        },
        {
          heroId: 'bigfoot', heroName: 'Bigfoot', games: 1, wins: 0,
          byOpponent: heroOpponents({ hard: { games: 1, wins: 0 } }),
        },
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
          {
            heroId: 'king-kong', heroName: 'King Kong', games: 4, wins: 3,
            byOpponent: heroOpponents({ hard: { games: 4, wins: 3 } }),
          },
          {
            heroId: 'medusa', heroName: 'Medusa', games: 2, wins: 1,
            byOpponent: heroOpponents({ hard: { games: 2, wins: 1 } }),
          },
          {
            heroId: 'bigfoot', heroName: 'Bigfoot', games: 1, wins: 0,
            byOpponent: heroOpponents({ hard: { games: 1, wins: 0 } }),
          },
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
          human: { games: 0, wins: 0, draws: 0 },
          // The day-4 draw is a bot game, so the tier row carries it too: the
          // client reads losses off `games - wins - draws` per row (#58).
          bots: [{ difficulty: 'hard', games: 7, wins: 4, draws: 1 }],
        },
        firstPlayer: {
          first: { games: 7, wins: 4, draws: 1 },
          second: { games: 0, wins: 0, draws: 0 },
        },
        // The bot side is a stamped `hard`, so the four wins are all
        // qualifying kills — none of them at 1 HP, all of them 10 turns long.
        clutchWins: 0,
        fastestBotWinTurns: 10,
        // `now` is 2026-08-06 noon: the day-7 game is a future day, off the calendar.
        calendar: [1, 2, 3, 4, 5, 6].map((day) => ({ date: `2026-08-0${day}`, games: 1 })),
        byHeroOpponentHero: [
          {
            heroId: 'king-kong', heroName: 'King Kong',
            opponentHeroId: 'the-mandalorian', opponentHeroName: 'The Mandalorian',
            games: 4, wins: 3, draws: 0,
          },
          {
            heroId: 'medusa', heroName: 'Medusa',
            opponentHeroId: 'the-mandalorian', opponentHeroName: 'The Mandalorian',
            games: 2, wins: 1, draws: 1,
          },
          {
            heroId: 'bigfoot', heroName: 'Bigfoot',
            opponentHeroId: 'the-mandalorian', opponentHeroName: 'The Mandalorian',
            games: 1, wins: 0, draws: 0,
          },
        ],
      });
    });
  });
  describe('bot tier from the pilot label (#58)', () => {
    // The live path stamps no `bot_difficulty` at all — every seat below leaves
    // it unset, exactly as production does, so the tier can only come from the
    // pilot label the engine writes from its running preset.
    const opposition = [
      { id: 'g-tier-easy', pilot: 'bot:easy', winner: 0, draw: false },
      { id: 'g-tier-medium', pilot: 'bot:mc(16,10000ms)', winner: 1, draw: false },
      { id: 'g-tier-hard-legacy', pilot: 'bot:mc(64, 400ms)', winner: 0, draw: false },
      { id: 'g-tier-hard-draw', pilot: 'bot:mc(64,10000ms)', winner: null, draw: true },
      { id: 'g-tier-expert', pilot: 'bot:ismcts(512,10000ms)', winner: 1, draw: false },
      { id: 'g-tier-sweep', pilot: 'bot:mc(sims-32/eps-0.10/depth-2)', winner: 0, draw: false },
    ] as const;

    beforeEach(async () => {
      let day = 1;
      for (const entry of opposition) {
        await ingest(game({
          id: entry.id,
          endedAt: `2026-09-0${day++}T10:00:00.000Z`,
          teams: [
            [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
            [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: entry.pilot }],
          ],
          winner: entry.winner,
          draw: entry.draw,
        }));
      }
    });

    it('splits live bot seats by real tier instead of one blended unknown row', async () => {
      const body = await stats(ALICE);
      expect(body.totalGames).toBe(6);
      // Rows are games desc then tier asc: hard has two games, the rest one.
      expect(body.byOpponentKind).toEqual({
        human: { games: 0, wins: 0, draws: 0 },
        bots: [
          { difficulty: 'hard', games: 2, wins: 1, draws: 1 },
          { difficulty: 'easy', games: 1, wins: 1, draws: 0 },
          { difficulty: 'expert', games: 1, wins: 0, draws: 0 },
          { difficulty: 'medium', games: 1, wins: 0, draws: 0 },
          // Only the knob-grid sweep label stays unknown — it is a point in a
          // parameter search, not a serving preset, so no tier is invented.
          { difficulty: 'unknown', games: 1, wins: 1, draws: 0 },
        ],
      });
    });

    it('lets a stamped bot_difficulty override the label', async () => {
      // The engine-side stamp is filed separately; when it lands it must win
      // over the label archaeology rather than be ignored.
      await pool.query(
        `UPDATE game_seats SET bot_difficulty = 'expert' WHERE game_id = 'g-tier-easy' AND pilot = 'bot:easy'`,
      );
      const body = await stats(ALICE);
      expect(body.byOpponentKind.bots).toContainEqual({
        difficulty: 'expert',
        games: 2,
        wins: 1,
        draws: 0,
      });
      expect(body.byOpponentKind.bots.map((row) => row.difficulty)).not.toContain('easy');
    });

    it('reports the same tiers on the leaderboard as on the player stats', async () => {
      const board = (await (await read('/accounts/leaderboard')).json()) as LeaderboardBody;
      const row = board.players.find((player) => player.playerId === ALICE);
      expect(row?.byOpponentKind).toEqual((await stats(ALICE)).byOpponentKind);
    });
  });

  describe('per-hero opponent-kind breakdown (#63)', () => {
    // One hero played against every opponent kind there is, so the cross of
    // byHero and byOpponentKind can be hand-counted, plus a second hero that
    // must not absorb any of it. The `easy` game is the short one — it is the
    // farming shape `minSeconds` exists to exclude.
    const opposition = [
      { day: 1, hero: 'king-kong', pilot: 'human', playerId: BOB, winner: 0, seconds: 600 },
      { day: 2, hero: 'king-kong', pilot: 'human', playerId: BOB, winner: 1, seconds: 600 },
      { day: 3, hero: 'king-kong', pilot: 'bot:easy', winner: 0, seconds: 30 },
      { day: 4, hero: 'king-kong', pilot: 'bot:mc(16,10000ms)', winner: 0, seconds: 600 },
      { day: 5, hero: 'king-kong', pilot: 'bot:mc(64, 400ms)', winner: 1, seconds: 600 },
      { day: 6, hero: 'king-kong', pilot: 'bot:ismcts(512,10000ms)', winner: 0, seconds: 600 },
      // A knob-grid sweep label: a bot, but no tier any rule claims.
      { day: 7, hero: 'king-kong', pilot: 'bot:mc(sims-32/eps-0.10/depth-2)', winner: 0, seconds: 600 },
      { day: 8, hero: 'medusa', pilot: 'bot:easy', winner: 0, seconds: 600 },
    ] as const;

    beforeEach(async () => {
      for (const entry of opposition) {
        await ingest(game({
          id: `g-cross-${entry.day}`,
          endedAt: `2026-10-0${entry.day}T10:00:00.000Z`,
          durationSeconds: entry.seconds,
          teams: [
            [{ deck: `${entry.hero}@1.0.0`, heroId: entry.hero, pilot: 'human', playerId: ALICE }],
            [{
              deck: 'the-mandalorian@1.0.0',
              heroId: 'the-mandalorian',
              pilot: entry.pilot,
              // A human opponent needs an account id; a bot seat carries none.
              ...('playerId' in entry ? { playerId: entry.playerId } : {}),
            }],
          ],
          winner: entry.winner,
        }));
      }
    });

    /** The breakdown for one hero of the player's `byHero` rows. */
    async function byOpponent(playerId: string, heroId: string): Promise<HeroOpponents | undefined> {
      const body = await stats(playerId);
      return body.byHero.find((row) => row.heroId === heroId)?.byOpponent;
    }

    it('crosses each hero with every opponent kind', async () => {
      const body = await stats(ALICE);
      expect(body.byHero).toEqual([
        {
          heroId: 'king-kong', heroName: 'King Kong', games: 7, wins: 5,
          // Two human games (one won), then one game per tier. Day 7's bot
          // decodes to no tier, so it is counted in `games` above but in no
          // bucket here — 6 bucketed games against 7 played.
          byOpponent: heroOpponents({
            human: { games: 2, wins: 1 },
            easy: { games: 1, wins: 1 },
            medium: { games: 1, wins: 1 },
            hard: { games: 1, wins: 0 },
            expert: { games: 1, wins: 1 },
          }),
        },
        {
          heroId: 'medusa', heroName: 'Medusa', games: 1, wins: 1,
          byOpponent: heroOpponents({ easy: { games: 1, wins: 1 } }),
        },
      ]);
    });

    it('reuses the top-level classification: the buckets roll up to byOpponentKind', async () => {
      const body = await stats(ALICE);
      const rolled = body.byHero.reduce(
        (totals, row) => {
          for (const kind of ['human', 'easy', 'medium', 'hard', 'expert'] as const) {
            totals[kind].games += row.byOpponent[kind].games;
            totals[kind].wins += row.byOpponent[kind].wins;
          }
          return totals;
        },
        structuredClone(NO_HERO_OPPONENTS),
      );

      // The same numbers the global split reports, tier for tier — the two are
      // the same classification grouped differently, not two definitions.
      expect(rolled.human).toEqual({
        games: body.byOpponentKind.human.games,
        wins: body.byOpponentKind.human.wins,
      });
      for (const bot of body.byOpponentKind.bots) {
        if (bot.difficulty === 'unknown') continue; // no key to roll it into
        const bucket = rolled[bot.difficulty as 'easy' | 'medium' | 'hard' | 'expert'];
        expect(bucket).toEqual({ games: bot.games, wins: bot.wins });
      }
      // Day 7 is the only unbucketed game, so the buckets are one short of the total.
      const bucketed = Object.values(rolled).reduce((sum, split) => sum + split.games, 0);
      expect(bucketed).toBe(body.totalGames - 1);
    });

    it('counts a mixed-tier bot side once, under its alphabetically first tier', async () => {
      await pool.query('TRUNCATE game_submissions, sim_campaigns, telemetry_sources CASCADE');
      await ingest(game({
        id: 'g-cross-2v2',
        endedAt: '2026-10-09T10:00:00.000Z',
        teams: [
          [
            { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE },
            { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB },
          ],
          [
            { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard' },
            { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:easy' },
          ],
        ],
        winner: 0,
      }));

      // One game, one bucket — exactly as byOpponentKind reports it, and on
      // Alice's own hero rather than her teammate's.
      expect(await byOpponent(ALICE, 'king-kong')).toEqual(
        heroOpponents({ easy: { games: 1, wins: 1 } }),
      );
      expect(await byOpponent(BOB, 'king-kong')).toBeUndefined();
      expect(await byOpponent(BOB, 'medusa')).toEqual(
        heroOpponents({ easy: { games: 1, wins: 1 } }),
      );
    });

    it('leaves the buckets empty for a hero whose only game had no opposing seat', async () => {
      await pool.query('TRUNCATE game_submissions, sim_campaigns, telemetry_sources CASCADE');
      await ingest(game({
        id: 'g-cross-solo',
        endedAt: '2026-10-10T10:00:00.000Z',
        teams: [[{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }]],
        winner: 0,
      }));

      const body = await stats(ALICE);
      // The game is the player's history and counts in `games`; it classifies
      // into neither bucket, the same producer-bug handling byOpponentKind has.
      expect(body.byHero).toEqual([
        { heroId: 'king-kong', heroName: 'King Kong', games: 1, wins: 1, byOpponent: NO_HERO_OPPONENTS },
      ]);
      expect(body.byOpponentKind).toEqual({ human: { games: 0, wins: 0, draws: 0 }, bots: [] });
    });

    describe('?minSeconds=', () => {
      /** The stats payload with a duration floor applied. */
      async function filtered(seconds: string): Promise<StatsBody> {
        const response = await read(`/accounts/players/${ALICE}/stats?minSeconds=${seconds}`);
        return (await response.json()) as StatsBody;
      }

      it('filters only the breakdown, never the rest of the payload', async () => {
        const unfiltered = await stats(ALICE);
        const body = await filtered('120');

        // The 30-second easy game is the only one under the floor; it leaves
        // king-kong's easy bucket and nothing else in the payload.
        expect(body.byHero).toEqual([
          {
            heroId: 'king-kong', heroName: 'King Kong', games: 7, wins: 5,
            byOpponent: heroOpponents({
              human: { games: 2, wins: 1 },
              medium: { games: 1, wins: 1 },
              hard: { games: 1, wins: 0 },
              expert: { games: 1, wins: 1 },
            }),
          },
          {
            heroId: 'medusa', heroName: 'Medusa', games: 1, wins: 1,
            byOpponent: heroOpponents({ easy: { games: 1, wins: 1 } }),
          },
        ]);
        // Everything outside the breakdown is byte-identical to the unfiltered
        // payload — including the global split, which keeps the easy game.
        expect({ ...body, byHero: null }).toEqual({ ...unfiltered, byHero: null });
        expect(body.byOpponentKind.bots).toContainEqual({
          difficulty: 'easy', games: 2, wins: 2, draws: 0,
        });
      });

      it('drops a game with no reported duration rather than letting it pass the floor', async () => {
        // A producer that omits `durationSeconds` must not be a way around an
        // anti-farm floor: unknown does not read as long enough.
        await pool.query(`UPDATE games SET duration_seconds = NULL WHERE id = 'g-cross-6'`);

        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({
            human: { games: 2, wins: 1 },
            easy: { games: 1, wins: 1 },
            medium: { games: 1, wins: 1 },
            hard: { games: 1, wins: 0 },
            expert: { games: 1, wins: 1 },
          }),
        );

        // The expert game is the one with no duration; every floor above zero
        // excludes it, while the default floor keeps it (asserted just above).
        const body = await filtered('1');
        expect(body.byHero[0]!.byOpponent.expert).toEqual({ games: 0, wins: 0 });
        expect(body.byHero[0]!.games).toBe(7);
      });

      it('treats a blank, negative or unparseable floor as no floor at all', async () => {
        const unfiltered = await stats(ALICE);
        for (const value of ['', '0', '-90', 'soon', 'NaN']) {
          expect(await filtered(value)).toEqual(unfiltered);
        }
        // A fractional floor truncates rather than 400ing; 30.9 still admits
        // the 30-second game, 31.2 does not.
        expect((await filtered('30.9')).byHero[0]!.byOpponent.easy).toEqual({ games: 1, wins: 1 });
        expect((await filtered('31.2')).byHero[0]!.byOpponent.easy).toEqual({ games: 0, wins: 0 });
      });
    });
  });

  describe('cosmetic-point anti-farm rules (#66)', () => {
    // The rules shape `byHero[].byOpponent` only, so every test here reads that
    // block for one hero and then checks the raw record beside it: a rule that
    // leaked into `byHero[].games`/`wins` or `byOpponentKind` would show up as
    // the player's history shrinking, which is not what any of this is for.

    /** Alice on king-kong against one other seat; humans carry an account id. */
    async function duel(options: {
      id: string;
      day: number;
      opponent: { pilot: string; playerId?: string };
      winner: number | null;
      draw?: boolean;
      turns?: number;
      endCondition?: string;
    }): Promise<void> {
      await ingest(game({
        id: options.id,
        endedAt: `2026-11-${String(options.day).padStart(2, '0')}T10:00:00.000Z`,
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{
            deck: 'the-mandalorian@1.0.0',
            heroId: 'the-mandalorian',
            pilot: options.opponent.pilot,
            ...(options.opponent.playerId ? { playerId: options.opponent.playerId } : {}),
          }],
        ],
        winner: options.winner,
        // Spread rather than pass `undefined`: the helper's defaults are what
        // "not specified" means, and exactOptionalPropertyTypes is on.
        ...(options.draw === undefined ? {} : { draw: options.draw }),
        ...(options.turns === undefined ? {} : { turns: options.turns }),
        ...(options.endCondition === undefined ? {} : { endCondition: options.endCondition }),
      }));
    }

    /** A human-vs-human duel; `winner` 0 is Alice, 1 is Bob. */
    function humanDuel(options: {
      id: string;
      day: number;
      winner: number | null;
      draw?: boolean;
      turns?: number;
      endCondition?: string;
    }): Promise<void> {
      return duel({ ...options, opponent: { pilot: 'human', playerId: BOB } });
    }

    /** The breakdown for one hero of the player's `byHero` rows. */
    async function byOpponent(playerId: string, heroId: string): Promise<HeroOpponents | undefined> {
      const body = await stats(playerId);
      return body.byHero.find((row) => row.heroId === heroId)?.byOpponent;
    }

    describe('forfeits', () => {
      beforeEach(async () => {
        // One conceded game and one honest one, so "the conceder earns nothing"
        // is visible as a difference rather than as an empty payload.
        await humanDuel({ id: 'g-66-forfeit', day: 1, winner: 1, endCondition: 'forfeit' });
        await humanDuel({ id: 'g-66-honest', day: 2, winner: 0 });
      });

      it('pays the conceding seat nothing at all — not even the played credit', async () => {
        // Alice conceded day 1: only the honest win she played out is countable.
        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({ human: { games: 1, wins: 1 } }),
        );
      });

      it('pays the seat conceded to the played credit but no win bonus', async () => {
        // Bob won day 1 by forfeit and lost day 2: two games, no countable win.
        expect(await byOpponent(BOB, 'the-mandalorian')).toEqual(
          heroOpponents({ human: { games: 2, wins: 0 } }),
        );
      });

      it('treats every concession-shaped end condition alike, however cased', async () => {
        await humanDuel({ id: 'g-66-timeout', day: 3, winner: 1, endCondition: 'timeout' });
        await humanDuel({ id: 'g-66-disconnect', day: 4, winner: 1, endCondition: 'DISCONNECT' });

        // Still just the honest win — neither concession added anything for Alice.
        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({ human: { games: 1, wins: 1 } }),
        );
        // ...and Bob's three concession wins are three played games, no wins.
        expect(await byOpponent(BOB, 'the-mandalorian')).toEqual(
          heroOpponents({ human: { games: 4, wins: 0 } }),
        );
      });

      it('leaves a draw alone', async () => {
        await humanDuel({
          id: 'g-66-draw', day: 5, winner: null, draw: true, endCondition: 'simultaneous',
        });

        // The draw is a game both seats played to the end: countable, unwon.
        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({ human: { games: 2, wins: 1 } }),
        );
        expect(await byOpponent(BOB, 'the-mandalorian')).toEqual(
          heroOpponents({ human: { games: 3, wins: 0 } }),
        );
      });

      it('leaves the raw record untouched for both seats', async () => {
        const alice = await stats(ALICE);
        expect(alice.byHero).toEqual([
          {
            heroId: 'king-kong', heroName: 'King Kong', games: 2, wins: 1,
            byOpponent: heroOpponents({ human: { games: 1, wins: 1 } }),
          },
        ]);
        expect(alice.byOpponentKind).toEqual({
          human: { games: 2, wins: 1, draws: 0 }, bots: [],
        });
        expect(alice.totalGames).toBe(2);

        const bob = await stats(BOB);
        expect(bob.byHero[0]).toMatchObject({ heroId: 'the-mandalorian', games: 2, wins: 1 });
        expect(bob.byOpponentKind).toEqual({
          human: { games: 2, wins: 1, draws: 0 }, bots: [],
        });
      });
    });

    describe('short human wins', () => {
      it('pays the played credit but no win bonus under five turns', async () => {
        await humanDuel({ id: 'g-66-t2', day: 1, winner: 0, turns: 2 });
        await humanDuel({ id: 'g-66-t4', day: 2, winner: 0, turns: 4 });

        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({ human: { games: 2, wins: 0 } }),
        );
      });

      it('pays the win bonus at exactly five turns', async () => {
        await humanDuel({ id: 'g-66-t5', day: 3, winner: 0, turns: 5 });

        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({ human: { games: 1, wins: 1 } }),
        );
      });

      it('counts a win whose turn count was never reported', async () => {
        // The opposite asymmetry to the `minSeconds` floor, on purpose: a
        // missing `turns` is a producer gap on ordinary games, so unknown
        // passes rather than being read as a two-turn concede.
        await humanDuel({ id: 'g-66-null', day: 4, winner: 0, turns: 12 });
        await pool.query(`UPDATE games SET turns = NULL WHERE id = 'g-66-null'`);

        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({ human: { games: 1, wins: 1 } }),
        );
      });

      it('exempts bot buckets — a two-turn expert kill is a real win', async () => {
        await duel({
          id: 'g-66-bot', day: 5, opponent: { pilot: 'bot:ismcts(512,10000ms)' },
          winner: 0, turns: 2,
        });

        expect(await byOpponent(ALICE, 'king-kong')).toEqual(
          heroOpponents({ expert: { games: 1, wins: 1 } }),
        );
      });

      it('leaves the raw record untouched', async () => {
        await humanDuel({ id: 'g-66-t2', day: 1, winner: 0, turns: 2 });
        await duel({
          id: 'g-66-bot', day: 5, opponent: { pilot: 'bot:ismcts(512,10000ms)' },
          winner: 0, turns: 2,
        });

        const body = await stats(ALICE);
        // Two wins in the history; only the bot one is countable for points.
        expect(body.byHero).toEqual([
          {
            heroId: 'king-kong', heroName: 'King Kong', games: 2, wins: 2,
            byOpponent: heroOpponents({
              human: { games: 1, wins: 0 },
              expert: { games: 1, wins: 1 },
            }),
          },
        ]);
        expect(body.byOpponentKind).toEqual({
          human: { games: 1, wins: 1, draws: 0 },
          bots: [{ difficulty: 'expert', games: 1, wins: 1, draws: 0 }],
        });
        expect(body.totalGames).toBe(2);
      });
    });
  });

  describe('clutch and speedrun records (unbrewed-api#26)', () => {
    // One history holding every way a win can and cannot qualify. Every
    // *excluded* game is deliberately faster than every included one, so a
    // predicate that leaks shows up as a smaller `fastestBotWinTurns` rather
    // than as a passing test.
    const finishes = [
      // Counts twice over: a 1 HP kill against a stamped expert bot.
      { id: 'g-brink', pilot: 'bot:ismcts(512,10000ms)', difficulty: 'expert', winner: 0, health: 1, turns: 11 },
      // Counts for the speed record only — won with health to spare.
      { id: 'g-quick', pilot: 'bot:mc(64,10000ms)', difficulty: 'hard', winner: 0, health: 9, turns: 7 },
      // A forfeit is a win in the data; turn-1 forfeits are real rows in prod.
      { id: 'g-forfeit', pilot: 'bot:ismcts(512,10000ms)', difficulty: 'expert', winner: 0, health: 1, turns: 1, endCondition: 'forfeit' },
      // The starved-hard era: the label decodes to `hard`, the column is unset.
      { id: 'g-legacy', pilot: 'bot:mc(64, 400ms)', difficulty: undefined, winner: 0, health: 1, turns: 3 },
      // Tiers below the bar, stamped or not.
      { id: 'g-easy', pilot: 'bot:easy', difficulty: 'easy', winner: 0, health: 1, turns: 2 },
      // A loss and a draw at 1 HP against exactly the right opponent.
      { id: 'g-loss', pilot: 'bot:ismcts(512,10000ms)', difficulty: 'expert', winner: 1, health: 1, turns: 4 },
      { id: 'g-draw', pilot: 'bot:ismcts(512,10000ms)', difficulty: 'expert', winner: null, health: 1, turns: 2, draw: true },
      // A human opponent is not a bot, however close the finish.
      { id: 'g-human', pilot: 'human', difficulty: undefined, winner: 0, health: 1, turns: 5, humanOpponent: true },
    ] as const;

    beforeEach(async () => {
      let day = 1;
      for (const entry of finishes) {
        await ingest(game({
          id: entry.id,
          endedAt: `2026-10-0${day++}T10:00:00.000Z`,
          teams: [
            [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE, finalHealth: entry.health }],
            [{
              deck: 'the-mandalorian@1.0.0',
              heroId: 'the-mandalorian',
              pilot: entry.pilot,
              finalHealth: entry.winner === 1 ? 4 : 0,
              ...('humanOpponent' in entry && entry.humanOpponent ? { playerId: BOB } : {}),
              ...(entry.difficulty === undefined ? {} : { botDifficulty: entry.difficulty }),
            }],
          ],
          winner: entry.winner,
          draw: 'draw' in entry ? entry.draw : false,
          turns: entry.turns,
          endCondition: 'endCondition' in entry ? entry.endCondition : 'hero_defeated',
        }));
      }
    });

    it('counts only 1 HP kills against a stamped hard or expert bot', async () => {
      const body = await stats(ALICE);
      expect(body.clutchWins).toBe(1);
      // 7 is the quick win; every disqualified game finished faster than that.
      expect(body.fastestBotWinTurns).toBe(7);
    });

    it('starts counting a legacy game the moment the backfill stamps it', async () => {
      // Emyrk/unbrewed-telemetry#60 fills the column in for current-era labels;
      // nothing here needs to change when it does.
      await pool.query(
        `UPDATE game_seats SET bot_difficulty = 'hard' WHERE game_id = 'g-legacy' AND pilot_kind = 'bot'`,
      );
      const body = await stats(ALICE);
      expect(body.clutchWins).toBe(2);
      expect(body.fastestBotWinTurns).toBe(3);
    });

    it('reads a 0-turn producer bug as no record rather than the fastest win ever', async () => {
      await pool.query(`UPDATE games SET turns = 0 WHERE id = 'g-quick'`);
      const body = await stats(ALICE);
      expect(body.fastestBotWinTurns).toBe(11);
    });

    it('reports no record at all for a player who has never won one', async () => {
      const body = await stats(BOB);
      expect(body.clutchWins).toBe(0);
      expect(body.fastestBotWinTurns).toBeNull();
    });
  });

  describe('leaderboard (#56)', () => {
    // Three players sharing games, plus the rows that must never count: a
    // campaign game with a player id on it, and an all-bot game with none.
    beforeEach(async () => {
      // Alice beats Bob, then Bob beats Alice — one game, two leaderboard rows.
      await ingest(game({
        id: 'g-lb-1',
        endedAt: '2026-08-01T10:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB }],
        ],
        winner: 0,
      }));
      await ingest(game({
        id: 'g-lb-2',
        endedAt: '2026-08-02T10:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB }],
        ],
        winner: 1,
      }));
      // Alice alone against a bot.
      await ingest(game({
        id: 'g-lb-3',
        endedAt: '2026-08-03T10:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
        ],
        winner: 0,
      }));
      // Alice on both seats of a 2v2 team — a producer bug, and it must count
      // as one game here exactly as it does in her own stats.
      await ingest(game({
        id: 'g-lb-4',
        endedAt: '2026-08-04T10:00:00.000Z',
        teams: [
          [
            { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE },
            { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: ALICE },
          ],
          [
            { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' },
            { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:hard', botDifficulty: 'hard' },
          ],
        ],
        winner: 0,
      }));
      // Carol's single game, a loss.
      await ingest(game({
        id: 'g-lb-5',
        endedAt: '2026-08-05T10:00:00.000Z',
        teams: [
          [{ deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'human', playerId: CAROL }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
        ],
        winner: 1,
      }));
      // Bob against an easy bot — a different tier from Alice's hard-bot wins,
      // which is exactly what the api needs to price the two differently.
      await ingest(game({
        id: 'g-lb-6',
        endedAt: '2026-08-06T09:00:00.000Z',
        teams: [
          [{ deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:easy', botDifficulty: 'easy' }],
        ],
        winner: 0,
      }));
      // Carol teamed with an anonymous human against a mixed-difficulty bot
      // side: one game, filed under the alphabetically first difficulty.
      await ingest(game({
        id: 'g-lb-7',
        endedAt: '2026-08-06T11:00:00.000Z',
        teams: [
          [
            { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'human', playerId: CAROL },
            { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human' },
          ],
          [
            { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' },
            { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:easy', botDifficulty: 'easy' },
          ],
        ],
        winner: 0,
      }));
      // Nobody signed in: no player id, so no leaderboard row at all.
      await ingest(game({
        id: 'g-lb-bots',
        endedAt: '2026-08-06T10:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:hard', botDifficulty: 'hard' }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' }],
        ],
        winner: 0,
      }));
      // A campaign seat carrying Carol's id: experiment data, never anybody's.
      const campaign = await cpRepo.createCampaign({
        name: 'leaderboard-exclusion-test',
        spec: { note: 'test' },
        baseSeed: 99,
        games: [{ spec: { step: 'test' } }],
        createdBy: 'test',
      });
      await ingest(game({
        id: 'g-lb-campaign',
        endedAt: '2026-08-07T10:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:ismcts', playerId: CAROL }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:mc' }],
        ],
        winner: 0,
      }), campaign.id);
    });

    async function leaderboard(query = ''): Promise<LeaderboardBody> {
      return (await (await read(`/accounts/leaderboard${query}`)).json()) as LeaderboardBody;
    }

    it('401s without the accounts read bearer', async () => {
      const missing = await read('/accounts/leaderboard', null);
      expect(missing.status).toBe(401);
      expect(await errorCode(missing)).toBe('UNAUTHORIZED');

      const wrong = await read('/accounts/leaderboard', 'not-the-token');
      expect(wrong.status).toBe(401);
    });

    it('returns one row per player with a completed game, games desc', async () => {
      expect(await leaderboard()).toEqual({
        ok: true,
        players: [
          // Alice: beat Bob, lost to Bob, beat a hard bot twice (the 2v2 she
          // double-seated counts once, on the hard-bot side).
          {
            playerId: ALICE,
            gamesPlayed: 4,
            wins: 3,
            byOpponentKind: {
              human: { games: 2, wins: 1, draws: 0 },
              bots: [{ difficulty: 'hard', games: 2, wins: 2, draws: 0 }],
            },
            mainHeroId: 'king-kong',
            mainHeroName: 'King Kong',
            recentForm: ['W', 'W', 'L', 'W'],
            currentStreak: 2,
          },
          // Bob: the two games against Alice, plus an easy-bot win.
          {
            playerId: BOB,
            gamesPlayed: 3,
            wins: 2,
            byOpponentKind: {
              human: { games: 2, wins: 1, draws: 0 },
              bots: [{ difficulty: 'easy', games: 1, wins: 1, draws: 0 }],
            },
            mainHeroId: 'medusa',
            mainHeroName: 'Medusa',
            recentForm: ['W', 'W', 'L'],
            currentStreak: 2,
          },
          // Carol: never faced a human — the mixed bot side files under 'easy'.
          {
            playerId: CAROL,
            gamesPlayed: 2,
            wins: 1,
            byOpponentKind: {
              human: { games: 0, wins: 0, draws: 0 },
              bots: [
                { difficulty: 'easy', games: 1, wins: 1, draws: 0 },
                { difficulty: 'hard', games: 1, wins: 0, draws: 0 },
              ],
            },
            // The campaign game carrying her id would make this W, W, L.
            mainHeroId: 'bigfoot',
            mainHeroName: 'Bigfoot',
            recentForm: ['W', 'L'],
            currentStreak: 1,
          },
        ],
      });
    });

    it('matches what each player\'s own stats report', async () => {
      const body = await leaderboard();
      expect(body.players.length).toBe(3);
      for (const row of body.players) {
        const own = await stats(row.playerId);
        expect({ gamesPlayed: own.totalGames, wins: own.wins }).toEqual({
          gamesPlayed: row.gamesPlayed,
          wins: row.wins,
        });
        // The split the api prices XP with must be the same object, rows and
        // order included — otherwise leaderboard XP drifts from /me/stats XP.
        expect(row.byOpponentKind).toEqual(own.byOpponentKind);
      }
    });

    it('respects ?limit= and defaults to unlimited', async () => {
      expect((await leaderboard('?limit=2')).players.map((p) => p.playerId)).toEqual([ALICE, BOB]);
      expect((await leaderboard('?limit=1')).players).toEqual([
        {
          playerId: ALICE,
          gamesPlayed: 4,
          wins: 3,
          byOpponentKind: {
            human: { games: 2, wins: 1, draws: 0 },
            bots: [{ difficulty: 'hard', games: 2, wins: 2, draws: 0 }],
          },
          mainHeroId: 'king-kong',
          mainHeroName: 'King Kong',
          recentForm: ['W', 'W', 'L', 'W'],
          currentStreak: 2,
        },
      ]);
      // A blank, unparseable, or non-positive limit is "no cap", not zero rows.
      for (const query of ['', '?limit=', '?limit=abc', '?limit=0', '?limit=-5']) {
        expect((await leaderboard(query)).players.length).toBe(3);
      }
    });

    // The api prices leaderboard XP off these four fields (contract §1d/§4), so
    // the dashboard additions must leave them byte-for-byte as they were. The
    // literal is the raw #56 body this fixture produced before T2, with only
    // the T2 keys deleted from each row (served key order kept).
    it('leaves the XP-priced fields byte-identical, with or without ?since=', async () => {
      const LEGACY_PLAYERS =
        '[{"playerId":"11111111-1111-4111-8111-111111111111","gamesPlayed":4,"wins":3,' +
        '"byOpponentKind":{"human":{"games":2,"wins":1,"draws":0},' +
        '"bots":[{"difficulty":"hard","games":2,"wins":2,"draws":0}]}},' +
        '{"playerId":"22222222-2222-4222-8222-222222222222","gamesPlayed":3,"wins":2,' +
        '"byOpponentKind":{"human":{"games":2,"wins":1,"draws":0},' +
        '"bots":[{"difficulty":"easy","games":1,"wins":1,"draws":0}]}},' +
        '{"playerId":"33333333-3333-4333-8333-333333333333","gamesPlayed":2,"wins":1,' +
        '"byOpponentKind":{"human":{"games":0,"wins":0,"draws":0},' +
        '"bots":[{"difficulty":"easy","games":1,"wins":1,"draws":0},' +
        '{"difficulty":"hard","games":1,"wins":0,"draws":0}]}}]';
      const t2Keys = ['mainHeroId', 'mainHeroName', 'recentForm', 'currentStreak', 'windowGames', 'windowWins'];
      for (const query of ['', '?since=2026-08-03T00:00:00.000Z', '?since=2000-01-01']) {
        const body = JSON.parse(await (await read(`/accounts/leaderboard${query}`)).text()) as {
          players: Array<Record<string, unknown>>;
        };
        for (const row of body.players) for (const key of t2Keys) delete row[key];
        expect(JSON.stringify(body.players)).toBe(LEGACY_PLAYERS);
      }
    });
  });

  // Stats dashboard T2 (contract §1c/§1d). Each fixture carries the contract's
  // mandatory rows — a campaign game, a bot-vs-bot game, a 2v2 with a human, a
  // casual-bot game, an unknown-tier bot and a human-vs-human game — and the
  // tests say what each one does to the new fields.
  describe('stats dashboard T2: player calendar and own-hero grid', () => {
    // `now` is 2026-08-06T12:00Z, so the 182-day window is 2026-02-06..2026-08-06.
    beforeEach(async () => {
      // Human vs human, one second before the window opens: in the grid, off the calendar.
      await ingest(game({
        id: 'g-t2-out',
        endedAt: '2026-02-05T23:59:59.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB }],
        ],
        winner: 0,
      }));
      // Casual bot, on the window's first instant (day 182): counted everywhere.
      await ingest(game({
        id: 'g-t2-in',
        endedAt: '2026-02-06T00:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:easy', botDifficulty: 'easy' }],
        ],
        winner: 0,
      }));
      // An unknown-tier bot, then a human-vs-human draw, on the same day.
      await ingest(game({
        id: 'g-t2-unknown',
        endedAt: '2026-08-05T10:00:00.000Z',
        teams: [
          [{ deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: ALICE }],
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:mystery' }],
        ],
        winner: 1,
      }));
      await ingest(game({
        id: 'g-t2-draw',
        endedAt: '2026-08-05T12:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE }],
          [{ deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: BOB }],
        ],
        winner: null,
        draw: true,
      }));
      // A 2v2 with a human teammate: on the calendar, never in the duel grid.
      await ingest(game({
        id: 'g-t2-2v2',
        endedAt: '2026-08-06T09:00:00.000Z',
        teams: [
          [
            { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: ALICE },
            { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human' },
          ],
          [
            { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' },
            { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:hard', botDifficulty: 'hard' },
          ],
        ],
        winner: 0,
      }));
      // Bot vs bot: nobody's.
      await ingest(game({
        id: 'g-t2-bots',
        endedAt: '2026-08-06T10:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:hard', botDifficulty: 'hard' }],
          [{ deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'bot:hard', botDifficulty: 'hard' }],
        ],
        winner: 0,
      }));
      // A campaign seat carrying Alice's id, inside the window: excluded from both.
      const campaign = await cpRepo.createCampaign({
        name: 't2-calendar-exclusion-test',
        spec: { note: 'test' },
        baseSeed: 7,
        games: [{ spec: { step: 'test' } }],
        createdBy: 'test',
      });
      await ingest(game({
        id: 'g-t2-campaign',
        endedAt: '2026-08-06T11:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:ismcts', playerId: ALICE }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:mc' }],
        ],
        winner: 0,
      }), campaign.id);
    });

    it('counts games per UTC day over the last 182 days, oldest first, non-empty days only', async () => {
      const body = await stats(ALICE);
      expect(body.calendar).toEqual([
        { date: '2026-02-06', games: 1 }, // day 182: in
        { date: '2026-08-05', games: 2 },
        { date: '2026-08-06', games: 1 }, // the 2v2; the campaign game is not counted
      ]);
      // Day 183 is out of the calendar but still in the lifetime totals.
      expect(body.totalGames).toBe(5);
    });

    it('crosses own hero with the opposing hero over duels only, games desc', async () => {
      const body = await stats(ALICE);
      expect(body.byHeroOpponentHero).toEqual([
        {
          heroId: 'king-kong', heroName: 'King Kong',
          opponentHeroId: 'medusa', opponentHeroName: 'Medusa',
          games: 2, wins: 1, draws: 1,
        },
        {
          heroId: 'king-kong', heroName: 'King Kong',
          opponentHeroId: 'bigfoot', opponentHeroName: 'Bigfoot',
          games: 1, wins: 1, draws: 0,
        },
        {
          heroId: 'medusa', heroName: 'Medusa',
          opponentHeroId: 'king-kong', opponentHeroName: 'King Kong',
          games: 1, wins: 0, draws: 0,
        },
      ]);
      // The 2v2 is the only game against the Mandalorian: absent from the grid,
      // present in the all-format opponent table.
      expect(body.byHeroOpponentHero.some((row) => row.opponentHeroId === 'the-mandalorian')).toBe(false);
      expect(body.byOpponentHero.some((row) => row.heroId === 'the-mandalorian')).toBe(true);
    });
  });

  describe('stats dashboard T2: leaderboard row extras and ?since=', () => {
    // Dave, oldest first: six real games (W L W W L W) plus a campaign win that
    // must not count. Heroes: king-kong x2 (1 win), medusa x2 (2 wins), bigfoot
    // x1, the 2v2 on thetis x1. Eve: one king-kong loss, one bigfoot loss.
    beforeEach(async () => {
      const duel = (id: string, endedAt: string, mine: SeatSpec, theirs: SeatSpec, winner: number) =>
        ingest(game({ id, endedAt, teams: [[mine], [theirs]], winner }));
      await duel('g-lb2-1', '2026-07-01T10:00:00.000Z',
        { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: DAVE },
        { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: EVE }, 0);
      await duel('g-lb2-2', '2026-07-02T10:00:00.000Z',
        { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'human', playerId: DAVE },
        { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'bot:easy', botDifficulty: 'easy' }, 1);
      await duel('g-lb2-3', '2026-08-01T10:00:00.000Z',
        { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: DAVE },
        { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:hard', botDifficulty: 'hard' }, 0);
      await duel('g-lb2-4', '2026-08-02T10:00:00.000Z',
        { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human', playerId: DAVE },
        { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:easy', botDifficulty: 'easy' }, 0);
      await duel('g-lb2-5', '2026-08-03T10:00:00.000Z',
        { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'human', playerId: DAVE },
        { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'bot:mystery' }, 1);
      await ingest(game({
        id: 'g-lb2-6',
        endedAt: '2026-08-04T10:00:00.000Z',
        teams: [
          [
            { deck: 'thetis@1.0.0', heroId: 'thetis', pilot: 'human', playerId: DAVE },
            { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'human' },
          ],
          [
            { deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:hard', botDifficulty: 'hard' },
            { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'bot:hard', botDifficulty: 'hard' },
          ],
        ],
        winner: 0,
      }));
      await duel('g-lb2-eve', '2026-08-02T12:00:00.000Z',
        { deck: 'bigfoot@1.0.0', heroId: 'bigfoot', pilot: 'human', playerId: EVE },
        { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'bot:medium', botDifficulty: 'medium' }, 1);
      await duel('g-lb2-bots', '2026-08-05T10:00:00.000Z',
        { deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:hard', botDifficulty: 'hard' },
        { deck: 'medusa@1.0.0', heroId: 'medusa', pilot: 'bot:hard', botDifficulty: 'hard' }, 0);
      // Would make king-kong Dave's main hero (3 games) and his form W, W, L, … .
      const campaign = await cpRepo.createCampaign({
        name: 't2-leaderboard-exclusion-test',
        spec: { note: 'test' },
        baseSeed: 8,
        games: [{ spec: { step: 'test' } }],
        createdBy: 'test',
      });
      await ingest(game({
        id: 'g-lb2-campaign',
        endedAt: '2026-08-05T11:00:00.000Z',
        teams: [
          [{ deck: 'king-kong@1.0.0', heroId: 'king-kong', pilot: 'bot:ismcts', playerId: DAVE }],
          [{ deck: 'the-mandalorian@1.0.0', heroId: 'the-mandalorian', pilot: 'bot:mc' }],
        ],
        winner: 0,
      }), campaign.id);
    });

    async function board(query = ''): Promise<LeaderboardBody['players']> {
      return ((await (await read(`/accounts/leaderboard${query}`)).json()) as LeaderboardBody).players;
    }

    function row(players: LeaderboardBody['players'], playerId: string) {
      const found = players.find((player) => player.playerId === playerId);
      if (!found) throw new Error(`no leaderboard row for ${playerId}`);
      return found;
    }

    it('picks the main hero by games, then wins, then hero id', async () => {
      const players = await board();
      // Dave: king-kong and medusa tie on 2 games; medusa has more wins.
      expect(row(players, DAVE)).toMatchObject({ mainHeroId: 'medusa', mainHeroName: 'Medusa' });
      // Eve: king-kong and bigfoot tie on games and wins; bigfoot sorts first.
      expect(row(players, EVE)).toMatchObject({ mainHeroId: 'bigfoot', mainHeroName: 'Bigfoot' });
    });

    it('caps recentForm at 5 and agrees with each player\'s own stats', async () => {
      const players = await board();
      // Six games, newest first W L W W L | W — the oldest drops off.
      expect(row(players, DAVE)).toMatchObject({ recentForm: ['W', 'L', 'W', 'W', 'L'], currentStreak: 1 });
      expect(row(players, EVE)).toMatchObject({ recentForm: ['L', 'L'], currentStreak: 0 });
      for (const player of players) {
        const own = await stats(player.playerId);
        expect(player.recentForm).toEqual(own.recentForm.slice(0, 5));
        expect(player.currentStreak).toBe(own.streaks.current);
      }
    });

    it('omits windowGames/windowWins without ?since=', async () => {
      for (const player of await board()) {
        expect(player).not.toHaveProperty('windowGames');
        expect(player).not.toHaveProperty('windowWins');
      }
    });

    it('counts games since ?since= and excludes casual bot opponents', async () => {
      const players = await board('?since=2026-08-01T00:00:00.000Z');
      // Dave since Aug 1: hard W, easy W (casual, out), unknown-tier L (not
      // casual, in), 2v2 vs hard W. The campaign win is never counted.
      expect(row(players, DAVE)).toMatchObject({ windowGames: 3, windowWins: 2 });
      // Eve's only window game is against a medium bot: a zero row, not a missing one.
      expect(row(players, EVE)).toMatchObject({ windowGames: 0, windowWins: 0 });
      // All-time: Dave's July human win counts, his July easy-bot loss does not.
      const allTime = await board('?since=2000-01-01');
      expect(row(allTime, DAVE)).toMatchObject({ windowGames: 4, windowWins: 3 });
      expect(row(allTime, EVE)).toMatchObject({ windowGames: 1, windowWins: 0 });
      // A window that starts after everything is zero, and the lifetime fields are untouched.
      const future = await board('?since=2026-09-01T00:00:00Z');
      expect(row(future, DAVE)).toMatchObject({ gamesPlayed: 6, wins: 4, windowGames: 0, windowWins: 0 });
    });

    it('400s BAD_SINCE on a since that is not an ISO timestamp', async () => {
      for (const since of ['yesterday', '', '2026-08-01T00:00', '2026-13-45', '1722470400000']) {
        const response = await read(`/accounts/leaderboard?since=${encodeURIComponent(since)}`);
        expect(response.status).toBe(400);
        expect(await errorCode(response)).toBe('BAD_SINCE');
      }
    });
  });
  describe('community aggregates (stats dashboard #72)', () => {
    const KK = 'king-kong';
    const MANDO = 'the-mandalorian';
    const THETIS = 'thetis';
    const seat = (heroId: string, pilot: string, extra: Partial<SeatSpec> = {}): SeatSpec => ({
      deck: `${heroId}@1.0.0`,
      heroId,
      pilot,
      ...extra,
    });
    const duel = (id: string, endedAt: string, a: SeatSpec, b: SeatSpec, winner: number | null) =>
      game({ id, endedAt, teams: [[a], [b]], winner, draw: winner === null });

    // `now` is 2026-08-06 (Thu): month window starts 2026-08-01, the current
    // week starts Mon 2026-08-03.
    beforeEach(async () => {
      const campaign = await cpRepo.createCampaign({
        name: 'community-exclusion-test',
        spec: { note: 'test' },
        baseSeed: 72,
        games: [{ spec: { step: 'test' } }],
        createdBy: 'test',
      });
      // --- excluded by Q ---
      // Campaign game with a human seat.
      await ingest(duel('c-campaign', '2026-08-02T09:00:00.000Z',
        seat(KK, 'human', { playerId: ALICE }), seat(MANDO, 'bot:hard'), 0), campaign.id);
      // Bot-vs-bot duel.
      await ingest(duel('c-botbot', '2026-08-02T09:00:00.000Z', seat(KK, 'bot:easy'), seat(MANDO, 'bot:hard'), 0));
      // 2v2 with a human.
      await ingest(game({
        id: 'c-2v2',
        endedAt: '2026-08-02T09:00:00.000Z',
        teams: [
          [seat(KK, 'human', { playerId: ALICE }), seat(THETIS, 'bot:easy')],
          [seat(MANDO, 'bot:hard'), seat('nancy-drew', 'bot:hard')],
        ],
        winner: 0,
      }));

      // --- qualifying duels ---
      await ingest(duel('c-hvh', '2026-08-02T10:00:00.000Z',
        seat(KK, 'human', { playerId: ALICE }), seat(MANDO, 'human', { playerId: BOB }), 0));
      await ingest(duel('c-easy', '2026-08-03T10:00:00.000Z',
        seat(MANDO, 'human', { playerId: BOB }), seat(KK, 'bot:easy'), 0));
      await ingest(duel('c-medium', '2026-08-04T10:00:00.000Z',
        seat(THETIS, 'human', { playerId: CAROL }), seat(MANDO, 'bot:medium'), 1));
      await ingest(duel('c-hard', '2026-08-04T11:00:00.000Z',
        seat(MANDO, 'human', { playerId: BOB }), seat(THETIS, 'bot:hard', { botDifficulty: 'hard' }), 0));
      await ingest(duel('c-expert', '2026-08-05T10:00:00.000Z',
        seat(KK, 'human', { playerId: ALICE }), seat(MANDO, 'bot:ismcts(512,10000ms)'), 0));
      // A knob-grid label no tier rule claims: `unknown`, priced as hardExpert.
      // Guest human (no player id): counts for hero usage, never for pilots.
      await ingest(duel('c-unknown', '2026-08-05T11:00:00.000Z',
        seat(THETIS, 'human'), seat(KK, 'bot:mc(sims-8/eps-1/depth-2)'), 1));
      // Legacy label decoded to hard; a draw.
      await ingest(duel('c-draw', '2026-08-05T12:00:00.000Z',
        seat(THETIS, 'human', { playerId: CAROL }), seat(KK, 'bot:mc(64, 400ms)'), null));
      // Last month: in `all`, out of `month`.
      await ingest(duel('c-lastmonth', '2026-07-20T10:00:00.000Z',
        seat(KK, 'human', { playerId: ALICE }), seat(THETIS, 'bot:easy'), 0));
      // Dave ties Alice on King Kong wins (3) but in more games (4).
      for (const [id, endedAt, winner] of [
        ['c-dave-1', '2026-08-01T10:00:00.000Z', 0],
        ['c-dave-2', '2026-08-01T11:00:00.000Z', 0],
        ['c-dave-3', '2026-08-02T11:00:00.000Z', 1],
        ['c-dave-4', '2026-08-03T11:00:00.000Z', 0],
      ] as const) {
        await ingest(duel(id, endedAt, seat(KK, 'human', { playerId: DAVE }), seat(MANDO, 'bot:hard'), winner));
      }
      // Eve ties Bob on Mandalorian wins and games (2/3) but got there first.
      for (const [id, endedAt, winner] of [
        ['c-eve-1', '2026-08-01T12:00:00.000Z', 0],
        ['c-eve-2', '2026-08-02T12:00:00.000Z', 0],
        ['c-eve-3', '2026-08-03T12:00:00.000Z', 1],
      ] as const) {
        await ingest(duel(id, endedAt, seat(MANDO, 'human', { playerId: EVE }), seat(THETIS, 'bot:easy'), winner));
      }
    });

    async function communityBody(query = ''): Promise<CommunityBody> {
      const response = await read(`/accounts/community${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as CommunityBody;
    }

    async function heroBody(heroId: string, query = ''): Promise<HeroBody> {
      const response = await read(`/accounts/heroes/${heroId}${query}`);
      expect(response.status).toBe(200);
      return (await response.json()) as HeroBody;
    }

    it('401s without the bearer, 400s a bad window, and 503s when unconfigured', async () => {
      for (const path of ['/accounts/community', `/accounts/heroes/${KK}`]) {
        const missing = await read(path, null);
        expect(missing.status).toBe(401);
        expect(await errorCode(missing)).toBe('UNAUTHORIZED');
        expect((await read(path, 'not-the-token')).status).toBe(401);

        const bad = await read(`${path}?window=week`);
        expect(bad.status).toBe(400);
        expect(await errorCode(bad)).toBe('BAD_WINDOW');
      }

      const unconfigured = createServer(createApp({ repo, cpRepo, config: appConfig(now, '') }));
      await new Promise<void>((resolve) => unconfigured.listen(0, resolve));
      try {
        const address = unconfigured.address();
        if (!address || typeof address === 'string') throw new Error('expected TCP address');
        for (const path of ['/accounts/community', `/accounts/heroes/${KK}`]) {
          const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
            headers: { authorization: `Bearer ${READ_TOKEN}` },
          });
          expect(response.status).toBe(503);
          expect(await errorCode(response)).toBe('AUTH_NOT_CONFIGURED');
        }
      } finally {
        await new Promise<void>((resolve, reject) => unconfigured.close((e) => (e ? reject(e) : resolve())));
      }
    });

    it('counts only qualifying duels, by game kind, over all time', async () => {
      const body = await communityBody();
      expect(body.ok).toBe(true);
      expect(body.window).toBe('all');
      expect(body.windowStart).toBeNull();
      expect(body.generatedAt).toBe(now.toISOString());
      // 15 Q games: campaign, bot-vs-bot and 2v2 excluded. Human-vs-human is one
      // game; unknown tier and the legacy hard label are hardExpert.
      expect(body.totals).toEqual({
        games: 15,
        human: 1,
        hardExpert: 8,
        casual: 6,
        humanVsExpert: { games: 1, wins: 1 },
      });
    });

    it('scopes totals, heroes, crowns and matchups to the current UTC month', async () => {
      const body = await communityBody('?window=month');
      expect(body.window).toBe('month');
      expect(body.windowStart).toBe('2026-08-01T00:00:00.000Z');
      expect(body.totals).toEqual({
        games: 14,
        human: 1,
        hardExpert: 8,
        casual: 5,
        humanVsExpert: { games: 1, wins: 1 },
      });
      const kk = body.heroes.find((hero) => hero.heroId === KK)!;
      expect(kk).toMatchObject({ games: 6, wins: 5, draws: 0 });
      // Alice's July win falls out: Dave's 3 wins now beat her 2.
      expect(kk.crown).toEqual({ playerId: DAVE, wins: 3, games: 4 });
      expect(body.matchups.find((m) => m.heroId === KK && m.opponentHeroId === THETIS)).toEqual({
        heroId: KK, opponentHeroId: THETIS, games: 2, wins: 1, draws: 1,
      });
    });

    it('always returns 12 zero-filled Monday weeks, oldest first, whatever the window', async () => {
      const all = await communityBody();
      const month = await communityBody('?window=month');
      expect(month.weekly).toEqual(all.weekly);
      expect(all.weekly).toHaveLength(12);
      expect(all.weekly[0]!.weekStart).toBe('2026-05-18');
      expect(all.weekly[11]!.weekStart).toBe('2026-08-03');
      for (const week of all.weekly) expect(new Date(`${week.weekStart}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(all.weekly.slice(9)).toEqual([
        { weekStart: '2026-07-20', human: 0, hardExpert: 0, casual: 1 },
        { weekStart: '2026-07-27', human: 1, hardExpert: 3, casual: 2 },
        { weekStart: '2026-08-03', human: 0, hardExpert: 5, casual: 3 },
      ]);
      for (const week of all.weekly.slice(0, 9)) {
        expect(week).toMatchObject({ human: 0, hardExpert: 0, casual: 0 });
      }
    });

    it('counts hero usage as human seat-games, with crowns and their tiebreaks', async () => {
      const body = await communityBody();
      expect(body.heroes).toEqual([
        // Alice 3W/3G beats Dave 3W/4G on fewer games.
        { heroId: KK, heroName: 'King Kong', games: 7, wins: 6, draws: 0, crown: { playerId: ALICE, wins: 3, games: 3 } },
        // Both human seats of the human-vs-human game count. Eve and Bob are
        // 2W/3G; Eve reached two wins first.
        {
          heroId: MANDO, heroName: 'The Mandalorian', games: 6, wins: 4, draws: 0,
          crown: { playerId: EVE, wins: 2, games: 3 },
        },
        // No signed-in winner: unclaimed.
        { heroId: THETIS, heroName: 'Thetis', games: 3, wins: 0, draws: 1, crown: null },
      ]);
    });

    it('returns a symmetric matchup grid over all seats, without mirrors or excluded games', async () => {
      const body = await communityBody();
      expect(body.matchups).toEqual([
        { heroId: KK, opponentHeroId: MANDO, games: 7, wins: 5, draws: 0 },
        { heroId: MANDO, opponentHeroId: KK, games: 7, wins: 2, draws: 0 },
        { heroId: MANDO, opponentHeroId: THETIS, games: 5, wins: 4, draws: 0 },
        { heroId: THETIS, opponentHeroId: MANDO, games: 5, wins: 1, draws: 0 },
        { heroId: KK, opponentHeroId: THETIS, games: 3, wins: 2, draws: 1 },
        { heroId: THETIS, opponentHeroId: KK, games: 3, wins: 0, draws: 1 },
      ]);
      for (const cell of body.matchups) {
        const mirror = body.matchups.find((m) => m.heroId === cell.opponentHeroId && m.opponentHeroId === cell.heroId);
        expect(mirror?.games).toBe(cell.games);
        expect(cell.heroId).not.toBe(cell.opponentHeroId);
      }
    });

    it('serves one hero page: pilots, crown, matchup row and opponent kinds', async () => {
      const body = await heroBody(KK);
      expect(body).toEqual({
        ok: true,
        heroId: KK,
        heroName: 'King Kong',
        window: 'all',
        windowStart: null,
        generatedAt: now.toISOString(),
        games: 7,
        wins: 6,
        draws: 0,
        totalHumanSeatGames: 16,
        pilotCount: 2,
        pilots: [
          { playerId: ALICE, games: 3, wins: 3, draws: 0 },
          { playerId: DAVE, games: 4, wins: 3, draws: 0 },
        ],
        crown: { playerId: ALICE, games: 3, wins: 3, draws: 0 },
        matchups: [
          { opponentHeroId: MANDO, opponentHeroName: 'The Mandalorian', games: 7, wins: 5, draws: 0 },
          { opponentHeroId: THETIS, opponentHeroName: 'Thetis', games: 3, wins: 2, draws: 1 },
        ],
        byOpponentKind: { human: 1, hardExpert: 5, casual: 1 },
      });

      const month = await heroBody(KK, '?window=month');
      expect(month).toMatchObject({
        windowStart: '2026-08-01T00:00:00.000Z',
        games: 6,
        wins: 5,
        totalHumanSeatGames: 15,
        pilots: [
          { playerId: DAVE, games: 4, wins: 3, draws: 0 },
          { playerId: ALICE, games: 2, wins: 2, draws: 0 },
        ],
        crown: { playerId: DAVE, games: 4, wins: 3, draws: 0 },
        byOpponentKind: { human: 1, hardExpert: 5, casual: 0 },
      });
    });

    it('orders pilots by the crown tiebreak and leaves a winless ladder uncrowned', async () => {
      expect((await heroBody(MANDO)).pilots.map((pilot) => pilot.playerId)).toEqual([EVE, BOB]);
      const thetis = await heroBody(THETIS);
      // The guest seat counts for usage but is not a pilot.
      expect(thetis).toMatchObject({
        games: 3,
        pilotCount: 1,
        pilots: [{ playerId: CAROL, games: 2, wins: 0, draws: 1 }],
        crown: null,
        byOpponentKind: { human: 0, hardExpert: 2, casual: 1 },
      });
    });

    it('answers an unknown hero with zeros, not a 404', async () => {
      expect(await heroBody('no-such-hero')).toEqual({
        ok: true,
        heroId: 'no-such-hero',
        heroName: null,
        window: 'all',
        windowStart: null,
        generatedAt: now.toISOString(),
        games: 0,
        wins: 0,
        draws: 0,
        totalHumanSeatGames: 16,
        pilotCount: 0,
        pilots: [],
        crown: null,
        matchups: [],
        byOpponentKind: { human: 0, hardExpert: 0, casual: 0 },
      });
    });
  });
});
