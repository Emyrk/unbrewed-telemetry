// Equivalence between the raw-table and rollup-table stats reads (#87), shared
// by `npm run stats:check-rollups` (against a restored snapshot) and
// test/stats-rollups.test.ts (against a synthetic fixture).
import type { Pool } from 'pg';
import { PgTelemetryRepository, pilotFilterSql, type DeckStatsFilters } from '../../src/db/repository.js';

export interface Mismatch {
  call: string;
  path: string;
  raw: unknown;
  rollup: unknown;
}

/** Averages are sums divided once on the rollup side and per row on the raw side. */
const RELATIVE_TOLERANCE = 1e-9;

function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
}

export function diff(raw: unknown, rollup: unknown, path = '$', out: Omit<Mismatch, 'call'>[] = []): Omit<Mismatch, 'call'>[] {
  if (typeof raw === 'number' && typeof rollup === 'number') {
    if (!sameNumber(raw, rollup)) out.push({ path, raw, rollup });
  } else if (Array.isArray(raw) && Array.isArray(rollup)) {
    if (raw.length !== rollup.length) out.push({ path: `${path}.length`, raw: raw.length, rollup: rollup.length });
    for (let i = 0; i < Math.min(raw.length, rollup.length); i += 1) diff(raw[i], rollup[i], `${path}[${i}]`, out);
  } else if (raw && rollup && typeof raw === 'object' && typeof rollup === 'object') {
    const keys = new Set([...Object.keys(raw), ...Object.keys(rollup)]);
    for (const key of keys) {
      diff((raw as Record<string, unknown>)[key], (rollup as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
  } else if (raw !== rollup) {
    out.push({ path, raw, rollup });
  }
  return out;
}

/**
 * The pilot allowlist exactly as `pilotFilterSql` evaluated it per game before
 * #87, against game_seats. Kept here as the reference the bucket predicate is
 * checked against.
 */
export const LEGACY_PILOT_FILTER_SQL = `($1::text[] IS NULL OR (
  (
    NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS allowed(pilot) WHERE allowed.pilot NOT LIKE 'must:%')
    OR NOT EXISTS (
      SELECT 1 FROM game_seats s2
      WHERE s2.game_id = g.id
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS allowed(pilot)
          WHERE allowed.pilot NOT LIKE 'must:%'
            AND (s2.pilot LIKE allowed.pilot || '%' OR s2.pilot_kind = allowed.pilot)
        )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM unnest($1::text[]) AS required(pilot)
    WHERE required.pilot LIKE 'must:%'
      AND NOT EXISTS (
        SELECT 1 FROM game_seats s3
        WHERE s3.game_id = g.id
          AND (s3.pilot LIKE substring(required.pilot from 6) || '%' OR s3.pilot_kind = substring(required.pilot from 6))
      )
  )
))`;

/** The 2v2/1v1 deck strings and pilots worth probing, read from the data. */
export async function probeValues(pool: Pool): Promise<{ pilots: string[]; decks: string[] }> {
  const pilots = await pool.query<{ pilot: string }>(
    'SELECT pilot FROM game_seats GROUP BY pilot ORDER BY COUNT(*) DESC, pilot LIMIT 6',
  );
  const decks = await pool.query<{ deck: string }>(`
    (SELECT deck FROM game_seats GROUP BY deck ORDER BY COUNT(*) DESC, deck LIMIT 4)
    UNION
    (SELECT s.deck FROM game_seats s JOIN games g ON g.id = s.game_id
     WHERE g.format IN ('team-2v2', '2v2') GROUP BY s.deck ORDER BY COUNT(*) DESC, s.deck LIMIT 2)
  `);
  return { pilots: pilots.rows.map((row) => row.pilot), decks: decks.rows.map((row) => row.deck).sort() };
}

/** Pilot allowlists covering exact, prefix, kind, multi-entry and must: forms. */
export function pilotFilters(pilots: string[]): string[][] {
  const [top, second, third] = pilots;
  const filters: string[][] = [[], ['human'], ['bot'], ['bot:'], ['nobody']];
  if (top) filters.push([top], [`must:${top}`]);
  if (top && second) filters.push([top, second], ['human', second], [top, `must:${second}`]);
  if (third) filters.push([third.slice(0, Math.max(5, third.length - 3))]);
  return filters;
}

export function statsFilterCombos(formats: (string | null)[], pilots: string[]): DeckStatsFilters[] {
  const combos: DeckStatsFilters[] = [];
  for (const format of formats) {
    for (const allowed of pilotFilters(pilots)) combos.push({ format, pilots: allowed });
  }
  const [top, second] = pilots;
  if (top) {
    // Heroes tab (hero pilot vs allowed opponents) and matchups tab (pilot pairing).
    combos.push({ format: 'duel', pilots: [], heroPilot: top, opponentPilots: [top, ...(second ? [second] : [])] });
    combos.push({ format: null, pilots: [top], heroPilot: top, opponentPilots: ['human'] });
    combos.push({ format: 'duel', pilots: [], heroPilot: top, opponentPilot: second ?? top });
    combos.push({ format: 'duel', pilots: [], opponentPilot: top });
  }
  return combos;
}

export interface EquivalenceReport {
  calls: number;
  mismatches: Mismatch[];
  pilotFilterMismatches: { pilots: string[]; legacyOnly: number; bucketOnly: number }[];
}

/** Compare every rollup-backed read against the raw read for each filter combination. */
export async function checkEquivalence(
  pool: Pool,
  options: { formats?: (string | null)[]; generatedAt?: Date } = {},
): Promise<EquivalenceReport> {
  const raw = new PgTelemetryRepository(pool, { statsSource: 'raw' });
  const rollup = new PgTelemetryRepository(pool, { statsSource: 'rollup' });
  const generatedAt = options.generatedAt ?? new Date('2026-01-01T00:00:00.000Z');
  const formats = options.formats ?? [null, 'duel', 'team-2v2', 'ffa-3', 'two-v-one-boss'];
  const { pilots, decks } = await probeValues(pool);
  const mismatches: Mismatch[] = [];
  let calls = 0;

  const compare = async <T,>(call: string, read: (repo: PgTelemetryRepository) => Promise<T>) => {
    calls += 1;
    const [rawResult, rollupResult] = await Promise.all([read(raw), read(rollup)]);
    for (const mismatch of diff(rawResult, rollupResult)) mismatches.push({ call, ...mismatch });
  };

  for (const filters of statsFilterCombos(formats, pilots)) {
    const label = JSON.stringify(filters);
    await compare(`dashboard ${label}`, (repo) => repo.dashboardStats(filters, generatedAt));
    await compare(`decks ${label}`, (repo) => repo.deckStats(filters));
    await compare(`sources ${label}`, (repo) => repo.sourceStats(filters));
  }
  for (const format of [null, 'duel', 'team-2v2']) {
    for (const allowed of pilotFilters(pilots).slice(0, 7)) {
      for (const deck of decks) {
        const filters = { format, pilots: allowed };
        await compare(`deck ${deck} ${JSON.stringify(filters)}`, (repo) => repo.deckDetail(deck, filters));
      }
    }
  }

  // The bucket predicate must select exactly the games the per-game LIKE did.
  const pilotFilterMismatches: EquivalenceReport['pilotFilterMismatches'] = [];
  for (const allowed of pilotFilters(pilots)) {
    const result = await pool.query<{ legacy_only: string; bucket_only: string }>(
      `
        WITH legacy AS (SELECT g.id FROM games g WHERE ${LEGACY_PILOT_FILTER_SQL}),
        bucketed AS (SELECT g.id FROM games g WHERE ${pilotFilterSql(1)})
        SELECT
          (SELECT COUNT(*) FROM legacy l WHERE NOT EXISTS (SELECT 1 FROM bucketed b WHERE b.id = l.id)) AS legacy_only,
          (SELECT COUNT(*) FROM bucketed b WHERE NOT EXISTS (SELECT 1 FROM legacy l WHERE l.id = b.id)) AS bucket_only
      `,
      [allowed.length > 0 ? allowed : null],
    );
    const legacyOnly = Number(result.rows[0]!.legacy_only);
    const bucketOnly = Number(result.rows[0]!.bucket_only);
    if (legacyOnly > 0 || bucketOnly > 0) pilotFilterMismatches.push({ pilots: allowed, legacyOnly, bucketOnly });
  }

  return { calls, mismatches, pilotFilterMismatches };
}
