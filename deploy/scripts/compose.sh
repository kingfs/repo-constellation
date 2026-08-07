#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(dirname "$(dirname "$script_dir")")

project_args=""
if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then project_args="-p $COMPOSE_PROJECT_NAME"; fi
if [ -n "${DOCKER_HOST:-}" ]; then
  exec env -i HOME="${HOME:-}" PATH="$PATH" DOCKER_HOST="$DOCKER_HOST" \
    docker compose $project_args --project-directory "$repo_root" --env-file "$repo_root/.env" "$@"
fi
exec env -i HOME="${HOME:-}" PATH="$PATH" \
  docker compose $project_args --project-directory "$repo_root" --env-file "$repo_root/.env" "$@"
