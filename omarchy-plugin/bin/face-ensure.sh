#!/usr/bin/env bash
# Make sure the Hermes face bridge is running *the code that shipped in this plugin*.
#
# Three jobs, in this order, because an update must actually take effect:
#   1. sync the vendored face/server.py + face/web/ into the prefix (never touching the user's
#      config.json or history.json) and remember which version was installed;
#   2. start the bridge if it is not answering;
#   3. restart it if the vendored code changed under a healthy bridge — otherwise the old,
#      possibly vulnerable, server keeps running and the fixes never load.
# A click on an unchanged install does not interrupt a live turn.
set -u

PORT="${HERMES_FACE_PORT:-9120}"
PREFIX="${HERMES_FACE_PREFIX:-$HOME/.local/share/hermes-face}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$PREFIX/.installed-version"
LOG="$HOME/.cache/hermes-face-bar.log"
UNIT_NAME="hermes-face.service"
UNIT="$HOME/.config/systemd/user/$UNIT_NAME"

say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
healthy() { curl -sf -m 1 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; }
use_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 && [ "$PORT" = "9120" ]; }

mkdir -p "$PREFIX" || { say "ensure: cannot create $PREFIX"; exit 1; }

vendor_hash() {
  ( cd "$PLUGIN_DIR/face" && { sha256sum server.py; ls web/* | sort | xargs sha256sum; } 2>/dev/null ) \
    | sha256sum | cut -d' ' -f1
}

VENDOR=$(vendor_hash)
INSTALLED=$(cat "$STAMP" 2>/dev/null || true)

sync_code() {
  # true when the prefix now holds different code than it did
  [ "$VENDOR" = "$INSTALLED" ] && return 1
  cp -f "$PLUGIN_DIR/face/server.py" "$PREFIX/server.py" || { say "ensure: cannot copy server.py"; return 1; }
  mkdir -p "$PREFIX/web"
  cp -f "$PLUGIN_DIR"/face/web/* "$PREFIX/web/" || { say "ensure: cannot copy web/"; return 1; }
  if [ ! -f "$PREFIX/config.json" ] && [ -f "$PLUGIN_DIR/face/config.example.json" ]; then
    cp -f "$PLUGIN_DIR/face/config.example.json" "$PREFIX/config.json"
  fi
  printf '%s\n' "$VENDOR" > "$STAMP"
  say "ensure: code updated to $VENDOR"
  return 0
}

CHANGED=0
sync_code && CHANGED=1

# Speech engine: prefer a working copy, else a private venv beside the face (no root).
PY=""
if [ -x "$PREFIX/.venv/bin/python" ] && "$PREFIX/.venv/bin/python" -c "import edge_tts" >/dev/null 2>&1; then
  PY="$PREFIX/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1 && python3 -c "import edge_tts" >/dev/null 2>&1; then
  PY="$(command -v python3)"
else
  if [ ! -x "$PREFIX/.venv/bin/python" ]; then
    python3 -m venv "$PREFIX/.venv" >/dev/null 2>&1 || { say "ensure: python3 -m venv failed"; exit 1; }
  fi
  "$PREFIX/.venv/bin/pip" install --quiet --disable-pip-version-check edge-tts >/dev/null 2>&1
  "$PREFIX/.venv/bin/python" -c "import edge_tts" >/dev/null 2>&1 \
    || say "ensure: edge-tts unavailable; the face will run silent"
  PY="$PREFIX/.venv/bin/python"
fi

if healthy && [ "$CHANGED" = "0" ]; then
  exit 0                       # nothing to do, and no turn interrupted
fi

write_unit() {
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Hermes face - holographic agent head bridge (127.0.0.1:$PORT)
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
ExecStart=$PY $PREFIX/server.py
Environment=HERMES_FACE_PORT=$PORT
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 || true
}

if use_systemd; then
  # A unit left over from an earlier install may point at an interpreter that no longer exists,
  # so rewrite it whenever it is missing or names the wrong python.
  if [ ! -f "$UNIT" ] || ! grep -q "^ExecStart=$PY $PREFIX/server.py$" "$UNIT" 2>/dev/null; then
    write_unit
  fi
  say "ensure: restarting $UNIT_NAME to run the installed code"
  systemctl --user restart "$UNIT" >/dev/null 2>&1 || true
else
  # No systemd: an old bridge may still be holding the port, and starting a second one would
  # simply fail to bind while the old code kept answering. Stop the process that owns the port.
  if healthy; then
    old_pid=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    if [ -n "${old_pid:-}" ]; then
      say "ensure: stopping the old bridge (pid $old_pid) before installing"
      kill "$old_pid" 2>/dev/null || true
      for _ in $(seq 1 40); do
        healthy || break
        sleep 0.25
      done
    fi
  fi
  say "ensure: starting a detached bridge on port $PORT"
  ( cd "$PREFIX" && setsid env HERMES_FACE_PORT="$PORT" PYTHONUNBUFFERED=1 "$PY" server.py >/dev/null 2>&1 & )
fi

for _ in $(seq 1 120); do
  healthy && say "ensure: bridge is answering" && exit 0
  sleep 0.25
done
say "ensure: bridge did not answer within 30s"
exit 1
