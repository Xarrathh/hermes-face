# Installing the Hermes face

The face is two pieces: a stdlib Python bridge (`server.py`) that talks to the
Hermes agent and synthesises speech, and a static page (`web/`) that renders the
head and drives the mouth. No framework, no build step, no database.

```
browser page  ──▶  server.py :9120  ──▶  hermes chat …   (the agent, own session)
     ▲                   │
     └── /state, /audio ─┴──▶  edge-tts  ──▶  reply-<n>.mp3
```

## What you need on the new machine

| piece | why | Arch | Debian/Ubuntu |
|---|---|---|---|
| python 3.9+ | runs the bridge | `python` | `python3` |
| python venv | isolated `edge-tts` | `python` | `python3-venv` |
| edge-tts | speech synthesis | `edge-tts` (pacman) or pip in the venv | pip in the venv |
| Hermes agent + a model | every turn is `hermes chat` | `~/.hermes/hermes-agent/…` or `hermes` on PATH | same |
| Chromium-family browser | the window / kiosk | `chromium` | `chromium` |
| `curl` | health check, launcher | `curl` | `curl` |

Optional, and only if you want them:

* **voxtype** — Omarchy's dictation daemon. The page watches
  `/run/user/<uid>/voxtype/state` and submits the transcript when F9 finishes.
  Without it, typing in the line at the bottom works exactly the same.
* **cage** — a single-app Wayland compositor, for a machine with no desktop
  (signage, a spare PC behind a TV, a Pi).

## Install

```bash
git clone <this repo> hermes-face
cd hermes-face
./install.sh                 # ~/.local/share/hermes-face, port 9120, systemd --user
```

The installer is idempotent. It copies code, keeps an existing `config.json`, creates
the venv, installs `edge-tts`, writes and enables the user service, installs the kiosk
launcher into `~/.local/bin`, and then waits until `http://127.0.0.1:9120/health`
answers before printing the summary.

It also sets up autostart, which the original did not:

* `loginctl enable-linger "$USER"` — the user manager only reaches `default.target`
  at login, so without linger the bridge is absent on a boot with no interactive
  login (a signage box, a machine that reboots overnight).
* a Hyprland autostart line in `~/.config/hypr/autostart.lua`
  (`hl.on("hyprland.start", …)` calling `hermes-face-kiosk --app`), and a window
  rule in `windows.lua` pinning `chrome-127.0.0.1__face_-Default` to workspace 1
  fullscreen. The class is derived from the URL; `--class=` is ignored by
  `omarchy-launch-webapp`, which is why the rule matches on the Chromium class.
* the previous Rynette face's autostart line is commented out, so one face owns
  workspace 1 instead of two windows opening on top of each other.

`--no-autostart` skips all of that (bridge only). `--kiosk` additionally installs the
`hermes-face-kiosk.service` unit bound to `graphical-session.target`; on Hyprland that
target is unreliable, and the unit plus the autostart line would double-launch, so the
launcher exits if a face window is already open.

### Options

| flag | meaning |
|---|---|
| `--prefix DIR` | install target (default `~/.local/share/hermes-face`) |
| `--port N` | bridge port (default 9120; also `HERMES_FACE_PORT`) |
| `--bin-dir DIR` | where the kiosk launcher goes (default `~/.local/bin`) |
| `--browser BIN` | browser to use for the window (default: first found) |
| `--hermes-home DIR` | Hermes install to talk to (default `~/.hermes`) |
| `--no-venv` | use the system python; requires `edge-tts` preinstalled |
| `--no-service` | copy files and launcher only, no systemd unit |
| `--kiosk` | also install + enable the kiosk window at login |
| `--uninstall` | stop, disable, remove units, launcher and prefix |

## Running it

```bash
systemctl --user status hermes-face     # the bridge
hermes-face-kiosk --app                 # a window the WM can float or tile
hermes-face-kiosk                       # true kiosk: fullscreen, no chrome, no cursor
xdg-open http://127.0.0.1:9120/face/    # or just a normal tab
```

In the page: **E** opens the editor drawer, **V** picks the voice, **F9** dictates
(where voxtype exists), the line at the bottom types a turn. Everything you change
saves to `config.json` as you drag it.

## Kiosk mode

`hermes-face-kiosk` is the whole kiosk story: it starts the bridge if it is down,
waits for the health endpoint, then `exec`s Chromium with a dedicated profile and
the flags that make it behave like an appliance — `--kiosk`, no first-run, no
extensions, no sync, no translate bar, no session-crashed bubble, scrollbars hidden,
autoplay allowed (the reply must speak without a click), and its own
`--user-data-dir` so it never reopens the last page instead of the face.

Three ways to use it:

1. **A window on the desktop** — `hermes-face-kiosk --app`. Pair it with a window
   rule if you want it borderless on a second monitor.
2. **Fullscreen on the desktop at login** — install with `--kiosk`. That enables
   `hermes-face-kiosk.service`, bound to `graphical-session.target`, so it starts
   with the graphical session and restarts if the browser dies.
   On Hyprland, `graphical-session.target` is what `uwsm`/`exec-once` bring up;
   if your session does not, add to `~/.config/hypr/autostart.conf`:
   `exec-once = hermes-face-kiosk`
3. **A dedicated appliance with no desktop** — run it under cage, so the machine
   boots straight into the face:

   ```ini
   # ~/.config/systemd/user/hermes-face-kiosk.service (override the ExecStart)
   [Service]
   ExecStart=
   ExecStart=/usr/bin/cage -s -- %h/.local/bin/hermes-face-kiosk
   ```

   then `systemctl --user enable hermes-face-kiosk` and start it from a TTY autologin
   (or a `getty@tty1` autologin unit). No window manager, no panel, no cursor.

For a TV that should never go blank, disable the compositor's idle handling rather
than the screen's: with `cage`, nothing else is running to blank it.

## Running it on another machine's screen

The bridge binds loopback only, on purpose — it has no authentication and it can run
agent turns. Two sane options:

* **On the machine itself** (the normal case): install, enable, done.
* **Face on a display box, agent elsewhere**: keep the bridge on the box that has
  Hermes and forward the port over SSH from the display box:

  ```bash
  ssh -N -L 9120:127.0.0.1:9120 user@agentbox
  hermes-face-kiosk --app
  ```

  Chromium then talks to `127.0.0.1:9120` on the display box and the tunnel carries
  it. Do not put this port on a LAN interface without a proxy and auth in front of it.

## Updating

```bash
cd hermes-face && git pull && ./install.sh
systemctl --user restart hermes-face    # if you skipped the installer
```

Code and units are replaced; `config.json`, `history.json` and `audio/` are kept.

## Uninstalling

```bash
./install.sh --uninstall
```

Units are stopped, disabled and removed; the launcher and the install prefix go too,
and the Hyprland autostart line and window rule are stripped back out.
`~/.hermes` and the Hermes agent are untouched, and so is the Chromium profile at
`~/.local/share/hermes-face-kiosk`.

## Troubleshooting

| symptom | check |
|---|---|
| page loads, nothing ever answers | `journalctl --user -u hermes-face -f` — usually no Hermes CLI or no model configured |
| 409 `busy` on `/say` | a turn is still running; `POST /interrupt`, or wait for it |
| silent replies, audio file zero bytes | `edge-tts` missing for the interpreter in the unit: `journalctl` shows `ModuleNotFoundError`, re-run `./install.sh` |
| face reloads itself in a loop | expected after a code change (build id from mtimes); if constant, the install prefix is being rewritten under it |
| every reply is "The agent did not return an answer" | the CLI changed: `hermes chat` has no `--format stream-json`. This fork runs `-Q` instead — the reply is on stdout, `session_id:` on stderr. Check with `journalctl --user -u hermes-face -n 30` |
| the face forgets the last thing you said | turn ran without a session: pass `--resume <sid>` or `--continue hermes-face --create-if-missing` |
| silence with `ModuleNotFoundError: edge_tts` | the module is not importable by the unit's interpreter; `synth()` falls back to the `edge-tts` CLI on PATH, so also check `which edge-tts` for that unit |
| new command refused with 409 while it thinks | not in this fork: `/say` interrupts the live turn instead. A 409 now only means an empty body |
| no `[mood]` expression | the reply must start with the tag; the server strips it and publishes `mood` on `/state` |
| dictation does nothing | voxtype is Omarchy-specific; type in the line instead, or set `HERMES_FACE_VOXTYPE_STATE` to your own state file |
| kiosk exits straight away | no display in that unit's environment, or no Chromium-family browser: run `hermes-face-kiosk` by hand and read stderr |
| wrong screen / window decorations | `--app` mode plus a compositor rule; `--kiosk` is fullscreen by design |

Useful probes:

```bash
curl -s 127.0.0.1:9120/health
curl -s 127.0.0.1:9120/state | head -c 400
systemctl --user show -p ExecStart hermes-face
```
