#!/bin/sh
# curl stub for the golden tests: logs each JSON-RPC call to $FAKE_GCLOUD_LOG and answers check.sh's two calls.
# In the drift scenario, the first node times out and the keeper is underfunded.
set -eu

: "${FAKE_GCLOUD_LOG:?}" "${FAKE_GCLOUD_SCENARIO:?}"

body='' url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -d) body=$2 && shift ;;
    -H | --max-time) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
method=$(printf '%s' "$body" | jq -r .method)
printf 'curl %s %s %s\n' "$url" "$method" "$(printf '%s' "$body" | jq -c .params)" >>"$FAKE_GCLOUD_LOG"
if [ "$FAKE_GCLOUD_SCENARIO" = drift ] && [ "$url" = https://mainnet.base.org ]; then
  printf 'curl: (28) Operation timed out after 15001 milliseconds\n' >&2
  exit 28
fi
case "$method" in
  eth_call) result=0x000000000000000000000000625cf6663d9d090535fbd57680bffe6fa0262434 ;;
  eth_getBalance) if [ "$FAKE_GCLOUD_SCENARIO" = drift ]; then result=0x5af3107a4000; else result=0x11c37937e08000; fi ;;
  *)
    printf 'fake-curl: unexpected method %s\n' "$method" >&2
    exit 99
    ;;
esac
printf '{"jsonrpc":"2.0","id":1,"result":"%s"}\n' "$result"
