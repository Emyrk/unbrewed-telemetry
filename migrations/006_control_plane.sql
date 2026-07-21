-- 006_control_plane.sql
-- Discord OAuth admin sessions, named telemetry sources with bearer credentials,
-- simulation campaigns, and simulation jobs.

-- ============================================================================
-- Admin sessions (Discord OAuth)
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_sessions (
  id text PRIMARY KEY,
  discord_id text NOT NULL,
  discord_username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_sessions_discord_id_idx ON admin_sessions (discord_id);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON admin_sessions (expires_at);

-- ============================================================================
-- Telemetry sources and credentials
-- ============================================================================

CREATE TABLE IF NOT EXISTS telemetry_sources (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

CREATE TABLE IF NOT EXISTS source_credentials (
  id text PRIMARY KEY,              -- public key_id prefix (e.g. "ubk_xxxx")
  source_id text NOT NULL REFERENCES telemetry_sources(id) ON DELETE CASCADE,
  label text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  hash text NOT NULL,               -- scrypt hash of secret portion
  salt text NOT NULL,               -- hex-encoded random salt
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

CREATE INDEX IF NOT EXISTS source_credentials_source_id_idx ON source_credentials (source_id);
CREATE INDEX IF NOT EXISTS source_credentials_revoked_idx ON source_credentials (id) WHERE revoked_at IS NULL;

-- ============================================================================
-- Simulation campaigns
-- ============================================================================

CREATE TABLE IF NOT EXISTS sim_campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  spec jsonb NOT NULL,              -- engine config / game spec template
  base_seed bigint NOT NULL DEFAULT 0,
  content_version text,
  total_games integer NOT NULL,
  completed_games integer NOT NULL DEFAULT 0,
  failed_games integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  cancelled_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS sim_campaigns_status_idx ON sim_campaigns (status);

-- ============================================================================
-- Simulation jobs (transient, one per game)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sim_jobs (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES sim_campaigns(id) ON DELETE CASCADE,
  game_index integer NOT NULL,
  seed bigint NOT NULL,
  spec jsonb NOT NULL,              -- per-game spec (may include overrides)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'failed')),
  lease_token text,
  leased_by text,                   -- credential id that claimed it
  leased_at timestamptz,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, game_index)
);

CREATE INDEX IF NOT EXISTS sim_jobs_claim_idx ON sim_jobs (status, lease_expires_at)
  WHERE status IN ('pending', 'leased');
CREATE INDEX IF NOT EXISTS sim_jobs_campaign_idx ON sim_jobs (campaign_id, status);

-- Add source_id to game_submissions for credential-based attribution
ALTER TABLE game_submissions ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE game_submissions ADD COLUMN IF NOT EXISTS campaign_id text;

-- Add campaign provenance to games
ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_id text;
ALTER TABLE games ADD COLUMN IF NOT EXISTS campaign_game_index integer;

CREATE INDEX IF NOT EXISTS games_campaign_idx ON games (campaign_id) WHERE campaign_id IS NOT NULL;
