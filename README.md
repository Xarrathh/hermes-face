# Hermes face

A holographic head for Hermes: a fullscreen, chrome-less web app that listens
through Omarchy's dictation (voxtype), thinks with the same Hermes agent, and
speaks through edge-tts with the voice set in `~/.hermes/config.yaml`.

Everything on the face is driven by one flat parameter set in
`web/schema.json` and edited live from the in-page panel (press `E`).

## This fork: the merged Rynette face

Two faces were built separately and both worked. This is the merge:

* **the head from `hermes-face`** — the parametric anatomy. Face shape and
  silhouette, eyes with iris/pupil/lashes, brows, nose, mouth, ears, hair,
  breathing, blinking, saccades, jaw driven by the voice, and a mood tag per
  reply (`[warm]`, `[amused]`, …) that eases expression offsets onto the tuned
  look without overwriting it.
* **the surface from the first Rynette face** — the Matrix pass. A grid of
  cells where each cell is a fine vertical thread (three sub-columns, gains
  `[0.52, 1.00, 0.68]`), tonal quantisation into a few fixed levels so the grid
  reads as a quantised portrait rather than a blur, glyph rain that falls in
  front of the room but never in front of the face, and a CRT finish
  (scanlines + vignette).

```
server.py             stdlib HTTP bridge on 127.0.0.1:9120
web/index.html        page: canvas, HUD, editor drawer
web/face.js           the renderer: parametric head, features, states, matrix pass
web/ui.js             editor, voice, dictation pickup, audio -> mouth, interrupt
web/schema.json       every editable number (single source of truth)
config.json           the values that are saved (params + voice)
audio/                reply-<n>.mp3, synthesised per turn
install.sh            installer: files, venv, systemd --user unit, launcher, autostart
packaging/            service unit templates (*.in, rendered by install.sh)
bin/hermes-face-kiosk app-window / fullscreen kiosk launcher (Chromium)
INSTALL.md            prerequisites, kiosk + appliance setup, troubleshooting
```

### What is new in the merge

`web/schema.json` grew a **Matrix (Rynette)** group:

| param | what it does |
|---|---|
| `matThreads` | strength of the thread grid over the head |
| `matPitch` | columns across the head width (24–180) |
| `matGain` | how hard the gaps between threads cut |
| `matLevels` | how many tonal steps each cell gets (1 = smooth) |
| `matRain` | front rain opacity — rain in the air, clipped out of the head |
| `matRainSpeed`, `matRainDensity` | the rain itself |
| `matScan` | CRT scanline strength (canvas, on top of the CSS grain) |
| `matVignette` | vignette strength |

Presets **Rynette** and **Matrix Threads** ship with the fork; `Pro-Pierre` is
the tuned look this box runs.

Server side, three things came over from the Rynette backend:

* **interrupt actually interrupts.** Each turn runs in its own process group, so
  `/interrupt` signals the agent itself, polls until the PID is reaped, then
  escalates to SIGKILL. It is not just a display reset.
* **the new command always wins.** `/say` no longer answers `409 busy` while a
  turn is live: it drops that turn and starts the new one. `Escape` in the page
  interrupts, too.
* **the agent turn matches the installed CLI.** `--format stream-json` no longer
  exists; turns now run `hermes chat -Q` and read the reply from stdout and
  `session_id:` from stderr (see `INSTALL.md`).

And autostart is fixed: `loginctl enable-linger` so the bridge is up at boot, a
Hyprland autostart line for the window, a window rule pinning it to workspace 1
fullscreen, and the old Rynette autostart line commented out so two faces do not
fight over workspace 1.

## Install on another machine

```bash
./install.sh              # ~/.local/share/hermes-face + service + autostart
./install.sh --kiosk      # ... and the graphical-session kiosk unit as well
./install.sh --no-autostart   # bridge only
```

See `INSTALL.md` for prerequisites, kiosk/appliance setups (including `cage`), remote
displays, and troubleshooting. The installer is idempotent and keeps `config.json`.

## Run

```bash
systemctl --user restart hermes-face     # the bridge
hermes-face-kiosk --app                  # the window (Chromium kiosk profile)
```

## Routes

| route | what |
|---|---|
| `GET /face/` | the page |
| `GET/POST /params` | read / save the face (also `voice`) |
| `GET /state` | agent state, dictation state, audio url, build id |
| `POST /say` | one agent turn `{text}` (interrupts a live turn) |
| `POST /spoken` | playback finished (state back to idle) |
| `POST /interrupt` | kill the running turn `{ok, killed}` |
| `GET /voices`, `POST /voice-test` | edge-tts voices |
| `GET /audio/<file>.mp3` | synthesized replies |

## How a turn works

1. Press `F9` (Omarchy dictation). Voxtype transcribes into the focused input.
2. The page polls `/state`, sees voxtype go `recording -> idle`, and submits the
   text on its own.
3. The server runs `hermes chat --query-file … -Q --source tool
   [--resume <sid> | --continue hermes-face --create-if-missing]` — same agent,
   own session.
4. The reply is cleaned for speech, synthesised with edge-tts, served as
   `/audio/reply-<n>.mp3`; the page plays it and drives the mouth from a
   WebAudio RMS envelope.
5. The agent opens its answer with a mood tag (`[warm]`, `[amused]`, …) which the
   server strips, then publishes as `mood` on `/state`. The page eases that mood's
   offsets onto the tuned parameters while the voice speaks and releases them
   afterwards, so the expression never overwrites the saved look.

## Editing the face

Press `E` or click ☰. Every slider saves to `config.json` (debounced). Presets
reset to schema defaults and then apply their overrides. `?edit=1` opens the
panel straight away.

Dev query flags: `?freeze=2.4` (deterministic frame for screenshots),
`?amp=0.7` (fixed audio envelope), `?off=mesh,scan,eyes,threads,rain,raster,…`
(layer isolation), `?hue=…&sat=…`.
