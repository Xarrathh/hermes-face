#!/usr/bin/env bash
# Hermes face — installer.
#
#   ./install.sh                     install to ~/.local/share/hermes-face,
#                                    systemd --user service on 127.0.0.1:9120
#   ./install.sh --kiosk             ... and install the kiosk systemd unit too
#   ./install.sh --no-autostart      bridge only: no linger, no Hyprland autostart
#
# Autostart (the default): loginctl enable-linger so the bridge is up at boot, a
# Hyprland autostart line for the window, and a window rule pinning it to
# workspace 1 fullscreen. --kiosk additionally installs the graphical-session unit,
# which you do not want on Hyprland: it double-launches against the autostart line.
#   ./install.sh --prefix /opt/face --port 9200 --no-service
#   ./install.sh --uninstall         stop, disable, remove units + launcher
#
# Idempotent: re-running over an existing install keeps config.json, history.json
# and the audio directory, and only rewrites code and units.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local/share/hermes-face}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
UNIT_DIR="${UNIT_DIR:-$HOME/.config/systemd/user}"
PORT="${HERMES_FACE_PORT:-${PORT:-9120}}"
BROWSER="${BROWSER:-}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
MAKE_VENV=1
SERVICE=1
KIOSK=0
AUTOSTART=1
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --browser) BROWSER="$2"; shift 2 ;;
    --hermes-home) HERMES_HOME="$2"; shift 2 ;;
    --no-venv) MAKE_VENV=0; shift ;;
    --no-service) SERVICE=0; shift ;;
    --kiosk) KIOSK=1; shift ;;
    --no-autostart) AUTOSTART=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- prerequisites
need_python() {
  have python3 || die "python3 not found (Arch: pacman -S python, Debian: apt install python3)"
  local v major minor
  v="$(python3 -V 2>&1 | awk '{print $2}')"
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%.*}"
  # 3.9+ is enough: the bridge is stdlib only, minus edge-tts
  case "$major$minor" in
    *[!0-9]*) warn "could not parse python version '$v'; assuming it is new enough" ;;
    *) if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 9 ]; }; then
         die "python3 $v is too old, need 3.9 or newer"
       fi ;;
  esac
  PY_MAJOR_MINOR="$v"
}

find_hermes() {
  if [ -n "${HERMES_BIN:-}" ] && [ -x "${HERMES_BIN}" ]; then return; fi
  for cand in "$HERMES_HOME/hermes-agent/.hermes/bin/hermes" "$HERMES_HOME/bin/hermes"; do
    if [ -x "$cand" ]; then HERMES_BIN="$cand"; return; fi
  done
  if have hermes; then HERMES_BIN="$(command -v hermes)"; return; fi
  HERMES_BIN="$HERMES_HOME/hermes-agent/.hermes/bin/hermes"
  warn "no hermes CLI found; the face will serve but every turn will fail until"
  warn "Hermes is installed or HERMES_BIN is set in the service environment"
}

find_browser() {
  if [ -n "$BROWSER" ]; then
    have "$BROWSER" || warn "browser '$BROWSER' not found on PATH"
    return
  fi
  for cand in chromium chromium-browser google-chrome-stable google-chrome brave-browser microsoft-edge; do
    if have "$cand"; then BROWSER="$cand"; return; fi
  done
  BROWSER="chromium"
  warn "no Chromium-family browser found; kiosk mode needs one"
  warn "  Arch: pacman -S chromium    Debian: apt install chromium"
}

# -------------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
  say "Removing Hermes face from $PREFIX"
  for unit in hermes-face-kiosk.service hermes-face.service; do
    if [ -f "$UNIT_DIR/$unit" ]; then
      systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
      rm -f "$UNIT_DIR/$unit"
      say "  removed unit $unit"
    fi
  done
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -f "$BIN_DIR/hermes-face-kiosk" && say "  removed $BIN_DIR/hermes-face-kiosk"
  HYPR="${HYPR_DIR:-$HOME/.config/hypr}"
  for f in "$HYPR/autostart.lua" "$HYPR/windows.lua"; do
    [ -f "$f" ] && python3 - "$f" <<'PY' || true
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'^.*hermes-face-kiosk.*\n', '', s, flags=re.M)
s = re.sub(r'\n?-- Hermes face[^\n]*\n(?:hl\.window_rule\(\{[^}]*?\}\)\n)+', '\n', s, flags=re.S)
open(p, 'w').write(s)
PY
  done
  say "  removed the Hyprland autostart line and window rules"
  rm -rf "$PREFIX" && say "  removed $PREFIX"
  say "Done. Hermes itself and ~/.hermes were left alone."
  exit 0
fi

# --------------------------------------------------------------------- install
need_python
find_hermes
find_browser

say "Hermes face installer"
say "  from     $REPO"
say "  to       $PREFIX"
say "  service  127.0.0.1:$PORT (systemd --user: $SERVICE, kiosk autostart: $KIOSK)"
say "  python   $PY_MAJOR_MINOR"
say "  hermes   $HERMES_BIN"
say "  browser  $BROWSER"

install -d "$PREFIX" "$PREFIX/web" "$PREFIX/audio"

# code: always replaced, so an upgrade is just re-running this script
install -m 0644 "$REPO/server.py"   "$PREFIX/server.py"
install -m 0644 "$REPO/README.md"   "$PREFIX/README.md"
for f in index.html face.js ui.js schema.json presets.json; do
  install -m 0644 "$REPO/web/$f" "$PREFIX/web/$f"
done
if [ -f "$REPO/INSTALL.md" ]; then install -m 0644 "$REPO/INSTALL.md" "$PREFIX/INSTALL.md"; fi

# data: never clobbered. config.json holds the tuned look and the saved presets.
# A clone carries config.example.json only: the live look is per-machine and is
# deliberately not in git, so seed from the example when there is nothing to keep.
if [ ! -f "$PREFIX/config.json" ]; then
  SEED=""
  for cand in "$REPO/config.json" "$REPO/config.example.json"; do
    [ -f "$cand" ] && { SEED="$cand"; break; }
  done
  if [ -n "$SEED" ]; then
    install -m 0644 "$SEED" "$PREFIX/config.json"
    say "  seeded config.json from $(basename "$SEED")"
  else
    warn "no config.json or config.example.json to seed; the server will write defaults"
  fi
else
  say "  kept existing config.json"
fi
[ -f "$PREFIX/history.json" ] || true      # server creates it on the first turn

# ---------------------------------------------------------------- python + tts
PY="$PREFIX/.venv/bin/python"
if [ "$MAKE_VENV" = 1 ]; then
  if [ ! -x "$PY" ]; then
    say "  creating venv"
    python3 -m venv "$PREFIX/.venv" || die "python3 -m venv failed (Debian: apt install python3-venv)"
  fi
  if "$PY" -m pip --version >/dev/null 2>&1; then
    say "  installing edge-tts"
    "$PY" -m pip install --quiet --disable-pip-version-check --upgrade edge-tts \
      || warn "edge-tts install failed; TTS will not work until it is importable"
  else
    warn "pip missing in the venv; install edge-tts yourself for $PY"
  fi
else
  PY="$(command -v python3)"
  "$PY" -m pip show edge-tts >/dev/null 2>&1 \
    || warn "edge-tts is not installed for $PY; TTS will not work"
fi

# ------------------------------------------------------------------- units
if [ "$SERVICE" = 1 ]; then
  install -d "$UNIT_DIR" "$BIN_DIR"
  render() {  # render <template> <dest>
    sed -e "s|@PREFIX@|$PREFIX|g" \
        -e "s|@PYTHON@|$PY|g" \
        -e "s|@PORT@|$PORT|g" \
        -e "s|@BIN_DIR@|$BIN_DIR|g" \
        -e "s|@HERMES_HOME@|$HERMES_HOME|g" \
        -e "s|@HERMES_BIN@|$HERMES_BIN|g" \
        -e "s|@HERMES_BINDIR@|$(dirname "$HERMES_BIN")|g" \
        -e "s|@BROWSER@|$BROWSER|g" \
        "$1" > "$2"
  }
  render "$REPO/packaging/hermes-face.service.in" "$UNIT_DIR/hermes-face.service"
  say "  wrote $UNIT_DIR/hermes-face.service"

  install -m 0755 "$REPO/bin/hermes-face-kiosk" "$BIN_DIR/hermes-face-kiosk"
  say "  wrote $BIN_DIR/hermes-face-kiosk"

  if [ "$KIOSK" = 1 ]; then
    render "$REPO/packaging/hermes-face-kiosk.service.in" "$UNIT_DIR/hermes-face-kiosk.service"
    say "  wrote $UNIT_DIR/hermes-face-kiosk.service"
  fi

  systemctl --user daemon-reload || die "systemctl --user daemon-reload failed (is this a user session?)"
  systemctl --user enable --now hermes-face.service >/dev/null \
    || die "could not enable hermes-face.service"
  if [ "$KIOSK" = 1 ]; then
    systemctl --user enable hermes-face-kiosk.service >/dev/null
  fi
  say "  enabled hermes-face.service"

  if [ "$AUTOSTART" = 1 ]; then
    # The user manager only runs at login without linger, so a boot with no login
    # never reaches default.target and the bridge is not there when the face opens.
    if loginctl enable-linger "$USER" 2>/dev/null; then
      say "  linger enabled (bridge runs at boot, before any login)"
    else
      warn "could not enable linger; the bridge will start at login only"
    fi

    HYPR="${HYPR_DIR:-$HOME/.config/hypr}"
    if [ -d "$HYPR" ]; then
      # A window rule, not --kiosk: the window manager owns placement, so the face
      # lands on workspace 1 fullscreen instead of wherever the cursor was.
      if [ -f "$HYPR/windows.lua" ]; then
        if ! grep -q 'Hermes face' "$HYPR/windows.lua"; then
          cat >> "$HYPR/windows.lua" <<'RULES'

-- Hermes face — pin the face window to workspace 1, fullscreen.
-- Chromium derives the class from the URL, so this is 127.0.0.1:9120/face/ and not
-- a --class= flag (omarchy-launch-webapp ignores that anyway).
hl.window_rule({
  match = { class = "^chrome-127\\.0\\.0\\.1__face_-Default$" },
  workspace = "1",
  fullscreen = true,
  tile = true,
})
hl.window_rule({
  match = { title = "^Hermes$" },
  workspace = "1",
  fullscreen = true,
  tile = true,
})
RULES
          say "  wrote the Hyprland window rule ($HYPR/windows.lua)"
        fi
      else
        warn "no $HYPR/windows.lua to add the window rule to"
      fi

      if ! grep -q 'require("hypr.windows")' "$HYPR/hyprland.lua" 2>/dev/null; then
        printf '\nrequire("hypr.windows")\n' >> "$HYPR/hyprland.lua" 2>/dev/null || true
      fi

      # The window at login. hermes-face-kiosk is idempotent (it exits if the face
      # window is already open), so this is safe next to the graphical-session unit.
      if [ -f "$HYPR/autostart.lua" ] || [ -d "$HYPR" ]; then
        AUTO="$HYPR/autostart.lua"
        if ! grep -q 'hermes-face-kiosk' "$AUTO" 2>/dev/null; then
          printf 'hl.on("hyprland.start", function() hl.exec_cmd("%s --app") end)\n' \
            "$BIN_DIR/hermes-face-kiosk" >> "$AUTO"
          say "  wrote the Hyprland autostart line ($AUTO)"
        fi
        # One face on workspace 1: the old Rynette window would open on top of it.
        if grep -q 'rynette/launch.sh' "$AUTO" 2>/dev/null; then
          # awk, not python: the note line has to survive being written verbatim
          awk '/rynette\/launch.sh/ && $0 !~ /^[[:space:]]*--/ {
                 print "-- stopped by the hermes-face installer: this face owns workspace 1 now";
                 print "-- " $0; next } { print }' "$AUTO" > "$AUTO.tmp" && mv "$AUTO.tmp" "$AUTO"
          say "  commented out the old Rynette autostart line (revert by uncommenting it)"
        fi
      fi

      if command -v hyprctl >/dev/null 2>&1 && [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
        hyprctl reload >/dev/null 2>&1 || warn "hyprctl reload failed"
        errs="$(hyprctl configerrors 2>/dev/null || true)"
        [ -z "$errs" ] || warn "Hyprland config errors: $errs"
      fi
    else
      warn "no Hyprland config at $HYPR; the window will not start at login"
    fi
  fi

  # health check: the unit is up, but "up" only counts when it answers
  URL="http://127.0.0.1:$PORT/face/"
  ok=0
  for _ in $(seq 1 40); do
    if have curl; then
      curl -sf -m 1 -o /dev/null "http://127.0.0.1:$PORT/health" && { ok=1; break; }
    elif have wget; then
      wget -q -T 1 -O /dev/null "http://127.0.0.1:$PORT/health" && { ok=1; break; }
    else
      warn "neither curl nor wget available; skipping the health probe"
      ok=1; break
    fi
    sleep 0.25
  done
  if [ "$ok" = 1 ]; then say "  $URL is answering"
  else warn "no answer on http://127.0.0.1:$PORT/health yet; check journalctl --user -u hermes-face"; fi
else
  install -d "$BIN_DIR"
  install -m 0755 "$REPO/bin/hermes-face-kiosk" "$BIN_DIR/hermes-face-kiosk"
  say "  wrote $BIN_DIR/hermes-face-kiosk (no service installed)"
  say "  start by hand: HERMES_FACE_PORT=$PORT $PY $PREFIX/server.py"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH; run $BIN_DIR/hermes-face-kiosk by full path" ;;
esac

cat <<EOF

Installed.

  page      http://127.0.0.1:$PORT/face/
  window    $BIN_DIR/hermes-face-kiosk --app   app window (WM can float/tile it)
            $BIN_DIR/hermes-face-kiosk         fullscreen kiosk, nothing else on screen
  logs      journalctl --user -u hermes-face -f
  look      press Alt+E in the page for the editor; every slider saves
  voice     press V in the page, or set tts.edge.voice in $HERMES_HOME/config.yaml

Next: the face runs \`hermes chat\` per turn, so it is the same agent with its own
session — make sure Hermes has a model configured, then press F9 (or type in the
line) and watch the mouth move.
EOF
