#!/bin/sh
# Keeper project resources that do not depend on the image. Idempotent.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

[ $# -eq 0 ] || die "usage: ${0##*/}"
require_tools
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
# ensure_secret NAME WHAT: the secret with the keeper as its only reader; says how to add WHAT if it has no version.
ensure_secret() {
  if gcloud secrets describe "$1" --project="$KEEPER_PROJECT" --format="value(name)" >/dev/null 2>&1; then
    log "exists: $1"
  else
    log "creating $1"
    gcloud secrets create "$1" --project="$KEEPER_PROJECT" --replication-policy=automatic
  fi
  set_iam_authoritative "$1" "--project=$KEEPER_PROJECT" "$(render_policy secret.iam.json.tmpl)" secrets
  versions=$(secret_versions "$1")
  [ "$versions" -gt 0 ] || log "add the $2: printf '%s' VALUE | gcloud secrets versions add $1 --project=$KEEPER_PROJECT --data-file=-"
}
ensure_secret "$RPC_SECRET" "RPC URL"
ensure_secret "$ALCHEMY_SECRET" "Alchemy API key"
[ -z "$COINGECKO_SECRET" ] || ensure_secret "$COINGECKO_SECRET" "CoinGecko demo API key"

log "== 4/4 alerts"
channel=$(find_channel)
if [ -n "$channel" ]; then
  log "exists: $channel"
else
  log "creating email channel for $ALERT_EMAIL"
  channel=$(gcloud beta monitoring channels create --project="$KEEPER_PROJECT" --display-name="$JOB alerts" \
    --type=email --channel-labels="email_address=$ALERT_EMAIL" --format="value(name)")
fi
alert=$(find_alert "$ALERT_NAME")
if [ -n "$alert" ]; then
  log "exists: $ALERT_NAME"
else
  log "creating alert policy: $ALERT_NAME"
  gcloud monitoring policies create --project="$KEEPER_PROJECT" --display-name="$ALERT_NAME" \
    --condition-display-name="failed task attempts" --condition-filter="$ALERT_FILTER" --if="> 0" \
    --aggregation='{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM"}' \
    --notification-channels="$channel" \
    --documentation="A $JOB execution failed. Read its logs in Cloud Run before the epoch flips." >/dev/null
fi
alert=$(find_alert "$START_ALERT_NAME")
if [ -n "$alert" ]; then
  log "exists: $START_ALERT_NAME"
else
  log "creating alert policy: $START_ALERT_NAME"
  start_alert_policy "$channel" >"$TMP/start-alert.json"
  gcloud monitoring policies create --project="$KEEPER_PROJECT" --policy-from-file="$TMP/start-alert.json" >/dev/null
fi

log "set KEEPER_SA in hydrex-keeper-key's config.env and run its sh/grant.sh:"
printf '%s\n' "$KEEPER_SA"
