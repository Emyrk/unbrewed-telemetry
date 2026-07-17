import { hostname } from 'node:os';
import { userInfo } from 'node:os';

export const TELEMETRY_SOURCE_ENV = 'TELEMETRY_SOURCE';

function currentUsername(): string {
  try {
    return userInfo().username || 'unknown-user';
  } catch {
    return 'unknown-user';
  }
}

/**
 * Source label for local command-line telemetry producers.
 *
 * TELEMETRY_SOURCE matches the engine-side telemetry producer so simulations
 * and direct DB seed runs can be grouped by a human-readable origin in
 * dashboards and admin tooling.
 */
export function commandLineSourceName(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[TELEMETRY_SOURCE_ENV]?.trim();
  if (configured) return configured;
  return `${hostname()}:${currentUsername()}:lab`;
}
