#!/usr/bin/env python3
"""face-peer - LAN presence and turn-taking for hermes-face.

Each face speaks only its own words on its own speakers. The wire carries text, never
audio: a voice belongs to the machine whose TTS produced it, and two private /24s that
happen to share a prefix have taught us not to assume a path exists until a beacon lands.

Discovery is a plain UDP broadcast, not mDNS: no avahi dependency, and the payload is
already the thing we need (id, name, port). A peer is present after one beacon and gone
after PRESENT_TTL of silence.

Loop protection, in order: a greeting fires once per peer per GREET_COOLDOWN, replies are
capped by --max-turns per conversation, and any message carrying kind="greet" is never
answered with another greeting.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
PRESENT_TTL = 8.0          # seconds of beacon silence before a peer is "gone"
GREET_COOLDOWN = 900.0    # one greeting per peer per 15 minutes
BEACON_EVERY = 2.0

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

    def get(self, pid: str) -> dict:
        with self.lock:
            return dict(self.peers.get(pid) or {})

    def resolve(self, who: str) -> tuple[str, dict] | tuple[None, None]:
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


def speak_local(args: argparse.Namespace, text: str, frm: str) -> None:
    try:
        face_call(args, "/speak", {"text": text, "from": frm, "kind": "peer"})
        log(f"spoke locally as {frm!r}: {text[:70]!r}")
    except Exception as exc:                       # noqa: BLE001
        log(f"local speak failed: {exc}")


def ask_agent(args: argparse.Namespace, peer_name: str, text: str) -> str:
    """Run a real agent turn so the answer is the face's own, then read the reply back."""
    prompt = f"{peer_name} (another Hermes face on this LAN) said: {text}\nReply to them in one short spoken sentence, no markdown."
    face_call(args, "/say", {"text": prompt})
    deadline = time.time() + args.reply_timeout
    while time.time() < deadline:
        time.sleep(0.7)
        try:
            with urllib.request.urlopen(
                urllib.request.Request(
                    args.face_url.rstrip("/") + "/state",
                    headers={"X-Face-Token": args.token, "User-Agent": f"face-peer/{VERSION}"},
                ),
                timeout=10,
            ) as resp:
                st = json.loads(resp.read() or b"{}")
        except Exception:                          # noqa: BLE001
            continue
        if st.get("agent") == "idle" and (st.get("reply") or "").strip():
            return str(st["reply"]).strip()
    return ""


# ------------------------------------------------------------------ transport
def post_json(url: str, payload: dict, timeout: float = 40.0) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": f"face-peer/{VERSION}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def peer_url(p: dict, path: str) -> str:
    return f"http://{p['ip']}:{int(p['port'])}{path}"


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
            if peer.get("greeted", 0) + GREET_COOLDOWN < time.time() or not peer.get("greeted"):
                book.mark_greeted(pid)
                threading.Thread(target=greet, args=(args, pid, peer), daemon=True).start()
    sock.close()


def greet(args: argparse.Namespace, pid: str, peer: dict) -> None:
    # Stagger so two faces that spot each other in the same second do not talk over
    # each other: a fixed offset per peer id, small enough to still feel immediate.
    time.sleep(1.2 + (sum(pid.encode()) % 1000) / 1000.0)
    name = peer.get("name") or pid
    speak_local(args, args.greet.format(name=name), "peer")


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = f"face-peer/{VERSION}"
    args: argparse.Namespace
    book: Book

    def log_message(self, fmt: str, *a) -> None:    # keep the journal readable
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
                return self._json({"error": f"no peer {who!r}", "peers": [p["id"] for p in self.book.snapshot()]}, 404)
            if not peer.get("present"):
                return self._json({"error": f"peer {who!r} is not present"}, 409)
            # My line is spoken here, by my own voice, before it is sent: the face says
            # what it means, then tells the other face what was said.
            speak_local(self.args, text[:600], self.args.name)
            try:
                answer = post_json(peer_url(peer, "/peer/incoming"),
                                   {"from": self.args.name, "id": self.args.id,
                                    "text": text[:600], "kind": body.get("kind") or "talk"},
                                   timeout=self.args.reply_timeout + 10)
            except Exception as exc:               # noqa: BLE001
                return self._json({"error": f"peer unreachable: {exc}"}, 502)
            return self._json({"ok": True, "peer": peer.get("name"), "reply": answer.get("reply", "")})

        if path == "/peer/incoming":
            frm = str(body.get("from") or "peer")[:60]
            text = str(body.get("text") or "").strip()
            kind = str(body.get("kind") or "talk")
            if not text:
                return self._json({"error": "empty"}, 400)
            log(f"incoming from {frm}: {text[:70]!r} kind={kind}")
            if kind == "greet" or not self.args.auto_reply:
                return self._json({"ok": True, "reply": ""})
            with LOCK_TURNS:
                turns = TURNS.get(frm, 0)
                if turns >= self.args.max_turns:
                    log(f"turn cap reached for {frm}; not answering")
                    return self._json({"ok": True, "reply": "", "capped": True})
                TURNS[frm] = turns + 1
            reply = ask_agent(self.args, frm, text)
            log(f"answered {frm}: {reply[:70]!r}")
            return self._json({"ok": True, "reply": reply})

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
    ap.add_argument("--beacon-send-port", type=int, default=None, help="beacon destination port (default: --beacon-port)")
    ap.add_argument("--face-url", default="http://127.0.0.1:9120")
    ap.add_argument("--token-file", default=os.path.expanduser("~/.local/share/hermes-face/token"))
    ap.add_argument("--greet", default="Hello, {name}. I can see you.")
    ap.add_argument("--auto-reply", action="store_true", help="answer an incoming line with an agent turn")
    ap.add_argument("--max-turns", type=int, default=6, help="answers per peer before the cap")
    ap.add_argument("--reply-timeout", type=float, default=45.0)
    args = ap.parse_args()
    if args.beacon_send_port is None:
        args.beacon_send_port = args.beacon_port
    args.token = read_token(args.token_file)

    book = Book()
    stop = threading.Event()
    Handler.args = args
    Handler.book = book

    threading.Thread(target=beacon_loop, args=(args, stop), daemon=True).start()
    threading.Thread(target=listen_loop, args=(args, book, stop), daemon=True).start()

    httpd = ThreadingHTTPServer(("", args.port), Handler)
    log(f"{args.name} ({args.id}) serving on tcp/{args.port}, face at {args.face_url}")
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
