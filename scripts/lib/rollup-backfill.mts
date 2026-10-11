// The migration-018 backfill (#87), shared by `npm run stats:backfill-rollups`
// and test/stats-rollups.test.ts. Three resumable steps, each batch its own
// short transaction, then one rebuild transaction that marks the rollups
// ready — so ready_at stays NULL until everything before it succeeded:
//
// 1. Give every game still missing a pilot bucket one (games written by the
//    pre-018 container during a rolling deploy), resolved from its seats
//    exactly as ingest resolves it, and copy it onto the seats.
// 2. Copy format + pilot_bucket onto game_cards / game_starting_cards rows
//    that lack them.
// 3. Rebuild every rollup from the raw tables and set ready_at.
import type { Pool } from 'pg';
import { rebuildRollups, resolvePilotBucket } from '../../src/db/rollups.js';

const CARD_TABLES = ['game_cards', 'game_starting_cards'] as const;

export interface BackfillPlan {
  readyAt: string | null;
  games: number;
  gamesWithoutBucket: number;
  seatsWithoutBucket: number;
  gamesWithCardRowsToCopy: number;
  cardRowsToCopy: Record<string, number>;
}

/** What a backfill would do. Read-only. */
export async function backfillPlan(pool: Pool): Promise<BackfillPlan> {
  const applied = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '018_stats_rollups.sql'`);
  if (applied.rowCount === 0) throw new Error('migration 018_stats_rollups.sql is not applied; run npm run db:migrate first');

  const state = await pool.query<{ ready_at: Date | null }>('SELECT ready_at FROM stats_rollup_state');
  const games = await pool.query<{ games: string; without_bucket: string; pending_games: string }>(`
    SELECT
      COUNT(*) AS games,
      COUNT(*) FILTER (WHERE g.pilot_bucket IS NULL) AS without_bucket,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM game_cards c WHERE c.game_id = g.id AND (c.format IS NULL OR c.pilot_bucket IS NULL)
      ) OR EXISTS (
        SELECT 1 FROM game_starting_cards c WHERE c.game_id = g.id AND (c.format IS NULL OR c.pilot_bucket IS NULL)
      )) AS pending_games
    FROM games g
  `);
  const seats = await pool.query<{ rows: string }>('SELECT COUNT(*) AS rows FROM game_seats WHERE pilot_bucket IS NULL');
  const cardRowsToCopy: Record<string, number> = {};
  for (const table of CARD_TABLES) {
    const result = await pool.query<{ rows: string }>(
      `SELECT COUNT(*) AS rows FROM ${table} WHERE format IS NULL OR pilot_bucket IS NULL`,
    );
    cardRowsToCopy[table] = Number(result.rows[0]!.rows);
  }
  return {
    readyAt: state.rows[0]?.ready_at?.toISOString() ?? null,
    games: Number(games.rows[0]!.games),
    gamesWithoutBucket: Number(games.rows[0]!.without_bucket),
    seatsWithoutBucket: Number(seats.rows[0]!.rows),
    gamesWithCardRowsToCopy: Number(games.rows[0]!.pending_games),
    cardRowsToCopy,
  };
}

export interface BackfillResult {
  bucketsAssigned: number;
  cardRowsCopied: number;
  rebuiltRollupRows: Record<string, number>;
  rebuildMs: number;
}

export async function backfillRollups(
  pool: Pool,
  options: { batchSize?: number; log?: (message: string) => void } = {},
): Promise<BackfillResult> {
  const batchSize = options.batchSize ?? 500;
  const log = options.log ?? (() => {});

  const bucketsAssigned = await assignMissingBuckets(pool, batchSize);
  log(JSON.stringify({ bucketsAssigned }));
  const cardRowsCopied = await copyCardColumns(pool, batchSize);
  log(JSON.stringify({ cardRowsCopied }));

  // Anything still missing would be silently left out of the rollups.
  const missing = await pool.query<{ source: string; rows: string }>(`
    SELECT 'games' AS source, COUNT(*) AS rows FROM games WHERE pilot_bucket IS NULL
    UNION ALL SELECT 'game_seats', COUNT(*) FROM game_seats WHERE pilot_bucket IS NULL
    UNION ALL SELECT 'game_cards', COUNT(*) FROM game_cards WHERE format IS NULL OR pilot_bucket IS NULL
    UNION ALL SELECT 'game_starting_cards', COUNT(*) FROM game_starting_cards WHERE format IS NULL OR pilot_bucket IS NULL
  `);
  for (const row of missing.rows) {
    if (Number(row.rows) > 0) {
      throw new Error(`${row.source} still has ${row.rows} rows without a pilot bucket/format (pre-018 code still ingesting?); run it again`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const started = Date.now();
    const { rows } = await rebuildRollups(client);
    await client.query('UPDATE stats_rollup_state SET ready_at = now()');
    await client.query('COMMIT');
    return { bucketsAssigned, cardRowsCopied, rebuiltRollupRows: rows, rebuildMs: Date.now() - started };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Step 1: bucket games written without one, `batchSize` games per transaction. */
async function assignMissingBuckets(pool: Pool, batchSize: number): Promise<number> {
  let assigned = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query<{ id: string }>(
        'SELECT id FROM games WHERE pilot_bucket IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
        [batchSize],
      );
      if (batch.rows.length === 0) {
        await client.query('COMMIT');
        break;
      }
      const ids = batch.rows.map((row) => row.id);
      const seats = await client.query<{ game_id: string; team_index: number; pilot: string; pilot_kind: string }>(
        'SELECT game_id, team_index, pilot, pilot_kind FROM game_seats WHERE game_id = ANY($1::text[])',
        [ids],
      );
      const seatsByGame = new Map<string, { teamIndex: number; pilot: string; pilotKind: string }[]>(ids.map((id) => [id, []]));
      for (const seat of seats.rows) {
        seatsByGame.get(seat.game_id)!.push({ teamIndex: seat.team_index, pilot: seat.pilot, pilotKind: seat.pilot_kind });
      }
      for (const [gameId, gameSeats] of seatsByGame) {
        const bucket = await resolvePilotBucket(client, gameSeats);
        await client.query('UPDATE games SET pilot_bucket = $2 WHERE id = $1', [gameId, bucket]);
      }
      await client.query('COMMIT');
      assigned += ids.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  // Seats follow their game; also catches seats of games bucketed by the migration.
  await pool.query(`
    UPDATE game_seats s
    SET pilot_bucket = g.pilot_bucket
    FROM games g
    WHERE g.id = s.game_id AND s.pilot_bucket IS NULL AND g.pilot_bucket IS NOT NULL
  `);
  return assigned;
}

/** Step 2: copy format + pilot_bucket onto card rows, walking games in id order. */
async function copyCardColumns(pool: Pool, batchSize: number): Promise<number> {
  let after = '';
  let copied = 0;
  for (;;) {
    const batch = await pool.query<{ id: string }>(
      'SELECT id FROM games WHERE id > $1 ORDER BY id LIMIT $2',
      [after, batchSize],
    );
    if (batch.rows.length === 0) break;
    const ids = batch.rows.map((row) => row.id);
    after = ids[ids.length - 1]!;
    for (const table of CARD_TABLES) {
      const updated = await pool.query(
        `
          UPDATE ${table} c
          SET format = g.format, pilot_bucket = g.pilot_bucket
          FROM games g
          WHERE g.id = c.game_id
            AND c.game_id = ANY($1::text[])
            AND (c.format IS NULL OR c.pilot_bucket IS NULL)
        `,
        [ids],
      );
      copied += updated.rowCount ?? 0;
    }
  }
  return copied;
}
