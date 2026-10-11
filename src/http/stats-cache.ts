import { createHash } from 'node:crypto';

/** A serialized stats response: only status 200 is ever stored. */
export interface StatsCacheResponse {
  status: number;
  body: string;
  etag: string;
}

export interface StatsCacheResult {
  response: StatsCacheResponse;
  /** True when the response came from a stored entry or an in-flight load. */
  hit: boolean;
}

interface Entry {
  expiresAt: number;
  response?: StatsCacheResponse;
  pending?: Promise<StatsCacheResponse>;
}

export interface StatsCacheOptions {
  ttlMs: number;
  maxEntries: number;
  nowMs: () => number;
}

/**
 * TTL cache for the aggregate stats routes (#86), following the
 * `recentHourlyCache` pattern: concurrent misses share one in-flight load, a
 * rejected or non-200 load is never stored, and the map is bounded (oldest
 * insertion evicted first). A `ttlMs` of 0 disables storage but still
 * de-duplicates concurrent loads.
 */
export class StatsCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: StatsCacheOptions) {}

  get ttlMs(): number {
    return this.options.ttlMs;
  }

  get size(): number {
    return this.entries.size;
  }

  async get(key: string, load: () => Promise<{ status: number; payload: unknown }>): Promise<StatsCacheResult> {
    const nowMs = this.options.nowMs();
    const cached = this.entries.get(key);
    if (cached?.response && cached.expiresAt > nowMs) return { response: cached.response, hit: true };
    if (cached?.pending) return { response: await cached.pending, hit: true };

    const pending = load().then(({ status, payload }) => serialize(status, payload));
    this.set(key, { expiresAt: nowMs + this.options.ttlMs, pending });
    try {
      const response = await pending;
      if (this.entries.get(key)?.pending === pending) {
        if (response.status === 200 && this.options.ttlMs > 0) {
          this.set(key, { expiresAt: this.options.nowMs() + this.options.ttlMs, response });
        } else {
          this.entries.delete(key);
        }
      }
      return { response, hit: false };
    } catch (error) {
      if (this.entries.get(key)?.pending === pending) this.entries.delete(key);
      throw error;
    }
  }

  private set(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size <= this.options.maxEntries) return;
    const nowMs = this.options.nowMs();
    for (const [candidate, value] of this.entries) {
      if (value.response && value.expiresAt <= nowMs) this.entries.delete(candidate);
    }
    for (const candidate of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(candidate);
    }
  }
}

/** Cache key: path plus the query string with parameters sorted, so order does not matter. */
export function statsCacheKey(url: URL): string {
  const params = [...url.searchParams.entries()]
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return `${url.pathname}?${new URLSearchParams(params).toString()}`;
}

/** True when an `If-None-Match` header matches `etag` under weak comparison. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === target);
}

function serialize(status: number, payload: unknown): StatsCacheResponse {
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
  return { status, body, etag };
}
