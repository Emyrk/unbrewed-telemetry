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
 */

import type { Pool } from 'pg';

/** Default page size for the games feed when the caller does not ask. */
export const PLAYER_GAMES_DEFAULT_LIMIT = 20;
/** Hard cap on page size, whatever the caller asks for. */
export const PLAYER_GAMES_MAX_LIMIT = 50;

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

export interface PlayerHeroStat {
  heroId: string | null;
  heroName: string | null;
  games: number;
  wins: number;
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

export interface PlayerMapStat {
  map: string;
  games: number;
  wins: number;
}

/** games/wins for one slice of the player's history. */
export interface PlayerSplitStat {
  games: number;
  wins: number;
}

export interface PlayerBotStat extends PlayerSplitStat {
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
  SELECT mine.game_id, mine.team_index, mine.won, mine.first_player,
         g.draw, g.map, g.turns, g.duration_seconds, g.first_player_team,
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
  SELECT p.game_id, p.won, o.hero_id, o.hero_name, o.pilot_kind, o.bot_difficulty
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
 * Six independent grouped queries rather than one mega-query: they share the
 * same two CTEs but group differently, and this endpoint sits behind
 * unbrewed-api's 60s per-user cache, so the round trips are cheap relative to
 * the readability. Nothing is aggregated in JS — the queries return one row per
 * output row.
 */
export async function playerStats(pool: Pool, playerId: string): Promise<PlayerStats> {
  const [totals, overview, streaks, byOpponentHero, byMap, byOpponentKind] = await Promise.all([
    playerTotals(pool, playerId),
    playerOverview(pool, playerId),
    playerStreaks(pool, playerId),
    playerByOpponentHero(pool, playerId),
    playerByMap(pool, playerId),
    playerByOpponentKind(pool, playerId),
  ]);

  return {
    ...totals,
    ...overview,
    ...streaks,
    byOpponentHero,
    byMap,
    byOpponentKind,
  };
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
    stats.byHero.push({ heroId: row.hero_id, heroName: row.hero_name, games, wins });
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
    second_games: string;
    second_wins: string;
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE})
      SELECT round(avg(duration_seconds)::numeric, 1) AS avg_duration_seconds,
             round(avg(turns)::numeric, 1) AS avg_turns,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND first_player) AS first_games,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND first_player AND won) AS first_wins,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND NOT first_player) AS second_games,
             count(*) FILTER (WHERE first_player_team IS NOT NULL AND NOT first_player AND won) AS second_wins
      FROM played
    `,
    [playerId],
  );

  const row = result.rows[0];
  if (!row) {
    return {
      avgDurationSeconds: null,
      avgTurns: null,
      firstPlayer: { first: { games: 0, wins: 0 }, second: { games: 0, wins: 0 } },
    };
  }
  return {
    avgDurationSeconds: mean(row.avg_duration_seconds),
    avgTurns: mean(row.avg_turns),
    firstPlayer: {
      first: { games: count(row.first_games), wins: count(row.first_wins) },
      second: { games: count(row.second_games), wins: count(row.second_wins) },
    },
  };
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
      ordered AS (
        SELECT (won AND NOT draw) AS is_win,
               (CASE WHEN draw THEN 'D' WHEN won THEN 'W' ELSE 'L' END)::text AS result,
               row_number() OVER (ORDER BY ended_at, game_id) AS rn
        FROM played
      ),
      islands AS (
        SELECT is_win, rn,
               rn - row_number() OVER (PARTITION BY is_win ORDER BY rn) AS run_id
        FROM ordered
      ),
      runs AS (
        SELECT run_id, count(*) AS len, max(rn) AS last_rn
        FROM islands
        WHERE is_win
        GROUP BY run_id
      )
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
 * Human vs bot opposition, and per-difficulty rows for the bot side.
 *
 * A game counts as a bot game if **any** opposing seat is a bot. Mixed human/bot
 * opposition only happens when a human drops and a bot takes over, or in a
 * hand-assembled lobby; classifying such a game as "vs bots" keeps the human
 * bucket meaning "I beat only people", which is the claim a player cares about.
 * For the same reason a mixed-difficulty bot side reports its alphabetically
 * first difficulty — one row per game, deterministically chosen.
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
  }>(
    `
      WITH mine AS (${PLAYER_SEATS_CTE}),
      played AS (${PLAYER_GAMES_CTE}),
      opposing AS (${OPPOSING_SEATS_CTE}),
      per_game AS (
        SELECT game_id,
               bool_and(won) AS won,
               bool_or(pilot_kind = 'bot') AS any_bot,
               min(COALESCE(NULLIF(bot_difficulty, ''), 'unknown'))
                 FILTER (WHERE pilot_kind = 'bot') AS difficulty
        FROM opposing
        GROUP BY game_id
      )
      SELECT CASE WHEN any_bot THEN 'bot' ELSE 'human' END AS kind,
             CASE WHEN any_bot THEN difficulty END AS difficulty,
             count(*) AS games,
             count(*) FILTER (WHERE won) AS wins
      FROM per_game
      GROUP BY 1, 2
      ORDER BY count(*) DESC, 2 ASC NULLS LAST
    `,
    [playerId],
  );

  const stats: PlayerOpponentKindStats = { human: { games: 0, wins: 0 }, bots: [] };
  for (const row of result.rows) {
    const games = Number(row.games);
    const wins = Number(row.wins);
    if (row.kind === 'bot') {
      stats.bots.push({ difficulty: row.difficulty ?? 'unknown', games, wins });
    } else {
      // 'unknown' pilot kinds land here too — not a bot, so not a bot row.
      stats.human.games += games;
      stats.human.wins += wins;
    }
  }
  return stats;
}
