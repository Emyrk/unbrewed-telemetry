-- 010_sim_job_checkpoint.sql
-- Crash-resume support for long sim games (engine #255): workers journal each
-- game and push it via heartbeat; any machine that reclaims the job resumes
-- from the stored checkpoint. Stored verbatim ({ engineVersion, journal }),
-- last-write-wins, and deliberately survives lease expiry and failed→pending
-- resets. Completed jobs leave sim_jobs, so cleanup is free.

ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;
