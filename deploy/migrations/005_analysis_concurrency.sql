CREATE TABLE IF NOT EXISTS analysis_concurrency_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  current_limit integer NOT NULL CHECK (current_limit > 0),
  last_adjusted_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  p95_seconds double precision,
  backlog integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
