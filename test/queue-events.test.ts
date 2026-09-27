import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { signBody } from '../src/http/auth.js';
import { validateQueueEvents } from '../src/ingest/queue-events-schema.js';
import type { QueueEvent } from '../src/types.js';
import { sampleQueueEvent } from './fixtures.js';

describe('queue events schema', () => {
  it('accepts a full search lifecycle', () => {
    const result = validateQueueEvents({
      events: [
        sampleQueueEvent({ type: 'search_started' }),
        sampleQueueEvent({ type: 'matched', waitMs: 8200 }),
        sampleQueueEvent({ type: 'abandoned', waitMs: 121000, reason: 'expired' }),
      ],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('accepts an optional schemaVersion stamp', () => {
    expect(validateQueueEvents({ schemaVersion: 1, events: [sampleQueueEvent()] })).toEqual({ ok: true, errors: [] });
  });

  it('rejects unknown properties at every level', () => {
    const top = validateQueueEvents({ events: [sampleQueueEvent()], extra: true });
    expect(top.ok).toBe(false);
    expect(top.errors.join('\n')).toContain('unexpected property extra');

    const event = validateQueueEvents({ events: [{ ...sampleQueueEvent(), playerId: 'player-1' }] });
    expect(event.ok).toBe(false);
    expect(event.errors.join('\n')).toContain('unexpected property playerId');
  });

  it('rejects missing required fields, unknown types and empty batches', () => {
    const { heroId: _heroId, ...withoutHero } = sampleQueueEvent();
    expect(validateQueueEvents({ events: [withoutHero] }).errors.join('\n')).toContain('heroId');
    expect(validateQueueEvents({ events: [sampleQueueEvent({ type: 'cancelled' as QueueEvent['type'] })] }).ok).toBe(false);
    expect(validateQueueEvents({ events: [] }).ok).toBe(false);
    expect(validateQueueEvents({ events: [sampleQueueEvent({ ts: 'yesterday' })] }).ok).toBe(false);
    expect(validateQueueEvents({ events: [sampleQueueEvent({ quickMatch: 'yes' as unknown as boolean })] }).ok).toBe(false);
  });

  it('keeps waitMs and reason to the event types that can carry them', () => {
    const wait = validateQueueEvents({ events: [sampleQueueEvent({ type: 'search_started', waitMs: 10 })] });
    expect(wait.ok).toBe(false);
    expect(wait.errors.join('\n')).toContain('/events/0/waitMs');

    const reason = validateQueueEvents({ events: [sampleQueueEvent({ type: 'matched', reason: 'expired' })] });
    expect(reason.ok).toBe(false);
    expect(reason.errors.join('\n')).toContain('/events/0/reason');

    expect(validateQueueEvents({ events: [sampleQueueEvent({ type: 'matched', waitMs: 900 })] }).ok).toBe(true);
    expect(validateQueueEvents({ events: [sampleQueueEvent({ type: 'abandoned' })] }).ok).toBe(true);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('queue events ingest with postgres', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  let server: Server;
  let baseUrl: string;
  const secret = 'test-secret';
  const now = new Date('2026-08-23T12:00:00.000Z');

  async function post(payload: unknown, options: { sign?: boolean; signature?: string } = {}): Promise<Response> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.sign !== false) {
      const signed = signBody(secret, body, now.toISOString());
      headers['x-unbrewed-timestamp'] = signed.timestamp;
      headers['x-unbrewed-signature'] = options.signature ?? signed.signature;
    }
    return fetch(`${baseUrl}/v1/queue-events`, { method: 'POST', headers, body });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    server = createServer(createApp({
      repo,
      cpRepo: new ControlPlaneRepository(pool),
      config: {
        telemetrySecret: secret,
        allowUnauthenticatedIngest: false,
        bodyLimitBytes: 1024 * 1024,
        replayBodyLimitBytes: 2 * 1024 * 1024,
        now: () => now,
        discordClientId: '',
        discordClientSecret: '',
        discordRedirectUri: '',
        adminDiscordIds: [],
        secureCookies: false,
        accountsReadToken: '',
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE queue_events');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it('persists a signed batch as-is', async () => {
    const response = await post({
      events: [
        sampleQueueEvent({ type: 'search_started', roomId: 'room-1', ts: '2026-08-23T11:59:00.000Z' }),
        sampleQueueEvent({ type: 'matched', roomId: 'room-1', waitMs: 8200, ts: '2026-08-23T11:59:08.200Z' }),
        sampleQueueEvent({ type: 'abandoned', roomId: 'room-2', quickMatch: false, waitMs: 120000, reason: 'host_left', ts: '2026-08-23T11:58:00.000Z' }),
      ],
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, inserted: 3 });

    const { rows } = await pool.query('SELECT * FROM queue_events ORDER BY id');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      type: 'search_started',
      room_id: 'room-1',
      hero_id: 'king-kong',
      format_id: 'duel',
      quick_match: true,
      wait_ms: null,
      reason: null,
    });
    expect(rows[0].received_at).toEqual(now);
    expect(rows[0].ts).toEqual(new Date('2026-08-23T11:59:00.000Z'));
    expect(rows[1]).toMatchObject({ type: 'matched', wait_ms: 8200, reason: null });
    expect(rows[2]).toMatchObject({ type: 'abandoned', quick_match: false, wait_ms: 120000, reason: 'host_left' });
  });

  it('rejects an unsigned or badly signed submission', async () => {
    const unsigned = await post({ events: [sampleQueueEvent()] }, { sign: false });
    expect(unsigned.status).toBe(401);

    const forged = await post(
      { events: [sampleQueueEvent()] },
      { signature: `sha256=${'0'.repeat(64)}` },
    );
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });

    expect((await pool.query('SELECT count(*)::int AS n FROM queue_events')).rows[0].n).toBe(0);
  });

  it('rejects a schema violation with 400 and writes nothing', async () => {
    const response = await post({ events: [{ ...sampleQueueEvent(), waitMs: 'soon' }] });
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; code: string; errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors.join('\n')).toContain('/events/0/waitMs');

    const semantic = await post({ events: [sampleQueueEvent({ type: 'search_started', waitMs: 10 })] });
    expect(semantic.status).toBe(400);

    expect((await pool.query('SELECT count(*)::int AS n FROM queue_events')).rows[0].n).toBe(0);
  });

  it('rejects malformed JSON and a non-JSON content type', async () => {
    const signed = signBody(secret, 'not json', now.toISOString());
    const badJson = await fetch(`${baseUrl}/v1/queue-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unbrewed-timestamp': signed.timestamp,
        'x-unbrewed-signature': signed.signature,
      },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ code: 'BAD_JSON' });

    const wrongType = await fetch(`${baseUrl}/v1/queue-events`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'events',
    });
    expect(wrongType.status).toBe(415);
  });

  it('aggregates median/p75 wait and match rate over a trailing window, split by quick match', async () => {
    // Quick match: 4 searches, 3 matched with waits 1s/3s/5s (median 3s, p75 4s).
    await repo.insertQueueEvents([
      sampleQueueEvent({ type: 'search_started', roomId: 'q-1' }),
      sampleQueueEvent({ type: 'search_started', roomId: 'q-2' }),
      sampleQueueEvent({ type: 'search_started', roomId: 'q-3' }),
      sampleQueueEvent({ type: 'search_started', roomId: 'q-4' }),
      sampleQueueEvent({ type: 'matched', roomId: 'q-1', waitMs: 1000 }),
      sampleQueueEvent({ type: 'matched', roomId: 'q-2', waitMs: 3000 }),
      sampleQueueEvent({ type: 'matched', roomId: 'q-3', waitMs: 5000 }),
      sampleQueueEvent({ type: 'abandoned', roomId: 'q-4', waitMs: 90000, reason: 'expired' }),
    ], now);
    // Custom lobbies: 2 searches, 1 matched at 10s.
    await repo.insertQueueEvents([
      sampleQueueEvent({ type: 'search_started', roomId: 'c-1', quickMatch: false }),
      sampleQueueEvent({ type: 'search_started', roomId: 'c-2', quickMatch: false }),
      sampleQueueEvent({ type: 'matched', roomId: 'c-1', quickMatch: false, waitMs: 10000 }),
    ], now);
    // Outside the window: must not move any number above.
    await repo.insertQueueEvents([
      sampleQueueEvent({ type: 'search_started', roomId: 'old-1' }),
      sampleQueueEvent({ type: 'matched', roomId: 'old-1', waitMs: 999000 }),
    ], new Date(now.getTime() - 48 * 60 * 60 * 1000));

    const stats = await repo.queueWaitStats({ windowHours: 24 }, now);
    expect(stats.windowHours).toBe(24);
    expect(stats.generatedAt).toBe(now.toISOString());
    expect(stats.buckets).toEqual([
      {
        quickMatch: true,
        searchStarted: 4,
        matched: 3,
        abandoned: 1,
        matchRate: 0.75,
        waitSamples: 3,
        medianWaitMs: 3000,
        p75WaitMs: 4000,
      },
      {
        quickMatch: false,
        searchStarted: 2,
        matched: 1,
        abandoned: 0,
        matchRate: 0.5,
        waitSamples: 1,
        medianWaitMs: 10000,
        p75WaitMs: 10000,
      },
    ]);
  });

  it('reports no wait percentiles when matched events carry no waitMs', async () => {
    await repo.insertQueueEvents([
      sampleQueueEvent({ type: 'search_started', roomId: 'q-1' }),
      sampleQueueEvent({ type: 'matched', roomId: 'q-1' }),
    ], now);

    const stats = await repo.queueWaitStats({ windowHours: 24 }, now);
    expect(stats.buckets).toEqual([{
      quickMatch: true,
      searchStarted: 1,
      matched: 1,
      abandoned: 0,
      matchRate: 1,
      waitSamples: 0,
      medianWaitMs: null,
      p75WaitMs: null,
    }]);
  });

  it('leaves the game ingest tables untouched', async () => {
    const countGames = async () =>
      (await pool.query('SELECT count(*)::int AS submissions, (SELECT count(*)::int FROM games) AS games FROM game_submissions')).rows[0];
    const before = await countGames();
    const response = await post({ events: [sampleQueueEvent()] });
    expect(response.status).toBe(201);
    expect(await countGames()).toEqual(before);
  });
});
