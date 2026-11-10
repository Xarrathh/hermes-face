# Face-to-face peering — install notes

Two files and one unit. Everything here was measured on `ProPierre-Work`
(`192.168.10.112`), Arch/Omarchy, `hermes-face` on `127.0.0.1:9120`.

## Files

- `server.py` — your `server.py` plus one new route, `POST /speak`, which speaks a line
  verbatim with no agent turn behind it. 44 added lines, nothing else changed. Shares the
  `seq` counter with `/say`, so an arriving peer line cancels an in-flight turn exactly as
  a new spoken command does.
- `face_peer.py` — the sidecar. UDP beacon on `9998` every 2 s, peer marked gone after 8 s
  of silence, greeting once per peer per 15 min, `/talk` for user-initiated lines (with
  `rounds=N`, 1–4, for a debate), `--max-turns` per-peer cap (default 12) inside a 300 s
  window, `--reply-timeout` default 120 s.
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

## Trust: automatic by default

Two faces on one network find each other and talk with nothing to configure. Possession of
the LAN address is the boundary: discovery, greeting and answering are unattended.

`peering.json` still holds a list, and the list fills itself:

- `seen` — every face that has contacted this box, with id, name and time. Nothing to write.
- `blocked` — ids refused outright (`403 face blocked`). `bin/face-trust.sh block <name>`.
- `strict: true` — answer only ids in `trusted`.
- `require_key: true` — demand the shared `peer.key` as well, for a network you do not own.

List changes are accepted from loopback only. The key and the pairing tool (`face_pair.py
mint` / `join`) remain for the `require_key` case; the default path needs neither.

## Failure behaviour

A partial answer must never look like a finished one:

- `/peer/incoming` returns `{"ok": true, "reply": …, "audio": …, "reason": …}` where `reason`
  is `ok`, `ok-no-audio` (words survived a speech failure), `timeout`, `error` or
  `unreachable`.
- `/talk` returns `lines`, `asked` and `stopped`. `stopped` is empty on a complete exchange
  and names the cause otherwise (`peer empty`, `peer unreachable: …`, `this face: timeout`).
- One turn at a time **per peer**: a second caller waits up to 150 s, then gets
  `409 {"reason": "busy"}`. Different peers are never serialised against each other.
- `/say` claims the turn under one lock (`_claim_turn`) and answers `409 busy` rather than
  killing the turn already running. Callers arriving together queue instead of racing for
  the sequence number, which used to leave orphaned turns.
- A reply's mp3 is never deleted while it might still be playing: files younger than two
  minutes survive, and pruning keeps the last three turns.

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

`/peers` reports the mode and who has been seen:

```bash
curl -s -H "X-Peer-Key: $(cat peer.key)" http://127.0.0.1:9910/peers
# {"me": {...}, "mode": "automatic", "trusted": [], "blocked": [], "seen": [...]}
```

`/health` stays behind the key when `require_key` is set; on a box with no `peer.key` the
automatic mode answers it, and `build` in the reply is the hash of the running `face_peer.py`
so two boxes can tell whether they are testing the same code.

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

## Pairing a new face without copying a file

    python3 peering/face_pair.py mint            # on any one face: prints 6 groups
    python3 peering/face_pair.py join <code>     # on the new face: writes peer.key, 0600

Minting REPLACES the key, so every other box re-joins the new code. The key is 128 bits of
randomness in base32; the grouping is cosmetic and `join` accepts any case without dashes.
This is the path for a fresh install: no file moves, nothing is published, and the secret is
read off one screen and typed once.
