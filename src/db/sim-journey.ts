/**
 * "Road to Expert+" journey aggregation (#248 follow-up, #32 live visibility).
 * A public, read-only, NO-AUTH view of the ISMCTS measurement mission's
 * campaign ladder.
 *
 * Reads EXPERIMENT DATA ONLY — `sim_campaigns` / `sim_jobs` and campaign-scoped
 * rows of `games`/`game_seats` (filtered by `campaign_id`), plus worker-session
 * liveness (`sim_worker_sessions` joined to credential labels). It never returns
 * a production (non-campaign) game, and only aggregates (win rates, counts,
 * bucketed cumulative series, checkpoint depth percentiles, liveness) — no
 * per-player rows, no job ids, no credential key ids — so it is safe to expose
 * without auth, matching the existing public `/v1/stats/*` reads.
 *
 * The mission is a set of campaigns identified by name (`grid`, `arm1`, …). The
 * caller passes the ordered names; each resolves to its most recent campaign.
 */

import type { Pool } from 'pg';
import { wilson } from '../stats/wilson.js';

/** Below this many hero games a step's win rate is "warming up", not a verdict. */
export const JOURNEY_MIN_VERDICT_GAMES = 50;

/** Cap on cumulative-series points returned per step (bucketed server-side). */
export const JOURNEY_SERIES_MAX_POINTS = 60;

/** Worker sessions with a heartbeat inside this window count as live. */
const WORKER_LIVE_WINDOW_MS = 15 * 60 * 1000;

export interface JourneyPilotStat {
  pilot: string;
  games: number;
  wins: number;
  rate: number;
  wilson95: [number, number];
}

/** One deck pairing cell of the matchup strip, from the hero pilot's side. */
export interface JourneyMatchup {
  heroDeck: string;
  oppDeck: string;
  games: number;
  wins: number;
  rate: number;
  wilson95: [number, number];
}

/** One bucketed point of the cumulative win-rate series (gate chart). */
export interface JourneyGatePoint {
  n: number;
  wins: number;
  rate: number;
  wilson95: [number, number];
}

/** Live checkpoint depth across a step's unexpired leased jobs (the pulse). */
export interface JourneyInFlight {
  jobs: number;
  /** Jobs whose checkpoint carries a readable journal (decisions so far). */
  reporting: number;
  medianDecisions: number | null;
  maxDecisions: number | null;
}

/** One live worker session, publicly identified by its credential LABEL only. */
export interface JourneyWorker {
  label: string;
  jobs: number;
  heartbeatAgeSeconds: number;
  /** True when this session runs the newest build among live sessions. */
  latestBuild: boolean;
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
  /** False until the hero has JOURNEY_MIN_VERDICT_GAMES games ("warming up"). */
  verdictReady: boolean;
  matchups: JourneyMatchup[];
  gateSeries: JourneyGatePoint[];
  inFlight: JourneyInFlight | null;
}

export interface Journey {
  ok: true;
  generatedAt: string;
  minVerdictGames: number;
  steps: JourneyStep[];
  workers: JourneyWorker[];
}

const HERO_HINT = /ismcts|expert/i;

export async function simJourney(pool: Pool, names: string[], nowMs: number): Promise<Journey> {
  const now = new Date(nowMs);
  const steps: JourneyStep[] = [];
  for (const name of names) {
    steps.push(await stepFor(pool, name, now));
  }
  const workers = await liveWorkers(pool, now);
  return {
    ok: true,
    generatedAt: now.toISOString(),
    minVerdictGames: JOURNEY_MIN_VERDICT_GAMES,
    steps,
    workers,
  };
}

async function stepFor(pool: Pool, name: string, now: Date): Promise<JourneyStep> {
  const camp = await pool.query<{
    id: string; status: string; total_games: number; completed_games: number; failed_games: number;
  }>(
    `SELECT id, status, total_games, completed_games, failed_games
     FROM sim_campaigns WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
    [name],
  );
  if (camp.rowCount === 0) {
    return {
      name, found: false, status: 'pending', totalGames: 0, completedGames: 0, failedGames: 0,
      leasedJobs: 0, mixedContentVersion: false, pilots: [], hero: null, verdictReady: false,
      matchups: [], gateSeries: [], inFlight: null,
    };
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

  const matchups = hero ? await matchupStrip(pool, c.id, hero.pilot) : [];
  const gateSeries = hero ? await cumulativeSeries(pool, c.id, hero.pilot) : [];
  const inFlight = await inFlightPulse(pool, c.id, now);

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
    verdictReady: (hero?.games ?? 0) >= JOURNEY_MIN_VERDICT_GAMES,
    matchups,
    gateSeries,
    inFlight,
  };
}

/**
 * Matchup strip: hero-side win rate per deck pairing (hero deck vs opposing
 * deck). One aggregate row per pairing cell — never per-game rows. In a true
 * pilot mirror (both seats share the hero pilot name) each game contributes
 * both perspectives, which correctly centres the pairing on 50%.
 */
async function matchupStrip(pool: Pool, campaignId: string, heroPilot: string): Promise<JourneyMatchup[]> {
  const rows = await pool.query<{ hero_deck: string; opp_deck: string; games: string; wins: string }>(
    `SELECT hs.deck_id AS hero_deck, os.deck_id AS opp_deck,
            count(*)::bigint AS games, count(*) FILTER (WHERE hs.won)::bigint AS wins
     FROM games g
     JOIN game_seats hs ON hs.game_id = g.id AND hs.pilot = $2
     JOIN game_seats os ON os.game_id = g.id
       AND (os.team_index <> hs.team_index OR os.seat_index <> hs.seat_index)
     WHERE g.campaign_id = $1
     GROUP BY hs.deck_id, os.deck_id
     ORDER BY hs.deck_id, os.deck_id`,
    [campaignId, heroPilot],
  );
  return rows.rows.map((r) => {
    const games = Number(r.games);
    const wins = Number(r.wins);
    const w = wilson(wins, games);
    return { heroDeck: r.hero_deck, oppDeck: r.opp_deck, games, wins, rate: games > 0 ? wins / games : 0, wilson95: [w.lo, w.hi] };
  });
}

/**
 * Cumulative hero win rate over games in completion order, bucketed down to at
 * most JOURNEY_SERIES_MAX_POINTS points server-side so the payload stays a
 * small aggregate regardless of campaign size.
 */
async function cumulativeSeries(pool: Pool, campaignId: string, heroPilot: string): Promise<JourneyGatePoint[]> {
  const rows = await pool.query<{ n: string; wins: string }>(
    `WITH hero AS (
       SELECT hs.won,
              row_number() OVER (ORDER BY g.received_at, g.id, hs.team_index, hs.seat_index) AS rn
       FROM games g
       JOIN game_seats hs ON hs.game_id = g.id AND hs.pilot = $2
       WHERE g.campaign_id = $1
     ), cum AS (
       SELECT rn,
              sum(won::int) OVER (ORDER BY rn) AS wins,
              count(*) OVER () AS total
       FROM hero
     )
     SELECT rn::bigint AS n, wins::bigint AS wins
     FROM cum
     WHERE rn = total OR rn % GREATEST(1, CEIL(total / $3::float8)::bigint) = 0
     ORDER BY rn`,
    [campaignId, heroPilot, JOURNEY_SERIES_MAX_POINTS],
  );
  return rows.rows.map((r) => {
    const n = Number(r.n);
    const wins = Number(r.wins);
    const w = wilson(wins, n);
    return { n, wins, rate: n > 0 ? wins / n : 0, wilson95: [w.lo, w.hi] };
  });
}

/**
 * In-flight pulse: how deep the currently leased games are, read from the
 * crash-resume checkpoints (engine #255/#256). Jobs without a readable journal
 * (just claimed, or a pre-checkpoint worker) still count as in flight — they
 * simply do not contribute a depth.
 */
async function inFlightPulse(pool: Pool, campaignId: string, now: Date): Promise<JourneyInFlight> {
  const rows = await pool.query<{
    jobs: number; reporting: number; median_d: number | null; max_d: number | null;
  }>(
    `SELECT count(*)::int AS jobs,
            count(d)::int AS reporting,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY d)::float8 AS median_d,
            max(d)::int AS max_d
     FROM (
       SELECT CASE WHEN jsonb_typeof(j.checkpoint->'journal'->'entries') = 'array'
                   THEN jsonb_array_length(j.checkpoint->'journal'->'entries') END AS d
       FROM sim_jobs j
       WHERE j.campaign_id = $1 AND j.status = 'leased' AND j.lease_expires_at > $2
     ) depths`,
    [campaignId, now],
  );
  const r = rows.rows[0]!;
  return {
    jobs: r.jobs,
    reporting: r.reporting,
    medianDecisions: r.median_d === null ? null : Math.round(r.median_d),
    maxDecisions: r.max_d === null ? null : r.max_d,
  };
}

/**
 * Live worker sessions (heartbeat within the last 15 minutes), latest session
 * per credential, surfaced by their admin-given LABEL — never the ubk_ key id.
 * `latestBuild` compares each session's worker_version to the newest build
 * among live sessions (the version reported by the most recently started
 * versioned session), doubling as a stale-build early warning.
 */
async function liveWorkers(pool: Pool, now: Date): Promise<JourneyWorker[]> {
  const liveSince = new Date(now.getTime() - WORKER_LIVE_WINDOW_MS);
  const rows = await pool.query<{
    label: string; last_heartbeat_at: Date; started_at: Date; worker_version: string | null; jobs: number;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (s.credential_id)
              s.credential_id, s.last_heartbeat_at, s.started_at, s.worker_version
       FROM sim_worker_sessions s
       WHERE s.last_heartbeat_at >= $1
       ORDER BY s.credential_id, s.started_at DESC
     )
     SELECT c.label, l.last_heartbeat_at, l.started_at, l.worker_version,
            COALESCE(held.n, 0)::int AS jobs
     FROM latest l
     JOIN source_credentials c ON c.id = l.credential_id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS n
       FROM sim_jobs j
       WHERE j.leased_by = l.credential_id AND j.status = 'leased' AND j.lease_expires_at > $2
     ) held ON true
     ORDER BY l.last_heartbeat_at DESC, c.label`,
    [liveSince, now],
  );

  let newestVersion: string | null = null;
  let newestStartedAt = -Infinity;
  for (const r of rows.rows) {
    if (r.worker_version !== null && r.started_at.getTime() > newestStartedAt) {
      newestStartedAt = r.started_at.getTime();
      newestVersion = r.worker_version;
    }
  }

  return rows.rows.map((r) => ({
    label: r.label,
    jobs: r.jobs,
    heartbeatAgeSeconds: Math.max(0, Math.round((now.getTime() - r.last_heartbeat_at.getTime()) / 1000)),
    latestBuild: newestVersion === null ? true : r.worker_version === newestVersion,
  }));
}
