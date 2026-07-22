/**
 * "Road to Expert+" journey aggregation (#248 follow-up). A public, read-only,
 * NO-AUTH view of the ISMCTS measurement mission's campaign ladder.
 *
 * Reads EXPERIMENT DATA ONLY — `sim_campaigns` / `sim_jobs` and campaign-scoped
 * rows of `games`/`game_seats` (filtered by `campaign_id`). It never returns a
 * production (non-campaign) game, and only aggregates (win rates, counts, runner
 * liveness) — no per-player rows — so it is safe to expose without auth, matching
 * the existing public `/v1/stats/*` reads.
 *
 * The mission is a set of campaigns identified by name (`grid`, `arm1`, …). The
 * caller passes the ordered names; each resolves to its most recent campaign.
 */

import type { Pool } from 'pg';
import { wilson } from '../stats/wilson.js';

export interface JourneyPilotStat {
  pilot: string;
  games: number;
  wins: number;
  rate: number;
  wilson95: [number, number];
}

export interface JourneyRunner {
  runner: string;
  leasedJobs: number;
  lastLeasedAt: string | null;
  /** Alive if it holds a lease that has not expired. */
  live: boolean;
}

export interface JourneyStep {
  name: string;
  found: boolean;
  status: 'pending' | 'active' | 'completed' | 'paused' | 'cancelled';
  totalGames: number;
  completedGames: number;
  failedGames: number;
  leasedJobs: number;
  mixedContentVersion: boolean;
  pilots: JourneyPilotStat[];
  /** The distinguished "hero" pilot (ismcts/expert side) for the gate bar. */
  hero: JourneyPilotStat | null;
}

export interface Journey {
  ok: true;
  generatedAt: string;
  steps: JourneyStep[];
  runners: JourneyRunner[];
}

const HERO_HINT = /ismcts|expert/i;

export async function simJourney(pool: Pool, names: string[], nowMs: number): Promise<Journey> {
  const steps: JourneyStep[] = [];
  for (const name of names) {
    steps.push(await stepFor(pool, name));
  }
  const runners = await activeRunners(pool, names, nowMs);
  return { ok: true, generatedAt: new Date(nowMs).toISOString(), steps, runners };
}

async function stepFor(pool: Pool, name: string): Promise<JourneyStep> {
  const camp = await pool.query<{
    id: string; status: string; total_games: number; completed_games: number; failed_games: number;
  }>(
    `SELECT id, status, total_games, completed_games, failed_games
     FROM sim_campaigns WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
    [name],
  );
  if (camp.rowCount === 0) {
    return { name, found: false, status: 'pending', totalGames: 0, completedGames: 0, failedGames: 0, leasedJobs: 0, mixedContentVersion: false, pilots: [], hero: null };
  }
  const c = camp.rows[0]!;

  const pilotRows = await pool.query<{ pilot: string; games: string; wins: string }>(
    `SELECT gs.pilot, count(*)::bigint AS games, count(*) FILTER (WHERE gs.won)::bigint AS wins
     FROM games g JOIN game_seats gs ON gs.game_id = g.id
     WHERE g.campaign_id = $1 GROUP BY gs.pilot ORDER BY gs.pilot`,
    [c.id],
  );
  const versions = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT content_version)::bigint AS n FROM games WHERE campaign_id = $1`,
    [c.id],
  );
  const leased = await pool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM sim_jobs WHERE campaign_id = $1 AND status = 'leased'`,
    [c.id],
  );

  const pilots: JourneyPilotStat[] = pilotRows.rows.map((r) => {
    const games = Number(r.games);
    const wins = Number(r.wins);
    const w = wilson(wins, games);
    return { pilot: r.pilot, games, wins, rate: games > 0 ? wins / games : 0, wilson95: [w.lo, w.hi] };
  });
  const hero = pilots.find((p) => HERO_HINT.test(p.pilot)) ?? null;

  return {
    name,
    found: true,
    status: c.status as JourneyStep['status'],
    totalGames: c.total_games,
    completedGames: c.completed_games,
    failedGames: c.failed_games,
    leasedJobs: Number(leased.rows[0]!.n),
    mixedContentVersion: Number(versions.rows[0]!.n) > 1,
    pilots,
    hero,
  };
}

/** Runners currently holding leases across the mission's campaigns. */
async function activeRunners(pool: Pool, names: string[], nowMs: number): Promise<JourneyRunner[]> {
  if (names.length === 0) return [];
  const rows = await pool.query<{ runner: string; leased_jobs: string; last_leased_at: Date | null; live: boolean }>(
    `SELECT j.leased_by AS runner,
            count(*)::bigint AS leased_jobs,
            max(j.leased_at) AS last_leased_at,
            bool_or(j.lease_expires_at > now()) AS live
     FROM sim_jobs j
     JOIN sim_campaigns c ON c.id = j.campaign_id
     WHERE c.name = ANY($1) AND j.status = 'leased' AND j.leased_by IS NOT NULL
     GROUP BY j.leased_by
     ORDER BY last_leased_at DESC NULLS LAST`,
    [names],
  );
  void nowMs;
  return rows.rows.map((r) => ({
    runner: r.runner,
    leasedJobs: Number(r.leased_jobs),
    lastLeasedAt: r.last_leased_at ? r.last_leased_at.toISOString() : null,
    live: r.live,
  }));
}

// ---------------------------------------------------------------------------
// Expanded per-step detail (#248 follow-up) — the three-zone card body. Lazily
// loaded when a step card is expanded, so the ladder payload stays small. Still
// aggregates-only, experiment-namespace-only, no auth.
// ---------------------------------------------------------------------------

export interface ChunkBucket {
  done: number;
  leased: number;
  pending: number;
  failed: number;
  total: number;
}

export interface HostContribution {
  host: string;
  gamesDone: number;
  gamesPerHour: number;
  sharePct: number;
  lastSeen: string | null;
  live: boolean;
}

export interface VariantRow {
  pilot: string;
  games: number;
  wins: number;
  rate: number;
  wilson95: [number, number];
  avgCostSec: number | null;
}

export interface GateMath {
  needGames: number;
  needRate: number;
  currentGames: number;
  currentRate: number;
  lo: number;
  hi: number;
  passes: boolean;
  sentence: string;
}

export interface StepDetail {
  ok: true;
  name: string;
  found: boolean;
  status: string;
  totalGames: number;
  completedGames: number;
  failedGames: number;
  leasedJobs: number;
  retriedJobs: number;
  ratePerHour: number;
  etaHours: number | null;
  hero: JourneyPilotStat | null;
  variants: VariantRow[];
  chunkStrip: ChunkBucket[];
  hosts: HostContribution[];
  contentVersions: string[];
  mixedContentVersion: boolean;
  gate: GateMath | null;
}

const LIVE_WINDOW_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 80;

export async function stepDetail(pool: Pool, name: string, nowMs: number): Promise<StepDetail> {
  const camp = await pool.query<{ id: string; status: string; total_games: number; completed_games: number; failed_games: number }>(
    `SELECT id, status, total_games, completed_games, failed_games FROM sim_campaigns WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
    [name],
  );
  if (camp.rowCount === 0) {
    return { ok: true, name, found: false, status: 'pending', totalGames: 0, completedGames: 0, failedGames: 0, leasedJobs: 0, retriedJobs: 0, ratePerHour: 0, etaHours: null, hero: null, variants: [], chunkStrip: [], hosts: [], contentVersions: [], mixedContentVersion: false, gate: null };
  }
  const c = camp.rows[0]!;
  const total = c.total_games;
  const nBuckets = Math.max(1, Math.min(MAX_BUCKETS, total));

  // Zone A — per-variant/pilot rows (win rate + CI + per-game cost).
  const variantRows = await pool.query<{ pilot: string; games: string; wins: string; cost: string | null }>(
    `SELECT gs.pilot,
            count(*)::bigint AS games,
            count(*) FILTER (WHERE gs.won)::bigint AS wins,
            avg(g.duration_seconds) AS cost
     FROM games g JOIN game_seats gs ON gs.game_id = g.id
     WHERE g.campaign_id = $1 GROUP BY gs.pilot ORDER BY gs.pilot`,
    [c.id],
  );
  const variants: VariantRow[] = variantRows.rows.map((r) => {
    const games = Number(r.games);
    const wins = Number(r.wins);
    const w = wilson(wins, games);
    return { pilot: r.pilot, games, wins, rate: games > 0 ? wins / games : 0, wilson95: [w.lo, w.hi], avgCostSec: r.cost === null ? null : Number(r.cost) };
  });
  const hero = variants.find((v) => /ismcts|expert/i.test(v.pilot)) ?? null;
  const heroStat: JourneyPilotStat | null = hero ? { pilot: hero.pilot, games: hero.games, wins: hero.wins, rate: hero.rate, wilson95: hero.wilson95 } : null;

  // Zone A — chunk strip: done from games (by campaign_game_index), leased/
  // pending/failed from sim_jobs (by game_index), bucketed server-side.
  const doneB = await pool.query<{ b: number; c: string }>(
    `SELECT width_bucket(campaign_game_index, 0, $2, $3) AS b, count(*)::bigint AS c
     FROM games WHERE campaign_id = $1 AND campaign_game_index IS NOT NULL GROUP BY b`,
    [c.id, total, nBuckets],
  );
  const jobB = await pool.query<{ b: number; status: string; c: string }>(
    `SELECT width_bucket(game_index, 0, $2, $3) AS b, status, count(*)::bigint AS c
     FROM sim_jobs WHERE campaign_id = $1 GROUP BY b, status`,
    [c.id, total, nBuckets],
  );
  const strip: ChunkBucket[] = Array.from({ length: nBuckets }, () => ({ done: 0, leased: 0, pending: 0, failed: 0, total: 0 }));
  const idxOf = (b: number): number => Math.max(0, Math.min(nBuckets - 1, b - 1));
  for (const r of doneB.rows) strip[idxOf(r.b)]!.done += Number(r.c);
  for (const r of jobB.rows) {
    const cell = strip[idxOf(r.b)]!;
    if (r.status === 'leased') cell.leased += Number(r.c);
    else if (r.status === 'pending') cell.pending += Number(r.c);
    else if (r.status === 'failed') cell.failed += Number(r.c);
  }
  for (const cell of strip) cell.total = cell.done + cell.leased + cell.pending + cell.failed;

  // Zone A — fleet rate + ETA (games completed in the last hour).
  const rate = await pool.query<{ last_hour: string }>(
    `SELECT count(*)::bigint AS last_hour FROM games WHERE campaign_id = $1 AND received_at > now() - interval '1 hour'`,
    [c.id],
  );
  const ratePerHour = Number(rate.rows[0]!.last_hour);
  const remaining = Math.max(0, total - c.completed_games);
  const etaHours = ratePerHour > 0 && remaining > 0 ? remaining / ratePerHour : null;

  // Zone B — per-host contributors (credential = per-host identity).
  const hostRows = await pool.query<{ label: string | null; key: string | null; done: string; last_hour: string; last_at: Date | null }>(
    `SELECT sc.label AS label, sub.auth_key_id AS key,
            count(*)::bigint AS done,
            count(*) FILTER (WHERE g.received_at > now() - interval '1 hour')::bigint AS last_hour,
            max(g.received_at) AS last_at
     FROM games g
     JOIN game_submissions sub ON sub.id = g.submission_id
     LEFT JOIN source_credentials sc ON sc.id = sub.auth_key_id
     WHERE g.campaign_id = $1
     GROUP BY sc.label, sub.auth_key_id
     ORDER BY done DESC`,
    [c.id],
  );
  const totalDone = hostRows.rows.reduce((s, r) => s + Number(r.done), 0) || 1;
  const hosts: HostContribution[] = hostRows.rows.map((r) => {
    const lastAt = r.last_at ? r.last_at.getTime() : 0;
    return {
      host: r.label ?? (r.key ? r.key.slice(0, 14) : 'unknown'),
      gamesDone: Number(r.done),
      gamesPerHour: Number(r.last_hour),
      sharePct: (Number(r.done) / totalDone) * 100,
      lastSeen: r.last_at ? r.last_at.toISOString() : null,
      live: lastAt > 0 && nowMs - lastAt < LIVE_WINDOW_MS,
    };
  });

  // Zone C — integrity.
  const versions = await pool.query<{ v: string | null }>(`SELECT DISTINCT content_version AS v FROM games WHERE campaign_id = $1`, [c.id]);
  const contentVersions = versions.rows.map((r) => r.v).filter((v): v is string => v !== null);
  const leased = await pool.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM sim_jobs WHERE campaign_id = $1 AND status = 'leased'`, [c.id]);
  const retried = await pool.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM sim_jobs WHERE campaign_id = $1 AND attempts > 1`, [c.id]);

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  let gate: GateMath | null = null;
  if (name === 'arm1' && heroStat) {
    const [lo, hi] = heroStat.wilson95;
    const passes = heroStat.games >= 1000 && heroStat.rate >= 0.6 && lo > 0.5;
    gate = {
      needGames: 1000, needRate: 0.6, currentGames: heroStat.games, currentRate: heroStat.rate, lo, hi, passes,
      sentence: `Needs ≥1000 games, ≥60%, Wilson CI excluding 50% — currently ${heroStat.games} games, ${pct(heroStat.rate)} [${pct(lo)}–${pct(hi)}]${passes ? ' — mechanically passing.' : '.'}`,
    };
  }

  return {
    ok: true,
    name,
    found: true,
    status: c.status,
    totalGames: total,
    completedGames: c.completed_games,
    failedGames: c.failed_games,
    leasedJobs: Number(leased.rows[0]!.n),
    retriedJobs: Number(retried.rows[0]!.n),
    ratePerHour,
    etaHours,
    hero: heroStat,
    variants,
    chunkStrip: strip,
    hosts,
    contentVersions,
    mixedContentVersion: contentVersions.length > 1,
    gate,
  };
}
