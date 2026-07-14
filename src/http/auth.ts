import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface AuthConfig {
  secret: string;
  allowUnauthenticated: boolean;
  toleranceMs: number;
  nowMs: () => number;
}

export type AuthResult =
  | { ok: true; authKeyId: string | null }
  | { ok: false; status: number; code: string; message: string };

export function signBody(secret: string, body: string | Buffer, timestamp: string = new Date().toISOString()): {
  timestamp: string;
  signature: string;
} {
  const signature = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest('hex');
  return { timestamp, signature: `sha256=${signature}` };
}

export function verifyIngestAuth(headers: IncomingHttpHeaders, body: Buffer, config: AuthConfig): AuthResult {
  if (!config.secret) {
    if (config.allowUnauthenticated) return { ok: true, authKeyId: null };
    return { ok: false, status: 503, code: 'AUTH_NOT_CONFIGURED', message: 'Telemetry ingest auth is not configured' };
  }

  const timestamp = header(headers, 'x-unbrewed-timestamp');
  const signature = header(headers, 'x-unbrewed-signature');
  if (!timestamp || !signature) {
    return { ok: false, status: 401, code: 'MISSING_SIGNATURE', message: 'Missing telemetry signature headers' };
  }

  const parsedTimestamp = parseTimestampMs(timestamp);
  if (parsedTimestamp === null) {
    return { ok: false, status: 401, code: 'BAD_TIMESTAMP', message: 'Invalid telemetry timestamp' };
  }
  if (Math.abs(config.nowMs() - parsedTimestamp) > config.toleranceMs) {
    return { ok: false, status: 401, code: 'STALE_TIMESTAMP', message: 'Telemetry timestamp is outside the allowed window' };
  }

  const expected = signBody(config.secret, body, timestamp).signature;
  if (!safeEqualSignature(signature, expected)) {
    return { ok: false, status: 401, code: 'BAD_SIGNATURE', message: 'Invalid telemetry signature' };
  }

  return { ok: true, authKeyId: 'default' };
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseTimestampMs(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function signatureBytes(value: string): Buffer | null {
  const hex = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

function safeEqualSignature(actual: string, expected: string): boolean {
  const actualBytes = signatureBytes(actual);
  const expectedBytes = signatureBytes(expected);
  if (!actualBytes || !expectedBytes) return false;
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
