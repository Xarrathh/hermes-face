#!/usr/bin/env python3
"""`unreachable` and `busy` must not be the same word.

A 40 s client timeout on a handoff to a live turn is a working bridge with a queue, not a dead
box. Both were reported as `unreachable`, which sent the operator to look at the network while
the answer was in the sequencer.

    python3 peering/test_reason.py     # exit 0 = each exception maps to the place you'd look
"""
import importlib.util
import socket
import sys
import urllib.error
from email.message import Message
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("face_peer", HERE / "face_peer.py")
assert spec and spec.loader, "cannot load peering/face_peer.py"
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)

CASES = [
    ("client timeout on a live turn", socket.timeout("timed out"), "busy"),
    ("handoff refused because a turn is running", urllib.error.HTTPError(
        "http://x/say", 409, "busy", Message(), None), "busy"),
    ("bridge overloaded", urllib.error.HTTPError("http://x/say", 503, "overloaded", Message(), None), "busy"),
    ("nothing listening", urllib.error.URLError(ConnectionRefusedError(111, "refused")), "unreachable"),
    ("host down", urllib.error.URLError(socket.timeout("timed out")), "busy"),
    ("a 500 from the bridge", urllib.error.HTTPError("http://x/say", 500, "boom", Message(), None), "http 500"),
]


def main() -> int:
    bad = 0
    for label, exc, want in CASES:
        got = fp.why_failed(exc)
        ok = got == want
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'} {label:44} -> {got!r} (want {want!r})")
    print(f"\n{len(CASES) - bad}/{len(CASES)} classifications correct")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
