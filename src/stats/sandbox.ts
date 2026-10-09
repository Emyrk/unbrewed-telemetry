import type { SandboxStatsResponse } from '../types.js';

/**
 * The trailing-window sandbox usage aggregate (#84), over the raw
 * `sandbox_events` stream only. Nothing here reads a Pro table, and nothing in
 * the Pro stats reads `sandbox_events`: the two buckets never mix.
 *
 * This is the single definition: the repository executes it, the
 * `GET /v1/stats/sandbox` endpoint serves it, and `scripts/sandbox-stats.mts`
 * runs it against any database. Keep it one query so they never drift.
 *
 * `$1` is the window cutoff (a timestamptz); rows received at or after it are
 * counted. Like queue events, the window is on `received_at` (server clock),
 * so a relay with a skewed clock cannot fall outside every window.
 *
 * Definitions:
 * - `roomsOpened`: distinct rooms with a `room_opened` event.
 * - `games`: distinct rooms where at least two distinct `player_hash` values
 *   joined. A room one person opened to fiddle with is not a game. `daily`
 *   applies the same rule per UTC day, so a room whose joins straddle midnight
 *   can count on neither day while counting once in the window total.
 * - `uniquePlayers`: distinct hashes with a `player_joined`.
 * - `returningPlayers`: of those, hashes that appear on any event received
 *   before the window.
 * - `hourOfWeek`: `player_joined` counts by UTC day of week (0 = Sunday) and
 *   hour, zero-filled to all 7×24 cells.
 * - `topHeroes`: distinct players per `hero_seen` hero name, top 10.
 */
export const SANDBOX_STATS_SQL = `
  WITH w AS (
    SELECT type, room_id, player_hash, hero_name, connections,
           (received_at AT TIME ZONE 'UTC') AS at_utc
    FROM sandbox_events
    WHERE received_at >= $1
  ),
  joins AS (
    SELECT room_id, player_hash, at_utc FROM w WHERE type = 'player_joined'
  ),
  game_rooms AS (
    SELECT room_id FROM joins GROUP BY room_id HAVING count(DISTINCT player_hash) >= 2
  ),
  daily_rooms AS (
    SELECT at_utc::date AS day, count(DISTINCT room_id) AS rooms_opened
    FROM w WHERE type = 'room_opened' GROUP BY 1
  ),
  daily_players AS (
    SELECT at_utc::date AS day, count(DISTINCT player_hash) AS unique_players
    FROM joins GROUP BY 1
  ),
  daily_games AS (
    SELECT day, count(*) AS games
    FROM (
      SELECT at_utc::date AS day, room_id FROM joins
      GROUP BY 1, 2 HAVING count(DISTINCT player_hash) >= 2
    ) g
    GROUP BY day
  ),
  hour_counts AS (
    SELECT extract(dow FROM at_utc)::int AS dow, extract(hour FROM at_utc)::int AS hour, count(*) AS joins
    FROM joins GROUP BY 1, 2
  ),
  heroes AS (
    SELECT hero_name, count(DISTINCT player_hash) AS players
    FROM w WHERE type = 'hero_seen' GROUP BY hero_name
    ORDER BY players DESC, hero_name
    LIMIT 10
  )
  SELECT
    (SELECT count(DISTINCT room_id) FROM w WHERE type = 'room_opened')::int AS rooms_opened,
    (SELECT count(*) FROM game_rooms)::int AS games,
    (SELECT count(DISTINCT player_hash) FROM joins)::int AS unique_players,
    (SELECT count(*) FROM (SELECT DISTINCT player_hash FROM joins) p
       WHERE EXISTS (
         SELECT 1 FROM sandbox_events e
         WHERE e.player_hash = p.player_hash AND e.received_at < $1
       ))::int AS returning_players,
    (SELECT max(connections) FROM w)::int AS peak_connections,
    COALESCE((
      SELECT json_agg(json_build_object(
        'date', to_char(day, 'YYYY-MM-DD'),
        'roomsOpened', COALESCE(r.rooms_opened, 0),
        'games', COALESCE(g.games, 0),
        'uniquePlayers', COALESCE(p.unique_players, 0)
      ) ORDER BY day)
      FROM daily_rooms r
      FULL JOIN daily_players p USING (day)
      FULL JOIN daily_games g USING (day)
    ), '[]'::json) AS daily,
    (
      SELECT json_agg(json_build_object('dow', d, 'hour', h, 'joins', COALESCE(c.joins, 0)) ORDER BY d, h)
      FROM generate_series(0, 6) d
      CROSS JOIN generate_series(0, 23) h
      LEFT JOIN hour_counts c ON c.dow = d AND c.hour = h
    ) AS hour_of_week,
    COALESCE((
      SELECT json_agg(json_build_object('heroName', hero_name, 'players', players) ORDER BY players DESC, hero_name)
      FROM heroes
    ), '[]'::json) AS top_heroes
`;

export interface SandboxStatsRow {
  rooms_opened: number;
  games: number;
  unique_players: number;
  returning_players: number;
  peak_connections: number | null;
  daily: SandboxStatsResponse['daily'];
  hour_of_week: SandboxStatsResponse['hourOfWeek'];
  top_heroes: SandboxStatsResponse['topHeroes'];
}

/** Map the one `SANDBOX_STATS_SQL` row into the API shape. */
export function sandboxStats(
  row: SandboxStatsRow,
  windowHours: number,
  generatedAt: Date,
): SandboxStatsResponse {
  return {
    windowHours,
    generatedAt: generatedAt.toISOString(),
    roomsOpened: row.rooms_opened,
    games: row.games,
    uniquePlayers: row.unique_players,
    returningPlayers: row.returning_players,
    peakConnections: row.peak_connections,
    daily: row.daily,
    hourOfWeek: row.hour_of_week,
    topHeroes: row.top_heroes,
  };
}

/** Default and cap for `windowHours`: a week, and a year. */
export const SANDBOX_DEFAULT_WINDOW_HOURS = 168;
export const SANDBOX_MAX_WINDOW_HOURS = 24 * 366;
