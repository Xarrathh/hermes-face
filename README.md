# Hermes face

A holographic head for Hermes: a fullscreen, chrome-less web app that listens
through Omarchy's dictation (voxtype), thinks with the same Hermes agent, and
speaks through edge-tts with the voice set in `~/.hermes/config.yaml`.

Everything on the face is driven by one flat parameter set in
`web/schema.json` and edited live from the in-page panel (press `E`).

## This fork: the merged Rynette face

Two faces were built separately and both worked. This is the merge:

* **the head from `hermes-face`** — the parametric anatomy. Face shape and
  silhouette, eyes with iris/pupil/lashes, brows, nose, mouth, ears, breathing,
  blinking, saccades, jaw driven by the voice, and a mood tag per
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

### Cell mode (the current face)

Pierre's ask: *my* face's definition (the particles/cells) carrying *their* features
(eyes, ears, nose, mouth), with the other effects off, no hair, no head outline, and
the editor still in charge.

How it is built, in `web/face.js`:

1. **The anatomy is rendered onto its own transparent layer** (`LAYER`), with `ctx`
   swapped for the pass: one flat base, the sculpt, the ears — no room, no rain, no
   outline, no shell lighting. Every draw function already uses `ctx`, so swapping the target is the
   whole refactor.
2. **`drawSculpt()` paints the definition in.** Measuring this project's shell alone
   gives a flat green mask — its glass is fairly even. So the original face's tonal
   field comes back: key light upper-left, brow ridge and sunken sockets, cheek
   volume and shadow, nose bridge and base, lip relief, jaw falling away. It is built
   as a grey relief map on a Gaussian field and composited with `overlay` (neutral
   grey changes nothing, light sculpts out, dark cuts in), keyed to *this* anatomy's
   parameters, so a slider moves the relief with the feature.
3. **`compositeCells()` measures and rebuilds it.** The layer is downsampled to one
   pixel per cell (`matPitch` cells across), each pixel read as luminance, mapped
   through black/white point + exposure onto a six-stop palette ramp (hue/sat), then
   drawn back as a grid where every cell is one flat tone made of three vertical
   threads (`[0.52, 1.00, 0.68]`) and two sub-rows. Per-column gain and per-cell
   dither give it the texture of cloth instead of noise.
4. **The vector features go on top at full resolution** — eyes with iris, pupil and
   catchlight, brows, nose, mouth. The cells give volume; the vectors give features.

Hair was removed outright at Pierre's request (the style select, hairline, hairline
shape, darkness and part line, and the two draw passes): this face is bald by design,
and the hairline band was adding a shadow the cells then measured.

`Surface` in the panel switches between **Cells (Rynette)** and the original
**Hologram** mode (wire/motes/circuit/matrix-glyph shell, projector rings, rim light),
so nothing was deleted — the old look is one select away.

Tuning knobs, in order of usefulness: **Relief** (`matSculpt`), **Exposure**,
**Black point** / **White point** (these three set how much of the face lights up),
**Cells across** (`matPitch` — 60 is coarse and chunky, 120 is nearly photographic),
**Cell texture**, **Tone bands** (1 = smooth gradient per cell, 5 = posterised chunks).

### What is new in the merge

`web/schema.json` grew a **Matrix (Rynette)** group:

| param | what it does |
|---|---|
| `matPortrait` | Surface: Cells (Rynette) or the original Hologram |
| `matSculpt` | relief: how hard the key light and the sockets sculpt the tone |
| `matExposure`, `matBlack`, `matWhite` | tone mapping before quantisation |
| `matThreads` | strength of the thread grid (hologram mode) |
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
