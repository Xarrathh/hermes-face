#!/usr/bin/env bash
# Stop the live turn and its speech, from the bar or a global keybinding.
# Refuses when nothing is running; authorisation is the socket's owning uid, so no secret goes
# into a command line where any local account could read it.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
LOG="$HOME/.cache/hermes-face-bar.log"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

state=$(curl -s --max-time 2 "http://127.0.0.1:$PORT/state")
agent=$(printf '%s' "$state" | grep -o '"agent": "[a-z]*"' | head -1 | cut -d'"' -f4)
if [ -z "$agent" ]; then
  say "interrupt: face not reachable or not authorised, ignored"
  exit 0
fi
if [ "$agent" = "idle" ]; then
  say "interrupt: nothing running, ignored"
  exit 0
fi
curl -s --max-time 3 -H 'content-type: application/json' -d '{}' \
  "http://127.0.0.1:$PORT/interrupt" >/dev/null
say "interrupt: stopped a turn (was $agent)"
