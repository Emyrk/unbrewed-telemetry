/**
 * Migration 019 (#107) applies on a fresh database and on one already at 013 —
 * DB-gated on TEST_DATABASE_URL. Each case works in its own scratch database
 * created (and dropped) on the same server, so it never touches the shared test
 * database's schema.
 */

import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

describeDb('quickplay migration (019)', () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const created: string[] = [];

  async function scratchPool(): Promise<Pool> {
    const name = `qp_migration_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    return new Pool({ connectionString: withDatabase(databaseUrl!, name) });
  }

  afterAll(async () => {
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  async function quickplayShape(pool: Pool) {
    const columns = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'games' AND column_name IN ('matched_via', 'xp_multiplier')
       ORDER BY column_name`,
    );
    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'games_xp_multiplier_idx'`,
    );
    return { columns: columns.rows, index: index.rows.map((row) => row.indexdef) };
  }

  const expectedShape = {
    columns: [
      { column_name: 'matched_via', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'xp_multiplier', data_type: 'real', is_nullable: 'NO', column_default: '1' },
    ],
    index: [expect.stringContaining('WHERE (xp_multiplier > (1)::double precision)')],
  };

  it('applies on a fresh database', async () => {
    const pool = await scratchPool();
    try {
      const result = await migrate(pool);
      expect(result.applied).toContain('019_quickplay.sql');
      expect(await quickplayShape(pool)).toEqual(expectedShape);
    } finally {
      await pool.end();
    }
  });

  it('applies on a database already at 013', async () => {
    const pool = await scratchPool();
    try {
      await pool.query(`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
      const upTo013 = files.filter((file) => file <= '013_accounts_player_lookup.sql');
      expect(upTo013).toHaveLength(13);
      for (const file of upTo013) {
        await pool.query(await readFile(`${migrationsDir}/${file}`, 'utf8'));
        await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      }
      const result = await migrate(pool);
      expect(result.skipped).toEqual(upTo013);
      expect(result.applied[result.applied.length - 1]).toBe('019_quickplay.sql');
      expect(await quickplayShape(pool)).toEqual(expectedShape);
    } finally {
      await pool.end();
    }
  });
});
