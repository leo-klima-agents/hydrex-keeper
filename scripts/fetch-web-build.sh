#!/usr/bin/env bash
# Downloads the public web build of lokal (https://app.lkl.berlin, a Next.js
# app) and de-minifies the lokal-specific chunks.
#
#   scripts/fetch-web-build.sh [outdir]      (default: ./work/web)
#
# Needs curl, python3 and npx (for prettier). No source maps are published, so
# what you get is pretty-printed webpack output, not the original TypeScript.
set -euo pipefail

OUT="${1:-work/web}"
BASE="https://app.lkl.berlin"
mkdir -p "$OUT/raw" "$OUT/pretty"

curl -fsS --retry 3 --retry-all-errors "$BASE/" -o "$OUT/index.html"

# Chunks referenced directly by the HTML (runtime, framework, entry).
grep -oE '/_next/static/[^"\\ ]+\.js' "$OUT/index.html" | sort -u > "$OUT/initial-chunks.txt"
while read -r path; do
  curl -fsS --retry 3 --retry-all-errors "$BASE$path" -o "$OUT/raw/$(basename "$path")"
done < "$OUT/initial-chunks.txt"

# The app itself is loaded lazily; the webpack runtime holds the id -> file map.
runtime="$(ls "$OUT"/raw/webpack-*.js)"
python3 -I - "$runtime" > "$OUT/lazy-chunks.txt" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'd\.u=e=>.*?"static/chunks/"\+\(\((\{.*?\})\)\[e\]\|\|e\)\+"\."\+\((\{.*?\})\)\[e\]\+"\.js"', src)
if not m:
    sys.exit("webpack chunk map not found; the build layout changed")
names = dict(re.findall(r'(\d+):"([0-9a-f]+)"', m.group(1)))
for cid, h in re.findall(r'(\d+):"([0-9a-f]+)"', m.group(2)):
    print(f"static/chunks/{names.get(cid, cid)}.{h}.js")
PY
while read -r path; do
  curl -fsS --retry 3 --retry-all-errors "$BASE/_next/$path" -o "$OUT/raw/$(basename "$path")"
done < "$OUT/lazy-chunks.txt"

# The lokal code is the chunk that carries the API URL; strings live in the
# chunk that defines the "yourKreuzer" dictionary entry.
app_chunk="$(grep -l 'https://api.lkl.berlin' "$OUT"/raw/*.js | head -1)"
i18n_chunk="$(grep -l 'yourKreuzer:"' "$OUT"/raw/*.js | head -1)"
for f in "$app_chunk" "$i18n_chunk"; do
  npx --yes prettier@3 --parser babel "$f" > "$OUT/pretty/$(basename "$f")"
done

echo "app chunk:  $OUT/pretty/$(basename "$app_chunk")"
echo "i18n chunk: $OUT/pretty/$(basename "$i18n_chunk")"
