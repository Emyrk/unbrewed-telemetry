/**
 * Canonical deck rules archive (#46) — verification and parsing for the
 * `rulesCanonical` string that accompanies a deck's `rulesHash`.
 *
 * The engine owns canonicalization (`canonicalDeckRules(hero, cards)` in
 * unbrewed-engine, shipped with #245). This service deliberately does NOT
 * re-implement it: it hashes the received bytes verbatim and compares the digest
 * to the fingerprint the producer sent. Re-serializing or "normalizing" the
 * string here would be a second implementation of a subtle algorithm in another
 * language, and it would drift — at which point the archive would no longer
 * prove anything about the fingerprint it is filed under.
 *
 * Two rules follow from that:
 *  - a digest that disagrees with its own rules is REJECTED (a fingerprint that
 *    does not describe its rules is worse than no archive at all);
 *  - a fingerprint whose ALGORITHM this service does not know (the `fp<n>-`
 *    prefix versions the algorithm) is STORED UNVERIFIED, never rejected —
 *    otherwise the day the engine ships `fp2` before telemetry is updated, every
 *    deck push starts failing.
 */

import { createHash } from 'node:crypto';
import type { DeckDefinitionSubmission } from '../types.js';

/** Algorithms whose canonicalization this service can verify a digest against. */
export const KNOWN_RULES_HASH_ALGORITHMS: readonly string[] = ['fp1'];

/** Mirrors the `rulesHash` pattern in deck-definitions.v1: `<algorithm>-<hex>`. */
const RULES_HASH_PATTERN = /^(fp[0-9]+)-([0-9a-f]{8,64})$/;

/** The parsed form of a canonical rules string: what the fingerprint covers. */
export interface DeckRulesDocument {
  hero: unknown;
  cards: unknown[];
}

export type DeckRulesVerification =
  /** No `rulesCanonical` on this deck — nothing to archive or verify. */
  | { status: 'absent' }
  /** `sha256(rulesCanonical)` agrees with `rulesHash`. */
  | { status: 'verified'; algorithm: string }
  /** Archived as received, with no digest check performed. Always accepted. */
  | { status: 'unverified'; reason: 'unknown-algorithm' | 'missing-hash' | 'malformed-hash'; algorithm: string | null }
  /** The digest disagrees with the rules it claims to describe. Rejected. */
  | { status: 'mismatch'; algorithm: string; expected: string; actual: string };

/** SHA-256 of the UTF-8 bytes of `value`, lowercase hex. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Verify one deck's archived rules against its fingerprint.
 *
 * The comparison is prefix-wise because the fingerprint carries a truncated
 * digest (`fp1` keeps 12 hex characters); the schema permits 8..64, so compare
 * exactly as many characters as the producer sent.
 */
export function verifyDeckRules(deck: { rulesCanonical?: string; rulesHash?: string }): DeckRulesVerification {
  const canonical = deck.rulesCanonical;
  if (canonical === undefined) return { status: 'absent' };
  if (deck.rulesHash === undefined) return { status: 'unverified', reason: 'missing-hash', algorithm: null };

  const parts = RULES_HASH_PATTERN.exec(deck.rulesHash);
  if (!parts) return { status: 'unverified', reason: 'malformed-hash', algorithm: null };

  const algorithm = parts[1]!;
  const digest = parts[2]!;
  if (!KNOWN_RULES_HASH_ALGORITHMS.includes(algorithm)) {
    return { status: 'unverified', reason: 'unknown-algorithm', algorithm };
  }

  // Hash the bytes exactly as received: no re-serialization, no key reordering,
  // no whitespace fixing. That is the whole point of archiving the string.
  const actual = sha256Hex(canonical).slice(0, digest.length);
  if (actual !== digest) return { status: 'mismatch', algorithm, expected: digest, actual };
  return { status: 'verified', algorithm };
}

/** Validation errors for a batch: only a provable digest mismatch rejects. */
export function deckRulesErrors(submission: DeckDefinitionSubmission): string[] {
  const errors: string[] = [];
  submission.decks.forEach((deck, i) => {
    const result = verifyDeckRules(deck);
    if (result.status === 'mismatch') {
      errors.push(
        `/decks/${i}/rulesCanonical: ${result.algorithm} digest of rulesCanonical is ${result.actual}, ` +
        `but rulesHash claims ${result.expected} (rules do not match their fingerprint)`,
      );
    }
  });
  return errors;
}

/** Log lines for decks archived without a digest check. Never blocks a push. */
export function deckRulesNotices(submission: DeckDefinitionSubmission): string[] {
  const notices: string[] = [];
  for (const deck of submission.decks) {
    const result = verifyDeckRules(deck);
    if (result.status !== 'unverified') continue;
    const known = KNOWN_RULES_HASH_ALGORITHMS.join(', ');
    const detail = result.reason === 'unknown-algorithm'
      ? `unknown rules hash algorithm ${result.algorithm} (this service verifies ${known})`
      : result.reason === 'missing-hash'
        ? 'rulesCanonical sent without a rulesHash to verify it against'
        : `unparseable rulesHash ${deck.rulesHash}`;
    notices.push(`${deck.deckId}@${deck.version}: stored rulesCanonical unverified — ${detail}`);
  }
  return notices;
}

/**
 * Parse a canonical rules string into its queryable form.
 *
 * `fp1` emits `fp1|hero=<json>|cards=[<json>,...]`. The JSON payloads can
 * themselves contain the literal `|cards=`, so the hero value is located by
 * scanning balanced JSON rather than by splitting on the marker.
 *
 * Returns null for anything it cannot parse — a future algorithm may frame the
 * string differently, and an unparseable archive is still a valid archive:
 * `rules_canonical` is the integrity anchor, `rules` is only a convenience.
 */
export function parseCanonicalDeckRules(canonical: string): DeckRulesDocument | null {
  const heroMarker = '|hero=';
  const heroMarkerAt = canonical.indexOf(heroMarker);
  if (heroMarkerAt < 0) return null;
  const heroStart = heroMarkerAt + heroMarker.length;
  const heroEnd = jsonValueEnd(canonical, heroStart);
  if (heroEnd < 0) return null;

  const cardsMarker = '|cards=';
  if (!canonical.startsWith(cardsMarker, heroEnd)) return null;

  try {
    const hero = JSON.parse(canonical.slice(heroStart, heroEnd)) as unknown;
    const cards = JSON.parse(canonical.slice(heroEnd + cardsMarker.length)) as unknown;
    if (!Array.isArray(cards)) return null;
    return { hero, cards };
  } catch {
    return null;
  }
}

/**
 * Index just past the JSON value starting at `start`, or -1 if it does not
 * terminate. Only the shapes a canonical hero can take are supported: an
 * object, an array, or the `null` an absent hero canonicalizes to.
 */
function jsonValueEnd(text: string, start: number): number {
  if (text.startsWith('null', start)) return start + 4;
  const open = text[start];
  if (open !== '{' && open !== '[') return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
