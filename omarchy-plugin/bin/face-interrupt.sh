#!/usr/bin/env bash
# Stop the live turn and its speech from the bar, without opening the face.
# It refuses when nothing is running: a stray right click must not kill a turn that is
# not there, and a log line makes an accidental trigger obvious.
set -u
LOG="$HOME/.cache/hermes-face-bar.log"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

state=$(curl -s --max-time 2 http://127.0.0.1:9120/state)
agent=$(printf '%s' "$state" | grep -o '"agent": "[a-z]*"' | head -1 | cut -d'"' -f4)
if [ -z "$agent" ]; then
  say "interrupt: face not reachable, ignored"
  exit 0
fi
if [ "$agent" = "idle" ]; then
  say "interrupt: nothing running, ignored"
  exit 0
fi
curl -s --max-time 3 -X POST -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:9120/interrupt >/dev/null
say "interrupt: stopped a turn (was $agent)"
