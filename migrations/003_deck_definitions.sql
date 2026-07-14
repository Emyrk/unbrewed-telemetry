-- Versioned deck registry pushed by content producers (the engine server) via
-- POST /v1/decks. One row per (deck_id, version) so historical games keep their
-- exact composition even as the live content set changes. Card counts and Σ
-- values are precomputed for fast dashboard joins; the raw card list is kept in
-- `cards` for future analytics.
CREATE TABLE deck_definitions (
  deck_id text NOT NULL,
  version text NOT NULL,
  name text,
  tier text,
  source text,
  content_version text,
  card_count integer NOT NULL DEFAULT 0,
  attack_count integer NOT NULL DEFAULT 0,
  defense_count integer NOT NULL DEFAULT 0,
  versatile_count integer NOT NULL DEFAULT 0,
  scheme_count integer NOT NULL DEFAULT 0,
  attack_value integer NOT NULL DEFAULT 0,
  defense_value integer NOT NULL DEFAULT 0,
  cards jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deck_id, version)
);

CREATE INDEX deck_definitions_deck_idx ON deck_definitions (deck_id, received_at DESC);
