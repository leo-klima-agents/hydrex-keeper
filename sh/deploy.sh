#!/bin/sh
# Builds the image from this checkout and deploys the job and its schedule. Idempotent.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

[ $# -eq 0 ] || die "usage: ${0##*/}"
require_tools gcloud jq
load_config
make_tmp

for secret in $SECRET_NAMES; do
  has_version "$secret" || die "$secret has no enabled version; see setup.sh"
done

log "== 1/3 job"
gcloud run jobs deploy "$JOB" --source="$REPO_ROOT" --region="$REGION" --project="$KEEPER_PROJECT" \
  --service-account="$KEEPER_SA" --set-secrets="$SECRETS" --set-env-vars="$ENV_VARS" \
  --task-timeout="${TASK_TIMEOUT}s" --max-retries="$MAX_RETRIES" --tasks=1 --cpu=1 --memory=512Mi --quiet

log "== 2/3 job IAM"
job_policy=$(render_policy job.iam.json.tmpl)
set_iam "$JOB" "--region=$REGION --project=$KEEPER_PROJECT" "$job_policy" run jobs

log "== 3/3 schedule"
if scheduler=$(describe_scheduler "$SCHEDULER"); then verb=update; else verb=create; fi
# shellcheck disable=SC2086
gcloud scheduler jobs "$verb" http "$SCHEDULER" --location="$REGION" --project="$KEEPER_PROJECT" \
  --schedule="$SCHEDULE" --time-zone=Etc/UTC --uri="$RUN_URI" --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SA" --description="starts $JOB before the Hydrex epoch flip" \
  $SCHEDULER_RETRY_FLAGS
if [ "$verb" = update ] && [ "$(json_field "$scheduler" .state)" = PAUSED ]; then
  log "resuming $SCHEDULER"
  gcloud scheduler jobs resume "$SCHEDULER" --location="$REGION" --project="$KEEPER_PROJECT"
fi
stale=$(stale_schedulers)
for name in $stale; do
  log "deleting stale scheduler job $name"
  gcloud scheduler jobs delete "$name" --location="$REGION" --project="$KEEPER_PROJECT" --quiet
done
