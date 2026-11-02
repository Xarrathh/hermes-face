#!/usr/bin/env bash
# Stop the live turn and its speech, from the bar or a global keybinding.
# Refuses when nothing is running, and carries the prefix token: the bridge no longer trusts
# anything that merely happens to be on loopback.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
PREFIX="${HERMES_FACE_PREFIX:-$HOME/.local/share/hermes-face}"
TOKEN=$(head -1 "$PREFIX/token" 2>/dev/null || true)
LOG="$HOME/.cache/hermes-face-bar.log"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

if [ -z "$TOKEN" ]; then
  say "interrupt: no token in $PREFIX, ignored"
  exit 0
fi

state=$(curl -s --max-time 2 -H "X-Face-Token: $TOKEN" "http://127.0.0.1:$PORT/state")
agent=$(printf '%s' "$state" | grep -o '"agent": "[a-z]*"' | head -1 | cut -d'"' -f4)
if [ -z "$agent" ]; then
  say "interrupt: face not reachable or not authorised, ignored"
  exit 0
fi
if [ "$agent" = "idle" ]; then
  say "interrupt: nothing running, ignored"
  exit 0
fi
curl -s --max-time 3 -H "X-Face-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{}' "http://127.0.0.1:$PORT/interrupt" >/dev/null
say "interrupt: stopped a turn (was $agent)"
