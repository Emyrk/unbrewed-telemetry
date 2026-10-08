/**
 * Print the sandbox usage aggregate (#84) for a trailing window: rooms opened,
 * games (rooms with >= 2 distinct players), unique and returning players,
 * daily rows, hour-of-week joins, peak connections and top heroes. Read-only;
 * runs the one query in `src/stats/sandbox.ts`.
 *
 *   npm run stats:sandbox            # trailing 7d
 *   npm run stats:sandbox -- 24      # trailing 24h
 *
 * Reads `.env` when present and falls back to the local compose database.
 */
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { SANDBOX_DEFAULT_WINDOW_HOURS } from '../src/stats/sandbox.js';

loadEnvFile();

const argument = process.argv[2];
const windowHours = argument === undefined ? SANDBOX_DEFAULT_WINDOW_HOURS : Number(argument);
if (!Number.isFinite(windowHours) || windowHours <= 0) {
  throw new Error(`Window hours must be a positive number, got: ${argument}`);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL });
try {
  const stats = await new PgTelemetryRepository(pool).sandboxStats({ windowHours });
  console.log(JSON.stringify(stats, null, 2));
} finally {
  await pool.end();
}
