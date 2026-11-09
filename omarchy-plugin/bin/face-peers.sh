#!/usr/bin/env bash
# List the faces this one can talk to, one per line: "Name<TAB>ip:port<TAB>present"
#
# Reads the sidecar rather than scanning the LAN: face-peer already did the discovery, and a
# second implementation would disagree with it about who is present.
set -u
URL="${FACE_PEER_URL:-http://127.0.0.1:9910}"
exec python3 - "$URL" <<'PY'
import json, sys, urllib.request

url = sys.argv[1].rstrip("/")
try:
    with urllib.request.urlopen(url + "/peers", timeout=3) as r:
        data = json.load(r)
except Exception as exc:
    print(f"face-peer unreachable: {exc}", file=sys.stderr)
    sys.exit(1)

for p in data.get("peers", []):
    state = "present" if p.get("present") else "gone"
    print(f'{p.get("name") or p.get("id")}\t{p.get("ip")}:{p.get("port")}\t{state}')
PY
