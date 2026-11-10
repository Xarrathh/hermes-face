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
# A 401 body is JSON too, and printing it made the widget report a reachable bridge in a state
# it never sends. Only a real /state document has an "agent" field; anything else is a failure
# and is reported as one.
case "$body" in
  *'"agent"'*) printf '%s' "$body"; exit 0 ;;
esac

reason="the bridge is not running"
[ -f "$MARKER" ] && reason=$(head -c 300 "$MARKER" 2>/dev/null)
[ -n "$body" ] && reason="the bridge refused the request (is the token readable?)"
printf '{"agent":"idle","error":"%s"}' "$(printf '%s' "$reason" | tr -s '[:cntrl:]' ' ' | tr -d '"\\')"
