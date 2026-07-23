-- 008_job_journal.sql
-- Crash-resilient game resume (engine #255): the worker piggybacks its
-- per-decision action journal on the lease heartbeat; we store it on the job
-- row and hand it back in the claim response, so after a hard kill (SIGKILL /
-- OOM / power loss) ANY same-build machine can resume the game instead of
-- re-running an hour of search from scratch.
--
-- The journal is an opaque worker-owned blob ({v, workerVersion, stateHash,
-- entries}); the control plane never inspects it. Lifecycle: written on
-- heartbeat, survives lease expiry + reclaim (that is the point), deleted with
-- the row on completion, cleared on fail (a failed game's journal may be the
-- poison that failed it).

ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS journal jsonb;
ALTER TABLE sim_jobs ADD COLUMN IF NOT EXISTS journal_updated_at timestamptz;
