#!/usr/bin/env bash
# Pull one layout from the Herdr home into this repo: layouts/<name>.json, its
# preview, the mods of mine it needs and its section of keys.json.
# Usage: ./sync.sh [layout]   (default: the layout the window shows now)
# Herdr's shipped mods (listed in installed.json) are skipped: every Herdr has them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

LAYOUT="${1:-$(herdr-app status 2>/dev/null | sed -n 's/.*"layout": *"\([^"]*\)".*/\1/p' | head -1)}"
[ -n "$LAYOUT" ] || { echo "error: no layout given and the Herdr window is not running" >&2; exit 1; }
[ -f "$APP_HOME/layouts/$LAYOUT.json" ] || { echo "error: $APP_HOME/layouts/$LAYOUT.json not found" >&2; exit 1; }

rm -rf "$HERE/layouts" "$HERE/mods"
mkdir -p "$HERE/layouts" "$HERE/mods"

cp "$APP_HOME/layouts/$LAYOUT.json" "$HERE/layouts/"
for p in "$APP_HOME/layouts/$LAYOUT".{png,svg}; do [ -f "$p" ] && cp "$p" "$HERE/layouts/"; done
echo "layout  $LAYOUT"

# My mods the layout needs: those it places, plus any my mods name in their code
# (a mod opening another one), followed until nothing new turns up.
mods="$(python3 - "$APP_HOME" "$LAYOUT" <<'PY'
import json, os, re, sys
home, layout = sys.argv[1], sys.argv[2]
shipped = set(json.load(open(os.path.join(home, "installed.json"))))
mine = {m for m in os.listdir(os.path.join(home, "mods"))
        if m not in shipped and os.path.isfile(os.path.join(home, "mods", m, "main.js"))}
text = open(os.path.join(home, "layouts", layout + ".json")).read()
need = set(re.findall(r'"mod":\s*"([^"]+)"', text)) & mine
todo = list(need)
while todo:
    d = os.path.join(home, "mods", todo.pop())
    code = "".join(open(os.path.join(d, f), errors="ignore").read()
                   for f in os.listdir(d) if f.endswith((".js", ".cjs")))
    for m in mine - need:
        if re.search(r'(?<![\w-])' + re.escape(m) + r'(?![\w-])', code):
            need.add(m); todo.append(m)
print("\n".join(sorted(need)))
PY
)"

for m in $mods; do
  rsync -a --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude '*.backup-*' --exclude .DS_Store \
    "$APP_HOME/mods/$m/" "$HERE/mods/$m/"
  echo "mod     $m"
done

# Only this layout's keys; my global and terminal keys stay out.
python3 - "$APP_HOME/keys.json" "$LAYOUT" "$HERE/keys.json" <<'PY'
import json, sys
src, layout, dst = sys.argv[1:]
section = "layout:" + layout
keys = json.load(open(src)).get(section)
out = {section: keys} if keys else {}
open(dst, "w").write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
PY
echo "keys.json"
