CREATE TABLE control_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation text NOT NULL CHECK (operation IN ('sync', 'curate')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  leased_until timestamptz,
  worker_id text,
  result jsonb,
  error text,
  CHECK (status <> 'running' OR (leased_until IS NOT NULL AND worker_id IS NOT NULL)),
  CHECK (status NOT IN ('succeeded', 'failed') OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX control_runs_one_active_operation_idx ON control_runs(operation) WHERE status IN ('pending', 'running');
CREATE INDEX control_runs_recent_idx ON control_runs(requested_at DESC);
