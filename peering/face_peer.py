#!/usr/bin/env python3
"""face-peer - LAN presence, turn-taking and voice relay for hermes-face.

Two faces find each other by UDP beacon and hold a conversation: the detecting face greets
the newcomer, and on request one face speaks a line, the other answers, and *its actual
audio* is played here. Relaying the mp3 rather than the text matters: re-synthesising a
peer's words in this host's voice would put one face's sentences in another face's mouth.

The wire carries text for turn-taking and the mp3 for the answer, never a microphone.

Loop protection, in order: a greeting fires once per peer per GREET_COOLDOWN, replies are
capped by --max-turns per conversation, and a message carrying kind="greet" is never
answered with another greeting.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.1"
PRESENT_TTL = 8.0          # seconds of beacon silence before a peer is "gone"
GREET_COOLDOWN = 900.0    # one greeting per peer per 15 minutes
BEACON_EVERY = 2.0
AUDIO_NAME = re.compile(r"[A-Za-z0-9._-]{1,64}\.mp3")

LOG_LOCK = threading.Lock()


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} face-peer[{os.getpid()}] {msg}"
    with LOG_LOCK:
        print(line, flush=True)


class Book:
    """Who is on the wire right now."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.peers: dict[str, dict] = {}

    def seen(self, pid: str, info: dict) -> tuple[bool, dict]:
        with self.lock:
            p = self.peers.get(pid) or {"greeted": 0.0, "present": False}
            was = bool(p.get("present"))
            for k in ("name", "port", "face", "ip"):
                if info.get(k) is not None:
                    p[k] = info[k]
            p["last"] = time.time()
            p["present"] = True
            self.peers[pid] = p
            return (not was), dict(p)

    def sweep(self) -> list[str]:
        gone = []
        with self.lock:
            for pid, p in self.peers.items():
                if p.get("present") and time.time() - p.get("last", 0) > PRESENT_TTL:
                    p["present"] = False
                    gone.append(pid)
        return gone

    def resolve(self, who: str) -> tuple[str | None, dict | None]:
        with self.lock:
            if who in self.peers:
                return who, dict(self.peers[who])
            for pid, p in self.peers.items():
                if (p.get("name") or "").lower() == who.lower():
                    return pid, dict(p)
        return None, None

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [dict(id=pid, **p) for pid, p in self.peers.items()]

    def mark_greeted(self, pid: str) -> None:
        with self.lock:
            if pid in self.peers:
                self.peers[pid]["greeted"] = time.time()


# ------------------------------------------------------------------ face calls
def face_call(args: argparse.Namespace, path: str, payload: dict, timeout: float = 40.0) -> dict:
    req = urllib.request.Request(
        args.face_url.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Face-Token": args.token,
            "User-Agent": f"face-peer/{VERSION}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def face_state(args: argparse.Namespace) -> dict:
    req = urllib.request.Request(
        args.face_url.rstrip("/") + "/state",
        headers={"X-Face-Token": args.token, "User-Agent": f"face-peer/{VERSION}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read() or b"{}")


def last_audio(args: argparse.Namespace, timeout: float = 25.0) -> str:
    """The file name of the audio the face is speaking (or last spoke), without the prefix."""
    deadline = time.time() + timeout
    seen = ""
    while time.time() < deadline:
        try:
            st = face_state(args)
        except Exception:                          # noqa: BLE001
            break
        parts = st.get("audio_parts") or []
        if parts:
            seen = str(parts[-1])
        elif st.get("audio"):
            seen = str(st["audio"])
        if seen and not st.get("error"):
            return seen.rsplit("/", 1)[-1]
        time.sleep(0.25)
    return seen.rsplit("/", 1)[-1] if seen else ""


def speak_local(args: argparse.Namespace, text: str, frm: str) -> str:
    try:
        face_call(args, "/speak", {"text": text, "from": frm, "kind": "peer"})
        name = last_audio(args)
        log(f"spoke locally as {frm!r}: {text[:70]!r} -> {name or 'no audio'}")
        return name
    except Exception as exc:                       # noqa: BLE001
        log(f"local speak failed: {exc}")
        return ""


def ask_agent(args: argparse.Namespace, peer_name: str, text: str) -> tuple[str, str]:
    """Run a real agent turn so the answer is this face's own, then read it and its audio back."""
    prompt = (f"{peer_name} (another Hermes face on this LAN) said: {text}\n"
              "Reply to them in one short spoken sentence, no markdown.")
    # Whatever the face spoke before this call is not this turn's answer. Handing that name
    # back relays a stale clip, and the listener hears the previous line again in the voice of
    # whoever said it last -- which reads as an echo.
    before = ""
    try:
        st0 = face_state(args)
        parts0 = st0.get("audio_parts") or []
        before = str(parts0[-1]) if parts0 else str(st0.get("audio") or "")
    except Exception:                              # noqa: BLE001
        pass
    try:
        face_call(args, "/say", {"text": prompt})
    except Exception as exc:                       # noqa: BLE001
        log(f"agent turn failed to start: {exc}")
        return "", ""
    deadline = time.time() + args.reply_timeout
    last_name = ""
    while time.time() < deadline:
        time.sleep(0.5)
        try:
            st = face_state(args)
        except Exception:                          # noqa: BLE001
            continue
        # The turn clears audio_parts when it goes idle, so the file that was spoken has to
        # be caught while it is still speaking -- reading only the final state always
        # reports "no audio" and the relay silently degrades to text.
        parts = st.get("audio_parts") or []
        if parts and str(parts[-1]) != before:
            last_name = str(parts[-1]).rsplit("/", 1)[-1]
        elif st.get("audio") and str(st["audio"]) != before:
            last_name = str(st["audio"]).rsplit("/", 1)[-1]
        if st.get("error"):
            # A failed turn writes its complaint into `reply`, and speaking it aloud turns a
            # broken bridge into the face answering with an error message. Nothing is relayed.
            log(f"turn error on this side: {st['error'][:140]}")
            return "", ""
        if st.get("agent") == "idle" and (st.get("reply") or "").strip():
            return str(st["reply"]).strip(), last_name
    return "", ""


# ------------------------------------------------------------------ transport
def post_json(url: str, payload: dict, timeout: float = 40.0) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": f"face-peer/{VERSION}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def http_bytes(url: str, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": f"face-peer/{VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def peer_url(p: dict, path: str) -> str:
    return f"http://{p['ip']}:{int(p['port'])}{path}"


def relay_audio(args: argparse.Namespace, peer: dict, name: str) -> bool:
    """Fetch the peer's own mp3 and play it here, so its voice, not ours, is heard."""
    if not name or not AUDIO_NAME.fullmatch(name):
        return False
    try:
        blob = http_bytes(peer_url(peer, "/audio/" + urllib.parse.quote(name)))
    except Exception as exc:                       # noqa: BLE001
        log(f"audio fetch from {peer.get('name')} failed: {exc}")
        return False
    if len(blob) < 512:
        log(f"relayed audio too small ({len(blob)} bytes); not playing")
        return False
    local = f"relay-{int(time.time() * 1000)}.mp3"
    try:
        (args.audio_dir / local).write_bytes(blob)
    except OSError as exc:
        log(f"cannot store relayed audio: {exc}")
        return False
    try:
        face_call(args, "/play", {"file": local, "from": peer.get("name") or "peer"})
        log(f"relayed {len(blob)} bytes of {peer.get('name')}'s voice as {local}")
        return True
    except Exception as exc:                       # noqa: BLE001
        log(f"local playback failed: {exc}")
        return False


# ------------------------------------------------------------------ loops
def beacon_loop(args: argparse.Namespace, stop: threading.Event) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
    body = json.dumps({"v": VERSION, "id": args.id, "name": args.name,
                       "port": args.port, "face": "hermes-face"}).encode()
    while not stop.is_set():
        try:
            sock.sendto(body, (args.beacon_send, args.beacon_send_port))
        except OSError as exc:
            log(f"beacon send failed: {exc}")
        stop.wait(BEACON_EVERY)
    sock.close()


def listen_loop(args: argparse.Namespace, book: Book, stop: threading.Event) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    except (AttributeError, OSError):
        pass
    sock.bind(("", args.beacon_port))
    log(f"listening for beacons on udp/{args.beacon_port}")
    sock.settimeout(1.0)
    while not stop.is_set():
        try:
            data, addr = sock.recvfrom(2048)
        except socket.timeout:
            for pid in book.sweep():
                log(f"peer gone: {pid}")
            continue
        except OSError:
            break
        try:
            info = json.loads(data.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            continue
        pid = str(info.get("id") or "")
        if not pid or pid == args.id:
            continue
        info["ip"] = addr[0]
        fresh, peer = book.seen(pid, info)
        if fresh:
            log(f"peer present: {peer.get('name')} at {addr[0]}:{peer.get('port')}")
            book.mark_greeted(pid)
            threading.Thread(target=greet, args=(args, pid, peer), daemon=True).start()
    sock.close()


def greet(args: argparse.Namespace, pid: str, peer: dict) -> None:
    # Stagger so two faces that spot each other in the same second do not talk over each
    # other: a fixed offset per peer id, still quick enough to feel like noticing someone.
    time.sleep(1.2 + (sum(pid.encode()) % 1000) / 1000.0)
    name = peer.get("name") or pid
    speak_local(args, args.greet.format(name=name), "peer")


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = f"face-peer/{VERSION}"
    args: argparse.Namespace
    book: Book

    def log_message(self, fmt: str, *a) -> None:
        log("http " + fmt % a)

    def _json(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if n <= 0 or n > (1 << 18):
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_GET(self) -> None:                      # noqa: N802
        path = self.path.split("?")[0]
        if path == "/health":
            return self._json({"ok": True, "who": self.args.id, "version": VERSION})
        if path == "/peers":
            return self._json({"me": {"id": self.args.id, "name": self.args.name},
                               "peers": self.book.snapshot()})
        if path.startswith("/audio/"):
            name = urllib.parse.unquote(path[len("/audio/"):])
            if not AUDIO_NAME.fullmatch(name):
                return self._json({"error": "bad name"}, 400)
            try:
                blob = (self.args.audio_dir / name).read_bytes()
            except OSError:
                return self._json({"error": "not found"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
            return None
        return self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:                     # noqa: N802
        path = self.path.split("?")[0]
        body = self._body()

        if path == "/speak":
            text = str(body.get("text") or "").strip()
            if not text:
                return self._json({"error": "empty"}, 400)
            speak_local(self.args, text[:600], self.args.name)
            return self._json({"ok": True})

        if path == "/talk":
            who = str(body.get("to") or "").strip()
            text = str(body.get("text") or "").strip()
            if not who or not text:
                return self._json({"error": "to and text required"}, 400)
            pid, peer = self.book.resolve(who)
            if not peer:
                return self._json({"error": f"no peer {who!r}",
                                   "peers": [p["id"] for p in self.book.snapshot()]}, 404)
            if not peer.get("present"):
                return self._json({"error": f"peer {who!r} is not present"}, 409)
            # My line is spoken here, in my own voice, before it is sent: the face says
            # what it means, then tells the other face what was said.
            speak_local(self.args, text[:600], self.args.name)
            try:
                answer = post_json(peer_url(peer, "/peer/incoming"),
                                   {"from": self.args.name, "id": self.args.id,
                                    "text": text[:600], "kind": body.get("kind") or "talk"},
                                   timeout=self.args.reply_timeout + 20)
            except Exception as exc:               # noqa: BLE001
                return self._json({"error": f"peer unreachable: {exc}"}, 502)
            reply = str(answer.get("reply") or "")
            relayed = relay_audio(self.args, peer, str(answer.get("audio") or ""))
            return self._json({"ok": True, "peer": peer.get("name"), "reply": reply,
                               "relayed_audio": relayed})

        if path == "/peer/incoming":
            frm = str(body.get("from") or "peer")[:60]
            text = str(body.get("text") or "").strip()
            kind = str(body.get("kind") or "talk")
            if not text:
                return self._json({"error": "empty"}, 400)
            log(f"incoming from {frm}: {text[:70]!r} kind={kind}")
            if kind == "greet" or not self.args.auto_reply:
                return self._json({"ok": True, "reply": "", "audio": ""})
            with LOCK_TURNS:
                turns = TURNS.get(frm, 0)
                if turns >= self.args.max_turns:
                    log(f"turn cap reached for {frm}; not answering")
                    return self._json({"ok": True, "reply": "", "audio": "", "capped": True})
                TURNS[frm] = turns + 1
            reply, audio = ask_agent(self.args, frm, text)
            log(f"answered {frm}: {reply[:70]!r} audio={audio or 'none'}")
            return self._json({"ok": True, "reply": reply, "audio": audio})

        return self._json({"error": "not found"}, 404)


TURNS: dict[str, int] = {}
LOCK_TURNS = threading.Lock()


def read_token(path: str) -> str:
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError as exc:
        log(f"token unreadable ({exc}); face calls will 401")
        return ""


def main() -> int:
    ap = argparse.ArgumentParser(description="LAN presence and turn-taking for hermes-face")
    ap.add_argument("--name", required=True, help="this face's spoken name, e.g. Pro-Pierre")
    ap.add_argument("--id", required=True, help="stable face id, e.g. face-pierre")
    ap.add_argument("--port", type=int, default=9910, help="TCP port peers call")
    ap.add_argument("--beacon-port", type=int, default=9998, help="UDP port beacons arrive on")
    ap.add_argument("--beacon-send", default="255.255.255.255", help="beacon destination")
    ap.add_argument("--beacon-send-port", type=int, default=None,
                    help="beacon destination port (default: --beacon-port)")
    ap.add_argument("--face-url", default="http://127.0.0.1:9120")
    ap.add_argument("--token-file", default=os.path.expanduser("~/.local/share/hermes-face/token"))
    ap.add_argument("--audio-dir", default=os.path.expanduser("~/.local/share/hermes-face/audio"))
    ap.add_argument("--greet", default="Hello, {name}. I can see you.")
    ap.add_argument("--auto-reply", action="store_true", help="answer an incoming line with an agent turn")
    ap.add_argument("--max-turns", type=int, default=6, help="answers per peer before the cap")
    ap.add_argument("--reply-timeout", type=float, default=60.0)
    args = ap.parse_args()
    if args.beacon_send_port is None:
        args.beacon_send_port = args.beacon_port
    args.token = read_token(args.token_file)
    args.audio_dir = Path(os.path.expanduser(args.audio_dir))

    book = Book()
    stop = threading.Event()
    Handler.args = args
    Handler.book = book

    threading.Thread(target=beacon_loop, args=(args, stop), daemon=True).start()
    threading.Thread(target=listen_loop, args=(args, book, stop), daemon=True).start()

    httpd = ThreadingHTTPServer(("", args.port), Handler)
    log(f"{args.name} ({args.id}) serving on tcp/{args.port}, face at {args.face_url}, "
        f"audio {args.audio_dir}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
