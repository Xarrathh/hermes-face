# Hermes face

A holographic head for Hermes: a fullscreen, chrome-less web app that listens
through Omarchy's dictation (voxtype), thinks with the same Hermes agent, and
speaks through edge-tts with the voice set in `~/.hermes/config.yaml`.

Everything on the face is driven by one flat parameter set in
`web/schema.json` and edited live from the in-page panel (press `E`).

```
server.py             stdlib HTTP bridge on 127.0.0.1:9120
web/index.html        page: canvas, HUD, editor drawer
web/face.js           the renderer: parametric head, features, states
web/ui.js             editor, voice, dictation pickup, audio -> mouth
web/schema.json       every editable number (single source of truth)
config.json           the values that are saved (params + voice)
audio/                reply-<n>.mp3, synthesised per turn
```

## Run

```bash
systemctl --user restart hermes-face     # the bridge
hermes-app face                          # the window (Chromium kiosk profile)
```

## Routes

| route | what |
|---|---|
| `GET /face/` | the page |
| `GET/POST /params` | read / save the face (also `voice`) |
| `GET /state` | agent state, dictation state, audio url, build id |
| `POST /say` | one agent turn `{text}` |
| `POST /spoken` | playback finished (state back to idle) |
| `POST /interrupt` | drop the current turn |
| `GET /voices`, `POST /voice-test` | edge-tts voices |
| `GET /audio/<file>.mp3` | synthesized replies |

## How a turn works

1. Press `F9` (Omarchy dictation). Voxtype transcribes into the focused input.
2. The page polls `/state`, sees voxtype go `recording -> idle`, and submits the
   text on its own.
3. The server runs `hermes chat --query-file … --format stream-json
   --pass-session-id [--resume <sid>]` — same agent, own session.
4. The reply is cleaned for speech, synthesised with edge-tts, served as
   `/audio/reply-<n>.mp3`; the page plays it and drives the mouth from a
   WebAudio RMS envelope.

## Editing the face

Press `E` or click ☰. Every slider saves to `config.json` (debounced). Presets
reset to schema defaults and then apply their overrides. `?edit=1` opens the
panel straight away.

Dev query flags: `?freeze=2.4` (deterministic frame for screenshots),
`?amp=0.7` (fixed audio envelope), `?off=mesh,scan,eyes,…` (layer isolation),
`?hue=…&sat=…`.
