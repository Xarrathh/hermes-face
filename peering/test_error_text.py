#!/usr/bin/env python3
"""A speech failure must not throw away the words.

The live pair produced `200 {"reply": ""}` twice: the answering bridge had failed to synthesise
audio (edge-tts burst), set `error`, and left the text in `reply`. The sidecar treated any error
as "no answer" and returned nothing, which reads as a peer that ignored the question.

This pins the fix without needing a broken TTS: it drives `ask_agent` with a stubbed bridge.

    python3 peering/test_error_text.py      # exit 0 = the words survive a voice failure
"""
import argparse
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("face_peer", HERE / "face_peer.py")
assert spec and spec.loader, "cannot load peering/face_peer.py"
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)

CALLS = {"state": 0}


def main() -> int:
    args = argparse.Namespace(face_url="http://stub", token="t", reply_timeout=3.0, key="")

    def fake_state(_args):
        CALLS["state"] += 1
        if CALLS["state"] < 2:                    # first poll: still thinking
            return {"agent": "thinking", "reply": "", "error": "", "audio_parts": []}
        return {"agent": "idle", "error": "speech failed: No audio was received",
                "reply": "Growth needs private capital, and load-shedding cost us two points.",
                "audio_parts": []}

    setattr(fp, "face_state", fake_state)
    setattr(fp, "face_call", lambda *a, **k: {"ok": True})
    fp.time.sleep = lambda _s: None

    text, audio, why = fp.ask_agent(args, "Suzie", "what do you think?")
    ok_text = text.startswith("Growth needs private capital")
    print(f"{'PASS' if ok_text else 'FAIL'} the text survives a speech error  [{text[:60]!r}]")
    ok_audio = audio == ""
    print(f"{'PASS' if ok_audio else 'FAIL'} no audio is handed back              [{audio!r}]")

    # and an error with no words must still yield nothing, not a fake answer
    CALLS["state"] = 0

    def empty_state(_args):
        CALLS["state"] += 1
        if CALLS["state"] < 2:
            return {"agent": "thinking", "reply": "", "error": "", "audio_parts": []}
        return {"agent": "idle", "error": "cannot read --query-file", "reply": "", "audio_parts": []}

    setattr(fp, "face_state", empty_state)
    text2, _audio2, why2 = fp.ask_agent(args, "Suzie", "anyone?")
    ok_empty = text2 == ""
    print(f"{'PASS' if ok_empty else 'FAIL'} an empty error stays empty        [{text2!r}]")

    ok_reason = why == "ok-no-audio" and why2 == "error"
    print(f"{'PASS' if ok_reason else 'FAIL'} the reason explains the answer      [{why!r}, {why2!r}]")

    failures = sum(1 for ok in (ok_text, ok_audio, ok_empty, ok_reason) if not ok)
    print(f"\n{4 - failures}/4 error-path checks behaved")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
