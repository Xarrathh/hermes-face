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

VERSION = "1.2"
PRESENT_TTL = 8.0          # seconds of beacon silence before a peer is "gone"
GREET_COOLDOWN = 900.0    # one greeting per peer per 15 minutes
BEACON_EVERY = 2.0
AUDIO_NAME = re.compile(r"[A-Za-z0-9._-]{1,64}\.mp3")

LOG_LOCK = threading.Lock()

# The dialogue, as it happens: one JSON object per line, so a person can read the exchange the way
# they would read a chat, and the face can show it. Text only — the audio is relayed separately.
TRANSCRIPT = Path(os.path.expanduser("~/.local/share/hermes-face/conversation.jsonl"))


def record(who: str, text: str, reply: str = "") -> None:
    """Append one line of the conversation, trimmed to something readable."""
    try:
        TRANSCRIPT.parent.mkdir(parents=True, exist_ok=True)
        entry = {"t": round(time.time(), 3), "from": who, "text": text[:280],
                 "reply": (reply or "")[:280]}
        with LOG_LOCK:
            with TRANSCRIPT.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            if TRANSCRIPT.stat().st_size > 256_000:      # keep the tail, not a growing archive
                lines = TRANSCRIPT.read_text(encoding="utf-8").splitlines()[-400:]
                TRANSCRIPT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass
# Shared secret for this LAN of faces, read from a file at start (never from argv: a key on a
# command line is visible to every local account through /proc). Empty means "not configured",
# and every peer endpoint refuses instead of trusting whatever asks.
PEER_KEY = ""


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
            for k in ("name", "port", "face", "ip", "aliases"):
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


def echo_score(reply: str, said: str) -> float:
    """How much of one text is made of the other, in whichever direction is fuller."""
    a = {w for w in re.findall(r"[a-z0-9']{3,}", reply.lower())}
    b = {w for w in re.findall(r"[a-z0-9']{3,}", said.lower())}
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return max(inter / len(a), inter / len(b))


def echoes_input(reply: str, said: str) -> bool:
    """True when the answer is really the question coming back.

    A model asked to "reply to them" will sometimes restate what it was told, and on the wire that
    is indistinguishable from an echo: the other face hears its own sentence in a new voice. Word
    overlap is a cheap, explainable test — a genuine counter-argument shares the topic words but
    adds a claim, so the two sets rarely coincide.
    """
    a = {w for w in re.findall(r"[a-z0-9']{3,}", reply.lower())}
    b = {w for w in re.findall(r"[a-z0-9']{3,}", said.lower())}
    if not a or not b:
        return False
    # Containment in whichever direction is fuller, not Jaccard: an echo is "most of one text is
    # made of the other", and Jaccard dilutes that with every extra word. Measured on real output
    # -- verbatim 1.00, paraphrase 0.92, a one-line summary of the input 0.80, a blunt counterpoint
    # that reuses the topic 0.67, a genuine rebuttal 0.00. Jaccard scored the paraphrase 0.79, i.e.
    # under a 0.8 cut, so the guard would have passed the answer it exists to refuse.
    inter = len(a & b)
    return max(inter / len(a), inter / len(b)) >= 0.75


def ask_agent(args: argparse.Namespace, peer_name: str, text: str) -> tuple[str, str]:
    """Run a real agent turn so the answer is this face's own, then read it and its audio back."""
    prompt = (f"{peer_name} (another Hermes face on this LAN) said: {text}\n"
              "Answer them in one short spoken sentence, in your own words. Do not repeat or "
              "paraphrase what they said; state your own position and one reason for it, and "
              "no markdown.")
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
        face_call(args, "/say", {"text": prompt, "origin": "peer"})
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
        headers={"Content-Type": "application/json", "User-Agent": f"face-peer/{VERSION}",
                 "X-Peer-Key": PEER_KEY},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read() or b"{}")


def http_bytes(url: str, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": f"face-peer/{VERSION}",
                                               "X-Peer-Key": PEER_KEY})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def peer_url(p: dict, path: str) -> str:
    return f"http://{p['ip']}:{int(p['port'])}{path}"


# ------------------------------------------------------------------ addressing
def load_identity(args: argparse.Namespace) -> tuple[str, list[str]]:
    """This face's spoken name and the extra words that address it, from peering.json.

    The name lives in a file rather than in the unit's arguments so the Omarchy plugin can
    edit it, and so a renamed face keeps its id and its peers.
    """
    name, aliases = args.name, []
    path = Path(args.config_file) if args.config_file else Path(args.audio_dir).parent / "peering.json"
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return name, aliases
    if isinstance(cfg.get("name"), str) and cfg["name"].strip():
        name = cfg["name"].strip()[:40]
    if isinstance(cfg.get("aliases"), list):
        aliases = [str(a).strip()[:40] for a in cfg["aliases"] if str(a).strip()]
    # A name is always an address for itself, even when the alias list forgot it.
    for form in (name, name.lower(), name.replace("-", " "), name.replace(" ", "-")):
        if form.lower() not in [a.lower() for a in aliases]:
            aliases.append(form)
    return name, aliases


ADDRESS_VERBS = ("ask", "tell", "say to", "speak to", "vra", "sê vir", "se vir",
                 "argue with", "debate with", "discuss with", "dispute with", "stry met")
DEBATE_VERBS = ("argue with", "debate", "debate with", "discuss with", "dispute", "stry met")


def debate_rounds(text: str, name: str) -> int:
    """How many rounds a sentence asks for: "argue with Suzie about X" is a debate, not a question.

    Three rounds is the smallest number that lets a position be answered and then answered back,
    which is what "argue" means to a person. Anything else stays a single exchange.
    """
    low = text.lower()
    if not any(v in low for v in DEBATE_VERBS):
        return 1
    return 3 if name.lower() in low else 1


def route_target(text: str, peers: list[dict], me: list[str]) -> tuple[dict | None, str]:
    """Which peer this sentence is addressed to, and the sentence with the address removed.

    Two shapes are honoured, cheapest first: a leading vocative ("Suzie, ..."), which is how a
    person actually speaks to a face across a room, and a verb form ("ask Suzie ..."). The
    longest matching name wins, so a face called "Pro-Pierre" is not shadowed by "Pierre".
    """
    raw = text.strip()
    low = raw.lower()
    mine = {m.lower() for m in me}
    candidates: list[tuple[int, dict, str]] = []
    for p in peers:
        if not p.get("present"):
            continue
        names = [str(p.get("name") or "").lower()] + [str(a).lower() for a in p.get("aliases") or []]
        for n in names:
            if not n or n in mine:
                continue
            # leading vocative: "suzie," / "suzie:" / "suzie "
            if low.startswith(n) and (len(low) == len(n) or low[len(n)] in ",:;— -"):
                rest = raw[len(n):].lstrip(" ,:;—-").strip()
                if rest:
                    candidates.append((len(n), p, rest))
            head = " ".join(low.split()[:4])
            neg = re.search(r"\b(not|never|no|nooit|nie|don'?t)\b", low)
            for verb in ADDRESS_VERBS:
                pat = f"{verb} {n}"
                i = low.find(pat)
                # Only near the start of the sentence, and never after a negation: "I will not
                # tell Suzie anything" is a statement about Suzie, not an instruction to her.
                if i >= 0 and pat in head and not (neg and neg.start() < i and i - neg.start() < 30):
                    rest = raw[i + len(pat):].lstrip(" ,:;—-").strip()
                    if rest:
                        candidates.append((len(n) + len(verb), p, rest))
    if not candidates:
        return None, ""
    candidates.sort(key=lambda c: -c[0])
    # "argue with Suzie about X" leaves "about X": the preposition belongs to the verb, not to
    # the sentence the other face will hear.
    return candidates[0][1], re.sub(r"^(about|oor|regarding|on)\s+", "", candidates[0][2], flags=re.I)


def local_talk(args: argparse.Namespace, to_name: str, text: str, rounds: int) -> None:
    """Drive this face's own /talk so a debate started by name speaks its own rounds here."""
    try:
        post_json(f"http://127.0.0.1:{args.port}/talk",
                  {"to": to_name, "text": text[:600], "rounds": rounds},
                  timeout=args.reply_timeout * rounds + 60)
    except Exception as exc:                       # noqa: BLE001
        log(f"local debate failed: {exc}")
        speak_local(args, f"{to_name or 'The other face'} did not answer.", "peer")


def http_post_json_async(url: str, payload: dict, timeout: float = 120.0) -> None:
    def run() -> None:
        try:
            post_json(url, payload, timeout=timeout)
        except Exception as exc:                   # noqa: BLE001
            log(f"dispatch to {url} failed: {exc}")
    threading.Thread(target=run, daemon=True).start()


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
    while not stop.is_set():
        # Re-read the name each tick: a rename through the plugin must reach the other faces
        # without restarting the service, and the beacon is the only thing that carries it.
        name, aliases = load_identity(args)
        body = json.dumps({"v": VERSION, "id": args.id, "name": name,
                           "port": args.port, "face": "hermes-face",
                           "aliases": aliases[:8]}).encode()
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
            threading.Thread(target=greet, args=(book, args, pid, peer), daemon=True).start()
    sock.close()


def greet(book: "Book", args: argparse.Namespace, pid: str, peer: dict) -> None:
    # Stagger so two faces that spot each other in the same second do not talk over each
    # other: a fixed offset per peer id, still quick enough to feel like noticing someone.
    time.sleep(0.4 + (sum(pid.encode()) % 600) / 1000.0)
    try:
        # A greeting must never interrupt the user's own turn: /speak cancels whatever is
        # running, so a restart that re-greets could cut an answer in half mid-sentence.
        if face_state(args).get("agent") != "idle":
            log("peer arrived while a turn was live; greeting deferred, not consumed")
            return
    except Exception:                              # noqa: BLE001
        pass
    name = peer.get("name") or pid
    line = args.greet.format(name=name)
    book.mark_greeted(pid)                 # only consume the greeting once it will be spoken
    speak_local(args, line, "peer")
    # Tell the peer it was seen, as a greeting that is never answered: the other face logs the
    # arrival without starting a conversation, and a harness can prove it happened.
    try:
        post_json(peer_url(peer, "/peer/incoming"),
                  {"from": args.name, "id": args.id, "text": line, "kind": "greet"}, timeout=10)
    except Exception as exc:                       # noqa: BLE001
        log(f"could not tell {name} it was seen: {exc}")


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

    def _authorised(self) -> bool:
        """Is this request carrying the LAN peer key?

        The listener is on the network, not on loopback: without this, anyone on the LAN could make
        the face speak, or spend its agent turns through /ask. A request from this machine's own
        user is trusted the same way the bridge trusts it — by the socket, not by a secret.
        """
        import hmac as _hmac
        if not PEER_KEY:
            return False
        given = self.headers.get("X-Peer-Key", "")
        if given and _hmac.compare_digest(given, PEER_KEY):
            return True
        try:
            return self.client_address[0] in ("127.0.0.1", "::1")
        except (IndexError, TypeError):
            return False

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
        if not self._authorised():
            return self._json({"error": "peer key required"}, 403)
        if path == "/health":
            return self._json({"ok": True, "who": self.args.id, "version": VERSION})
        if path == "/transcript":
            # The exchange as text, newest last, so a person can watch the two faces talk.
            if not self._authorised():
                return self._json({"error": "peer key required"}, 403)
            try:
                want = int(urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "").get("limit", ["40"])[0])
            except (ValueError, IndexError):
                want = 40
            lines: list[dict] = []
            try:
                for raw in TRANSCRIPT.read_text(encoding="utf-8").splitlines()[-max(1, min(want, 400)):]:
                    try:
                        lines.append(json.loads(raw))
                    except json.JSONDecodeError:
                        continue
            except OSError:
                pass
            return self._json({"me": self.args.name, "lines": lines})
        if path == "/peers":
            if not self._authorised():
                return self._json({"error": "peer key required"}, 403)
            name, aliases = load_identity(self.args)      # a panel rename must show here
            self.args.name, self.args.aliases = name, aliases
            return self._json({"me": {"id": self.args.id, "name": name},
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
        if not self._authorised():
            return self._json({"error": "peer key required"}, 403)
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
            relayed = relay_audio(self.args, peer, str(answer.get("audio") or "")) if self.args.relay else False
            lines = [{"who": self.args.name, "text": text[:600]},
                     {"who": peer.get("name") or "peer", "text": reply}]
            # `rounds` turns one question into an exchange: each face argues in its own voice, on
            # its own box, and nothing is replayed here. Capped, because every round is two real
            # agent turns and a person is listening.
            rounds = max(1, min(int(body.get("rounds") or 1), 4))
            for _ in range(rounds - 1):
                if not reply:
                    break
                mine, _audio = ask_agent(self.args, peer.get("name") or "peer", reply)
                if not mine:
                    break
                lines.append({"who": self.args.name, "text": mine})
                try:
                    answer = post_json(peer_url(peer, "/peer/incoming"),
                                       {"from": self.args.name, "id": self.args.id,
                                        "text": mine[:600], "kind": "talk"},
                                       timeout=self.args.reply_timeout + 20)
                except Exception as exc:               # noqa: BLE001
                    log(f"debate round failed at {peer.get('name')}: {exc}")
                    break
                reply = str(answer.get("reply") or "")
                lines.append({"who": peer.get("name") or "peer", "text": reply})
            return self._json({"ok": True, "peer": peer.get("name"), "reply": reply,
                               "relayed_audio": relayed, "rounds": rounds, "lines": lines})

        if path == "/route":
            # Addressed by name: this face says the question aloud in its own voice, then the
            # named face answers on *its* machine. Nothing is relayed back here -- both faces
            # are in the room, and a relayed clip would be the same sentence twice.
            text = str(body.get("text") or "").strip()
            if not text:
                return self._json({"handled": False})
            name, aliases = load_identity(self.args)
            self.args.name, self.args.aliases = name, aliases
            peer, rest = route_target(text, self.book.snapshot(), aliases)
            if not peer:
                return self._json({"handled": False})
            rounds = debate_rounds(text, peer.get("name") or "")
            if rounds > 1:
                # A debate needs this face to speak its own rounds, so it cannot be a one-way
                # delegation: run a local multi-round /talk instead of /peer/incoming.
                log(f"debate with {peer.get('name')} over {rounds} rounds: {rest[:60]!r}")
                threading.Thread(target=local_talk,
                                 args=(self.args, peer.get("name") or "", rest, rounds),
                                 daemon=True).start()
                return self._json({"handled": True, "peer": peer.get("name"),
                                   "ack": f"Arguing with {peer.get('name')}.",
                                   "rounds": rounds, "text": rest[:600]})
            log(f"routing to {peer.get('name')}: {rest[:70]!r}")
            http_post_json_async(peer_url(peer, "/peer/incoming"),
                                 {"from": self.args.name, "id": self.args.id,
                                  "text": rest[:600], "kind": "route"},
                                 timeout=self.args.reply_timeout + 20)
            return self._json({"handled": True, "peer": peer.get("name"),
                               "ack": f"Asking {peer.get('name')}.",
                               "text": rest[:600]})

        if path == "/ask":
            # Same as /talk but silent on this side: the agent that asked is already speaking
            # its own line, so this face must not say it twice. The peer's answer is relayed.
            who = str(body.get("to") or "").strip()
            text = str(body.get("text") or "").strip()
            if not who or not text:
                return self._json({"error": "to and text required"}, 400)
            pid, peer = self.book.resolve(who)
            if not peer or not peer.get("present"):
                return self._json({"error": f"peer {who!r} is not present",
                                   "peers": [p["id"] for p in self.book.snapshot()]}, 409)
            try:
                answer = post_json(peer_url(peer, "/peer/incoming"),
                                   {"from": self.args.name, "id": self.args.id,
                                    "text": text[:600], "kind": "talk"},
                                   timeout=self.args.reply_timeout + 20)
            except Exception as exc:               # noqa: BLE001
                return self._json({"error": f"peer unreachable: {exc}"}, 502)
            reply = str(answer.get("reply") or "")
            relayed = relay_audio(self.args, peer, str(answer.get("audio") or "")) if self.args.relay else False
            log(f"asked {peer.get('name')}: {text[:60]!r} -> reply={reply[:60]!r} relayed={relayed}")
            record(self.args.name, text, reply)
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
            who = str(body.get("id") or self.client_address[0])[:64]
            with LOCK_TURNS:
                # Keyed on the caller's id: a self-declared name is free to change, and a
                # rename used to reset the cap. The window makes the cap per conversation.
                now = time.time()
                turns, last = TURNS.get(who, (0, 0.0))
                if now - last > TURN_WINDOW:
                    turns = 0
                if turns >= self.args.max_turns:
                    log(f"turn cap reached for {frm}; not answering")
                    return self._json({"ok": True, "reply": "", "audio": "", "capped": True})
                TURNS[who] = (turns + 1, now)
            reply, audio = ask_agent(self.args, frm, text)
            # Log the number, not a verdict: tomorrow's third-voice test should yield a
            # distribution of real scores rather than "it felt like an echo".
            log(f"echo score vs {frm}: {echo_score(reply, text):.2f} (cut 0.75)")
            if reply and echoes_input(reply, text):
                log(f"{frm} got an echo back ({reply[:50]!r}); asking once more")
                reply, audio = ask_agent(self.args, frm,
                                          text + "\n(Do not repeat my words. Say what you think.)")
                if reply and echoes_input(reply, text):
                    log("still an echo; refusing to return it")
                    reply, audio = "", ""
            log(f"answered {frm}: {reply[:70]!r} audio={audio or 'none'}")
            return self._json({"ok": True, "reply": reply, "audio": audio})

        return self._json({"error": "not found"}, 404)


TURNS: dict[str, tuple[int, float]] = {}
TURN_WINDOW = 300.0        # silence that ends a conversation
LOCK_TURNS = threading.Lock()


def read_token(path: str) -> str:
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError as exc:
        log(f"token unreadable ({exc}); face calls will 401")
        return ""


def read_key(path: str) -> str:
    """The LAN-wide peer key: read it, or create one on first start.

    Every face on the LAN must hold the same value — copy this file to the other machine. Without
    it, /ask would let anyone on the network make this face speak and spend its agent turns.
    """
    try:
        key = open(path, encoding="utf-8").read().strip()
        if len(key) >= 16:
            return key
    except OSError:
        pass
    import secrets as _secrets
    key = _secrets.token_hex(24)
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(key + "\n")
        log(f"generated a peer key at {path}; copy it to the other faces")
    except OSError as exc:
        log(f"cannot write the peer key ({exc}); peer calls will refuse")
    return key


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
    ap.add_argument("--key-file", default=os.path.expanduser("~/.local/share/hermes-face/peer.key"),
                    help="shared LAN peer key (created on first start, 0600)")
    ap.add_argument("--audio-dir", default=os.path.expanduser("~/.local/share/hermes-face/audio"))
    ap.add_argument("--greet", default="Hello, {name}. I can see you.")
    ap.add_argument("--relay", action="store_true",
                    help="play the peer's audio here (off by default: the addressed face answers "
                         "on its own machine, and both faces are in the room)")
    ap.add_argument("--config-file", default=None,
                    help="peering.json holding this face's name and aliases (default: beside audio/)")
    ap.add_argument("--auto-reply", action="store_true", help="answer an incoming line with an agent turn")
    ap.add_argument("--max-turns", type=int, default=12,
                    help="answers per peer per conversation window; a 3-round debate spends 3, "
                         "so 6 let two debates inside one window hit the cap")
    ap.add_argument("--reply-timeout", type=float, default=60.0)
    args = ap.parse_args()
    if args.beacon_send_port is None:
        args.beacon_send_port = args.beacon_port
    args.token = read_token(args.token_file)
    global PEER_KEY
    PEER_KEY = read_key(args.key_file)
    args.audio_dir = Path(os.path.expanduser(args.audio_dir))
    args.name, args.aliases = load_identity(args)

    book = Book()
    stop = threading.Event()
    Handler.args = args
    Handler.book = book

    threading.Thread(target=beacon_loop, args=(args, stop), daemon=True).start()
    threading.Thread(target=listen_loop, args=(args, book, stop), daemon=True).start()

    class FastServer(ThreadingHTTPServer):
        # HTTPServer.server_bind() calls socket.getfqdn(); with a slow resolver the port stays
        # closed for seconds while the process looks healthy. The name is never used.
        def server_bind(self):
            import socketserver
            socketserver.TCPServer.server_bind(self)
            host, port = self.server_address[:2]
            self.server_name = host
            self.server_port = port

    httpd = FastServer(("", args.port), Handler)
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
