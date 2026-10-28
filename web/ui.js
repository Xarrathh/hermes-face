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
    // a group whose rows are all gated away hides its heading too
    for (const h of document.querySelectorAll('#paramGroups h2')) {
      let node = h.nextElementSibling;
      let any = false;
      while (node && node.tagName !== 'H2') {
        if (node.classList && node.classList.contains('row') && !node.hidden) any = true;
        node = node.nextElementSibling;
      }
      h.hidden = !any;
    }
  }

  function fmt(v, step) {
    const dec = step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    return Number(v).toFixed(dec);
  }

  async function buildEditor() {
    const host = $('#paramGroups');
    host.innerHTML = '';
    for (const g of schema.groups) {
      const h = document.createElement('h2');
      h.textContent = g.label;
      host.appendChild(h);
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
          host.appendChild(row);
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
        host.appendChild(row);
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
    for (const name of Object.keys(PRESETS.builtin || {})) add(name, false);
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
      const sel = $('#voice');
      sel.innerHTML = '';
      for (const [id, label] of j.voices) {
        const o = document.createElement('option');
        o.value = id; o.textContent = label;
        if (id === j.current) o.selected = true;
        sel.appendChild(o);
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

  $('#gear').addEventListener('click', () => togglePanel());
  $('#panelClose').addEventListener('click', () => togglePanel(false));

  /* ------------------------------------------------------------ audio */
  let ac = null, analyser = null, audioEl = null, sourceNode = null, rafAmp = 0;

  function ensureAudioGraph() {
    if (audioEl) return;
    audioEl = new Audio();
    audioEl.crossOrigin = 'anonymous';
    audioEl.addEventListener('ended', () => {
      fetch('/spoken', { method: 'POST' });
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
  async function submit() {
    const text = line.value.trim();
    if (!text || busy) return;
    busy = true;
    submitted = text;
    line.value = '';
    said.textContent = '';
    heardEl.textContent = 'you: ' + text;
    try {
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
    if (e.key === 'Escape') { line.blur(); togglePanel(false); }
  });

  addEventListener('keydown', (e) => {
    if (e.target === line) return;
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); togglePanel(); }
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
