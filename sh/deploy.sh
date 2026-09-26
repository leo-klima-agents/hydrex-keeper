#!/bin/sh
# Builds the image from this checkout and (re)deploys the job and its schedule. Idempotent.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

[ $# -eq 0 ] || die "usage: ${0##*/}"
require_tools
load_config
make_tmp

[ "$(secret_versions)" -gt 0 ] || die "$RPC_SECRET has no enabled version; see setup.sh"

log "== 1/3 job"
gcloud run jobs deploy "$JOB" --source="$REPO_ROOT" --region="$REGION" --project="$KEEPER_PROJECT" \
  --service-account="$KEEPER_SA" --set-secrets="$SECRETS" --set-env-vars="$ENV_VARS" \
  --task-timeout="$TASK_TIMEOUT" --max-retries="$MAX_RETRIES" --tasks=1 --cpu=1 --memory=512Mi --quiet

log "== 2/3 job IAM"
set_iam_authoritative "$JOB" "--region=$REGION --project=$KEEPER_PROJECT" "$(render_policy job.iam.json.tmpl)" run jobs

log "== 3/3 schedules"
tab=$(printf '\t')
while IFS="$tab" read -r name cron; do
  if [ -n "$(scheduler_exists "$name")" ]; then verb=update; else verb=create; fi
  gcloud scheduler jobs "$verb" http "$name" --location="$REGION" --project="$KEEPER_PROJECT" \
    --schedule="$cron" --time-zone=Etc/UTC --uri="$RUN_URI" --http-method=POST \
    --oauth-service-account-email="$SCHEDULER_SA" --description="starts $JOB before the Hydrex epoch flip"
done <<LIST
$(schedules)
LIST
for name in $(stale_schedulers); do
  log "deleting stale scheduler job $name"
  gcloud scheduler jobs delete "$name" --location="$REGION" --project="$KEEPER_PROJECT" --quiet
done
