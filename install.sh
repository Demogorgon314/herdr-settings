#!/usr/bin/env bash
# Install the layout in this repo into the Herdr home: layouts/, mods/ and its
# section of keys.json. Anything replaced is kept as <name>.backup-<time>.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
LAYOUT="$(basename "$(ls "$HERE"/layouts/*.json | head -1)" .json)"
STAMP="$(date +%Y%m%d-%H%M%S)"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
command -v herdr-app >/dev/null 2>&1 || die "herdr-app not found. Install Herdr (https://herdr.dev) first."
[ -d "$APP_HOME" ] || die "$APP_HOME does not exist. Open Herdr once first."

backup() {
  [ -e "$1" ] || return 0
  mv "$1" "$1.backup-$STAMP"
  echo "  backed up $(basename "$1") -> $(basename "$1").backup-$STAMP"
}

# A shown layout keeps its old code: leave it before its files change.
current="$(herdr-app status 2>/dev/null | sed -n 's/.*"layout": *"\([^"]*\)".*/\1/p' | head -1 || true)"
[ "$current" = "$LAYOUT" ] && herdr-app do layout.switch --name main >/dev/null 2>&1 || true

mkdir -p "$APP_HOME/layouts" "$APP_HOME/mods"
for f in "$HERE"/layouts/*; do
  backup "$APP_HOME/layouts/$(basename "$f")"
  cp "$f" "$APP_HOME/layouts/"
done
echo "installed layout $LAYOUT"

for d in "$HERE"/mods/*/; do
  m="$(basename "$d")"
  backup "$APP_HOME/mods/$m"
  cp -R "$d" "$APP_HOME/mods/$m"
  echo "installed mod $m"
done

# Merge the layout's keys into keys.json, leaving every other section alone.
if [ -f "$HERE/keys.json" ]; then
  [ -f "$APP_HOME/keys.json" ] && cp "$APP_HOME/keys.json" "$APP_HOME/keys.json.backup-$STAMP"
  python3 - "$HERE/keys.json" "$APP_HOME/keys.json" <<'PY'
import json, os, sys
src, dst = sys.argv[1:]
keys = json.load(open(dst)) if os.path.exists(dst) else {}
keys.update(json.load(open(src)))
open(dst, "w").write(json.dumps(keys, indent=2, ensure_ascii=False) + "\n")
PY
  echo "merged keys.json"
fi

fail=0
for d in "$HERE"/mods/*/; do
  m="$(basename "$d")"
  if out="$(herdr-app check "$APP_HOME/mods/$m" 2>&1)"; then echo "  ok   $m"; else echo "  FAIL $m: $out"; fail=1; fi
done
[ "$fail" = 0 ] || die "a mod failed its check; layout not switched."

if herdr-app do layout.switch --name "$LAYOUT" >/dev/null 2>&1; then
  echo "switched to $LAYOUT"
else
  echo "files are in place; open Herdr, then: herdr-app do layout.switch --name $LAYOUT"
fi
