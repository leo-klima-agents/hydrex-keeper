#!/bin/sh
# Sourced by every script in sh/.
# shellcheck disable=SC2034

SERVICES="run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com monitoring.googleapis.com"
TASK_TIMEOUT=5400 # seconds
MAX_RETRIES=3
ALERT_METRIC=run.googleapis.com/job/completed_task_attempt_count
HORIZON=3600 # seconds; same as HORIZON in src/main.ts
FLIP_WEEKDAY=4 # Thursday 00:00 UTC
TAB=$(printf '\t')
# check.sh fails below this: about four weeks of worst-case votes (a vote costs up to 1.5e13 wei, at most 8 a week).
MIN_KEEPER_WEI=500000000000000 # 0.0005 ETH
CHECK_RPC=${CHECK_RPC_URL:-https://mainnet.base.org} # read-only, weekly: the public node is enough

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

require_tools() {
  for tool in gcloud jq; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
}

load_config() {
  [ -f "$CONFIG_FILE" ] || die "$CONFIG_FILE missing; copy config.env.example"
  case "$CONFIG_FILE" in */*) ;; *) CONFIG_FILE=./$CONFIG_FILE ;; esac # else `.` searches PATH
  unset KEEPER_PROJECT REGION JOB KEEPER_SA_NAME SCHEDULER_SA_NAME KMS_KEY_VERSION MODULE VOTE_OFFSETS SCHEDULES RPC_SECRET ALCHEMY_SECRET COINGECKO_SECRET ALERT_EMAIL
  # shellcheck source=/dev/null
  . "$CONFIG_FILE"
  REGION=${REGION:-us-central1}
  JOB=${JOB:-hydrex-keeper}
  KEEPER_SA_NAME=${KEEPER_SA_NAME:-hydrex-keeper}
  SCHEDULER_SA_NAME=${SCHEDULER_SA_NAME:-hydrex-keeper-scheduler}
  MODULE=${MODULE:-0x750973E0CB728C3112561Bc8E9b235afA9B17E81}
  VOTE_OFFSETS=${VOTE_OFFSETS:-86400,600,200,70,25,10,5}
  SCHEDULES=${SCHEDULES:-50 23 * * 2;40 23 * * 3}
  RPC_SECRET=${RPC_SECRET:-base-rpc-url}
  ALCHEMY_SECRET=${ALCHEMY_SECRET:-alchemy-api-key}
  COINGECKO_SECRET=${COINGECKO_SECRET:-} # optional: empty leaves CoinGecko out

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
  check_offsets_covered

  KEEPER_SA=$KEEPER_SA_NAME@$KEEPER_PROJECT.iam.gserviceaccount.com
  SCHEDULER_SA=$SCHEDULER_SA_NAME@$KEEPER_PROJECT.iam.gserviceaccount.com
  RUN_URI=https://run.googleapis.com/v2/projects/$KEEPER_PROJECT/locations/$REGION/jobs/$JOB:run
  # `|` separates the variables because VOTE_OFFSETS contains commas.
  ENV_VARS="^|^MODULE=$MODULE|KMS_KEY_VERSION=$KMS_KEY_VERSION|VOTE_OFFSETS=$VOTE_OFFSETS"
  SECRETS="BASE_RPC_URL=$RPC_SECRET:latest,ALCHEMY_API_KEY=$ALCHEMY_SECRET:latest"
  KEEPER_SECRETS="$RPC_SECRET $ALCHEMY_SECRET" # the Secret Manager secrets the job reads
  if [ -n "$COINGECKO_SECRET" ]; then
    SECRETS="$SECRETS,COINGECKO_API_KEY=$COINGECKO_SECRET:latest"
    KEEPER_SECRETS="$KEEPER_SECRETS $COINGECKO_SECRET"
  fi
  ALERT_NAME="$JOB failed"
  ALERT_FILTER="metric.type=\"$ALERT_METRIC\" AND resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\" AND metric.labels.result=\"failed\""
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

# set_iam_authoritative RESOURCE FLAGS DESIRED gcloud-subcommand...: writes DESIRED in full with the live etag.
set_iam_authoritative() {
  iam_resource=$1
  iam_flags=$2
  iam_desired=$3
  shift 3
  iam_live=$(get_iam "$iam_resource" "$iam_flags" "$@")
  if ! policy_differs "$iam_live" "$iam_desired"; then
    log "iam: $iam_resource unchanged"
    return 0
  fi
  iam_etag=$(printf '%s\n' "$iam_live" | jq -r '.etag // empty')
  iam_file=$TMP/policy.json
  printf '%s\n' "$iam_desired" | jq --arg etag "$iam_etag" '.etag = $etag' >"$iam_file"
  log "iam: writing $iam_resource"
  # shellcheck disable=SC2086
  gcloud "$@" set-iam-policy $iam_flags "$iam_resource" "$iam_file" >/dev/null
}

# find_channel: name of the email notification channel for ALERT_EMAIL, or "".
find_channel() {
  channels=$(gcloud beta monitoring channels list --project="$KEEPER_PROJECT" \
    --filter="type=email AND labels.email_address=$ALERT_EMAIL" --format=json) || die "cannot list notification channels"
  require_json "$channels" "channel list"
  printf '%s\n' "$channels" | jq -r 'first(.[] | .name) // ""'
}

# find_alert: the alert policy named ALERT_NAME as JSON, or "".
find_alert() {
  alerts=$(gcloud monitoring policies list --project="$KEEPER_PROJECT" \
    --filter="displayName=\"$ALERT_NAME\"" --format=json) || die "cannot list alert policies"
  require_json "$alerts" "alert policy list"
  printf '%s\n' "$alerts" | jq -c 'first(.[]) // empty'
}

job_exists() { gcloud run jobs describe "$JOB" --region="$REGION" --project="$KEEPER_PROJECT" --format=json 2>/dev/null; }

# schedule_start CRON: seconds before the flip at which a "M H * * D" schedule fires.
schedule_start() {
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  [ $# -eq 5 ] && [ "$3" = '*' ] && [ "$4" = '*' ] || die "SCHEDULES entries must be 'M H * * D': $*"
  case "$1$2$5" in *[!0-9]*) die "SCHEDULES entries must be 'M H * * D': $*" ;; esac
  # Leading zeros would read as octal in arithmetic.
  minute=$(printf '%s' "$1" | sed 's/^0*\([0-9]\)/\1/')
  hour=$(printf '%s' "$2" | sed 's/^0*\([0-9]\)/\1/')
  weekday=$(printf '%s' "$5" | sed 's/^0*\([0-9]\)/\1/')
  [ "$minute" -le 59 ] && [ "$hour" -le 23 ] && [ "$weekday" -le 7 ] || die "SCHEDULES entry out of range: $*"
  schedule_start_seconds=$(((FLIP_WEEKDAY - weekday + 7) % 7 * 86400 - hour * 3600 - minute * 60))
  [ "$schedule_start_seconds" -gt 0 ] || schedule_start_seconds=$((schedule_start_seconds + 604800))
  printf '%s\n' "$schedule_start_seconds"
}

# Every offset must fall strictly within HORIZON after some schedule start, or the job never runs that pass.
check_offsets_covered() {
  starts=''
  while IFS="$TAB" read -r _ cron; do
    starts="$starts $(schedule_start "$cron")"
  done <<LIST
$(schedules)
LIST
  for offset in $(printf '%s\n' "$VOTE_OFFSETS" | tr ',' ' '); do
    covered=no
    for start in $starts; do
      [ "$offset" -lt "$start" ] && [ "$offset" -gt $((start - HORIZON)) ] && covered=yes
    done
    [ "$covered" = yes ] || die "VOTE_OFFSETS entry $offset is not within $HORIZON s after any SCHEDULES entry"
  done
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
    # Word splitting collapses whitespace around and between the fields, so what is deployed is what is checked.
    set -f
    # shellcheck disable=SC2086
    set -- $schedules_cron
    set +f
    printf '%s-%s\t%s\n' "$JOB" "$schedules_i" "$*"
  done
}

scheduler_exists() { gcloud scheduler jobs describe "$1" --location="$REGION" --project="$KEEPER_PROJECT" --format=json 2>/dev/null; }

# find_stale_schedulers: sets STALE to the scheduler jobs named $JOB or $JOB-* that SCHEDULES no longer lists, one
# per line. Call it as a command, not in $(...), so that a failed listing stops the script.
find_stale_schedulers() {
  stale_configured=$(schedules | cut -f1)
  stale_list=$(gcloud scheduler jobs list --location="$REGION" --project="$KEEPER_PROJECT" --format=json) || die "cannot list scheduler jobs"
  require_json "$stale_list" "scheduler job list"
  STALE=$(printf '%s\n' "$stale_list" |
    jq -r --arg job "$JOB" '.[].name | split("/") | last | select(. == $job or startswith($job + "-"))' |
    while IFS= read -r stale_name; do
      printf '%s\n' "$stale_configured" | grep -qx "$stale_name" || printf '%s\n' "$stale_name"
    done)
}

# rpc METHOD PARAMS: the JSON-RPC result from CHECK_RPC, as a string.
rpc() {
  rpc_reply=$(curl -sS --max-time 15 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$CHECK_RPC") || die "$1 failed on $CHECK_RPC"
  printf '%s\n' "$rpc_reply" | jq -er '.result' 2>/dev/null || die "$1 on $CHECK_RPC: $rpc_reply"
}

# secret_versions SECRET: the number of enabled versions.
secret_versions() {
  versions=$(gcloud secrets versions list "$1" --project="$KEEPER_PROJECT" --filter="state=enabled" --format=json) ||
    die "cannot list versions of $1"
  require_json "$versions" "secret version list"
  printf '%s\n' "$versions" | jq 'length'
}
