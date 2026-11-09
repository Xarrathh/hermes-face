#!/usr/bin/env python3
"""Pin the addressing rules: who a sentence is for, and whether it is a debate.

Four behaviours decide how Pierre's words travel, and each one has cost a round of debugging when
it was wrong:

  * "argue with Suzie about X" is a debate  -> routed to Suzie, 3 rounds
  * "Suzie, what about X?"                  -> routed, 1 round, address stripped
  * "ask Suzie about X"                     -> routed, 1 round, "about" stripped
  * "I will not tell Suzie anything"        -> NOT routed: a negation is a statement about her

    python3 peering/test_routing.py        # exit 0 = all four behave
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PEERS = [{"id": "face-suzie", "name": "Suzie", "present": True, "aliases": ["suzie", "suzie q"]}]
ME = ["Pro-Pierre", "pro-pierre"]

CASES = [
    ("argue with Suzie about whether relief can produce growth", True, 3, "whether relief can produce growth"),
    ("Suzie, what about growth?", True, 1, "what about growth?"),
    ("ask Suzie about the weather", True, 1, "the weather"),
    ("I will not tell Suzie anything", False, 1, ""),
    ("what is the weather like here?", False, 1, ""),
]


def main() -> int:
    spec = importlib.util.spec_from_file_location("face_peer", HERE / "face_peer.py")
    assert spec and spec.loader, "cannot load peering/face_peer.py"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    failures = 0
    for text, want_route, want_rounds, want_rest in CASES:
        peer, rest = mod.route_target(text, PEERS, ME)
        routed = peer is not None
        rounds = mod.debate_rounds(text, (peer or {}).get("name", ""))
        ok = routed == want_route and rounds == want_rounds and (not routed or rest == want_rest)
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} route={routed!s:5s} rounds={rounds} rest={rest!r}  <- {text}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} routing cases behaved")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
