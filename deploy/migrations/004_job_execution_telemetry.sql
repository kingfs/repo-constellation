ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_id text,
  ADD COLUMN IF NOT EXISTS last_sandbox_id text;

UPDATE jobs
SET started_at = COALESCE(started_at, created_at),
    last_heartbeat_at = COALESCE(last_heartbeat_at, created_at)
WHERE status = 'running';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_execution_times_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_execution_times_check
      CHECK (last_heartbeat_at IS NULL OR started_at IS NULL OR last_heartbeat_at >= started_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_last_run_id_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_last_run_id_check CHECK (last_run_id IS NULL OR last_run_id <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_last_sandbox_id_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_last_sandbox_id_check CHECK (last_sandbox_id IS NULL OR last_sandbox_id <> '');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS jobs_active_telemetry_idx
  ON jobs (started_at, leased_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_recent_failures_idx
  ON jobs (completed_at DESC NULLS FIRST, available_at DESC) WHERE status IN ('failed', 'dead');
CREATE INDEX IF NOT EXISTS jobs_pending_age_idx
  ON jobs (created_at) WHERE status = 'pending';
