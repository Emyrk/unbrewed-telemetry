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

export interface PlayerStats {
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  byHero: PlayerHeroStat[];
  firstGameAt: string | null;
  lastGameAt: string | null;
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
         s.game_id, s.team_index, s.seat_index, s.hero_id, s.hero_name, s.won, s.final_health
  FROM game_seats s
  WHERE s.player_id = $1
  ORDER BY s.game_id, s.team_index, s.seat_index
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

/** Lifetime aggregates for one player. Sim games excluded. */
export async function playerStats(pool: Pool, playerId: string): Promise<PlayerStats> {
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

  const stats: PlayerStats = {
    totalGames: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    byHero: [],
    firstGameAt: null,
    lastGameAt: null,
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
