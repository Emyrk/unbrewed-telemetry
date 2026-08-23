-- 015_queue_events.sql
-- Matchmaking queue lifecycle events from POST /v1/queue-events (#68).
--
-- Raw stream, stored as received: one row per emitted event, no aggregation at
-- write time. The wait/match-rate estimate the matchmaking screen will show is
-- a query over a trailing window (see src/stats/queue-wait.ts), so keeping the
-- events unrolled is what lets that window, and its definition, change later
-- without a backfill.
--
-- No foreign keys and no natural key: a search never becomes a game row here,
-- and the engine POSTs fire-and-forget, so there is nothing stable to dedupe
-- on. A synthetic bigserial keeps the rows narrow and insertion-ordered.
CREATE TABLE queue_events (
  id bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL CHECK (type IN ('search_started', 'matched', 'abandoned')),
  room_id text NOT NULL,
  hero_id text NOT NULL,
  format_id text NOT NULL,
  quick_match boolean NOT NULL,
  -- Only matched/abandoned events carry a wait; only abandoned carry a reason.
  wait_ms double precision CHECK (wait_ms IS NULL OR wait_ms >= 0),
  reason text CHECK (reason IS NULL OR reason IN ('expired', 'host_left')),
  ts timestamptz NOT NULL
);

-- The aggregate windows on `received_at` (server clock) rather than `ts`
-- (producer clock): a queue event is fire-and-forget, so a client with a skewed
-- clock would otherwise drop its searches outside every window, or inside all
-- of them. `ts` is kept as the producer's own account of when it happened.
CREATE INDEX queue_events_window_idx ON queue_events (received_at, quick_match, type);

-- Tracing one search's lifecycle (search_started -> matched/abandoned).
CREATE INDEX queue_events_room_idx ON queue_events (room_id);
