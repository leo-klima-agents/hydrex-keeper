#!/bin/sh
# Creates the project resources that do not depend on the image. Idempotent.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

[ $# -eq 0 ] || die "usage: ${0##*/}"
require_tools gcloud jq
load_config
make_tmp

log "== 1/4 APIs"
# shellcheck disable=SC2086
gcloud services enable $SERVICES --project="$KEEPER_PROJECT"

log "== 2/4 service accounts"
# ensure_sa NAME EMAIL DESCRIPTION
ensure_sa() {
  if gcloud iam service-accounts describe "$2" --project="$KEEPER_PROJECT" --format="value(email)" >/dev/null 2>&1; then
    log "exists: $2"
  else
    log "creating $2"
    gcloud iam service-accounts create "$1" --project="$KEEPER_PROJECT" --display-name="$1" --description="$3"
  fi
}
ensure_sa "$KEEPER_SA_NAME" "$KEEPER_SA" "runs the job and signs with the key"
ensure_sa "$SCHEDULER_SA_NAME" "$SCHEDULER_SA" "starts the job on schedule"

log "== 3/4 secrets"
# ensure_secret NAME WHAT: NAME, readable by the job only; says how to add WHAT if it has no version.
ensure_secret() {
  if gcloud secrets describe "$1" --project="$KEEPER_PROJECT" --format="value(name)" >/dev/null 2>&1; then
    log "exists: $1"
  else
    log "creating $1"
    gcloud secrets create "$1" --project="$KEEPER_PROJECT" --replication-policy=automatic
  fi
  set_iam "$1" "--project=$KEEPER_PROJECT" "$(render_policy secret.iam.json.tmpl)" secrets
  has_version "$1" || log "add the $2: printf '%s' '…' | gcloud secrets versions add $1 --project=$KEEPER_PROJECT --data-file=-"
}
ensure_secret "$RPC_SECRET" "RPC URLs"
ensure_secret "$ALCHEMY_SECRET" "Alchemy API key"
[ -z "$COINGECKO_SECRET" ] || ensure_secret "$COINGECKO_SECRET" "CoinGecko Demo API key"

log "== 4/4 alerts"
channel=$(find_channel)
if [ -n "$channel" ]; then
  log "exists: $channel"
else
  log "creating email channel for $ALERT_EMAIL"
  channel=$(gcloud beta monitoring channels create --project="$KEEPER_PROJECT" --display-name="$JOB alerts" \
    --type=email --channel-labels="email_address=$ALERT_EMAIL" --format="value(name)")
fi
# ensure_alert NAME FILE: creates the alert policy in FILE unless one named NAME exists.
ensure_alert() {
  if [ -n "$(find_alert "$1")" ]; then
    log "exists: $1"
  else
    log "creating alert policy: $1"
    gcloud monitoring policies create --project="$KEEPER_PROJECT" --policy-from-file="$2" >/dev/null
  fi
}
# A single failed attempt in a five-minute window fires it.
jq -n --arg name "$ALERT_NAME" --arg filter "$ALERT_FILTER" --arg channel "$channel" --arg job "$JOB" '{
  displayName: $name,
  combiner: "OR",
  conditions: [{
    displayName: "failed task attempts",
    conditionThreshold: {
      filter: $filter,
      aggregations: [{alignmentPeriod: "300s", perSeriesAligner: "ALIGN_SUM"}],
      comparison: "COMPARISON_GT",
      thresholdValue: 0,
      duration: "0s",
      trigger: {count: 1}
    }
  }],
  notificationChannels: [$channel],
  documentation: {
    mimeType: "text/markdown",
    content: "A \($job) execution failed. Read its logs in Cloud Run before the epoch flips."
  }
}' >"$TMP/alert.json"
ensure_alert "$ALERT_NAME" "$TMP/alert.json"
# A log-based condition needs a notification rate limit.
jq -n --arg name "$START_ALERT_NAME" --arg filter "$START_ALERT_FILTER" --arg channel "$channel" --arg job "$JOB" '{
  displayName: $name,
  combiner: "OR",
  conditions: [{displayName: "failed start attempts", conditionMatchedLog: {filter: $filter}}],
  alertStrategy: {notificationRateLimit: {period: "300s"}},
  notificationChannels: [$channel],
  documentation: {
    mimeType: "text/markdown",
    content: "Cloud Scheduler failed to start \($job). It retries three times; if all failed, run sh/run.sh before the epoch flips."
  }
}' >"$TMP/start-alert.json"
ensure_alert "$START_ALERT_NAME" "$TMP/start-alert.json"

log "set KEEPER_SA in hydrex-keeper-key's config.env and run its sh/grant.sh:"
printf '%s\n' "$KEEPER_SA"
