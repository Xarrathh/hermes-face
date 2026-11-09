#!/usr/bin/env bash
# Set this face's spoken name and the words that address it.
#
#   face-name.sh "Suzie"              # rename, keep the aliases
#   face-name.sh "Suzie" "suzie,suzanna"   # rename and replace the alias list
#   face-name.sh                     # prompt for both (reads stdin), for a terminal or a menu
#
# The name lives in peering.json next to the bridge, because that is what face-peer reads to
# decide whether a sentence is addressed to this face. No service restart is needed: the
# sidecar and the beacon re-read the file.
set -u
CFG="${HERMES_FACE_PEERING:-$HOME/.local/share/hermes-face/peering.json}"

name="${1-}"
aliases="${2-}"
if [ -z "$name" ]; then
  read -r -p "Face name: " name
  read -r -p "Aliases (comma separated, blank keeps current): " aliases
fi
[ -n "$name" ] || { echo "a face needs a name" >&2; exit 2; }

python3 - "$CFG" "$name" "$aliases" <<'PY'
import json, os, sys, tempfile

path, name, aliases = sys.argv[1], sys.argv[2].strip(), sys.argv[3].strip()
try:
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not isinstance(cfg, dict):
        cfg = {}
except (OSError, ValueError):
    cfg = {}

cfg["name"] = name
if aliases:
    cfg["aliases"] = [a.strip() for a in aliases.split(",") if a.strip()]
else:
    cfg.setdefault("aliases", [name.lower(), name.lower().replace("-", " ")])

os.makedirs(os.path.dirname(path), exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".peering-")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
os.replace(tmp, path)          # atomic: a half-written file would leave the face nameless
print(f'{cfg["name"]} — aliases: {", ".join(cfg["aliases"])}')
PY
