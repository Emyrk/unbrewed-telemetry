-- 018_stats_rollups.sql
-- Pre-aggregated dashboard stats (#87).
--
-- Every dashboard load used to re-aggregate games/game_seats/game_cards and
-- evaluate the pilot allowlist per game with a correlated
-- `NOT EXISTS … unnest() … LIKE allowed.pilot || '%'` (seconds per request on
-- the 2026-10-11 snapshot). Two changes fix that:
--
-- 1. Pilot buckets. The allowlist is a predicate over the *set* of seat pilots
--    in a game, and production has ~30 distinct sets. `pilot_buckets` stores
--    each distinct shape once — one `[pilot, pilot_kind, [opposing pilots…]]`
--    descriptor per distinct seat, sorted — and every game carries its bucket
--    id. A filter is evaluated once per bucket instead of once per game, and
--    the opposing-pilot list also answers the Heroes tab's "hero pilot vs
--    allowed opponent pilots" filter. Bucket ids are only ever looked up by
--    predicate, never compared across shapes, so two ids for one shape would
--    split rows without changing any total.
--
--    games/game_seats are backfilled here (tens of thousands of rows). The
--    1.3M-row game_cards/game_starting_cards copies of `format` and
--    `pilot_bucket` are backfilled by `npm run stats:backfill-rollups`, which
--    batches and has a dry run.
--
-- 2. Rollup tables (`stats_*_rollup`), keyed by format and pilot bucket plus
--    whatever each dashboard view groups on. Ingest queues the game id in
--    `stats_rollup_pending` in the same transaction as the raw rows, and a
--    fold (every few seconds, and before each rollup read) applies queued
--    games in batches (src/db/rollups.ts), so a committed game is counted
--    exactly once and ingest never waits on a hot rollup row. Every measure is
--    additive (counts and sums, averages are sum/n); every MAX/MODE the old
--    queries took is a key column instead, so the read side reproduces them
--    exactly. Raw tables stay the source of truth: the backfill script can
--    rebuild every rollup from them at any time.
--
-- `stats_rollup_state.ready_at` gates the read path: the dashboard keeps
-- reading raw tables until the backfill script has filled the card columns
-- and rebuilt the rollups. An empty database (tests, a fresh deploy) has
-- nothing to backfill, so it starts ready.

CREATE TABLE pilot_buckets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- [[pilot, pilot_kind, [opposing pilot, …]], …], distinct and sorted.
  seats jsonb NOT NULL UNIQUE
);

ALTER TABLE games ADD COLUMN pilot_bucket integer REFERENCES pilot_buckets (id);
ALTER TABLE game_seats ADD COLUMN pilot_bucket integer;
ALTER TABLE game_cards ADD COLUMN format text, ADD COLUMN pilot_bucket integer;
ALTER TABLE game_starting_cards ADD COLUMN format text, ADD COLUMN pilot_bucket integer;

-- Same canonical form as pilotBucketSeats() in src/db/rollups.ts: opposing
-- pilots sorted and distinct, descriptors distinct and sorted by
-- (pilot, pilot_kind, opposing pilots joined by U+001F), byte order.
CREATE TEMP TABLE game_pilot_shapes ON COMMIT DROP AS
WITH seat_shapes AS (
  SELECT DISTINCT
    s.game_id,
    s.pilot COLLATE "C" AS pilot,
    s.pilot_kind COLLATE "C" AS pilot_kind,
    ARRAY(
      SELECT DISTINCT o.pilot COLLATE "C"
      FROM game_seats o
      WHERE o.game_id = s.game_id AND o.team_index <> s.team_index
      ORDER BY 1
    ) AS opp
  FROM game_seats s
)
SELECT g.id AS game_id, COALESCE(shape.seats, '[]'::jsonb) AS seats
FROM games g
LEFT JOIN (
  SELECT
    x.game_id,
    jsonb_agg(
      jsonb_build_array(x.pilot, x.pilot_kind, to_jsonb(x.opp))
      ORDER BY x.pilot, x.pilot_kind, array_to_string(x.opp, chr(31)) COLLATE "C"
    ) AS seats
  FROM seat_shapes x
  GROUP BY x.game_id
) shape ON shape.game_id = g.id;

INSERT INTO pilot_buckets (seats)
SELECT DISTINCT seats FROM game_pilot_shapes
ON CONFLICT (seats) DO NOTHING;

UPDATE games g
SET pilot_bucket = b.id
FROM game_pilot_shapes shape
JOIN pilot_buckets b ON b.seats = shape.seats
WHERE shape.game_id = g.id;

UPDATE game_seats s
SET pilot_bucket = g.pilot_bucket
FROM games g
WHERE g.id = s.game_id;

ALTER TABLE games ALTER COLUMN pilot_bucket SET NOT NULL;
ALTER TABLE game_seats ALTER COLUMN pilot_bucket SET NOT NULL;

-- One row per (format, pilot bucket, map, boss, source, credential, labels).
-- Serves the dashboard summary, formats, boss breakdown, maps, the deck
-- table's totals and /v1/stats/sources.
CREATE TABLE stats_game_rollup (
  format text NOT NULL,
  format_label text,
  pilot_bucket integer NOT NULL,
  map text NOT NULL,
  map_version text,
  boss text,
  source text NOT NULL,
  auth_key_id text,
  games bigint NOT NULL,
  turns_sum bigint NOT NULL,
  turns_n bigint NOT NULL,
  first_player_games bigint NOT NULL,
  first_player_wins bigint NOT NULL,
  team0_wins bigint NOT NULL,
  last_received_at timestamptz,
  CONSTRAINT stats_game_rollup_key UNIQUE NULLS NOT DISTINCT
    (format, format_label, pilot_bucket, map, map_version, boss, source, auth_key_id)
);

-- One row per seat shape: deck × hero × the seat's own pilot × the pilots it
-- faced. Serves the deck table, pilot list, 2v2 solo baselines and the deck
-- detail headline numbers.
CREATE TABLE stats_deck_rollup (
  format text NOT NULL,
  format_label text,
  pilot_bucket integer NOT NULL,
  deck text NOT NULL,
  deck_id text NOT NULL,
  deck_version text NOT NULL,
  hero_id text,
  hero_name text,
  pilot text NOT NULL,
  pilot_kind text NOT NULL,
  opp_pilots text[] NOT NULL,
  games bigint NOT NULL,
  wins bigint NOT NULL,
  final_health_sum bigint NOT NULL,
  final_health_n bigint NOT NULL,
  win_final_health_sum bigint NOT NULL,
  win_final_health_n bigint NOT NULL,
  deck_count_sum bigint NOT NULL,
  deck_count_n bigint NOT NULL,
  win_deck_count_sum bigint NOT NULL,
  win_deck_count_n bigint NOT NULL,
  loss_deck_count_sum bigint NOT NULL,
  loss_deck_count_n bigint NOT NULL,
  win_turns_sum bigint NOT NULL,
  win_turns_n bigint NOT NULL,
  loss_turns_sum bigint NOT NULL,
  loss_turns_n bigint NOT NULL,
  first_games bigint NOT NULL,
  first_wins bigint NOT NULL,
  second_games bigint NOT NULL,
  second_wins bigint NOT NULL,
  CONSTRAINT stats_deck_rollup_key UNIQUE NULLS NOT DISTINCT
    (format, format_label, pilot_bucket, deck, deck_id, deck_version, hero_id, hero_name, pilot, pilot_kind, opp_pilots)
);

-- Deck × map, for the deck detail map table.
CREATE TABLE stats_deck_map_rollup (
  format text NOT NULL,
  pilot_bucket integer NOT NULL,
  deck text NOT NULL,
  map text NOT NULL,
  map_version text,
  games bigint NOT NULL,
  wins bigint NOT NULL,
  CONSTRAINT stats_deck_map_rollup_key UNIQUE NULLS NOT DISTINCT
    (format, pilot_bucket, deck, map, map_version)
);

-- Duel matchups, oriented: one row per (row seat, column seat) pairing of the
-- two seat-0s on different teams, so each game lands twice.
CREATE TABLE stats_matchup_rollup (
  format text NOT NULL,
  pilot_bucket integer NOT NULL,
  row_deck text NOT NULL,
  row_deck_id text NOT NULL,
  row_pilot text NOT NULL,
  col_deck text NOT NULL,
  col_deck_id text NOT NULL,
  col_pilot text NOT NULL,
  col_hero_id text,
  col_hero_name text,
  games bigint NOT NULL,
  wins bigint NOT NULL,
  turns_sum bigint NOT NULL,
  turns_n bigint NOT NULL,
  win_turns_sum bigint NOT NULL,
  win_turns_n bigint NOT NULL,
  loss_turns_sum bigint NOT NULL,
  loss_turns_n bigint NOT NULL,
  final_health_sum bigint NOT NULL,
  final_health_n bigint NOT NULL,
  deck_count_sum bigint NOT NULL,
  deck_count_n bigint NOT NULL,
  CONSTRAINT stats_matchup_rollup_key UNIQUE NULLS NOT DISTINCT
    (format, pilot_bucket, row_deck, row_deck_id, row_pilot, col_deck, col_deck_id, col_pilot, col_hero_id, col_hero_name)
);

-- 2v2 teammates as an ordered pair (deck_a_id <= deck_b_id).
CREATE TABLE stats_pair_rollup (
  format text NOT NULL,
  pilot_bucket integer NOT NULL,
  deck_a text NOT NULL,
  deck_a_id text NOT NULL,
  deck_b text NOT NULL,
  deck_b_id text NOT NULL,
  games bigint NOT NULL,
  wins bigint NOT NULL,
  CONSTRAINT stats_pair_rollup_key UNIQUE NULLS NOT DISTINCT
    (format, pilot_bucket, deck_a, deck_a_id, deck_b, deck_b_id)
);

-- 2v2 seat × partner × opposing pair, for the deck detail partner table's
-- opponent-strength-adjusted expectation.
CREATE TABLE stats_partner_rollup (
  format text NOT NULL,
  pilot_bucket integer NOT NULL,
  deck text NOT NULL,
  partner_deck text NOT NULL,
  partner_deck_id text NOT NULL,
  partner_hero_id text,
  partner_hero_name text,
  opp_deck_a_id text NOT NULL,
  opp_deck_b_id text NOT NULL,
  games bigint NOT NULL,
  wins bigint NOT NULL,
  CONSTRAINT stats_partner_rollup_key UNIQUE NULLS NOT DISTINCT
    (format, pilot_bucket, deck, partner_deck, partner_deck_id, partner_hero_id, partner_hero_name, opp_deck_a_id, opp_deck_b_id)
);

-- Card plays: seats that played the card (and won), and plays per context.
CREATE TABLE stats_card_rollup (
  format text NOT NULL,
  pilot_bucket integer NOT NULL,
  deck text NOT NULL,
  card text NOT NULL,
  games_with bigint NOT NULL,
  wins_with bigint NOT NULL,
  CONSTRAINT stats_card_rollup_key UNIQUE (format, pilot_bucket, deck, card)
);

CREATE TABLE stats_card_context_rollup (
  format text NOT NULL,
  pilot_bucket integer NOT NULL,
  deck text NOT NULL,
  card text NOT NULL,
  context_bucket text NOT NULL,
  plays bigint NOT NULL,
  CONSTRAINT stats_card_context_rollup_key UNIQUE (format, pilot_bucket, deck, card, context_bucket)
);

CREATE TABLE stats_starting_card_rollup (
  format text NOT NULL,
  pilot_bucket integer NOT NULL,
  deck text NOT NULL,
  card text NOT NULL,
  starts bigint NOT NULL,
  games_with bigint NOT NULL,
  wins_with bigint NOT NULL,
  CONSTRAINT stats_starting_card_rollup_key UNIQUE (format, pilot_bucket, deck, card)
);

CREATE TABLE stats_submission_rollup (
  validation_status text PRIMARY KEY,
  submissions bigint NOT NULL
);

-- Games ingested but not yet folded into the rollups. Ingest inserts here in
-- its own transaction instead of upserting the hot rollup rows; a fold claims
-- a batch and applies it (src/db/rollups.ts).
CREATE TABLE stats_rollup_pending (
  game_id text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX stats_rollup_pending_queued_idx ON stats_rollup_pending (queued_at);

CREATE TABLE stats_rollup_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ready_at timestamptz
);

INSERT INTO stats_rollup_state (ready_at)
SELECT CASE WHEN EXISTS (SELECT 1 FROM games) OR EXISTS (SELECT 1 FROM game_submissions) THEN NULL ELSE now() END;

-- Rollups summarize the raw tables, so emptying the raw tables empties them
-- too (the DB-backed tests TRUNCATE game_submissions CASCADE between cases,
-- which truncates games as well and fires both triggers).
CREATE FUNCTION stats_game_rollups_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM stats_game_rollup;
  DELETE FROM stats_deck_rollup;
  DELETE FROM stats_deck_map_rollup;
  DELETE FROM stats_matchup_rollup;
  DELETE FROM stats_pair_rollup;
  DELETE FROM stats_partner_rollup;
  DELETE FROM stats_card_rollup;
  DELETE FROM stats_card_context_rollup;
  DELETE FROM stats_starting_card_rollup;
  DELETE FROM stats_rollup_pending;
  RETURN NULL;
END;
$$;

CREATE TRIGGER stats_game_rollups_reset_on_truncate
AFTER TRUNCATE ON games
FOR EACH STATEMENT EXECUTE FUNCTION stats_game_rollups_reset();

CREATE FUNCTION stats_submission_rollup_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM stats_submission_rollup;
  RETURN NULL;
END;
$$;

CREATE TRIGGER stats_submission_rollup_reset_on_truncate
AFTER TRUNCATE ON game_submissions
FOR EACH STATEMENT EXECUTE FUNCTION stats_submission_rollup_reset();
