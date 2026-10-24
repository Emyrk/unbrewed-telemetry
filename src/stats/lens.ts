/**
 * The dashboard lens (#97): one set of query parameters that every panel of
 * the redesigned dashboard obeys (design board D). `parseLens` validates the
 * URL once; `lensGamesCte` turns a lens plus a time window into the one base
 * `lens_games` CTE every panel groups over.
 *
 *   scope=human|all            live games only (LIVE_SOURCES); human (default): with a human seat
 *   range=24h|7d|30d           trailing window ending now (default 7d), or
 *   from=YYYY-MM-DD&to=…       a UTC day range, both days inclusive
 *   deck, vs                   deck_id; with deck, vs means on the opposing team
 *   bot                        bot_id (the pilot label after `bot:`)
 *   ver                        <bot_id>:<bot_version>
 *   map, format, player        exact map, format id, human seat's player_id
 *
 * Other parameters (the client's `tab`, `focus`) are ignored. A blank value is
 * the same as an absent one. An invalid value is a 400 naming the key.
 */

export type LensScope = 'human' | 'all';
export type LensRange = '24h' | '7d' | '30d';

export interface Lens {
  scope: LensScope;
  /** Null when the window is a `from`/`to` day range. */
  range: LensRange | null;
  /** Inclusive UTC days, set together and only when `range` is null. */
  from: string | null;
  to: string | null;
  deck: string | null;
  vs: string | null;
  bot: string | null;
  /** `ver` split at its first colon. */
  ver: { botId: string; botVersion: string } | null;
  map: string | null;
  format: string | null;
  player: string | null;
}

export type LensParseResult =
  | { ok: true; lens: Lens }
  | { ok: false; key: string; message: string };

export interface LensWindow {
  from: Date;
  to: Date;
}

const LENS_KEYS = ['scope', 'range', 'from', 'to', 'deck', 'vs', 'bot', 'ver', 'map', 'format', 'player'] as const;
const RANGE_MS: Record<LensRange, number> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};
const DAY_MS = 86_400_000;
/** Longest `from`/`to` span, in days. */
export const LENS_MAX_DAYS = 366;
const MAX_VALUE_LENGTH = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function parseLens(params: URLSearchParams): LensParseResult {
  const values: Partial<Record<(typeof LENS_KEYS)[number], string>> = {};
  for (const key of LENS_KEYS) {
    const all = params.getAll(key);
    if (all.length > 1) return { ok: false, key, message: `${key} may be given at most once` };
    const value = all[0]?.trim();
    if (!value) continue;
    if (value.length > MAX_VALUE_LENGTH) return { ok: false, key, message: `${key} is longer than ${MAX_VALUE_LENGTH} characters` };
    if (CONTROL_CHARS.test(value)) return { ok: false, key, message: `${key} contains a control character` };
    values[key] = value;
  }

  const scope = values.scope ?? 'human';
  if (scope !== 'human' && scope !== 'all') return { ok: false, key: 'scope', message: 'scope must be human or all' };

  let range: LensRange | null = null;
  let from: string | null = null;
  let to: string | null = null;
  if (values.from !== undefined || values.to !== undefined) {
    if (values.range !== undefined) return { ok: false, key: 'range', message: 'range cannot be combined with from/to' };
    if (values.from === undefined) return { ok: false, key: 'from', message: 'from is required with to' };
    if (values.to === undefined) return { ok: false, key: 'to', message: 'to is required with from' };
    const fromMs = parseDay(values.from);
    if (fromMs === null) return { ok: false, key: 'from', message: 'from must be a date as YYYY-MM-DD' };
    const toMs = parseDay(values.to);
    if (toMs === null) return { ok: false, key: 'to', message: 'to must be a date as YYYY-MM-DD' };
    if (toMs < fromMs) return { ok: false, key: 'to', message: 'to must not be before from' };
    if ((toMs - fromMs) / DAY_MS + 1 > LENS_MAX_DAYS) {
      return { ok: false, key: 'to', message: `from/to may span at most ${LENS_MAX_DAYS} days` };
    }
    from = values.from;
    to = values.to;
  } else {
    const raw = values.range ?? '7d';
    if (!(raw in RANGE_MS)) return { ok: false, key: 'range', message: 'range must be 24h, 7d or 30d' };
    range = raw as LensRange;
  }

  let ver: Lens['ver'] = null;
  if (values.ver !== undefined) {
    const colon = values.ver.indexOf(':');
    if (colon <= 0 || colon === values.ver.length - 1) {
      return { ok: false, key: 'ver', message: 'ver must be <bot_id>:<bot_version>' };
    }
    ver = { botId: values.ver.slice(0, colon), botVersion: values.ver.slice(colon + 1) };
  }

  return {
    ok: true,
    lens: {
      scope,
      range,
      from,
      to,
      deck: values.deck ?? null,
      vs: values.vs ?? null,
      bot: values.bot ?? null,
      ver,
      map: values.map ?? null,
      format: values.format ?? null,
      player: values.player ?? null,
    },
  };
}

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

/** The lens's time window: a trailing range ending at `now`, or whole UTC days. */
export function lensWindow(lens: Lens, now: Date): LensWindow {
  if (lens.range === null) {
    return { from: new Date(parseDay(lens.from!)!), to: new Date(parseDay(lens.to!)! + DAY_MS) };
  }
  return { from: new Date(now.getTime() - RANGE_MS[lens.range]), to: now };
}

/** The same window shifted back once by its own length. */
export function previousWindow(window: LensWindow): LensWindow {
  const length = window.to.getTime() - window.from.getTime();
  return { from: new Date(window.from.getTime() - length), to: window.from };
}

/** Positional parameters for a generated statement. */
export class SqlParams {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * When a game happened: `ended_at`, or `received_at` for producers that did
 * not report an end. `windowSql` spells the range test out so each branch can
 * use its own index.
 */
export const GAME_AT_SQL = 'COALESCE(g.ended_at, g.received_at)';

function windowSql(window: LensWindow, params: SqlParams): string {
  const from = params.add(window.from);
  const to = params.add(window.to);
  return `((g.ended_at >= ${from} AND g.ended_at < ${to})
          OR (g.ended_at IS NULL AND g.received_at >= ${from} AND g.received_at < ${to}))`;
}

/**
 * "Human game" = any seat with `pilot_kind = 'human'`, decided once per pilot
 * bucket (#87) rather than per game, like `pilotFilterSql`. Games ingested by
 * a pre-018 container have no bucket yet and are checked seat by seat; that
 * set comes from the (normally empty) `games_unbucketed_idx`. The COALESCE
 * keeps the expression two-valued so `NOT` selects bot-only games.
 */
export const HUMAN_GAME_SQL = `(COALESCE(g.pilot_bucket IN (
            SELECT b.id FROM pilot_buckets b
            WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(b.seats) e WHERE e->>1 = 'human')
          ), false)
          OR g.id IN (
            SELECT u.id FROM games u
            WHERE u.pilot_bucket IS NULL
              AND EXISTS (SELECT 1 FROM game_seats h WHERE h.game_id = u.id AND h.pilot_kind = 'human')
          ))`;

/**
 * Live play: games from the live server's sources. `campaign_id IS NULL` is
 * not enough: the #95 audit found 29,449 non-campaign, bot-only lab sims
 * (sources `ai-lab`, `steven`, `<host>:<user>:lab`, July 2026) that would
 * otherwise swamp the ~2k live games. Campaign sims come from worker sources,
 * so this excludes them too. Every scope applies it.
 */
export const LIVE_SOURCES = ['engine', 'live-server'] as const;
export const LIVE_GAME_SQL = `g.source IN (${LIVE_SOURCES.map((source) => `'${source}'`).join(', ')})`;

/**
 * Which live games the scope admits. `human`: at least one human seat.
 * `all`: every live game. `hidden-bots` is what `human` leaves out of a
 * window: live bot-only games, counted on the side.
 */
export type ScopeFilter = LensScope | 'hidden-bots';

export function scopeSql(scope: ScopeFilter): string {
  if (scope === 'all') return LIVE_GAME_SQL;
  if (scope === 'human') return `${LIVE_GAME_SQL} AND ${HUMAN_GAME_SQL}`;
  return `${LIVE_GAME_SQL} AND NOT ${HUMAN_GAME_SQL}`;
}

/** The lens's pins as predicates over game `g`; only pinned keys add a clause. */
function pinSql(lens: Lens, params: SqlParams): string[] {
  const clauses: string[] = [];
  const seatExists = (condition: string) =>
    `EXISTS (SELECT 1 FROM game_seats s WHERE s.game_id = g.id AND ${condition})`;
  if (lens.deck !== null) {
    const deck = params.add(lens.deck);
    if (lens.vs !== null) {
      const vs = params.add(lens.vs);
      clauses.push(`EXISTS (
            SELECT 1 FROM game_seats a JOIN game_seats b ON b.game_id = a.game_id AND b.team_index <> a.team_index
            WHERE a.game_id = g.id AND a.deck_id = ${deck} AND b.deck_id = ${vs})`);
    } else {
      clauses.push(seatExists(`s.deck_id = ${deck}`));
    }
  } else if (lens.vs !== null) {
    clauses.push(seatExists(`s.deck_id = ${params.add(lens.vs)}`));
  }
  if (lens.bot !== null) clauses.push(seatExists(`s.bot_id = ${params.add(lens.bot)}`));
  if (lens.ver !== null) {
    clauses.push(seatExists(`s.bot_id = ${params.add(lens.ver.botId)} AND s.bot_version = ${params.add(lens.ver.botVersion)}`));
  }
  if (lens.map !== null) clauses.push(`g.map = ${params.add(lens.map)}`);
  if (lens.format !== null) clauses.push(`g.format = ${params.add(lens.format)}`);
  if (lens.player !== null) clauses.push(seatExists(`s.player_id = ${params.add(lens.player)} AND s.pilot_kind = 'human'`));
  return clauses;
}

/** WHERE clause over `games g` for a lens, window and scope. */
export function lensWhereSql(lens: Lens, window: LensWindow, scope: ScopeFilter, params: SqlParams): string {
  return [windowSql(window, params), scopeSql(scope), ...pinSql(lens, params)].join('\n          AND ');
}

/**
 * The base CTE: one row per game in the lens. Panels join it to `game_seats`
 * and group. `name` lets one statement hold the current and previous windows.
 */
export function lensGamesCte(lens: Lens, window: LensWindow, params: SqlParams, name = 'lens_games'): string {
  return `${name} AS MATERIALIZED (
        SELECT g.id, g.format, g.map, g.winner_team, g.draw, g.first_player_team,
               g.turns, g.duration_seconds, g.end_condition
        FROM games g
        WHERE ${lensWhereSql(lens, window, lens.scope, params)}
      )`;
}

/**
 * Whether a seat counts toward per-seat rates. With a player pinned only that
 * player's seats do (their win rate per deck); otherwise every seat.
 */
export function lensSeatSql(lens: Lens, params: SqlParams, seat = 's'): string {
  if (lens.player === null) return 'true';
  return `(${seat}.player_id = ${params.add(lens.player)} AND ${seat}.pilot_kind = 'human')`;
}
