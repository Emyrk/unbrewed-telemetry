import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

export async function migrate(pool: Pool): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file;
    const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (existing.rowCount && existing.rowCount > 0) {
      skipped.push(version);
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      applied.push(version);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
