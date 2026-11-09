# Face-to-face peering — install notes

Two files and one unit. Everything here was measured on `ProPierre-Work`
(`192.168.10.112`), Arch/Omarchy, `hermes-face` on `127.0.0.1:9120`.

## Files

- `server.py` — your `server.py` plus one new route, `POST /speak`, which speaks a line
  verbatim with no agent turn behind it. 44 added lines, nothing else changed. Shares the
  `seq` counter with `/say`, so an arriving peer line cancels an in-flight turn exactly as
  a new spoken command does.
- `face_peer.py` — the sidecar. UDP beacon on `9998` every 2 s, peer marked gone after 8 s
  of silence, greeting once per peer per 15 min, `/talk` for user-initiated lines,
  `--max-turns` cap (default 6) per peer.
- `face-peer.service.example` — a user unit. Change `--name`, `--id`, and the paths.

## Install

```bash
cd ~/.local/share/hermes-face
cp -p server.py server.py.pre-peer            # keep a way back
cp /path/to/bundle/server.py server.py
python3 -m py_compile server.py
systemctl --user restart hermes-face          # required: the route is new
cp /path/to/bundle/face_peer.py .
# unit: put it in ~/.config/systemd/user/face-peer.service, then
systemctl --user daemon-reload && systemctl --user enable --now face-peer
```

Ports, once, as root: `ufw allow from 192.168.10.0/24 to any port 9998 proto udp` and
`ufw allow from 192.168.10.0/24 to any port 9910 proto tcp`. On this LAN the two hosts are
`192.168.10.112` (Pro-Pierre) and `192.168.10.102` (Suzie).

## Verify

```bash
curl -s http://127.0.0.1:9910/health
curl -s http://127.0.0.1:9910/peers          # should list face-pierre within ~2 s
curl -s -X POST -H 'Content-Type: application/json' \
     -H "X-Face-Token: $(cat ~/.local/share/hermes-face/token)" \
     -d '{"text":"Test line.","from":"self"}' http://127.0.0.1:9120/speak
```

`/speak` answers `{"ok": true, "seq": N}` immediately; the audio lands in `audio/peer-N.mp3`
about 7–9 s later (edge-tts) and `/state` flips `thinking -> speaking -> idle`.

## Behaviour, as built

Each face speaks only its own words on its own speakers; the wire carries text, never
audio. A greeting fires when a peer first appears, staggered 1.2–2.2 s per peer id so two
faces that spot each other in the same second do not talk over each other. `/talk` speaks
your line locally, then sends it; the peer answers with a real agent turn and returns the
text, which is *not* spoken on your side — only its originator's face says a line.

## Health on a remote face

`/health` is behind the peer key like every other route, so a monitor that polls a face on
another machine must send `X-Peer-Key`. Loopback polling (the bar widget, `face-doctor.sh`,
`face-state.sh`) is unaffected. This is deliberate: one rule for the port beats one exception
that someone later copies.

## A peer line never cuts Pierre's answer

Verified on a live bridge by timing, not by reading: a turn was started, and once the face was
genuinely `speaking` a peer line was posted. The post returned **11.3 s** later, exactly when
the turn went idle — the answer finished first, then the peer line took the face. Under 45 s
the wait is polite; past 45 s the line wins, because an answer that never ends must not lock
out the room.
