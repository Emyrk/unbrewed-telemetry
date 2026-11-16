import type { PuzzleStatsResponse, PuzzleStatsRow } from '../types.js';

/**
 * Per-puzzle aggregates (#114) over `puzzle_attempts` only. Nothing here reads
 * a game table, and nothing in the game stats reads `puzzle_attempts`.
 *
 * One row per `puzzle_id`, over the attempts at its **latest version only** —
 * the highest `puzzle_version` any attempt at that puzzle carries, returned as
 * `puzzleVersion` (#116). A re-frozen puzzle is a different position, so it
 * starts from zero rather than keeping the old one's solve rate; attempts at
 * older versions stay in the table and are in no number here. Definitions,
 * each over that version's attempts:
 * - `attempts`: every recorded attempt, whatever its result.
 * - `solvedAttempts`: attempts with `result = 'solved'`. Ingest refuses
 *   `solved` together with `solution_shown: true`, so no solved attempt was
 *   shown the solution. A solve after a hint does count: `hint_used` is stored
 *   but not filtered on.
 * - a **player** is `coalesce(account_id, analytics_id)`. An attempt with
 *   neither id counts in `attempts`/`solvedAttempts` but is nobody: it is in
 *   neither player count. A guest who later signs in is two players.
 * - `distinctPlayers`: distinct players with at least one attempt.
 * - `distinctSolvers`: distinct players with at least one solved attempt.
 * - `solveRate`: `distinctSolvers / distinctPlayers` — the share of distinct
 *   players who solved the puzzle at least once, NOT solved attempts over
 *   attempts. `null` when no attempt carried a player id.
 * - `medianSolveSeconds`: median `duration_ms` of solved attempts, in seconds
 *   (interpolated between the two middle values on an even count); `null` when
 *   nothing was solved.
 *
 * Aggregates only: no attempt, account or analytics id leaves this query.
 */
export const PUZZLE_STATS_SQL = `
  SELECT
    puzzle_id,
    puzzle_version,
    count(*)::int AS attempts,
    (count(*) FILTER (WHERE result = 'solved'))::int AS solved_attempts,
    (count(DISTINCT COALESCE(account_id, analytics_id)))::int AS distinct_players,
    (count(DISTINCT COALESCE(account_id, analytics_id)) FILTER (WHERE result = 'solved'))::int AS distinct_solvers,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE result = 'solved'))::float8
      AS median_solve_ms
  FROM puzzle_attempts
  JOIN (
    SELECT puzzle_id, max(puzzle_version) AS puzzle_version
    FROM puzzle_attempts
    GROUP BY puzzle_id
  ) latest USING (puzzle_id, puzzle_version)
  GROUP BY puzzle_id, puzzle_version
  ORDER BY puzzle_id
`;

export interface PuzzleStatsSqlRow {
  puzzle_id: string;
  puzzle_version: number;
  attempts: number;
  solved_attempts: number;
  distinct_players: number;
  distinct_solvers: number;
  median_solve_ms: number | null;
}

/** Map the `PUZZLE_STATS_SQL` rows into the API shape. */
export function puzzleStats(rows: readonly PuzzleStatsSqlRow[], generatedAt: Date): PuzzleStatsResponse {
  return {
    generatedAt: generatedAt.toISOString(),
    puzzles: rows.map((row): PuzzleStatsRow => ({
      puzzleId: row.puzzle_id,
      puzzleVersion: row.puzzle_version,
      attempts: row.attempts,
      solvedAttempts: row.solved_attempts,
      distinctPlayers: row.distinct_players,
      distinctSolvers: row.distinct_solvers,
      solveRate: row.distinct_players > 0 ? row.distinct_solvers / row.distinct_players : null,
      medianSolveSeconds: row.median_solve_ms === null ? null : row.median_solve_ms / 1000,
    })),
  };
}
