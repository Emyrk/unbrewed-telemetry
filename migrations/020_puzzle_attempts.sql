-- 020_puzzle_attempts.sql
-- Puzzle attempts from POST /v1/puzzle-attempts (#114). One row per attempt at
-- a Pro puzzle — solved, failed or abandoned — keyed by the producer's
-- `attempt_id`, which is also the idempotency key.
--
-- An attempt is not a game. No foreign key to games or game_seats, and nothing
-- in the game stats reads this table: a puzzle attempt must never move a game
-- count.
--
-- `actions` is the ordered [{ t_ms, actor, action }] list as received, with
-- `action` the engine action JSON verbatim (future bot-training data).
CREATE TABLE puzzle_attempts (
  attempt_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  auth_key_id text,
  puzzle_id text NOT NULL,
  puzzle_version integer NOT NULL,
  -- No CHECK on puzzle_type: a later type arrives with a schema bump, and the
  -- validator is the gate.
  puzzle_type text NOT NULL,
  context text NOT NULL,
  result text NOT NULL CHECK (result IN ('solved', 'failed', 'abandoned')),
  try_number integer NOT NULL CHECK (try_number >= 1),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  action_count integer NOT NULL CHECK (action_count >= 0),
  actions jsonb NOT NULL,
  hint_used boolean NOT NULL,
  solution_shown boolean NOT NULL,
  -- At most one of these is normally set: a guest's anonymous PostHog id, or a
  -- signed-in player's pseudonymous account uuid. Both may be null.
  analytics_id text,
  account_id text,
  protocol_version integer NOT NULL,
  content_version text,
  dsl_version text
);

-- Per-puzzle aggregates (GET /v1/stats/puzzles).
CREATE INDEX puzzle_attempts_puzzle_idx ON puzzle_attempts (puzzle_id);

-- Per-player reads (later XP and streaks). Partial: most rows carry only one.
CREATE INDEX puzzle_attempts_account_idx ON puzzle_attempts (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX puzzle_attempts_analytics_idx ON puzzle_attempts (analytics_id) WHERE analytics_id IS NOT NULL;
