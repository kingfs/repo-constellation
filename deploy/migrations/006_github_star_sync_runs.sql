CREATE TABLE IF NOT EXISTS github_star_sync_runs (
  id uuid PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('daily', 'manual')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  observed_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS github_star_sync_runs_source_started_idx
  ON github_star_sync_runs(source, started_at DESC);

CREATE INDEX IF NOT EXISTS github_star_sync_runs_daily_success_idx
  ON github_star_sync_runs(started_at DESC)
  WHERE source = 'daily' AND status = 'succeeded';
