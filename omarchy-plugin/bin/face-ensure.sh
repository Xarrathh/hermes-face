#!/usr/bin/env bash
# Make sure the Hermes face bridge is running, from the copy vendored inside this plugin.
#
# Runs the first time the widget is clicked, and does nothing once the bridge answers. It
# installs only what is in this repository plus one Python package, so there is no remote
# git fetch or build step: the code being run is the code that was reviewed.
set -u

PORT="${HERMES_FACE_PORT:-9120}"
PREFIX="${HERMES_FACE_PREFIX:-$HOME/.local/share/hermes-face}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/.cache/hermes-face-bar.log"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

healthy() { curl -sf -m 1 -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; }

if healthy; then
  exit 0
fi

say "ensure: bridge not answering on $PORT, starting it"

mkdir -p "$PREFIX" || { say "ensure: cannot create $PREFIX"; exit 1; }

# Code: copy the vendored tree in, but never overwrite the user's own look or history.
for f in server.py; do
  cp -f "$PLUGIN_DIR/face/$f" "$PREFIX/$f" 2>/dev/null || true
done
mkdir -p "$PREFIX/web"
cp -f "$PLUGIN_DIR"/face/web/* "$PREFIX/web/" 2>/dev/null || true
if [ ! -f "$PREFIX/config.json" ] && [ -f "$PLUGIN_DIR/face/config.example.json" ]; then
  cp -f "$PLUGIN_DIR/face/config.example.json" "$PREFIX/config.json"
fi

# Speech: edge-tts is the only third-party piece. Prefer a copy that already works, otherwise
# build a small private venv beside the face (no root, no system site-packages).
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
  if "$PREFIX/.venv/bin/python" -c "import edge_tts" >/dev/null 2>&1; then
    PY="$PREFIX/.venv/bin/python"
  else
    say "ensure: edge-tts unavailable; the face will run silent"
    PY="$PREFIX/.venv/bin/python"
  fi
fi

# Start it under systemd when we can (so it survives, and the bar can restart it), otherwise
# as a detached process. A non-default port never touches the installed unit: that belongs to
# whatever bridge is already running on 9120.
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 && [ "$PORT" = "9120" ]; then
  UNIT="$HOME/.config/systemd/user/hermes-face.service"
  if [ ! -f "$UNIT" ]; then
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
    systemctl --user enable hermes-face.service >/dev/null 2>&1 || true
  fi
  systemctl --user restart hermes-face.service >/dev/null 2>&1 || true
else
  ( cd "$PREFIX" && setsid env HERMES_FACE_PORT="$PORT" PYTHONUNBUFFERED=1 "$PY" server.py >/dev/null 2>&1 & )
fi

for _ in $(seq 1 120); do
  healthy && say "ensure: bridge is answering" && exit 0
  sleep 0.25
done
say "ensure: bridge did not answer within 30s"
exit 1
