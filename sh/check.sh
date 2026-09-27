#!/bin/sh
# Compares the live project with config.env and policy/. Read-only; runs every check and exits 1 if any failed.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

[ $# -eq 0 ] || die "usage: ${0##*/}"
require_tools
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

# Job
job=$(describe_job) || die "job $JOB not found; run deploy.sh"
require_json "$job" "job $JOB"
task='.spec.template.spec.template.spec'
expect "job service account" "$(json_field "$job" "$task.serviceAccountName")" "$KEEPER_SA"
expect "job task timeout" "$(json_field "$job" "$task.timeoutSeconds | tostring")" "$TASK_TIMEOUT"
expect "job max retries" "$(json_field "$job" "$task.maxRetries | tostring")" "$MAX_RETRIES"
expect "job task count" "$(json_field "$job" ".spec.template.spec.taskCount | tostring")" "1"
expect "job containers" "$(json_field "$job" "$task.containers | length | tostring")" "1"
expect "job env" "$(json_field "$job" "[$task.containers[0].env[]? | select(.value != null) | \"\(.name)=\(.value)\"] | sort | join(\"|\")")" \
  "$(jq -nr --arg vars "${ENV_VARS#^|^}" '$vars | split("|") | sort | join("|")')"
expect "job secrets" "$(json_field "$job" "[$task.containers[0].env[]? | select(.valueFrom != null) | \"\(.name)=\(.valueFrom.secretKeyRef.name):\(.valueFrom.secretKeyRef.key)\"] | join(\"|\")")" \
  "$SECRETS"

live_policy=$(get_iam "$JOB" "--region=$REGION --project=$KEEPER_PROJECT" run jobs)
if policy_differs "$live_policy" "$(render_policy job.iam.json.tmpl)"; then
  fail "job IAM policy differs from template"
  show_policy_diff
else
  ok "job IAM policy matches template"
fi

# Schedules
while IFS="$TAB" read -r name cron; do
  if ! scheduler=$(describe_scheduler "$name"); then
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
stale=$(stale_schedulers)
if [ -z "$stale" ]; then ok "no stale scheduler job"; else fail "stale scheduler jobs: $stale"; fi

# Secret
if [ "$(secret_versions)" -gt 0 ]; then ok "$RPC_SECRET has an enabled version"; else fail "$RPC_SECRET has no enabled version"; fi
live_policy=$(get_iam "$RPC_SECRET" "--project=$KEEPER_PROJECT" secrets)
if policy_differs "$live_policy" "$(render_policy secret.iam.json.tmpl)"; then
  fail "secret IAM policy differs from template"
  show_policy_diff
else
  ok "secret IAM policy matches template"
fi

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
