import { CONCESSION_END_CONDITIONS } from '../db/accounts.js';
import type {
  BalanceFlag,
  HomeBotRow,
  HomeDeckRow,
  HomeKpis,
  HomeMapRow,
  HomeMatrixCell,
  HomeRate,
  HomeSummaryResponse,
} from '../types.js';
import {
  GAME_AT_SQL,
  SqlParams,
  lensGamesCte,
  lensSeatSql,
  lensWhereSql,
  lensWindow,
  previousWindow,
  scopeSql,
  type Lens,
  type LensWindow,
} from './lens.js';
import { wilson } from './wilson.js';

/**
 * `GET /api/home/summary` (#97): the landing page of the redesigned dashboard
 * (design boards A and D). One statement per window: `lens_games` (and
 * `prev_games`, the same lens shifted back once) are built by `lensGamesCte`,
 * and every panel is a GROUP BY over them joined to `game_seats`.
 *
 * The #87 rollups have no time key, so a windowed lens cannot read them; the
 * window narrows `games` through the `ended_at`/`received_at` indexes, the
 * human scope is decided per pilot bucket (#87), and the response goes through
 * the #86 stats cache.
 *
 * Derived rules, each encoded once here:
 * - Human game: any seat with `pilot_kind = 'human'` (one human vs three bots
 *   counts). The human scope also drops sims; `hiddenBotGames` counts the
 *   non-sim bot-only games it hides.
 * - Current bot version: per `bot_id`, the newest `bot_version` (latest first
 *   game) among versions with a game in the 14 days before now, over games the
 *   scope admits. Every other version seen is retired.
 * - Matchup cell: the row deck's win share over games where row and column
 *   decks sat on opposing teams; cells under 3 games are left out. The
 *   opposing side joins `game_seats` itself, not `lens_seats`: the planner has
 *   no statistics for a CTE, guessed a 20M-row self-join on the 2026-10-11
 *   snapshot, and spent 5 s of a 7 s query in JIT.
 * - First-player edge: games the first player's team won over games on that
 *   map that reported a first player.
 * - Balance flag: OVER/UNDER only when n >= 30 and the 95% Wilson band clears
 *   45–55%.
 * - Auto-widen: an empty 7d window is rerun at 30d; if that has games it is
 *   served with `widened: true`.
 */

export const BOT_CURRENT_DAYS = 14;
export const MATRIX_MIN_GAMES = 3;
export const FLAG_MIN_GAMES = 30;
const FLAG_BAND = { lo: 0.45, hi: 0.55 };

export function balanceFlag(wins: number, n: number): BalanceFlag {
  if (n < FLAG_MIN_GAMES) return null;
  const band = wilson(wins, n);
  if (band.lo > FLAG_BAND.hi) return 'OVER';
  if (band.hi < FLAG_BAND.lo) return 'UNDER';
  return null;
}

function rate(wins: number, n: number): HomeRate {
  if (n <= 0) return { winRate: null, lo: null, hi: null };
  const band = wilson(wins, n);
  return { winRate: band.p, lo: band.lo, hi: band.hi };
}

interface BotCounts {
  bot_id: string;
  bot_version: string | null;
  games: number;
  human_seats: number;
  human_wins: number;
}

interface SummaryRow {
  kpis: Omit<HomeKpis, 'humanWinRateVsBots'> & { newHumans: number };
  previous: Omit<HomeKpis, 'humanWinRateVsBots'>;
  hidden_bot_games: number;
  bots_current: BotCounts[];
  bots_retired: BotCounts[];
  retired_versions: number;
  retired_games: number;
  decks: Array<{ deck: string; games: number; wins: number }>;
  matrix_decks: string[];
  matrix: Array<{ deck: string; vs: string; games: number; wins: number }>;
  maps: Array<{ map: string; games: number; fp_games: number; fp_wins: number }>;
}

export type Query = <R>(text: string, values: unknown[]) => Promise<R[]>;

export function homeSummarySql(lens: Lens, window: LensWindow, now: Date): { text: string; values: unknown[] } {
  const p = new SqlParams();
  const concessions = p.add(CONCESSION_END_CONDITIONS);
  const recentCutoff = p.add(new Date(now.getTime() - BOT_CURRENT_DAYS * 86_400_000));
  const seats = (name: string, games: string) => `${name} AS MATERIALIZED (
        SELECT s.game_id, s.team_index, s.deck_id, s.pilot_kind, s.bot_id, s.bot_version,
               s.player_id, s.won, ${lensSeatSql(lens, p)} AS mine
        FROM ${games} lg JOIN game_seats s ON s.game_id = lg.id
      ),
      ${name}_flags AS (
        SELECT game_id, bool_or(pilot_kind = 'human') AS any_human, bool_or(pilot_kind = 'bot') AS any_bot
        FROM ${name} GROUP BY game_id
      )`;
  const kpis = (games: string, seatsName: string) => `
        'games', (SELECT count(*) FROM ${games}),
        'uniqueHumans', (SELECT count(DISTINCT player_id) FROM ${seatsName}
                         WHERE pilot_kind = 'human' AND player_id IS NOT NULL),
        'humanSeatsVsBots', (SELECT count(*) FROM ${seatsName} s JOIN ${seatsName}_flags f USING (game_id)
                             WHERE s.pilot_kind = 'human' AND s.mine AND f.any_bot),
        'humanWinsVsBots', (SELECT count(*) FROM ${seatsName} s JOIN ${seatsName}_flags f USING (game_id)
                            WHERE s.pilot_kind = 'human' AND s.mine AND f.any_bot AND s.won),
        'medianTurns', (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY turns) FROM ${games}),
        'medianDurationSeconds', (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_seconds) FROM ${games}),
        'endedEarly', (SELECT count(*) FROM ${games} WHERE end_condition = ANY(${concessions}::text[])),
        'botOnlyGames', (SELECT count(*) FROM ${seatsName}_flags WHERE NOT any_human)`;

  const hidden = lens.scope === 'human'
    ? `(SELECT count(*) FROM games g WHERE ${lensWhereSql(lens, window, 'hidden-bots', p)})::int`
    : '0';

  const decks = lens.deck === null
    ? `SELECT deck_id AS deck, count(*) AS games, count(*) FILTER (WHERE won) AS wins
         FROM lens_seats WHERE mine GROUP BY deck_id`
    : (() => {
        const deck = p.add(lens.deck);
        return `SELECT b.deck_id AS deck, count(DISTINCT a.game_id) AS games,
                       count(DISTINCT a.game_id) FILTER (WHERE a.won) AS wins
                FROM lens_seats a
                JOIN game_seats b ON b.game_id = a.game_id AND b.team_index <> a.team_index
                WHERE a.mine AND a.deck_id = ${deck} AND b.deck_id <> ${deck}
                GROUP BY b.deck_id`;
      })();

  const text = `
    WITH
      ${lensGamesCte(lens, window, p)},
      ${lensGamesCte(lens, previousWindow(window), p, 'prev_games')},
      ${seats('lens_seats', 'lens_games')},
      ${seats('prev_seats', 'prev_games')},
      bot_versions AS (
        SELECT s.bot_id, s.bot_version, min(${GAME_AT_SQL}) AS first_seen, max(${GAME_AT_SQL}) AS last_seen
        FROM games g JOIN game_seats s ON s.game_id = g.id
        WHERE ${scopeSql(lens.scope)} AND s.pilot_kind = 'bot' AND s.bot_id IS NOT NULL
        GROUP BY s.bot_id, s.bot_version
      ),
      current_versions AS (
        SELECT DISTINCT ON (bot_id) bot_id, bot_version
        FROM bot_versions
        WHERE last_seen >= ${recentCutoff}
        ORDER BY bot_id, first_seen DESC, bot_version DESC
      ),
      bot_games AS (
        SELECT DISTINCT s.game_id, s.bot_id, s.bot_version,
               EXISTS (SELECT 1 FROM current_versions c
                       WHERE c.bot_id = s.bot_id AND c.bot_version IS NOT DISTINCT FROM s.bot_version) AS current
        FROM lens_seats s WHERE s.pilot_kind = 'bot' AND s.bot_id IS NOT NULL
      ),
      bot_lens AS (
        SELECT bg.bot_id, bg.bot_version, bg.current, count(DISTINCT bg.game_id) AS games,
               count(h.game_id) AS human_seats, count(h.game_id) FILTER (WHERE h.won) AS human_wins
        FROM bot_games bg
        LEFT JOIN lens_seats h ON h.game_id = bg.game_id AND h.pilot_kind = 'human' AND h.mine
        GROUP BY bg.bot_id, bg.bot_version, bg.current
      ),
      deck_rows AS (${decks}),
      matrix_cells AS (
        SELECT a.deck_id AS deck, b.deck_id AS vs, count(DISTINCT a.game_id) AS games,
               count(DISTINCT a.game_id) FILTER (WHERE a.won) AS wins
        FROM lens_seats a
        JOIN game_seats b ON b.game_id = a.game_id AND b.team_index <> a.team_index
        WHERE a.mine AND a.deck_id <> b.deck_id
        GROUP BY a.deck_id, b.deck_id
      ),
      map_rows AS (
        SELECT map, count(*) AS games,
               count(*) FILTER (WHERE first_player_team IS NOT NULL) AS fp_games,
               count(*) FILTER (WHERE first_player_team IS NOT NULL AND NOT draw
                                  AND winner_team = first_player_team) AS fp_wins
        FROM lens_games GROUP BY map
      )
    SELECT
      json_build_object(${kpis('lens_games', 'lens_seats')},
        'newHumans', (SELECT count(DISTINCT s.player_id) FROM lens_seats s
                      WHERE s.pilot_kind = 'human' AND s.player_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM prev_seats q
                                        WHERE q.pilot_kind = 'human' AND q.player_id = s.player_id))
      ) AS kpis,
      json_build_object(${kpis('prev_games', 'prev_seats')}) AS previous,
      ${hidden} AS hidden_bot_games,
      COALESCE((
        SELECT json_agg(json_build_object(
          'bot_id', c.bot_id, 'bot_version', c.bot_version, 'games', COALESCE(l.games, 0),
          'human_seats', COALESCE(l.human_seats, 0), 'human_wins', COALESCE(l.human_wins, 0)
        ) ORDER BY c.bot_id)
        FROM current_versions c
        LEFT JOIN bot_lens l ON l.bot_id = c.bot_id AND l.bot_version IS NOT DISTINCT FROM c.bot_version
      ), '[]'::json) AS bots_current,
      COALESCE((
        SELECT json_agg(json_build_object(
          'bot_id', bot_id, 'bot_version', bot_version, 'games', games,
          'human_seats', human_seats, 'human_wins', human_wins
        ) ORDER BY bot_id, bot_version)
        FROM bot_lens WHERE NOT current
      ), '[]'::json) AS bots_retired,
      (SELECT count(*) FROM bot_versions v
       WHERE NOT EXISTS (SELECT 1 FROM current_versions c
                         WHERE c.bot_id = v.bot_id AND c.bot_version IS NOT DISTINCT FROM v.bot_version))::int
        AS retired_versions,
      (SELECT count(DISTINCT game_id) FROM bot_games WHERE NOT current)::int AS retired_games,
      COALESCE((SELECT json_agg(d) FROM deck_rows d), '[]'::json) AS decks,
      COALESCE((SELECT json_agg(DISTINCT deck_id ORDER BY deck_id) FROM lens_seats), '[]'::json) AS matrix_decks,
      COALESCE((SELECT json_agg(m ORDER BY m.deck, m.vs) FROM matrix_cells m), '[]'::json) AS matrix,
      COALESCE((SELECT json_agg(m ORDER BY m.games DESC, m.map) FROM map_rows m), '[]'::json) AS maps
  `;
  return { text, values: p.values };
}

function kpisFrom(raw: Omit<HomeKpis, 'humanWinRateVsBots'>): HomeKpis {
  return {
    games: raw.games,
    uniqueHumans: raw.uniqueHumans,
    humanSeatsVsBots: raw.humanSeatsVsBots,
    humanWinsVsBots: raw.humanWinsVsBots,
    humanWinRateVsBots: raw.humanSeatsVsBots > 0 ? raw.humanWinsVsBots / raw.humanSeatsVsBots : null,
    medianTurns: raw.medianTurns,
    medianDurationSeconds: raw.medianDurationSeconds,
    endedEarly: raw.endedEarly,
    botOnlyGames: raw.botOnlyGames,
  };
}

function botRow(row: BotCounts): HomeBotRow {
  return {
    botId: row.bot_id,
    botVersion: row.bot_version,
    games: row.games,
    humanSeats: row.human_seats,
    humanWins: row.human_wins,
    ...rate(row.human_wins, row.human_seats),
  };
}

function byRate(a: HomeDeckRow, b: HomeDeckRow): number {
  return (b.winRate ?? -1) - (a.winRate ?? -1) || b.games - a.games || (a.deck < b.deck ? -1 : a.deck > b.deck ? 1 : 0);
}

export async function homeSummary(query: Query, lens: Lens, now: Date): Promise<HomeSummaryResponse> {
  const run = async (window: LensWindow) => {
    const { text, values } = homeSummarySql(lens, window, now);
    return (await query<SummaryRow>(text, values))[0]!;
  };
  let window = lensWindow(lens, now);
  let range = lens.range;
  let row = await run(window);
  let widened = false;
  if (lens.range === '7d' && row.kpis.games === 0) {
    const wide = lensWindow({ ...lens, range: '30d' }, now);
    const wideRow = await run(wide);
    if (wideRow.kpis.games > 0) {
      window = wide;
      range = '30d';
      row = wideRow;
      widened = true;
    }
  }
  const previous = previousWindow(window);

  const cells: HomeMatrixCell[] = row.matrix
    .filter((cell) => cell.games >= MATRIX_MIN_GAMES)
    .map((cell) => ({ ...cell, winRate: cell.wins / cell.games }));

  return {
    generatedAt: now.toISOString(),
    lens: {
      scope: lens.scope,
      range: lens.range,
      from: lens.from,
      to: lens.to,
      deck: lens.deck,
      vs: lens.vs,
      bot: lens.bot,
      ver: lens.ver ? `${lens.ver.botId}:${lens.ver.botVersion}` : null,
      map: lens.map,
      format: lens.format,
      player: lens.player,
    },
    window: {
      range,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      previousFrom: previous.from.toISOString(),
      previousTo: previous.to.toISOString(),
    },
    widened,
    kpis: { ...kpisFrom(row.kpis), newHumans: row.kpis.newHumans },
    previous: kpisFrom(row.previous),
    hiddenBotGames: row.hidden_bot_games,
    bots: {
      current: row.bots_current.map(botRow),
      retired: { versions: row.retired_versions, games: row.retired_games, rows: row.bots_retired.map(botRow) },
    },
    decks: {
      mode: lens.deck === null ? 'decks' : 'vs',
      deck: lens.deck,
      rows: row.decks
        .map((deck) => ({ ...deck, ...rate(deck.wins, deck.games), flag: balanceFlag(deck.wins, deck.games) }))
        .sort(byRate),
    },
    matrix: {
      minGames: MATRIX_MIN_GAMES,
      decks: row.matrix_decks,
      cells,
      hiddenCells: row.matrix.length - cells.length,
    },
    maps: row.maps.map((map): HomeMapRow => ({
      map: map.map,
      games: map.games,
      firstPlayerGames: map.fp_games,
      firstPlayerWins: map.fp_wins,
      firstPlayerEdge: map.fp_games > 0 ? map.fp_wins / map.fp_games : null,
    })),
  };
}
