CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id bigint NOT NULL UNIQUE CHECK (github_id > 0),
  full_name text NOT NULL UNIQUE CHECK (full_name ~ '^[^/]+/[^/]+$'),
  owner text NOT NULL CHECK (owner <> ''),
  name text NOT NULL CHECK (name <> ''),
  html_url text NOT NULL CHECK (html_url <> ''),
  description text,
  homepage text,
  default_branch text,
  primary_language text,
  topics text[] NOT NULL DEFAULT '{}',
  license_spdx text,
  stars_count integer NOT NULL DEFAULT 0 CHECK (stars_count >= 0),
  forks_count integer NOT NULL DEFAULT 0 CHECK (forks_count >= 0),
  open_issues_count integer NOT NULL DEFAULT 0 CHECK (open_issues_count >= 0),
  github_created_at timestamptz,
  github_updated_at timestamptz,
  pushed_at timestamptz,
  starred_at timestamptz NOT NULL,
  unstarred_at timestamptz,
  archived boolean NOT NULL DEFAULT false,
  disabled boolean NOT NULL DEFAULT false,
  has_wiki boolean NOT NULL DEFAULT false,
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  activity_class text NOT NULL DEFAULT 'active'
    CHECK (activity_class IN ('hot', 'active', 'quiet', 'stale', 'archived')),
  last_checked_at timestamptz,
  next_check_at timestamptz,
  current_snapshot_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (unstarred_at IS NULL OR unstarred_at >= starred_at)
);

CREATE TABLE repository_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  content_hash text NOT NULL CHECK (content_hash <> ''),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  readme_text text,
  readme_etag text,
  release_text text,
  release_etag text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, content_hash),
  UNIQUE (id, repository_id)
);

ALTER TABLE repositories
  ADD CONSTRAINT repositories_current_snapshot_fk
  FOREIGN KEY (current_snapshot_id, id)
  REFERENCES repository_snapshots(id, repository_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE repository_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash <> ''),
  analysis_version text NOT NULL CHECK (analysis_version <> ''),
  model text NOT NULL CHECK (model <> ''),
  name_zh text,
  summary_zh text NOT NULL CHECK (summary_zh <> ''),
  categories text[] NOT NULL DEFAULT '{}',
  keywords text[] NOT NULL DEFAULT '{}',
  aliases text[] NOT NULL DEFAULT '{}',
  use_cases text[] NOT NULL DEFAULT '{}',
  problems_solved text[] NOT NULL DEFAULT '{}',
  target_users text[] NOT NULL DEFAULT '{}',
  technologies text[] NOT NULL DEFAULT '{}',
  maturity text,
  maintenance_status text,
  limitations text[] NOT NULL DEFAULT '{}',
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  analysis_json jsonb NOT NULL CHECK (jsonb_typeof(analysis_json) = 'object'),
  analyzed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (snapshot_id, repository_id)
    REFERENCES repository_snapshots(id, repository_id) ON DELETE CASCADE,
  UNIQUE (repository_id, content_hash, analysis_version)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('refresh_repository', 'analyze_repository', 'index_repository')),
  repository_id uuid REFERENCES repositories(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key <> ''),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  leased_by text,
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (attempts <= max_attempts),
  CHECK ((leased_until IS NULL) = (leased_by IS NULL)),
  CHECK (status <> 'running' OR leased_until IS NOT NULL),
  CHECK (status NOT IN ('succeeded', 'dead') OR completed_at IS NOT NULL)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (topic <> ''),
  aggregate_type text NOT NULL CHECK (aggregate_type <> ''),
  aggregate_id uuid,
  dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key <> ''),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text
);

CREATE TABLE query_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL,
  query_text text NOT NULL CHECK (query_text <> ''),
  result_repository_ids uuid[] NOT NULL DEFAULT '{}',
  selected_repository_id uuid REFERENCES repositories(id) ON DELETE SET NULL,
  rating smallint CHECK (rating IN (-1, 1)),
  action text CHECK (action IN ('click', 'favorite', 'helpful', 'unhelpful')),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX repositories_next_check_idx ON repositories (next_check_at)
  WHERE unstarred_at IS NULL;
CREATE INDEX repositories_pushed_at_idx ON repositories (pushed_at DESC NULLS LAST);
CREATE INDEX repositories_activity_class_idx ON repositories (activity_class);
CREATE INDEX repositories_starred_at_idx ON repositories (starred_at DESC);
CREATE INDEX repositories_active_star_idx ON repositories (github_id)
  WHERE unstarred_at IS NULL;
CREATE INDEX repository_snapshots_repository_fetched_idx
  ON repository_snapshots (repository_id, fetched_at DESC);
CREATE INDEX repository_analyses_repository_analyzed_idx
  ON repository_analyses (repository_id, analyzed_at DESC);
CREATE INDEX jobs_claim_idx ON jobs (type, priority DESC, available_at, created_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX jobs_lease_expiry_idx ON jobs (leased_until)
  WHERE status = 'running';
CREATE INDEX outbox_pending_idx ON outbox_events (available_at, occurred_at)
  WHERE published_at IS NULL;
CREATE INDEX query_feedback_query_idx ON query_feedback (query_id, created_at);
CREATE INDEX query_feedback_created_idx ON query_feedback (created_at DESC);
