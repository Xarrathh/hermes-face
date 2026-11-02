#!/usr/bin/env bash
# Print /state for the bar widget.
#
# No secret on the command line: the bridge authorises by the owning uid of the connecting
# socket, so a token in argv (readable by every local account through ps) is not needed.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
curl -s --max-time 2 "http://127.0.0.1:$PORT/state"
