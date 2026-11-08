-- Quick Play 2x XP (#107): how the room's seats were matched and the XP
-- multiplier the engine locked in at game start. Additive; no backfill — every
-- existing row is multiplier 1 by default.
ALTER TABLE games
  ADD COLUMN matched_via text,
  ADD COLUMN xp_multiplier real NOT NULL DEFAULT 1;

-- The accounts stats query filters on xp_multiplier > 1, a tiny slice of games.
CREATE INDEX games_xp_multiplier_idx ON games (id) WHERE xp_multiplier > 1;
