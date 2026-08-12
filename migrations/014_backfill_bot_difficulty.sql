-- 014_backfill_bot_difficulty.sql
-- One-time backfill of `game_seats.bot_difficulty` from current-era pilot
-- labels (#60).
--
-- Why the column is empty at all: the live serving path never stamped it. The
-- engine emits only the algorithm-shaped `pilot` label it builds at seat
-- creation (engine #278), so `bot_difficulty` is NULL on 100% of bot seats
-- (84,278 rows, checked against prod 2026-08-12). Everything keyed on it —
-- `playerByOpponentKind` in `src/db/accounts.ts`, and the difficulty-gated
-- badges unbrewed-api grants off it — saw one undifferentiated `unknown`
-- bucket. The forward fix is engine-side (unbrewed-engine#366, the engine
-- starts sending `botDifficulty`); this migration is the one-time catch-up so
-- games already played still count.
--
-- Only today's serving presets are mapped. A label is included when it is a
-- preset the engine currently serves and its tier is unambiguous:
--
--   bot:easy                 -> easy     randomBot; tier named in the label
--   bot:medium               -> medium   greedy-era medium (pre engine#263)
--   bot:mc(16,10000ms)       -> medium   MEDIUM_SERVE_BUDGET, 16 sims
--   bot:mc(64,10000ms)       -> hard     HARD_SERVE_BUDGET, 64 sims
--   bot:ismcts(512,10000ms)  -> expert   EXPERT_SERVE_BUDGET
--
-- Everything else stays NULL, deliberately (Dean, 2026-08-12). The legacy
-- budget labels — `bot:mc(64, 400ms)` (the starved-hard era, the bulk of live
-- history), `(64, 2000ms)`, `(64, 4000ms)`, `(64, 5000ms)`, other `mc(16, …)`
-- budgets, ISMCTS at other iteration counts — are distinguishable by label for
-- a reason: those bots played under budgets today's tiers do not describe, and
-- stamping them would launder an old population into a current tier. A NULL
-- there still reads as `unknown` through `src/db/bot-tier.ts`, which is the
-- honest answer.
--
-- Note the whitespace: stored pilots are not uniformly formatted
-- (`bot:mc(64, 400ms)` carries a space, the current labels do not), so the
-- match is on a normalized form — lower-cased with all whitespace stripped,
-- the same normalization `botTierSql()` uses on the read path.
--
-- `WHERE bot_difficulty IS NULL` does double duty: it makes a re-run a no-op,
-- and it means a value the engine stamps after #366 is never overwritten by
-- label archaeology.
UPDATE game_seats AS s
SET bot_difficulty = m.difficulty
FROM (VALUES
  ('bot:easy', 'easy'),
  ('bot:medium', 'medium'),
  ('bot:mc(16,10000ms)', 'medium'),
  ('bot:mc(64,10000ms)', 'hard'),
  ('bot:ismcts(512,10000ms)', 'expert')
) AS m (pilot, difficulty)
WHERE s.bot_difficulty IS NULL
  AND regexp_replace(lower(s.pilot), '\s', '', 'g') = m.pilot;
