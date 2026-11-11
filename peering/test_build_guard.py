#!/usr/bin/env python3
"""A peer that advertises no build is not a peer that passed the check.

Suzie ran a sidecar two protocol generations behind the repo. Her beacon carried no `build`, so
the old guard — `if peer.get("build") and peer["build"] != BUILD` — skipped the mismatch check
entirely and logged nothing about it, for hours, while every cross-face test in the repo was
being read as evidence. Silence read as agreement.

This proves the three cases the guard now distinguishes, and that all three still end up
registered — the guard warns, it never drops a peer:

  * no build advertised        -> BUILD UNVERIFIED, named, with this face's build
  * a different build          -> BUILD MISMATCH, with both builds
  * the same build             -> neither line

    python3 peering/test_build_guard.py        # exit 0 = the silence is gone

Needs no LAN: three beacons are injected over 127.0.0.1 UDP, exactly as discovery receives them.
"""
import hashlib
import json
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR = HERE / "face_peer.py"
PORT = 19930
BEACON_PORT = 19931
# The build the sidecar computes for itself: sha256 of its own file, first 12 hex chars.
BUILD = hashlib.sha256(SIDECAR.read_bytes()).hexdigest()[:12]


def free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def beacon(payload: dict) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.sendto(json.dumps(payload).encode(), ("127.0.0.1", BEACON_PORT))


def main() -> int:
    if not free(PORT) or not free(BEACON_PORT):
        print(f"port {PORT} or {BEACON_PORT} is busy; refusing to guess whose it is", file=sys.stderr)
        return 2
    root = Path(tempfile.mkdtemp(prefix="face-build-"))
    (root / "audio").mkdir()
    (root / "peer.key").write_text("unused-key-material\n")
    (root / "token").write_text("x" * 32)
    (root / "peering.json").write_text(json.dumps({"name": "TESTER", "aliases": ["tester"]}))
    out = root / "sidecar.log"

    with out.open("wb") as logfile:
        proc = subprocess.Popen([sys.executable, str(SIDECAR),
                                 "--name", "TESTER", "--id", "face-tester",
                                 "--port", str(PORT), "--beacon-port", str(BEACON_PORT),
                                 "--beacon-send", "127.0.0.1", "--beacon-send-port", str(BEACON_PORT),
                                 "--face-url", "http://127.0.0.1:1",
                                 "--token-file", str(root / "token"),
                                 "--key-file", str(root / "peer.key"),
                                 "--audio-dir", str(root / "audio"),
                                 "--config-file", str(root / "peering.json")],
                                stdout=logfile, stderr=subprocess.STDOUT)
    failures = 0
    try:
        for _ in range(80):
            if not free(PORT):
                break
            time.sleep(0.1)
        else:
            print("sidecar never bound", file=sys.stderr)
            return 1

        beacon({"id": "face-nobuild", "name": "NoBuild", "port": 1,
                "face": "http://127.0.0.1:1"})
        beacon({"id": "face-stale", "name": "Stale", "port": 1,
                "face": "http://127.0.0.1:1", "build": "deadbeef0000"})
        beacon({"id": "face-same", "name": "Same", "port": 1,
                "face": "http://127.0.0.1:1", "build": BUILD})
        # Discovery polls the UDP socket on a one-second timeout; give it two passes.
        time.sleep(2.5)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    log = out.read_text(errors="replace")
    checks = []

    unverified = [ln for ln in log.splitlines() if "BUILD UNVERIFIED" in ln]
    ok = len(unverified) == 1 and "NoBuild" in unverified[0] and BUILD in unverified[0]
    checks.append(("a peer with no build is named, not waved through", ok,
                   unverified[0] if unverified else "no BUILD UNVERIFIED line"))

    mismatch = [ln for ln in log.splitlines() if "BUILD MISMATCH" in ln]
    ok = len(mismatch) == 1 and "Stale" in mismatch[0] and "deadbeef0000" in mismatch[0]
    checks.append(("a different build still reports both builds", ok,
                   mismatch[0] if mismatch else "no BUILD MISMATCH line"))

    quiet = not any("Same" in ln for ln in unverified + mismatch)
    seen_same = any("peer present: Same" in ln and BUILD in ln for ln in log.splitlines())
    ok = quiet and seen_same
    checks.append(("a matching build warns about nothing", ok,
                   f"quiet={quiet} registered={seen_same}"))

    registered = [n for n in ("NoBuild", "Stale", "Same") if f"peer present: {n}" in log]
    ok = len(registered) == 3
    checks.append(("the guard warns and never drops a peer", ok, f"registered={registered}"))

    for label, ok, detail in checks:
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {label:<48} [{detail}]")
    print(f"\n{len(checks) - failures}/{len(checks)} build-guard checks behaved (this face runs {BUILD})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
