#!/usr/bin/env bash
# Flip the theme hook on or off from the bar menu.
#
# The hook itself lives in ~/.config/omarchy/hooks/theme-set.d and the on/off switch is a flag file
# the face reads; this just toggles that flag and reports the new state in the bar log.
set -u
LOG="$HOME/.cache/hermes-face-bar.log"
FLAG="$HOME/.local/share/hermes-face/theme-sync-off"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

mkdir -p "$(dirname "$FLAG")" 2>/dev/null || true
if [ -f "$FLAG" ]; then
  rm -f "$FLAG"
  say "theme sync: on (flag cleared)"
  # Re-apply the current theme's accent now rather than waiting for the next theme change.
  if [ -x "$HOME/.local/bin/hermes-face-theme-sync" ]; then
    "$HOME/.local/bin/hermes-face-theme-sync" on >/dev/null 2>&1 || true
  fi
else
  : > "$FLAG"
  say "theme sync: off (flag set)"
fi
