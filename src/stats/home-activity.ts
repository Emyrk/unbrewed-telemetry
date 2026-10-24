import { scopeSql } from './lens.js';

/**
 * "When people play" (#96): games bucketed by UTC day-of-week and hour over a
 * fixed trailing window. Global by design — no deck/format/map/range lens, only
 * `scope` — so the heat map does not move when someone narrows the dashboard.
 *
 * Counts are GAMES, not players: `pilot` carries no identity, so distinct
 * players would not be honest yet (`unit: "games"`).
 *
 * Buckets are UTC (`dow` 0 = Sunday, like the sandbox hour-of-week). Clients
 * rotate them into local time; zones with a 30 or 45 minute offset
 * (e.g. India +5:30, Nepal +5:45) cannot be expressed in whole-hour buckets, so
 * their local view is approximate.
 */
export const ACTIVITY_DAYS = 28;
export const ACTIVITY_SCOPES = ['human', 'all'] as const;
export type ActivityScope = (typeof ACTIVITY_SCOPES)[number];

/**
 * `$1` is the window cutoff. The scope predicate is the shared lens one
 * (`scopeSql`): live games only (`LIVE_GAME_SQL`, in both scopes, so lab and
 * campaign sims never appear), and for `human` at least one human seat. `all`
 * adds live bot-only games. The end time is `COALESCE(ended_at, received_at)`,
 * always bucketed in UTC regardless of the session time zone.
 */
export function homeActivitySql(scope: ActivityScope): string {
  return `
  SELECT extract(dow FROM t)::int AS dow, extract(hour FROM t)::int AS hour, count(*)::int AS n
  FROM (
    SELECT (COALESCE(g.ended_at, g.received_at) AT TIME ZONE 'UTC') AS t
    FROM games g
    WHERE COALESCE(g.ended_at, g.received_at) >= $1
      AND ${scopeSql(scope)}
  ) x
  GROUP BY 1, 2
`;
}

export interface ActivityCellRow { dow: number; hour: number; n: number }
export interface ActivitySlot { dow: number; hour: number; n: number }
export interface ActivityQuietRun { startHour: number; endHour: number; hours: number }

export interface HomeActivityResponse {
  scope: ActivityScope;
  unit: 'games';
  days: number;
  timezone: 'UTC';
  total: number;
  /** grid[dow][hour], dow 0 = Sunday, always 7×24. */
  grid: number[][];
  peak: ActivitySlot[];
  quiet: ActivityQuietRun | null;
  generatedAt: string;
}

/**
 * Longest circular run of hours (summed over days of the week) at or below
 * half the mean hourly total. Ties go to the earliest start hour. `endHour` is
 * the last hour inside the run; the run may wrap past 23. Null with no games.
 */
export function quietRun(grid: number[][]): ActivityQuietRun | null {
  const hourly = Array.from({ length: 24 }, (_, h) => grid.reduce((sum, row) => sum + (row[h] ?? 0), 0));
  const total = hourly.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const limit = total / 24 / 2;
  const low = hourly.map((n) => n <= limit);
  let best: ActivityQuietRun | null = null;
  for (let start = 0; start < 24; start++) {
    if (!low[start] || low[(start + 23) % 24]) continue; // only run starts
    let len = 0;
    while (len < 24 && low[(start + len) % 24]) len++;
    if (!best || len > best.hours) best = { startHour: start, endHour: (start + len - 1) % 24, hours: len };
  }
  return best;
}

export function homeActivity(
  rows: ActivityCellRow[],
  scope: ActivityScope,
  generatedAt: Date,
): HomeActivityResponse {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) grid[r.dow]![r.hour] = Number(r.n);
  const slots: ActivitySlot[] = [];
  let total = 0;
  grid.forEach((row, dow) => row.forEach((n, hour) => {
    total += n;
    if (n > 0) slots.push({ dow, hour, n });
  }));
  slots.sort((a, b) => b.n - a.n || a.dow - b.dow || a.hour - b.hour);
  return {
    scope,
    unit: 'games',
    days: ACTIVITY_DAYS,
    timezone: 'UTC',
    total,
    grid,
    peak: slots.slice(0, 3),
    quiet: quietRun(grid),
    generatedAt: generatedAt.toISOString(),
  };
}
