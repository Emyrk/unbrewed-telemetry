/**
 * Bearer token authentication for named telemetry sources.
 *
 * Credential format: `ubk_<keyId>.<secret>`
 * The keyId is stored in source_credentials.id; the secret is verified
 * against a scrypt hash + salt stored in the same row.
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;  // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELISM = 1; // p

export interface HashedCredential {
  hash: string; // hex
  salt: string; // hex
}

export function hashSecret(secret: string): HashedCredential {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELISM,
  }).toString('hex');
  return { hash, salt };
}

export function verifySecret(secret: string, salt: string, storedHash: string): boolean {
  const derived = scryptSync(secret, salt, SCRYPT_KEYLEN, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELISM,
  });
  const expected = Buffer.from(storedHash, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function generateCredential(keyId: string): { fullKey: string; secret: string } {
  const secret = randomBytes(32).toString('hex');
  return { fullKey: `ubk_${keyId}.${secret}`, secret };
}

export function parseBearer(headers: IncomingHttpHeaders): { keyId: string; secret: string } | null {
  const authHeader = headers['authorization'];
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value) return null;
  const match = value.match(/^Bearer\s+(ubk_[^.]+)\.(.+)$/i);
  if (!match) return null;
  return { keyId: match[1]!, secret: match[2]! };
}

export type Scope = 'games:submit' | 'decks:submit' | 'sim:claim' | 'sim:complete';

export const ALL_SCOPES: Scope[] = ['games:submit', 'decks:submit', 'sim:claim', 'sim:complete'];

export function hasScope(credentialScopes: string[], required: Scope): boolean {
  return credentialScopes.includes(required);
}
