#!/bin/sh
# Keeper project resources that do not depend on the image. Idempotent.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

require_tools
load_config
make_tmp

log "== 1/4 APIs"
# shellcheck disable=SC2086
gcloud services enable $SERVICES --project="$KEEPER_PROJECT"

log "== 2/4 service accounts"
for sa in "$KEEPER_SA_NAME:$KEEPER_SA:runs the job and signs with the key" \
  "$SCHEDULER_SA_NAME:$SCHEDULER_SA:starts the job on schedule"; do
  name=${sa%%:*}
  rest=${sa#*:}
  email=${rest%%:*}
  description=${rest#*:}
  if gcloud iam service-accounts describe "$email" --project="$KEEPER_PROJECT" --format="value(email)" >/dev/null 2>&1; then
    log "exists: $email"
  else
    log "creating $email"
    gcloud iam service-accounts create "$name" --project="$KEEPER_PROJECT" --display-name="$name" --description="$description"
  fi
done

log "== 3/4 RPC secret"
if gcloud secrets describe "$RPC_SECRET" --project="$KEEPER_PROJECT" --format="value(name)" >/dev/null 2>&1; then
  log "exists: $RPC_SECRET"
else
  log "creating $RPC_SECRET"
  gcloud secrets create "$RPC_SECRET" --project="$KEEPER_PROJECT" --replication-policy=automatic
fi
set_iam_authoritative "$RPC_SECRET" "--project=$KEEPER_PROJECT" "$(render_policy secret.iam.json.tmpl)" secrets
[ "$(secret_versions)" -gt 0 ] || log "add the RPC URL: printf '%s' URL | gcloud secrets versions add $RPC_SECRET --project=$KEEPER_PROJECT --data-file=-"

log "== 4/4 failure alert"
channel=$(find_channel)
if [ -n "$channel" ]; then
  log "exists: $channel"
else
  log "creating email channel for $ALERT_EMAIL"
  channel=$(gcloud beta monitoring channels create --project="$KEEPER_PROJECT" --display-name="$JOB alerts" \
    --type=email --channel-labels="email_address=$ALERT_EMAIL" --format="value(name)")
fi
if [ -n "$(find_alert)" ]; then
  log "exists: $ALERT_NAME"
else
  log "creating alert policy: $ALERT_NAME"
  gcloud monitoring policies create --project="$KEEPER_PROJECT" --display-name="$ALERT_NAME" \
    --condition-display-name="failed task attempts" --condition-filter="$ALERT_FILTER" --if="> 0" \
    --aggregation='{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM"}' \
    --notification-channels="$channel" \
    --documentation="A $JOB execution failed. Read its logs in Cloud Run before the epoch flips." >/dev/null
fi

log "set KEEPER_SA in hydrex-keeper-key's config.env and run its sh/grant.sh:"
printf '%s\n' "$KEEPER_SA"
