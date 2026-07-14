CREATE TABLE game_submissions (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  source text,
  auth_key_id text,
  payload jsonb NOT NULL,
  validation_status text NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  validation_errors jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE games (
  id text PRIMARY KEY,
  submission_id text NOT NULL UNIQUE REFERENCES game_submissions(id) ON DELETE RESTRICT,
  schema_version integer NOT NULL,
  submitted_at timestamptz,
  ended_at timestamptz,
  received_at timestamptz NOT NULL,
  source text NOT NULL,
  format text NOT NULL,
  format_label text,
  boss text,
  map text NOT NULL,
  map_version text,
  winner_team integer,
  draw boolean NOT NULL DEFAULT false,
  end_condition text,
  turns integer,
  duration_seconds integer,
  first_player_team integer,
  engine_schema_version integer,
  engine_dsl_version text,
  protocol_version integer,
  content_version text,
  replay_hash text,
  state_hash text,
  payload jsonb NOT NULL
);

CREATE TABLE game_teams (
  game_id text NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_index integer NOT NULL,
  role text,
  won boolean NOT NULL DEFAULT false,
  PRIMARY KEY (game_id, team_index)
);

CREATE TABLE game_seats (
  game_id text NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_index integer NOT NULL,
  seat_index integer NOT NULL,
  runtime_player_id text,
  deck text NOT NULL,
  deck_id text NOT NULL,
  deck_version text NOT NULL,
  hero_id text,
  hero_name text,
  pilot text NOT NULL,
  pilot_kind text NOT NULL CHECK (pilot_kind IN ('human', 'bot', 'unknown')),
  bot_id text,
  bot_difficulty text,
  bot_version text,
  player_id text,
  first_player boolean NOT NULL DEFAULT false,
  won boolean NOT NULL DEFAULT false,
  final_health integer,
  final_deck_count integer,
  final_hand_count integer,
  final_discard_count integer,
  PRIMARY KEY (game_id, team_index, seat_index)
);

CREATE INDEX games_format_idx ON games (format);
CREATE INDEX games_map_idx ON games (map);
CREATE INDEX games_received_at_idx ON games (received_at);
CREATE INDEX games_ended_at_idx ON games (ended_at);
CREATE INDEX game_seats_deck_idx ON game_seats (deck_id, deck_version);
CREATE INDEX game_seats_pilot_idx ON game_seats (pilot, pilot_kind);
CREATE INDEX game_seats_won_idx ON game_seats (won);
