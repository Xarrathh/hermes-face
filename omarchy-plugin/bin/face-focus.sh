#!/usr/bin/env bash
# Bring the Hermes face window forward, or start it if it is not running.
set -u
CLASS="chrome-127.0.0.1__face_-Default"
if hyprctl clients -j | grep -q "\"class\": \"$CLASS\""; then
  hyprctl dispatch focuswindow "class:$CLASS" >/dev/null
else
  setsid "$HOME/.local/bin/hermes-face-kiosk" --app >/dev/null 2>&1 &
fi
