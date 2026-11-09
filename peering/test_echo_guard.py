#!/usr/bin/env python3
"""Pin the echo-guard threshold to measured output instead of to taste.

These five strings are the cases that decided the number. Two are echoes, one is a summary of
the input (which reads as an echo on the wire), and two are legitimate answers that share the
topic but add a claim. The guard must refuse the first three and pass the last two.

The original guard used Jaccard >= 0.8 and scored the paraphrase echo **0.79** — it would have
returned the very answer it exists to refuse. Containment in the fuller direction separates them:
verbatim 1.00, paraphrase 0.92, summary 0.80, counterpoint 0.67, rebuttal 0.00.

    python3 peering/test_echo_guard.py        # exit 0 = all five behave
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
THRESHOLD = 0.75

CASES = [
    ("verbatim echo", "The rand weakened again overnight and inflation is still above target.",
     "The rand weakened again overnight and inflation is still above target.", True),
    ("paraphrase echo", "The weather today is sunny and twenty two degrees with no rain expected at all.",
     "Sunny and twenty two degrees here with no rain expected, so the weather today is fine.", True),
    ("summary echo", "Sunny, dry and warm where I am.",
     "The weather today is sunny and dry and warm with no rain expected at all.", True),
    ("blunt counterpoint", "Optimism ignores that load-shedding cost two points of GDP.",
     "Growth needs private capital, and load-shedding alone has cost us two points of GDP.", False),
    ("genuine rebuttal", "My case rests on arithmetic, not mood: fixed investment lifts output per worker.",
     "That is a strong objection — the bypasses do raise costs and exclude smaller players.", False),
]


def main() -> int:
    spec = importlib.util.spec_from_file_location("face_peer", HERE / "face_peer.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    failures = 0
    for name, reply, said, want in CASES:
        got = mod.echoes_input(reply, said)
        ok = got == want
        failures += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {name:20s} echo={got!s:5s} want={want}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} cases behaved (threshold {THRESHOLD})")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
