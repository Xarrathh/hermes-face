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

# This plugin is a Quickshell bar widget. Omarchy 3 and earlier had a waybar/different bar with no
# plugin API at all, and every later symptom (no glyph, no menu, nothing to click) follows from
# that one fact, so it is checked first.
omarchy_ver="$(cat /usr/share/omarchy/version 2>/dev/null || true)"
if [ -x /usr/bin/omarchy-shell ] && [ -f /usr/share/omarchy/shell/Ui/BarWidget.qml ]; then
  pass "Omarchy ${omarchy_ver:-unknown} with the Quickshell bar (bar widgets supported)"
else
  bad "this Omarchy has no Quickshell bar plugin API (found ${omarchy_ver:-no version file})" \
      "the widget needs Omarchy 4; on an older release there is no bar to host it"
fi

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
  [ -n "$cand" ] && [ -x "$cand" ] && agent="$(readlink -f "$cand" 2>/dev/null || printf '%s' "$cand")" && break
done
if [ -n "$agent" ]; then
  pass "agent: $agent"
  if "$agent" chat --help 2>/dev/null | grep -q -- "--query-file"; then
    pass "agent takes --query-file"
  else
    printf '  note  no --query-file: the face refuses a turn rather than putting your words in\n'
    printf '        the process list. Set HERMES_FACE_ALLOW_INLINE_PROMPT=1 to accept that.\n'
  fi
else
  bad "no hermes binary found" "install the Hermes agent, or set HERMES_BIN to its path"
fi

# SECURITY.md promises the prefix and the files in it are private to this user. A prefix
# restored from a backup, or created under a different umask, silently is not -- so check it.
if [ -d "$PREFIX" ]; then
  pmode=$(stat -c '%a' "$PREFIX" 2>/dev/null || echo '?')
  if [ "$pmode" = "700" ]; then
    pass "prefix is private (0700)"
  else
    bad "prefix mode is $pmode, not 700" "chmod 700 $PREFIX (the bridge does this on its next start)"
  fi
  for f in config.json history.json token; do
    [ -e "$PREFIX/$f" ] || continue
    fmode=$(stat -c '%a' "$PREFIX/$f" 2>/dev/null || echo '?')
    if [ "$fmode" = "600" ]; then
      pass "$f is private (0600)"
    else
      bad "$f mode is $fmode, not 600" "chmod 600 $PREFIX/$f (the bridge does this on its next start)"
    fi
  done
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
