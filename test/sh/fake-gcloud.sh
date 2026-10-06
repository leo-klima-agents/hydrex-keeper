#!/bin/sh
# gcloud stub for the golden tests: logs each call to $FAKE_GCLOUD_LOG and answers from the $FAKE_GCLOUD_SCENARIO state.
# In the log, --source paths become <repo> and set-iam-policy files their canonical JSON.
set -eu

: "${FAKE_GCLOUD_LOG:?}" "${FAKE_GCLOUD_SCENARIO:?}"

# Mirrors test/sh/config/keeper.env and the defaults in sh/lib.sh.
project=hydrex-keeper-test
region=us-central1
job=hydrex-keeper
keeper_sa=hydrex-keeper@$project.iam.gserviceaccount.com
scheduler_sa=hydrex-keeper-scheduler@$project.iam.gserviceaccount.com
key=projects/hydrex-keeper-key-test/locations/us/keyRings/hydrex-keeper/cryptoKeys/hydrex-keeper-v1/cryptoKeyVersions/1
module=0x750973E0CB728C3112561Bc8E9b235afA9B17E81
email=hydrex-admin@example.com
channel=projects/$project/notificationChannels/1234567890
run_uri=https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$job:run

# What exists; drift bends the live state; list-fails denies listing scheduler jobs and alert policies.
has_sas=yes has_secret=yes has_version=yes has_channel=yes has_alert=yes has_job=yes has_scheduler=yes drift=no list_fails=no
case "$FAKE_GCLOUD_SCENARIO" in
  fresh) has_sas=no has_secret=no has_version=no has_channel=no has_alert=no has_job=no has_scheduler=no ;;
  first-deploy) has_job=no has_scheduler=no ;;
  existing) ;;
  drift) drift=yes ;;
  list-fails) list_fails=yes ;;
  *)
    printf 'fake-gcloud: unknown scenario %s\n' "$FAKE_GCLOUD_SCENARIO" >&2
    exit 98
    ;;
esac

job_json() {
  if [ "$drift" = yes ]; then # deployed by an older version, which set VOTE_OFFSETS
    sa=123456789-compute@developer.gserviceaccount.com retries=0
    env='{"name":"MODULE","value":"'$module'"},{"name":"KMS_KEY_VERSION","value":"'$key'"},{"name":"VOTE_OFFSETS","value":"86400"}'
  else
    sa=$keeper_sa retries=3
    env='{"name":"MODULE","value":"'$module'"},{"name":"KMS_KEY_VERSION","value":"'$key'"}'
  fi
  secrets='{"name":"BASE_RPC_URLS","valueFrom":{"secretKeyRef":{"key":"latest","name":"base-rpc-url"}}},{"name":"ALCHEMY_API_KEY","valueFrom":{"secretKeyRef":{"key":"latest","name":"alchemy-api-key"}}}'
  printf '{"spec":{"template":{"spec":{"taskCount":1,"template":{"spec":{"containers":[{"env":[%s,%s],"image":"%s-docker.pkg.dev/%s/cloud-run-source-deploy/%s@sha256:0"}],"maxRetries":%s,"serviceAccountName":"%s","timeoutSeconds":"5400"}}}}}}\n' \
    "$env" "$secrets" "$region" "$project" "$job" "$retries" "$sa"
}

# scheduler_json NAME
scheduler_json() {
  case "$1" in "$job-1") cron='50 23 * * 2' ;; *) cron='40 23 * * 3' ;; esac
  if [ "$drift" = yes ] && [ "$1" = "$job-2" ]; then state=PAUSED; else state=ENABLED; fi
  if [ "$drift" = yes ] && [ "$1" = "$job-1" ]; then # Cloud Scheduler's defaults: no retry
    retry='{"maxBackoffDuration":"3600s","maxDoublings":5,"maxRetryDuration":"0s","minBackoffDuration":"5s"}'
  else
    retry='{"maxBackoffDuration":"60s","maxDoublings":2,"maxRetryDuration":"300s","minBackoffDuration":"15s","retryCount":3}'
  fi
  printf '{"httpTarget":{"httpMethod":"POST","oauthToken":{"scope":"https://www.googleapis.com/auth/cloud-platform","serviceAccountEmail":"%s"},"uri":"%s"},"name":"projects/%s/locations/%s/jobs/%s","retryConfig":%s,"schedule":"%s","state":"%s","timeZone":"Etc/UTC"}\n' \
    "$scheduler_sa" "$run_uri" "$project" "$region" "$1" "$retry" "$cron" "$state"
}

job_policy_json() {
  if [ "$has_job" = no ] || [ "$drift" = yes ]; then
    printf '{"etag":"BwJobEmpty"}\n'
  else
    printf '{"bindings":[{"role":"roles/run.invoker","members":["serviceAccount:%s"]}],"etag":"BwJobFull","version":1}\n' "$scheduler_sa"
  fi
}

secret_policy_json() {
  if [ "$has_secret" = no ]; then
    printf '{"etag":"ACAB"}\n'
  elif [ "$drift" = yes ]; then
    printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:%s","user:stray@example.com"]}],"etag":"BwSecretStray","version":1}\n' "$keeper_sa"
  else
    printf '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:%s"]}],"etag":"BwSecretFull","version":1}\n' "$keeper_sa"
  fi
}

sa_policy_json() {
  if [ "$drift" = yes ]; then
    printf '{"bindings":[{"role":"roles/iam.serviceAccountTokenCreator","members":["user:stray@example.com"]}],"etag":"BwSaStray","version":1}\n'
  else
    printf '{"etag":"BwSaEmpty"}\n'
  fi
}

project_policy_json() {
  bindings='{"role":"roles/owner","members":["user:'$email'"]}'
  [ "$drift" = no ] || bindings="$bindings,"'{"role":"roles/editor","members":["serviceAccount:'$keeper_sa'"]}'
  printf '{"bindings":[%s],"etag":"BwProj","version":1}\n' "$bindings"
}

alert_json() {
  if [ "$drift" = yes ]; then enabled=false channels='[]'; else enabled=true channels='["'$channel'"]'; fi
  printf '{"displayName":"%s failed","enabled":%s,"name":"projects/%s/alertPolicies/1","notificationChannels":%s,"conditions":[{"conditionThreshold":{"filter":"metric.type=\\"run.googleapis.com/job/completed_task_attempt_count\\" AND resource.type=\\"cloud_run_job\\" AND resource.labels.job_name=\\"%s\\" AND metric.labels.result=\\"failed\\""}}]}\n' \
    "$job" "$enabled" "$project" "$channels" "$job"
}

start_alert_json() {
  filter="resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=~\"^$job-[0-9]+\$\" AND jsonPayload.@type=\"type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished\" AND (severity>=ERROR OR httpRequest.status>=400)"
  [ "$drift" = no ] || filter='resource.type="cloud_scheduler_job"' # edited by hand
  jq -nc --arg name "$job start failed" --arg filter "$filter" --arg channel "$channel" --arg project "$project" \
    '{displayName: $name, enabled: true, name: "projects/\($project)/alertPolicies/2", notificationChannels: [$channel], conditions: [{conditionMatchedLog: {filter: $filter}}]}'
}

log_call() { printf 'gcloud %s\n' "$*" >>"$FAKE_GCLOUD_LOG"; }

# log_set_policy EXPECTED_ETAG ARGS...: checks the etag, then logs the policy file as canonical JSON.
log_set_policy() {
  expected_etag=$1
  shift
  file=$(eval "printf '%s' \"\$$#\"")
  [ "$(jq -r '.etag // ""' "$file")" = "$expected_etag" ] ||
    {
      printf 'fake-gcloud: etag %s, expected %s\n' "$(jq -r .etag "$file")" "$expected_etag" >&2
      exit 96
    }
  logged=''
  while [ $# -gt 1 ]; do
    logged="$logged $1"
    shift
  done
  log_call "${logged# } $(jq -c -S . "$file")"
}

# missing WHAT
missing() {
  printf 'ERROR: (gcloud) %s not found\n' "$1" >&2
  exit 1
}

case "$*" in
  "services enable "*)
    log_call "$@"
    ;;
  "iam service-accounts describe "*)
    log_call "$@"
    [ "$has_sas" = yes ] || missing "$4"
    printf '%s\n' "$4"
    ;;
  "iam service-accounts create "*)
    log_call "$@"
    ;;
  "iam service-accounts keys list "*)
    log_call "$@"
    if [ "$drift" = yes ]; then
      printf '[{"keyType":"USER_MANAGED","name":"projects/%s/serviceAccounts/%s/keys/0123abcd"}]\n' "$project" "$keeper_sa"
    else
      printf '[]\n'
    fi
    ;;
  "iam service-accounts get-iam-policy "*)
    log_call "$@"
    sa_policy_json
    ;;
  "secrets describe "*)
    log_call "$@"
    [ "$has_secret" = yes ] || missing "$3"
    printf 'projects/%s/secrets/%s\n' "$project" "$3"
    ;;
  "secrets create "*)
    log_call "$@"
    ;;
  "secrets get-iam-policy "*)
    log_call "$@"
    secret_policy_json
    ;;
  "secrets set-iam-policy "*)
    log_set_policy "$(secret_policy_json | jq -r .etag)" "$@"
    ;;
  "secrets versions list "*)
    log_call "$@"
    if [ "$has_version" = yes ]; then
      printf '[{"name":"projects/%s/secrets/%s/versions/1","state":"ENABLED"}]\n' "$project" "$4"
    else
      printf '[]\n'
    fi
    ;;
  "beta monitoring channels list "*)
    log_call "$@"
    if [ "$has_channel" = yes ]; then
      printf '[{"name":"%s","type":"email","labels":{"email_address":"%s"}}]\n' "$channel" "$email"
    else
      printf '[]\n'
    fi
    ;;
  "beta monitoring channels create "*)
    log_call "$@"
    printf '%s\n' "$channel"
    ;;
  "monitoring policies list "*)
    log_call "$@"
    [ "$list_fails" = no ] || {
      printf 'ERROR: (gcloud.monitoring.policies.list) PERMISSION_DENIED\n' >&2
      exit 1
    }
    if [ "$has_alert" = no ]; then printf '[]\n'; else printf '[%s,%s]\n' "$(alert_json)" "$(start_alert_json)"; fi
    ;;
  "monitoring policies create "*)
    logged=''
    for arg in "$@"; do
      case "$arg" in --policy-from-file=*) logged="$logged $(jq -c -S . "${arg#*=}")" ;; *) logged="$logged $arg" ;; esac
    done
    log_call "${logged# }"
    ;;
  "run jobs deploy "*)
    logged=''
    for arg in "$@"; do
      case "$arg" in --source=*) logged="$logged --source=<repo>" ;; *) logged="$logged $arg" ;; esac
    done
    log_call "${logged# }"
    ;;
  "run jobs get-iam-policy "*)
    log_call "$@"
    job_policy_json
    ;;
  "run jobs set-iam-policy "*)
    log_set_policy "$(job_policy_json | jq -r .etag)" "$@"
    ;;
  "run jobs describe "*)
    log_call "$@"
    [ "$has_job" = yes ] || missing "$4"
    job_json
    ;;
  "run jobs execute "*)
    log_call "$@"
    ;;
  "scheduler jobs describe "*)
    log_call "$@"
    [ "$has_scheduler" = yes ] || missing "$4"
    scheduler_json "$4"
    ;;
  "scheduler jobs create http "* | "scheduler jobs update http "* | "scheduler jobs resume "* | "scheduler jobs delete "*)
    log_call "$@"
    ;;
  "scheduler jobs list "*)
    log_call "$@"
    [ "$list_fails" = no ] || {
      printf 'ERROR: (gcloud.scheduler.jobs.list) PERMISSION_DENIED\n' >&2
      exit 1
    }
    names=''
    [ "$has_scheduler" = no ] || names="\"projects/$project/locations/$region/jobs/$job-1\",\"projects/$project/locations/$region/jobs/$job-2\""
    [ "$drift" = no ] || names="$names,\"projects/$project/locations/$region/jobs/$job-3\",\"projects/$project/locations/$region/jobs/other-job\""
    printf '[%s]\n' "$(printf '%s' "$names" | sed 's/"\([^"]*\)"/{"name":"\1"}/g')"
    ;;
  "projects get-iam-policy "*)
    log_call "$@"
    project_policy_json
    ;;
  *)
    log_call "UNEXPECTED:" "$@"
    printf 'fake-gcloud: unexpected call: gcloud %s\n' "$*" >&2
    exit 99
    ;;
esac
