/**
 * Accounts read API queries (#52).
 *
 * Server-to-server reads for the unbrewed accounts service (unbrewed-api),
 * which shows a signed-in player their own game history and stats. Keyed on
 * `game_seats.player_id` — the pseudonymous account uuid the engine stamps on a
 * signed-in player's seat (migration 001, populated since unbrewed-engine#345).
 *
 * Two invariants hold for everything in this file:
 *
 * 1. **Sim/campaign games never appear.** Every query filters
 *    `games.campaign_id IS NULL`. Simulation games are experiment data played
 *    by bots; they are not anybody's history, and a campaign row could only
 *    carry a player_id by producer bug.
 * 2. **Read-only.** No statement here writes.
 *
 * A player id that has never played is not an error: it yields empty results,
 * because the accounts service knows its own user ids and telemetry does not.
 *
 * Everything here is single-player (`WHERE s.player_id = $1`) except the
 * leaderboard aggregate (#56), which groups the same predicates across players
 * so a leaderboard row equals that player's own stats row, and the community
 * aggregates at the bottom (#72), which read only qualifying duels (Q).
 */

import type { Pool } from 'pg';
import { botTierSql, UNKNOWN_BOT_TIER } from './bot-tier.js';

/** Default page size for the games feed when the caller does not ask. */
export const PLAYER_GAMES_DEFAULT_LIMIT = 20;
/** Hard cap on page size, whatever the caller asks for. */
export const PLAYER_GAMES_MAX_LIMIT = 50;

/** No duration floor: `byHero[].byOpponent` counts every game, however short. */
export const PLAYER_STATS_DEFAULT_MIN_SECONDS = 0;

/**
 * End conditions that mean a seat *gave the game away* rather than lost it (#66).
 *
 * A concession is worth nothing to either side of the cosmetics point ledger:
 * two accounts trading instant concedes is the cheapest human-vs-human farm
 * there is. Kept as a list rather than `<> 'hero_defeated'` because the engine
 * also ends games in ways that are neither a kill nor a concession
 * (`simultaneous` — a draw — and `objective`), and those stay countable.
 * Compared case-insensitively: `endCondition` is a free-form producer string
 * (schema `game-submission.v1`), stored exactly as it arrives.
 */
export const CONCESSION_END_CONDITIONS = ['forfeit', 'timeout', 'disconnect'];

/**
 * A win against a human in fewer than this many turns pays no win bonus (#66).
 *
 * Bot buckets are exempt: a 2-turn kill on an expert bot is a real result, and
 * a bot cannot agree to lose. Only the human bucket is collusion-shaped.
 */
export const MIN_HUMAN_WIN_TURNS = 5;

/** Days the activity calendar covers, today (UTC) included. */
export const PLAYER_CALENDAR_DAYS = 182;

/** Format ids a 1v1 matchup grid reads: the production id and the mock label. */
const DUEL_FORMATS = ['duel', '1v1'];

export interface PlayerGameSeat {
  heroId: string | null;
  heroName: string | null;
  won: boolean;
  finalHealth: number | null;
}

export interface PlayerGameOpponent {
  heroId: string | null;
  heroName: string | null;
  pilot: string;
  botDifficulty: string | null;
}

export interface PlayerGame {
  id: string;
  endedAt: string;
  map: string;
  turns: number | null;
  durationSeconds: number | null;
  endCondition: string | null;
  draw: boolean;
  you: PlayerGameSeat;
  opponents: PlayerGameOpponent[];
}

export interface PlayerGamesPage {
  games: PlayerGame[];
  /** Opaque cursor for the next page, or null when the history is exhausted. */
  nextBefore: string | null;
}

/**
 * games/wins for one hero against one kind of opposition (#63).
 *
 * No `draws`: the cosmetics point system this feeds (unbrewed-p2p#610) pays per
 * *win* against a tier, and the top-level `byOpponentKind` already carries the
 * draw counts for anyone deriving a record.
 */
export interface PlayerHeroOpponentSplit {
  games: number;
  wins: number;
}

/**
 * The player's record on one hero, split by who they played against.
 *
 * Fixed keys, always present and zeroed when unplayed, so the caller can index
 * a tier without a lookup. Two kinds of game are deliberately in *no* bucket,
 * which is why these can sum to less than the row's `games`:
 *
 * - a bot game whose tier decodes to `unknown` (a label no rule in
 *   `bot-tier.ts` claims) — the tier is not guessed at here any more than it is
 *   in `byOpponentKind`, and there is no key to invent one into;
 * - a game with no opposing seat at all (a producer bug), exactly as
 *   `byOpponentKind` drops it.
 *
 * A non-zero `minSeconds` filter takes more games out of the buckets on top of
 * that — see {@link playerStats}.
 *
 * **These counts are what the cosmetics point system may pay for (#66)**, not
 * the raw record: `byHero[].games`/`wins` and `byOpponentKind` stay unfiltered.
 * Two per-game anti-farm rules apply here and nowhere else in the payload:
 *
 * - **Concessions** ({@link CONCESSION_END_CONDITIONS}). The seat that conceded
 *   counts toward neither `games` nor `wins`; the seat that was conceded to
 *   counts toward `games` but earns no `wins`. Nobody profits from a concede,
 *   in either direction. Draws (`simultaneous`) are untouched.
 * - **Short human wins** ({@link MIN_HUMAN_WIN_TURNS}). A win in the `human`
 *   bucket that took fewer than 5 turns counts toward `games` but not `wins`.
 *   Bot buckets are exempt. `turns` NULL passes — unlike the duration floor,
 *   unknown reads as long enough here, because a missing `turns` is a producer
 *   gap on real games and the concession rule already covers the farm shape a
 *   colluding pair can actually reach.
 */
export interface PlayerHeroOpponentStats {
  human: PlayerHeroOpponentSplit;
  easy: PlayerHeroOpponentSplit;
  medium: PlayerHeroOpponentSplit;
  hard: PlayerHeroOpponentSplit;
  expert: PlayerHeroOpponentSplit;
}

export interface PlayerHeroStat {
  heroId: string | null;
  heroName: string | null;
  games: number;
  wins: number;
  /**
   * The same games, crossed with opponent kind (#63), less what the anti-farm
   * rules of #66 disqualify. `games`/`wins` above are never filtered; this
   * block is the only part of the payload `minSeconds` and those rules touch.
   */
  byOpponent: PlayerHeroOpponentStats;
}

/** A win/loss/draw from the player's point of view. */
export type PlayerResult = 'W' | 'L' | 'D';

export interface PlayerStreaks {
  /** Consecutive wins counting back from the most recent game. A draw breaks it. */
  current: number;
  /** Longest consecutive-win run anywhere in the player's history. */
  best: number;
}

export interface PlayerOpponentHeroStat {
  heroId: string | null;
  heroName: string | null;
  games: number;
  wins: number;
}

/** Games on one UTC day, for the dashboard's activity calendar. */
export interface PlayerCalendarDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  games: number;
}

/** The player's own hero against one opposing hero, duels only. */
export interface PlayerHeroOpponentHeroStat {
  heroId: string | null;
  heroName: string | null;
  opponentHeroId: string | null;
  opponentHeroName: string | null;
  games: number;
  wins: number;
  draws: number;
}

export interface PlayerMapStat {
  map: string;
  games: number;
  wins: number;
}

/**
 * games/wins/draws for one slice of the player's history.
 *
 * `draws` is carried (#58) so a client can compute `losses = games - wins -
 * draws` per slice — the accounts page needs a headline record that excludes
 * the easy and medium bot tiers, which it cannot derive from games/wins alone.
 * `wins` counts the seat's `won` flag and `draws` counts `games.draw`, exactly
 * as `PlayerStats` does at the top level; they are independent counts, so a
 * producer that marked both on one game would make that subtraction go low.
 */
export interface PlayerSplitStat {
  games: number;
  wins: number;
  draws: number;
}

export interface PlayerBotStat extends PlayerSplitStat {
  /** A tier from `bot-tier.ts` — `easy`/`medium`/`hard`/`expert`, or `unknown`. */
  difficulty: string;
}

export interface PlayerOpponentKindStats {
  human: PlayerSplitStat;
  bots: PlayerBotStat[];
}

export interface PlayerFirstPlayerStats {
  first: PlayerSplitStat;
  second: PlayerSplitStat;
}

export interface PlayerStats {
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  byHero: PlayerHeroStat[];
  firstGameAt: string | null;
  lastGameAt: string | null;
  /** Mean over the games that report one; null when the player has no games. */
  avgDurationSeconds: number | null;
  avgTurns: number | null;
  streaks: PlayerStreaks;
  /** Last 10 results, newest first. */
  recentForm: PlayerResult[];
  byOpponentHero: PlayerOpponentHeroStat[];
  byMap: PlayerMapStat[];
  byOpponentKind: PlayerOpponentKindStats;
  firstPlayer: PlayerFirstPlayerStats;
  /**
   * Wins at exactly 1 HP over a hard or expert bot — see
   * {@link playerBotChallenges} for what "over a hard or expert bot" excludes.
   */
  clutchWins: number;
  /** Fewest `games.turns` in any such win; null when the player has never had one. */
  fastestBotWinTurns: number | null;
  /**
   * Games per UTC day over the last {@link PLAYER_CALENDAR_DAYS} days ending
   * today, only days with games, oldest first.
   */
  calendar: PlayerCalendarDay[];
  /** Own hero x each opposing seat's hero, duel/1v1 games only, games desc. */
  byHeroOpponentHero: PlayerHeroOpponentHeroStat[];
}

/** Decoded pagination cursor: the sort key of the last row of the previous page. */
export interface PlayerGamesCursor {
  endedAtMs: number;
  gameId: string;
}

/**
 * Cursors are opaque to the caller on purpose — the accounts service must not
 * build one by hand, so we are free to change the sort key later. The payload
 * is just the `(ended_at, id)` tuple the keyset predicate needs.
 */
export function encodePlayerGamesCursor(cursor: PlayerGamesCursor): string {
  return Buffer.from(`${cursor.endedAtMs}:${cursor.gameId}`, 'utf8').toString('base64url');
}

export function decodePlayerGamesCursor(value: string): PlayerGamesCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  const endedAtMs = Number(decoded.slice(0, separator));
  const gameId = decoded.slice(separator + 1);
  if (!Number.isSafeInteger(endedAtMs) || gameId === '') return null;
  return { endedAtMs, gameId };
}

export function clampPlayerGamesLimit(requested: number | null): number {
  if (requested === null || !Number.isFinite(requested)) return PLAYER_GAMES_DEFAULT_LIMIT;
  const truncated = Math.trunc(requested);
  if (truncated <= 0) return PLAYER_GAMES_DEFAULT_LIMIT;
  return Math.min(truncated, PLAYER_GAMES_MAX_LIMIT);
}

/**
 * A duration floor is a lenient knob, like `limit`: absent, blank, unparseable,
 * negative or fractional all fall back to "no floor" rather than 400ing, because
 * the caller (unbrewed-api) sets it from its own config and a typo there must not
 * take a player's stats page down. Truncated to whole seconds — `duration_seconds`
 * is an integer column.
 */
export function clampPlayerStatsMinSeconds(requested: number | null): number {
  if (requested === null || !Number.isFinite(requested)) return PLAYER_STATS_DEFAULT_MIN_SECONDS;
  const truncated = Math.trunc(requested);
  return truncated <= 0 ? PLAYER_STATS_DEFAULT_MIN_SECONDS : truncated;
}

/**
 * `ended_at` is nullable on `games` (a producer may omit it), but a history feed
 * has to sort on *something* total, and a keyset cursor cannot straddle NULLs.
 * Fall back to the server-stamped `received_at`, which is NOT NULL and within
 * seconds of the true end time for every real submission.
 */
const ENDED_AT = 'COALESCE(g.ended_at, g.received_at)';

/**
 * The player's own seat in each of their games, one row per game.
 *
 * DISTINCT ON collapses the pathological case of one player id occupying two
 * seats of the same game (a producer bug, but it would otherwise duplicate a
 * game across the feed and break the cursor): the lowest seat wins.
 */
const PLAYER_SEATS_CTE = `
  SELECT DISTINCT ON (s.game_id)
         s.game_id, s.team_index, s.seat_index, s.hero_id, s.hero_name, s.won, s.final_health,
         s.first_player
  FROM game_seats s
  WHERE s.player_id = $1
  ORDER BY s.game_id, s.team_index, s.seat_index
`;

/**
 * The player's own seat joined to its game, one row per non-sim game — the base
 * relation every stats aggregate below is built on. Carries only what those
 * aggregates need; `won` is always the *player's* seat, never a team roll-up.
 */
const PLAYER_GAMES_CTE = `
  SELECT mine.game_id, mine.team_index, mine.won, mine.first_player, mine.final_health,
         mine.hero_id, mine.hero_name,
         g.draw, g.map, g.turns, g.duration_seconds, g.first_player_team, g.end_condition,
         ${ENDED_AT} AS ended_at
  FROM mine
  JOIN games g ON g.id = mine.game_id
  WHERE g.campaign_id IS NULL
`;

/**
 * Seats on a team other than the player's, for every game they played.
 *
 * Note this is *narrower* than the `opponents` array of the games feed, which
 * lists every other seat including teammates: a matchup row is about who the
 * player played *against*, so a 2v2 contributes two opposing seats and a
 * teammate contributes none.
 */
const OPPOSING_SEATS_CTE = `
  SELECT p.game_id, p.won, p.draw, o.hero_id, o.hero_name, o.pilot_kind,
         ${botTierSql('o.pilot', 'o.bot_difficulty')} AS bot_tier,
         NULLIF(lower(btrim(o.bot_difficulty)), '') AS stamped_difficulty
  FROM played p
  JOIN game_seats o ON o.game_id = p.game_id AND o.team_index <> p.team_index
`;

/** One page of a player's game history, newest first. Sim games excluded. */
export async function playerGames(
  pool: Pool,
  playerId: string,
  options: { limit: number; before: PlayerGamesCursor | null },
): Promise<PlayerGamesPage> {
  const limit = clampPlayerGamesLimit(options.limit);
  const before = options.before;

  // Over-fetch by one so an exhausted history reports nextBefore: null rather
  // than handing out a cursor that resolves to an empty page.
  const gamesResult = await pool.query<{
    id: string;
    ended_at: Date;
    map: string;
    turns: number | null;
    duration_seconds: number | null;
    end_condition: string | null;
    draw: boolean;
    team_index: number;
    seat_index: number;
    hero_id: string | null;
    hero_name: string | null;
    won: boolean;
    final_health: number | null;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE})
      SELECT g.id, ${ENDED_AT} AS ended_at, g.map, g.turns, g.duration_seconds,
             g.end_condition, g.draw,
             mine.team_index, mine.seat_index, mine.hero_id, mine.hero_name,
             mine.won, mine.final_health
      FROM mine
      JOIN games g ON g.id = mine.game_id
      WHERE g.campaign_id IS NULL
        AND ($2::timestamptz IS NULL OR (${ENDED_AT}, g.id) < ($2::timestamptz, $3::text))
      ORDER BY ${ENDED_AT} DESC, g.id DESC
      LIMIT $4
    `,
    [
      playerId,
      before ? new Date(before.endedAtMs) : null,
      before ? before.gameId : null,
      limit + 1,
    ],
  );

  const hasMore = gamesResult.rows.length > limit;
  const rows = hasMore ? gamesResult.rows.slice(0, limit) : gamesResult.rows;
  if (rows.length === 0) return { games: [], nextBefore: null };

  const seatsResult = await pool.query<{
    game_id: string;
    team_index: number;
    seat_index: number;
    hero_id: string | null;
    hero_name: string | null;
    pilot: string;
    bot_difficulty: string | null;
  }>(
    `
      SELECT s.game_id, s.team_index, s.seat_index, s.hero_id, s.hero_name, s.pilot, s.bot_difficulty
      FROM game_seats s
      WHERE s.game_id = ANY($1::text[])
      ORDER BY s.game_id, s.team_index, s.seat_index
    `,
    [rows.map((row) => row.id)],
  );

  const opponentsByGame = new Map<string, typeof seatsResult.rows>();
  for (const seat of seatsResult.rows) {
    const list = opponentsByGame.get(seat.game_id);
    if (list) list.push(seat);
    else opponentsByGame.set(seat.game_id, [seat]);
  }

  const games: PlayerGame[] = rows.map((row) => ({
    id: row.id,
    endedAt: row.ended_at.toISOString(),
    map: row.map,
    turns: row.turns,
    durationSeconds: row.duration_seconds,
    endCondition: row.end_condition,
    draw: row.draw,
    you: {
      heroId: row.hero_id,
      heroName: row.hero_name,
      won: row.won,
      finalHealth: row.final_health,
    },
    // Everyone who is not the player's own seat — teammates included. The
    // accounts service renders "you vs the table"; team shape is not in scope.
    opponents: (opponentsByGame.get(row.id) ?? [])
      .filter((seat) => seat.team_index !== row.team_index || seat.seat_index !== row.seat_index)
      .map((seat) => ({
        heroId: seat.hero_id,
        heroName: seat.hero_name,
        pilot: seat.pilot,
        botDifficulty: seat.bot_difficulty,
      })),
  }));

  const last = rows[rows.length - 1]!;
  return {
    games,
    nextBefore: hasMore
      ? encodePlayerGamesCursor({ endedAtMs: last.ended_at.getTime(), gameId: last.id })
      : null,
  };
}

/** Postgres hands `count(*)` back as a string; every count here is small. */
function count(value: string | null): number {
  return value === null ? 0 : Number(value);
}

/** `avg()` comes back as a numeric string, or null when there is nothing to average. */
function mean(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Lifetime aggregates for one player. Sim games excluded.
 *
 * Independent grouped queries rather than one mega-query: they share the
 * same two CTEs but group differently, and this endpoint sits behind
 * unbrewed-api's 60s per-user cache, so the round trips are cheap relative to
 * the readability. Nothing is aggregated in JS — the queries return one row per
 * output row, and the only JS fold is stitching the per-hero opponent
 * breakdown onto the `byHero` rows it belongs to.
 *
 * The anti-farm rules are **deliberately narrow**: `minSeconds` (#63) and the
 * concession / short-human-win predicates (#66) shape `byHero[].byOpponent` and
 * nothing else. Every other number in the payload — `totalGames`,
 * `byHero[].games`/`wins`, `byOpponentKind`, the records — counts the player's
 * whole history, so a client can show "you played 300 games" beside "280 of
 * them count for points" without two calls. See {@link playerByHeroOpponent}.
 */
export async function playerStats(
  pool: Pool,
  playerId: string,
  options: { minSeconds?: number; now?: Date } = {},
): Promise<PlayerStats> {
  const minSeconds = clampPlayerStatsMinSeconds(options.minSeconds ?? null);
  const now = options.now ?? new Date();
  const [
    totals,
    overview,
    streaks,
    byOpponentHero,
    byMap,
    byOpponentKind,
    botChallenges,
    heroOpponents,
    calendar,
    byHeroOpponentHero,
  ] =
    await Promise.all([
      playerTotals(pool, playerId),
      playerOverview(pool, playerId),
      playerStreaks(pool, playerId),
      playerByOpponentHero(pool, playerId),
      playerByMap(pool, playerId),
      playerByOpponentKind(pool, playerId),
      playerBotChallenges(pool, playerId),
      playerByHeroOpponent(pool, playerId, minSeconds),
      playerCalendar(pool, playerId, now),
      playerByHeroOpponentHero(pool, playerId),
    ]);

  for (const hero of totals.byHero) {
    hero.byOpponent = heroOpponents.get(heroKey(hero.heroId, hero.heroName)) ?? emptyHeroOpponents();
  }

  return {
    ...totals,
    ...overview,
    ...streaks,
    ...botChallenges,
    byOpponentHero,
    byMap,
    byOpponentKind,
    calendar,
    byHeroOpponentHero,
  };
}

/** The five buckets, all zero — the shape a hero with no qualifying game reports. */
function emptyHeroOpponents(): PlayerHeroOpponentStats {
  return {
    human: { games: 0, wins: 0 },
    easy: { games: 0, wins: 0 },
    medium: { games: 0, wins: 0 },
    hard: { games: 0, wins: 0 },
    expert: { games: 0, wins: 0 },
  };
}

/** The bucket names that exist; anything else (today only `unknown`) is dropped. */
const HERO_OPPONENT_BUCKETS = new Set<keyof PlayerHeroOpponentStats>([
  'human',
  'easy',
  'medium',
  'hard',
  'expert',
]);

/**
 * `byHero` and the breakdown group on the same `(hero_id, hero_name)` pair, so
 * they are joined on it in JS. Both parts are nullable and a hero name may
 * legitimately contain any character, so they are joined on NUL — a byte no
 * hero id or display name can carry — rather than a printable separator that
 * could collide across the pair boundary.
 */
function heroKey(heroId: string | null, heroName: string | null): string {
  return `${heroId ?? ''}\u0000${heroName ?? ''}`;
}

/** The #52 payload: totals, per-hero rows, and the history's endpoints. */
async function playerTotals(
  pool: Pool,
  playerId: string,
): Promise<Pick<PlayerStats, 'totalGames' | 'wins' | 'losses' | 'draws' | 'byHero' | 'firstGameAt' | 'lastGameAt'>> {
  // Grouped by the player's *own* seat hero, so a hero row means "games I
  // played as this hero", not "games this hero appeared in".
  //
  // wins/draws/losses are counted independently rather than derived from each
  // other: `won` lives on the seat and `draw` on the game, and a loss is
  // exactly "my seat did not win and the game was not a draw". Deriving losses
  // by subtraction would go negative if a producer ever marked both.
  const result = await pool.query<{
    hero_id: string | null;
    hero_name: string | null;
    games: string;
    wins: string;
    draws: string;
    losses: string;
    first_game_at: Date | null;
    last_game_at: Date | null;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      joined AS (
        SELECT mine.hero_id, mine.hero_name, mine.won, g.draw, ${ENDED_AT} AS ended_at
        FROM mine
        JOIN games g ON g.id = mine.game_id
        WHERE g.campaign_id IS NULL
      )
      SELECT hero_id, hero_name,
             count(*) AS games,
             count(*) FILTER (WHERE won) AS wins,
             count(*) FILTER (WHERE draw) AS draws,
             count(*) FILTER (WHERE NOT won AND NOT draw) AS losses,
             min(ended_at) AS first_game_at,
             max(ended_at) AS last_game_at
      FROM joined
      GROUP BY hero_id, hero_name
      ORDER BY count(*) DESC, hero_id ASC NULLS LAST
    `,
    [playerId],
  );

  const stats = {
    totalGames: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    byHero: [] as PlayerHeroStat[],
    firstGameAt: null as string | null,
    lastGameAt: null as string | null,
  };

  for (const row of result.rows) {
    const games = Number(row.games);
    const wins = Number(row.wins);
    stats.totalGames += games;
    stats.wins += wins;
    stats.draws += Number(row.draws);
    stats.losses += Number(row.losses);
    // Zeroed until `playerStats` stitches the #63 breakdown on; `playerTotals`
    // is the un-filtered half and never learns about `minSeconds`.
    stats.byHero.push({
      heroId: row.hero_id,
      heroName: row.hero_name,
      games,
      wins,
      byOpponent: emptyHeroOpponents(),
    });
    const first = row.first_game_at ? row.first_game_at.toISOString() : null;
    const last = row.last_game_at ? row.last_game_at.toISOString() : null;
    if (first && (stats.firstGameAt === null || first < stats.firstGameAt)) stats.firstGameAt = first;
    if (last && (stats.lastGameAt === null || last > stats.lastGameAt)) stats.lastGameAt = last;
  }

  return stats;
}

/**
 * Means and the first/second-player split — one row, always.
 *
 * The split is keyed on the player's seat `first_player` flag, which the
 * normalizer derives from the game's `first_player_team`. When a producer omits
 * that field every seat flag defaults to false, which would silently pile those
 * games into `second`; games with no recorded first player are therefore left
 * out of the split entirely, so `first.games + second.games` can be less than
 * `totalGames`.
 */
async function playerOverview(
  pool: Pool,
  playerId: string,
): Promise<Pick<PlayerStats, 'avgDurationSeconds' | 'avgTurns' | 'firstPlayer'>> {
  const result = await pool.query<{
    avg_duration_seconds: string | null;
    avg_turns: string | null;
    first_games: string;
    first_wins: string;
    first_draws: string;
    second_games: string;
    second_wins: string;
    second_draws: string;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE})
      SELECT round(avg(duration_seconds)::numeric, 1) AS avg_duration_seconds,
             round(avg(turns)::numeric, 1) AS avg_turns,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND first_player) AS first_games,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND first_player AND won) AS first_wins,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND first_player AND draw) AS first_draws,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND NOT first_player) AS second_games,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND NOT first_player AND won) AS second_wins,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND NOT first_player AND draw) AS second_draws
      FROM played
    `,
    [playerId],
  );

  const row = result.rows[0];
  if (!row) {
    return {
      avgDurationSeconds: null,
      avgTurns: null,
      firstPlayer: {
        first: { games: 0, wins: 0, draws: 0 },
        second: { games: 0, wins: 0, draws: 0 },
      },
    };
  }
  return {
    avgDurationSeconds: mean(row.avg_duration_seconds),
    avgTurns: mean(row.avg_turns),
    firstPlayer: {
      first: { games: count(row.first_games), wins: count(row.first_wins), draws: count(row.first_draws) },
      second: {
        games: count(row.second_games),
        wins: count(row.second_wins),
        draws: count(row.second_draws),
      },
    },
  };
}

/**
 * The one definition of a result sequence and its win runs, shared by a
 * player's own `streaks`/`recentForm` and the leaderboard's `currentStreak`/
 * `recentForm` so the two can never disagree. Reads a `played` relation with
 * `won`, `draw`, `ended_at`, `game_id` (plus `key` when partitioned) and
 * defines three CTEs:
 *
 * - `ordered`: one row per game, `rn` numbering play order from 1, and the
 *   game's `result` letter;
 * - `islands`: each game labelled with the consecutive same-outcome run it is in;
 * - `runs`: one row per win run, its length and the `rn` it ends on.
 *
 * `key` names the partition column (`player_id` for the cross-player read), or
 * null for a relation that is already one player's.
 */
function resultRunsCtes(key: string | null): string {
  const by = key ? `${key}, ` : '';
  const partition = key ? `PARTITION BY ${key} ` : '';
  return `
      ordered AS (
        SELECT ${by}(won AND NOT draw) AS is_win,
               (CASE WHEN draw THEN 'D' WHEN won THEN 'W' ELSE 'L' END)::text AS result,
               row_number() OVER (${partition}ORDER BY ended_at, game_id) AS rn
        FROM played
      ),
      islands AS (
        SELECT ${by}is_win, rn,
               rn - row_number() OVER (PARTITION BY ${by}is_win ORDER BY rn) AS run_id
        FROM ordered
      ),
      runs AS (
        SELECT ${by}run_id, count(*) AS len, max(rn) AS last_rn
        FROM islands
        WHERE is_win
        GROUP BY ${by}run_id
      )`;
}

/**
 * Win streaks and recent form, both ordered by the same `(ended_at, id)` key the
 * games feed sorts on so the client's "last 10" matches the first page it shows.
 *
 * A win is `won AND NOT draw` — a draw breaks a streak rather than extending it,
 * and the belt-and-braces `NOT draw` keeps a producer that marked both from
 * inflating a run. Streaks come out of a gaps-and-islands pass: number the games
 * in play order, subtract a per-outcome row number to label each consecutive run,
 * then take the longest run (`best`) and the run that ends on the newest game
 * (`current`, zero when the newest game was not a win).
 */
async function playerStreaks(
  pool: Pool,
  playerId: string,
): Promise<Pick<PlayerStats, 'streaks' | 'recentForm'>> {
  const result = await pool.query<{
    current: string;
    best: string;
    recent_form: PlayerResult[] | null;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE}),
      ${resultRunsCtes(null)}
      SELECT
        COALESCE((SELECT max(len) FROM runs), 0) AS best,
        COALESCE(
          (SELECT max(len) FROM runs WHERE last_rn = (SELECT max(rn) FROM ordered)),
          0
        ) AS current,
        (SELECT array_agg(result ORDER BY rn DESC)
         FROM (SELECT result, rn FROM ordered ORDER BY rn DESC LIMIT 10) AS recent) AS recent_form
    `,
    [playerId],
  );

  const row = result.rows[0];
  return {
    streaks: { current: count(row?.current ?? null), best: count(row?.best ?? null) },
    recentForm: row?.recent_form ?? [],
  };
}

/**
 * The player's record against each opposing hero, games desc.
 *
 * Multi-seat semantics: one row-entry per *opposing seat*, so a 2v2 credits both
 * enemy heroes with a game (and a win, if the player's seat won). A player's
 * `byOpponentHero` games therefore sum to more than `totalGames` once they play
 * team formats — these are matchup counts, not game counts.
 */
async function playerByOpponentHero(pool: Pool, playerId: string): Promise<PlayerOpponentHeroStat[]> {
  const result = await pool.query<{
    hero_id: string | null;
    hero_name: string | null;
    games: string;
    wins: string;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE}),
      opposing AS (${OPPOSING_SEATS_CTE})
      SELECT hero_id, hero_name,
             count(*) AS games,
             count(*) FILTER (WHERE won) AS wins
      FROM opposing
      GROUP BY hero_id, hero_name
      ORDER BY count(*) DESC, hero_id ASC NULLS LAST
    `,
    [playerId],
  );

  return result.rows.map((row) => ({
    heroId: row.hero_id,
    heroName: row.hero_name,
    games: Number(row.games),
    wins: Number(row.wins),
  }));
}

/**
 * Games per UTC day for the activity calendar: the {@link PLAYER_CALENDAR_DAYS}
 * days ending on `now`'s UTC date, only days with games, oldest first. Same
 * game set as every other block here (all formats, every opponent, campaigns
 * excluded). A game is dated by its end time in UTC; one stamped after `now`
 * falls outside the window rather than onto a future day.
 */
async function playerCalendar(pool: Pool, playerId: string, now: Date): Promise<PlayerCalendarDay[]> {
  const result = await pool.query<{ date: string; games: string }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE}),
      bounds AS (SELECT ($2::timestamptz AT TIME ZONE 'UTC')::date AS today)
      SELECT to_char((ended_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
             count(*) AS games
      FROM played, bounds
      WHERE (ended_at AT TIME ZONE 'UTC')::date BETWEEN today - ($3::int - 1) AND today
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    [playerId, now, PLAYER_CALENDAR_DAYS],
  );

  return result.rows.map((row) => ({ date: row.date, games: Number(row.games) }));
}

/**
 * The player's own hero against each opposing seat's hero, duel/1v1 only, games
 * desc. Duels have exactly one opposing seat, so each game is one cell entry;
 * restricting to duels keeps the grid a true 1v1 matchup read (a 2v2 would
 * credit a hero with a "matchup" its teammate fought). Win predicate is the
 * seat's `won`, as in `byOpponentHero`.
 */
async function playerByHeroOpponentHero(
  pool: Pool,
  playerId: string,
): Promise<PlayerHeroOpponentHeroStat[]> {
  const result = await pool.query<{
    hero_id: string | null;
    hero_name: string | null;
    opponent_hero_id: string | null;
    opponent_hero_name: string | null;
    games: string;
    wins: string;
    draws: string;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE})
      SELECT p.hero_id, p.hero_name,
             o.hero_id AS opponent_hero_id, o.hero_name AS opponent_hero_name,
             count(*) AS games,
             count(*) FILTER (WHERE p.won) AS wins,
             count(*) FILTER (WHERE p.draw) AS draws
      FROM played p
      JOIN games g ON g.id = p.game_id AND g.format = ANY($2::text[])
      JOIN game_seats o ON o.game_id = p.game_id AND o.team_index <> p.team_index
      GROUP BY 1, 2, 3, 4
      ORDER BY count(*) DESC, 1 ASC NULLS LAST, 3 ASC NULLS LAST
    `,
    [playerId, DUEL_FORMATS],
  );

  return result.rows.map((row) => ({
    heroId: row.hero_id,
    heroName: row.hero_name,
    opponentHeroId: row.opponent_hero_id,
    opponentHeroName: row.opponent_hero_name,
    games: Number(row.games),
    wins: Number(row.wins),
    draws: Number(row.draws),
  }));
}

/** Record per map, games desc. `map` is NOT NULL but may be blank; that buckets as "unknown". */
async function playerByMap(pool: Pool, playerId: string): Promise<PlayerMapStat[]> {
  const result = await pool.query<{ map: string; games: string; wins: string }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE})
      SELECT COALESCE(NULLIF(map, ''), 'unknown') AS map,
             count(*) AS games,
             count(*) FILTER (WHERE won) AS wins
      FROM played
      GROUP BY 1
      ORDER BY count(*) DESC, 1 ASC
    `,
    [playerId],
  );

  return result.rows.map((row) => ({
    map: row.map,
    games: Number(row.games),
    wins: Number(row.wins),
  }));
}

/**
 * Human vs bot opposition, and per-tier rows for the bot side.
 *
 * A game counts as a bot game if **any** opposing seat is a bot. Mixed human/bot
 * opposition only happens when a human drops and a bot takes over, or in a
 * hand-assembled lobby; classifying such a game as "vs bots" keeps the human
 * bucket meaning "I beat only people", which is the claim a player cares about.
 * For the same reason a mixed-tier bot side reports its alphabetically first
 * tier — one row per game, deterministically chosen.
 *
 * The tier itself comes from `bot-tier.ts` (#58): `bot_difficulty` when the
 * producer stamped one, else decoded from the seat's pilot label, which is what
 * every live bot seat actually has. Keying on `bot_difficulty` alone put 100%
 * of live bot games in one `unknown` row.
 *
 * Games with no opposing seat at all (a producer bug: every seat on one team)
 * appear in neither bucket.
 */
async function playerByOpponentKind(pool: Pool, playerId: string): Promise<PlayerOpponentKindStats> {
  const result = await pool.query<{
    kind: 'bot' | 'human';
    difficulty: string | null;
    games: string;
    wins: string;
    draws: string;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE}),
      opposing AS (${OPPOSING_SEATS_CTE}),
      per_game AS (
        SELECT game_id,
               bool_and(won) AS won,
               bool_or(draw) AS draw,
               bool_or(pilot_kind = 'bot') AS any_bot,
               min(bot_tier) FILTER (WHERE pilot_kind = 'bot') AS difficulty
        FROM opposing
        GROUP BY game_id
      )
      SELECT CASE WHEN any_bot THEN 'bot' ELSE 'human' END AS kind,
             CASE WHEN any_bot THEN difficulty END AS difficulty,
             count(*) AS games,
             count(*) FILTER (WHERE won) AS wins,
             count(*) FILTER (WHERE draw) AS draws
      FROM per_game
      GROUP BY 1, 2
      ORDER BY count(*) DESC, 2 ASC NULLS LAST
    `,
    [playerId],
  );

  const stats: PlayerOpponentKindStats = { human: { games: 0, wins: 0, draws: 0 }, bots: [] };
  for (const row of result.rows) {
    const games = Number(row.games);
    const wins = Number(row.wins);
    const draws = Number(row.draws);
    if (row.kind === 'bot') {
      stats.bots.push({ difficulty: row.difficulty ?? UNKNOWN_BOT_TIER, games, wins, draws });
    } else {
      // 'unknown' pilot kinds land here too — not a bot, so not a bot row.
      stats.human.games += games;
      stats.human.wins += wins;
      stats.human.draws += draws;
    }
  }
  return stats;
}

/**
 * The cross of `byHero` and `byOpponentKind` (#63): per hero the player piloted,
 * their record against humans and against each bot tier.
 *
 * The classification is `playerByOpponentKind`'s, unchanged and for the same
 * reasons — opposing seats only (a teammate is not opposition), a game counts
 * as a bot game if *any* opposing seat is a bot, a mixed-tier bot side is
 * represented by its alphabetically first tier so a game lands in exactly one
 * bucket, and the tier comes from `bot-tier.ts` (`bot_difficulty` when stamped,
 * else decoded from the pilot label). The only differences are the extra
 * `GROUP BY` on the player's own seat hero and the `minSeconds` floor.
 *
 * A game whose bot side decodes to `unknown` produces a row here too; the caller
 * drops it, because {@link PlayerHeroOpponentStats} has no key to put it in.
 *
 * **The `minSeconds` floor.** `games.duration_seconds` is a nullable integer the
 * producer reports (migration 001), which is the only per-game duration the
 * schema has — `turns` is the other anti-farm signal and is left to the caller,
 * which can already read it as `avgTurns`. A floor of 0 (the default) is *no*
 * filter at all, null durations included; any positive floor requires a game to
 * have actually reported a duration that meets it, so a game with no recorded
 * duration cannot be farmed past the bar by omission. That asymmetry is the
 * point: unknown must not read as long enough. It stays because it is upstream
 * contract; unbrewed-api stopped sending it (unbrewed-api#35) once it turned out
 * `duration_seconds` was NULL on every live game.
 *
 * **The anti-farm rules (#66).** What replaces it are two *per-game* predicates,
 * which live here rather than in the caller because that is where the columns
 * are — the caller sees only the folded counts:
 *
 * 1. A concession ({@link CONCESSION_END_CONDITIONS}) pays nobody. The
 *    conceding seat (the player's own seat, `won = false`) is dropped from
 *    `games` as well as `wins` — it is not a game they played, it is a game
 *    they handed over — and the seat conceded to keeps the played credit but
 *    gets no win bonus. So two accounts trading instant concedes earn the
 *    "played" points of the games they actually sat through and nothing more.
 * 2. A win in the `human` bucket under {@link MIN_HUMAN_WIN_TURNS} turns keeps
 *    its played credit and loses its win bonus. Bot buckets are exempt: prod
 *    has ten legitimate 2–4-turn wins and every one of them is against a bot,
 *    which cannot collude. A NULL `turns` passes, deliberately the opposite of
 *    the duration floor's asymmetry — `turns` is a producer gap on ordinary
 *    long games, not the reachable farm shape, and treating unknown as short
 *    is exactly the mistake that zeroed everyone in unbrewed-api#35.
 *
 * The rules bite only on the buckets. `playerTotals` and `playerByOpponentKind`
 * run their own queries over the same games and are untouched, so the record,
 * badges and XP still see every game the player played.
 */
async function playerByHeroOpponent(
  pool: Pool,
  playerId: string,
  minSeconds: number,
): Promise<Map<string, PlayerHeroOpponentStats>> {
  const result = await pool.query<{
    hero_id: string | null;
    hero_name: string | null;
    bucket: string;
    games: string;
    wins: string;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE}),
      opposing AS (${OPPOSING_SEATS_CTE}),
      per_game AS (
        SELECT game_id,
               bool_or(pilot_kind = 'bot') AS any_bot,
               min(bot_tier) FILTER (WHERE pilot_kind = 'bot') AS difficulty
        FROM opposing
        GROUP BY game_id
      ),
      scored AS (
        SELECT p.hero_id, p.hero_name,
               CASE WHEN o.any_bot THEN o.difficulty ELSE 'human' END AS bucket,
               p.won,
               -- COALESCE, not a bare comparison: end_condition is nullable, and
               -- a NULL flag would make the FILTERs below drop the row entirely.
               COALESCE(lower(btrim(p.end_condition)) = ANY($3::text[]), false) AS conceded_game,
               COALESCE(NOT o.any_bot AND p.turns < $4::int, false) AS short_human_game
        FROM played p
        JOIN per_game o ON o.game_id = p.game_id
        WHERE $2::int = 0
           OR (p.duration_seconds IS NOT NULL AND p.duration_seconds >= $2::int)
      )
      SELECT hero_id, hero_name, bucket,
             count(*) FILTER (WHERE NOT (conceded_game AND NOT won)) AS games,
             count(*) FILTER (WHERE won AND NOT conceded_game AND NOT short_human_game) AS wins
      FROM scored
      GROUP BY 1, 2, 3
    `,
    [playerId, minSeconds, CONCESSION_END_CONDITIONS, MIN_HUMAN_WIN_TURNS],
  );

  const byHero = new Map<string, PlayerHeroOpponentStats>();
  for (const row of result.rows) {
    const bucket = row.bucket as keyof PlayerHeroOpponentStats;
    // `unknown` tiers (and any tier a future rule adds before this shape does)
    // are counted in no bucket rather than folded into a neighbouring one.
    if (!HERO_OPPONENT_BUCKETS.has(bucket)) continue;
    const key = heroKey(row.hero_id, row.hero_name);
    let entry = byHero.get(key);
    if (!entry) {
      entry = emptyHeroOpponents();
      byHero.set(key, entry);
    }
    entry[bucket].games += Number(row.games);
    entry[bucket].wins += Number(row.wins);
  }
  return byHero;
}

// ---------------------------------------------------------------------------
// Leaderboard (#56) — the one cross-player aggregate in this file.
// ---------------------------------------------------------------------------

/**
 * One player's XP inputs. XP itself is computed api-side from tiered weights.
 *
 * `byOpponentKind` is what makes those weights exact: unbrewed-api pays a human
 * win and an easy-bot win very differently (`src/progression/xp.ts`), so a row
 * carrying only games/wins forces it to weight everything as human and
 * over-state bot-heavy players. Same shape and same semantics as
 * `PlayerStats.byOpponentKind`, so the two roll up to the same XP.
 */
export interface LeaderboardPlayer {
  playerId: string;
  gamesPlayed: number;
  wins: number;
  byOpponentKind: PlayerOpponentKindStats;
  /** Hero with the most games; ties to most wins, then heroId asc. Null-hero seats never qualify. */
  mainHeroId: string | null;
  /** That hero's name as the player's most recent game on it reported it. */
  mainHeroName: string | null;
  /** Last 5 results, newest first — `PlayerStats.recentForm`'s rule, shorter. */
  recentForm: PlayerResult[];
  /** `PlayerStats.streaks.current`, same rule. */
  currentStreak: number;
  /** Only with `?since=`: games since then, casual (easy/medium) bot opponents excluded. */
  windowGames?: number;
  /** Only with `?since=`: wins among those `windowGames`. */
  windowWins?: number;
}

/** How many results a leaderboard row's `recentForm` carries. */
export const LEADERBOARD_RECENT_FORM = 5;

/** Bot tiers a leaderboard `?since=` window leaves out: the casual opponents. */
const CASUAL_BOT_TIERS = ['easy', 'medium'];

/**
 * `?limit=` is a safety cap the caller may set, not a page size: absent, blank,
 * unparseable, or non-positive all mean "every player", which is the default
 * because unbrewed-api has to sort the whole set by XP itself (telemetry cannot
 * pre-sort by a weighting it does not know). There is no hard maximum — the
 * user base is small and one row per player is a few dozen bytes.
 */
export function clampLeaderboardLimit(requested: number | null): number | null {
  if (requested === null || !Number.isFinite(requested)) return null;
  const truncated = Math.trunc(requested);
  return truncated <= 0 ? null : truncated;
}

/**
 * Every player's own seat in each of their games, one row per (player, game).
 *
 * The cross-player twin of `PLAYER_SEATS_CTE`: same DISTINCT ON collapse of one
 * player id occupying two seats of a game (lowest seat wins), now partitioned
 * per player instead of filtered to one. Blank player ids are dropped — the
 * per-player routes reject an empty playerId, so no such row is anybody's.
 */
const ALL_PLAYER_SEATS_CTE = `
  SELECT DISTINCT ON (s.player_id, s.game_id)
         s.player_id, s.game_id, s.team_index, s.won, s.hero_id, s.hero_name
  FROM game_seats s
  WHERE s.player_id IS NOT NULL AND s.player_id <> ''
  ORDER BY s.player_id, s.game_id, s.team_index, s.seat_index
`;

/** The cross-player twin of `PLAYER_GAMES_CTE`: same completed-game filter. */
const ALL_PLAYER_GAMES_CTE = `
  SELECT seats.player_id, seats.game_id, seats.team_index, seats.won, seats.hero_id, seats.hero_name,
         g.draw, ${ENDED_AT} AS ended_at
  FROM seats
  JOIN games g ON g.id = seats.game_id
  WHERE g.campaign_id IS NULL
`;

/**
 * Games played and won per player, for every player with at least one
 * completed game, plus the opponent-kind split those games break down into.
 * Sim/campaign games excluded, like everything else here.
 *
 * This is `playerTotals` and `playerByOpponentKind` with the
 * `WHERE s.player_id = $1` predicate lifted into the GROUP BY, and it
 * deliberately keeps every other predicate identical so a leaderboard row
 * equals what that player's own `/me/stats` reports:
 *
 * - the same DISTINCT ON collapse of a player occupying two seats of one game,
 *   now partitioned per `(player_id, game_id)` and applied *before* the join to
 *   `games`, exactly as `PLAYER_SEATS_CTE` does;
 * - the same "completed game" definition — a `games` row with no `campaign_id`;
 * - the same win predicate — the player's own seat `won`, matching
 *   `playerStats.wins` (which counts `won` alone, not `won AND NOT draw`).
 *
 * Ordered by games desc as a stable default; the real ordering is XP, applied
 * by the caller. `player_id` breaks ties so pagination-free clients still see a
 * deterministic list.
 */
export async function leaderboard(
  pool: Pool,
  options: { limit: number | null; since?: Date | null } = { limit: null },
): Promise<LeaderboardPlayer[]> {
  const limit = clampLeaderboardLimit(options.limit);
  const result = await pool.query<{ player_id: string; games_played: string; wins: string }>(
    `
      WITH seats AS (${ALL_PLAYER_SEATS_CTE}),
      played AS (${ALL_PLAYER_GAMES_CTE})
      SELECT player_id,
             count(*) AS games_played,
             count(*) FILTER (WHERE won) AS wins
      FROM played
      GROUP BY player_id
      ORDER BY count(*) DESC, player_id ASC
      LIMIT $1::bigint
    `,
    [limit],
  );

  const players: LeaderboardPlayer[] = result.rows.map((row) => ({
    playerId: row.player_id,
    gamesPlayed: Number(row.games_played),
    wins: Number(row.wins),
    byOpponentKind: { human: { games: 0, wins: 0, draws: 0 }, bots: [] } as PlayerOpponentKindStats,
    mainHeroId: null,
    mainHeroName: null,
    recentForm: [],
    currentStreak: 0,
  }));

  // Second round trip rather than one wide query: the split needs a different
  // grain (opposing seats folded per game) and only the players that survived
  // `limit` are worth folding. A player with no opposing seat in any game — a
  // producer bug — keeps the zeroed block, exactly as `playerStats` reports.
  const splits = await leaderboardOpponentKinds(pool, players.map((player) => player.playerId));
  for (const player of players) {
    const split = splits.get(player.playerId);
    if (split) player.byOpponentKind = split;
  }

  const since = options.since ?? null;
  const extras = await leaderboardRowExtras(pool, players.map((player) => player.playerId), since);
  for (const player of players) {
    const extra = extras.get(player.playerId);
    if (extra) Object.assign(player, extra);
    if (since !== null) {
      player.windowGames ??= 0;
      player.windowWins ??= 0;
    }
  }
  return players;
}

type LeaderboardRowExtras = Pick<
  LeaderboardPlayer,
  'mainHeroId' | 'mainHeroName' | 'recentForm' | 'currentStreak' | 'windowGames' | 'windowWins'
>;

/**
 * The dashboard fields of a leaderboard row (stats dashboard T2), for the given
 * players. Kept apart from `leaderboard`'s own query on purpose: `gamesPlayed`/
 * `wins`/`byOpponentKind` price XP api-side and must not move when these do.
 *
 * - `recentForm` / `currentStreak` come from {@link resultRunsCtes}, the very
 *   CTEs `playerStreaks` uses, partitioned per player — same order key, same
 *   "a draw breaks a run" rule — so a row always agrees with that player's
 *   `/stats` (`recentForm` is its first five entries).
 * - `mainHero*`: most games on the seat's hero, then most wins, then hero id
 *   asc. Seats with no hero id are not a hero, so never a main hero.
 * - `windowGames`/`windowWins` (only when `since` is given): games ending at or
 *   after `since`, less games against a casual bot. A game is casual by
 *   `leaderboardOpponentKinds`'s per-game rule — any opposing bot makes it a bot
 *   game, filed under the alphabetically first bot tier — so a window row
 *   agrees with the `byOpponentKind` split. Unknown tiers are not casual.
 */
async function leaderboardRowExtras(
  pool: Pool,
  playerIds: string[],
  since: Date | null,
): Promise<Map<string, LeaderboardRowExtras>> {
  const extras = new Map<string, LeaderboardRowExtras>();
  if (playerIds.length === 0) return extras;

  const result = await pool.query<{
    player_id: string;
    recent_form: PlayerResult[] | null;
    current_streak: string | null;
    main_hero_id: string | null;
    main_hero_name: string | null;
    window_games: string | null;
    window_wins: string | null;
  }>(
    `
      WITH all_seats AS (${ALL_PLAYER_SEATS_CTE}),
      seats AS (SELECT * FROM all_seats WHERE player_id = ANY($1::text[])),
      played AS (${ALL_PLAYER_GAMES_CTE}),
      ${resultRunsCtes('player_id')},
      latest AS (
        SELECT player_id, max(rn) AS last_rn FROM ordered GROUP BY player_id
      ),
      form AS (
        SELECT o.player_id, array_agg(o.result ORDER BY o.rn DESC) AS recent_form
        FROM ordered o
        JOIN latest l ON l.player_id = o.player_id
        WHERE o.rn > l.last_rn - $2::int
        GROUP BY o.player_id
      ),
      streak AS (
        SELECT l.player_id, max(r.len) AS current_streak
        FROM latest l
        JOIN runs r ON r.player_id = l.player_id AND r.last_rn = l.last_rn
        GROUP BY l.player_id
      ),
      hero_totals AS (
        SELECT player_id, hero_id,
               (array_agg(hero_name ORDER BY ended_at DESC, game_id DESC)
                  FILTER (WHERE hero_name IS NOT NULL))[1] AS hero_name,
               count(*) AS games,
               count(*) FILTER (WHERE won) AS wins
        FROM played
        WHERE hero_id IS NOT NULL
        GROUP BY player_id, hero_id
      ),
      main_hero AS (
        SELECT DISTINCT ON (player_id) player_id, hero_id, hero_name
        FROM hero_totals
        ORDER BY player_id, games DESC, wins DESC, hero_id ASC
      ),
      in_window AS (
        SELECT * FROM played WHERE $3::timestamptz IS NOT NULL AND ended_at >= $3::timestamptz
      ),
      window_bots AS (
        SELECT p.player_id, p.game_id,
               min(${botTierSql('o.pilot', 'o.bot_difficulty')}) AS bot_tier
        FROM in_window p
        JOIN game_seats o ON o.game_id = p.game_id AND o.team_index <> p.team_index
        WHERE o.pilot_kind = 'bot'
        GROUP BY p.player_id, p.game_id
      ),
      window_totals AS (
        SELECT w.player_id, count(*) AS window_games, count(*) FILTER (WHERE w.won) AS window_wins
        FROM in_window w
        LEFT JOIN window_bots b ON b.player_id = w.player_id AND b.game_id = w.game_id
        WHERE b.bot_tier IS NULL OR b.bot_tier <> ALL($4::text[])
        GROUP BY w.player_id
      )
      SELECT l.player_id, f.recent_form, s.current_streak,
             m.hero_id AS main_hero_id, m.hero_name AS main_hero_name,
             w.window_games, w.window_wins
      FROM latest l
      LEFT JOIN form f ON f.player_id = l.player_id
      LEFT JOIN streak s ON s.player_id = l.player_id
      LEFT JOIN main_hero m ON m.player_id = l.player_id
      LEFT JOIN window_totals w ON w.player_id = l.player_id
    `,
    [playerIds, LEADERBOARD_RECENT_FORM, since, CASUAL_BOT_TIERS],
  );

  for (const row of result.rows) {
    const extra: LeaderboardRowExtras = {
      mainHeroId: row.main_hero_id,
      mainHeroName: row.main_hero_name,
      recentForm: row.recent_form ?? [],
      currentStreak: count(row.current_streak),
    };
    if (since !== null) {
      extra.windowGames = count(row.window_games);
      extra.windowWins = count(row.window_wins);
    }
    extras.set(row.player_id, extra);
  }
  return extras;
}

/**
 * Human vs bot opposition per player, for the given players.
 *
 * Every classification rule is `playerByOpponentKind`'s, unchanged: opposing
 * seats only (teammates excluded), a game counts as a bot game if *any*
 * opposing seat is a bot, a mixed-tier bot side reports its alphabetically
 * first tier, the tier itself comes from `bot-tier.ts` (`bot_difficulty` when
 * stamped, else decoded from the pilot label), and a game with no opposing seat
 * at all lands in neither bucket. Bot rows come back games desc then difficulty asc,
 * the same order the per-player query emits, so the two payloads compare equal.
 */
async function leaderboardOpponentKinds(
  pool: Pool,
  playerIds: string[],
): Promise<Map<string, PlayerOpponentKindStats>> {
  const stats = new Map<string, PlayerOpponentKindStats>();
  if (playerIds.length === 0) return stats;

  const result = await pool.query<{
    player_id: string;
    kind: 'bot' | 'human';
    difficulty: string | null;
    games: string;
    wins: string;
    draws: string;
  }>(
    `
      WITH seats AS (${ALL_PLAYER_SEATS_CTE}),
      played AS (${ALL_PLAYER_GAMES_CTE}),
      opposing AS (
        SELECT p.player_id, p.game_id, p.won, p.draw, o.pilot_kind,
               ${botTierSql('o.pilot', 'o.bot_difficulty')} AS bot_tier
        FROM played p
        JOIN game_seats o ON o.game_id = p.game_id AND o.team_index <> p.team_index
        WHERE p.player_id = ANY($1::text[])
      ),
      per_game AS (
        SELECT player_id, game_id,
               bool_and(won) AS won,
               bool_or(draw) AS draw,
               bool_or(pilot_kind = 'bot') AS any_bot,
               min(bot_tier) FILTER (WHERE pilot_kind = 'bot') AS difficulty
        FROM opposing
        GROUP BY player_id, game_id
      )
      SELECT player_id,
             CASE WHEN any_bot THEN 'bot' ELSE 'human' END AS kind,
             CASE WHEN any_bot THEN difficulty END AS difficulty,
             count(*) AS games,
             count(*) FILTER (WHERE won) AS wins,
             count(*) FILTER (WHERE draw) AS draws
      FROM per_game
      GROUP BY 1, 2, 3
      ORDER BY player_id ASC, count(*) DESC, 3 ASC NULLS LAST
    `,
    [playerIds],
  );

  for (const row of result.rows) {
    let entry = stats.get(row.player_id);
    if (!entry) {
      entry = { human: { games: 0, wins: 0, draws: 0 }, bots: [] };
      stats.set(row.player_id, entry);
    }
    const games = Number(row.games);
    const wins = Number(row.wins);
    const draws = Number(row.draws);
    if (row.kind === 'bot') {
      entry.bots.push({ difficulty: row.difficulty ?? UNKNOWN_BOT_TIER, games, wins, draws });
    } else {
      // 'unknown' pilot kinds land here too — not a bot, so not a bot row.
      entry.human.games += games;
      entry.human.wins += wins;
      entry.human.draws += draws;
    }
  }
  return stats;
}

/** Bot difficulties a win has to be against to count as a challenge badge. */
const CHALLENGE_DIFFICULTIES = ['hard', 'expert'];

/**
 * The two "how did you win it" records the accounts service's `clutch` and
 * `speedrunner` badges are thresholds over (JollyGrin/unbrewed-api#26).
 *
 * A qualifying game is a win by the player's own seat, not a draw, that ended
 * in a `hero_defeated` kill against a side with at least one `hard` or `expert`
 * bot. Every clause there is load-bearing:
 *
 *  - **`hero_defeated` only.** A forfeit is recorded as a win too, and the data
 *    already holds turn-1 forfeits — without this, "win in 5 turns" is a badge
 *    for having an opponent who quit.
 *  - **`stamped_difficulty` only** — the one predicate in this file that reads
 *    the raw column instead of `bot_tier`. The label decoder (#58) maps the
 *    starved-hard era (`bot:mc(64, 400ms)`, 400ms of search) onto `hard`, which
 *    is right for weighting a tier's win rate and wrong for "you beat a hard bot
 *    in five turns". A legacy row therefore does not count however hard the bot
 *    behind it looks; the backfill (#60) is what makes an old game count, by
 *    stamping the column, not a looser predicate here.
 *  - **`final_health = 1` exactly**, not `<= 1`: the badge is "on the brink",
 *    and a 0-HP winner is a producer bug rather than a tighter finish.
 *
 * `fastestBotWinTurns` is a MIN over the same set and is null for a player who
 * has never won one — the accounts service must not read "no record" as fast.
 * `turns` counts player activations rather than rounds; the guard against
 * non-positive values keeps a producer that reported 0 out of the record.
 */
async function playerBotChallenges(
  pool: Pool,
  playerId: string,
): Promise<Pick<PlayerStats, 'clutchWins' | 'fastestBotWinTurns'>> {
  // `min(turns)` is an int4 today, but pg hands larger numerics back as strings;
  // read it either way rather than letting a driver detail become a null record.
  const result = await pool.query<{ clutch_wins: string; fastest_turns: number | string | null }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE}),
      opposing AS (${OPPOSING_SEATS_CTE}),
      qualifying AS (
        SELECT p.final_health, p.turns
        FROM played p
        WHERE p.won AND NOT p.draw AND p.end_condition = 'hero_defeated'
          AND EXISTS (
            SELECT 1 FROM opposing o
            WHERE o.game_id = p.game_id
              AND o.pilot_kind = 'bot'
              AND o.stamped_difficulty = ANY($2::text[])
          )
      )
      SELECT count(*) FILTER (WHERE final_health = 1) AS clutch_wins,
             min(turns) FILTER (WHERE turns > 0) AS fastest_turns
      FROM qualifying
    `,
    [playerId, CHALLENGE_DIFFICULTIES],
  );

  const fastest = result.rows[0]?.fastest_turns ?? null;
  return {
    clutchWins: count(result.rows[0]?.clutch_wins ?? null),
    fastestBotWinTurns: fastest === null ? null : Number(fastest),
  };
}

// ---------------------------------------------------------------------------
// Community aggregates (stats dashboard T1, #72): `/accounts/community` and
// `/accounts/heroes/:heroId`. Field names, filters and rules are the stats
// dashboard contract's §0/§1a/§1b; nothing here is per-player history.
// ---------------------------------------------------------------------------

/** `window=all` (the default) or the current calendar month in UTC. */
export type CommunityWindow = 'all' | 'month';

/** Parse `?window=`: absent or blank is `all`, anything unrecognised is null (→ 400). */
export function parseCommunityWindow(value: string | null): CommunityWindow | null {
  if (value === null || value === '' || value === 'all') return 'all';
  if (value === 'month') return 'month';
  return null;
}

/** Start of `now`'s calendar month in UTC, or null for `all`. */
export function communityWindowStart(window: CommunityWindow, now: Date): Date | null {
  if (window === 'all') return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface CommunityKindCounts {
  human: number;
  hardExpert: number;
  casual: number;
}

export interface CommunityWeek extends CommunityKindCounts {
  /** YYYY-MM-DD, a Monday, UTC. */
  weekStart: string;
}

export interface CommunityHero {
  heroId: string;
  heroName: string | null;
  games: number;
  wins: number;
  draws: number;
  crown: { playerId: string; wins: number; games: number } | null;
}

export interface CommunityMatchup {
  heroId: string;
  opponentHeroId: string;
  games: number;
  wins: number;
  draws: number;
}

export interface CommunityPayload {
  window: CommunityWindow;
  windowStart: string | null;
  generatedAt: string;
  totals: CommunityKindCounts & {
    games: number;
    humanVsExpert: { games: number; wins: number };
  };
  weekly: CommunityWeek[];
  heroes: CommunityHero[];
  matchups: CommunityMatchup[];
}

export interface HeroPilot {
  playerId: string;
  games: number;
  wins: number;
  draws: number;
}

export interface HeroMatchup {
  opponentHeroId: string;
  opponentHeroName: string | null;
  games: number;
  wins: number;
  draws: number;
}

export interface HeroPayload {
  heroId: string;
  heroName: string | null;
  window: CommunityWindow;
  windowStart: string | null;
  generatedAt: string;
  games: number;
  wins: number;
  draws: number;
  totalHumanSeatGames: number;
  pilotCount: number;
  pilots: HeroPilot[];
  crown: HeroPilot | null;
  matchups: HeroMatchup[];
  byOpponentKind: CommunityKindCounts;
}

/** `weekly` always spans this many Monday-UTC weeks, the current one last. */
export const COMMUNITY_WEEKS = 12;
/** `pilots` on the hero page is capped here. */
export const HERO_PILOTS_LIMIT = 50;

/**
 * Qualifying community games (Q), one row per game, with its timestamp:
 *
 *   g.campaign_id IS NULL                 -- sim campaigns land in `games` too
 *   AND g.format IN ('duel', '1v1')       -- community aggregates are duel only
 *   AND EXISTS (human seat)               -- also removes every bot-vs-bot game
 *
 * Unwindowed on purpose: `weekly` ignores `window`, so each query applies its
 * own time predicate on `ts`. The format predicate can use `games_format_idx`;
 * the EXISTS probe hits the `game_seats` primary key (game_id leads it).
 */
const Q_GAMES_CTE = `
  SELECT g.id AS game_id, g.draw, ${ENDED_AT} AS ts
  FROM games g
  WHERE g.campaign_id IS NULL
    AND g.format IN ('duel', '1v1')
    AND EXISTS (SELECT 1 FROM game_seats h WHERE h.game_id = g.id AND h.pilot_kind = 'human')
`;

/**
 * Every human seat of a Q game (`q` must be in scope), with its opponent kind:
 * `human` when the opposing seat is human, `casual` for an easy/medium bot, and
 * `hardExpert` for any other bot tier — hard, expert and `unknown` alike (the
 * api prices unknown as hard). Tiers come from `bot-tier.ts`, stamped
 * `bot_difficulty` first. A seat whose only opposition is an `unknown` pilot
 * kind (or none at all, a producer bug) gets a null kind and sits in no bucket.
 * `vs_expert` feeds `totals.humanVsExpert`.
 */
const Q_OPPONENT_TIER = botTierSql('o.pilot', 'o.bot_difficulty');
const Q_HUMAN_SEATS_CTE = `
  SELECT s.game_id, q.ts, q.draw, s.hero_id, s.hero_name, s.won,
         NULLIF(btrim(s.player_id), '') AS player_id,
         CASE
           WHEN bool_or(o.pilot_kind = 'bot' AND ${Q_OPPONENT_TIER} NOT IN ('easy', 'medium')) THEN 'hardExpert'
           WHEN bool_or(o.pilot_kind = 'bot') THEN 'casual'
           WHEN bool_or(o.pilot_kind = 'human') THEN 'human'
         END AS opponent_kind,
         coalesce(bool_or(o.pilot_kind = 'bot' AND ${Q_OPPONENT_TIER} = 'expert'), false) AS vs_expert
  FROM q
  JOIN game_seats s ON s.game_id = q.game_id AND s.pilot_kind = 'human'
  -- The tier is decoded inside the aggregates, i.e. only for opposing seats of
  -- Q games; a derived table here gets flattened and decodes every sim seat.
  LEFT JOIN game_seats o ON o.game_id = s.game_id AND o.team_index <> s.team_index
  GROUP BY s.game_id, s.team_index, s.seat_index, q.ts, q.draw, s.hero_id, s.hero_name, s.won, s.player_id
`;

/**
 * Game kind per Q game (`human_seats` in scope): `human` with two human seats,
 * otherwise its human seat's opponent kind.
 */
const Q_GAME_KINDS_CTE = `
  SELECT game_id, min(ts) AS ts,
         CASE WHEN count(*) >= 2 THEN 'human' ELSE min(opponent_kind) END AS kind
  FROM human_seats
  GROUP BY game_id
`;

/**
 * Every seat of a Q game (human or bot pilot) against every opposing seat —
 * the matchup-cell grain. Each game contributes both orientations, so
 * `A|B.games == B|A.games`; mirrors and null hero ids are dropped.
 */
const Q_MATCHUP_PAIRS_CTE = `
  SELECT q.game_id, q.ts, q.draw, s.hero_id, s.won, o.hero_id AS opponent_hero_id,
         o.hero_name AS opponent_hero_name
  FROM q
  JOIN game_seats s ON s.game_id = q.game_id
  JOIN game_seats o ON o.game_id = s.game_id AND o.team_index <> s.team_index
  WHERE s.hero_id IS NOT NULL AND o.hero_id IS NOT NULL AND s.hero_id <> o.hero_id
`;

/**
 * Per (hero, signed-in player) standing in the window, ordered by the crown
 * rule: most wins, then fewer games, then whoever reached that win count first
 * (the timestamp of their latest win *is* the moment they reached it), then
 * `player_id` asc. Games/wins count distinct games so one account on both
 * seats of a mirror counts once. `rank` is 1 for the crown candidate.
 */
const HERO_PILOTS_CTE = `
  SELECT hero_id, player_id,
         count(DISTINCT game_id) AS games,
         count(DISTINCT game_id) FILTER (WHERE won) AS wins,
         count(DISTINCT game_id) FILTER (WHERE draw) AS draws,
         row_number() OVER (
           PARTITION BY hero_id
           ORDER BY count(DISTINCT game_id) FILTER (WHERE won) DESC,
                    count(DISTINCT game_id) ASC,
                    max(ts) FILTER (WHERE won) ASC NULLS LAST,
                    player_id ASC
         ) AS rank
  FROM human_seats
  WHERE player_id IS NOT NULL AND hero_id IS NOT NULL
    AND ($1::timestamptz IS NULL OR ts >= $1)
  GROUP BY hero_id, player_id
`;

interface CountRow {
  games: string;
  wins: string;
  draws: string;
}

function kindCounts(rows: Array<{ kind: string | null; n: string }>): CommunityKindCounts {
  const counts: CommunityKindCounts = { human: 0, hardExpert: 0, casual: 0 };
  for (const row of rows) {
    if (row.kind === 'human' || row.kind === 'hardExpert' || row.kind === 'casual') {
      counts[row.kind] += Number(row.n);
    }
  }
  return counts;
}

/** `GET /accounts/community` (contract §1a). */
export async function community(
  pool: Pool,
  options: { window: CommunityWindow; now: Date },
): Promise<CommunityPayload> {
  const start = communityWindowStart(options.window, options.now);
  const base = `q AS (${Q_GAMES_CTE}), human_seats AS (${Q_HUMAN_SEATS_CTE})`;

  const [totals, expert, weekly, heroes, crowns, matchups] = await Promise.all([
    pool.query<{ kind: string | null; n: string }>(
      `
        WITH ${base}, kinds AS (${Q_GAME_KINDS_CTE})
        SELECT kind, count(*) AS n
        FROM kinds
        WHERE $1::timestamptz IS NULL OR ts >= $1
        GROUP BY kind
      `,
      [start],
    ),
    pool.query<{ games: string; wins: string }>(
      `
        WITH ${base}
        SELECT count(*) AS games, count(*) FILTER (WHERE won) AS wins
        FROM human_seats
        WHERE vs_expert AND ($1::timestamptz IS NULL OR ts >= $1)
      `,
      [start],
    ),
    // Independent of `window`: always the last 12 Monday-UTC weeks, zero-filled.
    pool.query<{ week_start: string; human: string; hard_expert: string; casual: string }>(
      `
        WITH ${base}, kinds AS (${Q_GAME_KINDS_CTE}),
        weeks AS (
          SELECT generate_series(
                   date_trunc('week', $1::timestamptz AT TIME ZONE 'UTC') - interval '${COMMUNITY_WEEKS - 1} weeks',
                   date_trunc('week', $1::timestamptz AT TIME ZONE 'UTC'),
                   interval '1 week'
                 ) AS week
        )
        SELECT to_char(w.week, 'YYYY-MM-DD') AS week_start,
               count(k.game_id) FILTER (WHERE k.kind = 'human') AS human,
               count(k.game_id) FILTER (WHERE k.kind = 'hardExpert') AS hard_expert,
               count(k.game_id) FILTER (WHERE k.kind = 'casual') AS casual
        FROM weeks w
        LEFT JOIN kinds k
          ON k.ts >= (w.week AT TIME ZONE 'UTC')
         AND k.ts < ((w.week + interval '1 week') AT TIME ZONE 'UTC')
        GROUP BY w.week
        ORDER BY w.week ASC
      `,
      [options.now],
    ),
    pool.query<CountRow & { hero_id: string; hero_name: string | null }>(
      `
        WITH ${base}
        SELECT hero_id,
               (array_agg(hero_name ORDER BY ts DESC) FILTER (WHERE hero_name IS NOT NULL))[1] AS hero_name,
               count(*) AS games,
               count(*) FILTER (WHERE won) AS wins,
               count(*) FILTER (WHERE draw) AS draws
        FROM human_seats
        WHERE hero_id IS NOT NULL AND ($1::timestamptz IS NULL OR ts >= $1)
        GROUP BY hero_id
        ORDER BY count(*) DESC, hero_id ASC
      `,
      [start],
    ),
    pool.query<{ hero_id: string; player_id: string; games: string; wins: string }>(
      `
        WITH ${base}, pilots AS (${HERO_PILOTS_CTE})
        SELECT hero_id, player_id, games, wins
        FROM pilots
        WHERE rank = 1 AND wins > 0
      `,
      [start],
    ),
    pool.query<CountRow & { hero_id: string; opponent_hero_id: string }>(
      `
        WITH q AS (${Q_GAMES_CTE}), pairs AS (${Q_MATCHUP_PAIRS_CTE})
        SELECT hero_id, opponent_hero_id,
               count(*) AS games,
               count(*) FILTER (WHERE won) AS wins,
               count(*) FILTER (WHERE draw) AS draws
        FROM pairs
        WHERE $1::timestamptz IS NULL OR ts >= $1
        GROUP BY hero_id, opponent_hero_id
        ORDER BY count(*) DESC, hero_id ASC, opponent_hero_id ASC
      `,
      [start],
    ),
  ]);

  const kinds = kindCounts(totals.rows);
  const crownByHero = new Map(crowns.rows.map((row) => [row.hero_id, row]));

  return {
    window: options.window,
    windowStart: start?.toISOString() ?? null,
    generatedAt: options.now.toISOString(),
    totals: {
      games: totals.rows.reduce((sum, row) => sum + Number(row.n), 0),
      ...kinds,
      humanVsExpert: { games: count(expert.rows[0]?.games ?? null), wins: count(expert.rows[0]?.wins ?? null) },
    },
    weekly: weekly.rows.map((row) => ({
      weekStart: row.week_start,
      human: Number(row.human),
      hardExpert: Number(row.hard_expert),
      casual: Number(row.casual),
    })),
    heroes: heroes.rows.map((row) => {
      const crown = crownByHero.get(row.hero_id);
      return {
        heroId: row.hero_id,
        heroName: row.hero_name,
        games: Number(row.games),
        wins: Number(row.wins),
        draws: Number(row.draws),
        crown: crown ? { playerId: crown.player_id, wins: Number(crown.wins), games: Number(crown.games) } : null,
      };
    }),
    matchups: matchups.rows.map((row) => ({
      heroId: row.hero_id,
      opponentHeroId: row.opponent_hero_id,
      games: Number(row.games),
      wins: Number(row.wins),
      draws: Number(row.draws),
    })),
  };
}

/**
 * `GET /accounts/heroes/:heroId` (contract §1b). A hero with no games in the
 * window — or an id telemetry has never seen — is zeros and empty arrays, not
 * an error: a never-played hero is a valid page.
 */
export async function heroCommunity(
  pool: Pool,
  heroId: string,
  options: { window: CommunityWindow; now: Date },
): Promise<HeroPayload> {
  const start = communityWindowStart(options.window, options.now);
  const base = `q AS (${Q_GAMES_CTE}), human_seats AS (${Q_HUMAN_SEATS_CTE})`;

  const [name, totals, byKind, pilots, matchups] = await Promise.all([
    // The name is not windowed: a hero unplayed this month still has one.
    pool.query<{ hero_name: string | null }>(
      `
        WITH q AS (${Q_GAMES_CTE})
        SELECT s.hero_name
        FROM q
        JOIN game_seats s ON s.game_id = q.game_id
        WHERE s.hero_id = $1 AND s.hero_name IS NOT NULL
        ORDER BY q.ts DESC
        LIMIT 1
      `,
      [heroId],
    ),
    pool.query<CountRow & { total: string; pilot_count: string }>(
      `
        WITH ${base}
        SELECT count(*) FILTER (WHERE hero_id = $2) AS games,
               count(*) FILTER (WHERE hero_id = $2 AND won) AS wins,
               count(*) FILTER (WHERE hero_id = $2 AND draw) AS draws,
               count(*) AS total,
               count(DISTINCT player_id) FILTER (WHERE hero_id = $2) AS pilot_count
        FROM human_seats
        WHERE $1::timestamptz IS NULL OR ts >= $1
      `,
      [start, heroId],
    ),
    pool.query<{ kind: string | null; n: string }>(
      `
        WITH ${base}
        SELECT opponent_kind AS kind, count(*) AS n
        FROM human_seats
        WHERE hero_id = $2 AND ($1::timestamptz IS NULL OR ts >= $1)
        GROUP BY opponent_kind
      `,
      [start, heroId],
    ),
    pool.query<CountRow & { player_id: string }>(
      `
        WITH ${base}, pilots AS (${HERO_PILOTS_CTE})
        SELECT player_id, games, wins, draws
        FROM pilots
        WHERE hero_id = $2
        ORDER BY rank ASC
        LIMIT ${HERO_PILOTS_LIMIT}
      `,
      [start, heroId],
    ),
    pool.query<CountRow & { opponent_hero_id: string; opponent_hero_name: string | null }>(
      `
        WITH q AS (${Q_GAMES_CTE}), pairs AS (${Q_MATCHUP_PAIRS_CTE})
        SELECT opponent_hero_id,
               (array_agg(opponent_hero_name ORDER BY ts DESC)
                  FILTER (WHERE opponent_hero_name IS NOT NULL))[1] AS opponent_hero_name,
               count(*) AS games,
               count(*) FILTER (WHERE won) AS wins,
               count(*) FILTER (WHERE draw) AS draws
        FROM pairs
        WHERE hero_id = $2 AND ($1::timestamptz IS NULL OR ts >= $1)
        GROUP BY opponent_hero_id
        ORDER BY count(*) DESC, opponent_hero_id ASC
      `,
      [start, heroId],
    ),
  ]);

  const row = totals.rows[0];
  const pilotRows: HeroPilot[] = pilots.rows.map((pilot) => ({
    playerId: pilot.player_id,
    games: Number(pilot.games),
    wins: Number(pilot.wins),
    draws: Number(pilot.draws),
  }));
  const leader = pilotRows[0];

  return {
    heroId,
    heroName: name.rows[0]?.hero_name ?? null,
    window: options.window,
    windowStart: start?.toISOString() ?? null,
    generatedAt: options.now.toISOString(),
    games: count(row?.games ?? null),
    wins: count(row?.wins ?? null),
    draws: count(row?.draws ?? null),
    totalHumanSeatGames: count(row?.total ?? null),
    pilotCount: count(row?.pilot_count ?? null),
    pilots: pilotRows,
    crown: leader && leader.wins >= 1 ? leader : null,
    matchups: matchups.rows.map((matchup) => ({
      opponentHeroId: matchup.opponent_hero_id,
      opponentHeroName: matchup.opponent_hero_name,
      games: Number(matchup.games),
      wins: Number(matchup.wins),
      draws: Number(matchup.draws),
    })),
    byOpponentKind: kindCounts(byKind.rows),
  };
}
