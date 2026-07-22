-- 009_worker_sessions.sql
-- Durable runner sessions for fleet liveness and per-session throughput.

CREATE TABLE IF NOT EXISTS sim_worker_sessions (
  id text PRIMARY KEY,
  credential_id text NOT NULL REFERENCES source_credentials(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  reported_concurrency integer CHECK (reported_concurrency IS NULL OR reported_concurrency > 0),
  worker_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sim_worker_sessions_credential_started_idx
  ON sim_worker_sessions (credential_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sim_worker_sessions_heartbeat_idx
  ON sim_worker_sessions (last_heartbeat_at DESC);
