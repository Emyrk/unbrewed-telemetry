/**
 * GET /accounts/replays/:gameId — DB-backed, gated on TEST_DATABASE_URL.
 * Server-to-server bearer read of a stored replay bundle, served verbatim.
 */

import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { sampleReplayBundle } from './fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const READ_TOKEN = 'accounts-read-token-for-tests';
const GAME_ID = 'live-room1-1790000000000-abcdef123456';
const now = new Date('2026-10-05T12:00:00.000Z');

const appConfig = (accountsReadToken: string) => ({
  telemetrySecret: 'unused',
  accountsReadToken,
  allowUnauthenticatedIngest: true,
  bodyLimitBytes: 1024 * 1024,
  replayBodyLimitBytes: 2 * 1024 * 1024,
  now: () => now,
  discordClientId: '',
  discordClientSecret: '',
  discordRedirectUri: '',
  adminDiscordIds: [],
  secureCookies: false,
});

describeDb('GET /accounts/replays/:gameId', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  let server: Server;
  let unconfigured: Server;
  let baseUrl: string;
  let unconfiguredUrl: string;

  const listen = async (s: Server): Promise<string> => {
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const address = s.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    return `http://127.0.0.1:${address.port}`;
  };
  const get = (path: string, token: string | null = READ_TOKEN, base = baseUrl) =>
    fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    const cpRepo = new ControlPlaneRepository(pool);
    server = createServer(createApp({ repo, cpRepo, config: appConfig(READ_TOKEN) }));
    unconfigured = createServer(createApp({ repo, cpRepo, config: appConfig('') }));
    baseUrl = await listen(server);
    unconfiguredUrl = await listen(unconfigured);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM game_replays WHERE game_id = $1', [GAME_ID]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM game_replays WHERE game_id = $1', [GAME_ID]);
    for (const s of [server, unconfigured]) {
      await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    }
    await pool.end();
  });

  const insert = (bundle = sampleReplayBundle()) =>
    repo.insertGameReplay({ gameId: GAME_ID, bundle, receivedAt: now, source: 'test', authKeyId: null });

  it('503s when ACCOUNTS_READ_TOKEN is unset, even with a bearer', async () => {
    const res = await get(`/accounts/replays/${GAME_ID}`, 'anything', unconfiguredUrl);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('refuses a missing or wrong bearer', async () => {
    await insert();
    expect((await get(`/accounts/replays/${GAME_ID}`, null)).status).toBe(401);
    expect((await get(`/accounts/replays/${GAME_ID}`, 'wrong')).status).toBe(401);
  });

  it('returns the stored bundle verbatim with the envelope and cache headers', async () => {
    const bundle = sampleReplayBundle();
    await insert(bundle);
    const res = await get(`/accounts/replays/${GAME_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    const body = await res.json();
    expect(body).toEqual({
      gameId: GAME_ID,
      receivedAt: now.toISOString(),
      engine: { schemaVersion: 2, dslVersion: '0.78.0' },
      digestVersion: 1,
      actionCount: 1,
      turns: 1,
      bundle,
    });
  });

  it('404s an unknown id', async () => {
    const res = await get('/accounts/replays/live-nope');
    expect(res.status).toBe(404);
  });

  it('400s an over-long id and bad percent-encoding, 404s an empty id', async () => {
    expect((await get(`/accounts/replays/${'x'.repeat(201)}`)).status).toBe(400);
    expect((await get('/accounts/replays/')).status).toBe(404);
    expect((await get('/accounts/replays/%E0%A4%A')).status).toBe(400);
  });

  it('400s control characters in the id instead of 500ing', async () => {
    expect((await get('/accounts/replays/Probe-1%00')).status).toBe(400);
    expect((await get('/accounts/replays/Probe-1%0a')).status).toBe(400);
  });

  it('keeps nothing else reachable under the prefix', async () => {
    expect((await get(`/accounts/replays/${GAME_ID}/extra`)).status).toBe(404);
  });
});
