/**
 * Auth for the accounts read API (#52).
 *
 * A deliberately THIRD credential, distinct from both existing schemes:
 *
 * - `ubk_` bearer credentials (`bearer-auth.ts`) carry write scopes and are
 *   handed to sim workers; they are numerous and long-lived.
 * - HMAC (`auth.ts`) is the legacy game-submission path.
 * - This one is a single shared secret held by exactly one consumer, the
 *   unbrewed accounts service, and it can only read.
 *
 * Keeping it separate means the read surface has its own blast radius and can
 * be rotated without touching a single worker or producer. It is never exposed
 * to browsers: unbrewed-api proxies it server-side.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type AccountsAuthResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/** Extract the raw token from `Authorization: Bearer <token>`. */
function bearerToken(headers: IncomingHttpHeaders): string | null {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  return token === '' ? null : token;
}

/**
 * Constant-time equality that does not leak length through an early return.
 * `timingSafeEqual` throws on a length mismatch, so hash-free comparison needs
 * the lengths equalised first; comparing the padded buffers *and* the lengths
 * keeps the whole check branch-free with respect to the secret.
 */
function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const width = Math.max(a.length, b.length);
  const padded = (buf: Buffer): Buffer => Buffer.concat([buf], width);
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length;
}

export function verifyAccountsReadAuth(headers: IncomingHttpHeaders, configuredToken: string): AccountsAuthResult {
  if (!configuredToken) {
    // Never fail open. 503 rather than 401 so an operator who forgot the env
    // var sees a configuration problem instead of chasing a bad token.
    return {
      ok: false,
      status: 503,
      code: 'AUTH_NOT_CONFIGURED',
      message: 'Accounts read API is not configured (ACCOUNTS_READ_TOKEN unset)',
    };
  }
  const token = bearerToken(headers);
  if (!token) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Missing accounts read bearer token' };
  }
  if (!safeEqual(token, configuredToken)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid accounts read bearer token' };
  }
  return { ok: true };
}
