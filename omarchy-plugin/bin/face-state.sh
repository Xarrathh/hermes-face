#!/usr/bin/env bash
# Print /state, authenticated. The widget and the bar scripts all go through here so the token
# lives in exactly one place. Read-only; safe to call as often as the bar likes.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
PREFIX="${HERMES_FACE_PREFIX:-$HOME/.local/share/hermes-face}"
TOKEN=$(head -1 "$PREFIX/token" 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
  exit 1
fi
curl -s --max-time 2 -H "X-Face-Token: $TOKEN" "http://127.0.0.1:$PORT/state"
