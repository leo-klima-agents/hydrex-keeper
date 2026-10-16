#!/bin/sh
# Executes the job and waits. --dry-run signs but does not send; --now votes at once; --claim claims at once.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

usage="usage: ${0##*/} [--dry-run] [--now | --claim]"
args=''
for arg in "$@"; do
  case "$arg" in
    --dry-run | --now | --claim) args="$args,$arg" ;;
    *) die "$usage" ;;
  esac
done
case "$args," in *,--now,*--claim,* | *,--claim,*--now,*) die "$usage" ;; esac

require_tools gcloud jq
load_config

gcloud run jobs execute "$JOB" --region="$REGION" --project="$KEEPER_PROJECT" --wait --args="${args#,}"
