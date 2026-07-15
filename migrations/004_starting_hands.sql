-- One row per card in a seat's starting hand. Enables opening-hand win-rate stats.
CREATE TABLE game_starting_cards (
  game_id text NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_index integer NOT NULL,
  seat_index integer NOT NULL,
  card_index integer NOT NULL,
  deck text NOT NULL,
  deck_id text NOT NULL,
  card text NOT NULL,
  seat_won boolean NOT NULL DEFAULT false,
  PRIMARY KEY (game_id, team_index, seat_index, card_index)
);

CREATE INDEX game_starting_cards_deck_idx ON game_starting_cards (deck_id);
CREATE INDEX game_starting_cards_deck_card_idx ON game_starting_cards (deck, card);
CREATE INDEX game_starting_cards_seat_idx ON game_starting_cards (game_id, team_index, seat_index);
