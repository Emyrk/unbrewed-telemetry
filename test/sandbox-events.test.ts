import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import { signBody } from '../src/http/auth.js';
import { validateSandboxEvents } from '../src/ingest/sandbox-events-schema.js';
import type { SandboxEvent, SandboxStatsResponse } from '../src/types.js';
import { sampleGame } from './fixtures.js';

const PLAYER_A = '9f2e4c1a7b3d5e60';
const PLAYER_B = '0123456789abcdef';
const PLAYER_C = 'fedcba9876543210';
const LOBBY = '5a6b7c8d9e0f1a2b';

function ev(overrides: Partial<SandboxEvent> & Pick<SandboxEvent, 'type'>): SandboxEvent {
  return { eventId: randomUUID(), roomId: 'a1b2c3', ts: '2026-10-08T19:00:00Z', ...overrides };
}

const opened = (roomId: string) => ev({ type: 'room_opened', roomId, lobbyHash: LOBBY });
const joined = (roomId: string, playerHash: string, connections = 1) =>
  ev({ type: 'player_joined', roomId, playerHash, connections });

function contractBatch(): SandboxEvent[] {
  return [
    ev({ type: 'room_opened', lobbyHash: LOBBY }),
    ev({ type: 'player_joined', playerHash: PLAYER_A, connections: 1 }),
    ev({ type: 'player_left', playerHash: PLAYER_A, connections: 0 }),
    ev({ type: 'hero_seen', playerHash: PLAYER_A, heroName: 'Medusa' }),
    ev({
      type: 'room_closed',
      reason: 'inactive',
      lifetimeMs: 3600000,
      distinctPlayers: 2,
      peakConnections: 3,
      stateUpdates: 412,
    }),
  ];
}

describe('sandbox events schema', () => {
  it('accepts the contract batch', () => {
    expect(validateSandboxEvents({ schemaVersion: 1, events: contractBatch() })).toEqual({ ok: true, errors: [] });
  });

  it('refuses raw player names at every level', () => {
    for (const key of ['name', 'playerName', 'displayName']) {
      const onEvent = validateSandboxEvents({ events: [{ ...joined('r', PLAYER_A), [key]: 'Alice' }] });
      expect(onEvent.ok).toBe(false);
      expect(onEvent.errors.join('\n')).toContain(`unexpected property ${key}`);
      expect(validateSandboxEvents({ events: [opened('r')], [key]: 'Alice' }).ok).toBe(false);
    }
  });

  it('rejects malformed hashes, ids and oversized strings', () => {
    expect(validateSandboxEvents({ events: [joined('r', 'ABCDEF0123456789')] }).ok).toBe(false);
    expect(validateSandboxEvents({ events: [joined('r', 'abc')] }).ok).toBe(false);
    expect(validateSandboxEvents({ events: [{ ...opened('r'), eventId: 'not-a-uuid' }] }).ok).toBe(false);
    expect(validateSandboxEvents({ events: [opened('x'.repeat(129))] }).ok).toBe(false);
    expect(validateSandboxEvents({
      events: [ev({ type: 'hero_seen', playerHash: PLAYER_A, heroName: 'x'.repeat(129) })],
    }).ok).toBe(false);
    expect(validateSandboxEvents({ events: [] }).ok).toBe(false);
    expect(validateSandboxEvents({ schemaVersion: 2, events: [opened('r')] }).ok).toBe(false);
  });

  it('enforces the per-type fields', () => {
    const join = validateSandboxEvents({ events: [ev({ type: 'player_joined', playerHash: PLAYER_A })] });
    expect(join.errors).toEqual(['/events/0/connections: required on player_joined events']);

    const hero = validateSandboxEvents({ events: [ev({ type: 'hero_seen', playerHash: PLAYER_A })] });
    expect(hero.errors).toEqual(['/events/0/heroName: required on hero_seen events']);

    const closed = validateSandboxEvents({ events: [ev({ type: 'room_closed', reason: 'shutdown' })] });
    expect(closed.ok).toBe(false);
    expect(closed.errors).toHaveLength(4);

    const stray = validateSandboxEvents({ events: [ev({ type: 'room_opened', lobbyHash: LOBBY, playerHash: PLAYER_A })] });
    expect(stray.errors).toEqual(['/events/0/playerHash: not carried by room_opened events']);
  });

  it('requires lobbyHash on room_opened and rejects it elsewhere', () => {
    const missing = validateSandboxEvents({ events: [ev({ type: 'room_opened' })] });
    expect(missing.ok).toBe(false);
    expect(missing.errors).toEqual(["/events/0: must have required property 'lobbyHash'"]);

    for (const event of [joined('r', PLAYER_A), ...contractBatch().slice(1)]) {
      const stray = validateSandboxEvents({ events: [{ ...event, lobbyHash: LOBBY }] });
      expect(stray.ok).toBe(false);
      expect(stray.errors).toEqual(['/events/0/lobbyHash: not carried by events other than room_opened']);
    }

    expect(validateSandboxEvents({ events: [{ ...opened('r'), lobbyHash: 'ABCDEF0123456789' }] }).ok).toBe(false);
    expect(validateSandboxEvents({ events: [{ ...opened('r'), lobbyHash: 'abc' }] }).ok).toBe(false);
  });

  it('caps a batch at 1000 events', () => {
    const events = (n: number) => Array.from({ length: n }, () => opened('r'));
    expect(validateSandboxEvents({ events: events(1000) }).ok).toBe(true);
    const over = validateSandboxEvents({ events: events(1001) });
    expect(over.errors).toEqual(['/events: must NOT have more than 1000 items']);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('sandbox events with postgres', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  let cpRepo: ControlPlaneRepository;
  let server: Server;
  let baseUrl: string;
  let sandboxKey: string;
  let gamesOnlyKey: string;
  const secret = 'test-secret';
  const now = new Date('2026-10-09T12:00:00.000Z');

  async function post(payload: unknown, key: string | null): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    return fetch(`${baseUrl}/v1/sandbox-events`, { method: 'POST', headers, body: JSON.stringify(payload) });
  }

  async function stats(windowHours?: number | string) {
    const query = windowHours === undefined ? '' : `?windowHours=${windowHours}`;
    return fetch(`${baseUrl}/v1/stats/sandbox${query}`);
  }

  async function insertAt(hoursAgo: number, events: SandboxEvent[]): Promise<void> {
    await repo.insertSandboxEvents(events, 'sandbox-relay', new Date(now.getTime() - hoursAgo * 3600 * 1000));
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    cpRepo = new ControlPlaneRepository(pool);
    server = createServer(createApp({
      repo,
      cpRepo,
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
    await pool.query('TRUNCATE sandbox_events');
    await pool.query('TRUNCATE game_submissions CASCADE');
    await pool.query('TRUNCATE telemetry_sources, source_credentials CASCADE');
    const source = await cpRepo.createSource('sandbox-relay', null, 'test-admin');
    sandboxKey = (await cpRepo.createCredential(source.id, 'relay', ['sandbox:submit'], 'test-admin')).fullKey;
    gamesOnlyKey = (await cpRepo.createCredential(source.id, 'pro', ['games:submit'], 'test-admin')).fullKey;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it('stores a batch once and counts a re-send as duplicates', async () => {
    const batch = { schemaVersion: 1, events: contractBatch() };
    const first = await post(batch, sandboxKey);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, inserted: 5, duplicates: 0 });

    const again = await post(batch, sandboxKey);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ ok: true, inserted: 0, duplicates: 5 });

    const { rows } = await pool.query(
      `SELECT source, type, lobby_hash, player_hash, hero_name, connections, reason, lifetime_ms::int AS lifetime_ms,
              distinct_players, peak_connections, state_updates, received_at
       FROM sandbox_events ORDER BY id`,
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.source === 'sandbox-relay')).toBe(true);
    expect(rows[0]).toMatchObject({ type: 'room_opened', lobby_hash: LOBBY, player_hash: null });
    expect(rows[1]).toMatchObject({ type: 'player_joined', lobby_hash: null, player_hash: PLAYER_A });
    expect(rows[3]).toMatchObject({ type: 'hero_seen', player_hash: PLAYER_A, hero_name: 'Medusa' });
    expect(rows[4]).toMatchObject({
      type: 'room_closed', reason: 'inactive', lifetime_ms: 3600000,
      distinct_players: 2, peak_connections: 3, state_updates: 412,
    });
    expect(rows[0].received_at.toISOString()).toBe(now.toISOString());
  });

  it('rejects a batch over 1000 events with 400, not a bind-parameter 500', async () => {
    const events = Array.from({ length: 1001 }, (_, i) => joined(`r${i}`, PLAYER_A));
    const response = await post({ events }, sandboxKey);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect((await pool.query('SELECT count(*)::int AS n FROM sandbox_events')).rows[0].n).toBe(0);

    const full = await post({ events: events.slice(0, 1000) }, sandboxKey);
    expect(await full.json()).toEqual({ ok: true, inserted: 1000, duplicates: 0 });
  });

  it('dedupes an eventId repeated inside one batch', async () => {
    const event = opened('r1');
    const response = await post({ events: [event, event] }, sandboxKey);
    expect(await response.json()).toEqual({ ok: true, inserted: 1, duplicates: 1 });
  });

  it('requires a bearer credential with sandbox:submit', async () => {
    const batch = { events: [opened('r1')] };
    expect((await post(batch, null)).status).toBe(401);
    expect((await post(batch, 'ubk_nope.secret')).status).toBe(401);
    expect((await post(batch, gamesOnlyKey)).status).toBe(403);

    // HMAC is the legacy scheme; it does not open this route.
    const body = JSON.stringify(batch);
    const signed = signBody(secret, body, now.toISOString());
    const hmac = await fetch(`${baseUrl}/v1/sandbox-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unbrewed-timestamp': signed.timestamp,
        'x-unbrewed-signature': signed.signature,
      },
      body,
    });
    expect(hmac.status).toBe(401);
    expect((await pool.query('SELECT count(*)::int AS n FROM sandbox_events')).rows[0].n).toBe(0);
  });

  it('refuses a payload carrying a raw player name', async () => {
    for (const key of ['name', 'playerName', 'displayName']) {
      const response = await post({ events: [{ ...joined('r1', PLAYER_A), [key]: 'Alice' }] }, sandboxKey);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM sandbox_events')).rows[0].n).toBe(0);
  });

  it('leaves /v1/stats/dashboard byte-identical', async () => {
    await repo.ingestValid({
      payload: sampleGame(),
      idempotencyKey: 'dash-1',
      receivedAt: now,
      authKeyId: null,
      sourceOverride: null,
      sourceId: null,
    });
    const dashboard = async () => (await fetch(`${baseUrl}/v1/stats/dashboard`)).text();
    const before = await dashboard();
    expect(JSON.parse(before).totalGames).toBe(1);

    const response = await post({
      events: [opened('r1'), joined('r1', PLAYER_A), joined('r1', PLAYER_B, 2), ...contractBatch()],
    }, sandboxKey);
    expect(response.status).toBe(201);

    expect(await dashboard()).toBe(before);
  });

  it('counts a game only when two distinct players joined a room', async () => {
    await insertAt(1, [
      // r-solo: one person, joining twice — not a game.
      opened('r-solo'), joined('r-solo', PLAYER_A), joined('r-solo', PLAYER_A, 2),
      // r-pair: two people — a game.
      opened('r-pair'), joined('r-pair', PLAYER_A), joined('r-pair', PLAYER_B, 2),
      // r-three: three people — one game, peak 3 connections.
      opened('r-three'), joined('r-three', PLAYER_A), joined('r-three', PLAYER_B, 2), joined('r-three', PLAYER_C, 3),
      ev({ type: 'hero_seen', roomId: 'r-pair', playerHash: PLAYER_A, heroName: 'Medusa' }),
      ev({ type: 'hero_seen', roomId: 'r-three', playerHash: PLAYER_A, heroName: 'Medusa' }),
      ev({ type: 'hero_seen', roomId: 'r-three', playerHash: PLAYER_B, heroName: 'Medusa' }),
      ev({ type: 'hero_seen', roomId: 'r-pair', playerHash: PLAYER_B, heroName: 'Alice' }),
    ]);

    const response = await stats(24);
    expect(response.status).toBe(200);
    const body = await response.json() as SandboxStatsResponse;
    expect(body).toMatchObject({
      ok: true,
      windowHours: 24,
      generatedAt: now.toISOString(),
      roomsOpened: 3,
      games: 2,
      uniquePlayers: 3,
      returningPlayers: 0,
      peakConnections: 3,
      daily: [{ date: '2026-10-09', roomsOpened: 3, games: 2, uniquePlayers: 3 }],
      topHeroes: [{ heroName: 'Medusa', players: 2 }, { heroName: 'Alice', players: 1 }],
    });
    expect(body.hourOfWeek).toHaveLength(7 * 24);
    // 2026-10-09T11:00Z is a Friday (dow 5), hour 11.
    const cell = body.hourOfWeek.find((row) => row.dow === 5 && row.hour === 11)!;
    expect(cell.joins).toBe(7);
    expect(body.hourOfWeek.reduce((sum, row) => sum + row.joins, 0)).toBe(7);
  });

  it('marks players seen before the window as returning', async () => {
    // Ten days ago: A and B played. Outside a 168h window.
    await insertAt(240, [opened('old'), joined('old', PLAYER_A), joined('old', PLAYER_B, 2)]);
    // This week: A comes back with C, a newcomer.
    await insertAt(2, [opened('new'), joined('new', PLAYER_A), joined('new', PLAYER_C, 2)]);

    const body = await (await stats()).json() as SandboxStatsResponse;
    expect(body).toMatchObject({
      windowHours: 168,
      roomsOpened: 1,
      games: 1,
      uniquePlayers: 2,
      returningPlayers: 1,
    });

    const wide = await (await stats(24 * 30)).json() as SandboxStatsResponse;
    expect(wide).toMatchObject({ roomsOpened: 2, games: 2, uniquePlayers: 3, returningPlayers: 0 });
    expect(wide.daily.map((row) => row.date)).toEqual(['2026-09-29', '2026-10-09']);
  });

  it('returns zeros for an empty window and rejects a bad windowHours', async () => {
    const body = await (await stats()).json() as SandboxStatsResponse;
    expect(body).toMatchObject({
      roomsOpened: 0, games: 0, uniquePlayers: 0, returningPlayers: 0,
      peakConnections: null, daily: [], topHeroes: [],
    });
    expect(body.hourOfWeek.every((row) => row.joins === 0)).toBe(true);

    for (const bad of ['abc', '0', '-5', String(24 * 400)]) {
      expect((await stats(bad)).status).toBe(400);
    }
  });
});
