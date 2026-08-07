#!/bin/sh
set -eu

: "${API_URL:?API_URL is required}"
: "${WEB_URL:?WEB_URL is required}"
: "${PLATFORM_AGENT_TOKEN:?PLATFORM_AGENT_TOKEN is required}"

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
E2E_RUN_ID=${E2E_RUN_ID:-"$(date +%s)$$"}
fixture=$(PLATFORM_API_URL="$API_URL" E2E_RUN_ID="$E2E_RUN_ID" node "$SCRIPT_DIR/platform-etl-fixture.cjs")
printf '%s' "$fixture" | jq -e '.collected.reconciled == 1 and .curated.curated >= 1' >/dev/null
repository_full_name=$(printf '%s' "$fixture" | jq -er '.repositoryFullName')
query_token=$(printf '%s' "$fixture" | jq -er '.queryToken')

attempt=0
while [ "$attempt" -lt 20 ]; do
  result=$(curl --fail --silent --show-error "$WEB_URL/api/v1/search?q=$query_token")
  if printf '%s' "$result" | jq -e --arg name "$repository_full_name" '.total >= 1 and any(.items[]; .project.fullName == $name)' >/dev/null; then
    run=$(curl --fail --silent --show-error -X POST "$WEB_URL/api/v1/agent/search" \
      -H 'Content-Type: application/json' --data "{\"query\":\"$query_token git diff tool\"}")
    run_id=$(printf '%s' "$run" | jq -er '.runId')
    events=$(curl --fail --silent --show-error "$WEB_URL/api/v1/agent/search/$run_id/events")
    printf '%s' "$events" | grep -q 'event: answer.completed'
    status=$(curl --fail --silent --show-error "$WEB_URL/api/v1/agent/search/$run_id")
    printf '%s' "$status" | jq -e --arg name "$repository_full_name" '.status == "completed" and any(.answer.recommendations[]; .project.fullName == $name)' >/dev/null
    result_ids=$(printf '%s' "$status" | jq -c '[.answer.recommendations[].project.id]')
    curl --fail --silent --show-error -X POST "$WEB_URL/api/v1/feedback" -H 'Content-Type: application/json' \
      --data "{\"queryId\":\"$run_id\",\"queryText\":\"$query_token git diff tool\",\"resultRepositoryIds\":$result_ids,\"rating\":1,\"action\":\"helpful\",\"metadata\":{\"source\":\"platform-e2e\"}}" >/dev/null
    curl --fail --silent --show-error "$WEB_URL/" >/dev/null
    echo "platform end-to-end smoke test passed"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "indexed repository did not become searchable" >&2
exit 1
