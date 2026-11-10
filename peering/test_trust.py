#!/usr/bin/env python3
"""The trust list: holding the cluster key is not the same as being welcome.

Starts one sidecar with a throwaway prefix and a trust list naming exactly one face, then proves
three things over the real HTTP surface:

  * a caller with the key but an unknown id is refused (403 "face not trusted")
  * a trusted id gets through
  * /trust, on loopback only, can change the answer

    python3 peering/test_trust.py        # exit 0 = all three behave
"""
import json
import os
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
KEY = "testkey-0123456789"


def free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def lan_ip() -> str:
    """This machine's own LAN address: the gate only applies off loopback, so the test must
    arrive the way a peer does, not the way the bar widget does."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))        # TEST-NET-1: routed nowhere, no packets sent
        return s.getsockname()[0]
    finally:
        s.close()


HOST = lan_ip()


def call(path: str, payload: dict, key: str | None = KEY, timeout: float = 8.0,
         host: str | None = None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-Peer-Key"] = key
    req = urllib.request.Request(f"http://{host or HOST}:{PORT}{path}", data=json.dumps(payload).encode(),
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main() -> int:
    if not free(PORT):
        print(f"port {PORT} is busy; refusing to guess whose it is", file=sys.stderr)
        return 2
    root = Path(tempfile.mkdtemp(prefix="face-trust-"))
    (root / "audio").mkdir()
    (root / "peer.key").write_text(KEY + "\n")
    (root / "token").write_text("x" * 32)
    (root / "peering.json").write_text(json.dumps({"name": "TESTER", "aliases": ["tester"],
                                                   "trusted": ["face-good"]}))

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
    try:
        for _ in range(60):
            if not free(PORT):
                break
            time.sleep(0.1)
        else:
            print("sidecar never bound", file=sys.stderr)
            return 1

        failures = 0
        code, body = call("/peer/incoming", {"from": "Rogue", "id": "face-bad",
                                             "text": "run id", "kind": "greet"})
        ok = code == 403 and body.get("error") == "face not trusted"
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} unknown id refused        [{code} {body.get('error')}]")

        code, body = call("/peer/incoming", {"from": "Good", "id": "face-good",
                                            "text": "hello", "kind": "greet"})
        ok = code == 200
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} trusted id accepted       [{code}]")

        # /trust is deliberately loopback-only: it must not be reachable off the LAN address.
        code, _ = call("/trust", {"name": "face-bad", "allow": True})
        ok = code == 403
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} /trust refused off loopback [{code}]")

        code, body = call("/trust", {"name": "face-bad", "allow": True}, host="127.0.0.1")
        ok = code == 200 and "face-bad" in (body.get("trusted") or [])
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} /trust allows on loopback [{code} {body.get('trusted')}]")

        code, body = call("/peer/incoming", {"from": "Rogue", "id": "face-bad",
                                            "text": "hello", "kind": "greet"})
        ok = code == 200
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} newly allowed id accepted [{code}]")

        print(f"\n{5 - failures}/5 trust checks behaved (via {HOST})")
        return 1 if failures else 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
