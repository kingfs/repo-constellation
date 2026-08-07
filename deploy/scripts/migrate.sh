#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  : "${PGHOST:?DATABASE_URL or PGHOST is required}"
  : "${PGUSER:?PGUSER is required}"
  : "${PGPASSWORD:?PGPASSWORD is required}"
  : "${PGDATABASE:?PGDATABASE is required}"
fi
MIGRATIONS_DIR=${MIGRATIONS_DIR:-"$(CDPATH='' cd -- "$(dirname -- "$0")/../migrations" && pwd)"}

command -v psql >/dev/null 2>&1 || {
  echo "psql is required" >&2
  exit 127
}

plan=$(mktemp)
trap 'rm -f "$plan"' EXIT HUP INT TERM

cat >"$plan" <<'SQL'
\set ON_ERROR_STOP on
SELECT pg_advisory_lock(hashtextextended('github-stars-platform:migrations', 0));

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  version=$(basename "$migration" .sql)
  case "$version" in
    *[!A-Za-z0-9_.-]*)
      echo "invalid migration filename: $migration" >&2
      exit 1
      ;;
  esac
  checksum=$(sha256sum "$migration" | awk '{print $1}')
  absolute_migration=$(CDPATH='' cd -- "$(dirname -- "$migration")" && pwd)/$(basename "$migration")
  {
    printf '%s\n' "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '$version' AND checksum <> '$checksum') AS checksum_mismatch \\gset"
    printf '%s\n' '\if :checksum_mismatch'
    printf '%s\n' "  \\echo 'migration $version checksum mismatch'"
    printf '%s\n' '  \quit 3'
    printf '%s\n' '\endif'
    printf '%s\n' "SELECT NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '$version') AS apply_migration \\gset"
    printf '%s\n' '\if :apply_migration'
    printf '%s\n' "  \\echo 'applying migration $version'"
    echo '  BEGIN;'
    printf '%s\n' "  \\ir '$absolute_migration'"
    printf "  INSERT INTO schema_migrations(version, checksum) VALUES ('%s', '%s');\n" "$version" "$checksum"
    echo '  COMMIT;'
    printf '%s\n' '\else'
    printf '%s\n' "  \\echo 'migration $version already applied'"
    printf '%s\n' '\endif'
  } >>"$plan"
done

cat >>"$plan" <<'SQL'
SELECT pg_advisory_unlock(hashtextextended('github-stars-platform:migrations', 0));
SQL

# One psql session holds the session-level lock across discovery, checksum
# validation and every migration transaction.
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -f "$plan"
else
  psql -f "$plan"
fi
