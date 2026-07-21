import { createServer } from 'node:http';
import { Pool } from 'pg';
import { loadConfig, loadEnvFile } from './config.js';
import { migrate } from './db/migrate.js';
import { PgTelemetryRepository } from './db/repository.js';
import { ControlPlaneRepository } from './db/control-plane-repository.js';
import { createApp } from './http/app.js';

loadEnvFile();
const config = loadConfig(process.env);
const pool = new Pool({ connectionString: config.databaseUrl });

if (config.runMigrationsOnStart) {
  const result = await migrate(pool);
  if (result.applied.length > 0) {
    console.log(`[telemetry] applied migrations: ${result.applied.join(', ')}`);
  }
}

const repo = new PgTelemetryRepository(pool);
const cpRepo = new ControlPlaneRepository(pool);
const server = createServer(createApp({
  repo,
  cpRepo,
  config: {
    telemetrySecret: config.telemetrySecret,
    allowUnauthenticatedIngest: config.allowUnauthenticatedIngest,
    bodyLimitBytes: config.bodyLimitBytes,
    now: () => new Date(),
    discordClientId: config.discordClientId,
    discordClientSecret: config.discordClientSecret,
    discordRedirectUri: config.discordRedirectUri,
    adminDiscordIds: config.adminDiscordIds,
    secureCookies: config.secureCookies,
  },
}));

server.listen(config.port, () => {
  console.log(`[telemetry] listening on :${config.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[telemetry] ${signal} received, shutting down`);
  server.close((error) => {
    if (error) console.error('[telemetry] server close error', error);
  });
  await pool.end();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
