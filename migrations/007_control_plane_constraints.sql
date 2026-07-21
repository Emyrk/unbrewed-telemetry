-- Add durable control-plane provenance constraints after the initial tables exist.

ALTER TABLE game_submissions
  ADD CONSTRAINT game_submissions_source_id_fk
  FOREIGN KEY (source_id) REFERENCES telemetry_sources(id) ON DELETE SET NULL;

ALTER TABLE game_submissions
  ADD CONSTRAINT game_submissions_campaign_id_fk
  FOREIGN KEY (campaign_id) REFERENCES sim_campaigns(id) ON DELETE SET NULL;

ALTER TABLE games
  ADD CONSTRAINT games_campaign_id_fk
  FOREIGN KEY (campaign_id) REFERENCES sim_campaigns(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS games_campaign_game_idx
  ON games (campaign_id, campaign_game_index)
  WHERE campaign_id IS NOT NULL;
