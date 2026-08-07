#!/bin/sh
set -eu
: "${1:?usage: restore-drill.sh <backup.dump>}"
BACKUP=$1
test -s "$BACKUP"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
DRILL_DB="restore_drill_$(date +%s)_$$"
cleanup() { "$SCRIPT_DIR/compose.sh" exec -T postgres sh -c 'dropdb --if-exists --force -U "$POSTGRES_USER" "$1"' sh "$DRILL_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
"$SCRIPT_DIR/compose.sh" exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$DRILL_DB"
"$SCRIPT_DIR/compose.sh" exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-acl' sh "$DRILL_DB" <"$BACKUP"
"$SCRIPT_DIR/compose.sh" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM repositories; SELECT count(*) FROM schema_migrations;"' sh "$DRILL_DB" >/dev/null
echo "restore drill passed: $DRILL_DB"
