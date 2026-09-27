#!/bin/sh
# check.sh: live state vs config.env and policy/. Read-only.
# Runs every check; exits 1 if any failed.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

[ $# -eq 0 ] || die "usage: ${0##*/}"
require_tools
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"
load_config
make_tmp

failed=0
fail() {
  log "FAIL: $*"
  failed=1
}
ok() { log "ok: $*"; }
# expect LABEL ACTUAL EXPECTED
expect() {
  if [ "$2" = "$3" ]; then ok "$1 is $3"; else fail "$1 is ${2:-unset}, expected $3"; fi
}
# expect_policy LABEL LIVE TEMPLATE
expect_policy() {
  if policy_differs "$2" "$(render_policy "$3")"; then
    fail "$1 IAM policy differs from template"
    show_policy_diff
  else
    ok "$1 IAM policy matches template"
  fi
}

# Job
job=$(job_exists) || die "job $JOB not found; run deploy.sh"
require_json "$job" "job $JOB"
task='.spec.template.spec.template.spec'
expect "job service account" "$(json_field "$job" "$task.serviceAccountName")" "$KEEPER_SA"
expect "job task timeout" "$(json_field "$job" "$task.timeoutSeconds | tostring")" "$TASK_TIMEOUT"
expect "job max retries" "$(json_field "$job" "$task.maxRetries | tostring")" "$MAX_RETRIES"
expect "job task count" "$(json_field "$job" ".spec.template.spec.taskCount | tostring")" "1"
expect "job containers" "$(json_field "$job" "$task.containers | length | tostring")" "1"
expect "job env" "$(json_field "$job" "[$task.containers[0].env[]? | select(.value != null) | \"\(.name)=\(.value)\"] | sort | join(\"|\")")" \
  "KMS_KEY_VERSION=$KMS_KEY_VERSION|MODULE=$MODULE|VOTE_OFFSETS=$VOTE_OFFSETS"
expect "job secrets" "$(json_field "$job" "[$task.containers[0].env[]? | select(.valueFrom != null) | \"\(.name)=\(.valueFrom.secretKeyRef.name):\(.valueFrom.secretKeyRef.key)\"] | join(\"|\")")" \
  "$SECRETS"

live_policy=$(get_iam "$JOB" "--region=$REGION --project=$KEEPER_PROJECT" run jobs)
expect_policy job "$live_policy" job.iam.json.tmpl

# Schedules
while IFS="$TAB" read -r name cron; do
  if ! scheduler=$(scheduler_exists "$name"); then
    fail "scheduler job $name not found; run deploy.sh"
    continue
  fi
  require_json "$scheduler" "scheduler job $name"
  expect "$name schedule" "$(json_field "$scheduler" .schedule)" "$cron"
  expect "$name time zone" "$(json_field "$scheduler" .timeZone)" "Etc/UTC"
  expect "$name target" "$(json_field "$scheduler" .httpTarget.uri)" "$RUN_URI"
  expect "$name method" "$(json_field "$scheduler" .httpTarget.httpMethod)" "POST"
  expect "$name service account" "$(json_field "$scheduler" .httpTarget.oauthToken.serviceAccountEmail)" "$SCHEDULER_SA"
  expect "$name state" "$(json_field "$scheduler" .state)" "ENABLED"
done <<LIST
$(schedules)
LIST
find_stale_schedulers
stale=$(printf '%s\n' "$STALE" | paste -sd ' ' -)
if [ -z "$stale" ]; then ok "no stale scheduler job"; else fail "stale scheduler jobs: $stale"; fi

# Secret
versions=$(secret_versions)
if [ "$versions" -gt 0 ]; then ok "$RPC_SECRET has an enabled version"; else fail "$RPC_SECRET has no enabled version"; fi
live_policy=$(get_iam "$RPC_SECRET" "--project=$KEEPER_PROJECT" secrets)
expect_policy secret "$live_policy" secret.iam.json.tmpl

# Service accounts: no downloadable key, nobody can impersonate the keeper, no project-level role.
sa_keys=$(gcloud iam service-accounts keys list --iam-account="$KEEPER_SA" --managed-by=user --format=json) ||
  die "cannot list keys of $KEEPER_SA"
require_json "$sa_keys" "key list of $KEEPER_SA"
sa_key_ids=$(printf '%s\n' "$sa_keys" | jq -r '[.[].name | split("/") | last] | join(" ")')
if [ -z "$sa_key_ids" ]; then ok "$KEEPER_SA has no user-managed keys"; else fail "$KEEPER_SA has user-managed keys: $sa_key_ids"; fi
sa_policy=$(get_iam "$KEEPER_SA" "--project=$KEEPER_PROJECT" iam service-accounts)
sa_bindings=$(json_field "$sa_policy" '[.bindings[]? | "\(.role):\(.members | join(","))"] | join(" ")')
if [ -z "$sa_bindings" ]; then ok "nobody can act as $KEEPER_SA"; else fail "$KEEPER_SA has IAM bindings: $sa_bindings"; fi
project_policy=$(get_iam "$KEEPER_PROJECT" "" projects)
for sa in "$KEEPER_SA" "$SCHEDULER_SA"; do
  roles=$(json_field "$project_policy" "[.bindings[]? | select(.members | index(\"serviceAccount:$sa\")) | .role] | join(\" \")")
  if [ -z "$roles" ]; then ok "$sa has no project-level role"; else fail "$sa has project-level roles: $roles"; fi
done

# Keeper balance: KEEPER() on the module, then its ETH.
keeper_word=$(rpc eth_call "[{\"to\":\"$MODULE\",\"data\":\"0x862a179e\"},\"latest\"]")
keeper=0x$(printf '%s' "$keeper_word" | tail -c 40)
balance_hex=$(rpc eth_getBalance "[\"$keeper\",\"latest\"]")
balance_digits=$(printf '%s' "${balance_hex#0x}" | sed 's/^0*//')
if [ "${#balance_digits}" -gt 15 ]; then
  ok "keeper $keeper holds over 1 ETH"
else
  balance_wei=$(printf '%d' "0x${balance_digits:-0}")
  balance_eth=$(awk "BEGIN { printf \"%.6f\", $balance_wei / 1e18 }")
  if [ "$balance_wei" -ge "$MIN_KEEPER_WEI" ]; then ok "keeper $keeper holds $balance_eth ETH"; else fail "keeper $keeper holds $balance_eth ETH, under 0.0005; fund it"; fi
fi

# Alert
channel=$(find_channel)
alert=$(find_alert)
if [ -z "$channel" ]; then
  fail "no email channel for $ALERT_EMAIL"
elif [ -z "$alert" ]; then
  fail "alert policy \"$ALERT_NAME\" missing"
else
  expect "alert enabled" "$(json_field "$alert" '.enabled | tostring')" "true"
  if [ "$(json_field "$alert" ".notificationChannels | index(\"$channel\") != null")" = true ]; then
    ok "alert notifies $ALERT_EMAIL"
  else
    fail "alert does not notify $ALERT_EMAIL"
  fi
  expect "alert filter" "$(json_field "$alert" '.conditions[0].conditionThreshold.filter')" "$ALERT_FILTER"
fi

[ "$failed" -ne 0 ] || log "all checks passed"
exit "$failed"
