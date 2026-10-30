#!/usr/bin/env bash
# Bring the Hermes face forward: workspace 1 is its home, so a click always lands there
# and starts the window if it is not running.
set -u
CLASS="chrome-127.0.0.1__face_-Default"
# This Hyprland build evaluates dispatch arguments as Lua: the space form errors out and
# does nothing, the comma form still dispatches. Workspace 1 is the face's home.
hyprctl dispatch 'workspace,1' >/dev/null 2>&1
if hyprctl clients -j | grep -q "\"class\": \"$CLASS\""; then
  hyprctl dispatch focuswindow "class:$CLASS" >/dev/null
  hyprctl dispatch 'workspace,1' >/dev/null 2>&1   # and make sure it lands on its own desk
else
  setsid "$HOME/.local/bin/hermes-face-kiosk" --app >/dev/null 2>&1 &
fi
