-- 016_game_replays.sql
-- Full replay bundle per live game from POST /v1/replays (#70). One row per
-- game, keyed by the engine's live game id (the same id the /v1/games
-- submission carries). No foreign key to games: the two POSTs are independent
-- and fire-and-forget on the engine; join on game_id at read time.
--
-- The scalar columns are copied out of the bundle at insert so analysis can
-- filter by engine version or size without unpacking the jsonb.
CREATE TABLE game_replays (
  game_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text,
  auth_key_id text,
  engine_schema_version integer NOT NULL,
  engine_dsl_version text NOT NULL,
  digest_version integer,
  action_count integer NOT NULL CHECK (action_count >= 0),
  turns integer,
  bundle_bytes integer NOT NULL CHECK (bundle_bytes > 0),
  bundle jsonb NOT NULL
);
CREATE INDEX game_replays_received_at_idx ON game_replays (received_at);
