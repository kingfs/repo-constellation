#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
OUTPUT=${1:-"postgres-backup-$(date -u +%Y%m%dT%H%M%SZ).dump"}
"$SCRIPT_DIR/compose.sh" exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' >"$OUTPUT"
test -s "$OUTPUT"
echo "$OUTPUT"
