#!/usr/bin/env bash
# Remove the layout in this repo and its mods from the Herdr home, restoring
# what install.sh backed up. Its keys.json section is removed too.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
LAYOUT="$(basename "$(ls "$HERE"/layouts/*.json | head -1)" .json)"

current="$(herdr-app status 2>/dev/null | sed -n 's/.*"layout": *"\([^"]*\)".*/\1/p' | head -1 || true)"
[ "$current" = "$LAYOUT" ] && herdr-app do layout.switch --name main >/dev/null 2>&1 || true

# Put back the newest backup of <path>, if install.sh made one.
restore() {
  local b
  b="$(ls -d "$1".backup-* 2>/dev/null | sort | tail -1 || true)"
  [ -n "$b" ] || return 0
  mv "$b" "$1"
  echo "  restored $(basename "$1")"
}

for f in "$HERE"/layouts/*; do
  rm -f "$APP_HOME/layouts/$(basename "$f")"
  restore "$APP_HOME/layouts/$(basename "$f")"
done
echo "removed layout $LAYOUT"

for d in "$HERE"/mods/*/; do
  m="$(basename "$d")"
  rm -rf "$APP_HOME/mods/$m"
  restore "$APP_HOME/mods/$m"
  echo "removed mod $m"
done

if [ -f "$APP_HOME/keys.json" ]; then
  python3 - "$HERE/keys.json" "$APP_HOME/keys.json" <<'PY'
import json, sys
src, dst = sys.argv[1:]
keys = json.load(open(dst))
for section in json.load(open(src)):
    keys.pop(section, None)
open(dst, "w").write(json.dumps(keys, indent=2, ensure_ascii=False) + "\n")
PY
  echo "removed its keys from keys.json"
fi
