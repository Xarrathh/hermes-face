# Security notes

This repository is a bar widget plus the copy of the Hermes face it runs. It executes as your own
user, unsandboxed, like every other community plugin. This document states exactly what it touches
so the marketplace's automated baseline and a human reviewer do not have to infer it.

## What runs, and as whom

| Process | Started by | Runs as |
| --- | --- | --- |
| `bin/*.sh` helpers | the bar widget (clicks), the theme hook, the stop key | you |
| `face/server.py` | `systemd --user` unit `hermes-face.service` (or a detached process where systemd is unavailable) | you |
| `hermes chat` | `face/server.py`, one child per spoken turn | you |

No `sudo`, no `pkexec`, no root, no setuid, and no passwordless privilege rules. Nothing is
installed outside the user's home.

## Network

- The bridge binds `127.0.0.1:9120` only. It cannot be reached from the LAN or the internet.
- The optional peer layer is the one listener that faces the LAN: `udp/9998` receives discovery
  beacons and `tcp/9910` serves the peer API. Both are off until `face-peer.service` is enabled,
  and every mutating peer route requires the shared key in `peer.key` (`X-Peer-Key`); loopback is
  trusted so the local bridge can call `/route` without one. Without a key file the peer API
  answers loopback only. Discovery beacons carry the face id, name, aliases and port — no text,
  no audio, no paths.
- Enabling the peer layer means opening those two ports to your own subnet and nothing wider.
  The installer prints the two `ufw` commands rather than guessing your LAN.
- Scripts, the widget and the hook talk to that loopback port and nowhere else.
- **The face's speech is not local.** `edge-tts` synthesises through Microsoft's Edge read-aloud
  service (`wss://speech.platform.bing.com`). The text it speaks — the agent's reply — is sent
  there. No audio, no microphone input and no history is uploaded; only the sentence being spoken.
  If you do not want that, remove `edge-tts` (or leave the `venv` absent): the face then runs and
  displays silently, which it reports on screen.
- The reply itself is produced by your own Hermes agent, whose model traffic is governed by your
  Hermes configuration, not by this plugin.
- `pip install edge-tts` fetches that one package from PyPI the first time voice is needed. Nothing
  else is downloaded, and no code is fetched and executed at runtime.

## Local authorisation

The bridge is on loopback, which means "this machine", not "this user". Private endpoints are
therefore gated on the kernel's answer about the *client socket*: its local endpoint, the endpoint
it connected to, and the owning uid, resolved from `/proc/net/tcp{,6}`. A connection from another
local account is refused. `/health` and `/face/*` are deliberately open, and contain no user data.

`POST` additionally requires `content-type: application/json` and, when present, a same-origin
`Origin`/`Referer`, so a web page in any browser cannot drive the bridge.

A shared token remains as a fallback for systems where `/proc` is unreadable to the service; it is
never passed on a command line or in a URL by these scripts.

## Files

`~/.local/share/hermes-face/` is mode `0700`; `config.json`, `history.json`, the token file and
every audio and prompt file are `0600`. `harden_permissions()` re-applies this at each start, so an
install created under a looser umask is corrected rather than left readable — and every rewrite of
`config.json` creates its temp file `0600` rather than inheriting the umask, because the rename
carries that mode with it.

Spoken audio is pruned as the face is used: a new turn deletes the `reply-*.mp3` files of older
turns, and `voice-test-*` leftovers older than a day go too, so his voice does not accumulate in
the prefix forever. Abandoned `q-*.txt` prompt files — the ones a killed bridge leaves behind —
age out in the same sweep, and the sweep also runs at boot. The systemd unit sets
`NoNewPrivileges=yes` and `UMask=0077`, so a file the bridge creates is private at creation
rather than at the next startup chmod.

Prompt text and reply text are never placed in process arguments. The bridge calls the agent with
`--query-file`, and a CLI too old for that flag is refused rather than having the spoken words put
in `ps`; `HERMES_FACE_ALLOW_INLINE_PROMPT=1` opts into the exposure explicitly, for an old install
its owner chooses to keep. The CLI speech fallback writes to a private file and passes `--file`.

## Headers

The page is served with a strict `Content-Security-Policy` (`default-src 'self'`, no inline
script, `connect-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`; every response is `Cache-Control:
`no-store`. A `POST` body is capped at 1 MiB and a malformed `Content-Length` is answered with 400
instead of being read; `/say` accepts at most 8000 characters and the voice sampler 400.

`HEAD` is answered like `GET` without a body, so a monitor that probes with `curl -I` sees `200`
rather than the `501` an unimplemented method returns. `/health` is readiness only (`ok`, `agent`):
the agent's binary path lives on the authenticated `/state`, not on the one route any local
account may read.

## What the automated baseline will flag

Declared in advance, so these are expected rather than surprising:

- `package-manager` — `bin/face-ensure.sh` runs `pip install edge-tts` into a private venv when no
  working copy exists.
- `service-management` — `bin/face-ensure.sh` and `bin/face-restart.sh` use
  `systemctl --user daemon-reload|enable|restart` on the user's own unit.
- `installer` — the vendored `face/` tree is copied into the user's data directory on first use.

There are no findings-pattern matches: no `curl | sh`, no unpinned remote git execution, no
privileged-process control from shared temporary files, and no privilege-escalation rules of any
kind. All temporary state is created with `O_CREAT` mode `0600` inside the owner's home; nothing
uses `/tmp`.

## Removing it

`omarchy plugin remove pierregoosen.hermes-face` removes the widget. The bridge and its data are
separate and stay until you delete them: `systemctl --user disable --now hermes-face` and
`rm -rf ~/.local/share/hermes-face ~/.config/systemd/user/hermes-face.service`.

## Reporting

Open an issue for ordinary bugs. For anything that looks like a vulnerability, use GitHub's private
vulnerability reporting on this repository rather than a public issue.
