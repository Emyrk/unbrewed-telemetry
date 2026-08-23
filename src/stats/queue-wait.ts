import type { QueueWaitBucket } from '../types.js';

/**
 * The trailing-window matchmaking wait aggregate (#68), split by `quick_match`.
 *
 * This is the single definition of the estimate: the repository executes it,
 * `scripts/queue-wait-stats.mts` runs it against any database, and the future
 * "typical wait" figure on the matchmaking screen consumes its shape. Keep it
 * one query so the two never drift.
 *
 * `$1` is the window cutoff (a timestamptz); rows received at or after it are
 * counted. Callers derive it from a window length so tests can pin "now".
 *
 * Notes on the shape:
 * - The wait percentiles cover `matched` only. A `waitMs` on an `abandoned`
 *   search is how long someone waited before giving up, which is a different
 *   question and would drag the estimate away from "wait until a match".
 * - `percentile_cont` interpolates and ignores NULL `wait_ms`, so events from a
 *   producer that omits the field lower `wait_samples` without skewing p50/p75.
 * - Match rate is `matched / search_started` over the window, so searches still
 *   open at the window edge count as unmatched. Over a window much longer than
 *   a typical search that bias is small; a short window will read pessimistic.
 */
export const QUEUE_WAIT_STATS_SQL = `
  SELECT
    quick_match,
    count(*) FILTER (WHERE type = 'search_started') AS search_started,
    count(*) FILTER (WHERE type = 'matched') AS matched,
    count(*) FILTER (WHERE type = 'abandoned') AS abandoned,
    count(wait_ms) FILTER (WHERE type = 'matched') AS wait_samples,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_ms)
      FILTER (WHERE type = 'matched') AS median_wait_ms,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY wait_ms)
      FILTER (WHERE type = 'matched') AS p75_wait_ms
  FROM queue_events
  WHERE received_at >= $1
  GROUP BY quick_match
  ORDER BY quick_match DESC
`;

export interface QueueWaitStatsRow {
  quick_match: boolean;
  search_started: string | number;
  matched: string | number;
  abandoned: string | number;
  wait_samples: string | number;
  median_wait_ms: string | number | null;
  p75_wait_ms: string | number | null;
}

function count(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function millis(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

/** Map one `QUEUE_WAIT_STATS_SQL` row into the API shape. */
export function queueWaitBucket(row: QueueWaitStatsRow): QueueWaitBucket {
  const searchStarted = count(row.search_started);
  const matched = count(row.matched);
  return {
    quickMatch: row.quick_match,
    searchStarted,
    matched,
    abandoned: count(row.abandoned),
    matchRate: searchStarted > 0 ? matched / searchStarted : null,
    waitSamples: count(row.wait_samples),
    medianWaitMs: millis(row.median_wait_ms),
    p75WaitMs: millis(row.p75_wait_ms),
  };
}

/** The cutoff `QUEUE_WAIT_STATS_SQL` takes as `$1`, for a trailing window. */
export function windowCutoff(now: Date, windowHours: number): Date {
  return new Date(now.getTime() - windowHours * 60 * 60 * 1000);
}
