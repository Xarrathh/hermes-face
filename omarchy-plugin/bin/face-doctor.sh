#!/usr/bin/env bash
# Diagnose a face install that will not start. Prints one line per check, in the order the start
# path takes them, so the first FAIL is the thing to fix.
set -u
PORT="${HERMES_FACE_PORT:-9120}"
PREFIX="${HERMES_FACE_PREFIX:-$HOME/.local/share/hermes-face}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass() { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n        fix: %s\n' "$1" "$2"; }

echo "hermes-face doctor"
echo "  plugin  $HERE"
echo "  prefix  $PREFIX"
echo "  port    $PORT"

command -v python3 >/dev/null 2>&1 && pass "python3 on PATH" || bad "python3 missing" "install python3"

if [ -x "$PREFIX/.venv/bin/python" ]; then
  pass "venv present"
  if "$PREFIX/.venv/bin/python" -c "import edge_tts" >/dev/null 2>&1; then
    pass "edge-tts importable (voice)"
  else
    bad "edge-tts not importable (the face runs silent)" "$PREFIX/.venv/bin/pip install edge-tts"
  fi
else
  bad "no venv in the prefix" "run $HERE/bin/face-ensure.sh once, it creates it"
fi

agent=""
for cand in "$(command -v hermes 2>/dev/null || true)" "$HOME/.local/bin/hermes" \
            "$HOME/.hermes/bin/hermes" "$HOME/.hermes/hermes-agent/.hermes/bin/hermes" \
            /usr/local/bin/hermes /usr/bin/hermes; do
  [ -n "$cand" ] && [ -x "$cand" ] && agent="$cand" && break
done
if [ -n "$agent" ]; then
  pass "agent: $agent"
  "$agent" chat --help 2>/dev/null | grep -q -- "--query-file" \
    && pass "agent takes --query-file" \
    || printf '  note  this agent has no --query-file; the face falls back to the inline prompt\n'
else
  bad "no hermes binary found" "install the Hermes agent, or set HERMES_BIN to its path"
fi

if [ -x "$HOME/.local/bin/hermes-face-kiosk" ]; then
  pass "kiosk launcher installed"
else
  bad "kiosk launcher missing (no face window)" "run $HERE/bin/face-ensure.sh once"
fi

if curl -sf -m 2 -o /dev/null "http://127.0.0.1:$PORT/health"; then
  pass "bridge answering on 127.0.0.1:$PORT"
else
  bad "bridge not answering on 127.0.0.1:$PORT" "middle click the bar icon, or run $HERE/bin/face-restart.sh"
  [ -f "$PREFIX/.last-error" ] && printf '        last error: %s\n' "$(cat "$PREFIX/.last-error")"
  if command -v systemctl >/dev/null 2>&1; then
    printf '        unit: %s\n' "$(systemctl --user is-active hermes-face.service 2>/dev/null || echo absent)"
  fi
fi

echo "  log     $HOME/.cache/hermes-face-bar.log"
