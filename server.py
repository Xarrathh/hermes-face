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
import shutil
import signal
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
PRESETS_FILE = WEB / "presets.json"

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _resolve_hermes() -> Path:
    """Where the agent CLI lives, without assuming this machine's layout.

    HERMES_BIN wins if set; otherwise the known in-repo install, then anything on
    PATH, so a fresh box is a config change rather than a code change.
    """
    env = os.environ.get("HERMES_BIN")
    if env:
        return Path(env)
    for cand in (HERMES_HOME / "hermes-agent/.hermes/bin/hermes",
                 HERMES_HOME / "bin/hermes"):
        if cand.is_file() and os.access(cand, os.X_OK):
            return cand
    found = shutil.which("hermes")
    return Path(found) if found else HERMES_HOME / "hermes-agent/.hermes/bin/hermes"


HERMES = _resolve_hermes()
HERMES_CONFIG = HERMES_HOME / "config.yaml"
VOXTYPE_STATE = Path(os.environ.get("HERMES_FACE_VOXTYPE_STATE")
                     or f"/run/user/{os.getuid()}/voxtype/state")

PORT = int(os.environ.get("HERMES_FACE_PORT", "9120"))

# Fallback for a box with no network (or no edge-tts): the voices this face shipped with.
VOICES_STATIC = [
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


def _voice_label(short: str, locale: str, gender: str) -> str:
    """`en-ZA · Leah (Female)`: locale first, because that is how a human picks one."""
    name = short
    if locale and name.startswith(locale + "-"):
        name = name[len(locale) + 1:]
    if name.endswith("Neural"):
        name = name[:-6]
    name = re.sub(r"(?<=[a-z])([A-Z])", r" \1", name)      # AriaMultilingual -> Aria Multilingual
    return f"{locale} · {name}" + (f" ({gender})" if gender else "")


def load_voices() -> list[tuple[str, str]]:
    """Every voice the service knows about, English first.

    edge-tts ships ~320 of them and the list changes; hardcoding eleven was throwing away
    the whole point of the service. The module is tried first (the installer puts it in the
    venv), then the CLI, then the static list -- a face with no network still speaks.
    """
    rows: list[tuple[str, str, str]] = []
    try:
        import edge_tts
        for v in asyncio.run(edge_tts.list_voices()):
            rows.append((v.get("ShortName", ""), v.get("Locale", ""), v.get("Gender", "")))
    except Exception:                                   # noqa: BLE001
        try:
            cli = shutil.which("edge-tts") or str(Path.home() / ".local/bin/edge-tts")
            raw = subprocess.run([cli, "--list-voices"], capture_output=True,
                                  text=True, timeout=25).stdout
            for line in raw.splitlines()[2:]:
                parts = line.split()
                if len(parts) >= 3 and parts[0].endswith("Neural"):
                    loc = "-".join(parts[0].split("-")[:2])
                    rows.append((parts[0], loc, parts[1]))
        except Exception:                               # noqa: BLE001
            return list(VOICES_STATIC)

    rows = [r for r in rows if r[0]]
    if not rows:
        return list(VOICES_STATIC)
    # English first (that is what the face speaks), then by locale, then by name
    rows.sort(key=lambda r: (not r[1].startswith("en"), r[1], r[0]))
    return [(short, _voice_label(short, loc, gen)) for short, loc, gen in rows]


VOICES = load_voices()
VOICE_SET = {v for v, _ in VOICES}

PROMPT_PREFIX = (
    "Voice interface: your answer is spoken aloud by TTS and shown on screen. "
    "Answer in English only, in one to three short sentences of plain speech. "
    "No markdown, no lists, no code blocks, no emoji. Be direct. "
    "Begin the answer with exactly one mood tag in square brackets -- one of "
    "[warm] [amused] [serious] [curious] [excited] [concerned] [dry] [neutral] -- "
    "that matches how the answer should sound. The tag is stripped before speaking "
    "and is never shown, so nothing else belongs in the brackets.\n\n"
)

MOODS = ("neutral", "warm", "amused", "curious", "excited", "serious", "concerned", "dry")
MOOD_TAG = re.compile(r"^\s*\[([a-z][a-z \-]{1,19})\]\s*", re.I)

# the tag is the model's own read of the answer; when it forgets, these words are a
# crude but adequate second opinion, and a slash-command reply always lands here
MOOD_HINTS = (
    ("amused", ("haha", "funny", "joke", "ridiculous")),
    ("concerned", ("sorry", "fail", "failed", "error", "broken", "problem", "can't",
                   "cannot", "unable", "risk", "careful", "warning")),
    ("excited", ("great", "excellent", "perfect", "brilliant", "let's go", "works")),
    ("warm", ("happy", "glad", "thanks", "thank you", "welcome", "nice")),
)


def split_mood(reply: str) -> tuple[str, str]:
    """Pull the leading mood tag out of a reply. Returns (mood, reply without it)."""
    m = MOOD_TAG.match(reply or "")
    if m:
        word = m.group(1).strip().lower().replace(" ", "")
        rest = reply[m.end():].lstrip()
        if word in MOODS and rest:
            return word, rest
    return guess_mood(reply), (reply or "").strip()


def guess_mood(text: str) -> str:
    low = (text or "").lower()
    for mood, words in MOOD_HINTS:
        if any(w in low for w in words):
            return mood
    if "?" in low:
        return "curious"
    return "neutral"


LOCK = threading.Lock()
# The live turn's process, so /interrupt can kill the agent and not just the display.
# Each turn is started in its own session, so TERM to the group takes the CLI and
# anything it spawned with it.
RUN = {"proc": None, "seq": 0}
RUN_LOCK = threading.Lock()
STATE = {
    "agent": "idle",        # idle | thinking | speaking
    "voxtype": "idle",      # idle | recording | transcribing
    "mood": "neutral",      # drives the expression while it speaks
    "heard": "",
    "reply": "",
    "audio": None,
    "session": "",
    "seq": 0,
    "error": "",
}


SID_LINE = re.compile(r"^\s*session_id:\s*(\S+)\s*$", re.M)
RE_SID = re.compile(r"[0-9A-Za-z_\-]{6,64}")
FACE_SESSION = "hermes-face"


_CAPS: dict[str, bool] = {}


def hermes_caps() -> dict[str, bool]:
    """Which `hermes chat` flags this machine's CLI actually has.

    The face ran on 0.21 and broke on 0.19 in the same project: `--query-file` and
    `--create-if-missing` are new, and passing an unknown flag is a hard argparse
    failure, not a warning. Probe once, cache, and build the command from the
    result so one copy of the code drives every box.
    """
    if _CAPS:
        return _CAPS
    caps = {"query_file": False, "create_if_missing": False}
    try:
        out = subprocess.run([str(HERMES), "chat", "--help"], capture_output=True,
                             text=True, timeout=20).stdout
    except Exception:                              # noqa: BLE001  (old CLI, no binary)
        out = ""
    caps["query_file"] = "--query-file" in out
    caps["create_if_missing"] = "--create-if-missing" in out
    _CAPS.update(caps)
    return _CAPS



def parse_quiet(out: str) -> tuple[str, str]:
    """Split `hermes chat -Q` output into (reply, session_id)."""
    text = out or ""
    m = SID_LINE.search(text)
    sid = m.group(1) if m else ""
    body = SID_LINE.sub("", text).strip()
    return body, sid


def _kill_turn(wait: float = 3.0) -> bool:
    """Signal the live turn's process group and wait until it is actually gone.

    Returning before the PID is reaped is what breaks the *next* turn: Hermes
    refuses a second run with "session already has a live owner" while the dead
    run's lock file lingers. So this polls for the exit, then escalates to KILL.
    """
    with RUN_LOCK:
        proc = RUN["proc"]
    if proc is None or proc.poll() is not None:
        return False
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return False
    deadline = time.time() + wait
    while time.time() < deadline:
        if proc.poll() is not None:
            return True
        time.sleep(0.05)
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    for _ in range(40):
        if proc.poll() is not None:
            break
        time.sleep(0.05)
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    return True


# --------------------------------------------------------------------- face spec
def load_schema() -> dict:
    data: dict = {}
    try:
        data = json.loads(SCHEMA.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {"groups": [], "presets": {}}
    # Presets live in their own file so the parameter schema stays a stable contract:
    # three agents rewriting one schema.json to change a look is a merge conflict by
    # construction. A schema that still carries presets keeps working -- the file wins.
    try:
        presets = json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
        if isinstance(presets, dict) and isinstance(presets.get("presets"), dict):
            data["presets"] = presets["presets"]
    except (OSError, json.JSONDecodeError):
        pass
    return data


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
VOICE_SET.add(hermes_voice())


def load_config() -> dict:
    """The whole document, not just the two keys this module reads.

    Saved presets live under "presets", and every /params save rewrites the file
    from whatever this returned: rebuilding the dict here dropped them, so moving
    a slider after saving a preset silently deleted the preset.
    """
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    params = cfg.get("params")
    if not isinstance(params, dict):
        params = {}
    merged = {}
    for key, (default, _lo, _hi, _choices) in PARAM_SPEC.items():
        v = coerce(key, params.get(key, default))
        merged[key] = default if v is None else v
    cfg["params"] = merged
    cfg["voice"] = cfg["voice"] if cfg.get("voice") in VOICE_SET else hermes_voice()
    return cfg


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
    """Speak, with the module or the CLI -- a systemd unit's PATH often has neither.

    The venv install gives the module. On a box where edge-tts came from uv/pipx the
    module is not importable by the service's interpreter, and the CLI is the only
    thing that exists; without this fallback every reply is silent with a
    ModuleNotFoundError in the journal.
    """
    said = voice or load_config()["voice"]
    try:
        import edge_tts
    except ImportError:
        cli = shutil.which("edge-tts") or str(Path.home() / ".local/bin/edge-tts")
        subprocess.run([cli, "--voice", said, "--rate=+4%", "--text", text,
                        "--write-media", str(out)],
                       check=True, capture_output=True, timeout=120)
        return

    async def run() -> None:
        await edge_tts.Communicate(text, said, rate="+4%").save(str(out))

    # Edge's websocket rejects the security token now and then (a bare
    # `403 Invalid response status` that succeeds on the next attempt). One retry
    # keeps a single bad token from silencing a whole reply.
    last: Exception | None = None
    for attempt in range(3):
        try:
            asyncio.run(run())
            if out.is_file() and out.stat().st_size > 0:
                return
        except Exception as exc:                   # noqa: BLE001
            last = exc
        time.sleep(0.8 * (attempt + 1))
    if last:
        raise last
    raise RuntimeError("edge-tts wrote no audio")


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
        # -Q is the programmatic mode the current CLI actually has: it prints the
        # final response plus a `session_id: ...` line, and nothing else. The old
        # invocation asked for `--format stream-json`, which this Hermes no longer
        # accepts, so every turn failed with "unrecognized arguments".
        cmd = [str(HERMES), "chat"]
        caps = hermes_caps()
        if caps["query_file"]:
            cmd += ["--query-file", str(qfile)]
        else:
            # Pre-0.20 CLIs only take the prompt inline. Fine for a spoken line; the
            # file exists either way so the cleanup path stays identical.
            cmd += ["-q", PROMPT_PREFIX + heard]
        cmd += ["-Q", "--source", "tool"]
        if RE_SID.fullmatch(sid or "") and sid != FACE_SESSION:
            cmd += ["--resume", sid]
        elif caps["create_if_missing"]:
            # A named session is the durable half of the trick: a fresh conversation
            # per turn would forget the last thing that was said to the face.
            cmd += ["--continue", FACE_SESSION, "--create-if-missing"]
        # else: no --create-if-missing in this CLI, so the first turn opens a fresh
        # session and every later turn resumes the id parsed out of it.

        reply, new_sid, interrupted = "", sid, False
        # The previous killed run can still hold the session lock for a moment, so a
        # turn that fails on "live owner" is retried rather than reported as an error.
        for attempt in range(4):
            try:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        text=True, stdin=subprocess.DEVNULL,
                                        start_new_session=True)
            except Exception as exc:               # noqa: BLE001
                reply = f"I hit an error: {exc}"
                break
            with RUN_LOCK:
                RUN["proc"] = proc
                RUN["seq"] = seq
            try:
                out, err = proc.communicate(timeout=240)
            except subprocess.TimeoutExpired:
                _kill_turn()
                out, err = "", ""
                reply = "That took too long, so I stopped."
            finally:
                with RUN_LOCK:
                    if RUN["proc"] is proc:
                        RUN["proc"] = None
                qfile.unlink(missing_ok=True)

            # interrupted: the seq moved on, so this turn's answer is not wanted
            with LOCK:
                abandoned = STATE["seq"] != seq
            if abandoned:
                interrupted = True
                break

            # `hermes chat -Q` prints the reply on stdout and `session_id: ...` on
            # stderr, so both streams have to be read to keep the thread.
            reply, got_sid = parse_quiet(out)
            if not got_sid:
                _, got_sid = parse_quiet(err)
            new_sid = got_sid or new_sid or sid or FACE_SESSION

            if reply or proc.returncode == 0:
                break
            tail = (err or "").strip().splitlines()
            last = tail[-1][:200] if tail else ""
            if "live owner" in last and attempt < 3:
                time.sleep(0.6 * (attempt + 1))     # the dead run's lock is clearing
                continue
            reply = "The agent did not return an answer." + (f" ({last[:160]})" if last else "")
            break

        if interrupted:
            reply = "[INTERRUPTED]"

    if reply == "[INTERRUPTED]":
        set_if_current(seq, agent="idle", audio=None)
        return
    mood, reply = split_mood(reply)
    record_turn(heard, reply, new_sid or "")
    speech = clean_for_speech(reply)[:1200]
    if not set_if_current(seq, agent="speaking", reply=reply, mood=mood, session=new_sid or ""):
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
            # The new command always wins: drop whatever is running instead of
            # refusing the turn. The killed run notices its seq moved and stays quiet.
            _kill_turn()
            with LOCK:
                STATE["seq"] += 1
                seq = STATE["seq"]
                STATE.update(agent="thinking", mood="curious", heard=text.strip(),
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
                    if payload["voice"] in VOICE_SET:
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

        if path == "/interrupt":
            killed = _kill_turn()
            with LOCK:
                # clear the caption too: the killed turn cannot report its own end,
                # and a half-finished reply left on screen reads as the new answer
                STATE.update(agent="idle", audio=None, reply="", seq=STATE["seq"] + 1)
            return self._json({"ok": True, "killed": killed})

        if path == "/spoken":
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
