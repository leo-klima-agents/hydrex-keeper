#!/bin/sh
# Executes the job and waits. --dry-run signs but does not send; --now runs one pass at once.
set -eu
script_dir=$(dirname -- "$0")
# shellcheck source=sh/lib.sh
. "$script_dir/lib.sh"

args=''
for arg in "$@"; do
  case "$arg" in
    --dry-run | --now) args="$args,$arg" ;;
    *) die "usage: ${0##*/} [--dry-run] [--now]" ;;
  esac
done

require_tools gcloud jq
load_config

gcloud run jobs execute "$JOB" --region="$REGION" --project="$KEEPER_PROJECT" --wait --args="${args#,}"
