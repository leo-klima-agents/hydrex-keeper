#!/bin/sh
# run.sh [--update]: every script under $TEST_SH (default dash) against
# test/sh/fake-gcloud, diffed against test/sh/golden/<case>.txt.
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

# golden_case NAME CONFIG SCENARIO SCRIPT [ARGS...]: runs, appends the exit code, compares.
golden_case() {
  name=$1
  config=$2
  scenario=$3
  script=$4
  shift 4
  log=$tmp/$name.log
  : >"$log"
  rc=0
  FAKE_GCLOUD_LOG=$log FAKE_GCLOUD_SCENARIO=$scenario HYDREX_CONFIG=$root/test/sh/config/$config.env \
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

golden_case setup-fresh keeper fresh setup.sh
golden_case setup-existing keeper existing setup.sh
golden_case deploy-no-secret keeper fresh deploy.sh
golden_case deploy-first keeper first-deploy deploy.sh
golden_case deploy-existing keeper existing deploy.sh
golden_case deploy-stale keeper drift deploy.sh
golden_case deploy-no-list keeper no-list deploy.sh
golden_case run-dry keeper existing run.sh --dry-run --now
golden_case run-bad-arg keeper existing run.sh --later
golden_case config-uncovered uncovered existing run.sh --now
golden_case config-zeros zeros existing run.sh --now
golden_case check-ok keeper existing check.sh
golden_case check-drift keeper drift check.sh
golden_case check-fresh keeper fresh check.sh
golden_case check-no-list keeper no-list check.sh

[ "$failures" -eq 0 ] || { printf '%s golden case(s) failed\n' "$failures"; exit 1; }
printf 'all golden cases passed\n'
