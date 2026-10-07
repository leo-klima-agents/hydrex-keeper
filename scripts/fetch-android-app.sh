#!/usr/bin/env bash
# Downloads the Android app (com.app.lkl.berlin) from the APKCombo mirror and
# decompiles its Hermes bytecode bundle.
#
#   scripts/fetch-android-app.sh [outdir]    (default: ./work/android)
#
# The analysis in README.md used lokal Berlin 1.0.5 (versionCode 34), an Expo /
# React Native app (Expo slug "lkl-gnosis") whose JavaScript ships as Hermes
# bytecode v98. APKCombo is a third-party mirror: compare the version in the
# XAPK manifest with the Play Store listing before relying on it.
#
# Needs curl, unzip, python3 (for hermes-dec).
set -euo pipefail

OUT="${1:-work/android}"
PKG="com.app.lkl.berlin"
SLUG="lokal-berlin"
UA="Mozilla/5.0"
mkdir -p "$OUT/xapk"

# APKCombo either embeds the base64-encoded download link in the page (once
# cached) or builds it in JavaScript by POSTing the package name to the page's
# /dl endpoint. Handle both.
page="https://apkcombo.com/$SLUG/$PKG/download/apk"
find_link() { grep -oE 'apkcombo\.com/d\?u=[A-Za-z0-9+/=]+' | head -1 | cut -d= -f2- || true; }
html="$(curl -fsS --retry 3 --retry-all-errors -A "$UA" "$page")"
encoded="$(printf '%s' "$html" | find_link)"
if [ -z "$encoded" ]; then
  xid="$(printf '%s' "$html" | grep -oE 'var xid = "[^"]+"' | cut -d'"' -f2 || true)"
  [ -n "$xid" ] || { echo "no download link or xid on $page; the mirror layout changed" >&2; exit 1; }
  encoded="$(curl -fsS --retry 3 --retry-all-errors -A "$UA" -H "Referer: $page" -X POST \
    -F "package_name=$PKG" -F "version=" "https://apkcombo.com/$SLUG/$PKG/$xid/dl" | find_link)"
fi
url="$(printf '%s' "$encoded" | base64 -d)"
checkin="$(curl -fsS --retry 3 --retry-all-errors -A "$UA" -X POST https://apkcombo.com/checkin)"
curl -fsSL --retry 3 --retry-all-errors -A "$UA" "$url&$checkin" -o "$OUT/lokal.xapk"

unzip -q -o "$OUT/lokal.xapk" -d "$OUT/xapk"
cat "$OUT/xapk/manifest.json"; echo
unzip -q -o "$OUT/xapk/$PKG.apk" -d "$OUT/base"

python3 -m venv "$OUT/venv"
"$OUT/venv/bin/pip" install -q hermes-dec
"$OUT/venv/bin/hbc-decompiler" "$OUT/base/assets/index.android.bundle" "$OUT/decompiled.js"

echo "Expo config:  $OUT/base/assets/app.config"
echo "Decompiled:   $OUT/decompiled.js  (search for 'sendKreuzer', 'kiez:wallet', 'What are Kreuzer?')"
