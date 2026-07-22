-- Priority tiers for simulation campaign scheduling.
-- Lower tier numbers run first. Campaigns in the same tier are claimed round-robin.
ALTER TABLE sim_campaigns ADD COLUMN IF NOT EXISTS priority_tier integer;
ALTER TABLE sim_campaigns ADD COLUMN IF NOT EXISTS priority_position integer;
ALTER TABLE sim_campaigns ADD COLUMN IF NOT EXISTS last_claimed_at timestamptz;

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id)::integer - 1 AS tier
  FROM sim_campaigns
  WHERE status IN ('active', 'paused')
)
UPDATE sim_campaigns AS campaign
SET priority_tier = ordered.tier,
    priority_position = 0
FROM ordered
WHERE campaign.id = ordered.id
  AND campaign.priority_tier IS NULL;

UPDATE sim_campaigns
SET priority_tier = 0,
    priority_position = 0
WHERE priority_tier IS NULL OR priority_position IS NULL;

ALTER TABLE sim_campaigns ALTER COLUMN priority_tier SET DEFAULT 0;
ALTER TABLE sim_campaigns ALTER COLUMN priority_tier SET NOT NULL;
ALTER TABLE sim_campaigns ALTER COLUMN priority_position SET DEFAULT 0;
ALTER TABLE sim_campaigns ALTER COLUMN priority_position SET NOT NULL;

CREATE INDEX IF NOT EXISTS sim_campaigns_schedule_idx
  ON sim_campaigns (status, priority_tier, priority_position);
