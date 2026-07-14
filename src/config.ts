import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOCAL_COMPOSE_DATABASE_URL = 'postgres://unbrewed:unbrewed@localhost:55432/unbrewed_telemetry';
export const LOCAL_DEV_TELEMETRY_SECRET = 'dev-telemetry-secret-change-me';

export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(match[2] ?? '');
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export interface Config {
  port: number;
  databaseUrl: string;
  telemetrySecret: string;
  allowUnauthenticatedIngest: boolean;
  bodyLimitBytes: number;
  runMigrationsOnStart: boolean;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const telemetrySecret = env.TELEMETRY_SECRET ?? '';
  const allowUnauthenticatedIngest = boolFromEnv(env.ALLOW_UNAUTHENTICATED_INGEST, false);
  if (env.NODE_ENV === 'production' && !telemetrySecret) {
    throw new Error('TELEMETRY_SECRET is required in production');
  }
  if (!telemetrySecret && !allowUnauthenticatedIngest) {
    throw new Error('TELEMETRY_SECRET is required unless ALLOW_UNAUTHENTICATED_INGEST=1');
  }
  return {
    port: intFromEnv(env.PORT, 8788),
    databaseUrl,
    telemetrySecret,
    allowUnauthenticatedIngest,
    bodyLimitBytes: intFromEnv(env.MAX_BODY_BYTES, 1024 * 1024),
    runMigrationsOnStart: boolFromEnv(env.RUN_MIGRATIONS_ON_START, false),
  };
}
