/**
 * Provision per-host sim-fleet bearer credentials WITHOUT the Discord admin UI
 * or Railway env access (#248, Dean's direction).
 *
 * Emyrk's control plane stores each credential as a scrypt hash + salt
 * (`source_credentials`); the plaintext `ubk_<keyId>.<secret>` is shown exactly
 * once, at creation. This script creates a telemetry source and one credential
 * per host directly against the database, and writes the plaintext keys to a
 * GITIGNORED file for Dean to distribute out-of-band. **No secret ever touches
 * the repo, a PR, or an issue** — only the scrypt hashes live in Postgres, and
 * the plaintext lives only in the local, ignored file.
 *
 *   npm run sim:seed-credentials -- sim-box emyrk
 *   # → source "sim-fleet", credentials for hosts sim-box + emyrk,
 *   #   plaintext written to sim-credentials.local.json (gitignored)
 *
 * Idempotent-ish: reuses an existing source of the same name; each run mints
 * FRESH credentials for the named hosts (old ones can be revoked in /admin).
 * DATABASE_URL selects the target; defaults to the local compose database.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import type { Scope } from '../src/http/bearer-auth.js';

loadEnvFile();

const SOURCE_NAME = process.env.SIM_SOURCE_NAME ?? 'sim-fleet';
const OUT_FILE = resolve(process.cwd(), process.env.SIM_CREDENTIALS_OUT ?? 'sim-credentials.local.json');
// A runner needs to claim jobs, submit games, and complete them.
const RUNNER_SCOPES: Scope[] = ['sim:claim', 'sim:complete', 'games:submit'];

const hosts = process.argv.slice(2).map((h) => h.trim()).filter(Boolean);
if (hosts.length === 0) {
  console.error('usage: npm run sim:seed-credentials -- <host> [<host> ...]');
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL;
const pool = new Pool({ connectionString: databaseUrl });
const repo = new ControlPlaneRepository(pool);

try {
  // Reuse an existing source of this name, else create it.
  const sources = await repo.listSources();
  let source = sources.find((s) => s.name === SOURCE_NAME);
  if (!source) {
    source = await repo.createSource(SOURCE_NAME, 'Sim measurement fleet (#248)', 'seed-sim-credentials');
    console.log(`created telemetry source "${SOURCE_NAME}" (${source.id})`);
  } else {
    console.log(`reusing telemetry source "${SOURCE_NAME}" (${source.id})`);
  }

  const out: Record<string, { keyId: string; apiKey: string; scopes: Scope[] }> = {};
  for (const host of hosts) {
    const cred = await repo.createCredential(source.id, `sim-fleet:${host}`, RUNNER_SCOPES, 'seed-sim-credentials');
    out[host] = { keyId: cred.id, apiKey: cred.fullKey, scopes: RUNNER_SCOPES };
    console.log(`  minted credential ${cred.id} for host "${host}"`);
  }

  writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  console.log('');
  console.log(`Plaintext API keys written to ${OUT_FILE} (gitignored, mode 600).`);
  console.log('Distribute each host its own key out-of-band, e.g.:');
  console.log('  SIM_HOST_KEY=<apiKey> TELEMETRY_URL=https://<telemetry-host> JOBS=22 bash scripts/sim-join.sh');
  console.log('These secrets are NOT stored anywhere else — only scrypt hashes live in Postgres.');
} finally {
  await pool.end();
}
