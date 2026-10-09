-- 017_sandbox_events.sql
-- Sandbox (non-Pro) room lifecycle events from POST /v1/sandbox-events (#84).
--
-- A separate bucket on purpose: sandbox games run on the Go relay with no rules
-- engine, so they say nothing about balance. Nothing here joins to games,
-- game_seats or any Pro table, and no Pro stat reads this table.
--
-- Raw stream, stored as received (queue_events precedent): the counts the
-- dashboard shows are a query over a trailing window (src/stats/sandbox.ts).
-- Unlike queue_events the producer stamps a uuid per event, so a retried batch
-- dedupes on event_id instead of double-counting.
--
-- Players arrive only as player_hash, a relay-side HMAC of the normalized name;
-- telemetry never sees the name itself.
CREATE TABLE sandbox_events (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Telemetry source name, derived from the bearer credential.
  source text NOT NULL,
  type text NOT NULL CHECK (type IN ('room_opened', 'player_joined', 'player_left', 'hero_seen', 'room_closed')),
  -- A uuid the relay mints per room it creates, so two sittings that reuse a
  -- lobby name are separate rooms.
  room_id text NOT NULL,
  -- room_opened only: the lobby name under the same salted HMAC as player_hash,
  -- so a reported lobby can be looked up by name.
  lobby_hash text CHECK (lobby_hash IS NULL OR lobby_hash ~ '^[0-9a-f]{16}$'),
  -- player_joined, player_left, hero_seen.
  player_hash text CHECK (player_hash IS NULL OR player_hash ~ '^[0-9a-f]{16}$'),
  -- hero_seen only.
  hero_name text,
  -- player_joined, player_left: live connections in the room after the event.
  connections integer CHECK (connections IS NULL OR connections >= 0),
  -- room_closed only.
  reason text CHECK (reason IS NULL OR reason IN ('inactive', 'shutdown')),
  lifetime_ms bigint CHECK (lifetime_ms IS NULL OR lifetime_ms >= 0),
  distinct_players integer CHECK (distinct_players IS NULL OR distinct_players >= 0),
  peak_connections integer CHECK (peak_connections IS NULL OR peak_connections >= 0),
  state_updates integer CHECK (state_updates IS NULL OR state_updates >= 0),
  ts timestamptz NOT NULL
);

-- Read-time aggregates window on received_at (server clock), like queue_events.
CREATE INDEX sandbox_events_window_idx ON sandbox_events (received_at, type);
CREATE INDEX sandbox_events_room_idx ON sandbox_events (room_id);
-- returningPlayers probes "any earlier row for this hash": with received_at
-- second the EXISTS stops at the first one.
CREATE INDEX sandbox_events_player_idx ON sandbox_events (player_hash, received_at);
CREATE INDEX sandbox_events_lobby_idx ON sandbox_events (lobby_hash);
