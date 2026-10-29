# Handoff — hermes-face (Rynette's merged face)

Source of truth for what this is: `README.md` (what it does), `INSTALL.md` (setup on a
new machine), `web/schema.json` (every tunable). This page is the short version for
whoever implements it next.

## State at handoff (2026-10-29, verified on Rynette)

- Unit `hermes-face.service` (systemd --user) active + enabled, `Linger=yes`
- Bridge `server.py` on `127.0.0.1:9120`; page at `/face/`, health at `/health`
- Installed copy `~/.local/share/hermes-face` byte-identical to this repo
- End-to-end turn verified: `POST /say` → `hermes chat` → reply on stdout → edge-tts →
  `audio/reply-<n>.mp3` served at `/audio/…`; state goes
  `thinking → speaking → idle`
- Renderer verified in Chromium: canvas `web/face.js`, cell-quantised head + glyph
  rain + scanlines + vignette, live editor on `E`
- Git history here is the real one (30 commits). `git log --oneline` is the changelog.

## Implement it

```bash
git clone <this> hermes-face && cd hermes-face
./install.sh          # copies to ~/.local/share/hermes-face, venv + edge-tts, unit, kiosk bin, autostart
systemctl --user restart hermes-face    # enable --now does NOT restart a running unit
curl -s 127.0.0.1:9120/health           # {"ok": true}
```

Config: `config.json` next to `server.py` is the saved look + voice; the installer keeps an
existing one. `params` are the flat set in `web/schema.json` — do not invent keys.

## Gotchas that cost hours here

- `hermes chat` has **no** `--format stream-json`. Reply is on **stdout**, the
  `session_id:` line on **stderr**. Turn shape: `hermes chat --query-file F -Q
  --source tool [--resume SID] --continue <name> --create-if-missing`.
- `systemctl --user enable --now` will not restart a running unit — always `restart`.
- `edge-tts` from uv is CLI-only, not importable by systemd's interpreter: `synth()`
  must fall back to the CLI or every reply is silent.
- Chromium derives the window class from the URL, so the kiosk window is
  `chrome-127.0.0.1__face_-Default`; `--class=` is ignored by `omarchy-launch-webapp`.
  Never match a bare `chrome-localhost__-Default` — that hits every local webapp.
- Hyprland 0.56 with the Lua config: `hyprctl dispatch …` is rejected. Use
  `hyprctl eval "hl.dispatch(hl.dsp.focus({ workspace = '1' }))"`; close with
  `hl.dsp.window.close({ window = 'address:0x…' })`.
- Rain/threads must **multiply** (darken gaps). An additive `lighter` pass over the head
  flattens the key light and saturates to white.
- Do not re-seed `config.json` on install if a human is tuning the face live — check its
  mtime first; saving from a test page fights them.

## Cost (measured, Sandy Bridge iGPU, 4 cores, 1600×900)

~0.75 of one core while visible (GPU proc ~45%, renderer ~30% ≈ 19% of the machine);
~1% when the workspace is hidden (Chromium throttles rAF). Head parallax is free;
the cost is the cell quantiser (`getImageData`/`putImageData` per frame) plus the
full-screen rain/scanline/vignette passes. Measure with a per-frame probe
(`stats.drawMs`), not process CPU — process CPU collapses the moment the workspace
changes.
