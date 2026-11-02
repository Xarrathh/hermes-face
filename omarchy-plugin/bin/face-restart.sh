#!/usr/bin/env bash
# Restart the face bridge from the bar. This is the user asking for it, so it is allowed to
# drop a live turn — the window comes back and reconnects on its own.
set -u
LOG="$HOME/.cache/hermes-face-bar.log"
printf '%s %s\n' "$(date '+%F %T')" "restart: requested from the bar" >>"$LOG"
systemctl --user restart hermes-face
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s --max-time 2 http://127.0.0.1:9120/health | grep -q '"ok": true'; then
    printf '%s %s\n' "$(date '+%F %T')" "restart: face is answering again" >>"$LOG"
    exit 0
  fi
done
printf '%s %s\n' "$(date '+%F %T')" "restart: face did not answer within 10s" >>"$LOG"
exit 1
