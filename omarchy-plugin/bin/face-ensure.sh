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
# The prefix holds his conversations, his speech and the token, and this script creates it
# before the server has a chance to harden it. Keep the seed and the stamp owner-only.
umask 077
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
MARKER="$PREFIX/.last-error"
# The bar cannot read the log, so the reason a start failed is written where the widget's tooltip
# can find it. Success clears it.
fail() { printf '%s' "$1" >"$MARKER" 2>/dev/null || true; say "ensure: $1"; exit 1; }
ok() { rm -f "$MARKER" 2>/dev/null || true; }

vendor_hash() {
  # NUL-separated on purpose: `ls web/* | sort | xargs sha256sum` splits on whitespace, so a
  # filename with a space hashed as two names (one of them nonexistent) and a rename could
  # leave the stamp unchanged. `find -print0` hashes exactly the files that exist.
  ( cd "$PLUGIN_DIR/face" && { sha256sum server.py; find web -maxdepth 1 ! -type d -print0 \
      | sort -z | xargs -0 -r sha256sum; } 2>/dev/null ) \
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
  # A file deleted upstream must not keep being served from the prefix: `cp` never removes
  # anything, so a retired script stayed live after an update.
  for old in "$PREFIX"/web/*; do
    [ -e "$old" ] || continue
    [ -f "$PLUGIN_DIR/face/web/$(basename "$old")" ] || rm -f "$old"
  done
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
    python3 -m venv "$PREFIX/.venv" >/dev/null 2>&1 || fail "python3 cannot create a virtual environment here (install python3-venv)"
  fi
  "$PREFIX/.venv/bin/pip" install --quiet --disable-pip-version-check edge-tts >/dev/null 2>&1
  "$PREFIX/.venv/bin/python" -c "import edge_tts" >/dev/null 2>&1 \
    || say "ensure: edge-tts unavailable; the face will run silent"
  PY="$PREFIX/.venv/bin/python"
fi

install_extras() {
  # Everything that used to be homework. These are additive files in the user's own directories
  # plus one keybinding, so a first start leaves a complete install rather than a README of
  # instructions. Run once: the marker stops a user's deliberate removal from being undone.
  local marker="$PREFIX/.extras-installed"
  [ -f "$marker" ] && return 0
  mkdir -p "$HOME/.local/bin" "$HOME/.config/omarchy/hooks/theme-set.d" || return 0
  install -Dm755 "$PLUGIN_DIR/bin/hermes-face-stop" "$HOME/.local/bin/hermes-face-stop" 2>/dev/null || true
  install -Dm755 "$PLUGIN_DIR/bin/hermes-face-theme-sync" "$HOME/.local/bin/hermes-face-theme-sync" 2>/dev/null || true
  # Without this the face has no window: face-focus.sh prefers the installed launcher and only
  # falls back to a bare browser, which is not the locked-down kiosk the face expects.
  install -Dm755 "$PLUGIN_DIR/bin/hermes-face-kiosk" "$HOME/.local/bin/hermes-face-kiosk" 2>/dev/null || true
  if [ -f "$PLUGIN_DIR/hooks/theme-set.d/hermes-face-theme.hook" ]; then
    cp -f "$PLUGIN_DIR/hooks/theme-set.d/hermes-face-theme.hook" \
          "$HOME/.config/omarchy/hooks/theme-set.d/hermes-face-theme.hook" 2>/dev/null || true
  fi
  # One binding, appended, never rewritten: the stop key is the only control that has nowhere
  # else to live. A backup is left beside the file and the line is only added when absent.
  local binds="$HOME/.config/hypr/bindings.lua"
  if [ -f "$binds" ] && ! grep -q "hermes-face-stop" "$binds" 2>/dev/null; then
    cp -f "$binds" "$binds.hermes-face.bak" 2>/dev/null || true
    {
      printf '\n-- Hermes face: stop the live turn and its voice (added by the plugin)\n'
      printf 'o.bind("SUPER + SHIFT + H", "Stop the Hermes face", "hermes-face-stop")\n'
      printf 'o.bind("SUPER + SHIFT + F", "Hermes face menu", "%s/bin/face-menu.sh")\n' \
             "$HOME/.config/omarchy/plugins/pierregoosen.hermes-face"
    } >> "$binds" 2>/dev/null || true
    say "ensure: added SUPER+SHIFT+H and SUPER+SHIFT+F to $binds (backup at $binds.hermes-face.bak)"
  fi
  # The Omarchy menu reads exactly one user file, ~/.config/omarchy/extensions/omarchy-menu.jsonc,
  # so our entries are merged into it (backup kept, never duplicated) rather than dropped in as a
  # file of their own that nothing would read.
  local menu_file="$HOME/.config/omarchy/extensions/omarchy-menu.jsonc"
  local entries="$PLUGIN_DIR/menu/hermes-face.entries.jsonc"
  mkdir -p "$(dirname "$menu_file")" 2>/dev/null || true
  if [ -f "$entries" ] && ! grep -q '^[[:space:]]*"hermes"' "$menu_file" 2>/dev/null; then
    if [ -f "$menu_file" ]; then
      cp -f "$menu_file" "$menu_file.hermes-face.bak" 2>/dev/null || true
      # Insert before the final brace, adding the comma only when the object already has entries.
      "$PY" - "$menu_file" "$entries" <<'PYEOF' 2>/dev/null || true
import sys
target, extra = sys.argv[1], sys.argv[2]
body = open(target, encoding="utf-8").read()
add = open(extra, encoding="utf-8").read()
cut = body.rstrip().rfind("}")
if cut < 0:
    sys.exit(1)
head, tail = body[:cut].rstrip(), body[cut:]
sep = "" if head.endswith("{") else ","
open(target, "w", encoding="utf-8").write(head + sep + "\n" + add.strip("\n") + "\n" + tail)
PYEOF
      say "ensure: merged the Hermes menu into $menu_file"
    else
      cp -f "$entries" "$menu_file" 2>/dev/null || true
    fi
  fi
  : > "$marker"
  say "ensure: installed the stop key, theme hook and sync helper"
}

install_extras

agent_binary() {
  # Do not trust the caller's PATH: the bar launches this with a different environment than a
  # login shell, and `command -v` then finds nothing even though hermes is installed.
  local cand
  for cand in "$(command -v hermes 2>/dev/null || true)" \
              "$HOME/.local/bin/hermes" \
              "$HOME/.hermes/bin/hermes" \
              "$HOME/.hermes/hermes-agent/.hermes/bin/hermes" \
              /usr/local/bin/hermes /usr/bin/hermes; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      readlink -f "$cand" 2>/dev/null || printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

# An existing install whose unit predates the PATH/HERMES_BIN pinning must be repaired even when
# the code itself has not changed, or it keeps reporting a missing agent forever.
NEED_UNIT=0
if use_systemd; then
  [ -f "$UNIT" ] || NEED_UNIT=1
  grep -q "^Environment=PATH=" "$UNIT" 2>/dev/null || NEED_UNIT=1
  if [ "$NEED_UNIT" = "0" ] && agent_binary >/dev/null 2>&1 \
     && ! grep -q "^Environment=HERMES_BIN=" "$UNIT" 2>/dev/null; then
    NEED_UNIT=1
  fi
  # A unit written before the hardening pass has neither directive, and the vendor hash does
  # not move when only the script changed: without this the unit stays unhardened forever.
  for directive in "NoNewPrivileges=yes" "UMask=0077"; do
    grep -qx "$directive" "$UNIT" 2>/dev/null || NEED_UNIT=1
  done
fi

if healthy && [ "$CHANGED" = "0" ] && [ "$NEED_UNIT" = "0" ]; then
  exit 0                       # nothing to do, and no turn interrupted
fi

write_unit() {
  mkdir -p "$(dirname "$UNIT")"
  # A systemd user unit inherits a bare PATH, so a hermes in ~/.local/bin (or a pipx/venv install)
  # is invisible to the bridge and it wrongly reports "agent not found". Pin both the PATH and,
  # when this script can see one, the exact binary.
  local agent_bin=""
  agent_bin="$(agent_binary || true)"
  say "ensure: agent binary ${agent_bin:-not found}"
  {
    cat <<EOF
[Unit]
Description=Hermes face - holographic agent head bridge (127.0.0.1:$PORT)
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
ExecStart=$PY $PREFIX/server.py
Environment=HERMES_FACE_PORT=$PORT
Environment=PYTHONUNBUFFERED=1
Environment=PATH=$HOME/.local/bin:$HOME/.hermes/bin:/usr/local/bin:/usr/bin:/bin
EOF
    [ -n "$agent_bin" ] && printf 'Environment=HERMES_BIN=%s\n' "$agent_bin"
    cat <<EOF
Restart=always
RestartSec=2
# The bridge is a local appliance that speaks to a browser and one agent CLI; it needs no
# privilege escalation, and its own writes should never be group- or world-readable. The
# prefix mode is the first line, this is the second: a file created by a stray helper under
# this unit still lands 0600.
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=default.target
EOF
  } > "$UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 || true
}

if use_systemd; then
  # Rewrite the unit whenever we are about to restart anyway: it pins the interpreter, the PATH
  # and the agent binary this script can see, and a stale unit is exactly how a working install
  # ends up reporting that it cannot find hermes.
  write_unit
  # A process that already holds the port but is not the unit's main process makes the unit die
  # with "address already in use" on every restart — the bar then shows a cross while something
  # else answers on the port, which is the most misleading failure of the lot.
  if healthy; then
    holder=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    mainpid=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null)
    if [ -n "${holder:-}" ] && [ "$holder" != "${mainpid:-}" ]; then
      say "ensure: port $PORT held by pid $holder, not the unit ($mainpid) — stopping it"
      kill "$holder" 2>/dev/null || true
      for _ in $(seq 1 40); do
        ss -ltn 2>/dev/null | grep -q ":$PORT " || break
        sleep 0.25
      done
    fi
  fi
  say "ensure: restarting $UNIT_NAME to run the installed code"
  # Restart by NAME, never by path: `systemctl --user restart ~/.config/systemd/user/x.service`
  # is parsed as a mount unit ("home-pierregoosen-.config-systemd-user-hermes\x2dface.service.mount")
  # and fails with exit 5 — which a `|| true` then hid completely. Observed on a real install:
  # the log said "restarting … bridge is answering" while the process from days earlier kept
  # serving the pre-audit code, because a healthy /health says nothing about which code the
  # running process imported.
  pid_before=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)
  if ! restart_err=$(systemctl --user restart "$UNIT_NAME" 2>&1); then
    say "ensure: restart failed: $restart_err"
    fail "restart failed: $restart_err"
  fi
  pid_after=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)
  if [ -n "${pid_before:-}" ] && [ "${pid_before:-0}" != "0" ] && [ "$pid_before" = "${pid_after:-}" ]; then
    # The same process is still holding the unit: stop it outright and start again, then
    # refuse to report success if the pid has not moved.
    say "ensure: restart left pid $pid_before in place — stopping and starting"
    systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1 || true
    systemctl --user start "$UNIT_NAME" >/dev/null 2>&1 || true
    pid_after=$(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)
    if [ "$pid_before" = "${pid_after:-}" ]; then
      fail "the bridge is still the old process (pid $pid_before) after a restart — the new code is on disk but not running"
    fi
  fi
  say "ensure: running pid ${pid_after:-?} ($(systemctl --user show -p ActiveEnterTimestamp --value "$UNIT_NAME" 2>/dev/null || echo 'start time unknown'))"
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
  healthy && say "ensure: bridge is answering" && ok && exit 0
  sleep 0.25
done
if use_systemd; then
  state=$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)
  fail "the bridge did not answer within 30s (unit is $state; see ~/.cache/hermes-face-bar.log and journalctl --user -u hermes-face)"
fi
fail "the bridge did not answer within 30s (see ~/.cache/hermes-face-bar.log)"
