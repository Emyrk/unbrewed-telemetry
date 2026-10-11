/**
 * Dashboard rollups (#87): the rollup-backed reads must return exactly what
 * the raw-table reads return, for every filter combination the dashboard
 * sends, after ingest, after an admin delete, and after a full rebuild.
 * `npm run stats:check-rollups` runs the same comparison against a restored
 * production snapshot.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { foldPendingRollups, pilotBucketSeats, rebuildRollups, ROLLUP_TABLES } from '../src/db/rollups.js';
import type { GameSubmission } from '../src/types.js';
import { checkEquivalence } from '../scripts/lib/stats-equivalence.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describe('pilotBucketSeats', () => {
  it('keeps one sorted descriptor per distinct seat shape', () => {
    const seats = [
      { teamIndex: 1, pilot: 'human', pilotKind: 'human' },
      { teamIndex: 0, pilot: 'bot:mc(64, 400ms)', pilotKind: 'bot' },
      { teamIndex: 1, pilot: 'human', pilotKind: 'human' },
      { teamIndex: 0, pilot: 'bot:easy', pilotKind: 'bot' },
    ];
    expect(pilotBucketSeats(seats)).toEqual([
      ['bot:easy', 'bot', ['human']],
      ['bot:mc(64, 400ms)', 'bot', ['human']],
      ['human', 'human', ['bot:easy', 'bot:mc(64, 400ms)']],
    ]);
  });

  it('is independent of seat order', () => {
    const a = { teamIndex: 0, pilot: 'bot:hard', pilotKind: 'bot' };
    const b = { teamIndex: 1, pilot: 'human', pilotKind: 'human' };
    expect(pilotBucketSeats([a, b])).toEqual(pilotBucketSeats([b, a]));
  });
});

/** Small deterministic PRNG so the fixture is the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PILOTS = ['bot:mc(64, 400ms)', 'bot:mc(64, 4000ms)', 'bot:easy', 'human'];
const HEROES = ['king-kong', 'thrall', 'the-mandalorian', 'hollow-oak-spice', 'piper'];
const CARDS = ['strike', 'guard', 'feint', 'scheme-a', 'boost-b'];
const CONTEXTS = ['attack', 'defense', 'scheme', 'boost', 'discard', 'mystery'];

/**
 * Varied games: duel, 2v2, 3-way FFA and boss formats; mixed and mirrored
 * pilots; two deck versions per hero; missing turns and first player; ties in
 * every MODE() the dashboard takes.
 */
function fixtureGames(count: number): GameSubmission[] {
  const rnd = mulberry32(87);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(rnd() * values.length)]!;
  const games: GameSubmission[] = [];
  for (let i = 0; i < count; i += 1) {
    const format = pick(['duel', 'duel', 'duel', 'team-2v2', 'ffa-3', 'two-v-one-boss']);
    const shape = format === 'team-2v2' ? [2, 2] : format === 'ffa-3' ? [1, 1, 1] : format === 'two-v-one-boss' ? [1, 2] : [1, 1];
    const teams = shape.map((size, teamIndex) => ({
      ...(format === 'two-v-one-boss' ? { role: teamIndex === 0 ? 'boss' : 'challengers' } : {}),
      seats: Array.from({ length: size }, (_, seatIndex) => {
        const hero = pick(HEROES);
        return {
          deck: `${hero}@0.${1 + Math.floor(rnd() * 2)}.0`,
          pilot: pick(PILOTS),
          runtimePlayerId: `p${teamIndex}-${seatIndex}`,
          heroId: hero,
          ...(rnd() < 0.8 ? { heroName: hero.toUpperCase() } : {}),
          ...(rnd() < 0.8 ? { finalHealth: Math.floor(rnd() * 12) } : {}),
          ...(rnd() < 0.8 ? { finalDeckCount: Math.floor(rnd() * 20) } : {}),
        };
      }),
    }));
    const seats = teams.flatMap((team, teamIndex) => team.seats.map((_, seatIndex) => [teamIndex, seatIndex] as [number, number]));
    games.push({
      schemaVersion: 1,
      gameId: `rollup-${i}`,
      source: pick(['lab-a', 'lab-b', '']),
      format,
      ...(rnd() < 0.7 ? { formatLabel: format === 'duel' ? '1v1' : format.toUpperCase() } : {}),
      boss: format === 'two-v-one-boss' ? pick(['kong-boss', 'dragon-boss']) : null,
      map: pick(['mended-drum', 'sherwood', 'baskerville']),
      ...(rnd() < 0.7 ? { mapVersion: pick(['1.0.0', '1.1.0']) } : {}),
      teams,
      winner: Math.floor(rnd() * shape.length),
      endCondition: 'hero_defeated',
      ...(rnd() < 0.85 ? { turns: 4 + Math.floor(rnd() * 20) } : {}),
      ...(rnd() < 0.85 ? { firstPlayerTeam: Math.floor(rnd() * shape.length) } : {}),
      stateHash: `rollup-state-${i}`,
      telemetry: {
        startingHands: seats.map((seat) => ({ seat, cards: [pick(CARDS), pick(CARDS), pick(CARDS)] })),
        cardsPlayed: seats.flatMap((seat) => Array.from({ length: Math.floor(rnd() * 6) }, () => ({
          seat,
          card: pick(CARDS),
          turn: 1 + Math.floor(rnd() * 10),
          context: pick(CONTEXTS),
        }))),
      },
    });
  }
  return games;
}

/** Fold until the queue is empty; a fold skips (returns false) while another holds the lock. */
async function foldAll(pool: Pool): Promise<void> {
  for (;;) {
    const done = await foldPendingRollups(pool);
    const pending = await pool.query('SELECT 1 FROM stats_rollup_pending LIMIT 1');
    if (done && pending.rowCount === 0) return;
  }
}

async function rollupSnapshot(pool: Pool): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of ROLLUP_TABLES) {
    const rows = await pool.query(`SELECT * FROM ${table}`);
    snapshot[table] = rows.rows
      .map((row) => JSON.stringify(row, (key, value) => (key === 'last_received_at' ? undefined : value)))
      .sort();
  }
  return snapshot;
}

describeDb('dashboard rollups with postgres', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  const receivedAt = new Date('2026-10-01T12:00:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE game_submissions, deck_definitions CASCADE');
    await pool.query('UPDATE stats_rollup_state SET ready_at = now()');
    const games = fixtureGames(160);
    for (const [index, game] of games.entries()) {
      await repo.ingestValid({
        payload: game,
        idempotencyKey: game.gameId!,
        receivedAt: new Date(receivedAt.getTime() + index * 1000),
        authKeyId: index % 3 === 0 ? null : `key-${index % 2}`,
      });
    }
    await repo.ingestInvalid({
      payload: { nope: true },
      idempotencyKey: 'rollup-invalid',
      receivedAt,
      authKeyId: null,
      errors: ['bad'],
    });
    await foldAll(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('serves the same dashboard, deck, deck detail and source stats as the raw tables', async () => {
    const report = await checkEquivalence(pool, { generatedAt: receivedAt });
    expect(report.calls).toBeGreaterThan(100);
    expect(report.pilotFilterMismatches).toEqual([]);
    expect(report.mismatches).toEqual([]);
  }, 120_000);

  it('stays equal after an admin deck delete takes games out', async () => {
    // Leave one game unfolded so the delete covers both queued and folded games.
    await repo.ingestValid({
      payload: { ...fixtureGames(1)[0]!, gameId: 'rollup-late', stateHash: 'late' },
      idempotencyKey: 'rollup-late',
      receivedAt,
      authKeyId: null,
    });
    const deleted = await repo.adminDeleteDeck('thrall');
    expect(deleted.deletedGames).toBeGreaterThan(0);
    const report = await checkEquivalence(pool, { generatedAt: receivedAt });
    expect(report.mismatches).toEqual([]);
  }, 120_000);

  it('rebuilds to the same rows the incremental folds produced', async () => {
    const incremental = await rollupSnapshot(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await rebuildRollups(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await rollupSnapshot(pool)).toEqual(incremental);
  }, 30_000);

  it('folds games queued since the last fold before a rollup read', async () => {
    const before = await repo.dashboardStats({ format: null, pilots: [] });
    await repo.ingestValid({
      payload: { ...fixtureGames(1)[0]!, gameId: 'rollup-fresh', stateHash: 'fresh' },
      idempotencyKey: 'rollup-fresh',
      receivedAt,
      authKeyId: null,
    });
    const pending = await pool.query('SELECT game_id FROM stats_rollup_pending');
    expect(pending.rows).toEqual([{ game_id: 'rollup-fresh' }]);
    const after = await repo.dashboardStats({ format: null, pilots: [] });
    expect(after.totalGames).toBe(before.totalGames + 1);
    expect(after.totalSubmissions).toBe(before.totalSubmissions + 1);
  }, 30_000);

  it('reads the raw tables until the backfill marks the rollups ready', async () => {
    const expected = await new PgTelemetryRepository(pool, { statsSource: 'raw' }).dashboardStats({ format: null, pilots: [] });
    await pool.query('UPDATE stats_rollup_state SET ready_at = NULL');
    await pool.query('DELETE FROM stats_game_rollup');
    const notReady = new PgTelemetryRepository(pool);
    expect((await notReady.dashboardStats({ format: null, pilots: [] })).totalGames).toBe(expected.totalGames);
    await pool.query('UPDATE stats_rollup_state SET ready_at = now()');
  }, 30_000);
});
