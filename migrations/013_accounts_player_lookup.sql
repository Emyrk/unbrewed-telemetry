-- 013_accounts_player_lookup.sql
-- The accounts read API (#52) looks games up by `game_seats.player_id` — the
-- pseudonymous account uuid the engine stamps on a signed-in player's seat.
-- Every existing index on game_seats leads with deck/pilot/won, so a player
-- history would seq-scan the whole table.
--
-- Partial on NOT NULL: the overwhelming majority of seats are bots and
-- anonymous humans with a NULL player_id, and none of them are ever looked up
-- this way, so the partial index stays proportional to signed-in play.
CREATE INDEX IF NOT EXISTS game_seats_player_id_idx
  ON game_seats (player_id)
  WHERE player_id IS NOT NULL;
