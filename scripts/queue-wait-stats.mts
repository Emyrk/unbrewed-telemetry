/**
 * Print the matchmaking queue wait aggregate (#68) for a trailing window:
 * median + p75 wait for matched searches and the match rate, split by quick
 * match. Read-only; runs the one query in `src/stats/queue-wait.ts`.
 *
 *   npm run stats:queue-wait            # trailing 24h
 *   npm run stats:queue-wait -- 168     # trailing 7d
 *
 * Reads `.env` when present and falls back to the local compose database.
 */
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { PgTelemetryRepository } from '../src/db/repository.js';

loadEnvFile();

const argument = process.argv[2];
const windowHours = argument === undefined ? 24 : Number(argument);
if (!Number.isFinite(windowHours) || windowHours <= 0) {
  throw new Error(`Window hours must be a positive number, got: ${argument}`);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL });
try {
  const stats = await new PgTelemetryRepository(pool).queueWaitStats({ windowHours });
  console.log(JSON.stringify(stats, null, 2));
} finally {
  await pool.end();
}
