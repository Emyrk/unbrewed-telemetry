import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, createHmac } from 'node:crypto';
import { validateGameSubmission } from '../ingest/schema.js';
import { validateDeckDefinitions } from '../ingest/deck-schema.js';
import type { PgTelemetryRepository } from '../db/repository.js';
import type { ControlPlaneRepository } from '../db/control-plane-repository.js';
import type { DeckDefinitionSubmission, GameSubmission, RecentHourlyResponse } from '../types.js';
import { verifyIngestAuth } from './auth.js';
import { parseBearer, verifySecret, hasScope, type Scope } from './bearer-auth.js';
import { serveDashboardAsset } from './static.js';

const RECENT_HOURLY_CACHE_MS = 5 * 60 * 1000;

interface RecentHourlyCacheEntry {
  expiresAt: number;
  payload?: RecentHourlyResponse;
  pending?: Promise<RecentHourlyResponse>;
}

const recentHourlyCache = new Map<string, RecentHourlyCacheEntry>();

export interface AppConfig {
  telemetrySecret: string;
  allowUnauthenticatedIngest: boolean;
  bodyLimitBytes: number;
  now: () => Date;
  discordClientId: string;
  discordClientSecret: string;
  discordRedirectUri: string;
  adminDiscordIds: string[];
  secureCookies: boolean;
}

export interface AppDeps {
  repo: PgTelemetryRepository;
  cpRepo: ControlPlaneRepository;
  config: AppConfig;
}

/** Authenticated bearer credential context resolved from the request. */
interface BearerContext {
  credentialId: string;
  sourceId: string;
  sourceName: string;
  scopes: string[];
}

export function createApp({ repo, cpRepo, config }: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleRequest(req, res, repo, cpRepo, config).catch((error) => {
      console.error('[telemetry] unhandled request error', error);
      sendJson(res, 500, { ok: false, code: 'SERVER_ERROR', message: 'Internal server error' });
    });
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  cpRepo: ControlPlaneRepository,
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
    await handleGameIngest(req, res, repo, config, cpRepo);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/decks') {
    await handleDeckIngest(req, res, repo, config, cpRepo);
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

  if (req.method === 'GET' && url.pathname === '/v1/stats/bot-execution') {
    await handleBotExecutionStats(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/pilot-comparison') {
    await handlePilotComparison(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/scenario') {
    await handleScenarioExplorer(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/sources') {
    await handleSourceStats(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/recent/hourly') {
    await handleRecentHourly(url, res, repo, config);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/stats/recent') {
    await handleRecentGames(url, res, repo);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/admin/decks') {
    await handleAdminListDecks(req, res, repo, cpRepo, config);
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/v1/admin/deck') {
    await handleAdminDeleteDeck(req, url, res, repo, cpRepo, config);
    return;
  }

  // ---- Discord OAuth ----
  if (req.method === 'GET' && url.pathname === '/auth/discord') {
    handleDiscordLogin(res, config);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/discord/callback') {
    await handleDiscordCallback(req, url, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    await handleLogout(req, res, cpRepo);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/admin/me') {
    await handleAdminMe(req, res, cpRepo, config);
    return;
  }

  // ---- Source & credential management ----
  if (req.method === 'GET' && url.pathname === '/v1/admin/sources') {
    await handleAdminListSources(req, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/admin/sources') {
    await handleAdminCreateSource(req, res, cpRepo, config);
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/v1/admin/sources') {
    await handleAdminDeleteSource(req, url, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/admin/credentials') {
    await handleAdminCreateCredential(req, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/admin/credentials/revoke') {
    await handleAdminRevokeCredential(req, res, cpRepo, config);
    return;
  }

  // ---- Simulation campaigns ----
  if (req.method === 'GET' && url.pathname === '/v1/admin/campaigns') {
    await handleAdminListCampaigns(req, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/admin/campaigns') {
    await handleAdminCreateCampaign(req, res, cpRepo, config);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/admin/campaign') {
    await handleAdminGetCampaign(req, url, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/admin/campaign/cancel') {
    await handleAdminCancelCampaign(req, res, cpRepo, config);
    return;
  }

  // ---- Public "Road to Expert+" journey (NO AUTH — experiment aggregates only) ----
  if (req.method === 'GET' && url.pathname === '/v1/sim/public/journey') {
    await handleSimJourney(url, res, cpRepo, config);
    return;
  }

  // ---- Runner sim endpoints (bearer auth) ----
  // Campaign win-rate view for the #248 ISMCTS road-to-expert report.
  if (req.method === 'GET' && url.pathname.startsWith('/v1/sim/campaigns/') && url.pathname.endsWith('/progress')) {
    await handleSimCampaignProgress(req, res, url, cpRepo);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/sim/claim') {
    await handleSimClaim(req, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/sim/heartbeat') {
    await handleSimHeartbeat(req, res, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/sim/complete') {
    await handleSimComplete(req, res, repo, cpRepo, config);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/sim/fail') {
    await handleSimFail(req, res, cpRepo, config);
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
  cpRepo?: ControlPlaneRepository,
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

  // Try bearer auth first, then fall back to HMAC
  let authKeyId: string | null = null;
  let sourceOverride: string | null = null;
  let sourceId: string | null = null;

  const bearerCtx = cpRepo ? await verifyBearerAuth(req, cpRepo, 'games:submit') : null;
  if (bearerCtx) {
    authKeyId = bearerCtx.credentialId;
    sourceOverride = bearerCtx.sourceName;
    sourceId = bearerCtx.sourceId;
  } else if (bearerCtx === undefined) {
    // bearer was present but invalid/revoked/missing scope
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Invalid or revoked API key, or missing games:submit scope' });
    return;
  } else {
    // No bearer token found — fall back to HMAC
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
    authKeyId = auth.authKeyId;
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
      authKeyId,
      errors: validation.errors,
      sourceOverride,
      sourceId,
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
    authKeyId,
    sourceOverride,
    sourceId,
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
  cpRepo: ControlPlaneRepository,
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

  let sourceOverride: string | null = null;
  const bearerCtx = await verifyBearerAuth(req, cpRepo, 'decks:submit');
  if (bearerCtx) {
    sourceOverride = bearerCtx.sourceName;
  } else if (bearerCtx === undefined) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Invalid or revoked API key, or missing decks:submit scope' });
    return;
  } else {
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

  const result = await repo.upsertDeckDefinitions(parsed as DeckDefinitionSubmission, config.now(), sourceOverride);
  sendJson(res, 200, { ok: true, upserted: result.upserted });
}

async function handleBotExecutionStats(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const pilot = url.searchParams.get('pilot')?.trim() || null;
  const deck = url.searchParams.get('deck')?.trim() || null;
  const result = await repo.botExecutionStats({ pilot, deck });
  sendJson(res, 200, { ok: true, ...result });
}

async function handlePilotComparison(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const pilotA = blankToNull(url.searchParams.get('pilotA'));
  const pilotB = blankToNull(url.searchParams.get('pilotB'));
  const opponentPilot = blankToNull(url.searchParams.get('opponentPilot'));
  if (!pilotA || !pilotB || !opponentPilot) {
    sendJson(res, 400, {
      ok: false,
      code: 'MISSING_PILOTS',
      message: 'pilotA, pilotB, and opponentPilot query parameters are required',
    });
    return;
  }
  if (pilotA === pilotB) {
    sendJson(res, 400, { ok: false, code: 'SAME_PILOT', message: 'pilotA and pilotB must be different' });
    return;
  }
  const result = await repo.pilotComparison({
    pilotA,
    pilotB,
    hero: blankToNull(url.searchParams.get('hero')),
    opponentPilot,
    opponent: blankToNull(url.searchParams.get('opponent')),
  });
  sendJson(res, 200, { ok: true, ...result });
}

async function handleScenarioExplorer(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const filters = statsFiltersFromUrl(url);
  const result = await repo.scenarioExplorer({
    format: filters.format,
    map: blankToNull(url.searchParams.get('map')),
    deck: blankToNull(url.searchParams.get('deck')),
    partner: blankToNull(url.searchParams.get('partner')),
    enemyA: blankToNull(url.searchParams.get('enemyA')),
    enemyB: blankToNull(url.searchParams.get('enemyB')),
    pilots: filters.pilots,
  });
  sendJson(res, 200, { ok: true, ...result });
}

async function handleSourceStats(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const result = await repo.sourceStats(statsFiltersFromUrl(url));
  sendJson(res, 200, { ok: true, ...result });
}

async function handleRecentHourly(
  url: URL,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  config: AppConfig,
): Promise<void> {
  const filters = statsFiltersFromUrl(url);
  const key = recentHourlyCacheKey(filters.format, filters.pilots);
  const nowMs = config.now().getTime();
  const cached = recentHourlyCache.get(key);
  if (cached?.payload && cached.expiresAt > nowMs) {
    sendJson(res, 200, { ok: true, ...cached.payload }, cacheHeaders(RECENT_HOURLY_CACHE_MS));
    return;
  }

  const pending = cached?.pending ?? repo.recentHourlyGames(filters, config.now());
  recentHourlyCache.set(key, { expiresAt: nowMs + RECENT_HOURLY_CACHE_MS, pending });
  try {
    const payload = await pending;
    recentHourlyCache.set(key, { expiresAt: nowMs + RECENT_HOURLY_CACHE_MS, payload });
    sendJson(res, 200, { ok: true, ...payload }, cacheHeaders(RECENT_HOURLY_CACHE_MS));
  } catch (error) {
    if (recentHourlyCache.get(key)?.pending === pending) recentHourlyCache.delete(key);
    throw error;
  }
}

async function handleRecentGames(url: URL, res: ServerResponse, repo: PgTelemetryRepository): Promise<void> {
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
  const result = await repo.recentGames(statsFiltersFromUrl(url), limit);
  sendJson(res, 200, { ok: true, ...result });
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

function statsFiltersFromUrl(url: URL): {
  format: string | null;
  pilots: string[];
  opponent: string | null;
  partner: string | null;
  heroPilot: string | null;
  opponentPilot: string | null;
} {
  const format = blankToNull(url.searchParams.get('format'));
  const pilotParam = blankToNull(url.searchParams.get('pilots')) ?? blankToNull(url.searchParams.get('pilot'));
  const pilots = pilotParam ? pilotParam.split(',').map((value) => value.trim()).filter(Boolean) : [];
  return {
    format,
    pilots,
    opponent: blankToNull(url.searchParams.get('opponent')),
    partner: blankToNull(url.searchParams.get('partner')),
    heroPilot: blankToNull(url.searchParams.get('heroPilot')),
    opponentPilot: blankToNull(url.searchParams.get('opponentPilot')),
  };
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

function simulationIdempotencyKeyFor(
  req: IncomingMessage,
  payload: GameSubmission,
  campaignId: string,
  gameIndex: number,
): string {
  const headerKey = header(req, 'idempotency-key') ?? header(req, 'x-idempotency-key');
  if (headerKey) return headerKey;
  if (payload.idempotencyKey) return payload.idempotencyKey;
  if (payload.gameId) return payload.gameId;
  if (payload.stateHash) return `state:${payload.stateHash}`;
  if (payload.replayHash) return `replay:${payload.replayHash}`;
  return `sim:${campaignId}:${gameIndex}`;
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

function recentHourlyCacheKey(format: string | null, pilots: string[]): string {
  return JSON.stringify({ format, pilots: [...pilots].sort() });
}

function cacheHeaders(ttlMs: number): Record<string, string> {
  return {
    'cache-control': `public, max-age=${Math.floor(ttlMs / 1000)}, stale-while-revalidate=${Math.floor(ttlMs / 1000)}`,
  };
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

/** Session-based admin auth from Discord OAuth. Returns discord username or null. */
async function verifySessionAuth(
  req: IncomingMessage,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<{ discordId: string; discordUsername: string } | null> {
  const sessionId = parseCookie(req, 'session');
  if (!sessionId) return null;
  const session = await cpRepo.getSession(sessionId);
  if (!session) return null;
  if (!config.adminDiscordIds.includes(session.discordId)) return null;
  return { discordId: session.discordId, discordUsername: session.discordUsername };
}

/** Discord session-based admin authentication. */
async function verifyAdminAuth(
  req: IncomingMessage,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<string | null> {
  const session = await verifySessionAuth(req, cpRepo, config);
  return session?.discordUsername ?? null;
}

/**
 * Verify a bearer API key. Returns BearerContext if valid with required scope,
 * undefined if bearer was present but invalid/revoked/wrong scope,
 * null if no bearer token was present at all.
 */
async function verifyBearerAuth(
  req: IncomingMessage,
  cpRepo: ControlPlaneRepository,
  requiredScope: Scope,
): Promise<BearerContext | null | undefined> {
  const parsed = parseBearer(req.headers);
  if (!parsed) return null;
  const cred = await cpRepo.lookupCredential(parsed.keyId);
  if (!cred) return undefined;
  if (cred.revoked_at) return undefined;
  if (!verifySecret(parsed.secret, cred.salt, cred.hash)) return undefined;
  if (!hasScope(cred.scopes, requiredScope)) return undefined;
  // Touch last_used_at in background (fire-and-forget)
  void cpRepo.touchCredentialLastUsed(cred.id).catch(() => {});
  return {
    credentialId: cred.id,
    sourceId: cred.source_id,
    sourceName: cred.source_name,
    scopes: cred.scopes,
  };
}

async function handleAdminListDecks(
  req: IncomingMessage,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' });
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
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' });
    return;
  }
  const deck = blankToNull(url.searchParams.get('deck'));
  if (!deck) {
    sendJson(res, 400, { ok: false, code: 'MISSING_DECK', message: 'deck query parameter is required' });
    return;
  }
  const result = await repo.adminDeleteDeck(deck);
  console.log(`[admin] ${admin} deleted deck ${deck}: ${result.deletedDefinitions} definitions, ${result.deletedGames} games`);
  sendJson(res, 200, { ok: true, ...result });
}

// ============================================================================
// Discord OAuth handlers
// ============================================================================

function handleDiscordLogin(res: ServerResponse, config: AppConfig): void {
  if (!config.discordClientId || !config.discordRedirectUri) {
    sendJson(res, 503, { ok: false, code: 'OAUTH_NOT_CONFIGURED', message: 'Discord OAuth is not configured' });
    return;
  }
  const state = randomUUID();
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: config.discordRedirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  const cookieOpts = cookieOptions(config, 300); // 5 min
  res.writeHead(302, {
    location: `https://discord.com/api/oauth2/authorize?${params.toString()}`,
    'set-cookie': `oauth_state=${state}; ${cookieOpts}; Path=/auth`,
  });
  res.end();
}

async function handleDiscordCallback(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const storedState = parseCookie(req, 'oauth_state');

  if (!code || !state || !storedState || state !== storedState) {
    sendJson(res, 400, { ok: false, code: 'INVALID_STATE', message: 'OAuth state mismatch' });
    return;
  }

  // Exchange code for token
  let tokenData: { access_token?: string };
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.discordRedirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Discord token exchange returned ${tokenRes.status}`);
    tokenData = await tokenRes.json() as { access_token?: string };
  } catch {
    sendJson(res, 502, { ok: false, code: 'DISCORD_ERROR', message: 'Failed to exchange code with Discord' });
    return;
  }

  if (!tokenData.access_token) {
    sendJson(res, 401, { ok: false, code: 'DISCORD_ERROR', message: 'Failed to obtain access token' });
    return;
  }

  // Fetch user identity
  let user: { id?: string; username?: string };
  try {
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) throw new Error(`Discord user lookup returned ${userRes.status}`);
    user = await userRes.json() as { id?: string; username?: string };
  } catch {
    sendJson(res, 502, { ok: false, code: 'DISCORD_ERROR', message: 'Failed to fetch Discord user info' });
    return;
  }

  if (!user.id || !user.username) {
    sendJson(res, 401, { ok: false, code: 'DISCORD_ERROR', message: 'Discord did not return valid user info' });
    return;
  }

  // Check allowlist
  if (!config.adminDiscordIds.includes(user.id)) {
    sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: 'Your Discord account is not in the admin allowlist' });
    return;
  }

  // Create session
  const session = await cpRepo.createSession({
    discordId: user.id,
    discordUsername: user.username,
  });

  const cookieOpts = cookieOptions(config, 7 * 24 * 3600);
  const clearState = `oauth_state=; ${cookieOptions(config, 0)}; Path=/auth`;
  res.writeHead(302, {
    location: '/admin',
    'set-cookie': [
      `session=${session.id}; ${cookieOpts}; Path=/`,
      clearState,
    ],
  });
  res.end();
}

async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
): Promise<void> {
  const sessionId = parseCookie(req, 'session');
  if (sessionId) {
    await cpRepo.deleteSession(sessionId);
  }
  res.writeHead(200, {
    'content-type': 'application/json',
    'set-cookie': `session=; Max-Age=0; Path=/`,
  });
  res.end(JSON.stringify({ ok: true }));
}

async function handleAdminMe(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const session = await verifySessionAuth(req, cpRepo, config);
  if (!session) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Not authenticated' });
    return;
  }
  sendJson(res, 200, { ok: true, ...session });
}

// ============================================================================
// Source & credential admin handlers
// ============================================================================

async function handleAdminListSources(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const sources = await cpRepo.listSources();
  sendJson(res, 200, { ok: true, sources });
}

async function handleAdminCreateSource(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { name?: string; description?: string };
  try { data = JSON.parse(body.body.toString('utf8')) as { name?: string; description?: string }; }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  if (!data.name || typeof data.name !== 'string') {
    sendJson(res, 400, { ok: false, code: 'MISSING_NAME', message: 'name is required' }); return;
  }
  try {
    const source = await cpRepo.createSource(data.name, data.description ?? null, admin);
    sendJson(res, 201, { ok: true, source });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('duplicate key')) {
      sendJson(res, 409, { ok: false, code: 'DUPLICATE_NAME', message: 'Source name already exists' });
    } else throw error;
  }
}

async function handleAdminDeleteSource(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const id = url.searchParams.get('id');
  if (!id) { sendJson(res, 400, { ok: false, code: 'MISSING_ID', message: 'id query parameter is required' }); return; }
  const deleted = await cpRepo.deleteSource(id);
  sendJson(res, deleted ? 200 : 404, { ok: deleted });
}

async function handleAdminCreateCredential(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { sourceId?: string; label?: string; scopes?: string[] };
  try { data = JSON.parse(body.body.toString('utf8')) as { sourceId?: string; label?: string; scopes?: string[] }; }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  if (!data.sourceId || !data.label) {
    sendJson(res, 400, { ok: false, code: 'MISSING_FIELDS', message: 'sourceId and label are required' }); return;
  }
  const validScopes = ['games:submit', 'decks:submit', 'sim:claim', 'sim:complete'] as const;
  const scopes = (data.scopes ?? []).filter(s => (validScopes as readonly string[]).includes(s)) as Scope[];
  const result = await cpRepo.createCredential(data.sourceId, data.label, scopes, admin);
  sendJson(res, 201, { ok: true, credential: result });
}

async function handleAdminRevokeCredential(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { credentialId?: string };
  try { data = JSON.parse(body.body.toString('utf8')) as { credentialId?: string }; }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  if (!data.credentialId) {
    sendJson(res, 400, { ok: false, code: 'MISSING_ID', message: 'credentialId is required' }); return;
  }
  const revoked = await cpRepo.revokeCredential(data.credentialId);
  sendJson(res, revoked ? 200 : 404, { ok: revoked });
}

// ============================================================================
// Campaign admin handlers
// ============================================================================

async function handleAdminListCampaigns(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const campaigns = await cpRepo.listCampaigns();
  sendJson(res, 200, { ok: true, campaigns });
}

async function handleAdminCreateCampaign(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: {
    name?: string;
    description?: string;
    spec?: unknown;
    baseSeed?: string | number;
    contentVersion?: string;
    gameCount?: number;
    games?: unknown[];
  };
  try { data = JSON.parse(body.body.toString('utf8')); }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  const gameCount = data.gameCount;
  const hasCount = Number.isInteger(gameCount) && (gameCount ?? 0) > 0 && (gameCount ?? 0) <= 100_000;
  const hasGames = Array.isArray(data.games) && data.games.length > 0 && data.games.length <= 100_000;
  if (!data.name || data.spec === undefined || (!hasCount && !hasGames)) {
    sendJson(res, 400, {
      ok: false,
      code: 'INVALID_CAMPAIGN',
      message: 'name, spec, and either gameCount (1-100000) or a non-empty games array are required',
    });
    return;
  }
  const games = hasGames
    ? data.games!.map(g => ({ spec: (g && typeof g === 'object' && 'spec' in g) ? (g as { spec: unknown }).spec : undefined }))
    : Array.from({ length: gameCount! }, () => ({}));
  try {
    const campaign = await cpRepo.createCampaign({
      name: data.name,
      description: data.description,
      spec: data.spec,
      baseSeed: data.baseSeed,
      contentVersion: data.contentVersion,
      games,
      createdBy: admin,
    });
    sendJson(res, 201, { ok: true, campaign });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('baseSeed')) {
      sendJson(res, 400, { ok: false, code: 'INVALID_BASE_SEED', message: error.message });
      return;
    }
    if (error instanceof Error && error.message.startsWith('campaign spec:')) {
      sendJson(res, 400, { ok: false, code: 'INVALID_CAMPAIGN_SPEC', message: error.message });
      return;
    }
    throw error;
  }
}

async function handleAdminGetCampaign(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const id = url.searchParams.get('id');
  if (!id) { sendJson(res, 400, { ok: false, code: 'MISSING_ID', message: 'id query parameter required' }); return; }
  const campaign = await cpRepo.getCampaign(id);
  if (!campaign) { sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Campaign not found' }); return; }
  sendJson(res, 200, { ok: true, campaign });
}

async function handleAdminCancelCampaign(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const admin = await verifyAdminAuth(req, cpRepo, config);
  if (!admin) { sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Admin authentication required' }); return; }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { campaignId?: string };
  try { data = JSON.parse(body.body.toString('utf8')) as { campaignId?: string }; }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  if (!data.campaignId) {
    sendJson(res, 400, { ok: false, code: 'MISSING_ID', message: 'campaignId is required' }); return;
  }
  const cancelled = await cpRepo.cancelCampaign(data.campaignId);
  sendJson(res, cancelled ? 200 : 404, { ok: cancelled });
}

// ============================================================================
// Runner simulation endpoints (bearer auth)
// ============================================================================

/** The mission's campaign ladder, in order. Override with ?campaigns=a,b,c. */
const DEFAULT_JOURNEY_STEPS = ['grid', 'arm1', 'arm2', 'arm3', 'arm5', 'mirror', 'cost'];

async function handleSimJourney(
  url: URL,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const raw = url.searchParams.get('campaigns');
  const names = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_JOURNEY_STEPS;
  const journey = await cpRepo.journey(names.slice(0, 32), config.now().getTime());
  sendJson(res, 200, journey);
}

async function handleSimCampaignProgress(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  cpRepo: ControlPlaneRepository,
): Promise<void> {
  // Any valid runner credential may read (all hosts + the dashboard share a run).
  const bearerCtx = await verifyBearerAuth(req, cpRepo, 'sim:claim');
  if (!bearerCtx) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Valid API key with sim:claim scope required' });
    return;
  }
  // /v1/sim/campaigns/<id>/progress
  const parts = url.pathname.split('/');
  const campaignId = decodeURIComponent(parts[4] ?? '');
  if (!campaignId) {
    sendJson(res, 400, { ok: false, code: 'MISSING_CAMPAIGN', message: 'campaign id is required' });
    return;
  }
  const progress = await cpRepo.campaignProgress(campaignId);
  if (!progress) {
    sendJson(res, 404, { ok: false, code: 'CAMPAIGN_NOT_FOUND', message: 'No such campaign' });
    return;
  }
  sendJson(res, 200, { ok: true, ...progress });
}

async function handleSimClaim(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const bearerCtx = await verifyBearerAuth(req, cpRepo, 'sim:claim');
  if (bearerCtx === null || bearerCtx === undefined) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Valid API key with sim:claim scope required' }); return;
  }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { campaignId?: string; count?: number; leaseDurationMs?: number };
  try { data = JSON.parse(body.body.toString('utf8')) as { campaignId?: string; count?: number; leaseDurationMs?: number }; }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  const requestedCount = Number.isFinite(data.count) ? Math.trunc(data.count!) : 10;
  const count = Math.min(Math.max(requestedCount, 1), 100);
  const requestedDuration = Number.isFinite(data.leaseDurationMs) ? Math.trunc(data.leaseDurationMs!) : 5 * 60 * 1000;
  const leaseDurationMs = Math.min(Math.max(requestedDuration, 10_000), 60 * 60 * 1000);
  const jobs = await cpRepo.claimJobs(data.campaignId ?? null, count, bearerCtx.credentialId, leaseDurationMs);
  sendJson(res, 200, { ok: true, jobs });
}

async function handleSimHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const bearerCtx = await verifyBearerAuth(req, cpRepo, 'sim:claim');
  if (!bearerCtx) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Valid API key with sim:claim scope required' });
    return;
  }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { jobId?: string; leaseToken?: string; leaseDurationMs?: number };
  try { data = JSON.parse(body.body.toString('utf8')) as { jobId?: string; leaseToken?: string; leaseDurationMs?: number }; }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  if (!data.jobId || !data.leaseToken) {
    sendJson(res, 400, { ok: false, code: 'MISSING_FIELDS', message: 'jobId and leaseToken are required' });
    return;
  }
  const requestedDuration = Number.isFinite(data.leaseDurationMs) ? Math.trunc(data.leaseDurationMs!) : 5 * 60 * 1000;
  const leaseDurationMs = Math.min(Math.max(requestedDuration, 10_000), 60 * 60 * 1000);
  const expiresAt = await cpRepo.renewLease(
    data.jobId,
    data.leaseToken,
    bearerCtx.credentialId,
    leaseDurationMs,
  );
  if (!expiresAt) {
    sendJson(res, 409, { ok: false, code: 'INVALID_LEASE', message: 'Lease is missing, expired, or owned by another credential' });
    return;
  }
  sendJson(res, 200, { ok: true, leaseExpiresAt: expiresAt.toISOString() });
}

async function handleSimComplete(
  req: IncomingMessage,
  res: ServerResponse,
  repo: PgTelemetryRepository,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const bearerCtx = await verifyBearerAuth(req, cpRepo, 'sim:complete');
  if (bearerCtx === null || bearerCtx === undefined) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Valid API key with sim:complete scope required' }); return;
  }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { jobId?: string; leaseToken?: string; game?: unknown };
  try { data = JSON.parse(body.body.toString('utf8')); }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  if (!data.jobId || !data.leaseToken || !data.game) {
    sendJson(res, 400, { ok: false, code: 'MISSING_FIELDS', message: 'jobId, leaseToken, and game are required' }); return;
  }

  // Validate game payload
  const validation = validateGameSubmission(data.game);
  if (!validation.ok) {
    sendJson(res, 400, { ok: false, code: 'VALIDATION_FAILED', errors: validation.errors }); return;
  }

  const gamePayload = data.game as GameSubmission;
  const completed = await cpRepo.completeJobWith(data.jobId, data.leaseToken, async (client, provenance) => {
    const idempotencyKey = simulationIdempotencyKeyFor(req, gamePayload, provenance.campaignId, provenance.gameIndex);
    return repo.ingestValidWithClient(client, {
      payload: gamePayload,
      idempotencyKey,
      receivedAt: config.now(),
      authKeyId: bearerCtx.credentialId,
      sourceOverride: bearerCtx.sourceName,
      sourceId: bearerCtx.sourceId,
      campaignId: provenance.campaignId,
      campaignGameIndex: provenance.gameIndex,
    });
  }, bearerCtx.credentialId);
  if (!completed) {
    sendJson(res, 409, { ok: false, code: 'INVALID_JOB', message: 'Job not found, not leased, or lease token mismatch' }); return;
  }

  sendJson(res, completed.result.kind === 'created' ? 201 : 200, {
    ok: true,
    ...completed.result,
    campaignId: completed.provenance.campaignId,
    gameIndex: completed.provenance.gameIndex,
  });
}

async function handleSimFail(
  req: IncomingMessage,
  res: ServerResponse,
  cpRepo: ControlPlaneRepository,
  config: AppConfig,
): Promise<void> {
  const bearerCtx = await verifyBearerAuth(req, cpRepo, 'sim:claim');
  if (bearerCtx === null || bearerCtx === undefined) {
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Valid API key with sim:claim scope required' }); return;
  }
  const body = await readBody(req, config.bodyLimitBytes);
  if (!body.ok) { sendJson(res, body.status, { ok: false, code: body.code, message: body.message }); return; }
  let data: { jobId?: string; leaseToken?: string; error?: string };
  try { data = JSON.parse(body.body.toString('utf8')) as { jobId?: string; leaseToken?: string; error?: string }; }
  catch { sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: 'Invalid JSON' }); return; }
  if (!data.jobId || !data.leaseToken) {
    sendJson(res, 400, { ok: false, code: 'MISSING_FIELDS', message: 'jobId and leaseToken are required' }); return;
  }
  const ok = await cpRepo.failJob(data.jobId, data.leaseToken, data.error ?? 'unknown error', bearerCtx.credentialId);
  sendJson(res, ok ? 200 : 409, { ok });
}

// ============================================================================
// Cookie helpers
// ============================================================================

function parseCookie(req: IncomingMessage, name: string): string | null {
  const cookieHeader = req.headers['cookie'];
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

function cookieOptions(config: AppConfig, maxAge: number): string {
  const parts = [`Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}
