import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { validateGameSubmission } from '../ingest/schema.js';
import { validateDeckDefinitions } from '../ingest/deck-schema.js';
import type { PgTelemetryRepository } from '../db/repository.js';
import type { DeckDefinitionSubmission, GameSubmission } from '../types.js';
import { verifyIngestAuth } from './auth.js';
import { serveDashboardAsset } from './static.js';

export interface AppConfig {
  telemetrySecret: string;
  allowUnauthenticatedIngest: boolean;
  bodyLimitBytes: number;
  now: () => Date;
}

export interface AppDeps {
  repo: PgTelemetryRepository;
  config: AppConfig;
}

export function createApp({ repo, config }: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleRequest(req, res, repo, config).catch((error) => {
      console.error('[telemetry] unhandled request error', error);
      sendJson(res, 500, { ok: false, code: 'SERVER_ERROR', message: 'Internal server error' });
    });
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  config: AppConfig,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && await serveDashboardAsset(url.pathname, res)) {
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
    await handleHealth(res, repo);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/games') {
    await handleGameIngest(req, res, repo, config);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/decks') {
    await handleDeckIngest(req, res, repo, config);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/dashboard') {
    await handleDashboardStats(url, res, repo, config);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/decks') {
    await handleDeckStats(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/deck') {
    await handleDeckDetail(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/synergy') {
    await handleSynergyMatchups(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/admin/decks') {
    await handleAdminListDecks(req, res, repo, config);
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/v1/admin/deck') {
    await handleAdminDeleteDeck(req, url, res, repo, config);
    return;
  }

  sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Not found' });
}

async function handleHealth(res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  try {
    await repo.ping();
    sendJson(res, 200, { ok: true, db: true });
  } catch {
    sendJson(res, 200, { ok: true, db: false });
  }
}

async function handleGameIngest(
  req: IncomingMessage,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  config: AppConfig,
): Promise<void> {
  const contentType = req.headers['content-type'];
  if (contentType && !String(contentType).toLowerCase().includes('application/json')) {
    sendJson(res, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' });
    return;
  }

  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) {
    sendJson(res, body.status, { ok: false, code: body.code, message: body.message });
    return;
  }

  const auth = verifyIngestAuth(req.headers, body.body, {
    secret: config.telemetrySecret,
    allowUnauthenticated: config.allowUnauthenticatedIngest,
    toleranceMs: 5 * 60 * 1000,
    nowMs: () => config.now().getTime(),
  });
  if (!auth.ok) {
    sendJson(res, auth.status, { ok: false, code: auth.code, message: auth.message });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Request body is not valid JSON' });
    return;
  }

  const idempotencyKey = idempotencyKeyFor(req, parsed);
  const validation = validateGameSubmission(parsed);
  if (!validation.ok) {
    const result = await repo.ingestInvalid({
      payload: parsed,
      idempotencyKey,
      receivedAt: config.now(),
      authKeyId: auth.authKeyId,
      errors: validation.errors,
    });
    if (result.kind === 'duplicate') {
      sendJson(res, 200, { ok: true, duplicate: true, submissionId: result.submissionId, gameId: result.gameId });
      return;
    }
    sendJson(res, 400, { ok: false, code: 'VALIDATION_FAILED', submissionId: result.submissionId, errors: result.errors });
    return;
  }

  const result = await repo.ingestValid({
    payload: parsed as GameSubmission,
    idempotencyKey,
    receivedAt: config.now(),
    authKeyId: auth.authKeyId,
  });
  if (result.kind === 'duplicate') {
    sendJson(res, 200, { ok: true, duplicate: true, submissionId: result.submissionId, gameId: result.gameId });
    return;
  }
  sendJson(res, 201, { ok: true, duplicate: false, submissionId: result.submissionId, gameId: result.gameId });
}

async function handleDeckIngest(
  req: IncomingMessage,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  config: AppConfig,
): Promise<void> {
  const contentType = req.headers['content-type'];
  if (contentType && !String(contentType).toLowerCase().includes('application/json')) {
    sendJson(res, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' });
    return;
  }

  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) {
    sendJson(res, body.status, { ok: false, code: body.code, message: body.message });
    return;
  }

  const auth = verifyIngestAuth(req.headers, body.body, {
    secret: config.telemetrySecret,
    allowUnauthenticated: config.allowUnauthenticatedIngest,
    toleranceMs: 5 * 60 * 1000,
    nowMs: () => config.now().getTime(),
  });
  if (!auth.ok) {
    sendJson(res, auth.status, { ok: false, code: auth.code, message: auth.message });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Request body is not valid JSON' });
    return;
  }

  const validation = validateDeckDefinitions(parsed);
  if (!validation.ok) {
    sendJson(res, 400, { ok: false, code: 'VALIDATION_FAILED', errors: validation.errors });
    return;
  }

  const result = await repo.upsertDeckDefinitions(parsed as DeckDefinitionSubmission, config.now());
  sendJson(res, 200, { ok: true, upserted: result.upserted });
}

async function handleSynergyMatchups(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const deckA = blankToNull(url.searchParams.get('deckA'));
  const deckB = blankToNull(url.searchParams.get('deckB'));
  if (!deckA || !deckB) {
    sendJson(res, 400, { ok: false, code: 'MISSING_PAIR', message: 'deckA and deckB query parameters are required' });
    return;
  }
  const result = await repo.synergyPairMatchups(deckA, deckB, statsFiltersFromUrl(url));
  sendJson(res, 200, { ok: true, ...result });
}

async function handleDashboardStats(
  url: URL,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  config: AppConfig,
): Promise<void> {
  const filters = statsFiltersFromUrl(url);
  const stats = await repo.dashboardStats(filters, config.now());
  sendJson(res, 200, { ok: true, ...stats });
}

async function handleDeckStats(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const stats = await repo.deckStats(statsFiltersFromUrl(url));
  sendJson(res, 200, { ok: true, ...stats });
}

async function handleDeckDetail(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const deck = blankToNull(url.searchParams.get('deck'));
  if (!deck) {
    sendJson(res, 400, { ok: false, code: 'MISSING_DECK', message: 'deck query parameter is required' });
    return;
  }
  const detail = await repo.deckDetail(deck, statsFiltersFromUrl(url));
  if (!detail.found) {
    sendJson(res, 404, { ok: false, code: 'DECK_NOT_FOUND', message: 'No games for this deck under the current filters' });
    return;
  }
  sendJson(res, 200, { ok: true, ...detail });
}

function statsFiltersFromUrl(url: URL): { format: string | null; pilots: string[] } {
  const format = blankToNull(url.searchParams.get('format'));
  const pilotParam = blankToNull(url.searchParams.get('pilots')) ?? blankToNull(url.searchParams.get('pilot'));
  const pilots = pilotParam ? pilotParam.split(',').map((value) => value.trim()).filter(Boolean) : [];
  return { format, pilots };
}

function idempotencyKeyFor(req: IncomingMessage, parsed: unknown): string {
  const headerKey = header(req, 'idempotency-key') ?? header(req, 'x-idempotency-key');
  if (headerKey) return headerKey;
  if (parsed && typeof parsed === 'object') {
    const candidate = parsed as { idempotencyKey?: unknown; gameId?: unknown; stateHash?: unknown; replayHash?: unknown };
    if (typeof candidate.idempotencyKey === 'string' && candidate.idempotencyKey) return candidate.idempotencyKey;
    if (typeof candidate.gameId === 'string' && candidate.gameId) return candidate.gameId;
    if (typeof candidate.stateHash === 'string' && candidate.stateHash) return `state:${candidate.stateHash}`;
    if (typeof candidate.replayHash === 'string' && candidate.replayHash) return `replay:${candidate.replayHash}`;
  }
  return `generated:${randomUUID()}`;
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'all' ? null : trimmed;
}

type BodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; code: string; message: string };

async function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      return { ok: false, status: 413, code: 'BODY_TOO_LARGE', message: 'Request body is too large' };
    }
    chunks.push(buffer);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

function verifyAdminAuth(req: IncomingMessage, config: AppConfig): boolean {
  if (!config.telemetrySecret) return false;
  const authHeader = header(req, 'authorization');
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return match[1] === config.telemetrySecret;
}

async function handleAdminListDecks(
  req: IncomingMessage,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  config: AppConfig,
): Promise<void> {
  if (!verifyAdminAuth(req, config)) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Invalid admin secret' });
    return;
  }
  const data = await repo.adminListDecks();
  sendJson(res, 200, { ok: true, ...data });
}

async function handleAdminDeleteDeck(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  config: AppConfig,
): Promise<void> {
  if (!verifyAdminAuth(req, config)) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Invalid admin secret' });
    return;
  }
  const deck = blankToNull(url.searchParams.get('deck'));
  if (!deck) {
    sendJson(res, 400, { ok: false, code: 'MISSING_DECK', message: 'deck query parameter is required' });
    return;
  }
  const result = await repo.adminDeleteDeck(deck);
  console.log(`[admin] deleted deck ${deck}: ${result.deletedDefinitions} definitions, ${result.deletedGames} games`);
  sendJson(res, 200, { ok: true, ...result });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
