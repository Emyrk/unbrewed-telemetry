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
}

/** The leaderboard payload unbrewed-api ranks by XP (#56). */
interface LeaderboardBody {
  ok: true;
  players: Array<{
    playerId: string;
    gamesPlayed: number;
    wins: number;
    byOpponentKind: StatsBody['byOpponentKind'];
  }>;
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
        },
      ]);
      // A blank, unparseable, or non-positive limit is "no cap", not zero rows.
      for (const query of ['', '?limit=', '?limit=abc', '?limit=0', '?limit=-5']) {
        expect((await leaderboard(query)).players.length).toBe(3);
      }
    });
  });
});
