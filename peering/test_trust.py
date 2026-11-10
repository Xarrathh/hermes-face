#!/usr/bin/env python3
"""Automatic by default, a list for when you want one.

The design Pierre asked for: two faces on one network find each other and talk, with no key to
copy and no pairing. The voice greeting is the announcement; the list is the optional security
control. This proves the four behaviours that decide whether that is true:

  * a face nobody configured is answered (automatic), and recorded in `seen`
  * `block` refuses it with 403
  * `allow` brings it back
  * the list can only be changed on this machine (loopback), never off the LAN

    python3 peering/test_trust.py        # exit 0 = all four behave
"""
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = 19920


def lan_ip() -> str:
    """The gate only applies off loopback, so the test must arrive the way a peer does."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))        # TEST-NET-1: routed nowhere, no packets sent
        return s.getsockname()[0]
    finally:
        s.close()


HOST = lan_ip()


def free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def call(path: str, payload: dict, timeout: float = 8.0, host: str | None = None):
    req = urllib.request.Request(f"http://{host or HOST}:{PORT}{path}",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main() -> int:
    if not free(PORT):
        print(f"port {PORT} is busy; refusing to guess whose it is", file=sys.stderr)
        return 2
    root = Path(tempfile.mkdtemp(prefix="face-auto-"))
    (root / "audio").mkdir()
    (root / "peer.key").write_text("unused-key-material\n")
    (root / "token").write_text("x" * 32)
    (root / "peering.json").write_text(json.dumps({"name": "TESTER", "aliases": ["tester"]}))

    proc = subprocess.Popen([sys.executable, str(HERE / "face_peer.py"),
                             "--name", "TESTER", "--id", "face-tester",
                             "--port", str(PORT), "--beacon-port", "19921",
                             "--beacon-send", "127.0.0.1", "--beacon-send-port", "19921",
                             "--face-url", "http://127.0.0.1:1",
                             "--token-file", str(root / "token"),
                             "--key-file", str(root / "peer.key"),
                             "--audio-dir", str(root / "audio"),
                             "--config-file", str(root / "peering.json")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    failures = 0
    try:
        for _ in range(80):
            if not free(PORT):
                break
            time.sleep(0.1)
        else:
            print("sidecar never bound", file=sys.stderr)
            return 1

        code, _ = call("/peer/incoming", {"from": "New", "id": "face-new", "text": "hi",
                                          "kind": "greet"})
        cfg = json.loads((root / "peering.json").read_text())
        seen = [s.split("|")[0] for s in cfg.get("seen") or []]
        ok = code == 200 and "face-new" in seen
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} an unpaired face is answered and recorded [{code}, seen={seen}]")

        call("/trust", {"id": "face-new", "block": True}, host="127.0.0.1")
        code, body = call("/peer/incoming", {"from": "New", "id": "face-new", "text": "hi",
                                             "kind": "greet"})
        ok = code == 403 and body.get("error") == "face blocked"
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} block refuses it                [{code} {body.get('error')}]")

        call("/trust", {"id": "face-new", "allow": True}, host="127.0.0.1")
        code, _ = call("/peer/incoming", {"from": "New", "id": "face-new", "text": "hi",
                                          "kind": "greet"})
        ok = code == 200
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} allow brings it back            [{code}]")

        code, _ = call("/trust", {"id": "face-new", "block": True})
        ok = code == 403
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} the list is loopback-only       [{code}]")

        print(f"\n{4 - failures}/4 automatic-mode checks behaved (via {HOST})")
        return 1 if failures else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
