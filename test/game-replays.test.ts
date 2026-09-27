import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { signBody } from '../src/http/auth.js';
import { validateGameReplay } from '../src/ingest/game-replay-schema.js';
import { sampleReplayBundle } from './fixtures.js';

function withSeat(p1: Record<string, unknown>) {
  const bundle = sampleReplayBundle();
  const players = bundle.config.players as Record<string, unknown>;
  return { ...bundle, config: { ...bundle.config, players: { ...players, p1 } } };
}

describe('game replay schema', () => {
  it('accepts the sample bundle', () => {
    expect(validateGameReplay({ gameId: 'game-1', bundle: sampleReplayBundle() })).toEqual({ ok: true, errors: [] });
  });

  it('accepts an optional schemaVersion stamp', () => {
    expect(validateGameReplay({ schemaVersion: 1, gameId: 'game-1', bundle: sampleReplayBundle() }))
      .toEqual({ ok: true, errors: [] });
  });

  it('rejects unknown top-level and bundle-level properties', () => {
    const top = validateGameReplay({ gameId: 'game-1', bundle: sampleReplayBundle(), extra: true });
    expect(top.ok).toBe(false);
    expect(top.errors.join('\n')).toContain('unexpected property extra');

    const bundle = validateGameReplay({ gameId: 'game-1', bundle: { ...sampleReplayBundle(), chat: [] } });
    expect(bundle.ok).toBe(false);
    expect(bundle.errors.join('\n')).toContain('unexpected property chat');
  });

  it('rejects a missing or empty actionLog and an unknown bundle version', () => {
    const { actionLog: _actionLog, ...withoutLog } = sampleReplayBundle();
    expect(validateGameReplay({ gameId: 'game-1', bundle: withoutLog }).errors.join('\n')).toContain('actionLog');
    expect(validateGameReplay({ gameId: 'game-1', bundle: sampleReplayBundle({ actionLog: [] }) }).ok).toBe(false);
    expect(validateGameReplay({ gameId: 'game-1', bundle: { ...sampleReplayBundle(), v: 2 } }).ok).toBe(false);
    expect(validateGameReplay({ gameId: '', bundle: sampleReplayBundle() }).ok).toBe(false);
  });

  it('rejects player identity on a seat', () => {
    const result = validateGameReplay({
      gameId: 'game-1',
      bundle: withSeat({ heroId: 'thrall', hero: {}, cards: [], displayName: 'Steven' }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('/bundle: forbidden key displayName');

    const named = validateGameReplay({
      gameId: 'game-1',
      bundle: withSeat({ heroId: 'thrall', hero: {}, cards: [], name: 'Steven' }),
    });
    expect(named.ok).toBe(false);
    expect(named.errors).toContain('/bundle: forbidden key name');
  });

  it('rejects displayName, playerName and email at any depth', () => {
    const nested = validateGameReplay({
      gameId: 'game-1',
      bundle: sampleReplayBundle({ meta: { winner: 'p1', players: [{ displayName: 'Steven' }] } }),
    });
    expect(nested.ok).toBe(false);
    expect(nested.errors).toContain('/bundle: forbidden key displayName');

    const inLog = validateGameReplay({
      gameId: 'game-1',
      bundle: sampleReplayBundle({ actionLog: [{ type: 'CHAT', payload: { email: 'a@b.c', playerName: 'x' } }] }),
    });
    expect(inLog.errors).toEqual(expect.arrayContaining([
      '/bundle: forbidden key email',
      '/bundle: forbidden key playerName',
    ]));
  });

  it('allows name as rules content below the seat', () => {
    const result = validateGameReplay({
      gameId: 'game-1',
      bundle: withSeat({
        heroId: 'thrall',
        hero: { name: 'Thrall', counters: [{ name: 'RAGE' }] },
        cards: [{ blocks: [{ ops: [{ name: 'x' }] }] }],
      }),
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('replay ingest with postgres', () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  const secret = 'test-secret';
  const now = new Date('2026-09-27T12:00:00.000Z');
  const replayBodyLimitBytes = 4 * 1024;

  async function post(payload: unknown, options: { sign?: boolean } = {}): Promise<Response> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.sign !== false) {
      const signed = signBody(secret, body, now.toISOString());
      headers['x-unbrewed-timestamp'] = signed.timestamp;
      headers['x-unbrewed-signature'] = signed.signature;
    }
    return fetch(`${baseUrl}/v1/replays`, { method: 'POST', headers, body });
  }

  const countReplays = async () =>
    (await pool.query('SELECT count(*)::int AS n FROM game_replays')).rows[0].n as number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    server = createServer(createApp({
      repo: new PgTelemetryRepository(pool),
      cpRepo: new ControlPlaneRepository(pool),
      config: {
        telemetrySecret: secret,
        allowUnauthenticatedIngest: false,
        bodyLimitBytes: 1024 * 1024,
        replayBodyLimitBytes,
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
    await pool.query('TRUNCATE game_replays');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it('persists a signed bundle with the derived columns, and dedupes a re-post', async () => {
    const payload = { gameId: 'game-1', bundle: sampleReplayBundle() };
    const response = await post(payload);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, gameId: 'game-1', duplicate: false });

    const { rows } = await pool.query('SELECT * FROM game_replays');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      game_id: 'game-1',
      source: 'engine',
      auth_key_id: 'default',
      engine_schema_version: 2,
      engine_dsl_version: '0.78.0',
      digest_version: 1,
      action_count: 1,
      turns: 1,
      bundle_bytes: Buffer.byteLength(JSON.stringify(payload.bundle)),
    });
    expect(rows[0].bundle_bytes).toBeGreaterThan(0);
    expect(rows[0].received_at).toEqual(now);
    expect(rows[0].bundle).toEqual(payload.bundle);

    const again = await post(payload);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, gameId: 'game-1', duplicate: true });
    expect(await countReplays()).toBe(1);
  });

  it('stores null digest_version and turns when the bundle omits them', async () => {
    const { digests: _d, digestVersion: _v, ...bundle } = sampleReplayBundle({ meta: { winner: 'p1' } });
    expect((await post({ gameId: 'game-2', bundle })).status).toBe(201);
    const { rows } = await pool.query('SELECT digest_version, turns FROM game_replays');
    expect(rows[0]).toEqual({ digest_version: null, turns: null });
  });

  it('rejects an unsigned submission', async () => {
    const unsigned = await post({ gameId: 'game-1', bundle: sampleReplayBundle() }, { sign: false });
    expect(unsigned.status).toBe(401);
    expect(await countReplays()).toBe(0);
  });

  it('rejects a non-JSON content type', async () => {
    const response = await fetch(`${baseUrl}/v1/replays`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'bundle',
    });
    expect(response.status).toBe(415);
  });

  it('rejects a body over the replay cap with 413', async () => {
    const big = sampleReplayBundle({
      actionLog: Array.from({ length: 200 }, () => ({ type: 'END_TURN', player: 'p1' })),
    });
    expect(JSON.stringify(big).length).toBeGreaterThan(replayBodyLimitBytes);
    const response = await post({ gameId: 'game-1', bundle: big });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect(await countReplays()).toBe(0);
  });

  it('rejects malformed JSON and a schema failure with 400', async () => {
    const signed = signBody(secret, 'not json', now.toISOString());
    const badJson = await fetch(`${baseUrl}/v1/replays`, {
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

    const invalid = await post({ gameId: 'game-1', bundle: sampleReplayBundle({ actionLog: [] }) });
    expect(invalid.status).toBe(400);
    const body = await invalid.json() as { code: string; errors: string[] };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors.join('\n')).toContain('/bundle/actionLog');

    const identity = await post({
      gameId: 'game-1',
      bundle: withSeat({ heroId: 'thrall', hero: {}, cards: [], displayName: 'Steven' }),
    });
    expect(identity.status).toBe(400);
    expect(await countReplays()).toBe(0);
  });

  it('leaves the game ingest tables untouched', async () => {
    const countGames = async () =>
      (await pool.query('SELECT count(*)::int AS submissions, (SELECT count(*)::int FROM games) AS games FROM game_submissions')).rows[0];
    const before = await countGames();
    expect((await post({ gameId: 'game-3', bundle: sampleReplayBundle() })).status).toBe(201);
    expect(await countGames()).toEqual(before);
  });
});
