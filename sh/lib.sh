#!/bin/sh
# Sourced by the scripts in sh/.
# shellcheck disable=SC2034

# cloudkms: the job signs with a key in another project, which needs the API enabled in both.
# cloudresourcemanager, iamcredentials, sts: CI's Workload Identity Federation and check.sh.
SERVICES="artifactregistry.googleapis.com cloudbuild.googleapis.com cloudkms.googleapis.com
cloudresourcemanager.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com iamcredentials.googleapis.com
logging.googleapis.com monitoring.googleapis.com run.googleapis.com secretmanager.googleapis.com sts.googleapis.com"
TASK_TIMEOUT=5400 # seconds
MAX_RETRIES=3
# Cloud Scheduler retries a failed start after 15, 30 and 60 s: within 5 minutes, before the first pass.
SCHEDULER_RETRY_FLAGS="--max-retry-attempts=3 --min-backoff=15s --max-backoff=60s --max-doublings=2 --max-retry-duration=300s"
ALERT_METRIC=run.googleapis.com/job/completed_task_attempt_count
HORIZON=3600                   # seconds; HORIZON in src/schedule.ts
MIN_LEAD=120                   # seconds; over PREPARE_S in src/main.ts: the last blocks' execution starts this long before the flip
FLIP_WEEKDAY=4                 # Thursday 00:00 UTC
MIN_KEEPER_WEI=500000000000000 # 0.0005 ETH: weeks of votes; check.sh fails below it
# PUBLIC_RPCS in src/main.ts; check.sh reads the keeper's balance from the first that answers.
PUBLIC_RPCS="https://mainnet.base.org https://base.drpc.org https://base-rpc.publicnode.com"
TAB=$(printf '\t')

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
POLICY_DIR=$REPO_ROOT/policy
CONFIG_FILE=${HYDREX_CONFIG:-$REPO_ROOT/config.env}

log() { printf '%s\n' "$*" >&2; }

die() {
  log "error: $*"
  exit 1
}

make_tmp() {
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# require_tools TOOL...: dies unless every TOOL is on PATH.
require_tools() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
}

load_config() {
  [ -f "$CONFIG_FILE" ] || die "$CONFIG_FILE missing; copy config.env.example"
  case "$CONFIG_FILE" in */*) ;; *) CONFIG_FILE=./$CONFIG_FILE ;; esac # else `.` searches PATH
  unset KEEPER_PROJECT REGION JOB KEEPER_SA_NAME SCHEDULER_SA_NAME KMS_KEY_VERSION MODULE VOTE_OFFSETS SCHEDULES \
    RPC_SECRET ALCHEMY_SECRET COINGECKO_SECRET ALERT_EMAIL
  # shellcheck source=/dev/null
  . "$CONFIG_FILE"
  REGION=${REGION:-us-central1}
  JOB=${JOB:-hydrex-keeper}
  KEEPER_SA_NAME=${KEEPER_SA_NAME:-hydrex-keeper}
  SCHEDULER_SA_NAME=${SCHEDULER_SA_NAME:-hydrex-keeper-scheduler}
  MODULE=${MODULE:-0x750973E0CB728C3112561Bc8E9b235afA9B17E81}
  VOTE_OFFSETS=${VOTE_OFFSETS:-86400}
  SCHEDULES=${SCHEDULES:-50 23 * * 2;40 23 * * 3}
  RPC_SECRET=${RPC_SECRET:-base-rpc-url}
  ALCHEMY_SECRET=${ALCHEMY_SECRET:-alchemy-api-key}
  COINGECKO_SECRET=${COINGECKO_SECRET:-}

  for required in KEEPER_PROJECT KMS_KEY_VERSION ALERT_EMAIL; do
    eval "value=\${$required:-}"
    [ -n "$value" ] || die "$required is not set in $CONFIG_FILE"
  done
  case "$KMS_KEY_VERSION" in
    projects/?*/locations/?*/keyRings/?*/cryptoKeys/?*/cryptoKeyVersions/?*) ;;
    *) die "KMS_KEY_VERSION must be a full cryptoKeyVersions resource name" ;;
  esac
  key_project=${KMS_KEY_VERSION#projects/}
  key_project=${key_project%%/*}
  [ "$key_project" != "$KEEPER_PROJECT" ] || die "the key must live in another project than KEEPER_PROJECT"
  case "$MODULE" in
    0x*[!0-9a-fA-F]*) die "MODULE must be a 20-byte hex address" ;;
    0x*) [ ${#MODULE} -eq 42 ] || die "MODULE must be a 20-byte hex address" ;;
    *) die "MODULE must be a 20-byte hex address" ;;
  esac
  case "$VOTE_OFFSETS" in
    "" | *[!0-9,]* | *,,* | ,* | *,) die "VOTE_OFFSETS must be comma-separated seconds" ;;
  esac
  case "$ALERT_EMAIL" in
    ?*@?*) ;;
    *) die "ALERT_EMAIL must be an email address" ;;
  esac
  case "$SCHEDULES" in
    "" | *";;"* | ";"* | *";") die "SCHEDULES must be cron expressions separated by ;" ;;
  esac
  starts=$(schedules | cut -f2 | while read -r cron; do schedule_start "$cron"; done)
  check_offsets_covered "$starts"
  check_flip_covered "$starts"

  KEEPER_SA=$KEEPER_SA_NAME@$KEEPER_PROJECT.iam.gserviceaccount.com
  SCHEDULER_SA=$SCHEDULER_SA_NAME@$KEEPER_PROJECT.iam.gserviceaccount.com
  RUN_URI=https://run.googleapis.com/v2/projects/$KEEPER_PROJECT/locations/$REGION/jobs/$JOB:run
  # Sorted by name, as check.sh reads them back; `|`-separated since VOTE_OFFSETS contains commas.
  ENV_VARS="KMS_KEY_VERSION=$KMS_KEY_VERSION|MODULE=$MODULE|VOTE_OFFSETS=$VOTE_OFFSETS"
  SECRETS="ALCHEMY_API_KEY=$ALCHEMY_SECRET:latest|BASE_RPC_URLS=$RPC_SECRET:latest"
  SECRET_NAMES="$RPC_SECRET $ALCHEMY_SECRET"
  if [ -n "$COINGECKO_SECRET" ]; then
    SECRETS="$SECRETS|COINGECKO_API_KEY=$COINGECKO_SECRET:latest"
    SECRET_NAMES="$SECRET_NAMES $COINGECKO_SECRET"
  fi
  ALERT_NAME="$JOB failed"
  ALERT_FILTER="metric.type=\"$ALERT_METRIC\" AND resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\" AND metric.labels.result=\"failed\""
  # Cloud Scheduler logs an AttemptFinished entry for each attempt to start the job, at ERROR if it failed.
  START_ALERT_NAME="$JOB start failed"
  START_ALERT_FILTER="resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=~\"^$JOB-[0-9]+\$\" AND jsonPayload.@type=\"type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished\" AND (severity>=ERROR OR httpRequest.status>=400)"
}

# render_policy FILE: policy/FILE with the service accounts filled in.
render_policy() {
  jq --arg keeper "$KEEPER_SA" --arg scheduler "$SCHEDULER_SA" '
    walk(if type == "string"
         then (split("${KEEPER_SA}") | join($keeper)) | (split("${SCHEDULER_SA}") | join($scheduler))
         else . end)
  ' "$POLICY_DIR/$1"
}

# json_field JSON FILTER: "" if null or absent.
json_field() {
  printf '%s\n' "$1" | jq -r "($2) // \"\"" || die "cannot parse JSON"
}

# require_json JSON LABEL: dies unless JSON parses.
require_json() {
  printf '%s\n' "$1" | jq -e . >/dev/null 2>&1 || die "$2 is not JSON: $1"
}

# Canonical policy: sorted bindings, without etag and version.
normalize_policy() {
  jq -S '{
    bindings: ((.bindings // [])
      | map({role, members: ((.members // []) | sort)} + (if .condition then {condition} else {} end))
      | sort_by([.role, ((.condition // {}) | tojson)]))
  }'
}

# policy_differs LIVE DESIRED. Leaves live_norm and desired_norm set.
policy_differs() {
  live_norm=$(printf '%s\n' "$1" | normalize_policy)
  desired_norm=$(printf '%s\n' "$2" | normalize_policy)
  [ "$live_norm" != "$desired_norm" ]
}

# Prints the diff from the last policy_differs.
show_policy_diff() {
  printf '%s\n' "$desired_norm" >"$TMP/expected.json"
  printf '%s\n' "$live_norm" >"$TMP/live.json"
  diff -u "$TMP/expected.json" "$TMP/live.json" | tail -n +3 >&2 || true
}

# get_iam RESOURCE FLAGS gcloud-subcommand...: FLAGS is one word-split string, "" for none.
get_iam() {
  iam_resource=$1
  iam_flags=$2
  shift 2
  # shellcheck disable=SC2086
  iam_json=$(gcloud "$@" get-iam-policy $iam_flags "$iam_resource" --format=json) || die "cannot read IAM policy of $iam_resource"
  require_json "$iam_json" "IAM policy of $iam_resource"
  printf '%s\n' "$iam_json"
}

# set_iam RESOURCE FLAGS DESIRED gcloud-subcommand...: writes DESIRED in full, with the live etag, unless it matches.
set_iam() {
  set_iam_resource=$1
  set_iam_flags=$2
  set_iam_desired=$3
  shift 3
  set_iam_live=$(get_iam "$set_iam_resource" "$set_iam_flags" "$@")
  if ! policy_differs "$set_iam_live" "$set_iam_desired"; then
    log "iam: $set_iam_resource unchanged"
    return 0
  fi
  set_iam_etag=$(printf '%s\n' "$set_iam_live" | jq -r '.etag // empty')
  printf '%s\n' "$set_iam_desired" | jq --arg etag "$set_iam_etag" '.etag = $etag' >"$TMP/policy.json"
  log "iam: writing $set_iam_resource"
  # shellcheck disable=SC2086
  gcloud "$@" set-iam-policy $set_iam_flags "$set_iam_resource" "$TMP/policy.json" >/dev/null
}

# find_channel PROJECT: name of PROJECT's email notification channel for ALERT_EMAIL, or "".
find_channel() {
  channels=$(gcloud beta monitoring channels list --project="$1" --format=json) || die "cannot list notification channels"
  require_json "$channels" "channel list"
  printf '%s\n' "$channels" |
    jq -r --arg email "$ALERT_EMAIL" 'first(.[] | select(.type == "email" and .labels.email_address == $email) | .name) // ""'
}

# find_alert PROJECT NAME: PROJECT's alert policy named NAME as JSON, or "".
find_alert() {
  alerts=$(gcloud monitoring policies list --project="$1" --format=json) || die "cannot list alert policies"
  require_json "$alerts" "alert policy list"
  printf '%s\n' "$alerts" | jq -c --arg name "$2" 'first(.[] | select(.displayName == $name)) // empty'
}

describe_job() { gcloud run jobs describe "$JOB" --region="$REGION" --project="$KEEPER_PROJECT" --format=json 2>/dev/null; }

describe_scheduler() { gcloud scheduler jobs describe "$1" --location="$REGION" --project="$KEEPER_PROJECT" --format=json 2>/dev/null; }

# has_version SECRET: whether SECRET has an enabled version.
has_version() {
  versions=$(gcloud secrets versions list "$1" --project="$KEEPER_PROJECT" --format=json) || die "cannot list versions of $1"
  require_json "$versions" "secret version list"
  printf '%s\n' "$versions" | jq -e 'any(.[]; .state == "ENABLED")' >/dev/null
}

# rpc METHOD PARAMS: the result of a JSON-RPC call to the first of PUBLIC_RPCS that answers.
rpc() {
  for rpc_url in $PUBLIC_RPCS; do
    rpc_reply=$(curl -sS --max-time 15 -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$rpc_url" 2>&1) &&
      printf '%s\n' "$rpc_reply" | jq -er '.result' 2>/dev/null && return 0
    log "$1 failed on $rpc_url: $rpc_reply"
  done
  die "$1 failed on every public Base node"
}

# schedule_start CRON: seconds before the flip at which a "M H * * D" schedule fires.
schedule_start() {
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  if [ $# -ne 5 ] || [ "$3" != '*' ] || [ "$4" != '*' ]; then die "SCHEDULES entries must be 'M H * * D': $*"; fi
  case "$1$2$5" in *[!0-9]*) die "SCHEDULES entries must be 'M H * * D': $*" ;; esac
  # Leading zeros would read as octal in arithmetic.
  minute=$(printf '%s' "$1" | sed 's/^0*\([0-9]\)/\1/')
  hour=$(printf '%s' "$2" | sed 's/^0*\([0-9]\)/\1/')
  weekday=$(printf '%s' "$5" | sed 's/^0*\([0-9]\)/\1/')
  if [ "$minute" -gt 59 ] || [ "$hour" -gt 23 ] || [ "$weekday" -gt 7 ]; then die "SCHEDULES entry out of range: $*"; fi
  schedule_start_seconds=$(((FLIP_WEEKDAY - weekday + 7) % 7 * 86400 - hour * 3600 - minute * 60))
  [ "$schedule_start_seconds" -gt 0 ] || schedule_start_seconds=$((schedule_start_seconds + 604800))
  printf '%s\n' "$schedule_start_seconds"
}

# check_offsets_covered STARTS: every offset must fall strictly within HORIZON after some schedule start (seconds
# before the flip, one per line), or the job never runs that pass, and at least MIN_LEAD before the flip, which the
# last blocks' vote keeps for itself.
check_offsets_covered() {
  starts=$1
  for offset in $(printf '%s\n' "$VOTE_OFFSETS" | tr ',' ' '); do
    [ "$offset" -ge "$MIN_LEAD" ] || die "VOTE_OFFSETS entry $offset is within $MIN_LEAD s of the flip, kept for the last blocks"
    covered=no
    for start in $starts; do
      [ "$offset" -lt "$start" ] && [ "$offset" -gt $((start - HORIZON)) ] && covered=yes
    done
    [ "$covered" = yes ] || die "VOTE_OFFSETS entry $offset is not within $HORIZON s after any SCHEDULES entry"
  done
}

# check_flip_covered STARTS: some schedule must start between MIN_LEAD and HORIZON before the flip, as that execution
# votes in the last blocks.
check_flip_covered() {
  covered=no
  for start in $1; do
    [ "$start" -ge "$MIN_LEAD" ] && [ "$start" -le "$HORIZON" ] && covered=yes
  done
  [ "$covered" = yes ] || die "no SCHEDULES entry starts between $MIN_LEAD and $HORIZON s before the flip"
}

# schedules: one "NAME<TAB>CRON" line per entry of SCHEDULES; NAME is $JOB-1, $JOB-2, ...
schedules() {
  schedules_rest=$SCHEDULES
  schedules_i=0
  while [ -n "$schedules_rest" ]; do
    schedules_i=$((schedules_i + 1))
    case "$schedules_rest" in
      *";"*) schedules_cron=${schedules_rest%%;*} schedules_rest=${schedules_rest#*;} ;;
      *) schedules_cron=$schedules_rest schedules_rest='' ;;
    esac
    # Word splitting normalizes the spaces, so that check.sh compares what deploy.sh sent.
    set -f
    # shellcheck disable=SC2086
    set -- $schedules_cron
    set +f
    printf '%s-%s\t%s\n' "$JOB" "$schedules_i" "$*"
  done
}

# stale_schedulers: scheduler jobs named $JOB-* that SCHEDULES no longer lists, space-separated.
# Assign its output (x=$(stale_schedulers)) so that a failed listing stops the script.
stale_schedulers() {
  stale_list=$(gcloud scheduler jobs list --location="$REGION" --project="$KEEPER_PROJECT" --format=json) || die "cannot list scheduler jobs"
  require_json "$stale_list" "scheduler job list"
  printf '%s\n' "$stale_list" | jq -r --arg job "$JOB" --arg configured "$(schedules | cut -f1)" '
    [.[].name | split("/") | last | select(startswith($job + "-"))] - ($configured | split("\n"))
    | join(" ")'
}
