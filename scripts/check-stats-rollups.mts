// Equivalence + latency check for the dashboard rollups (#87). Read-only.
//
//   npm run stats:check-rollups              # raw vs rollup output, every filter combination
//   npm run stats:check-rollups -- --bench   # also time each endpoint's repository call
//
// Run it against a restored snapshot after `npm run stats:backfill-rollups`.
// Exits non-zero on any mismatch. Reads DATABASE_URL (or .env), defaulting to
// the local compose database like `npm run db:migrate`.
import { Pool } from 'pg';
import { LOCAL_COMPOSE_DATABASE_URL, loadEnvFile } from '../src/config.js';
import { PgTelemetryRepository, type DeckStatsFilters } from '../src/db/repository.js';
import { checkEquivalence, probeValues } from './lib/stats-equivalence.mjs';

loadEnvFile();

const bench = process.argv.includes('--bench');
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_COMPOSE_DATABASE_URL, max: 20 });

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function time(label: string, runs: number, read: () => Promise<unknown>): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await read();
    samples.push(performance.now() - started);
  }
  console.log(`${label.padEnd(64)} first ${samples[0]!.toFixed(0).padStart(6)} ms  p50 ${percentile(samples, 50).toFixed(0).padStart(6)} ms  p95 ${percentile(samples, 95).toFixed(0).padStart(6)} ms`);
}

try {
  const started = Date.now();
  const report = await checkEquivalence(pool);
  console.log(JSON.stringify({
    calls: report.calls,
    mismatches: report.mismatches.length,
    pilotFilterMismatches: report.pilotFilterMismatches,
    ms: Date.now() - started,
  }, null, 2));
  for (const mismatch of report.mismatches.slice(0, 40)) console.log(JSON.stringify(mismatch));

  if (bench) {
    const { pilots, decks } = await probeValues(pool);
    const top = pilots[0]!;
    const deck = decks[0]!;
    const dashboards: [string, DeckStatsFilters][] = [
      ['duel, all pilots', { format: 'duel', pilots: [] }],
      [`duel, pilot=${top}`, { format: 'duel', pilots: [top] }],
      ['team-2v2, two pilots', { format: 'team-2v2', pilots: [top, 'human'] }],
      ['heroes tab, hero pilot vs allowed', { format: 'duel', pilots: [top], heroPilot: top, opponentPilots: [top] }],
    ];
    for (const source of ['raw', 'rollup'] as const) {
      const repo = new PgTelemetryRepository(pool, { statsSource: source });
      const runs = source === 'raw' ? 3 : 20;
      for (const [label, filters] of dashboards) {
        await time(`[${source}] /v1/stats/dashboard ${label}`, runs, () => repo.dashboardStats(filters));
      }
      await time(`[${source}] /v1/stats/sources all`, runs, () => repo.sourceStats({ format: null, pilots: [] }));
      await time(`[${source}] /v1/stats/sources pilot=${top}`, runs, () => repo.sourceStats({ format: null, pilots: [top] }));
      await time(`[${source}] /v1/stats/deck ${deck} duel pilot=${top}`, runs, () => repo.deckDetail(deck, { format: 'duel', pilots: [top] }));
    }
  }
  if (report.mismatches.length > 0 || report.pilotFilterMismatches.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
