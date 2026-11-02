#!/usr/bin/env bash
# Print /state for the bar widget.
#
# No secret on the command line: the bridge authorises by the owning uid of the connecting
# socket, so a token in argv (readable by every local account through ps) is not needed.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
PREFIX="${HERMES_FACE_PREFIX:-$HOME/.local/share/hermes-face}"
MARKER="$PREFIX/.last-error"

# When the bridge is not answering the widget still has to say something useful, so a marker left
# by face-ensure names the step that broke instead of a bare cross with no reason.
body=$(curl -s --max-time 2 "http://127.0.0.1:$PORT/state" 2>/dev/null)
if [ -n "$body" ]; then
  printf '%s' "$body"
  exit 0
fi

reason="the bridge is not running"
[ -f "$MARKER" ] && reason=$(head -c 300 "$MARKER" 2>/dev/null)
printf '{"agent":"idle","error":"%s"}' "$(printf '%s' "$reason" | tr -d '"\\' | tr '\n' ' ')"
