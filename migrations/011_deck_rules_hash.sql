-- 011_deck_rules_hash.sql
-- Content-derived deck rules fingerprint (`fp<n>-<hex>`, engine #245) so a row
-- says which deck *rules* produced it, not just the hand-set CONTENT_VERSION
-- label that every deck shares. Additive and nullable: producers ship it behind
-- a flag, so historical rows and any producer that has not enabled it keep a
-- NULL here and their existing deck_version semantics unchanged.

ALTER TABLE game_seats ADD COLUMN IF NOT EXISTS deck_rules_hash text;
ALTER TABLE deck_definitions ADD COLUMN IF NOT EXISTS rules_hash text;

-- The core deck-balancing query groups seats by rules fingerprint to compare
-- candidate versions of one deck, so index (deck_id, deck_rules_hash) rather
-- than the hash alone: it serves both the per-deck grouping and a bare hash
-- lookup via the leading column when scoped to a deck. Partial on NOT NULL
-- because every pre-flag row is NULL and none of them are ever queried this way.
CREATE INDEX IF NOT EXISTS game_seats_deck_rules_hash_idx
  ON game_seats (deck_id, deck_rules_hash)
  WHERE deck_rules_hash IS NOT NULL;
