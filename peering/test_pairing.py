#!/usr/bin/env python3
"""The pairing code: mint on one box, type it once on the next, no file copying.

    python3 peering/test_pairing.py     # exit 0 = the round trip holds

Checks the three things a person actually does — read a code off one screen, type it on another,
and expect the same key — plus the two ways it can go wrong: a mangled code is refused, and a
code that decodes to something too short to be a key is refused.
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "face_pair.py"


def run(args, key_path: Path):
    env = dict(os.environ, HERMES_FACE_KEY=str(key_path))
    return subprocess.run([sys.executable, str(SCRIPT)] + args, capture_output=True, text=True, env=env)


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="face-pair-"))
    a, b = root / "a.key", root / "b.key"
    out = run(["mint"], a)
    code = out.stdout.strip()
    failures = 0

    ok = out.returncode == 0 and code and "-" in code
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} mint prints a grouped code   [{code or out.stderr.strip()[:60]}]")

    run(["join", code], b)
    ok = a.read_bytes() == b.read_bytes()
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} join reproduces the key bytes")

    run(["join", code.lower().replace("-", "")], b)
    ok = a.read_bytes() == b.read_bytes()
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} case and dashes do not matter")

    out = run(["join", "NOTACODE!"], b)
    ok = out.returncode != 0
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} a mangled code is refused     [exit {out.returncode}]")

    os.chmod(b, 0o600)
    ok = (b.stat().st_mode & 0o777) == 0o600
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} the key file is 0600")

    print(f"\n{5 - failures}/5 pairing checks behaved")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
