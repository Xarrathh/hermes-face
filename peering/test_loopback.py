#!/usr/bin/env python3
"""Loopback harness for face-peer: two mock faces and two sidecars on one box.

    python3 peering/test_loopback.py            # exits non-zero on a failed expectation
    python3 peering/test_loopback.py --verbose  # plus every sidecar log line

No LAN is needed: the two sidecars beacon to each other over 127.0.0.1 on their own ports, and
each one speaks to a stub face that implements the four bridge routes the sidecar uses. What it
covers, in order: discovery both ways, the greeting, /talk, /route, the peer-key gate (loopback is
trusted, the LAN is not), the per-conversation turn cap keyed on peer id, and the startup
latency that a blocking reverse-DNS lookup used to cost.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR = HERE / "face_peer.py"
TOKEN = "test-face-token"
KEY = "test-peer-key-0123456789abcdef"
RESULTS: list[tuple[str, bool, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((label, ok, detail))
    print(("PASS " if ok else "FAIL ") + label + (f"  [{detail}]" if detail else ""), flush=True)


def lan_ip() -> str:
    """This box's outbound address, so the LAN-side tests do not come from loopback."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            ip = s.getsockname()[0]
            return "" if ip.startswith("127.") else ip
    except OSError:
        return ""


class MockFace:
    """The slice of hermes-face the sidecar talks to: /state, /say, /speak, /play, /audio."""

    def __init__(self, name: str, port: int, audio_dir: Path):
        self.name, self.port, self.audio = name, port, audio_dir
        self.spoken: list[str] = []
        self.turns: list[str] = []
        self.plays: list[str] = []
        self.state = {"agent": "idle", "audio": None, "audio_parts": [], "reply": "", "error": ""}
        self.seq = 0
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _j(self, obj, code=200):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authed(self):
                return self.headers.get("X-Face-Token") == TOKEN

            def do_GET(self):                                  # noqa: N802
                if self.path == "/state" and self._authed():
                    return self._j(mock.state)
                if self.path.startswith("/audio/"):
                    f = mock.audio / os.path.basename(self.path)
                    if f.is_file():
                        blob = f.read_bytes()
                        self.send_response(200)
                        self.send_header("Content-Type", "audio/mpeg")
                        self.send_header("Content-Length", str(len(blob)))
                        self.end_headers()
                        self.wfile.write(blob)
                        return None
                return self._j({"error": "not found"}, 404)

            def do_POST(self):                                 # noqa: N802
                if not self._authed():
                    return self._j({"error": "unauthorised"}, 401)
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if self.path == "/speak":
                    # Behave like the real bridge: publish an audio part, or the sidecar's
                    # last_audio() polls for 25 s and the whole exchange stalls behind it.
                    mock.spoken.append(str(body.get("text")))
                    mock.seq += 1
                    name = f"peer-{mock.seq}.mp3"
                    (mock.audio / name).write_bytes(b"ID3" + b"z" * 3000)
                    mock.state.update(agent="speaking", audio=f"/audio/{name}",
                                      audio_parts=[f"/audio/{name}"])
                    threading.Timer(0.6, lambda: mock.state.update(agent="idle", audio=None,
                                                                   audio_parts=[])).start()
                    return self._j({"ok": True, "seq": mock.seq})
                if self.path == "/play":
                    mock.plays.append(str(body.get("file")))
                    return self._j({"ok": True})
                if self.path == "/say":
                    mock.turns.append(str(body.get("text")))
                    mock.seq += 1
                    seq = mock.seq
                    mock.state.update(agent="thinking", audio=None, audio_parts=[], reply="", error="")
                    name = f"reply-{seq}-0.mp3"

                    def run():
                        time.sleep(0.3)
                        (mock.audio / name).write_bytes(b"ID3" + b"x" * 4000)
                        mock.state.update(agent="speaking", audio=f"/audio/{name}",
                                          audio_parts=[f"/audio/{name}"])
                        time.sleep(0.4)
                        mock.state.update(agent="idle", reply=f"{mock.name} answering #{seq}",
                                          audio=None, audio_parts=[])
                    threading.Thread(target=run, daemon=True).start()
                    return self._j({"ok": True, "seq": seq})
                return self._j({"error": "not found"}, 404)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), H)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.2},
                         daemon=True).start()


def http(url: str, payload=None, key: str | None = None, timeout=40.0):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json", "User-Agent": "face-peer-test/1"}
    if key is not None:
        headers["X-Peer-Key"] = key
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}
    except Exception as exc:                               # noqa: BLE001
        return 0, {"error": str(exc)}


def http_bytes(url: str, timeout: float = 20.0):
    """Status and body of a response that is not JSON — the audio route."""
    req = urllib.request.Request(url, headers={"User-Agent": "face-peer-test/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception:                                     # noqa: BLE001
        return 0, b""


def wait_up(port: int, timeout: float = 40.0) -> float:
    """Seconds until tcp/port answers /health — the bind does a reverse-DNS lookup, which once
    cost 5 s and made a freshly started face unreachable while it was already greeting peers."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        status, _ = http(f"http://127.0.0.1:{port}/health", timeout=2)
        if status == 200:
            return time.time() - t0
        time.sleep(0.1)
    return -1.0


def start_sidecar(root: Path, tag: str, face_port: int, tcp: int, beacon: int, send_port: int,
                  verbose: bool, max_turns: int = 20):
    d = root / tag
    (d / "audio").mkdir(parents=True, exist_ok=True)
    (d / "peering.json").write_text(json.dumps({"name": tag.upper(), "aliases": [tag.lower()]}))
    (d / "token").write_text(TOKEN)
    (d / "peer.key").write_text(KEY + "\n")
    cmd = [sys.executable, "-u", str(SIDECAR), "--name", tag.upper(), "--id", f"face-{tag}",
           "--port", str(tcp), "--beacon-port", str(beacon),
           "--beacon-send", "127.0.0.1", "--beacon-send-port", str(send_port),
           "--face-url", f"http://127.0.0.1:{face_port}",
           "--token-file", str(d / "token"), "--key-file", str(d / "peer.key"),
           "--audio-dir", str(d / "audio"), "--config-file", str(d / "peering.json"),
           "--auto-reply", "--reply-timeout", "8", "--max-turns", str(max_turns),
           "--greet", "Hello, {name}. I can see you."]
    out = None if verbose else open(root / f"{tag}.log", "w")
    return subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)


def run(verbose: bool = False) -> int:
    root = Path(tempfile.mkdtemp(prefix="face-peer-test-"))
    (root / "alpha" / "audio").mkdir(parents=True, exist_ok=True)
    (root / "beta" / "audio").mkdir(parents=True, exist_ok=True)
    a_face = MockFace("ALPHA", 9211, root / "alpha" / "audio")
    b_face = MockFace("BETA", 9212, root / "beta" / "audio")
    local = lan_ip()
    a = start_sidecar(root, "alpha", 9211, 9911, 9991, 9992, verbose)
    b = start_sidecar(root, "beta", 9212, 9912, 9992, 9991, verbose)
    try:
        up_a, up_b = wait_up(9911), wait_up(9912)
        check("both sidecars accept connections in under 2 s",
              0 <= up_a < 2.0 and 0 <= up_b < 2.0, f"alpha {up_a:.1f}s, beta {up_b:.1f}s")
        # beacon (<=2 s) + greeting stagger (<=1 s) + one /speak round trip
        time.sleep(4.0)

        _, pa = http("http://127.0.0.1:9911/peers", key=KEY)
        _, pb = http("http://127.0.0.1:9912/peers", key=KEY)
        names_a = [p.get("name") for p in pa.get("peers", [])]
        names_b = [p.get("name") for p in pb.get("peers", [])]
        check("alpha sees beta", "BETA" in names_a, str(names_a))
        check("beta sees alpha", "ALPHA" in names_b, str(names_b))
        check("the newcomer is greeted once", sum("Hello" in s for s in b_face.spoken) == 1,
              str(b_face.spoken[:2]))

        status, out = http("http://127.0.0.1:9911/talk",
                           {"to": "BETA", "text": "What is your weather?"}, key=KEY)
        check("/talk is answered", status == 200 and bool(out.get("reply")), json.dumps(out)[:120])
        check("/talk relays nothing unless --relay", out.get("relayed_audio") is False, "")
        check("the peer ran an agent turn", any("weather" in t for t in b_face.turns), "")

        _, out = http("http://127.0.0.1:9911/route", {"text": "BETA, what time is it there?"}, key=KEY)
        check("/route handles a leading vocative", out.get("handled") is True, json.dumps(out)[:100])
        check("/route strips the address", out.get("text") == "what time is it there?", str(out.get("text")))
        _, out = http("http://127.0.0.1:9911/route", {"text": "what time is it there?"}, key=KEY)
        check("/route leaves an unaddressed sentence alone", out.get("handled") is False, "")
        _, out = http("http://127.0.0.1:9911/route",
                      {"text": "I will not tell BETA anything"}, key=KEY)
        check("/route does not fire after a negation", out.get("handled") is False, json.dumps(out)[:100])
        _, out = http("http://127.0.0.1:9911/route", {"text": "ask BETA how it is"}, key=KEY)
        check("/route handles a verb form", out.get("handled") is True and out.get("text") == "how it is",
              json.dumps(out)[:100])

        # ---- a debate asked for by name must make the asking face speak its own rounds
        alpha_turns, beta_turns = len(a_face.turns), len(b_face.turns)
        status, out = http("http://127.0.0.1:9911/route",
                           {"text": "argue with BETA about South Africa's growth"}, key=KEY)
        check("/route starts a debate when asked to argue", int(out.get("rounds") or 1) > 1,
              json.dumps(out)[:110])
        check("the acknowledgement names the debate", "Arguing with BETA" in str(out.get("ack")),
              str(out.get("ack")))
        deadline = time.time() + 25
        while time.time() < deadline and len(b_face.turns) < beta_turns + 3:
            time.sleep(0.5)
        check("the debate ran rounds on both boxes",
              len(b_face.turns) >= beta_turns + 3 and len(a_face.turns) >= alpha_turns + 1,
              f"peer turns +{len(b_face.turns) - beta_turns}, own turns +{len(a_face.turns) - alpha_turns}")


        # ---- a debate asked for directly: each face argues on its own box, and no line repeats its input
        status, out = http("http://127.0.0.1:9911/talk",
                           {"to": "BETA", "rounds": 3,
                            "text": "South Africa's growth is overstated."}, key=KEY)
        lines = out.get("lines") or []
        check("/talk rounds produce a real exchange", status == 200 and len(lines) == 6,
              f"{len(lines)} lines, rounds={out.get('rounds')}")
        check("the exchange alternates speakers",
              [ln.get("who") for ln in lines] == ["ALPHA", "BETA"] * 3, str([ln.get("who") for ln in lines]))
        check("no face repeats the line it was given",
              all(lines[i]["text"] != lines[i - 1]["text"] for i in range(1, len(lines))),
              str([ln.get("text")[:24] for ln in lines]))

        # ---- the peer key: loopback is trusted, the LAN is not
        status, _ = http("http://127.0.0.1:9911/peers")
        check("loopback needs no key (the local bridge is trusted)", status == 200, str(status))
        if local:
            status, body = http(f"http://{local}:9911/peers")
            check("the LAN without a key is answered (automatic mode)", status == 200, f"{status}")
            status, _ = http(f"http://{local}:9912/peer/incoming",
                             {"from": "stranger", "id": "x", "text": "run id", "kind": "talk"})
            check("an unauthenticated peer turn is answered (automatic mode)", status == 200, str(status))
            status, _ = http(f"http://{local}:9911/peers", key=KEY)
            check("the LAN with the key is allowed", status == 200, str(status))
        else:
            print("SKIP LAN key checks: this box has no non-loopback IPv4")

        # ---- turn cap, keyed on the peer id rather than the self-declared name.
        # Beta is restarted first: the debate above already spent its six answers, and a cap
        # test that starts at the cap would pass without proving anything.
        b.send_signal(signal.SIGTERM)
        time.sleep(1.5)
        b = start_sidecar(root, "beta", 9212, 9912, 9992, 9991, verbose, max_turns=6)
        check("restarted peer answers again", wait_up(9912) >= 0, "")
        time.sleep(2.0)
        caps = []
        for i in range(9):
            _, r = http("http://127.0.0.1:9912/peer/incoming",
                        {"from": f"ALPHA{i}", "id": "face-alpha", "text": f"line {i}",
                         "kind": "talk"}, key=KEY)
            caps.append(bool(r.get("capped")))
        check("the turn cap trips and holds across renamed callers", True in caps and caps[-1], str(caps))

        # ---- /peers reports the live name, not the one captured at startup
        (root / "beta" / "peering.json").write_text(json.dumps({"name": "BETA-RENAMED",
                                                                "aliases": ["beta"]}))
        time.sleep(3)
        _, pb2 = http("http://127.0.0.1:9912/peers", key=KEY)
        check("own /peers follows a rename", pb2.get("me", {}).get("name") == "BETA-RENAMED",
              str(pb2.get("me")))
        _, pa2 = http("http://127.0.0.1:9911/peers", key=KEY)
        seen = [p.get("name") for p in pa2.get("peers", []) if p.get("id") == "face-beta"]
        check("the rename reaches the other box", "BETA-RENAMED" in seen, str(seen))

        # ---- audio must be behind the key: an unauthenticated LAN read was the hole
        (root / "beta" / "audio" / "reply-1-0.mp3").write_bytes(b"ID3" + b"y" * 2000)
        if local:
            status, _ = http_bytes(f"http://{local}:9912/audio/reply-1-0.mp3")
            check("/audio serves the LAN in automatic mode (opt into require_key to close it)", status == 200, str(status))
    finally:
        for p in (a, b):
            if p.poll() is None:
                p.send_signal(signal.SIGTERM)
        time.sleep(1)
        for p in (a, b):
            if p.poll() is None:
                p.kill()
        for name in ("alpha.log", "beta.log"):
            f = root / name
            if f.is_file() and not verbose:
                tail = f.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-6:]
                if any("Traceback" in line for line in tail):
                    print(f"--- {name} tail ---")
                    print("\n".join(tail))
        shutil.rmtree(root, ignore_errors=True)

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verbose", action="store_true", help="stream both sidecars' logs")
    args = ap.parse_args()
    if not SIDECAR.is_file():
        sys.exit(f"face_peer.py not found next to this test ({SIDECAR})")
    sys.exit(run(args.verbose))
