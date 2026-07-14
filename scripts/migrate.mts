import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, LOCAL_DEV_TELEMETRY_SECRET, loadConfig, loadEnvFile } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';

loadEnvFile();

const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL,
  TELEMETRY_SECRET: process.env.TELEMETRY_SECRET ?? LOCAL_DEV_TELEMETRY_SECRET,
  ALLOW_UNAUTHENTICATED_INGEST: process.env.ALLOW_UNAUTHENTICATED_INGEST ?? '1',
});
const pool = new Pool({ connectionString: config.databaseUrl });
try {
  const result = await migrate(pool);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} finally {
  await pool.end();
}
