#!/usr/bin/env bash
# Bring the Hermes face forward: workspace 1 is its home, so a click always lands there
# and starts the window if it is not running. Every run leaves a line in the log, because a
# click that does nothing looks identical to a click that never arrived.
set -u
LOG="$HOME/.cache/hermes-face-bar.log"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

# A bar-launched process may not carry Hyprland's socket name, and hyprctl then fails
# silently (empty output, exit 0). Resolve it here rather than trusting the environment.
if [ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
  sock=$(ls -d "/run/user/$(id -u)/hypr/"*/ 2>/dev/null | head -1)
  if [ -n "$sock" ]; then
    HYPRLAND_INSTANCE_SIGNATURE=$(basename "$sock")
    export HYPRLAND_INSTANCE_SIGNATURE
  fi
fi
say "focus: sig=${HYPRLAND_INSTANCE_SIGNATURE:-none}"

CLASS="chrome-127.0.0.1__face_-Default"
# This Hyprland build evaluates dispatch arguments as Lua: the space form errors out and does
# nothing, the comma form still dispatches.
hyprctl dispatch 'workspace,1' >/dev/null 2>&1
say "focus: workspace,1 -> $(hyprctl activeworkspace -j 2>/dev/null | grep -o '"id": [0-9]*' | head -1)"

if hyprctl clients -j 2>/dev/null | grep -q "\"class\": \"$CLASS\""; then
  hyprctl dispatch focuswindow "class:$CLASS" >/dev/null 2>&1
  hyprctl dispatch 'workspace,1' >/dev/null 2>&1
  say "focus: focused existing window on $(hyprctl activeworkspace -j 2>/dev/null | grep -o '"id": [0-9]*' | head -1)"
else
  setsid "$HOME/.local/bin/hermes-face-kiosk" --app >/dev/null 2>&1 &
  say "focus: no window, launched kiosk"
fi
