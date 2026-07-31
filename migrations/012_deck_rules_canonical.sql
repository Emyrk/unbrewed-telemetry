-- 012_deck_rules_canonical.sql
-- Archive of the deck rules a fingerprint describes (engine #245/#305). 011
-- stores the fingerprint itself, which can only say *that* a deck's rules moved;
-- these columns say *how* they moved, which is what deck balancing needs to
-- attribute a win-rate change to a specific rules change.
--
-- Additive and nullable: producers ship `rulesCanonical` behind a flag, and
-- historical rows keep their lossy `cards` payload with NULLs here. No backfill.

-- The exact bytes the engine hashed. This is the integrity anchor: ingest
-- recomputes sha256 over this string verbatim and rejects a payload whose digest
-- disagrees with its rules_hash, so a stored pair is always self-consistent
-- (except under an algorithm this service did not know at write time, which is
-- stored unverified by design).
ALTER TABLE deck_definitions ADD COLUMN IF NOT EXISTS rules_canonical text;

-- The same content parsed, so card values, quantities, effect programs and
-- hero/sidekick stats are queryable in SQL without parsing text. Derived from
-- rules_canonical, never authoritative over it.
ALTER TABLE deck_definitions ADD COLUMN IF NOT EXISTS rules jsonb;

-- The archive's reason for existing is fingerprint -> rules lookup: given a
-- seat's deck_rules_hash, fetch the rules that produced it. Partial on NOT NULL
-- because every row pushed before the producer flag is NULL and none of them are
-- ever looked up this way.
CREATE INDEX IF NOT EXISTS deck_definitions_rules_hash_idx
  ON deck_definitions (rules_hash)
  WHERE rules_hash IS NOT NULL;
