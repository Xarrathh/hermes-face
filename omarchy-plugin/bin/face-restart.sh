#!/usr/bin/env bash
# Restart the face bridge from the bar — the supported "load the new code" action.
#
# It syncs the vendored face into the prefix *before* restarting, so an update actually runs the
# reviewed code instead of the old file that happened to be on disk. Dropping a live turn is
# fine here: this is the user asking for it.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/.cache/hermes-face-bar.log"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

say "restart: requested from the bar"
"$HERE/face-ensure.sh" >/dev/null 2>&1 || true

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 && [ "$PORT" = "9120" ]; then
  systemctl --user restart hermes-face.service >/dev/null 2>&1 || true
fi

for _ in $(seq 1 20); do
  sleep 1
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok": true'; then
    say "restart: face is answering again"
    exit 0
  fi
done
say "restart: face did not answer within 20s"
exit 1
