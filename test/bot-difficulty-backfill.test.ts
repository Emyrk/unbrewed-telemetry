/**
 * Migration 014 — the one-time `game_seats.bot_difficulty` backfill (#60).
 *
 * The migration file itself is the artifact under test: it is read off disk and
 * run against seats ingested through the repository, so what is asserted here
 * is exactly the SQL that runs on production.
 *
 * The three things that make this safe to ship are the three things covered:
 * only current-era serving presets are stamped, legacy budget labels are left
 * NULL rather than laundered into a tier they never played at, and the update
 * is confined to `bot_difficulty IS NULL` — so a re-run does nothing and a
 * value the engine starts stamping after unbrewed-engine#366 is never
 * overwritten.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { botTierFromPilot } from '../src/db/bot-tier.js';
import type { GameSubmission } from '../src/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const migrationPath = fileURLToPath(
  new URL('../migrations/014_backfill_bot_difficulty.sql', import.meta.url),
);

/** The mapping the ticket specifies, verbatim. Current-era presets only. */
const CURRENT_ERA: ReadonlyArray<readonly [pilot: string, difficulty: string]> = [
  ['bot:easy', 'easy'],
  ['bot:medium', 'medium'],
  ['bot:mc(16,10000ms)', 'medium'],
  ['bot:mc(64,10000ms)', 'hard'],
  ['bot:ismcts(512,10000ms)', 'expert'],
];

/**
 * Labels that must survive the backfill untouched. The budget variants played
 * under search budgets today's tiers do not describe; the knob-grid labels are
 * sim sweeps, not presets.
 */
const LEFT_NULL = [
  'bot:mc(64, 400ms)',
  'bot:mc(64,400ms)',
  'bot:mc(64, 2000ms)',
  'bot:mc(64, 4000ms)',
  'bot:mc(64, 5000ms)',
  'bot:mc(16, 400ms)',
  'bot:mc(16,2000ms)',
  'bot:ismcts(256,10000ms)',
  'bot:ismcts(512,4000ms)',
  'bot:mc',
  'bot:mc(sims-64/eps-0.15/depth-3)',
  'human',
];

describe('bot difficulty backfill mapping', () => {
  it('agrees with the read-path tier decoding for every stamped label', () => {
    // A stamped value takes precedence over the label in `botTier()`, so the
    // two must not disagree: the backfill is meant to persist what the read
    // path already infers, not to change any player's stats.
    for (const [pilot, difficulty] of CURRENT_ERA) {
      expect(botTierFromPilot(pilot)).toBe(difficulty);
    }
  });
});

describeDb('migration 014 — bot_difficulty backfill', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  let backfillSql: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    backfillSql = await readFile(migrationPath, 'utf8');
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE game_submissions CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  /** One duel per bot label: the bot seat under test against a human seat. */
  async function ingestBotSeat(
    id: string,
    pilot: string,
    botDifficulty?: string,
  ): Promise<void> {
    const submission = {
      schemaVersion: 1,
      gameId: id,
      submittedAt: '2026-08-12T12:00:00.000Z',
      endedAt: '2026-08-12T12:00:00.000Z',
      source: 'test',
      format: 'duel',
      map: 'mended-drum',
      teams: [
        { seats: [{ deck: 'king-kong@1.0.0', pilot: 'human', runtimePlayerId: 'p1', heroId: 'king-kong' }] },
        { seats: [{ deck: 'medusa@1.0.0', pilot, runtimePlayerId: 'p2', heroId: 'medusa', botDifficulty }] },
      ],
      winner: 0,
      draw: false,
      endCondition: 'hero_defeated',
      turns: 10,
      durationSeconds: 600,
      firstPlayerTeam: 0,
      engine: { schemaVersion: 3, dslVersion: '0.18.0', protocolVersion: 12, contentVersion: 'test' },
      stateHash: `state-${id}`,
    } as GameSubmission;
    const result = await repo.ingestValid({
      payload: submission,
      idempotencyKey: id,
      receivedAt: new Date('2026-08-12T12:00:00.000Z'),
      authKeyId: 'test',
      campaignId: null,
      campaignGameIndex: null,
    });
    expect(result.kind).toBe('created');
  }

  /** `bot_difficulty` for the seat carrying `pilot`, across all games. */
  async function stamped(pilot: string): Promise<Array<string | null>> {
    const rows = await pool.query<{ bot_difficulty: string | null }>(
      'SELECT bot_difficulty FROM game_seats WHERE pilot = $1 ORDER BY game_id',
      [pilot],
    );
    return rows.rows.map((row) => row.bot_difficulty);
  }

  async function runBackfill(): Promise<number> {
    const result = await pool.query(backfillSql);
    return result.rowCount ?? 0;
  }

  it('stamps every current-era preset with its tier', async () => {
    for (const [index, [pilot]] of CURRENT_ERA.entries()) {
      await ingestBotSeat(`g-current-${index}`, pilot);
    }

    expect(await runBackfill()).toBe(CURRENT_ERA.length);
    for (const [pilot, difficulty] of CURRENT_ERA) {
      expect(await stamped(pilot)).toEqual([difficulty]);
    }
  });

  it('matches a stored label whose whitespace differs from the canonical form', async () => {
    // Live pilots are not uniformly formatted; the space is formatting, not a
    // different bot. Casing is normalized for the same reason.
    await ingestBotSeat('g-ws-space', 'bot:mc(64, 10000ms)');
    await ingestBotSeat('g-ws-tab', 'bot:ismcts(512,\t10000ms)');
    await ingestBotSeat('g-ws-case', 'BOT:MC(16,10000MS)');

    expect(await runBackfill()).toBe(3);
    expect(await stamped('bot:mc(64, 10000ms)')).toEqual(['hard']);
    expect(await stamped('bot:ismcts(512,\t10000ms)')).toEqual(['expert']);
    expect(await stamped('BOT:MC(16,10000MS)')).toEqual(['medium']);
  });

  it('leaves legacy budget labels, sweep labels and humans NULL', async () => {
    for (const [index, pilot] of LEFT_NULL.entries()) {
      await ingestBotSeat(`g-legacy-${index}`, pilot);
    }

    expect(await runBackfill()).toBe(0);
    for (const pilot of LEFT_NULL) {
      // `human` matches the opposing seat of every duel above, not just its own.
      const values = await stamped(pilot);
      expect(values.length).toBeGreaterThan(0);
      expect(values.filter((value) => value !== null)).toEqual([]);
    }
    // The human seat on the other side of each duel is untouched too.
    const nonNull = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM game_seats WHERE bot_difficulty IS NOT NULL',
    );
    expect(nonNull.rows[0]!.count).toBe('0');
  });

  it('is a no-op on a re-run', async () => {
    await ingestBotSeat('g-idem-0', 'bot:ismcts(512,10000ms)');
    await ingestBotSeat('g-idem-1', 'bot:mc(64, 400ms)');

    expect(await runBackfill()).toBe(1);
    expect(await runBackfill()).toBe(0);
    expect(await runBackfill()).toBe(0);
    expect(await stamped('bot:ismcts(512,10000ms)')).toEqual(['expert']);
    expect(await stamped('bot:mc(64, 400ms)')).toEqual([null]);
  });

  it('never overwrites a difficulty the engine stamped', async () => {
    // What unbrewed-engine#366 will start sending. The label says hard; if the
    // engine says easy, the engine wins.
    await ingestBotSeat('g-stamped', 'bot:mc(64,10000ms)', 'easy');

    expect(await runBackfill()).toBe(0);
    expect(await stamped('bot:mc(64,10000ms)')).toEqual(['easy']);
  });
});
