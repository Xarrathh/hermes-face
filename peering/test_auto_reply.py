#!/usr/bin/env python3
"""`--auto-reply` is the switch between a face that answers and a face that only says 200.

An inbound `/peer/incoming` with kind "talk" returned `{"ok": true, "reply": ""}` on every box that
was installed by the plugin's unit template, and the caller read the empty string as the other agent
having nothing to say. The template writes `--relay` and omits `--auto-reply`, and `--auto-reply` is
`store_true`, so the default is off: `face_peer.py` returns before any turn can run.

This asserts the three behaviours that line decides, against a stub face that records every `/say`:

  * `--auto-reply` set   -> an inbound talk reaches the face (/say is called)
  * `--auto-reply` unset -> it does not, and the caller still gets 200 with an empty reply
  * a "greet" never reaches the face, with or without the flag

    python3 peering/test_auto_reply.py        # exit 0 = the flag really is the switch

No LAN needed: stub face and sidecar both live on 127.0.0.1, and loopback is trusted by the key gate.
"""
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR = HERE / "face_peer.py"
SAY_CALLS: list[str] = []
LOCK = threading.Lock()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


class StubFace(BaseHTTPRequestHandler):
    """The four bridge routes ask_agent uses, with /say recorded and answered."""

    def log_message(self, *args, **kwargs) -> None:   # keep the test output clean
        pass

    def _json(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:               # noqa: N802
        if self.path.startswith("/health"):
            return self._json({"ok": True, "agent": True})
        if self.path.startswith("/state"):
            # Deliberately idle with no reply: the turn never completes, which is fine — the test
            # asks whether a turn was started, not what it said.
            return self._json({"agent": "idle", "reply": "", "audio": "", "audio_parts": [],
                               "seq": 0, "heard": "", "mood": "curious"})
        return self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:              # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if self.path.startswith("/say"):
            try:
                text = json.loads(raw or b"{}").get("text", "")
            except json.JSONDecodeError:
                text = ""
            with LOCK:
                SAY_CALLS.append(text)
            return self._json({"ok": True, "seq": 1})
        if self.path.startswith("/speak"):
            return self._json({"ok": True})
        return self._json({"error": "not found"}, 404)


def start_sidecar(auto_reply: bool, face_url: str, port: int, root: Path) -> subprocess.Popen:
    args = [sys.executable, str(SIDECAR),
            "--name", "TESTER", "--id", "face-tester",
            "--port", str(port),
            "--beacon-port", str(port + 1), "--beacon-send", "127.0.0.1",
            "--beacon-send-port", str(port + 1),
            "--face-url", face_url,
            "--token-file", str(root / "token"),
            "--key-file", str(root / "peer.key"),
            "--audio-dir", str(root / "audio"),
            "--config-file", str(root / "peering.json"),
            "--reply-timeout", "3"]
    if auto_reply:
        args.append("--auto-reply")
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_up(port: int, seconds: float = 10.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not free(port):
            return True
        time.sleep(0.1)
    return False


def incoming(port: int, kind: str) -> tuple[int, dict]:
    body = json.dumps({"from": "Peer", "id": "face-peer", "text": "one sentence, please",
                       "kind": kind}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/peer/incoming", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="face-autoreply-"))
    (root / "audio").mkdir()
    (root / "token").write_text("x" * 32)
    (root / "peer.key").write_text("unused-key-material\n")
    (root / "peering.json").write_text(json.dumps({"name": "TESTER", "aliases": ["tester"]}))

    stub = ThreadingHTTPServer(("127.0.0.1", 0), StubFace)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    face_url = f"http://127.0.0.1:{stub.server_address[1]}"

    checks = []
    ports = [free_port(), free_port()]
    procs = []
    try:
        # 1. with the flag
        with LOCK:
            SAY_CALLS.clear()
        p = start_sidecar(True, face_url, ports[0], root)
        procs.append(p)
        if not wait_up(ports[0]):
            print("sidecar with --auto-reply never bound", file=sys.stderr)
            return 1
        code, body = incoming(ports[0], "talk")
        for _ in range(60):
            with LOCK:
                if SAY_CALLS:
                    break
            time.sleep(0.1)
        with LOCK:
            calls = list(SAY_CALLS)
        checks.append(("with --auto-reply an inbound talk reaches the face", bool(calls),
                       f"code={code} /say calls={len(calls)} first={calls[0][:60] if calls else ''!r}"))

        # 2. without the flag, same request
        with LOCK:
            SAY_CALLS.clear()
        p2 = start_sidecar(False, face_url, ports[1], root)
        procs.append(p2)
        if not wait_up(ports[1]):
            print("sidecar without --auto-reply never bound", file=sys.stderr)
            return 1
        code2, body2 = incoming(ports[1], "talk")
        time.sleep(2.0)                      # long enough for a turn to have been started
        with LOCK:
            calls2 = list(SAY_CALLS)
        checks.append(("without it the reply is empty and no turn runs",
                       code2 == 200 and body2.get("reply") == "" and not calls2,
                       f"code={code2} reply={body2.get('reply')!r} /say calls={len(calls2)}"))

        # 3. a greet is never a conversation, flag or not
        with LOCK:
            SAY_CALLS.clear()
        code3, _ = incoming(ports[0], "greet")
        time.sleep(1.5)
        with LOCK:
            calls3 = list(SAY_CALLS)
        checks.append(("a greet never starts a turn, even with the flag on",
                       code3 == 200 and not calls3, f"code={code3} /say calls={len(calls3)}"))
    finally:
        for p in procs:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        stub.shutdown()

    failures = 0
    for label, ok, detail in checks:
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {label:<55} [{detail}]")
    print(f"\n{len(checks) - failures}/{len(checks)} auto-reply checks behaved")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
