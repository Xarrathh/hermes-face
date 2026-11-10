#!/usr/bin/env python3
"""Mint a cluster key and hand it to another box as a short code, without copying files.

    python3 peering/face_pair.py mint                # 6 groups, e.g. K7Q2M-9XBR4-...
    python3 peering/face_pair.py join K7Q2M-9XBR4-...  # writes peer.key here
    python3 peering/face_pair.py show                 # the code for the key already here

Why a code and not a file: the key must never be published (the repo is public) and `scp`
needs sshd running on the receiving box. A code is something a person can read off a screen
and type once, which is the actual requirement for "install a new PC".

The key is 128 bits of randomness in base32 — 26 characters, six groups of five with the last
group short. Grouping is cosmetic: `join` accepts it with or without dashes and with any case.
"""
from __future__ import annotations

import base64
import os
import secrets
import sys
from pathlib import Path

DEFAULT_KEY = Path(os.path.expanduser("~/.local/share/hermes-face/peer.key"))
KEY_BYTES = 16          # 128 bits, 26 base32 characters


def encode(raw: bytes) -> str:
    text = base64.b32encode(raw).decode().rstrip("=")
    return "-".join(text[i:i + 5] for i in range(0, len(text), 5))


def decode(code: str) -> bytes:
    clean = "".join(ch for ch in code.upper() if ch.isalnum())
    pad = "-" * ((-len(clean)) % 8)
    return base64.b32decode(clean + pad.replace("-", "="))


def write_key(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(raw.hex())          # stored as hex text: the sidecar reads it as a plain string
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def read_raw(path: Path) -> bytes | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        return bytes.fromhex(text)
    except ValueError:
        return text.encode()         # an older key: any string works, it is compared byte for byte


def main(argv: list[str]) -> int:
    key_path = Path(os.environ.get("HERMES_FACE_KEY", DEFAULT_KEY))
    cmd = argv[0] if argv else "show"

    if cmd == "mint":
        raw = secrets.token_bytes(KEY_BYTES)
        write_key(key_path, raw)
        print(encode(raw))
        print(f"\nwrote {key_path} — minting REPLACES the key, so every other box must join this code",
              file=sys.stderr)
        return 0

    if cmd == "join":
        if len(argv) < 2:
            print("join needs the code from the other box", file=sys.stderr)
            return 2
        try:
            raw = decode(" ".join(argv[1:]))
        except Exception as exc:                   # noqa: BLE001
            print(f"that is not a pairing code: {exc}", file=sys.stderr)
            return 2
        if len(raw) < 8:
            print("code decodes to something too short to be a key", file=sys.stderr)
            return 2
        write_key(key_path, raw)
        print(f"wrote {key_path} ({len(raw) * 8} bits) — restart face-peer to use it")
        return 0

    raw = read_raw(key_path)
    if raw is None:
        print(f"no key at {key_path}; run mint", file=sys.stderr)
        return 1
    if len(raw) == KEY_BYTES:
        print(encode(raw))
        return 0
    print(f"{key_path} holds {len(raw)} bytes, not a minted key — "
          f"mint a new one and join the others, or copy the file by hand", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
