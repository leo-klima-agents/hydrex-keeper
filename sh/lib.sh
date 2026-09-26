#!/bin/sh
# Sourced by every script in sh/.
# shellcheck disable=SC2034

SERVICES="run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com monitoring.googleapis.com"
TASK_TIMEOUT=90m
TASK_TIMEOUT_SECONDS=5400
MAX_RETRIES=3
ALERT_METRIC=run.googleapis.com/job/completed_task_attempt_count

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

# require_tools [EXTRA...]: gcloud and jq, plus any named extras.
# shellcheck disable=SC2120
require_tools() {
  for tool in gcloud jq "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
}

load_config() {
  [ -f "$CONFIG_FILE" ] || die "$CONFIG_FILE missing; copy config.env.example"
  case "$CONFIG_FILE" in */*) ;; *) CONFIG_FILE=./$CONFIG_FILE ;; esac # else `.` searches PATH
  unset KEEPER_PROJECT REGION JOB KEEPER_SA_NAME SCHEDULER_SA_NAME KMS_KEY_VERSION MODULE VOTE_OFFSETS SCHEDULE RPC_SECRET ALERT_EMAIL
  # shellcheck source=/dev/null
  . "$CONFIG_FILE"
  REGION=${REGION:-us-central1}
  JOB=${JOB:-hydrex-keeper}
  KEEPER_SA_NAME=${KEEPER_SA_NAME:-hydrex-keeper}
  SCHEDULER_SA_NAME=${SCHEDULER_SA_NAME:-hydrex-keeper-scheduler}
  MODULE=${MODULE:-0x750973E0CB728C3112561Bc8E9b235afA9B17E81}
  VOTE_OFFSETS=${VOTE_OFFSETS:-3600,600,60}
  SCHEDULE=${SCHEDULE:-50 22 * * 3}
  RPC_SECRET=${RPC_SECRET:-base-rpc-url}

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
    "" | *[!0-9,]*) die "VOTE_OFFSETS must be comma-separated seconds" ;;
  esac
  case "$ALERT_EMAIL" in
    ?*@?*) ;;
    *) die "ALERT_EMAIL must be an email address" ;;
  esac

  KEEPER_SA=$KEEPER_SA_NAME@$KEEPER_PROJECT.iam.gserviceaccount.com
  SCHEDULER_SA=$SCHEDULER_SA_NAME@$KEEPER_PROJECT.iam.gserviceaccount.com
  RUN_URI=https://run.googleapis.com/v2/projects/$KEEPER_PROJECT/locations/$REGION/jobs/$JOB:run
  # `|` separates the variables because VOTE_OFFSETS contains commas.
  ENV_VARS="^|^MODULE=$MODULE|KMS_KEY_VERSION=$KMS_KEY_VERSION|VOTE_OFFSETS=$VOTE_OFFSETS"
  SECRETS="BASE_RPC_URL=$RPC_SECRET:latest"
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
  gcloud "$@" get-iam-policy $iam_flags "$iam_resource" --format=json
}

# write_iam_if_changed RESOURCE FLAGS LIVE DESIRED gcloud-subcommand...: writes DESIRED in full with LIVE's etag.
write_iam_if_changed() {
  iam_resource=$1
  iam_flags=$2
  iam_live=$3
  iam_desired=$4
  shift 4
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

# set_iam_authoritative RESOURCE FLAGS DESIRED gcloud-subcommand...
set_iam_authoritative() {
  set_iam_resource=$1
  set_iam_flags=$2
  set_iam_desired=$3
  shift 3
  set_iam_live=$(get_iam "$set_iam_resource" "$set_iam_flags" "$@")
  write_iam_if_changed "$set_iam_resource" "$set_iam_flags" "$set_iam_live" "$set_iam_desired" "$@"
}

# find_channel: name of the email notification channel for ALERT_EMAIL, or "".
find_channel() {
  gcloud beta monitoring channels list --project="$KEEPER_PROJECT" \
    --filter="type=email AND labels.email_address=$ALERT_EMAIL" --format=json |
    jq -r 'first(.[] | .name) // ""'
}

# find_alert: the alert policy named ALERT_NAME as JSON, or "".
find_alert() {
  gcloud monitoring policies list --project="$KEEPER_PROJECT" \
    --filter="displayName=\"$ALERT_NAME\"" --format=json |
    jq -c 'first(.[]) // empty'
}

job_exists() { gcloud run jobs describe "$JOB" --region="$REGION" --project="$KEEPER_PROJECT" --format=json 2>/dev/null; }

scheduler_exists() { gcloud scheduler jobs describe "$JOB" --location="$REGION" --project="$KEEPER_PROJECT" --format=json 2>/dev/null; }

secret_versions() {
  gcloud secrets versions list "$RPC_SECRET" --project="$KEEPER_PROJECT" --filter="state=enabled" --format=json | jq 'length'
}
