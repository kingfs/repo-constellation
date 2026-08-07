CREATE TABLE agent_search_runs (
  id uuid PRIMARY KEY,
  query text NOT NULL CHECK (query <> ''),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  answer jsonb,
  error text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'running' OR completed_at IS NOT NULL)
);

CREATE TABLE agent_search_events (
  run_id uuid NOT NULL REFERENCES agent_search_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  type text NOT NULL CHECK (type IN ('run.started', 'search.started', 'search.completed', 'candidates.compared', 'answer.completed', 'run.failed')),
  occurred_at timestamptz NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (run_id, sequence)
);

CREATE INDEX agent_search_runs_created_idx ON agent_search_runs(created_at DESC);
CREATE INDEX agent_search_runs_status_idx ON agent_search_runs(status, updated_at);

CREATE TABLE operational_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type text NOT NULL CHECK (check_type IN ('index_consistency', 'backup_restore', 'upgrade')),
  status text NOT NULL CHECK (status IN ('passed', 'failed')),
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operational_checks_type_checked_idx ON operational_checks(check_type, checked_at DESC);
