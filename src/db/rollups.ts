import type { Pool, PoolClient } from 'pg';

/**
 * Dashboard rollups (#87). Each rollup is one GROUP BY over the raw tables.
 * Ingest only queues the new game id (stats_rollup_pending, in the ingest
 * transaction); foldPendingRollups() runs the GROUP BYs over a batch of queued
 * games and adds the result, and the backfill script runs them over every game
 * to rebuild from scratch. One definition serves both, so the incremental and
 * rebuilt tables cannot drift. Folding in batches keeps ingest off the hot
 * rollup rows: with per-game upserts every concurrent ingest serialized on
 * them. Schema and rationale: migrations/018_stats_rollups.sql.
 *
 * Every writer of rollup rows — fold, rebuild, admin delete — holds the
 * ROLLUP_LOCK advisory lock, so they never interleave.
 */

/** One distinct seat shape in a game: its pilot, pilot kind, and the pilots it faced. */
export type PilotBucketSeat = [pilot: string, pilotKind: string, opponents: string[]];

interface Rollup {
  table: string;
  constraint: string;
  keys: string[];
  /** Summed on conflict. The first one is the row's count; a row whose count reaches 0 is deleted. */
  sums: string[];
  /** Kept as the larger value on conflict. */
  maxes?: string[];
  /**
   * SELECT producing `keys, sums, maxes` in order, for the games matched by
   * `filter(<game id column>)`, each measure wrapped in signed().
   */
  select(filter: (gameIdColumn: string) => string): string;
  /** Rows the rebuild adds that no game carries (invalid submissions). */
  rebuildSelect?: string;
}

// Contributions are multiplied by the sign; withSign() binds it to a parameter
// for a fold or delete, or to a literal for the rebuild.
const SIGN = '{{sign}}';
const signed = (expr: string) => `${SIGN} * ${expr}`;
const withSign = (sql: string, sign: string) => sql.replaceAll(SIGN, sign);

/**
 * Card rollups read the card rows' own copies of format and pilot bucket
 * instead of joining games. Ingest always writes them; rows from before
 * migration 018 get them from the backfill script, which fills every row
 * before it rebuilds the rollups. Until then a rollup is scratch the rebuild
 * replaces, and the guard keeps an admin delete of an old game from failing
 * on the NOT NULL rollup keys.
 */
const CARD_DENORMALIZED = 'c.format IS NOT NULL AND c.pilot_bucket IS NOT NULL';

const TWO_V_TWO_FORMATS = `('team-2v2', '2v2')`;
const DUEL_FORMATS = `('duel', '1v1')`;

/** Transaction-scoped advisory lock held by every rollup writer. */
const ROLLUP_LOCK = 87_0018;

const ROLLUPS: Rollup[] = [
  {
    table: 'stats_submission_rollup',
    constraint: 'stats_submission_rollup_pkey',
    keys: ['validation_status'],
    sums: ['submissions'],
    select: (filter) => `
      SELECT sub.validation_status, ${signed('COUNT(*)')}
      FROM games g
      JOIN game_submissions sub ON sub.id = g.submission_id
      WHERE ${filter('g.id')}
      GROUP BY sub.validation_status`,
    rebuildSelect: `
      SELECT validation_status, ${signed('COUNT(*)')}
      FROM game_submissions
      WHERE validation_status = 'invalid'
      GROUP BY validation_status`,
  },
  {
    table: 'stats_game_rollup',
    constraint: 'stats_game_rollup_key',
    keys: ['format', 'format_label', 'pilot_bucket', 'map', 'map_version', 'boss', 'source', 'auth_key_id'],
    sums: ['games', 'turns_sum', 'turns_n', 'first_player_games', 'first_player_wins', 'team0_wins'],
    maxes: ['last_received_at'],
    select: (filter) => `
      SELECT
        g.format, g.format_label, g.pilot_bucket, g.map, g.map_version, g.boss, g.source, sub.auth_key_id,
        ${signed('COUNT(*)')},
        ${signed('COALESCE(SUM(g.turns), 0)')},
        ${signed('COUNT(g.turns)')},
        ${signed('COUNT(*) FILTER (WHERE g.first_player_team IS NOT NULL AND g.winner_team IS NOT NULL)')},
        ${signed('COUNT(*) FILTER (WHERE g.first_player_team IS NOT NULL AND g.winner_team IS NOT NULL AND g.first_player_team = g.winner_team)')},
        ${signed('COUNT(*) FILTER (WHERE g.winner_team = 0)')},
        MAX(g.received_at)
      FROM games g
      JOIN game_submissions sub ON sub.id = g.submission_id
      WHERE ${filter('g.id')}
      GROUP BY g.format, g.format_label, g.pilot_bucket, g.map, g.map_version, g.boss, g.source, sub.auth_key_id`,
  },
  {
    table: 'stats_deck_rollup',
    constraint: 'stats_deck_rollup_key',
    keys: [
      'format', 'format_label', 'pilot_bucket', 'deck', 'deck_id', 'deck_version', 'hero_id', 'hero_name',
      'pilot', 'pilot_kind', 'opp_pilots',
    ],
    sums: [
      'games', 'wins',
      'final_health_sum', 'final_health_n', 'win_final_health_sum', 'win_final_health_n',
      'deck_count_sum', 'deck_count_n', 'win_deck_count_sum', 'win_deck_count_n', 'loss_deck_count_sum', 'loss_deck_count_n',
      'win_turns_sum', 'win_turns_n', 'loss_turns_sum', 'loss_turns_n',
      'first_games', 'first_wins', 'second_games', 'second_wins',
    ],
    select: (filter) => `
      SELECT
        g.format, g.format_label, g.pilot_bucket, s.deck, s.deck_id, s.deck_version, s.hero_id, s.hero_name,
        s.pilot, s.pilot_kind, opp.pilots,
        ${signed('COUNT(*)')},
        ${signed('COUNT(*) FILTER (WHERE s.won)')},
        ${signed('COALESCE(SUM(s.final_health), 0)')},
        ${signed('COUNT(s.final_health)')},
        ${signed('COALESCE(SUM(s.final_health) FILTER (WHERE s.won), 0)')},
        ${signed('COUNT(s.final_health) FILTER (WHERE s.won)')},
        ${signed('COALESCE(SUM(s.final_deck_count), 0)')},
        ${signed('COUNT(s.final_deck_count)')},
        ${signed('COALESCE(SUM(s.final_deck_count) FILTER (WHERE s.won), 0)')},
        ${signed('COUNT(s.final_deck_count) FILTER (WHERE s.won)')},
        ${signed('COALESCE(SUM(s.final_deck_count) FILTER (WHERE NOT s.won), 0)')},
        ${signed('COUNT(s.final_deck_count) FILTER (WHERE NOT s.won)')},
        ${signed('COALESCE(SUM(g.turns) FILTER (WHERE s.won), 0)')},
        ${signed('COUNT(g.turns) FILTER (WHERE s.won)')},
        ${signed('COALESCE(SUM(g.turns) FILTER (WHERE NOT s.won), 0)')},
        ${signed('COUNT(g.turns) FILTER (WHERE NOT s.won)')},
        ${signed('COUNT(*) FILTER (WHERE g.first_player_team = s.team_index)')},
        ${signed('COUNT(*) FILTER (WHERE g.first_player_team = s.team_index AND s.won)')},
        ${signed('COUNT(*) FILTER (WHERE g.first_player_team IS NOT NULL AND g.first_player_team <> s.team_index)')},
        ${signed('COUNT(*) FILTER (WHERE g.first_player_team IS NOT NULL AND g.first_player_team <> s.team_index AND s.won)')}
      FROM game_seats s
      JOIN games g ON g.id = s.game_id
      CROSS JOIN LATERAL (
        SELECT ARRAY(
          SELECT DISTINCT o.pilot
          FROM game_seats o
          WHERE o.game_id = s.game_id AND o.team_index <> s.team_index
          ORDER BY 1
        ) AS pilots
      ) opp
      WHERE ${filter('s.game_id')}
      GROUP BY g.format, g.format_label, g.pilot_bucket, s.deck, s.deck_id, s.deck_version, s.hero_id, s.hero_name,
               s.pilot, s.pilot_kind, opp.pilots`,
  },
  {
    table: 'stats_deck_map_rollup',
    constraint: 'stats_deck_map_rollup_key',
    keys: ['format', 'pilot_bucket', 'deck', 'map', 'map_version'],
    sums: ['games', 'wins'],
    select: (filter) => `
      SELECT g.format, g.pilot_bucket, s.deck, g.map, g.map_version,
             ${signed('COUNT(*)')}, ${signed('COUNT(*) FILTER (WHERE s.won)')}
      FROM game_seats s
      JOIN games g ON g.id = s.game_id
      WHERE ${filter('s.game_id')}
      GROUP BY g.format, g.pilot_bucket, s.deck, g.map, g.map_version`,
  },
  {
    table: 'stats_matchup_rollup',
    constraint: 'stats_matchup_rollup_key',
    keys: ['format', 'pilot_bucket', 'row_deck', 'row_deck_id', 'row_pilot', 'col_deck', 'col_deck_id', 'col_pilot', 'col_hero_id', 'col_hero_name'],
    sums: [
      'games', 'wins', 'turns_sum', 'turns_n', 'win_turns_sum', 'win_turns_n', 'loss_turns_sum', 'loss_turns_n',
      'final_health_sum', 'final_health_n', 'deck_count_sum', 'deck_count_n',
    ],
    select: (filter) => `
      SELECT
        g.format, g.pilot_bucket, r.deck, r.deck_id, r.pilot, c.deck, c.deck_id, c.pilot, c.hero_id, c.hero_name,
        ${signed('COUNT(*)')},
        ${signed('COUNT(*) FILTER (WHERE r.won)')},
        ${signed('COALESCE(SUM(g.turns), 0)')},
        ${signed('COUNT(g.turns)')},
        ${signed('COALESCE(SUM(g.turns) FILTER (WHERE r.won), 0)')},
        ${signed('COUNT(g.turns) FILTER (WHERE r.won)')},
        ${signed('COALESCE(SUM(g.turns) FILTER (WHERE NOT r.won), 0)')},
        ${signed('COUNT(g.turns) FILTER (WHERE NOT r.won)')},
        ${signed('COALESCE(SUM(r.final_health), 0)')},
        ${signed('COUNT(r.final_health)')},
        ${signed('COALESCE(SUM(r.final_deck_count), 0)')},
        ${signed('COUNT(r.final_deck_count)')}
      FROM games g
      JOIN game_seats r ON r.game_id = g.id
      JOIN game_seats c ON c.game_id = g.id AND c.team_index <> r.team_index
      WHERE g.format IN ${DUEL_FORMATS}
        AND r.seat_index = 0 AND c.seat_index = 0
        AND ${filter('g.id')}
      GROUP BY g.format, g.pilot_bucket, r.deck, r.deck_id, r.pilot, c.deck, c.deck_id, c.pilot, c.hero_id, c.hero_name`,
  },
  {
    table: 'stats_pair_rollup',
    constraint: 'stats_pair_rollup_key',
    keys: ['format', 'pilot_bucket', 'deck_a', 'deck_a_id', 'deck_b', 'deck_b_id'],
    sums: ['games', 'wins'],
    select: (filter) => `
      SELECT
        g.format, g.pilot_bucket,
        CASE WHEN a.deck_id <= b.deck_id THEN a.deck ELSE b.deck END,
        CASE WHEN a.deck_id <= b.deck_id THEN a.deck_id ELSE b.deck_id END,
        CASE WHEN a.deck_id <= b.deck_id THEN b.deck ELSE a.deck END,
        CASE WHEN a.deck_id <= b.deck_id THEN b.deck_id ELSE a.deck_id END,
        ${signed('COUNT(*)')},
        ${signed('COUNT(*) FILTER (WHERE a.won)')}
      FROM games g
      JOIN game_seats a ON a.game_id = g.id
      JOIN game_seats b ON b.game_id = g.id AND b.team_index = a.team_index AND b.seat_index > a.seat_index
      WHERE g.format IN ${TWO_V_TWO_FORMATS} AND ${filter('g.id')}
      GROUP BY 1, 2, 3, 4, 5, 6`,
  },
  {
    table: 'stats_partner_rollup',
    constraint: 'stats_partner_rollup_key',
    keys: [
      'format', 'pilot_bucket', 'deck', 'partner_deck', 'partner_deck_id', 'partner_hero_id', 'partner_hero_name',
      'opp_deck_a_id', 'opp_deck_b_id',
    ],
    sums: ['games', 'wins'],
    select: (filter) => `
      SELECT
        g.format, g.pilot_bucket, me.deck, partner.deck, partner.deck_id, partner.hero_id, partner.hero_name,
        opp.deck_a_id, opp.deck_b_id,
        ${signed('COUNT(*)')},
        ${signed('COUNT(*) FILTER (WHERE me.won)')}
      FROM games g
      JOIN game_seats me ON me.game_id = g.id
      JOIN game_seats partner ON partner.game_id = me.game_id
        AND partner.team_index = me.team_index
        AND partner.seat_index <> me.seat_index
      JOIN (
        SELECT
          a.game_id,
          a.team_index,
          CASE WHEN a.deck_id <= b.deck_id THEN a.deck_id ELSE b.deck_id END AS deck_a_id,
          CASE WHEN a.deck_id <= b.deck_id THEN b.deck_id ELSE a.deck_id END AS deck_b_id
        FROM game_seats a
        JOIN game_seats b ON b.game_id = a.game_id AND b.team_index = a.team_index AND b.seat_index > a.seat_index
      ) opp ON opp.game_id = me.game_id AND opp.team_index <> me.team_index
      WHERE g.format IN ${TWO_V_TWO_FORMATS} AND ${filter('g.id')}
      GROUP BY g.format, g.pilot_bucket, me.deck, partner.deck, partner.deck_id, partner.hero_id, partner.hero_name,
               opp.deck_a_id, opp.deck_b_id`,
  },
  {
    table: 'stats_card_rollup',
    constraint: 'stats_card_rollup_key',
    keys: ['format', 'pilot_bucket', 'deck', 'card'],
    sums: ['games_with', 'wins_with'],
    select: (filter) => `
      SELECT c.format, c.pilot_bucket, c.deck, c.card,
             ${signed('COUNT(DISTINCT (c.game_id, c.team_index, c.seat_index))')},
             ${signed('COUNT(DISTINCT (c.game_id, c.team_index, c.seat_index)) FILTER (WHERE c.seat_won)')}
      FROM game_cards c
      WHERE ${filter('c.game_id')} AND ${CARD_DENORMALIZED}
      GROUP BY c.format, c.pilot_bucket, c.deck, c.card`,
  },
  {
    table: 'stats_card_context_rollup',
    constraint: 'stats_card_context_rollup_key',
    keys: ['format', 'pilot_bucket', 'deck', 'card', 'context_bucket'],
    sums: ['plays'],
    select: (filter) => `
      SELECT c.format, c.pilot_bucket, c.deck, c.card, c.context_bucket, ${signed('COUNT(*)')}
      FROM game_cards c
      WHERE ${filter('c.game_id')} AND ${CARD_DENORMALIZED}
      GROUP BY c.format, c.pilot_bucket, c.deck, c.card, c.context_bucket`,
  },
  {
    table: 'stats_starting_card_rollup',
    constraint: 'stats_starting_card_rollup_key',
    keys: ['format', 'pilot_bucket', 'deck', 'card'],
    sums: ['starts', 'games_with', 'wins_with'],
    select: (filter) => `
      SELECT c.format, c.pilot_bucket, c.deck, c.card,
             ${signed('COUNT(*)')},
             ${signed('COUNT(DISTINCT (c.game_id, c.team_index, c.seat_index))')},
             ${signed('COUNT(DISTINCT (c.game_id, c.team_index, c.seat_index)) FILTER (WHERE c.seat_won)')}
      FROM game_starting_cards c
      WHERE ${filter('c.game_id')} AND ${CARD_DENORMALIZED}
      GROUP BY c.format, c.pilot_bucket, c.deck, c.card`,
  },
];

export const ROLLUP_TABLES: readonly string[] = ROLLUPS.map((rollup) => rollup.table);

function columnsOf(rollup: Rollup): string[] {
  return [...rollup.keys, ...rollup.sums, ...(rollup.maxes ?? [])];
}

function upsertSql(rollup: Rollup, select: string): string {
  const maxes = rollup.maxes ?? [];
  const columns = columnsOf(rollup);
  const updates = [
    ...rollup.sums.map((col) => `${col} = ${rollup.table}.${col} + EXCLUDED.${col}`),
    ...maxes.map((col) => `${col} = GREATEST(${rollup.table}.${col}, EXCLUDED.${col})`),
  ];
  // ORDER BY the key so concurrent ingests lock rollup rows in the same order.
  return `
    INSERT INTO ${rollup.table} (${columns.join(', ')})
    SELECT * FROM (${select}) contribution
    ORDER BY ${rollup.keys.map((_, i) => i + 1).join(', ')}
    ON CONFLICT ON CONSTRAINT ${rollup.constraint} DO UPDATE SET ${updates.join(', ')}
  `;
}

/** Queue a just-ingested game for the next fold, in the ingest transaction. */
export async function queueRollups(client: PoolClient, gameId: string): Promise<void> {
  await client.query('INSERT INTO stats_rollup_pending (game_id) VALUES ($1)', [gameId]);
}

/**
 * Fold queued games into the rollups, `batchSize` at a time, until the queue
 * is empty or `maxBatches` ran. Returns false without waiting when another
 * writer holds the rollup lock: a reader then serves slightly older rollups
 * rather than queueing behind it. A queued game was committed together with
 * its raw rows, so every claimed id has all of them.
 */
export async function foldPendingRollups(
  pool: Pool,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<boolean> {
  const batchSize = options.batchSize ?? 500;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [ROLLUP_LOCK]);
      if (!locked.rows[0]!.locked) {
        await client.query('ROLLBACK');
        return false;
      }
      const claimed = await client.query<{ game_id: string }>(
        `
          DELETE FROM stats_rollup_pending
          WHERE game_id IN (SELECT game_id FROM stats_rollup_pending ORDER BY queued_at LIMIT $1)
          RETURNING game_id
        `,
        [batchSize],
      );
      await applyContributions(client, ROLLUPS, claimed.rows.map((row) => row.game_id), 1);
      await client.query('COMMIT');
      if (claimed.rows.length < batchSize) return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return true;
}

/**
 * Take the given games out of the rollups before they are deleted, in the
 * deleting transaction. Games still queued were never folded: they only leave
 * the queue.
 */
export async function subtractRollups(client: PoolClient, gameIds: readonly string[]): Promise<void> {
  if (gameIds.length === 0) return;
  await client.query('SELECT pg_advisory_xact_lock($1)', [ROLLUP_LOCK]);
  const unfolded = await client.query<{ game_id: string }>(
    'DELETE FROM stats_rollup_pending WHERE game_id = ANY($1::text[]) RETURNING game_id',
    [gameIds],
  );
  const queued = new Set(unfolded.rows.map((row) => row.game_id));
  const folded = gameIds.filter((id) => !queued.has(id));
  await applyContributions(client, ROLLUPS, folded, -1);
  for (const rollup of ROLLUPS) {
    await client.query(`DELETE FROM ${rollup.table} WHERE ${rollup.sums[0]} = 0`);
  }
  // MAX cannot be subtracted: recompute it for the rows that remain.
  await client.query(`
    UPDATE stats_game_rollup r
    SET last_received_at = latest.received_at
    FROM (
      SELECT g.format, g.format_label, g.pilot_bucket, g.map, g.map_version, g.boss, g.source, sub.auth_key_id,
             MAX(g.received_at) AS received_at
      FROM games g
      JOIN game_submissions sub ON sub.id = g.submission_id
      WHERE NOT (g.id = ANY($1::text[]))
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    ) latest
    WHERE (r.format, r.pilot_bucket, r.map, r.source) = (latest.format, latest.pilot_bucket, latest.map, latest.source)
      AND r.format_label IS NOT DISTINCT FROM latest.format_label
      AND r.map_version IS NOT DISTINCT FROM latest.map_version
      AND r.boss IS NOT DISTINCT FROM latest.boss
      AND r.auth_key_id IS NOT DISTINCT FROM latest.auth_key_id
      AND r.last_received_at IS DISTINCT FROM latest.received_at
  `, [gameIds]);
}

async function applyContributions(
  client: PoolClient,
  rollups: readonly Rollup[],
  gameIds: readonly string[],
  sign: 1 | -1,
): Promise<void> {
  if (gameIds.length === 0) return;
  const filter = (column: string) => `${column} = ANY($2::text[])`;
  for (const rollup of rollups) {
    await client.query(upsertSql(rollup, withSign(rollup.select(filter), '$1::bigint')), [sign, gameIds]);
  }
}

/**
 * Record an invalid submission, which has no game to roll up. Rare enough to
 * write directly; the rebuild's EXCLUSIVE lock on this one table orders it.
 */
export async function countInvalidSubmission(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO stats_submission_rollup (validation_status, submissions)
    VALUES ('invalid', 1)
    ON CONFLICT (validation_status) DO UPDATE SET submissions = stats_submission_rollup.submissions + 1
  `);
}

/**
 * Recompute every rollup from the raw tables, in the caller's transaction.
 * Holding the rollup lock stops folds, so the rebuild owns the tables; reads
 * keep serving the old rows until it commits. It aggregates the games that
 * exist when it starts (snapshotted into a temp table — game rows are
 * insert-only, so the id set pins down every row they contribute), then drops
 * those games from the queue. Games committed after the snapshot stay queued
 * and are folded afterwards.
 */
export async function rebuildRollups(client: PoolClient): Promise<{ rows: Record<string, number> }> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [ROLLUP_LOCK]);
  await client.query('CREATE TEMP TABLE rollup_rebuild_games (id text PRIMARY KEY) ON COMMIT DROP');
  await client.query('INSERT INTO rollup_rebuild_games SELECT id FROM games');
  await client.query('ANALYZE rollup_rebuild_games');
  const [submissions, ...gameRollups] = ROLLUPS;
  const inSnapshot = (column: string) => `${column} IN (SELECT id FROM rollup_rebuild_games)`;
  const rows: Record<string, number> = {};
  for (const rollup of gameRollups) {
    await client.query(`DELETE FROM ${rollup.table}`);
    const inserted = await client.query(upsertSql(rollup, withSign(rollup.select(inSnapshot), '1')));
    rows[rollup.table] = inserted.rowCount ?? 0;
  }
  await client.query('DELETE FROM stats_rollup_pending WHERE game_id IN (SELECT id FROM rollup_rebuild_games)');

  // Valid submissions follow the game snapshot; invalid ones are counted
  // directly at ingest, so recount them under a lock that orders the two.
  await client.query(`LOCK TABLE ${submissions!.table} IN EXCLUSIVE MODE`);
  await client.query(`DELETE FROM ${submissions!.table}`);
  await client.query(upsertSql(submissions!, withSign(submissions!.select(inSnapshot), '1')));
  const invalid = await client.query(upsertSql(submissions!, withSign(submissions!.rebuildSelect!, '1')));
  const valid = await client.query(`SELECT 1 FROM ${submissions!.table} WHERE validation_status <> 'invalid'`);
  rows[submissions!.table] = (valid.rowCount ?? 0) + (invalid.rowCount ?? 0);
  return { rows };
}

/** True once the backfill script has rebuilt the rollups and filled the card columns. */
export async function rollupsReady(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ ready: boolean }>(
    'SELECT ready_at IS NOT NULL AS ready FROM stats_rollup_state',
  );
  return result.rows[0]?.ready === true;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical pilot-bucket shape for a game's seats, matching the backfill
 * in migrations/018_stats_rollups.sql: distinct seat descriptors sorted by
 * (pilot, pilot kind, opposing pilots joined by U+001F) in byte order.
 */
export function pilotBucketSeats(
  seats: readonly { teamIndex: number; pilot: string; pilotKind: string }[],
): PilotBucketSeat[] {
  const byKey = new Map<string, PilotBucketSeat>();
  for (const seat of seats) {
    const opponents = [...new Set(seats.filter((other) => other.teamIndex !== seat.teamIndex).map((other) => other.pilot))]
      .sort(compareText);
    const key = [seat.pilot, seat.pilotKind, opponents.join('\u001f')].join('\u0000');
    byKey.set(key, [seat.pilot, seat.pilotKind, opponents]);
  }
  return [...byKey.values()].sort((a, b) =>
    compareText(a[0], b[0]) || compareText(a[1], b[1]) || compareText(a[2].join('\u001f'), b[2].join('\u001f')));
}

/** Find or create the pilot bucket for a game's seats. */
export async function resolvePilotBucket(
  client: PoolClient,
  seats: readonly { teamIndex: number; pilot: string; pilotKind: string }[],
): Promise<number> {
  const shape = JSON.stringify(pilotBucketSeats(seats));
  const existing = await client.query<{ id: number }>('SELECT id FROM pilot_buckets WHERE seats = $1::jsonb', [shape]);
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await client.query<{ id: number }>(
    'INSERT INTO pilot_buckets (seats) VALUES ($1::jsonb) ON CONFLICT (seats) DO NOTHING RETURNING id',
    [shape],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  // A concurrent ingest created it and has since committed.
  const raced = await client.query<{ id: number }>('SELECT id FROM pilot_buckets WHERE seats = $1::jsonb', [shape]);
  return raced.rows[0]!.id;
}
