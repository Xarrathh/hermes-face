#!/usr/bin/env bash
# Allow or revoke the faces that may talk to this one.
#
#   face-trust.sh                          # list the faces seen and whether each is trusted
#   face-trust.sh allow Suzie              # trust the face called Suzie (by name or id)
#   face-trust.sh revoke Suzie             # stop trusting it
#   face-trust.sh allow '*'                # trust every face that holds the cluster key
#
# The shared peer.key says "same installation". This list says "this specific face may drive me",
# so one laptop with the key but an unknown id gets discovery and nothing else.
set -u
PEER_URL="${FACE_PEER_URL:-http://127.0.0.1:9910}"
KEY_FILE="${HERMES_FACE_KEY:-$HOME/.local/share/hermes-face/peer.key}"
KEY="$(cat "$KEY_FILE" 2>/dev/null || true)"

api() {  # api METHOD PATH JSON
  curl -s -m 5 -X "$1" -H 'Content-Type: application/json' \
       ${KEY:+-H "X-Peer-Key: $KEY"} ${2:+} \
       ${3:+-d "$3"} "$PEER_URL$2" 2>/dev/null
}

python3 - "$PEER_URL" "$KEY" "$@" <<'PY'
import json, sys, urllib.request

url, key = sys.argv[1].rstrip("/"), sys.argv[2]
argv = sys.argv[3:]


def call(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url + path, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json",
                                          **({"X-Peer-Key": key} if key else {})})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read() or b"{}")


try:
    state = call("/peers")
except Exception as exc:
    print(f"face-peer unreachable at {url}: {exc}", file=sys.stderr)
    sys.exit(1)

cmd = argv[0] if argv else "list"
target = " ".join(argv[1:]).strip()

if cmd == "list":
    trusted = state.get("trusted") or []
    peers = state.get("peers") or []
    print(f"trusted: {', '.join(trusted) if trusted else '(nobody — this face answers only loopback)'}")
    if not peers:
        print("no faces seen")
    for p in peers:
        mark = "yes" if p.get("trusted") else "NO"
        print(f"  {p.get('name') or p.get('id'):<20} id={p.get('id'):<16} "
              f"present={str(bool(p.get('present'))):<5} trusted={mark}")
    sys.exit(0)

if cmd not in ("allow", "revoke"):
    print(f"unknown command {cmd!r}; use list | allow <name> | revoke <name>", file=sys.stderr)
    sys.exit(2)
if not target:
    print(f"{cmd} needs a face name or id", file=sys.stderr)
    sys.exit(2)

try:
    out = call("/trust", {"name": target, "allow": cmd == "allow"})
except Exception as exc:
    print(f"could not change the trust list: {exc}", file=sys.stderr)
    sys.exit(1)
print(f"trusted now: {', '.join(out.get('trusted') or []) or '(nobody)'}")
PY
