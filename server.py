#!/usr/bin/env python3
"""Hermes face — the local bridge between the holographic face page and the agent.

Serves the face page, exposes live state (voxtype dictation + agent), takes an
utterance, runs it through the same Hermes agent (own session), synthesises the
reply with edge-tts, and serves it to the page. Loopback only.

Face geometry lives in web/schema.json and web/face.js; config.json stores the
chosen values so the face looks the same after a restart.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
AUDIO = HERE / "audio"
AUDIO.mkdir(exist_ok=True)
CONFIG = HERE / "config.json"
SCHEMA = WEB / "schema.json"

HERMES = Path.home() / ".hermes/hermes-agent/.hermes/bin/hermes"
HERMES_CONFIG = Path.home() / ".hermes/config.yaml"
VOXTYPE_STATE = Path(f"/run/user/{os.getuid()}/voxtype/state")

PORT = int(os.environ.get("HERMES_FACE_PORT", "9120"))

VOICES = [
    ("en-ZA-LukeNeural", "South African — Luke"),
    ("en-ZA-LeahNeural", "South African — Leah"),
    ("en-GB-RyanNeural", "British — Ryan"),
    ("en-GB-SoniaNeural", "British — Sonia"),
    ("en-GB-ThomasNeural", "British — Thomas"),
    ("en-US-GuyNeural", "American — Guy"),
    ("en-US-AriaNeural", "American — Aria"),
    ("en-US-JennyNeural", "American — Jenny"),
    ("en-AU-WilliamNeural", "Australian — William"),
    ("en-AU-NatashaNeural", "Australian — Natasha"),
    ("en-IE-ConnorNeural", "Irish — Connor"),
]

PROMPT_PREFIX = (
    "Voice interface: your answer is spoken aloud by TTS and shown on screen. "
    "Answer in English only, in one to three short sentences of plain speech. "
    "No markdown, no lists, no code blocks, no emoji. Be direct.\n\n"
)

LOCK = threading.Lock()
STATE = {
    "agent": "idle",        # idle | thinking | speaking
    "voxtype": "idle",      # idle | recording | transcribing
    "heard": "",
    "reply": "",
    "audio": None,
    "session": "",
    "seq": 0,
    "error": "",
}


# --------------------------------------------------------------------- face spec
def load_schema() -> dict:
    try:
        return json.loads(SCHEMA.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"groups": [], "presets": {}}


SCHEMA_DATA = load_schema()
# key -> (default, min, max, choices) ; choices is None for a numeric slider and
# the number of options for a select, so the same clamp serves both.
PARAM_SPEC: dict[str, tuple[float, float, float, int | None]] = {}
for _g in SCHEMA_DATA.get("groups", []):
    for _p in _g.get("params", []):
        if _p.get("kind") == "select":
            n = len(_p.get("options", []))
            PARAM_SPEC[_p["key"]] = (float(_p.get("default", 0)), 0.0, float(max(0, n - 1)), n)
        else:
            PARAM_SPEC[_p["key"]] = (_p.get("default", 0.0), _p["min"], _p["max"], None)


def coerce(key: str, value) -> float | int | None:
    """Clamp one value to its schema range; selects round to an option index."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    default, lo, hi, choices = PARAM_SPEC[key]
    v = min(hi, max(lo, float(value)))
    return int(round(v)) if choices is not None else v


def hermes_voice() -> str:
    """The voice Hermes itself speaks with, so the face is the same agent."""
    try:
        text = HERMES_CONFIG.read_text(encoding="utf-8")
    except OSError:
        return "en-ZA-LukeNeural"
    block = re.search(r"^tts:\s*$((?:\n[ \t]+.*)+)", text, re.M)
    if block:
        body = block.group(1)
        edge = re.search(r"^\s+edge:\s*$((?:\n[ \t]+.*)+)", body, re.M)
        for scope in ([edge.group(1)] if edge else []) + [body]:
            m = re.search(r"^\s+voice:\s*[\"']?([A-Za-z0-9\-]+)", scope, re.M)
            if m:
                return m.group(1)
    return "en-ZA-LukeNeural"


# --------------------------------------------------------------------- config
def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cfg = {}
    params = cfg.get("params")
    if not isinstance(params, dict):
        params = {}
    merged = {}
    for key, (default, _lo, _hi, _choices) in PARAM_SPEC.items():
        v = coerce(key, params.get(key, default))
        merged[key] = default if v is None else v
    voice = cfg.get("voice") if cfg.get("voice") in {v for v, _ in VOICES} else hermes_voice()
    return {"params": merged, "voice": voice}


def custom_presets(cfg: dict) -> dict:
    raw = cfg.get("presets")
    if not isinstance(raw, dict):
        return {}
    out = {}
    for name, over in raw.items():
        if not isinstance(over, dict):
            continue
        clean = {}
        for k, v in over.items():
            if k in PARAM_SPEC:
                cv = coerce(k, v)
                if cv is not None:
                    clean[k] = cv
        out[str(name)[:40]] = clean
    return out


def save_config(cfg: dict) -> None:
    """Write through a temp file: a truncate-in-place write can be observed
    half-finished by a concurrent GET /params, which then falls back to schema
    defaults and silently replaces the tuned look."""
    tmp = CONFIG.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, CONFIG)


def config_rev() -> int:
    try:
        return int(CONFIG.stat().st_mtime_ns // 1000)
    except OSError:
        return 0


def voxtype_state() -> str:
    try:
        raw = VOXTYPE_STATE.read_text(encoding="utf-8", errors="replace").strip().lower()
    except OSError:
        return "idle"
    return raw if raw in ("idle", "recording", "transcribing") else "idle"


def set_state(**kw) -> None:
    with LOCK:
        STATE.update(kw)


def set_if_current(seq: int, **kw) -> bool:
    """Only let the turn that owns `seq` write: an abandoned turn finishing
    late must not overwrite the live one and re-speak an answer nobody wants."""
    with LOCK:
        if STATE["seq"] != seq:
            return False
        STATE.update(kw)
        return True


def page_build() -> int:
    """mtime of the renderer: a running page reloads itself when the code moves."""
    newest = 0
    for name in ("face.js", "ui.js", "index.html", "schema.json"):
        try:
            newest = max(newest, int((WEB / name).stat().st_mtime_ns // 1000))
        except OSError:
            pass
    return newest


def snapshot() -> dict:
    with LOCK:
        s = dict(STATE)
    s["voxtype"] = voxtype_state()
    s["rev"] = config_rev()
    s["build"] = page_build()
    return s


# --------------------------------------------------------------------- speech
def clean_for_speech(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"[*_`#>]+", "", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def synth(text: str, out: Path, voice: str | None = None) -> None:
    import edge_tts

    async def run() -> None:
        await edge_tts.Communicate(text, voice or load_config()["voice"], rate="+4%").save(str(out))

    asyncio.run(run())


def _auto_idle_after(seconds: float, seq: int) -> None:
    """If the browser never reports playback (blocked autoplay, quiet sink, crash)
    the state must not stay 'speaking' and lock out the next turn."""
    def run() -> None:
        time.sleep(seconds)
        with LOCK:
            if STATE["seq"] == seq and STATE["agent"] == "speaking":
                STATE.update(agent="idle", audio=None)
    threading.Thread(target=run, daemon=True).start()


# ------------------------------------------------------------------ history
HISTORY = HERE / "history.json"
HIST_LOCK = threading.Lock()
HIST_SESSIONS = 12
HIST_TURNS = 80


def load_history() -> dict:
    try:
        h = json.loads(HISTORY.read_text(encoding="utf-8"))
        if isinstance(h, dict) and isinstance(h.get("sessions"), list):
            return h
    except (OSError, json.JSONDecodeError):
        pass
    return {"sessions": []}


def save_history(h: dict) -> None:
    tmp = HISTORY.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(h, indent=1), encoding="utf-8")
    os.replace(tmp, HISTORY)


def record_turn(heard: str, reply: str, sid: str) -> None:
    """One entry per completed turn, grouped by the Hermes session it belongs to."""
    with HIST_LOCK:
        h = load_history()
        sessions = h.setdefault("sessions", [])
        sid = sid or ""
        if not sessions or sessions[-1].get("sid") != sid:
            sessions.append({"sid": sid, "started": time.time(), "turns": []})
        turns = sessions[-1].setdefault("turns", [])
        turns.append({"ts": time.time(), "heard": heard, "reply": reply})
        sessions[-1]["turns"] = turns[-HIST_TURNS:]
        del sessions[:-HIST_SESSIONS]
        save_history(h)


def handle_command(text: str) -> str:
    """Slash commands typed into the face's own chat line.

    The voice path speaks the returned string, so these read as sentences rather than
    as shell output. Anything unrecognised is answered, never forwarded to the model:
    a leading slash means the user is talking to Hermes, not to the assistant.
    """
    cmd, _, rest = text[1:].partition(" ")
    cmd = cmd.strip().lower()
    rest = rest.strip()

    if cmd in ("help", "?"):
        return ("Commands: slash new for a fresh conversation, slash status for this "
                "session, slash history for what we have said, slash stop to interrupt, "
                "slash help for this list.")
    if cmd in ("new", "clear", "reset"):
        with LOCK:
            STATE.update(session="", heard="", reply="", audio=None)
        return "New conversation. Nothing before this is carried forward."
    if cmd == "status":
        with LOCK:
            sid, agent, seq = STATE["session"], STATE["agent"], STATE["seq"]
        h = load_history()
        turns = sum(len(s.get("turns", [])) for s in h.get("sessions", []))
        # a command is answered while the turn that carries it is still "thinking", so
        # report the state it is about to be rather than confusing the speaker
        shown = "ready" if agent == "thinking" else agent
        return (f"{shown}, turn {seq}. Session {sid[:12] if sid else 'new'}. "
                f"Voice {load_config()['voice']}. {turns} turns in history.")
    if cmd == "history":
        h = load_history()
        sessions = h.get("sessions", [])
        turns = sum(len(s.get("turns", [])) for s in sessions)
        last = ""
        if sessions and sessions[-1].get("turns"):
            last = sessions[-1]["turns"][-1].get("heard", "")[:60]
        return (f"{len(sessions)} conversation{'s' if len(sessions) != 1 else ''}, "
                f"{turns} turns. Last thing heard: {last or 'nothing yet'}.")
    if cmd in ("stop", "cancel"):
        with LOCK:
            STATE.update(agent="idle", audio=None)
        return "Stopped."
    return f"Unknown command {cmd}. Try slash help."


def run_turn(text: str, seq: int) -> None:
    heard = text.strip()
    if not heard:
        set_if_current(seq, agent="idle")
        return

    with LOCK:
        sid = STATE["session"]

    if heard.startswith("/"):
        # A leading slash is addressed to Hermes, not to the model: answer it locally so
        # commands work in the chat line without a round trip through the agent.
        reply = handle_command(heard)
        with LOCK:
            new_sid = STATE["session"]
    else:
        qfile = AUDIO / f"q-{int(time.time() * 1000)}.txt"
        qfile.write_text(PROMPT_PREFIX + heard, encoding="utf-8")
        cmd = [str(HERMES), "chat", "--query-file", str(qfile), "--format", "stream-json",
               "--pass-session-id"]
        if sid:
            cmd += ["--resume", sid]

        reply, new_sid = "", sid
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240,
                                  stdin=subprocess.DEVNULL)
            for raw in proc.stdout.splitlines():
                raw = raw.strip()
                if not raw.startswith("{"):
                    continue
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "result":
                    reply = (ev.get("text") or "").strip()
                    new_sid = ev.get("session_id") or new_sid
            if not reply:
                stderr = (proc.stderr or "").strip().splitlines()
                reply = "The agent did not return an answer." + (f" ({stderr[-1][:160]})" if stderr else "")
        except subprocess.TimeoutExpired:
            reply = "That took too long, so I stopped."
        except Exception as exc:                   # noqa: BLE001
            reply = f"I hit an error: {exc}"
        finally:
            qfile.unlink(missing_ok=True)

    record_turn(heard, reply, new_sid or "")
    speech = clean_for_speech(reply)[:1200]
    if not set_if_current(seq, agent="speaking", reply=reply, session=new_sid or ""):
        return                                     # this turn was abandoned
    if not speech:
        set_if_current(seq, agent="idle")
        return

    out = AUDIO / f"reply-{seq}.mp3"
    try:
        synth(speech, out)
        for old in AUDIO.glob("reply-*.mp3"):
            if old != out:
                old.unlink(missing_ok=True)
        if not set_if_current(seq, audio=f"/audio/{out.name}"):
            return
        _auto_idle_after(out.stat().st_size / 6000.0 + 4.0, seq)
    except Exception as exc:                       # noqa: BLE001
        set_if_current(seq, error=f"tts: {exc}", agent="idle")


# --------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):            # keep the journal quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self) -> None:                      # noqa: N802
        path = self.path.split("?")[0]
        if path == "/face":
            self.send_response(302)
            self.send_header("Location", "/face/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/face/":
            html = (WEB / "index.html").read_text(encoding="utf-8")
            for name in ("face.js", "ui.js"):
                try:
                    v = int((WEB / name).stat().st_mtime_ns // 1000)
                except OSError:
                    v = 0
                html = html.replace(f'src="/face/{name}"', f'src="/face/{name}?v={v}"')
            return self._send(200, html.encode(), "text/html; charset=utf-8")
        if path.startswith("/face/"):
            rel = path[len("/face/"):]
            if ".." not in rel:
                f = (WEB / rel).resolve()
                if f.is_file() and str(f).startswith(str(WEB.resolve())):
                    ctype = {".png": "image/png", ".json": "application/json",
                             ".html": "text/html; charset=utf-8",
                             ".js": "text/javascript; charset=utf-8",
                             ".css": "text/css; charset=utf-8",
                             ".ttf": "font/ttf"}.get(f.suffix, "application/octet-stream")
                    return self._send(200, f.read_bytes(), ctype)
            return self._json({"error": "not found"}, 404)
        if path == "/params":
            return self._json(load_config()["params"])
        if path == "/config":
            return self._json(load_config())
        if path == "/presets":
            cfg = load_config()
            return self._json({"builtin": SCHEMA_DATA.get("presets", {}),
                                "custom": custom_presets(cfg)})
        if path == "/voices":
            return self._json({"voices": VOICES, "current": load_config()["voice"]})
        if path == "/state":
            return self._json(snapshot())
        if path == "/history":
            return self._json(load_history())
        if path == "/health":
            return self._json({"ok": True})
        if path.startswith("/audio/"):
            name = os.path.basename(path)
            f = AUDIO / name
            if f.is_file() and name.endswith(".mp3"):
                return self._send(200, f.read_bytes(), "audio/mpeg")
        return self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:                     # noqa: N802
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}

        if path == "/say":
            text = str(payload.get("text") or "")
            if not text.strip():
                return self._json({"error": "empty"}, 400)
            with LOCK:
                if STATE["agent"] != "idle":
                    return self._json({"error": "busy"}, 409)
                STATE["seq"] += 1
                seq = STATE["seq"]
                STATE.update(agent="thinking", heard=text.strip(),
                             reply="", error="", audio=None)
            threading.Thread(target=run_turn, args=(text, seq), daemon=True).start()
            return self._json({"ok": True, "seq": seq})

        if path == "/history/clear":
            with HIST_LOCK:
                save_history({"sessions": []})
            return self._json({"ok": True})

        if path == "/history/resume":
            sid = str(payload.get("sid") or "")
            with LOCK:
                STATE.update(session=sid, heard="", reply="", audio=None)
            return self._json({"ok": True, "session": sid})

        if path == "/params":
            with LOCK:                             # read-modify-write must be one step
                cfg = load_config()
                if isinstance(payload.get("voice"), str):
                    if payload["voice"] in {v for v, _ in VOICES}:
                        cfg["voice"] = payload["voice"]
                changed = False
                for key, value in payload.items():
                    if key not in PARAM_SPEC:
                        continue
                    v = coerce(key, value)
                    if v is None:
                        continue
                    cfg["params"][key] = v
                    changed = True
                if changed or "voice" in payload:
                    save_config(cfg)
                out = {"ok": True, "params": cfg["params"],
                       "voice": cfg["voice"], "rev": config_rev()}
            return self._json(out)

        if path == "/presets":
            name = str(payload.get("name") or "").strip()[:40]
            if not name:
                return self._json({"error": "name required"}, 400)
            with LOCK:                             # same one-step rule as /params
                cfg = load_config()
                store = cfg.get("presets")
                if not isinstance(store, dict):
                    store = {}
                if payload.get("delete"):
                    store.pop(name, None)
                else:
                    # save exactly what the face is showing, clamped to the schema
                    saved = {}
                    for k, v in cfg["params"].items():
                        cv = coerce(k, v)
                        if cv is not None:
                            saved[k] = cv
                    store[name] = saved
                cfg["presets"] = store
                save_config(cfg)
                out = {"ok": True, "custom": custom_presets(cfg)}
            return self._json(out)

        if path == "/voice-test":
            sample = str(payload.get("text") or "This is how I sound. Say the word and I will change it.")
            out = AUDIO / f"voice-test-{int(time.time() * 1000)}.mp3"
            try:
                synth(sample, out)
                return self._json({"ok": True, "audio": f"/audio/{out.name}?t={int(time.time())}"})
            except Exception as exc:               # noqa: BLE001
                return self._json({"ok": False, "error": str(exc)}, 500)

        if path in ("/spoken", "/interrupt"):
            with LOCK:
                want = payload.get("seq")
                if want is not None and int(want) != STATE["seq"]:
                    return self._json({"ok": True, "ignored": "stale seq"})
                if STATE["agent"] == "thinking":
                    return self._json({"ok": True, "ignored": "turn in flight"})
                STATE.update(agent="idle", audio=None)
            return self._json({"ok": True})

        return self._json({"error": "not found"}, 404)


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print(f"hermes-face on http://127.0.0.1:{PORT}/face/ (voice {load_config()['voice']})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
