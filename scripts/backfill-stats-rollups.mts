// Backfill for migration 018 (#87): copies `format` and `pilot_bucket` onto
// the game_cards / game_starting_cards rows written before the migration, then
// rebuilds every stats_*_rollup table from the raw tables and marks the
// rollups ready, which switches the dashboard over to reading them.
//
//   npm run stats:backfill-rollups -- --dry-run          # read-only report
//   npm run stats:backfill-rollups                       # do it
//   npm run stats:backfill-rollups -- --batch-size=1000  # games per batch (default 500)
//
// Safe to re-run: the card copy only touches rows still missing a value, and
// the rebuild replaces the rollups wholesale. Ingest and dashboard reads keep
// running throughout: each card batch is its own short transaction, ingest
// never touches the rollup tables (it queues), and the rebuild only pauses the
// fold of that queue — readers see the previous rollups until it commits.
//
// Reads DATABASE_URL (or .env), defaulting to the local compose database like
// `npm run db:migrate`.
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { rebuildRollups } from '../src/db/rollups.js';

loadEnvFile();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchArg = args.find((arg) => arg.startsWith('--batch-size='));
const batchSize = batchArg ? Number(batchArg.slice('--batch-size='.length)) : 500;
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  console.error(`invalid --batch-size: ${batchArg}`);
  process.exit(1);
}

const CARD_TABLES = ['game_cards', 'game_starting_cards'] as const;

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL });
try {
  const applied = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '018_stats_rollups.sql'`);
  if (applied.rowCount === 0) throw new Error('migration 018_stats_rollups.sql is not applied; run npm run db:migrate first');

  const state = await pool.query<{ ready_at: Date | null }>('SELECT ready_at FROM stats_rollup_state');
  const games = await pool.query<{ games: string; pending_games: string }>(`
    SELECT
      COUNT(*) AS games,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM game_cards c WHERE c.game_id = g.id AND (c.format IS NULL OR c.pilot_bucket IS NULL)
      ) OR EXISTS (
        SELECT 1 FROM game_starting_cards c WHERE c.game_id = g.id AND (c.format IS NULL OR c.pilot_bucket IS NULL)
      )) AS pending_games
    FROM games g
  `);
  const pendingRows: Record<string, number> = {};
  for (const table of CARD_TABLES) {
    const result = await pool.query<{ rows: string }>(
      `SELECT COUNT(*) AS rows FROM ${table} WHERE format IS NULL OR pilot_bucket IS NULL`,
    );
    pendingRows[table] = Number(result.rows[0]!.rows);
  }
  const pendingGames = Number(games.rows[0]!.pending_games);
  console.log(JSON.stringify({
    dryRun,
    readyAt: state.rows[0]?.ready_at?.toISOString() ?? null,
    games: Number(games.rows[0]!.games),
    gamesWithCardRowsToCopy: pendingGames,
    cardRowsToCopy: pendingRows,
    batchSize,
    batches: Math.ceil(pendingGames / batchSize),
  }, null, 2));

  if (dryRun) {
    console.log('dry run: nothing written');
  } else {
    // Walk games in id order; each batch copies its games' card columns in one
    // short transaction, so ingest is never held up for long.
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
    console.log(JSON.stringify({ cardRowsCopied: copied }));

    // A card row the copy missed would be silently left out of the card rollups.
    for (const table of CARD_TABLES) {
      const missing = await pool.query<{ rows: string }>(
        `SELECT COUNT(*) AS rows FROM ${table} WHERE format IS NULL OR pilot_bucket IS NULL`,
      );
      if (Number(missing.rows[0]!.rows) > 0) {
        throw new Error(`${table} still has ${missing.rows[0]!.rows} rows without format/pilot_bucket`);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const started = Date.now();
      const { rows } = await rebuildRollups(client);
      await client.query('UPDATE stats_rollup_state SET ready_at = now()');
      await client.query('COMMIT');
      console.log(JSON.stringify({ rebuiltRollupRows: rows, rebuildMs: Date.now() - started, ready: true }, null, 2));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
