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
