import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp, type AppConfig } from '../src/http/app.js';
import { signBody } from '../src/http/auth.js';
import { MAX_ACTION_DEPTH, validatePuzzleAttempt } from '../src/ingest/puzzle-attempt-schema.js';
import type { PuzzleAttemptSubmission } from '../src/types.js';
import { sampleGame } from './fixtures.js';

/** The committed example: a realistic attempt with real engine action shapes. */
function examplePayload(overrides: Partial<PuzzleAttemptSubmission> = {}): PuzzleAttemptSubmission {
  const file = new URL('../examples/sample-puzzle-attempt.json', import.meta.url);
  return { ...(JSON.parse(readFileSync(file, 'utf8')) as PuzzleAttemptSubmission), ...overrides };
}

function without(key: keyof PuzzleAttemptSubmission): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = examplePayload();
  return rest;
}

describe('puzzle attempt schema', () => {
  it('accepts the committed example payload', () => {
    const example = examplePayload();
    expect(validatePuzzleAttempt(example)).toEqual({ ok: true, errors: [] });
    // The example must stay realistic: engine actions with their real keys.
    expect(example.actions.length).toBeGreaterThan(1);
    const keys = new Set(example.actions.flatMap((entry) => Object.keys(entry.action)));
    for (const key of ['type', 'player', 'attacker', 'target', 'path', 'card', 'promptId', 'optionId']) {
      expect(keys).toContain(key);
    }
  });

  it('accepts every context and result, null ids, and an account attempt', () => {
    for (const context of ['landing', 'page', 'quick_search', 'lobby_wait'] as const) {
      expect(validatePuzzleAttempt(examplePayload({ context })).ok).toBe(true);
    }
    for (const result of ['solved', 'failed', 'abandoned'] as const) {
      expect(validatePuzzleAttempt(examplePayload({ result })).ok).toBe(true);
    }
    expect(validatePuzzleAttempt(examplePayload({ analytics_id: null, account_id: null })).ok).toBe(true);
    expect(validatePuzzleAttempt(examplePayload({
      analytics_id: null,
      account_id: '5d0c1c1e-2f6b-4d53-9a51-0e6a3f1f2b77',
    })).ok).toBe(true);
  });

  it('accepts an abandoned attempt with no actions and a minimal engine block', () => {
    const { schema_version: _v, ...unstamped } = examplePayload({
      result: 'abandoned',
      actions: [],
      engine: { protocol_version: 39 },
    });
    expect(validatePuzzleAttempt(unstamped)).toEqual({ ok: true, errors: [] });
  });

  it('leaves the engine action object free-form', () => {
    const result = validatePuzzleAttempt(examplePayload({
      actions: [{
        t_ms: 0,
        actor: 'solver',
        action: { type: 'SOMETHING_NEW', player: 'p1', name: 'x', nested: { deeper: [{ any: 'thing' }] } },
      }],
    }));
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('rejects an unknown key at every closed level', () => {
    const top = validatePuzzleAttempt({ ...examplePayload(), display_name: 'Steven' });
    expect(top.ok).toBe(false);
    expect(top.errors).toContain('/: unexpected property display_name');

    const example = examplePayload();
    const inAction = validatePuzzleAttempt({
      ...example,
      actions: [{ ...example.actions[0], note: 'x' }],
    });
    expect(inAction.ok).toBe(false);
    expect(inAction.errors).toContain('/actions/0: unexpected property note');

    const inEngine = validatePuzzleAttempt({ ...example, engine: { ...example.engine, schema_version: 5 } });
    expect(inEngine.ok).toBe(false);
    expect(inEngine.errors).toContain('/engine: unexpected property schema_version');
  });

  it('rejects a bad enum value', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['/puzzle_type', { puzzle_type: 'survive' }],
      ['/context', { context: 'tutorial' }],
      ['/result', { result: 'won' }],
    ];
    for (const [path, override] of cases) {
      const result = validatePuzzleAttempt({ ...examplePayload(), ...override });
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain(path);
    }
    const example = examplePayload();
    const actor = validatePuzzleAttempt({ ...example, actions: [{ ...example.actions[0], actor: 'bot' }] });
    expect(actor.ok).toBe(false);
    expect(actor.errors.join('\n')).toContain('/actions/0/actor');
  });

  it('rejects a missing required field, including a nullable id left out', () => {
    for (const key of [
      'attempt_id', 'puzzle_id', 'puzzle_version', 'puzzle_type', 'context', 'result', 'try_number',
      'started_at', 'ended_at', 'duration_ms', 'actions', 'hint_used', 'solution_shown',
      'analytics_id', 'account_id', 'engine', 'source',
    ] as const) {
      const result = validatePuzzleAttempt(without(key));
      expect(result.ok, key).toBe(false);
      expect(result.errors.join('\n')).toContain(key);
    }
    expect(validatePuzzleAttempt({ ...examplePayload(), engine: { dsl_version: '0.92.0' } }).ok).toBe(false);
  });

  it('rejects out-of-range and wrongly typed values', () => {
    const bad: Array<Record<string, unknown>> = [
      { attempt_id: '' },
      { try_number: 0 },
      { try_number: 1.5 },
      { puzzle_version: '1' },
      { duration_ms: -1 },
      { started_at: '2026-11-16 12:00' },
      { hint_used: 'no' },
      { analytics_id: '' },
      { actions: 'none' },
      { actions: [{ t_ms: -1, actor: 'solver', action: { type: 'MANEUVER' } }] },
      { actions: [{ t_ms: 1, actor: 'solver', action: 'MANEUVER' }] },
      { actions: [{ t_ms: 1, actor: 'solver' }] },
    ];
    for (const override of bad) {
      expect(validatePuzzleAttempt({ ...examplePayload(), ...override }).ok, JSON.stringify(override)).toBe(false);
    }
  });

  it('bounds the action list at 200', () => {
    const action = { t_ms: 1, actor: 'solver' as const, action: { type: 'MANEUVER', player: 'p1' } };
    expect(validatePuzzleAttempt(examplePayload({ actions: Array.from({ length: 200 }, () => action) })).ok).toBe(true);
    const over = validatePuzzleAttempt(examplePayload({ actions: Array.from({ length: 201 }, () => action) }));
    expect(over.ok).toBe(false);
    expect(over.errors.join('\n')).toContain('/actions');
  });

  it('rejects an attempt that ends before it starts', () => {
    const result = validatePuzzleAttempt(examplePayload({
      started_at: '2026-11-16T12:00:10.000Z',
      ended_at: '2026-11-16T12:00:00.000Z',
    }));
    expect(result).toEqual({ ok: false, errors: ['/ended_at: must not be before started_at'] });
  });

  it('rejects what Postgres could not store, instead of failing the insert', () => {
    const nul = String.fromCharCode(0);
    const loneSurrogate = String.fromCharCode(0xd800);
    const unstorable = '/: strings must not contain a NUL character or a lone surrogate';
    const action = (inner: Record<string, unknown>) => [{ t_ms: 1, actor: 'solver' as const, action: inner }];
    for (const override of [
      { attempt_id: `a${nul}b` },
      { account_id: `acct${nul}` },
      { actions: action({ type: 'MANEUVER', note: `x${nul}` }) },
      { actions: action({ type: 'MANEUVER', nested: [{ [`k${nul}`]: 1 }] }) },
      { actions: action({ type: 'MANEUVER', note: loneSurrogate }) },
    ] as Array<Partial<PuzzleAttemptSubmission>>) {
      expect(validatePuzzleAttempt(examplePayload(override)).errors, JSON.stringify(override)).toContain(unstorable);
    }
    // A real astral character (a surrogate pair) and a literal backslash-u text are fine.
    expect(validatePuzzleAttempt(examplePayload({
      actions: action({ type: 'MANEUVER', note: '\u{1F600} \\u0000' }),
    }))).toEqual({ ok: true, errors: [] });

    expect(validatePuzzleAttempt(examplePayload({ started_at: '0000-01-01T00:00:00Z' })).errors)
      .toContain('/started_at: not a storable timestamp');
    expect(validatePuzzleAttempt(examplePayload({
      started_at: '2027-06-01T00:00:00Z',
      ended_at: '2026-12-31T23:59:60Z',
    })).errors).toContain('/ended_at: not a storable timestamp');
  });

  it('rejects a solve reported after the solution was shown', () => {
    expect(validatePuzzleAttempt(examplePayload({ result: 'solved', solution_shown: true }))).toEqual({
      ok: false,
      errors: ['/result: must not be solved when solution_shown is true'],
    });
    // Shown the solution and not solved, or solved after only a hint, are both fine.
    for (const result of ['failed', 'abandoned'] as const) {
      expect(validatePuzzleAttempt(examplePayload({ result, solution_shown: true })).ok, result).toBe(true);
    }
    expect(validatePuzzleAttempt(examplePayload({ result: 'solved', hint_used: true })).ok).toBe(true);
  });

  it('caps how deep an action may nest', () => {
    const tooDeep = `/actions: an action must not nest deeper than ${MAX_ACTION_DEPTH} levels`;
    expect(MAX_ACTION_DEPTH).toBe(32);
    for (const kind of ['object', 'array'] as const) {
      const atCap = validatePuzzleAttempt(examplePayload({ actions: [nestedAction(MAX_ACTION_DEPTH, kind)] }));
      expect(atCap, kind).toEqual({ ok: true, errors: [] });
      const over = validatePuzzleAttempt(examplePayload({ actions: [nestedAction(MAX_ACTION_DEPTH + 1, kind)] }));
      expect(over, kind).toEqual({ ok: false, errors: [tooDeep] });
    }
    // Far past the cap: an error, not a stack overflow.
    expect(validatePuzzleAttempt(examplePayload({ actions: [nestedAction(50_000, 'array')] })).errors).toEqual([tooDeep]);
  });
});

/**
 * A timed action whose `action` is `levels` containers deep, the action object
 * itself being level 1. Built in a loop: recursion would overflow first.
 */
function nestedAction(levels: number, kind: 'object' | 'array'): PuzzleAttemptSubmission['actions'][number] {
  let inner: unknown = 'leaf';
  for (let level = 1; level < levels; level += 1) inner = kind === 'object' ? { n: inner } : [inner];
  return { t_ms: 1, actor: 'solver', action: { type: 'MANEUVER', nested: inner } };
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('puzzle attempts with postgres', () => {
  let pool: Pool;
  let repo: PgTelemetryRepository;
  let cpRepo: ControlPlaneRepository;
  let server: Server;
  let baseUrl: string;
  const secret = 'test-secret';
  const now = new Date('2026-11-16T12:05:00.000Z');
  const puzzleAttemptBodyLimitBytes = 8 * 1024;

  async function post(payload: unknown, options: { sign?: boolean; headers?: Record<string, string> } = {}): Promise<Response> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
    if (options.sign !== false) {
      const signed = signBody(secret, body, now.toISOString());
      headers['x-unbrewed-timestamp'] = signed.timestamp;
      headers['x-unbrewed-signature'] = signed.signature;
    }
    return fetch(`${baseUrl}/v1/puzzle-attempts`, { method: 'POST', headers, body });
  }

  /** POST a raw, signed body: for JSON too deep for `JSON.stringify` to build. */
  async function postRaw(url: string, body: string): Promise<Response> {
    const signed = signBody(secret, body, now.toISOString());
    return fetch(`${url}/v1/puzzle-attempts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-unbrewed-timestamp': signed.timestamp,
        'x-unbrewed-signature': signed.signature,
      },
      body,
    });
  }

  function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
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
      ...overrides,
    };
  }

  /** Run `use` against a second app on the same database, e.g. one with the stats cache on. */
  async function withApp(overrides: Partial<AppConfig>, use: (url: string) => Promise<void>): Promise<void> {
    const other = createServer(createApp({ repo, cpRepo, config: appConfig(overrides) }));
    await new Promise<void>((resolve) => other.listen(0, resolve));
    try {
      const address = other.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      await use(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => other.close((error) => error ? reject(error) : resolve()));
    }
  }

  const countAttempts = async () =>
    (await pool.query('SELECT count(*)::int AS n FROM puzzle_attempts')).rows[0].n as number;

  let nextAttempt = 0;
  /** Seed one attempt straight through the repository. */
  async function seed(overrides: Partial<PuzzleAttemptSubmission>): Promise<void> {
    nextAttempt += 1;
    const attempt = examplePayload({ attempt_id: `seed-${nextAttempt}`, analytics_id: null, account_id: null, ...overrides });
    expect(validatePuzzleAttempt(attempt)).toEqual({ ok: true, errors: [] });
    await repo.insertPuzzleAttempt({ attempt, receivedAt: now, authKeyId: null });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    repo = new PgTelemetryRepository(pool);
    cpRepo = new ControlPlaneRepository(pool);
    server = createServer(createApp({ repo, cpRepo, config: appConfig({ puzzleAttemptBodyLimitBytes }) }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE puzzle_attempts');
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it('persists the example payload column for column, and dedupes a re-post', async () => {
    const payload = examplePayload();
    const response = await post(payload);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, attemptId: payload.attempt_id, duplicate: false });

    const { rows } = await pool.query('SELECT * FROM puzzle_attempts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      attempt_id: payload.attempt_id,
      received_at: now,
      source: 'server',
      auth_key_id: 'default',
      puzzle_id: 'kong-lethal-01',
      puzzle_version: 1,
      puzzle_type: 'defeat_hero',
      context: 'landing',
      result: 'solved',
      try_number: 2,
      started_at: new Date(payload.started_at),
      ended_at: new Date(payload.ended_at),
      duration_ms: 41250,
      action_count: payload.actions.length,
      actions: payload.actions,
      hint_used: false,
      solution_shown: false,
      analytics_id: payload.analytics_id,
      account_id: null,
      protocol_version: 39,
      content_version: '1.42.0',
      dsl_version: '0.92.0',
    });

    // Same attempt_id again — even with a different body — writes nothing.
    const again = await post({ ...payload, result: 'failed' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, attemptId: payload.attempt_id, duplicate: true });
    expect(await countAttempts()).toBe(1);
    expect((await pool.query('SELECT result FROM puzzle_attempts')).rows[0].result).toBe('solved');
  });

  it('keeps action order and stores null optional engine versions', async () => {
    const actions = Array.from({ length: 30 }, (_, i) => ({
      t_ms: i * 100,
      actor: i % 2 === 0 ? 'solver' as const : 'responder' as const,
      action: { type: 'RESPOND_PROMPT', player: 'p1', promptId: `prompt-${i}`, optionId: `opt-${29 - i}` },
    }));
    const payload = examplePayload({ attempt_id: 'ordered', actions, engine: { protocol_version: 39 } });
    expect((await post(payload)).status).toBe(201);
    const { rows } = await pool.query('SELECT actions, action_count, content_version, dsl_version FROM puzzle_attempts');
    expect(rows[0]).toEqual({ actions, action_count: 30, content_version: null, dsl_version: null });
  });

  it('accepts only an HMAC-signed submission', async () => {
    const payload = examplePayload();
    const unsigned = await post(payload, { sign: false });
    expect(unsigned.status).toBe(401);

    // A named bearer credential — even one that can submit games — does not open this route.
    const source = await cpRepo.createSource(`puzzle-test-${Date.now()}`, null, 'test-admin');
    const key = (await cpRepo.createCredential(source.id, 'games', ['games:submit'], 'test-admin')).fullKey;
    const bearer = await post(payload, { sign: false, headers: { authorization: `Bearer ${key}` } });
    expect(bearer.status).toBe(401);

    const body = JSON.stringify(payload);
    const wrongSecret = signBody('not-the-secret', body, now.toISOString());
    const forged = await post(payload, {
      sign: false,
      headers: { 'x-unbrewed-timestamp': wrongSecret.timestamp, 'x-unbrewed-signature': wrongSecret.signature },
    });
    expect(forged.status).toBe(401);

    const stale = signBody(secret, body, new Date(now.getTime() - 60 * 60 * 1000).toISOString());
    const replayed = await post(payload, {
      sign: false,
      headers: { 'x-unbrewed-timestamp': stale.timestamp, 'x-unbrewed-signature': stale.signature },
    });
    expect(replayed.status).toBe(401);

    expect(await countAttempts()).toBe(0);
  });

  it('answers a browser preflight with no CORS grant', async () => {
    const preflight = await fetch(`${baseUrl}/v1/puzzle-attempts`, {
      method: 'OPTIONS',
      headers: { origin: 'https://unbrewed.xyz', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    const response = await post(examplePayload(), { headers: { origin: 'https://unbrewed.xyz' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a wrong content type, an oversized body, bad JSON and a schema failure', async () => {
    const text = await fetch(`${baseUrl}/v1/puzzle-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'attempt',
    });
    expect(text.status).toBe(415);

    const big = examplePayload({
      actions: Array.from({ length: 200 }, (_, i) => ({
        t_ms: i,
        actor: 'solver' as const,
        action: { type: 'MOVE_FIGHTER', player: 'p1', fighter: 'p1:hero', path: ['s1', 's2', 's3', 's4'] },
      })),
    });
    expect(validatePuzzleAttempt(big).ok).toBe(true);
    expect(JSON.stringify(big).length).toBeGreaterThan(puzzleAttemptBodyLimitBytes);
    const tooLarge = await post(big);
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: 'BODY_TOO_LARGE' });

    const signed = signBody(secret, 'not json', now.toISOString());
    const badJson = await fetch(`${baseUrl}/v1/puzzle-attempts`, {
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

    const invalid = await post({ ...examplePayload(), result: 'won', player_name: 'Steven' });
    expect(invalid.status).toBe(400);
    const body = await invalid.json() as { code: string; errors: string[] };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors).toContain('/: unexpected property player_name');
    expect(body.errors.join('\n')).toContain('/result');

    expect(await countAttempts()).toBe(0);
  });

  it('rejects a solve after the solution was shown, and stores nothing', async () => {
    const response = await post(examplePayload({ result: 'solved', solution_shown: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: ['/result: must not be solved when solution_shown is true'],
    });
    expect(await countAttempts()).toBe(0);

    // The engine's rewrite of the same attempt is accepted.
    expect((await post(examplePayload({ result: 'failed', solution_shown: true }))).status).toBe(201);
  });

  it('answers a deeply nested action with 400, not 500', async () => {
    const tooDeep = `/actions: an action must not nest deeper than ${MAX_ACTION_DEPTH} levels`;
    const bodyNested = (levels: number): string => {
      const marker = '"__nested__"';
      const body = JSON.stringify(examplePayload({
        attempt_id: `deep-${levels}`,
        actions: [{ t_ms: 1, actor: 'solver', action: { type: 'MANEUVER', nested: '__nested__' } }],
      }));
      // The action object is level 1, so `levels - 1` arrays sit inside it.
      return body.replace(marker, `${'['.repeat(levels - 1)}${']'.repeat(levels - 1)}`);
    };

    // At the cap is stored; one level past it is refused.
    expect((await postRaw(baseUrl, bodyNested(MAX_ACTION_DEPTH))).status).toBe(201);
    const justOver = await postRaw(baseUrl, bodyNested(MAX_ACTION_DEPTH + 1));
    expect(justOver.status).toBe(400);
    expect(await justOver.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [tooDeep] });

    // As deep as the production body cap allows: 100 000 levels in ~200 KB.
    await withApp({}, async (url) => {
      const body = bodyNested(100_000);
      expect(Buffer.byteLength(body)).toBeLessThan(256 * 1024);
      const response = await postRaw(url, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [tooDeep] });
    });
    expect(await countAttempts()).toBe(1);
  });

  it('changes no row count in games or any game ingest table', async () => {
    await pool.query('TRUNCATE game_submissions CASCADE');
    await repo.ingestValid({
      payload: sampleGame(),
      idempotencyKey: 'puzzle-isolation-1',
      receivedAt: now,
      authKeyId: null,
      sourceOverride: null,
      sourceId: null,
    });
    const counts = async () => (await pool.query(
      `SELECT (SELECT count(*)::int FROM games) AS games,
              (SELECT count(*)::int FROM game_seats) AS game_seats,
              (SELECT count(*)::int FROM game_teams) AS game_teams,
              (SELECT count(*)::int FROM game_submissions) AS game_submissions,
              (SELECT count(*)::int FROM game_cards) AS game_cards,
              (SELECT count(*)::int FROM game_replays) AS game_replays,
              (SELECT count(*)::int FROM stats_rollup_pending) AS rollup_pending`,
    )).rows[0];
    // Read the dashboard first: that read folds the queued rollup, which is the game's doing.
    const dashboardBefore = await (await fetch(`${baseUrl}/v1/stats/dashboard`)).text();
    const before = await counts();
    expect(before.games).toBe(1);

    expect((await post(examplePayload({ attempt_id: 'iso-solved' }))).status).toBe(201);
    expect((await post(examplePayload({ attempt_id: 'iso-failed', result: 'failed' }))).status).toBe(201);
    expect((await post(examplePayload({ attempt_id: 'iso-abandoned', result: 'abandoned', actions: [] }))).status).toBe(201);

    expect(await countAttempts()).toBe(3);
    expect(await counts()).toEqual(before);
    expect(await (await fetch(`${baseUrl}/v1/stats/dashboard`)).text()).toBe(dashboardBefore);
    await pool.query('TRUNCATE game_submissions CASCADE');
  });

  it('serves an empty aggregate before any attempt', async () => {
    const response = await fetch(`${baseUrl}/v1/stats/puzzles`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, generatedAt: now.toISOString(), puzzles: [] });
  });

  it('aggregates seeded attempts per puzzle', async () => {
    // puzzle-a: four players (two accounts, two guests) plus one anonymous attempt.
    //   acct-1: failed, then solved in 10 s, then solved again in 20 s.
    //   acct-2: failed twice.
    //   guest-1: solved in 40 s.
    //   guest-2: abandoned.
    //   nobody (no ids): solved in 30 s — counts as an attempt, not as a player.
    await seed({ puzzle_id: 'puzzle-a', account_id: 'acct-1', result: 'failed', duration_ms: 5_000 });
    await seed({ puzzle_id: 'puzzle-a', account_id: 'acct-1', result: 'solved', duration_ms: 10_000, try_number: 2 });
    await seed({ puzzle_id: 'puzzle-a', account_id: 'acct-1', result: 'solved', duration_ms: 20_000, try_number: 3 });
    await seed({ puzzle_id: 'puzzle-a', account_id: 'acct-2', result: 'failed', duration_ms: 99_000 });
    await seed({ puzzle_id: 'puzzle-a', account_id: 'acct-2', result: 'failed', duration_ms: 99_000, try_number: 2 });
    await seed({ puzzle_id: 'puzzle-a', analytics_id: 'guest-1', result: 'solved', duration_ms: 40_000 });
    await seed({ puzzle_id: 'puzzle-a', analytics_id: 'guest-2', result: 'abandoned', duration_ms: 1_000, actions: [] });
    await seed({ puzzle_id: 'puzzle-a', result: 'solved', duration_ms: 30_000 });

    // puzzle-b: one player, never solved; only the version 2 attempt is counted.
    await seed({ puzzle_id: 'puzzle-b', analytics_id: 'guest-1', result: 'failed', duration_ms: 7_000 });
    await seed({ puzzle_id: 'puzzle-b', analytics_id: 'guest-1', result: 'abandoned', duration_ms: 3_000, puzzle_version: 2 });

    // puzzle-c: only anonymous attempts; an account id wins over an analytics id on puzzle-d.
    await seed({ puzzle_id: 'puzzle-c', result: 'solved', duration_ms: 12_500 });
    await seed({ puzzle_id: 'puzzle-d', account_id: 'acct-1', analytics_id: 'guest-9', result: 'failed', duration_ms: 1_000 });
    await seed({ puzzle_id: 'puzzle-d', account_id: 'acct-1', analytics_id: 'guest-8', result: 'solved', duration_ms: 3_000 });

    const response = await fetch(`${baseUrl}/v1/stats/puzzles`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      generatedAt: now.toISOString(),
      puzzles: [
        {
          puzzleId: 'puzzle-a',
          puzzleVersion: 1,
          attempts: 8,
          solvedAttempts: 4,
          distinctPlayers: 4,
          distinctSolvers: 2,
          solveRate: 0.5,
          // Solved durations 10, 20, 30, 40 s.
          medianSolveSeconds: 25,
        },
        {
          puzzleId: 'puzzle-b',
          puzzleVersion: 2,
          attempts: 1,
          solvedAttempts: 0,
          distinctPlayers: 1,
          distinctSolvers: 0,
          solveRate: 0,
          medianSolveSeconds: null,
        },
        {
          puzzleId: 'puzzle-c',
          puzzleVersion: 1,
          attempts: 1,
          solvedAttempts: 1,
          distinctPlayers: 0,
          distinctSolvers: 0,
          solveRate: null,
          medianSolveSeconds: 12.5,
        },
        {
          puzzleId: 'puzzle-d',
          puzzleVersion: 1,
          attempts: 2,
          solvedAttempts: 1,
          distinctPlayers: 1,
          distinctSolvers: 1,
          solveRate: 1,
          medianSolveSeconds: 3,
        },
      ],
    });

    // Aggregates only: no attempt, account or analytics id in the response.
    for (const id of ['acct-1', 'acct-2', 'guest-1', 'guest-2', 'guest-8', 'guest-9', 'seed-']) {
      expect(text).not.toContain(id);
    }
  });

  it('aggregates only the latest version of a re-frozen puzzle', async () => {
    // Version 1 was easy: three players, all solved. Version 2 is the re-freeze:
    // two players so far, one solve. Version 1 must not prop up the solve rate.
    for (const account_id of ['acct-1', 'acct-2', 'acct-3']) {
      await seed({ puzzle_id: 'refrozen', puzzle_version: 1, account_id, result: 'solved', duration_ms: 4_000 });
    }
    await seed({ puzzle_id: 'refrozen', puzzle_version: 2, account_id: 'acct-1', result: 'failed', duration_ms: 9_000 });
    await seed({ puzzle_id: 'refrozen', puzzle_version: 2, account_id: 'acct-4', result: 'solved', duration_ms: 30_000 });
    // A straggler still on the old version after the re-freeze changes nothing.
    await seed({ puzzle_id: 'refrozen', puzzle_version: 1, account_id: 'acct-5', result: 'solved', duration_ms: 2_000 });
    // Another puzzle's higher version number is not this puzzle's latest.
    await seed({ puzzle_id: 'steady', puzzle_version: 7, account_id: 'acct-1', result: 'solved', duration_ms: 8_000 });

    const response = await fetch(`${baseUrl}/v1/stats/puzzles`);
    expect(response.status).toBe(200);
    expect((await response.json() as { puzzles: unknown[] }).puzzles).toEqual([
      {
        puzzleId: 'refrozen',
        puzzleVersion: 2,
        attempts: 2,
        solvedAttempts: 1,
        distinctPlayers: 2,
        distinctSolvers: 1,
        solveRate: 0.5,
        medianSolveSeconds: 30,
      },
      {
        puzzleId: 'steady',
        puzzleVersion: 7,
        attempts: 1,
        solvedAttempts: 1,
        distinctPlayers: 1,
        distinctSolvers: 1,
        solveRate: 1,
        medianSolveSeconds: 8,
      },
    ]);
  });

  it('serves the aggregate through the stats cache', async () => {
    await withApp({ statsCacheTtlMs: 60_000 }, async (appUrl) => {
      const url = `${appUrl}/v1/stats/puzzles`;

      await seed({ puzzle_id: 'puzzle-a', analytics_id: 'guest-1', result: 'solved', duration_ms: 10_000 });
      const miss = await fetch(url);
      expect(miss.status).toBe(200);
      expect(miss.headers.get('x-stats-cache')).toBe('miss');
      expect(miss.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
      const etag = miss.headers.get('etag');
      expect(etag).toBeTruthy();
      const first = await miss.json() as { puzzles: Array<{ attempts: number }> };
      expect(first.puzzles[0]!.attempts).toBe(1);

      // A later attempt is not visible until the entry expires.
      await seed({ puzzle_id: 'puzzle-a', analytics_id: 'guest-2', result: 'failed', duration_ms: 10_000 });
      const hit = await fetch(url);
      expect(hit.headers.get('x-stats-cache')).toBe('hit');
      expect(await hit.json()).toEqual(first);

      const notModified = await fetch(url, { headers: { 'if-none-match': etag! } });
      expect(notModified.status).toBe(304);
    });
  });

  it('caches the aggregate under its path alone, whatever the query string', async () => {
    await withApp({ statsCacheTtlMs: 60_000 }, async (appUrl) => {
      const url = `${appUrl}/v1/stats/puzzles`;
      await seed({ puzzle_id: 'puzzle-a', analytics_id: 'guest-1', result: 'solved', duration_ms: 10_000 });

      const first = await fetch(`${url}?x=1`);
      expect(first.status).toBe(200);
      expect(first.headers.get('x-stats-cache')).toBe('miss');
      const body = await first.text();

      // A different throwaway parameter, and none at all, reuse the one entry:
      // the attempt seeded in between is not visible, so the query did not run.
      await seed({ puzzle_id: 'puzzle-a', analytics_id: 'guest-2', result: 'failed', duration_ms: 10_000 });
      for (const query of ['?x=2', '', '?cachebust=3&x=4']) {
        const again = await fetch(`${url}${query}`);
        expect(again.status, query).toBe(200);
        expect(again.headers.get('x-stats-cache'), query).toBe('hit');
        expect(await again.text(), query).toBe(body);
      }
    });
  });
});
