import { describe, expect, it } from 'vitest';
import { StatsCache, etagMatches, statsCacheKey } from '../src/http/stats-cache.js';

function clock(start = 0) {
  let now = start;
  return { nowMs: () => now, advance: (ms: number) => { now += ms; } };
}

function counter(payload: unknown = { ok: true }, status = 200) {
  let calls = 0;
  return {
    get calls() { return calls; },
    load: async () => { calls += 1; return { status, payload }; },
  };
}

describe('StatsCache', () => {
  it('misses, then hits within the TTL, then misses again after expiry', async () => {
    const time = clock();
    const cache = new StatsCache({ ttlMs: 60_000, maxEntries: 10, nowMs: time.nowMs });
    const loader = counter({ ok: true, n: 1 });

    const first = await cache.get('k', loader.load);
    expect(first.hit).toBe(false);
    expect(JSON.parse(first.response.body)).toEqual({ ok: true, n: 1 });
    expect(first.response.etag).toMatch(/^W\/".+"$/);

    time.advance(59_999);
    const second = await cache.get('k', loader.load);
    expect(second.hit).toBe(true);
    expect(second.response).toBe(first.response);
    expect(loader.calls).toBe(1);

    time.advance(1);
    const third = await cache.get('k', loader.load);
    expect(third.hit).toBe(false);
    expect(loader.calls).toBe(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = new StatsCache({ ttlMs: 60_000, maxEntries: 10, nowMs: () => 0 });
    let release!: () => void;
    let calls = 0;
    const load = () => {
      calls += 1;
      return new Promise<{ status: number; payload: unknown }>((resolve) => {
        release = () => resolve({ status: 200, payload: { ok: true } });
      });
    };
    const a = cache.get('k', load);
    const b = cache.get('k', load);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra.hit).toBe(false);
    expect(rb.hit).toBe(true);
    expect(rb.response).toBe(ra.response);
  });

  it('does not cache a rejected load', async () => {
    const cache = new StatsCache({ ttlMs: 60_000, maxEntries: 10, nowMs: () => 0 });
    await expect(cache.get('k', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(cache.size).toBe(0);
    const loader = counter();
    const next = await cache.get('k', loader.load);
    expect(next.hit).toBe(false);
    expect(loader.calls).toBe(1);
  });

  it('does not cache a non-200 response', async () => {
    const cache = new StatsCache({ ttlMs: 60_000, maxEntries: 10, nowMs: () => 0 });
    const notFound = counter({ ok: false, code: 'DECK_NOT_FOUND' }, 404);
    expect((await cache.get('k', notFound.load)).response.status).toBe(404);
    expect((await cache.get('k', notFound.load)).hit).toBe(false);
    expect(notFound.calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('stores nothing when the TTL is 0', async () => {
    const cache = new StatsCache({ ttlMs: 0, maxEntries: 10, nowMs: () => 0 });
    const loader = counter();
    await cache.get('k', loader.load);
    await cache.get('k', loader.load);
    expect(loader.calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('bounds the map, evicting the oldest entry first', async () => {
    const cache = new StatsCache({ ttlMs: 60_000, maxEntries: 2, nowMs: () => 0 });
    const loader = counter();
    await cache.get('a', loader.load);
    await cache.get('b', loader.load);
    await cache.get('c', loader.load);
    expect(cache.size).toBe(2);
    expect((await cache.get('b', loader.load)).hit).toBe(true);
    expect((await cache.get('c', loader.load)).hit).toBe(true);
    expect((await cache.get('a', loader.load)).hit).toBe(false);
  });
});

describe('statsCacheKey', () => {
  it('ignores query parameter order but keeps repeated values', () => {
    const a = statsCacheKey(new URL('http://x/v1/stats/dashboard?format=duel&pilot=b&pilot=a'));
    const b = statsCacheKey(new URL('http://x/v1/stats/dashboard?pilot=a&pilot=b&format=duel'));
    const c = statsCacheKey(new URL('http://x/v1/stats/dashboard?pilot=a&format=duel'));
    const d = statsCacheKey(new URL('http://x/v1/stats/decks?pilot=a&format=duel'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(c).not.toBe(d);
  });
});

describe('etagMatches', () => {
  it('compares weakly and accepts lists and *', () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"x", W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('*', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"x"', 'W/"abc"')).toBe(false);
    expect(etagMatches(undefined, 'W/"abc"')).toBe(false);
  });
});
