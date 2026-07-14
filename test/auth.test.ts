import { describe, expect, it } from 'vitest';
import { signBody, verifyIngestAuth } from '../src/http/auth.js';

describe('ingest auth', () => {
  it('accepts a valid HMAC signature', () => {
    const body = Buffer.from('{"ok":true}');
    const { timestamp, signature } = signBody('secret', body, '2026-07-14T16:00:00.000Z');
    const result = verifyIngestAuth(
      { 'x-unbrewed-timestamp': timestamp, 'x-unbrewed-signature': signature },
      body,
      { secret: 'secret', allowUnauthenticated: false, toleranceMs: 1000, nowMs: () => Date.parse(timestamp) },
    );
    expect(result).toEqual({ ok: true, authKeyId: 'default' });
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from('{"ok":true}');
    const { timestamp, signature } = signBody('secret', body, '2026-07-14T16:00:00.000Z');
    const result = verifyIngestAuth(
      { 'x-unbrewed-timestamp': timestamp, 'x-unbrewed-signature': signature },
      Buffer.from('{"ok":false}'),
      { secret: 'secret', allowUnauthenticated: false, toleranceMs: 1000, nowMs: () => Date.parse(timestamp) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BAD_SIGNATURE');
  });
});
