import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { sampleGame } from './fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const READ_TOKEN = 'accounts-read-token-for-cache-tests';
const TTL_MS = 60_000;

describeDb('stats response cache (#86)', () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let nowMs = Date.parse('2026-07-14T16:30:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    server = createServer(createApp({
      repo: new PgTelemetryRepository(pool),
      cpRepo: new ControlPlaneRepository(pool),
      config: {
        telemetrySecret: '',
        accountsReadToken: READ_TOKEN,
        allowUnauthenticatedIngest: true,
        bodyLimitBytes: 1024 * 1024,
        replayBodyLimitBytes: 2 * 1024 * 1024,
        now: () => new Date(nowMs),
        discordClientId: '',
        discordClientSecret: '',
        discordRedirectUri: '',
        adminDiscordIds: [],
        secureCookies: false,
        statsCacheTtlMs: TTL_MS,
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE game_submissions, deck_definitions CASCADE');
    // Every test starts past the previous test's entries, so none of them leak.
    nowMs += 10 * TTL_MS;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  async function postGame(id: string): Promise<Response> {
    const response = await fetch(`${baseUrl}/v1/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': id },
      body: JSON.stringify(sampleGame({ gameId: id, stateHash: id })),
    });
    expect(response.status).toBe(201);
    return response;
  }

  it('serves a repeat dashboard load from cache within the TTL and reloads after it', async () => {
    await postGame('cache-001');
    const first = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilot=bot:hard`);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-stats-cache')).toBe('miss');
    expect(first.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
    expect(first.headers.get('etag')).toMatch(/^W\/".+"$/);
    expect(((await first.json()) as { totalGames: number }).totalGames).toBe(1);

    await postGame('cache-002');
    nowMs += TTL_MS - 1;
    const started = performance.now();
    // Same filters, different parameter order: one cache entry.
    const second = await fetch(`${baseUrl}/v1/stats/dashboard?pilot=bot:hard&format=duel`);
    const body = (await second.json()) as { totalGames: number };
    expect(performance.now() - started).toBeLessThan(100);
    expect(second.headers.get('x-stats-cache')).toBe('hit');
    expect(body.totalGames).toBe(1);

    nowMs += 1;
    const third = await fetch(`${baseUrl}/v1/stats/dashboard?format=duel&pilot=bot:hard`);
    expect(third.headers.get('x-stats-cache')).toBe('miss');
    expect(((await third.json()) as { totalGames: number }).totalGames).toBe(2);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    await postGame('cache-etag-001');
    const first = await fetch(`${baseUrl}/v1/stats/sources?format=duel`);
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();

    const revalidated = await fetch(`${baseUrl}/v1/stats/sources?format=duel`, { headers: { 'if-none-match': etag } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(revalidated.headers.get('cache-control')).toContain('public');
    expect(await revalidated.text()).toBe('');

    const stale = await fetch(`${baseUrl}/v1/stats/sources?format=duel`, { headers: { 'if-none-match': 'W/"other"' } });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('etag')).toBe(etag);
  });

  it('never caches error responses', async () => {
    for (let i = 0; i < 2; i += 1) {
      const missing = await fetch(`${baseUrl}/v1/stats/deck?deck=nobody@1.0.0`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('x-stats-cache')).toBe('miss');
      expect(missing.headers.get('cache-control')).toBe('no-store');
      expect(missing.headers.get('etag')).toBeNull();
    }
    const invalid = await fetch(`${baseUrl}/v1/stats/pilot-comparison?pilotA=a`);
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
  });

  it('caches accounts aggregates privately, after auth', async () => {
    const unauthorized = await fetch(`${baseUrl}/accounts/community`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('cache-control')).toBe('no-store');

    const read = () => fetch(`${baseUrl}/accounts/community?window=all`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    const first = await read();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, max-age=60, stale-while-revalidate=60');
    expect(first.headers.get('x-stats-cache')).toBe('miss');
    expect((await read()).headers.get('x-stats-cache')).toBe('hit');
    // Auth still runs on every request, cached or not.
    expect((await fetch(`${baseUrl}/accounts/community?window=all`)).status).toBe(401);
  });

  it('leaves ingest and auth routes uncached', async () => {
    const ingest = await postGame('cache-ingest-001');
    expect(ingest.headers.get('cache-control')).toBe('no-store');
    expect(ingest.headers.get('etag')).toBeNull();
    const me = await fetch(`${baseUrl}/v1/admin/me`);
    expect(me.headers.get('cache-control')).toBe('no-store');
  });
});
