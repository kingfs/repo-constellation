#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
compose="$SCRIPT_DIR/compose.sh"

# Exercise the real Compose network without requiring PostgreSQL to be exposed
# on the host. Two one-shot migrators verify that the advisory lock serializes
# concurrent migration attempts.
"$compose" run --rm --no-deps migrate &
first_pid=$!
"$compose" run --rm --no-deps migrate &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
"$compose" run --rm --no-deps migrate

# Remove the fixed fixture persisted by older, non-transactional versions of
# schema.sql. The current schema test below rolls back all of its writes.
"$compose" exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "DELETE FROM repositories WHERE github_id=123 AND full_name='\''owner/repo'\''"' \
  >/dev/null

"$compose" exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < test/schema.sql

health=$("$compose" exec -T meilisearch wget -qO- http://127.0.0.1:7700/health)
case "$health" in
  *'"status":"available"'*) ;;
  *) echo "unexpected Meilisearch health response: $health" >&2; exit 1 ;;
esac

echo "compose infrastructure smoke test passed"
