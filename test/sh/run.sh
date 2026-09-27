#!/bin/sh
# Runs the scripts in sh/ under $TEST_SH (default dash) against fake-gcloud and diffs with golden/; --update rewrites it.
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
test_sh=${TEST_SH:-dash}
update=no
case "$#:${1:-}" in
  0:) ;;
  1:--update) update=yes ;;
  *) printf 'usage: %s [--update]\n' "$0" >&2; exit 2 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$tmp/bin"
ln -s "$root/test/sh/fake-gcloud" "$tmp/bin/gcloud"
PATH=$tmp/bin:$PATH
export PATH
failures=0

# golden_case NAME SCENARIO SCRIPT [ARGS...]: runs with $CONFIG (default keeper), appends the exit code, compares.
golden_case() {
  name=$1
  scenario=$2
  script=$3
  shift 3
  log=$tmp/$name.log
  : >"$log"
  rc=0
  FAKE_GCLOUD_LOG=$log FAKE_GCLOUD_SCENARIO=$scenario HYDREX_CONFIG=$root/test/sh/config/${CONFIG:-keeper}.env \
    "$test_sh" "$root/sh/$script" "$@" >"$tmp/$name.out" 2>&1 || rc=$?
  { printf 'exit=%s\n--- output ---\n' "$rc"; cat "$tmp/$name.out"; } >>"$log"
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

golden_case setup-fresh fresh setup.sh
golden_case setup-existing existing setup.sh
golden_case deploy-no-secret fresh deploy.sh
golden_case deploy-first first-deploy deploy.sh
golden_case deploy-existing existing deploy.sh
golden_case deploy-stale drift deploy.sh
golden_case deploy-list-fails list-fails deploy.sh
golden_case run-dry existing run.sh --dry-run --now
golden_case run-bad-arg existing run.sh --later
CONFIG=uncovered golden_case config-uncovered existing run.sh --now
CONFIG=zeros golden_case config-zeros existing run.sh --now
CONFIG=bad-module golden_case config-bad-module existing run.sh --now
golden_case check-ok existing check.sh
golden_case check-drift drift check.sh
golden_case check-fresh fresh check.sh
golden_case check-list-fails list-fails check.sh

[ "$failures" -eq 0 ] || { printf '%s golden case(s) failed\n' "$failures"; exit 1; }
printf 'all golden cases passed\n'
