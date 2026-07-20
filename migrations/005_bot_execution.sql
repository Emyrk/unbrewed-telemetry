-- Optional validated per-game execution summary for bot-controlled seats.
-- Kept as JSONB because search algorithms and their instrumentation can evolve
-- without turning every additive metric into another relational migration.
ALTER TABLE game_seats
  ADD COLUMN bot_execution jsonb;
