#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${MEILI_URL:?MEILI_URL is required}"

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Start two migrators against an empty database. The advisory lock must make
# one apply the migration and the other observe it as already applied.
"$SCRIPT_DIR/migrate.sh" &
first_pid=$!
"$SCRIPT_DIR/migrate.sh" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
"$SCRIPT_DIR/migrate.sh"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/../test/schema.sql"

health=$(curl --fail --silent --show-error "$MEILI_URL/health")
case "$health" in
  *'"status":"available"'*) ;;
  *) echo "unexpected Meilisearch health response: $health" >&2; exit 1 ;;
esac

echo "infrastructure smoke test passed"
