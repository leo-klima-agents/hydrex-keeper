#!/bin/sh
# Runs the scripts in sh/ under $TEST_SH (default dash) against fake-gcloud.sh and fake-curl.sh, and diffs with golden/.
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
test_sh=${TEST_SH:-dash}
update=no
case "$#:${1:-}" in
  0:) ;;
  1:--update) update=yes ;;
  *)
    printf 'usage: %s [--update]\n' "$0" >&2
    exit 2
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$tmp/bin"
ln -s "$root/test/sh/fake-gcloud.sh" "$tmp/bin/gcloud"
ln -s "$root/test/sh/fake-curl.sh" "$tmp/bin/curl"
PATH=$tmp/bin:$PATH
export PATH
failures=0

# golden_case NAME SCENARIO CONFIG SCRIPT [ARGS...]: runs SCRIPT with config/CONFIG.env and compares.
golden_case() {
  name=$1
  scenario=$2
  config=$3
  script=$4
  shift 4
  log=$tmp/$name.log
  : >"$log"
  rc=0
  FAKE_GCLOUD_LOG=$log FAKE_GCLOUD_SCENARIO=$scenario HYDREX_CONFIG=$root/test/sh/config/$config.env \
    "$test_sh" "$root/sh/$script" "$@" >"$tmp/$name.out" 2>&1 || rc=$?
  {
    printf 'exit=%s\n--- output ---\n' "$rc"
    cat "$tmp/$name.out"
  } >>"$log"
  golden=$root/test/sh/golden/$name.txt
  if grep -Eq '^exit=12[67]$' "$log"; then # 126/127: broken script
    printf 'FAIL    %s: exit 126/127\n' "$name"
    cat "$tmp/$name.out"
    failures=$((failures + 1))
  elif [ "$update" = yes ]; then
    cp "$log" "$golden"
    printf 'updated %s\n' "$name"
  elif [ -f "$golden" ] && diff -u "$golden" "$log" >"$tmp/$name.diff"; then
    printf 'ok      %s\n' "$name"
  else
    printf 'FAIL    %s\n' "$name"
    cat "$tmp/$name.diff" 2>/dev/null || printf '(no golden %s)\n' "$golden"
    failures=$((failures + 1))
  fi
}

golden_case setup-fresh fresh keeper setup.sh
golden_case setup-existing existing keeper setup.sh
golden_case setup-list-fails list-fails keeper setup.sh
golden_case deploy-no-secret fresh keeper deploy.sh
golden_case deploy-first first-deploy keeper deploy.sh
golden_case deploy-existing existing keeper deploy.sh
golden_case deploy-stale drift keeper deploy.sh
golden_case deploy-list-fails list-fails keeper deploy.sh
golden_case deploy-spaces existing spaces deploy.sh
golden_case deploy-coingecko existing coingecko deploy.sh
golden_case run-dry existing keeper run.sh --dry-run --now
golden_case run-bad-arg existing keeper run.sh --later
golden_case config-uncovered existing uncovered run.sh --now
golden_case config-zeros existing zeros run.sh --now
golden_case config-every-block existing every-block run.sh --now
golden_case config-bad-module existing bad-module run.sh --now
golden_case check-ok existing keeper check.sh
golden_case check-drift drift keeper check.sh
golden_case check-fresh fresh keeper check.sh
golden_case check-list-fails list-fails keeper check.sh

[ "$failures" -eq 0 ] || {
  printf '%s golden case(s) failed\n' "$failures"
  exit 1
}
printf 'all golden cases passed\n'
