#!/bin/sh
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

# golden_case NAME SCENARIO CONFIG SCRIPT [ARGS...]
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
    # The checkout's path, taken literally rather than as a pattern.
    ROOT=$root awk '{
      while ((i = index($0, ENVIRON["ROOT"])) > 0) $0 = substr($0, 1, i - 1) "<repo>" substr($0, i + length(ENVIRON["ROOT"]))
      print
    }' "$tmp/$name.out"
  } >>"$log"
  golden=$root/test/sh/golden/$name.txt
  if grep -Eq '^exit=12[67]$' "$log"; then # the shell couldn't run a command
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
golden_case deploy-drift drift keeper deploy.sh
golden_case deploy-coingecko existing coingecko deploy.sh
golden_case run-dry existing keeper run.sh --dry-run --now
golden_case run-claim existing keeper run.sh --dry-run --claim
golden_case run-bad-arg existing keeper run.sh --later
golden_case run-now-claim existing keeper run.sh --now --dry-run --claim
golden_case config-bad-module existing bad-module run.sh --now
golden_case config-missing-proposer existing missing-proposer run.sh --now
golden_case config-shared-key existing shared-key run.sh --now
golden_case check-ok existing keeper check.sh
golden_case check-drift drift keeper check.sh
golden_case check-fresh fresh keeper check.sh
golden_case check-list-fails list-fails keeper check.sh
golden_case check-conduit-missing no-conduit keeper check.sh

[ "$failures" -eq 0 ] || {
  printf '%s golden case(s) failed\n' "$failures"
  exit 1
}
printf 'all golden cases passed\n'
