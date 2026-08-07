BEGIN;
DELETE FROM repositories WHERE github_id = 123;

DO $$
DECLARE
  repo_id uuid;
  snapshot_id uuid;
BEGIN
  INSERT INTO repositories(github_id, full_name, owner, name, html_url, starred_at)
  VALUES (123, 'owner/repo', 'owner', 'repo', 'https://github.com/owner/repo', now())
  RETURNING id INTO repo_id;

  INSERT INTO repository_snapshots(repository_id, content_hash)
  VALUES (repo_id, 'sha256:first') RETURNING id INTO snapshot_id;

  UPDATE repositories SET current_snapshot_id = snapshot_id WHERE id = repo_id;

  INSERT INTO repository_analyses(
    repository_id, snapshot_id, content_hash, analysis_version, model,
    summary_zh, analysis_json
  ) VALUES (repo_id, snapshot_id, 'sha256:first', 'v1', 'test', '摘要', '{}');

  INSERT INTO jobs(type, repository_id, dedupe_key)
  VALUES ('analyze_repository', repo_id, 'analyze:' || repo_id || ':sha256:first:v1');

  INSERT INTO outbox_events(topic, aggregate_type, aggregate_id, dedupe_key)
  VALUES ('github.repository.changed', 'repository', repo_id, 'changed:' || repo_id || ':sha256:first');

  INSERT INTO query_feedback(query_id, query_text, result_repository_ids, rating)
  VALUES (gen_random_uuid(), 'git diff 工具', ARRAY[repo_id], 1);

  INSERT INTO agent_search_runs(id, query, status, created_at)
  VALUES (gen_random_uuid(), 'git diff 工具', 'running', now()) RETURNING id INTO snapshot_id;
  INSERT INTO agent_search_events(run_id, sequence, type, occurred_at, data)
  VALUES (snapshot_id, 1, 'run.started', now(), '{}');
  UPDATE agent_search_runs SET status='completed', completed_at=now() WHERE id=snapshot_id;
  INSERT INTO operational_checks(check_type, status, details)
  VALUES ('index_consistency', 'passed', '{}');

  BEGIN
    INSERT INTO repository_snapshots(repository_id, content_hash)
    VALUES (repo_id, 'sha256:first');
    RAISE EXCEPTION 'snapshot idempotency constraint did not reject duplicate';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jobs(type, repository_id, dedupe_key)
    VALUES ('analyze_repository', repo_id, 'analyze:' || repo_id || ':sha256:first:v1');
    RAISE EXCEPTION 'job idempotency constraint did not reject duplicate';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO repository_analyses(
      repository_id, snapshot_id, content_hash, analysis_version, model,
      summary_zh, analysis_json, confidence
    ) VALUES (repo_id, snapshot_id, 'sha256:second', 'v1', 'test', '摘要', '{}', 2);
    RAISE EXCEPTION 'analysis confidence constraint did not reject invalid value';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

SELECT 1 / CASE WHEN (
  SELECT count(*) = 10 FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('repositories', 'repository_snapshots', 'repository_analyses', 'jobs', 'outbox_events', 'query_feedback', 'control_runs', 'agent_search_runs', 'agent_search_events', 'operational_checks')
) THEN 1 ELSE 0 END AS all_domain_tables_exist;

SELECT 1 / CASE WHEN NOT EXISTS (
  SELECT required.name
  FROM (VALUES
    ('repositories_next_check_idx'),
    ('repositories_active_star_idx'),
    ('repository_snapshots_repository_fetched_idx'),
    ('repository_analyses_repository_analyzed_idx'),
    ('jobs_claim_idx'),
    ('jobs_lease_expiry_idx'),
    ('outbox_pending_idx'),
    ('query_feedback_query_idx'),
    ('agent_search_runs_status_idx'),
    ('operational_checks_type_checked_idx')
  ) AS required(name)
  LEFT JOIN pg_indexes actual
    ON actual.schemaname = 'public' AND actual.indexname = required.name
  WHERE actual.indexname IS NULL
) THEN 1 ELSE 0 END AS critical_indexes_exist;

ROLLBACK;
