import { describe, expect, it } from 'vitest';
import {
  KNOWN_RULES_HASH_ALGORITHMS,
  parseCanonicalDeckRules,
  verifyDeckRules,
} from '../src/ingest/deck-rules.js';
import { validateDeckDefinitions } from '../src/ingest/deck-schema.js';
import { fingerprintFor, sampleCanonicalRules } from './fixtures.js';

describe('deck rules verification', () => {
  it('verifies a fingerprint against the exact bytes it digests', () => {
    const canonical = sampleCanonicalRules();
    expect(verifyDeckRules({ rulesCanonical: canonical, rulesHash: fingerprintFor(canonical) }))
      .toEqual({ status: 'verified', algorithm: 'fp1' });
  });

  it('rejects rules whose digest disagrees with the fingerprint', () => {
    const canonical = sampleCanonicalRules();
    const other = fingerprintFor(sampleCanonicalRules({ attackValue: 6 }));
    const result = verifyDeckRules({ rulesCanonical: canonical, rulesHash: other });
    expect(result.status).toBe('mismatch');
  });

  it('hashes the received bytes verbatim: a reordered but equivalent string fails', () => {
    // Semantically identical to the fixture — same hero, same cards, same values —
    // but with the hero's keys in a different order. If ingest re-canonicalized
    // before hashing, this would pass and the archive would stop proving anything.
    const canonical = sampleCanonicalRules();
    const reordered = canonical.replace(
      '|hero={"health":18,"id":"king-kong"',
      '|hero={"id":"king-kong","health":18',
    );
    expect(reordered).not.toBe(canonical);
    expect(JSON.parse(reordered.slice(reordered.indexOf('{'), reordered.indexOf('|cards='))))
      .toEqual(JSON.parse(canonical.slice(canonical.indexOf('{'), canonical.indexOf('|cards='))));

    const result = verifyDeckRules({ rulesCanonical: reordered, rulesHash: fingerprintFor(canonical) });
    expect(result.status).toBe('mismatch');
  });

  it('stores an unknown algorithm unverified rather than rejecting it', () => {
    // The day the engine ships fp2 before telemetry knows it, deck pushes must
    // keep working — the archive is just filed without a digest check.
    expect(KNOWN_RULES_HASH_ALGORITHMS).not.toContain('fp2');
    const result = verifyDeckRules({
      rulesCanonical: 'fp2|whatever the next canonicalization looks like',
      rulesHash: 'fp2-0123456789abcdef',
    });
    expect(result).toEqual({ status: 'unverified', reason: 'unknown-algorithm', algorithm: 'fp2' });
  });

  it('treats rules sent without a fingerprint as unverified, not invalid', () => {
    expect(verifyDeckRules({ rulesCanonical: sampleCanonicalRules() }))
      .toEqual({ status: 'unverified', reason: 'missing-hash', algorithm: null });
  });

  it('has nothing to verify when no rules are archived', () => {
    expect(verifyDeckRules({ rulesHash: 'fp1-9c3a17b40e21' })).toEqual({ status: 'absent' });
    expect(verifyDeckRules({})).toEqual({ status: 'absent' });
  });

  it('compares only as many digest characters as the producer sent', () => {
    const canonical = sampleCanonicalRules();
    const full = fingerprintFor(canonical).slice('fp1-'.length);
    expect(verifyDeckRules({ rulesCanonical: canonical, rulesHash: `fp1-${full.slice(0, 8)}` }).status)
      .toBe('verified');
  });
});

describe('canonical deck rules parsing', () => {
  it('parses hero and cards out of the canonical string', () => {
    const parsed = parseCanonicalDeckRules(sampleCanonicalRules());
    expect(parsed?.hero).toMatchObject({ id: 'king-kong', health: 18, sidekick: { health: 8 } });
    expect(parsed?.cards).toHaveLength(4);
    expect(parsed?.cards).toContainEqual(expect.objectContaining({ id: 'king-kong/a', quantity: 12, value: 5 }));
  });

  it('is not fooled by the cards marker appearing inside a string value', () => {
    const canonical = 'fp1|hero={"id":"trap","name":"|cards=[not really]"}|cards=[{"quantity":1,"type":"attack"}]';
    const parsed = parseCanonicalDeckRules(canonical);
    expect(parsed?.hero).toEqual({ id: 'trap', name: '|cards=[not really]' });
    expect(parsed?.cards).toEqual([{ quantity: 1, type: 'attack' }]);
  });

  it('returns null for a framing it does not recognize instead of throwing', () => {
    expect(parseCanonicalDeckRules('fp2|something entirely different')).toBeNull();
    expect(parseCanonicalDeckRules('fp1|hero={"id":"broken"|cards=[]')).toBeNull();
    expect(parseCanonicalDeckRules('fp1|hero={"id":"x"}|cards={"not":"an array"}')).toBeNull();
    expect(parseCanonicalDeckRules('')).toBeNull();
  });
});

describe('deck definition rules canonical validation', () => {
  it('stays optional: a batch without it still validates', () => {
    expect(validateDeckDefinitions(batch())).toEqual({ ok: true, errors: [] });
  });

  it('accepts a verified pair', () => {
    const canonical = sampleCanonicalRules();
    expect(validateDeckDefinitions(batch({ rulesCanonical: canonical, rulesHash: fingerprintFor(canonical) })))
      .toEqual({ ok: true, errors: [] });
  });

  it('rejects a batch whose rules do not match their fingerprint', () => {
    const result = validateDeckDefinitions(batch({
      rulesCanonical: sampleCanonicalRules(),
      rulesHash: fingerprintFor(sampleCanonicalRules({ heroHealth: 19 })),
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('/decks/0/rulesCanonical');
  });

  it('accepts a batch carrying an unknown algorithm prefix', () => {
    expect(validateDeckDefinitions(batch({
      rulesCanonical: 'fp2|hero={"id":"king-kong"}|cards=[]',
      rulesHash: 'fp2-0123456789abcdef',
    }))).toEqual({ ok: true, errors: [] });
  });

  it('rejects a non-string rulesCanonical at the schema layer', () => {
    const result = validateDeckDefinitions(batch({ rulesCanonical: 42 as unknown as string }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('/decks/0/rulesCanonical');
  });
});

function batch(deck: { rulesCanonical?: string; rulesHash?: string } = {}): unknown {
  return {
    schemaVersion: 1,
    source: 'test',
    decks: [{
      deckId: 'king-kong',
      version: '0.1.0',
      ...deck,
      cards: [{ type: 'attack', value: 5, quantity: 12 }],
    }],
  };
}
