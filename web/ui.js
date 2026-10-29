/* Hermes face — HUD, editor, voice and dictation wiring. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const line = $('#line');
  const said = $('#said');
  const heardEl = $('#heard');
  const stateLabel = $('#stateLabel');
  const panel = $('#panel');
  const saveState = $('#saveState');

  let schema = null;
  let P = {};
  let saveTimer = 0;
  let lastAudio = '';
  let busy = false;
  let prevVox = 'idle';
  let buildAtLoad = 0;
  let voxText = '';            // text present at the moment dictation started
  let submitted = '';
  let submitTimer = 0;
  let audioPrevVox = 'idle';

  const api = () => window.__face;

  /* ------------------------------------------------------------ panel */
  function readSaved() {
    return fetch('/params', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  }

  function setP(key, value) {
    P[key] = value;
    api().setParams({ [key]: value });
    if (key === 'effect') applyEffectGate();
  }

  // Only show the settings that belong to the chosen effect
  function applyEffectGate() {
    const cur = Number(P.effect ?? 0);
    for (const row of document.querySelectorAll('#paramGroups .row[data-effect]')) {
      row.hidden = Number(row.dataset.effect) !== cur;
    }
    // a group whose rows are all gated away hides its section too
    for (const sec of document.querySelectorAll('#paramGroups details.group')) {
      const rows = [...sec.querySelectorAll('.row')];
      sec.hidden = rows.length > 0 && rows.every(r => r.hidden);
    }
  }

  function fmt(v, step) {
    const dec = step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    return Number(v).toFixed(dec);
  }

  async function buildEditor() {
    const host = $('#paramGroups');
    host.innerHTML = '';
    // Ten headings and sixty sliders is a wall; each group is a <details> now, so the
    // panel opens as a list and only the sections in use are unfolded. Head, Eyes and
    // Cells start open -- those are the three anyone touches first.
    const OPEN = new Set(['head', 'eyes', 'cells']);
    for (const g of schema.groups) {
      const sec = document.createElement('details');
      sec.className = 'group';
      if (OPEN.has(g.id)) sec.open = true;
      const h = document.createElement('summary');
      h.textContent = g.label;
      sec.appendChild(h);
      host.appendChild(sec);
      for (const p of g.params) {
        const row = document.createElement('div');
        row.className = 'row';
        if (p.effect !== undefined) row.dataset.effect = String(p.effect);

        // a select (hair style) is a choice, not a range
        if (p.kind === 'select') {
          const lbl = document.createElement('label');
          const nm = document.createElement('span');
          nm.textContent = p.label;
          lbl.append(nm);
          const sel = document.createElement('select');
          sel.className = 'pick';
          sel.dataset.key = p.key;
          (p.options || []).forEach((opt, i) => {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = opt;
            sel.appendChild(o);
          });
          sel.value = String(P[p.key] ?? p.default);
          sel.addEventListener('change', () => {
            setP(p.key, Number(sel.value));
            queueSave();
          });
          row.append(lbl, sel);
          sec.appendChild(row);
          continue;
        }

        const label = document.createElement('label');
        const name = document.createElement('span');
        name.textContent = p.label;
        const out = document.createElement('output');
        out.textContent = fmt(P[p.key] ?? p.default, p.step);
        label.append(name, out);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = p.min; input.max = p.max; input.step = p.step;
        input.value = P[p.key] ?? p.default;
        input.addEventListener('input', () => {
          const v = Number(input.value);
          out.textContent = fmt(v, p.step);
          setP(p.key, v);
          queueSave();
        });
        input.dataset.key = p.key;
        row.append(label, input);
        sec.appendChild(row);
      }
    }
    // presets: built in from the schema, plus whatever Pierre has saved
    await loadPresets();
    const saveBtn = $('#presetSave');
    if (saveBtn && !saveBtn.dataset.wired) {
      saveBtn.dataset.wired = '1';
      saveBtn.addEventListener('click', savePreset);
      const nameInput = $('#presetName');
      if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') savePreset(); });
    }
    syncInputs();
    applyEffectGate();
  }

  function syncInputs() {
    for (const sel of document.querySelectorAll('#paramGroups select.pick')) {
      const k = sel.dataset.key;
      if (k in P) sel.value = String(P[k]);
    }
    for (const inp of document.querySelectorAll('#paramGroups input[type="range"]')) {
      const k = inp.dataset.key;
      if (k in P) {
        inp.value = P[k];
        const out = inp.parentElement.querySelector('output');
        if (out) out.textContent = fmt(P[k], Number(inp.step));
      }
    }
  }

  function defaults() {
    const d = {};
    for (const g of schema.groups) for (const p of g.params) d[p.key] = p.default;
    return d;
  }

  let PRESETS = { builtin: {}, custom: {} };

  async function loadPresets() {
    try {
      const r = await fetch('/presets', { cache: 'no-store' });
      if (r.ok) PRESETS = await r.json();
    } catch (e) { /* keep whatever we had */ }
    renderPresets();
  }

  function renderPresets() {
    const ph = $('#presets');
    if (!ph) return;
    ph.innerHTML = '';
    const add = (name, custom) => {
      const wrap = document.createElement('span');
      wrap.className = 'chip' + (custom ? ' mine' : '');
      const b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', () => applyPreset(name));
      wrap.appendChild(b);
      if (custom) {
        const x = document.createElement('button');
        x.className = 'x';
        x.textContent = '\u00d7';
        x.title = 'Delete this preset';
        x.addEventListener('click', async ev => {
          ev.stopPropagation();
          await fetch('/presets', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, delete: true }),
          });
          loadPresets();
        });
        wrap.appendChild(x);
      }
      ph.appendChild(wrap);
    };
    // grouped by category, because fifteen chips in one wrap is a soup
    const bucket = (name) => {
      const n = name.toLowerCase();
      if (n.startsWith('male')) return 'Male';
      if (n.startsWith('female')) return 'Female';
      if (n.startsWith('style')) return 'Style';
      return 'Other';
    };
    for (const cat of ['Male', 'Female', 'Style', 'Other']) {
      const names = Object.keys(PRESETS.builtin || {}).filter(n => bucket(n) === cat);
      if (!names.length) continue;
      const label = document.createElement('div');
      label.className = 'presetCat';
      label.textContent = cat;
      ph.appendChild(label);
      for (const name of names) add(name, false);
    }
    for (const name of Object.keys(PRESETS.custom || {})) add(name, true);
  }

  async function savePreset() {
    const input = $('#presetName');
    const name = (input && input.value || '').trim();
    if (!name) { if (input) input.focus(); return; }
    const r = await fetch('/presets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (r.ok) {
      const j = await r.json();
      PRESETS.custom = j.custom || {};
      if (input) input.value = '';
      renderPresets();
      saveState.textContent = 'preset saved: ' + name;
      setTimeout(() => { saveState.textContent = 'saved'; }, 2200);
    }
  }

  function applyPreset(name) {
    const base = defaults();
    const over = Object.assign({}, (PRESETS.builtin || {})[name] || {}, (PRESETS.custom || {})[name] || {});
    P = Object.assign(base, over);
    api().setParams(P);
    syncInputs();
    applyEffectGate();
    queueSave();
  }

  function queueSave() {
    saveState.textContent = 'saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const r = await fetch('/params', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(P),
        });
        const j = await r.json();
        if (j && j.params) P = Object.assign(P, j.params);
        saveState.textContent = 'saved';
      } catch {
        saveState.textContent = 'not saved';
      }
    }, 320);
  }

  function togglePanel(force) {
    const open = force === undefined ? !panel.classList.contains('open') : force;
    panel.classList.toggle('open', open);
    document.body.classList.toggle('panel-open', open);
    if (!open) line.focus();
  }

  /* ------------------------------------------------------------ voice list */
  async function loadVoices() {
    try {
      const r = await fetch('/voices');
      const j = await r.json();
      // 300+ voices is a wall of options, so group them by language. The server sorts
      // English first and then by locale, so the groups come out contiguous.
      const sel = $('#voice');
      sel.innerHTML = '';
      let group = null, groupKey = '';
      for (const [id, label] of j.voices) {
        // group by the voice id's language part, not by the label: the label format is
        // for humans and the fallback list does not use it at all
        const key = (id.split('-')[0] || '').toLowerCase();
        if (key !== groupKey) {
          group = document.createElement('optgroup');
          group.label = key === 'en' ? 'English' : key.toUpperCase();
          sel.appendChild(group);
          groupKey = key;
        }
        const o = document.createElement('option');
        o.value = id; o.textContent = label;
        if (id === j.current) o.selected = true;
        group.appendChild(o);
      }
      sel.addEventListener('change', async () => {
        await fetch('/params', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ voice: sel.value }),
        });
        saveState.textContent = 'voice: ' + sel.value;
      });
    } catch { /* the face works without a voice list */ }
  }

  $('#voiceTest').addEventListener('click', async () => {
    saveState.textContent = 'synthesising…';
    try {
      const r = await fetch('/voice-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Hello Pierre. This is the voice you will hear me speak with.' }),
      });
      const j = await r.json();
      if (j.audio) { play(j.audio); saveState.textContent = 'voice test'; }
      else saveState.textContent = 'tts failed';
    } catch { saveState.textContent = 'tts failed'; }
  });

  $('#reset').addEventListener('click', () => {
    P = defaults();
    api().setParams(P);
    syncInputs();
    queueSave();
  });

  /* ------------------------------------------------------------ history */
  const histPanel = $('#histPanel');
  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function renderHistory(h) {
    const list = $('#histList');
    const sessions = (h && h.sessions) || [];
    if (!sessions.length) { list.innerHTML = '<div id="histEmpty">nothing yet</div>'; return; }
    list.innerHTML = '';
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      const box = document.createElement('div');
      box.className = 'sess';
      const head = document.createElement('div');
      head.className = 'head';
      const label = document.createElement('span');
      label.textContent = (s.sid ? s.sid.slice(0, 10) : 'new session') + ' · ' + (s.turns || []).length + ' turns';
      const resume = document.createElement('button');
      resume.className = 'small';
      resume.textContent = 'resume';
      resume.addEventListener('click', async () => {
        await fetch('/history/resume', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sid: s.sid || '' }),
        });
        heardEl.textContent = 'resumed ' + (s.sid ? s.sid.slice(0, 10) : 'a fresh session');
        toggleHistory(false);
      });
      head.append(label, resume);
      box.append(head);
      for (const turn of (s.turns || []).slice(-12)) {
        const row = document.createElement('div');
        row.className = 'turn';
        const tEl = document.createElement('span');
        tEl.className = 't';
        tEl.textContent = fmtTime(turn.ts) + '  ';
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = turn.heard;
        const bot = document.createElement('div');
        bot.className = 'bot';
        bot.textContent = turn.reply;
        row.append(tEl, you, bot);
        box.append(row);
      }
      list.append(box);
    }
  }
  async function refreshHistory() {
    try {
      const r = await fetch('/history', { cache: 'no-store' });
      renderHistory(await r.json());
    } catch { $('#histList').innerHTML = '<div id="histEmpty">history unavailable</div>'; }
  }
  function toggleHistory(on) {
    const open = on === undefined ? !document.body.classList.contains('history-open') : on;
    document.body.classList.toggle('history-open', open);
    if (open) refreshHistory();
  }
  $('#hist').addEventListener('click', () => toggleHistory());
  $('#histClose').addEventListener('click', () => toggleHistory(false));
  $('#histClear').addEventListener('click', async () => {
    await fetch('/history/clear', { method: 'POST' });
    refreshHistory();
  });

  $('#gear').addEventListener('click', () => togglePanel());
  $('#panelClose').addEventListener('click', () => togglePanel(false));

  /* ------------------------------------------------------------ audio */
  let ac = null, analyser = null, audioEl = null, sourceNode = null, rafAmp = 0, freqBuf = null;
  let lastSeq = null;   /* the turn this page is currently showing */

  function ensureAudioGraph() {
    if (audioEl) return;
    audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('ended', () => {
      fetch('/spoken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq: lastSeq }),   /* a stale turn must not clear the live one */
      });
      api().setAmp(0);
    });
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = ac.createMediaElementSource(audioEl);
      analyser = ac.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      sourceNode.connect(analyser);
      analyser.connect(ac.destination);
    } catch { /* audio graph is optional; the face still animates */ }
  }

  function pumpAmp() {
    if (!analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    api().setAmp(Math.min(1, rms * 3.4));

    // spectral centre of mass, normalised: speech lands low, a bright or emphatic voice
    // lands higher. It is a cheap stand-in for pitch and it moves with emphasis, which is
    // all the expression layer needs.
    if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(freqBuf);
    let wsum = 0, msum = 0;
    for (let i = 1; i < freqBuf.length; i++) {
      const m = freqBuf[i];
      if (m < 8) continue;
      wsum += i * m; msum += m;
    }
    const centroid = msum > 0 ? (wsum / msum) / freqBuf.length : 0;   // 0..1 of Nyquist
    // speech measured off a real reply lands between 0.11 and 0.23, so the band is centred
    // there: outside it the value would sit pinned at one end and stop meaning anything
    api().setProsody(Math.min(1, rms * 3.4), Math.max(0, Math.min(1, (centroid - 0.08) / 0.20)));
    rafAmp = requestAnimationFrame(pumpAmp);
  }

  function play(url) {
    ensureAudioGraph();
    if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    if (!audioEl) return;
    audioEl.src = url;
    audioEl.play().then(() => {
      cancelAnimationFrame(rafAmp);
      if (analyser) pumpAmp();
    }).catch(() => { /* autoplay blocked: server auto-idles the state */ });
  }

  ['pointerdown', 'keydown'].forEach((ev) =>
    addEventListener(ev, () => { if (ac && ac.state === 'suspended') ac.resume().catch(() => {}); }, { passive: true }));

  /* ------------------------------------------------------------ turn */
  // The new command always wins: if a turn is running it is interrupted first and the
  // reply that was mid-sentence is dropped, rather than the input being refused.
  async function interruptTurn() {
    if (audioEl) { try { audioEl.pause(); audioEl.currentTime = 0; } catch { /* not loaded */ } }
    lastAudio = '';
    try {
      await fetch('/interrupt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch { /* the next /say will fail loudly if the bridge is really down */ }
  }

  async function submit() {
    const text = line.value.trim();
    if (!text) return;
    const wasBusy = busy;
    busy = true;
    submitted = text;
    line.value = '';
    said.textContent = '';
    heardEl.textContent = 'you: ' + text;
    try {
      if (wasBusy) await interruptTurn();
      const r = await fetch('/say', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (r.status === 409) heardEl.textContent = 'still thinking — one moment';
    } catch {
      heardEl.textContent = 'the agent bridge is down';
    }
  }

  line.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') {
      // Escape is the "stop talking and listen" key while a turn is live
      if (busy) { e.preventDefault(); interruptTurn(); heardEl.textContent = 'interrupted'; return; }
      line.blur();
      togglePanel(false);
    }
  });

  // Shortcuts below are bare keys, so anything typed into a field must be left alone: the
  // profile-name input made every "e" in a name close the panel.
  const isField = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  addEventListener('keydown', (e) => {
    if (e.target === line || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isField(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); togglePanel(); }
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); toggleHistory(); }
    if (e.key === 'Escape') togglePanel(false);
  });

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('open') || panel.contains(e.target) || e.target.id === 'gear') return;
    line.focus();
  });
  addEventListener('load', () => line.focus());
  document.addEventListener('face:ready', () => line.focus());

  /* ------------------------------------------------------------ state poll */
  const LABEL = { idle: 'idle', listening: 'listening', thinking: 'thinking', speaking: 'speaking' };

  async function poll() {
    try {
      const r = await fetch('/state', { cache: 'no-store' });
      const st = await r.json();
      if (st.seq !== undefined) lastSeq = st.seq;

      // state arbitration: dictation outranks the agent, agent outranks idle
      let state = 'idle';
      if (st.voxtype === 'recording' || st.voxtype === 'transcribing') state = 'listening';
      else if (st.agent === 'thinking') state = 'thinking';
      else if (st.agent === 'speaking') state = 'speaking';

      // the backend stamps a build id from the file mtimes: a code change reloads
      // the open window instead of leaving it on stale JavaScript
      if (st.build) {
        if (!buildAtLoad) buildAtLoad = st.build;
        else if (st.build !== buildAtLoad) { location.reload(); return; }
      }

      busy = st.agent !== 'idle';
      api().setState(state);
      api().setMood(st.mood || 'neutral');
      document.body.dataset.state = state;
      stateLabel.textContent = LABEL[state] || state;

      if (st.reply && st.agent !== 'idle') said.textContent = st.reply;
      if (st.error) heardEl.textContent = st.error;

      if (st.audio && st.audio !== lastAudio) {
        lastAudio = st.audio;
        play(st.audio);
      }
      if (!st.audio) lastAudio = '';

      // dictation finished -> send whatever voxtype typed
      if (prevVox !== 'idle' && st.voxtype === 'idle') {
        voxText = line.value.trim();
        if (voxText && voxText !== submitted && !busy) {
          clearTimeout(submitTimer);
          submitTimer = setTimeout(() => {
            if (line.value.trim() === voxText && !busy) submit();
          }, 550);
        }
      }
      prevVox = st.voxtype;
    } catch {
      stateLabel.textContent = 'offline';
      document.body.dataset.state = 'idle';
    }
    setTimeout(poll, 380);
  }

  /* ------------------------------------------------------------ boot */
  (async () => {
    try {
      schema = await (await fetch('/face/schema.json', { cache: 'no-store' })).json();
      const saved = await readSaved();
      const d = defaults();
      for (const [k, v] of Object.entries(saved || {})) if (typeof v === 'number' && isFinite(v)) d[k] = v;
      P = d;
      if (new URLSearchParams(location.search).get('edit') === '1') togglePanel(true);
      const wait = () => (window.__face && window.__face.schema ? buildEditor() : setTimeout(wait, 60));
      wait();
      loadVoices();
      poll();
    } catch (err) {
      heardEl.textContent = 'face failed to load: ' + err.message;
    }
  })();
})();
