// Backfill for migration 018 (#87), in order: gives every game still missing
// a pilot bucket one (games the pre-018 container wrote during the rolling
// deploy), copies `format` and `pilot_bucket` onto game_cards /
// game_starting_cards rows that lack them, then rebuilds every stats_*_rollup
// table from the raw tables and marks the rollups ready, which switches the
// dashboard over to reading them. Logic: scripts/lib/rollup-backfill.mts.
//
//   npm run stats:backfill-rollups -- --dry-run          # read-only report
//   npm run stats:backfill-rollups                       # do it
//   npm run stats:backfill-rollups -- --batch-size=1000  # games per batch (default 500)
//
// Run it once the old container is gone: a game it writes after the rebuild
// would never be counted. One it writes during the run makes the run stop
// before marking anything ready; just run it again.
//
// Safe to re-run and to resume: every step only touches rows still missing a
// value, the rebuild replaces the rollups wholesale, and ready_at is set only
// at the very end. Ingest and dashboard reads keep running throughout: each
// batch is its own short transaction, ingest never touches the rollup tables
// (it queues), and the rebuild only pauses the fold of that queue — readers
// see the previous rollups until it commits.
//
// Reads DATABASE_URL (or .env), defaulting to the local compose database like
// `npm run db:migrate`.
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { backfillPlan, backfillRollups } from './lib/rollup-backfill.mjs';

loadEnvFile();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchArg = args.find((arg) => arg.startsWith('--batch-size='));
const batchSize = batchArg ? Number(batchArg.slice('--batch-size='.length)) : 500;
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  console.error(`invalid --batch-size: ${batchArg}`);
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL });
try {
  const plan = await backfillPlan(pool);
  console.log(JSON.stringify({ dryRun, batchSize, ...plan }, null, 2));
  if (dryRun) {
    console.log('dry run: nothing written');
  } else {
    const result = await backfillRollups(pool, { batchSize, log: (message) => console.log(message) });
    console.log(JSON.stringify({ ...result, ready: true }, null, 2));
  }
} finally {
  await pool.end();
}
