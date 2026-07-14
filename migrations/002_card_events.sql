-- Per-card play facts derived from telemetry.cardsPlayed.
-- One row per card-play event. Enables deck play-mix profiles and card influence.
CREATE TABLE game_cards (
  game_id text NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  event_index integer NOT NULL,
  team_index integer NOT NULL,
  seat_index integer NOT NULL,
  deck text NOT NULL,
  deck_id text NOT NULL,
  card text NOT NULL,
  turn integer,
  context text,
  -- normalized context bucket: attack, defense, scheme, boost, discard, other
  context_bucket text NOT NULL,
  seat_won boolean NOT NULL DEFAULT false,
  PRIMARY KEY (game_id, event_index)
);

CREATE INDEX game_cards_deck_idx ON game_cards (deck_id);
CREATE INDEX game_cards_deck_card_idx ON game_cards (deck, card);
CREATE INDEX game_cards_bucket_idx ON game_cards (deck, context_bucket);
CREATE INDEX game_cards_seat_idx ON game_cards (game_id, team_index, seat_index);
