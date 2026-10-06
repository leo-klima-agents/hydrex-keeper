#!/bin/sh
# Compares the live project with config.env and policy/. Read-only; runs every check, exits 1 if any failed.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

[ $# -eq 0 ] || die "usage: ${0##*/}"
require_tools gcloud jq curl
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
job=$(describe_job) || die "job $JOB not found; run deploy.sh"
require_json "$job" "job $JOB"
task='.spec.template.spec.template.spec'
expect "job service account" "$(json_field "$job" "$task.serviceAccountName")" "$KEEPER_SA"
expect "job task timeout" "$(json_field "$job" "$task.timeoutSeconds | tostring")" "$TASK_TIMEOUT"
expect "job max retries" "$(json_field "$job" "$task.maxRetries | tostring")" "$MAX_RETRIES"
expect "job task count" "$(json_field "$job" ".spec.template.spec.taskCount | tostring")" "1"
expect "job containers" "$(json_field "$job" "$task.containers | length | tostring")" "1"
container_env=$(json_field "$job" "[$task.containers[0].env[]?] | tojson")
env_vars=$(json_field "$container_env" '[.[] | select(.value) | "\(.name)=\(.value)"] | sort | join(",")')
secrets=$(json_field "$container_env" '[.[] | select(.valueFrom) | "\(.name)=\(.valueFrom.secretKeyRef | "\(.name):\(.key)")"] | sort | join(",")')
expect "job env" "$env_vars" "$ENV_VARS"
expect "job secrets" "$secrets" "$SECRETS"

job_policy=$(get_iam "$JOB" "--region=$REGION --project=$KEEPER_PROJECT" run jobs)
expect_policy job "$job_policy" job.iam.json.tmpl

# Schedule
if scheduler=$(describe_scheduler "$SCHEDULER"); then
  require_json "$scheduler" "scheduler job $SCHEDULER"
  expect "$SCHEDULER schedule" "$(json_field "$scheduler" .schedule)" "$SCHEDULE"
  expect "$SCHEDULER time zone" "$(json_field "$scheduler" .timeZone)" "Etc/UTC"
  expect "$SCHEDULER target" "$(json_field "$scheduler" .httpTarget.uri)" "$RUN_URI"
  expect "$SCHEDULER method" "$(json_field "$scheduler" .httpTarget.httpMethod)" "POST"
  expect "$SCHEDULER service account" "$(json_field "$scheduler" .httpTarget.oauthToken.serviceAccountEmail)" "$SCHEDULER_SA"
  expect "$SCHEDULER state" "$(json_field "$scheduler" .state)" "ENABLED"
  retry='.retryConfig | "--max-retry-attempts=\(.retryCount // 0) --min-backoff=\(.minBackoffDuration)'
  retry="$retry"' --max-backoff=\(.maxBackoffDuration) --max-doublings=\(.maxDoublings) --max-retry-duration=\(.maxRetryDuration)"'
  expect "$SCHEDULER retries" "$(json_field "$scheduler" "$retry")" "$SCHEDULER_RETRY_FLAGS"
else
  fail "scheduler job $SCHEDULER not found; run deploy.sh"
fi
stale=$(stale_schedulers)
if [ -z "$stale" ]; then ok "no stale scheduler job"; else fail "stale scheduler jobs: $stale"; fi

# Secrets
for secret in $SECRET_NAMES; do
  if has_version "$secret"; then ok "$secret has an enabled version"; else fail "$secret has no enabled version"; fi
  secret_policy=$(get_iam "$secret" "--project=$KEEPER_PROJECT" secrets)
  expect_policy "$secret" "$secret_policy" secret.iam.json.tmpl
done

# Service accounts
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

# Keeper balance: the module's KEEPER(), then its ETH.
keeper=$(rpc eth_call "[{\"to\":\"$MODULE\",\"data\":\"0x862a179e\"},\"latest\"]")
keeper=0x$(printf '%s' "$keeper" | tail -c 40)
balance=$(rpc eth_getBalance "[\"$keeper\",\"latest\"]")
balance=$(printf '%s' "${balance#0x}" | sed 's/^0*//')
if [ ${#balance} -gt 15 ]; then # over 1 ETH, and too large for shell arithmetic
  ok "keeper $keeper holds over 1 ETH"
else
  balance=$((0x${balance:-0}))
  eth=$(awk "BEGIN { printf \"%.4f\", $balance / 1e18 }")
  if [ "$balance" -ge "$MIN_KEEPER_WEI" ]; then ok "keeper $keeper holds $eth ETH"; else fail "keeper $keeper holds $eth ETH; fund it"; fi
fi

# Alerts
channel=$(find_channel "$KEEPER_PROJECT")
[ -n "$channel" ] || fail "no email channel for $ALERT_EMAIL"
# expect_alert PROJECT NAME FILTER
expect_alert() {
  alert=$(find_alert "$1" "$2")
  if [ -z "$alert" ]; then
    fail "alert policy \"$2\" missing"
    return 0
  fi
  expect "\"$2\" enabled" "$(json_field "$alert" '.enabled | tostring')" "true"
  if [ -n "$channel" ] && [ "$(json_field "$alert" ".notificationChannels | index(\"$channel\") != null")" = true ]; then
    ok "\"$2\" notifies $ALERT_EMAIL"
  else
    fail "\"$2\" does not notify $ALERT_EMAIL"
  fi
  expect "\"$2\" filter" "$(json_field "$alert" '.conditions[0] | (.conditionThreshold // .conditionMatchedLog).filter')" "$3"
}
expect_alert "$KEEPER_PROJECT" "$ALERT_NAME" "$ALERT_FILTER"
expect_alert "$KEEPER_PROJECT" "$START_ALERT_NAME" "$START_ALERT_FILTER"

[ "$failed" -ne 0 ] || log "all checks passed"
exit "$failed"
