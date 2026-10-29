/* Hermes face — parametric holographic head.
 *
 * Every visible thing is derived from one flat parameter set P (web/schema.json).
 * Units: u in [-1,1] across the head width, v in [0,1] from crown to chin.
 * Nothing below stores anatomy in pixels; ux()/vy() are the only converters, so a
 * proportion survives any window size and any slider move.
 *
 * Layers, bottom to top:
 *   backdrop   dark room, perspective floor grid, dust
 *   projector  rings under the chin
 *   head       translucent shell, latitude/longitude mesh, scan band, rim light
 *   features   ears (behind the shell edge), eyes, brows, nose, mouth
 */
(() => {
  'use strict';

  const cv = document.getElementById('face');
  if (!cv) return;
  const mainCtx = cv.getContext('2d', { alpha: false });
  // ctx follows whichever pass is drawing. In cell mode the anatomy is rendered onto
  // its own transparent layer first, so the quantiser reads shading without the room,
  // the rain or the outline in it. Every draw function uses `ctx`, so swapping the
  // target is all it takes -- no function signature changes.
  let ctx = mainCtx;

  const QS = new URLSearchParams(location.search);
  const FREEZE = QS.has('freeze') ? Number(QS.get('freeze')) : null;
  const OFF = new Set((QS.get('off') || '').split(',').filter(Boolean));
  const FIXED_AMP = QS.has('amp') ? Number(QS.get('amp')) : null;

  const TAU = Math.PI * 2;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

  /* ---------------------------------------------------------------- palette */
  let P = {};                       // the params the renderer reads: BASE plus the mood offsets
  let BASE = {};                    // the tuned look, as the sliders and the file have it
  const COL = { main: [80, 220, 240], core: [235, 255, 255], dim: [30, 110, 130], deep: [6, 30, 38] };

  function hsl2rgb(h, s, l) {
    if (s <= 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = ((((h % 360) + 360) % 360) / 60);
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const m = l - c / 2;
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function palette() {
    const h = P.hue ?? 186, s = P.sat ?? 0.78;
    COL.main = hsl2rgb(h, s, 0.63);
    COL.core = hsl2rgb(h, s * 0.22, 0.94);
    COL.dim = hsl2rgb(h, s * 0.95, 0.36);
    COL.deep = hsl2rgb(h, s, 0.10);
    COL.ramp = rampStops(h, s);        // the cell quantiser's six-stop ramp
  }

  /* ---------------------------------------------------------------- layout */
  const HEAD = { cx: 0, cy: 0, w: 0, h: 0 };
  let VW = 0, VH = 0, DPR = 1;

  const ux = (u) => HEAD.cx + u * HEAD.w * 0.5;
  const vy = (v) => HEAD.cy + (v - 0.5) * HEAD.h;
  const dU = (u) => u * HEAD.w * 0.5;
  const dV = (v) => v * HEAD.h;

  function layout() {
    // Length and width are independent: a bigger headLength makes the face
    // longer, not larger. A uniform fallback only kicks in when the result
    // would run off the screen.
    const baseH = Math.min(VH * 0.76, VW * 0.86);
    let h = baseH * (P.headLength ?? 1);
    let w = baseH * 0.735 * (P.headWidth ?? 1);
    const fit = Math.min(1, (VH * 0.94) / h);
    h *= fit;
    w *= fit;
    HEAD.h = h;
    HEAD.w = w;
    HEAD.cx = VW * 0.5;
    HEAD.cy = VH * 0.435;
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    VW = Math.max(360, window.innerWidth);
    VH = Math.max(280, window.innerHeight);
    cv.width = Math.round(VW * DPR);
    cv.height = Math.round(VH * DPR);
    cv.style.width = VW + 'px';
    cv.style.height = VH + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    G.vignette = null;
    G.scanPat = null;
    buildLayer();
    layout();
    rebuildGeometry();
    buildMotes();
    buildCircuit();
    buildMatrix();
    buildBgEffect();
    buildThreads(true);
    buildRain();
  }

  /* ---------------------------------------------------------------- anatomy */
  // Right half of the silhouette, crown -> chin. u is the half width at that v.
  // Params bend this one curve; nothing else stores a face.
  const SILHOUETTE = [
    [0.000, 0.000], [0.225, 0.008], [0.450, 0.028], [0.660, 0.062], [0.820, 0.108],
    [0.915, 0.170], [0.955, 0.245], [0.968, 0.320], [0.966, 0.395], [0.958, 0.462],
    [0.944, 0.525], [0.922, 0.585], [0.900, 0.640], [0.884, 0.692], [0.864, 0.744],
    [0.830, 0.796], [0.775, 0.844], [0.690, 0.888], [0.570, 0.928], [0.425, 0.960],
    [0.255, 0.985], [0.150, 0.996], [0.108, 1.000],
  ];
  // The chin is a rounded arc, not a point. Ending the curve at u = 0 gave every
  // face a tapered elf chin however narrow the jaw was set; chinWidth then had
  // almost nothing left to widen. CHIN_U is the half width of the chin's bottom arc.
  const CHIN_U = 0.108;

  const G = { pts: [], hw: new Float32Array(257) };

  // Face *shape* is a separate axis from the single tuned silhouette: no combination of
  // jaw/chin sliders turns the shared curve into a round or heart-shaped face, because
  // the width profile between cheekbone and chin is fixed. Each family is a multiplier
  // over v applied to that profile, so the params still bend it afterwards.
  const SHAPES = {
    oval:  () => 1,
    // Both extremes overshoot if the multiplier is applied with the wrong sign of
    // generosity: 0.11/-0.10 gave a square jaw, 0.09/-0.20 a pointed elf chin. The jaw
    // corner lives in the base curve (v 0.69-0.79), so a shape can only *round* it.
    round: (v) => 1 + 0.070 * Math.sin(Math.PI * clamp((v - 0.10) / 0.58, 0, 1))
                    - 0.045 * smoothstep(0.74, 1.0, v),
    heart: (v) => 1 + 0.065 * Math.sin(Math.PI * clamp((v - 0.06) / 0.44, 0, 1))
                    - 0.105 * smoothstep(0.66, 0.98, v),
    long:  (v) => 0.93 - 0.05 * smoothstep(0.45, 1.0, v) + 0.04 * smoothstep(0.35, 0.0, v),
  };

  function rebuildGeometry() {
    const SHAPE_ORDER = ['oval', 'round', 'heart', 'long'];
    const shape = SHAPES[SHAPE_ORDER[clamp(Math.round(P.faceShape ?? 0), 0, SHAPE_ORDER.length - 1)]] ?? SHAPES.oval;
    const cran = P.cranium ?? 1;
    const cheek = P.cheekbone ?? 1;
    const jaw = P.jawWidth ?? 1;
    const chin = P.chinWidth ?? 1;
    const chinLen = P.chinLength ?? 1;

    let pts = SILHOUETTE.map(([u, v]) => {
      let uu = u, vv = v;
      if (v < 0.42) uu *= lerp(1, cran, smoothstep(0.42, 0.04, v));
      if (v > 0.34 && v < 0.68) {
        const bell = Math.pow(Math.sin(Math.PI * clamp((v - 0.34) / (0.68 - 0.34), 0, 1)), 1.1);
        uu *= lerp(1, cheek, bell);
      }
      if (v >= 0.62) uu *= lerp(1, jaw, smoothstep(0.60, 0.735, v));
      if (v > 0.82) uu *= lerp(1, chin, smoothstep(0.82, 0.95, v));
      if (v > 0.66) vv = 0.66 + (v - 0.66) * chinLen;
      return [uu * shape(v), vv];
    });
    const vEnd = pts[pts.length - 1][1];
    pts = pts.map(([u, v]) => [u, v / vEnd]);
    G.pts = pts;

    const n = G.hw.length;
    for (let i = 0; i < n; i++) {
      const v = i / (n - 1);
      G.hw[i] = widthAt(pts, v);
    }
  }

  function widthAt(pts, v) {
    if (v <= pts[0][1]) return pts[0][0];
    for (let k = 0; k < pts.length - 1; k++) {
      const [u0, v0] = pts[k], [u1, v1] = pts[k + 1];
      if (v >= v0 && v <= v1) {
        const t = v1 > v0 ? (v - v0) / (v1 - v0) : 0;
        return lerp(u0, u1, t);
      }
    }
    return 0;
  }
  const halfWidth = (v) => G.hw[clamp(Math.round(v * (G.hw.length - 1)), 0, G.hw.length - 1)];

  /* ---------------------------------------------------------------- mood */
  // The whole face is one parameter set, so an emotion is a set of small offsets on top of
  // the tuned look, never a replacement for it. The server tags each reply; the blend eases
  // in while the voice speaks and out again afterwards. Offsets are in the params' own units
  // and clamped to the schema range, so no mood can push the face somewhere the sliders can't.
  // Note on headroom: the tuned look sits at smile 0.38 and eyeOpen at the schema max of
  // 1.70, so upward moves on those two keys are mostly clamped away. The moods therefore do
  // their loud work downward (the mouth can drop to -0.50) and widen through browHeight,
  // browArch and pupilSize instead, which are nowhere near their limits. Amplitudes here are
  // the whole offset, not a hint: ~2x the first pass, which read as a permanent smile.
  const MOODS = {
    neutral:   {},
    warm:      { smile: 0.20, lipFullness: 0.25, mouthWidth: 0.015, eyeOpen: -0.06,
                 browSlant: -0.08, browArch: -0.05 },
    amused:    { smile: 0.21, lipFullness: 0.35, eyeOpen: -0.45, browArch: 0.30,
                 browHeight: 0.012, earTilt: 0.05 },
    excited:   { smile: 0.18, lipFullness: 0.20, mouthWidth: 0.025, pupilSize: 0.18,
                 browHeight: 0.045, browArch: 0.35, earTilt: 0.10 },
    curious:   { smile: -0.10, browHeight: 0.045, browSlant: 0.12, browArch: 0.15,
                 eyeTilt: 0.10, pupilSize: 0.08, mouthWidth: -0.015 },
    serious:   { smile: -0.45, browSlant: -0.22, browThickness: 0.35, browArch: -0.35,
                 browHeight: -0.015, eyeOpen: -0.20, mouthWidth: -0.02 },
    concerned: { smile: -0.50, browSlant: 0.30, browHeight: 0.022, browArch: 0.20,
                 eyeTilt: 0.08, lipFullness: -0.15, mouthWidth: -0.03 },
    dry:       { smile: -0.16, eyeOpen: -0.30, browSlant: -0.16, browArch: -0.10,
                 earTilt: -0.05 },
  };
  const MOOD = { name: 'neutral', target: 0, blend: 0 };
  const RANGE = {};                 // key -> [min, max], filled from the schema at boot

  function moodParams() {
    const out = Object.assign({}, BASE);
    const k = MOOD.blend;
    if (k < 0.002) return out;
    const bump = (key, d) => {
      if (!(key in out) || !d) return;
      const r = RANGE[key];
      const v = out[key] + d;
      out[key] = r ? clamp(v, r[0], r[1]) : v;
    };
    const off = MOODS[MOOD.name];
    if (off) for (const key in off) bump(key, off[key] * k);
    // the live layer under the mood: loudness opens the pupils a touch, a brighter voice
    // lifts the brows and the corners. Tiny on purpose -- this is a breath, not a puppet.
    // eyeOpen is already pinned at the schema max in the tuned look, so loudness moves the
    // pupil instead of the lid, or it would be silently clamped to nothing.
    bump('pupilSize', 0.06 * S.pEnergy * k);
    bump('browHeight', 0.009 * S.pBright * k);
    bump('smile', 0.04 * S.pBright * k);
    return out;
  }

  /* ---------------------------------------------------------------- senses */
  const S = {
    state: 'idle',
    t: 0,
    blink: 0, blinkPhase: 0, nextBlink: 2.4, doubleBlink: 0, blinks: 0,
    gazeX: 0, gazeY: 0, tgx: 0, tgy: 0, nextSaccade: 2.0,
    browL: 0, browR: 0, browTL: 0, browTR: 0, nextBrow: 2.2, flash: 0, nextFlash: 6,
    nostril: 0, nextNostril: 3, earL: 0, earR: 0,
    aperture: 0,
    amp: 0,
    energy: 0, bright: 0, pEnergy: 0, pBright: 0,   // live prosody from the speaking voice
    breath: 0,
    listen: 0, think: 0,
    flick: 1, nextFlick: 3,
    fps: 60,
  };

  const look = { eye: 1, brow: 0, iris: 1, speed: 1 };

  function updateSenses(dt, t) {
    // breathing: a slow lift of the whole head
    S.breath = Math.sin(t * 0.9) * 2.2 * (P.breath ?? 0.6);

    // the voice's own energy and brightness, eased so a syllable does not snap the face
    S.pEnergy = approach(S.pEnergy, S.energy, 9, dt);
    S.pBright = approach(S.pBright, S.bright, 5, dt);

    // blinking: a randomised schedule, not a metronome. Mean interval follows
    // blinkRate, each gap is re-drawn, and about one blink in six comes back for
    // a quick second one -- that is what makes a face look alive.
    S.nextBlink -= dt;
    if (S.nextBlink <= 0) {
      S.blinkPhase = 1;
      S.blinks += 1;
      S.blink = 0.0001;
      const rate = clamp(P.blinkRate ?? 0.5, 0, 1);
      const mean = lerp(6.2, 1.4, rate);
      S.nextBlink = mean * rnd(0.50, 1.60);
      S.doubleBlink = Math.random() < 0.16 ? 1 : 0;
    }
    if (S.blinkPhase > 0) {
      const k = 1 - Math.abs(S.blinkPhase - 0.5) * 2;      // 0->1->0
      S.blink = k;
      S.blinkPhase = Math.max(0, S.blinkPhase - dt * 7.5);
      if (S.blinkPhase === 0) {
        S.blink = 0;
        if (S.doubleBlink) {
          S.doubleBlink = 0;
          S.nextBlink = rnd(0.12, 0.26);
        }
      }
    } else S.blink = approach(S.blink, 0, 20, dt);

    // brows: slow asymmetric drift plus an occasional flash, so the face is
    // never perfectly still above the eyes
    const bm = P.browMotion ?? 0.65;
    S.nextBrow -= dt;
    if (S.nextBrow <= 0) {
      S.nextBrow = rnd(1.1, 4.4);
      S.browTL = rnd(-0.9, 1.0) * bm;
      S.browTR = rnd(-0.9, 1.0) * bm;
    }
    S.browL = approach(S.browL, S.browTL, 4.5, dt);
    S.browR = approach(S.browR, S.browTR, 4.5, dt);
    // nostrils: they ride the breath, and flare now and then on their own
    const nf = P.nostrilFlare ?? 0.6;
    S.nextNostril -= dt;
    let nTarget = 0.14 + 0.20 * (0.5 + 0.5 * Math.sin(t * 0.9)) + 0.22 * S.listen;
    if (S.aperture > 0.05) nTarget += 0.25 * S.aperture;
    if (S.nextNostril <= 0) { S.nextNostril = rnd(2.2, 6.8); S.burst = 1; }
    S.burst = approach(S.burst || 0, 0, 3.2, dt);   // a flare lasts ~0.3 s, not one frame
    nTarget += 0.85 * (S.burst || 0);
    S.nostril = approach(S.nostril, nTarget * nf, 9, dt);

    // ears: a small independent twitch, one side at a time
    // ears: a slow, small rise and fall, each side on its own phase. No twitching --
    // the motion is continuous, the way ears move while someone is listening.
    const em = clamp(P.earMotion ?? 0.5, 0, 1);
    S.earL = em * (0.5 + 0.5 * Math.sin(t * 0.72));
    S.earR = em * (0.5 + 0.5 * Math.sin(t * 0.61 + 1.7));

    S.nextFlash -= dt;
    if (S.nextFlash <= 0) {
      S.nextFlash = rnd(5.0, 15.0);
      S.flash = bm > 0.05 ? 1 : 0;
    }
    S.flash = approach(S.flash, 0, 3.0, dt);
    if (S.state === 'thinking') S.flash = Math.max(S.flash, 0.25);

    // gaze: saccades between small targets, plus a slow drift
    S.nextSaccade -= dt;
    if (S.nextSaccade <= 0) {
      S.nextSaccade = rnd(1.1, 3.8);
      // most saccades are horizontal: eyes track across the room, not just up and down
      const horiz = Math.random() < 0.72;
      S.tgx = rnd(-1, 1);
      S.tgy = horiz ? rnd(-0.22, 0.22) : rnd(-0.6, 0.6);
    }
    const gm = P.gaze ?? 0.55;
    S.gazeX = approach(S.gazeX, S.tgx * gm, 6, dt);
    S.gazeY = approach(S.gazeY, S.tgy * gm, 6, dt);

    // audio envelope -> mouth
    const amp = FIXED_AMP !== null ? FIXED_AMP : S.amp;
    const talking = S.state === 'speaking';
    const target = talking ? clamp(0.10 + amp * 2.4, 0, 1) : 0;
    S.aperture = approach(S.aperture, target, talking ? 22 : 9, dt);

    S.listen = approach(S.listen, S.state === 'listening' ? 1 : 0, 7, dt);
    S.think = approach(S.think, S.state === 'thinking' ? 1 : 0, 5, dt);

    // state-dependent face
    const eyeT = (S.state === 'listening' ? 1.14 : S.state === 'thinking' ? 0.94 : 1) * (1 + S.think * 0.02);
    const irisT = S.state === 'listening' ? 1.14 : 1;
    look.eye = approach(look.eye, eyeT, 6, dt);
    look.iris = approach(look.iris, irisT, 6, dt);
    look.brow = approach(look.brow, S.state === 'listening' ? 1 : S.state === 'thinking' ? 0.45 : 0, 6, dt);
    look.speed = S.state === 'thinking' ? 2.1 : S.state === 'listening' ? 0.7 : 1;

    // hologram flicker
    S.nextFlick -= dt;
    if (S.nextFlick <= 0) {
      S.nextFlick = rnd(1.2, 5.5);
      S.flick = rnd(0.86, 1.0);
    } else {
      S.flick = approach(S.flick, 1, 9, dt);
    }
  }

  /* ---------------------------------------------------------------- head path */
  function jawDrop(v) {
    const a = S.aperture * (P.jawDrop ?? 1);
    if (a < 0.01) return 0;
    const vM = P.mouthY ?? 0.79;
    const k = clamp((v - vM) / (1 - vM), 0, 1);
    return a * dV(0.020) * Math.pow(k, 1.35);
  }

  function headPath() {
    const ring = [];
    for (const [u, v] of G.pts) ring.push([ux(u), vy(v) + jawDrop(v)]);
    for (let i = G.pts.length - 1; i >= 1; i--) {
      const [u, v] = G.pts[i];
      if (u === 0) continue;                       // a pointed crown must not duplicate
      ring.push([ux(-u), vy(v) + jawDrop(v)]);
    }
    const n = ring.length;
    const p = new Path2D();
    p.moveTo(ring[0][0], ring[0][1]);
    for (let i = 0; i < n; i++) {
      const p0 = ring[(i - 1 + n) % n], p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
      p.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1],
      );
    }
    p.closePath();
    return p;
  }

  /* ---------------------------------------------------------------- circuit */
  // A board etched into the face: orthogonal and 45-degree traces inside the silhouette,
  // pads at the bends, and electrons running along the copper.
  const CIRCUIT = { traces: [], ready: false, glow: null };

  function buildCircuit() {
    CIRCUIT.traces = [];
    const geo = headPath();
    const scratch = document.createElement('canvas').getContext('2d');
    const inside = (x, y) => scratch.isPointInPath(geo, x, y);
    const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    const density = clamp(P.circuitDensity ?? 1, 0.2, 2.5);
    const want = Math.round(34 * density);
    let guard = 0;

    while (CIRCUIT.traces.length < want && guard++ < want * 20) {
      const u0 = rnd(-0.72, 0.72), v0 = rnd(0.10, 0.90);
      if (!inside(ux(u0), vy(v0))) continue;
      const pts = [[ux(u0), vy(v0)]];
      let dir = Math.floor(Math.random() * 8);
      const segs = 3 + Math.floor(Math.random() * 5);
      for (let i = 0; i < segs; i++) {
        const step = rnd(0.09, 0.22);
        const [, ] = dirs[dir];
        const nx = pts[pts.length - 1][0] + dU(dirs[dir][0] * step);
        const ny = pts[pts.length - 1][1] + dV(dirs[dir][1] * step * 0.85);
        if (!inside(nx, ny)) break;
        pts.push([nx, ny]);
        if (Math.random() < 0.32) dir = (dir + (Math.random() < 0.5 ? 1 : 7)) % 8;
      }
      if (pts.length < 3) continue;

      let len = 0;
      const acc = [0];
      for (let i = 1; i < pts.length; i++) {
        len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        acc.push(len);
      }
      const nEl = Math.random() < 0.75 ? 1 : 2;
      const electrons = [];
      for (let k = 0; k < nEl; k++) electrons.push({ s0: rnd(0, len), v: rnd(0.55, 1.35) });
      CIRCUIT.traces.push({ pts, acc, len, electrons });
    }

    // a soft sprite for the electrons, built once per palette
    const g = document.createElement('canvas');
    g.width = g.height = 64;
    const gc = g.getContext('2d');
    const rg = gc.createRadialGradient(32, 32, 1, 32, 32, 32);
    rg.addColorStop(0, rgba(COL.core, 1));
    rg.addColorStop(0.25, rgba(COL.main, 0.85));
    rg.addColorStop(1, rgba(COL.main, 0));
    gc.fillStyle = rg;
    gc.fillRect(0, 0, 64, 64);
    CIRCUIT.glow = g;
    CIRCUIT.ready = true;
  }

  function pointAt(trace, s) {
    const { pts, acc } = trace;
    let i = 1;
    while (i < acc.length - 1 && acc[i] < s) i++;
    const span = acc[i] - acc[i - 1] || 1;
    const k = clamp((s - acc[i - 1]) / span, 0, 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k,
            pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
  }

  function drawCircuit(hp, t) {
    if (!CIRCUIT.ready) buildCircuit();
    const glow = P.glow ?? 1;
    const speed = P.electronSpeed ?? 1;
    ctx.save();
    ctx.clip(hp);

    // traces
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const tr of CIRCUIT.traces) {
      ctx.strokeStyle = rgba(COL.main, 0.16 * glow);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(tr.pts[0][0], tr.pts[0][1]);
      for (let i = 1; i < tr.pts.length; i++) ctx.lineTo(tr.pts[i][0], tr.pts[i][1]);
      ctx.stroke();
      // pads at the bends
      ctx.fillStyle = rgba(COL.main, 0.22 * glow);
      for (const [x, y] of tr.pts) {
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, TAU);
        ctx.fill();
      }
    }

    // electrons
    for (const tr of CIRCUIT.traces) {
      for (const e of tr.electrons) {
        const sHead = (e.s0 + e.v * speed * 90 * t) % tr.len;
        for (let k = 3; k >= 0; k--) {
          const s2 = sHead - k * 3.2;
          if (s2 < 0) continue;
          const [x, y] = pointAt(tr, s2);
          const r = k === 0 ? 5.5 : 4 - k * 0.6;
          ctx.globalAlpha = k === 0 ? 0.95 : 0.30 * (1 - k / 4);
          ctx.drawImage(CIRCUIT.glow, x - r, y - r, r * 2, r * 2);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ---------------------------------------------------------------- face effects */
  // Effect 0 is the code rain (drawn below); 1 is the old latitude/longitude shell,
  // 2 is drifting motes, 3 is bare glass.
  const MOTES = { list: [], ready: false };

  function buildMotes() {
    MOTES.list = [];
    const n = 160;
    for (let i = 0; i < n; i++) {
      MOTES.list.push({
        u: rnd(-0.95, 0.95), v: rnd(0.04, 0.98),
        r: rnd(0.6, 2.1), sp: rnd(0.010, 0.045), ph: rnd(0, TAU),
      });
    }
    MOTES.ready = true;
  }

  function drawWire(hp, t) {
    const glow = P.glow ?? 1;
    ctx.save();
    ctx.clip(hp);
    ctx.globalCompositeOperation = 'lighter';
    const wd = clamp(P.wireDensity ?? 1, 0.3, 2.2);
    const lat = Math.round(18 * wd);
    for (let i = 1; i < lat; i++) {
      const v = i / lat;
      const hw = halfWidth(v) * 0.985;
      const sag = dV(0.012) * (0.4 + 0.6 * Math.sin(Math.PI * v));
      const g = ctx.createLinearGradient(ux(-hw), 0, ux(hw), 0);
      g.addColorStop(0, rgba(COL.main, 0.02));
      g.addColorStop(0.14, rgba(COL.main, 0.16 * glow));
      g.addColorStop(0.5, rgba(COL.main, 0.06 * glow));
      g.addColorStop(0.86, rgba(COL.main, 0.16 * glow));
      g.addColorStop(1, rgba(COL.main, 0.02));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ux(-hw), vy(v));
      ctx.quadraticCurveTo(ux(0), vy(v) + sag, ux(hw), vy(v));
      ctx.stroke();
    }
    const merid = Math.max(3, Math.round(7 * wd));
    for (let j = 1; j <= merid; j++) {
      const u0 = Math.cos(Math.PI * j / (merid + 1));
      ctx.beginPath();
      for (let i = 0; i <= 44; i++) {
        const v = i / 44;
        const x = ux(u0 * halfWidth(v));
        const y = vy(v);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = rgba(COL.main, 0.07 * glow);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // a slow scan band, so a static shell still has life
    const k = (t * 0.06 * clamp(P.wireSweep ?? 1, 0.2, 3)) % 1;
    const y = vy(0.02 + k * 0.96);
    const sg = ctx.createLinearGradient(0, y - dV(0.05), 0, y + dV(0.02));
    sg.addColorStop(0, rgba(COL.main, 0));
    sg.addColorStop(0.8, rgba(COL.core, 0.18));
    sg.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = sg;
    ctx.fillRect(ux(-1.05), y - dV(0.05), dU(2.1), dV(0.07));
    ctx.restore();
  }

  function drawMotes(hp, t) {
    if (!MOTES.ready) buildMotes();
    const amt = Math.min(1.4, 0.6 + (P.glow ?? 1) * 0.4);
    const count = Math.min(MOTES.list.length, Math.round(MOTES.list.length * clamp(P.moteCount ?? 1, 0.1, 2)));
    const mSpeed = clamp(P.moteSpeed ?? 1, 0.2, 3);
    ctx.save();
    ctx.clip(hp);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const m = MOTES.list[i];
      const v = 0.98 - (((0.98 - m.v) + t * m.sp * mSpeed) % 0.96);   // drifts upward
      const hw = halfWidth(v) * 0.94;
      const x = ux(m.u * hw);
      const y = vy(v);
      const a = (0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.7 + m.ph))) * amt;
      ctx.fillStyle = rgba(COL.main, a);
      ctx.beginPath();
      ctx.arc(x, y, m.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- backdrop */

  /* ------------------------------------------------------------- background */
  // The backdrop mirrors whichever shell effect is selected: same idiom, viewport
  // scale, dimmed by `bgLevel`. It is drawn BEFORE the head, and the shell is opaque,
  // so the part that falls behind the face is hidden for free — the background never
  // needs to know where the head is, and none of it can leak into the face.
  const BG = {
    motes: [], traces: [], cols: [], cv: null, c: null, last: -1, ready: false,
    w: 0, h: 0, ch: 26, cw: 16, CHARS: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<>[]{}/\\|=+-*:.',
  };

  function buildBgEffect() {
    BG.motes = [];
    const n = Math.round(44 * clamp(P.moteCount ?? 1, 0.2, 2));
    for (let i = 0; i < n; i++) {
      BG.motes.push({ x: Math.random(), y: Math.random(), r: 0.7 + 1.5 * Math.random(),
                      sp: 0.004 + 0.016 * Math.random(), ph: Math.random() * TAU });
    }

    // board traces: a coarse orthogonal/45° walk across the viewport. No head test —
    // the opaque shell hides whatever passes behind it.
    BG.traces = [];
    const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    const step = VH * 0.052;
    const want = Math.round(18 * clamp(P.circuitDensity ?? 1, 0.3, 2.5));
    for (let i = 0; i < want; i++) {
      let x = Math.random() * VW, y = Math.random() * VH;
      let d = Math.floor(Math.random() * 8);
      const pts = [[x, y]];
      const legs = 6 + Math.floor(Math.random() * 6);
      for (let k = 0; k < legs; k++) {
        if (Math.random() < 0.45) d = (d + (Math.random() < 0.5 ? 1 : 7)) % 8;
        const nx = x + dirs[d][0] * step, ny = y + dirs[d][1] * step;
        if (nx < -step || nx > VW + step || ny < -step || ny > VH + step) break;
        x = nx; y = ny; pts.push([x, y]);
      }
      if (pts.length > 1) BG.traces.push({ pts, ph: Math.random(), sp: 0.15 + 0.35 * Math.random() });
    }

    const ch = Math.max(14, VH * 0.030);
    const cw = ch * 0.62;
    const cv = BG.cv || document.createElement('canvas');
    const dpr = DPR || 1;
    cv.width = Math.round(VW * dpr); cv.height = Math.round(VH * dpr);
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(BG, { cv, c, ch, cw, w: VW, h: VH, ready: true, last: -1 });
    BG.cols = [];
    const nc = Math.max(1, Math.floor(VW / cw));
    for (let i = 0; i < nc; i++) {
      const h1 = hash01(i * 4.31), h2 = hash01(i * 9.17 + 7.3), h3 = hash01(i * 2.77 + 19.1);
      BG.cols.push({ x: i * cw, seed: h1, speed: 0.35 + 0.8 * h2, len: 4 + Math.round(14 * h3) });
    }
  }

  function drawBgEffect(t) {
    const level = clamp(P.bgLevel ?? 0.35, 0, 1);
    if (level < 0.01 || OFF.has('bg')) return;
    const effect = clamp(Math.round(P.effect ?? 0), 0, 4);
    if (effect === 2) return;                       // clean glass: nothing in the background either
    if (!BG.ready) buildBgEffect();
    const glow = P.glow ?? 1;
    const cx = HEAD.cx, cy = vy(0.55);

    ctx.save();
    if (effect === 0) {
      // wireframe room: a receding perspective floor rather than a dome around the head.
      // Concentric rings at screen scale read as horizontal bands; a grid with a horizon
      // reads as a room the head is standing in, which is what "the background is the
      // same effect" has to mean once the effect is a mesh.
      const horizon = VH * 0.72;
      ctx.strokeStyle = rgba(COL.main, 0.13 * level * glow);
      ctx.lineWidth = 1;
      const cols = 26;
      for (let k = -cols; k <= cols; k++) {          // verticals fanning toward the horizon
        ctx.beginPath();
        ctx.moveTo(VW * 0.5 + k * (VW * 0.012), horizon);
        ctx.lineTo(VW * 0.5 + k * (VW * 0.115), VH);
        ctx.stroke();
      }
      const scroll = (t * 0.22) % 1;                 // rows crawl toward the viewer
      for (let i = 0; i <= 22; i++) {
        const q = ((i + scroll) / 22);
        const y = horizon + Math.pow(q, 2.35) * (VH - horizon);
        ctx.globalAlpha = clamp(1 - q * 0.85, 0.15, 1);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(VW, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'lighter';
      const hz = ctx.createLinearGradient(0, horizon - VH * 0.06, 0, horizon + VH * 0.02);
      hz.addColorStop(0, rgba(COL.main, 0));
      hz.addColorStop(1, rgba(COL.core, 0.10 * level * glow));
      ctx.fillStyle = hz;
      ctx.fillRect(0, horizon - VH * 0.06, VW, VH * 0.08);
    } else if (effect === 1) {
      // particles: the same motes, spread over the room
      ctx.globalCompositeOperation = 'lighter';
      for (const m of BG.motes) {
        const y = ((m.y - t * m.sp) % 1 + 1) % 1;
        const a = (0.18 + 0.22 * Math.abs(Math.sin(t * 0.9 + m.ph))) * level * glow;
        ctx.fillStyle = rgba(COL.main, a);
        ctx.fillRect(m.x * VW, y * VH, m.r, m.r);
      }
    } else if (effect === 3) {
      // circuit: the same board idiom, drawn as a backplane behind the face
      ctx.strokeStyle = rgba(COL.main, 0.12 * level * glow);
      ctx.lineWidth = 1;
      for (const tr of BG.traces) {
        ctx.beginPath();
        ctx.moveTo(tr.pts[0][0], tr.pts[0][1]);
        for (let i = 1; i < tr.pts.length; i++) ctx.lineTo(tr.pts[i][0], tr.pts[i][1]);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'lighter';
      for (const tr of BG.traces) {
        const segs = tr.pts.length - 1;
        const s = ((t * tr.sp * 0.25 + tr.ph) % 1) * segs;
        const i = Math.min(segs - 1, Math.floor(s)), f = s - i;
        const x = lerp(tr.pts[i][0], tr.pts[i + 1][0], f), y = lerp(tr.pts[i][1], tr.pts[i + 1][1], f);
        const eg = ctx.createRadialGradient(x, y, 0, x, y, 4 * (1 + level));
        eg.addColorStop(0, rgba(COL.core, 0.34 * level * glow));
        eg.addColorStop(1, rgba(COL.main, 0));
        ctx.fillStyle = eg;
        ctx.fillRect(x - 5 * (1 + level), y - 5 * (1 + level), 10 * (1 + level), 10 * (1 + level));
      }
    } else if (effect === 4) {
      // matrix: the glyph rain fills the room, the face occludes its own part of it
      if (BG.last < 0 || t - BG.last >= 1 / 12) {
        BG.last = t;
        const c = BG.c;
        c.clearRect(0, 0, BG.w, BG.h);
        c.font = `${Math.round(BG.ch * 0.94)}px "JetBrainsMono Nerd Font", "DejaVu Sans Mono", monospace`;
        c.textBaseline = 'top';
        const frame = Math.floor(t * 10);
        for (const col of BG.cols) {
          const span = BG.h + (col.len + 1) * BG.ch;
          const head = ((col.seed * span) + t * col.speed * BG.ch * 6) % span - col.len * BG.ch;
          for (let k = 0; k <= col.len; k++) {
            const y = head - k * BG.ch;
            if (y < -BG.ch || y > BG.h) continue;
            const gi = Math.floor(hash01(col.x * 0.61 + k * 11.3 + (frame % 41) * 77.7) * BG.CHARS.length);
            const a = (k === 0 ? 0.55 : 0.34 * Math.pow(1 - k / (col.len + 1), 1.7)) * level;
            c.fillStyle = rgba(k === 0 ? COL.core : COL.main, a);
            c.fillText(BG.CHARS[gi], col.x, y);
          }
        }
      }
      ctx.drawImage(BG.cv, 0, 0, BG.w, BG.h);
    }
    ctx.restore();
  }

  function drawBackdrop(t) {
    const bg = ctx.createRadialGradient(VW * 0.5, VH * 0.42, 0, VW * 0.5, VH * 0.52, Math.max(VW, VH) * 0.78);
    bg.addColorStop(0, 'rgb(4,16,22)');
    bg.addColorStop(0.5, 'rgb(2,9,13)');
    bg.addColorStop(1, 'rgb(1,4,6)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, VW, VH);



    // horizon glow, so the head has a floor to stand on
    const horizon = VH * 0.80;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const hg = ctx.createLinearGradient(0, horizon - VH * 0.05, 0, horizon + VH * 0.10);
    hg.addColorStop(0, rgba(COL.main, 0));
    hg.addColorStop(0.5, rgba(COL.main, 0.06));
    hg.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = hg;
    ctx.fillRect(0, horizon - VH * 0.05, VW, VH * 0.15);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- projector */
  function drawProjector(t) {
    const baseY = vy(1.16);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const k = (t * 0.22 + i / 3) % 1;
      const rx = dU(0.62) * (0.7 + k * 0.5);
      const ry = dV(0.055) * (0.7 + k * 0.5);
      ctx.strokeStyle = rgba(COL.main, 0.20 * (1 - k) * (0.5 + 0.5 * (P.glow ?? 1)));
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(HEAD.cx, baseY, rx, ry, 0, 0, TAU);
      ctx.stroke();
    }
    const ug = ctx.createRadialGradient(HEAD.cx, baseY, 0, HEAD.cx, baseY, dU(0.9));
    ug.addColorStop(0, rgba(COL.main, 0.16));
    ug.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = ug;
    ctx.beginPath();
    ctx.ellipse(HEAD.cx, baseY, dU(0.9), dV(0.14), 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- ears */
  function drawEars() {
    for (const side of [-1, 1]) {
      const vTop = P.earY ?? 0.44;
      const size = P.earSize ?? 1.1;
      const out = P.earOut ?? 0.55;
      const midV = vTop + 0.095 * size;
      const hh = dV(0.095 * size);
      const hw = dU(0.040 * size + 0.014 * out);
      const x = ux(side * halfWidth(midV)) + side * dU(0.004 + 0.008 * out);
      const cyE = vy(midV);

      const amp = clamp(P.earMotion ?? 0.5, 0, 1);
      const tw = (side < 0 ? S.earL : S.earR) * amp;
      ctx.save();
      // a small, slow rise and fall -- no snap, no twitch
      ctx.translate(x + side * dU(0.006) * tw, cyE - dV(0.020) * tw);
      // Tilt is mirrored with the shape: the scale(field) below already flips this ear, so the
      // rotation carries the same side factor or both ears lean the same way on screen.
      ctx.rotate(-((P.earTilt ?? 0.1) + 0.05 * tw) * side);
      ctx.scale(side, 1);

      // shell
      ctx.beginPath();
      ctx.ellipse(0, 0, hw, hh, 0, 0, TAU);
      ctx.fillStyle = `rgba(1,7,10,${0.60 + 0.30 * (P.fill ?? 0.86)})`;
      ctx.fill();
      ctx.strokeStyle = rgba(COL.main, 0.62);
      ctx.lineWidth = 1.4;
      ctx.shadowColor = rgba(COL.main, 0.55);
      ctx.shadowBlur = 10 * (P.glow ?? 1);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // helix
      ctx.strokeStyle = rgba(COL.main, 0.34);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(-hw * 0.18, -hh * 0.05, hw * 0.58, hh * 0.66, 0, -0.5, Math.PI * 1.05);
      ctx.stroke();
      // antihelix
      ctx.strokeStyle = rgba(COL.main, 0.26);
      ctx.beginPath();
      ctx.ellipse(-hw * 0.20, hh * 0.08, hw * 0.34, hh * 0.40, 0, 0.15, Math.PI * 1.25);
      ctx.stroke();
      // concha shadow
      ctx.fillStyle = 'rgba(0,4,6,0.55)';
      ctx.beginPath();
      ctx.ellipse(-hw * 0.28, hh * 0.10, hw * 0.26, hh * 0.28, 0, 0, TAU);
      ctx.fill();
      // lobe
      ctx.strokeStyle = rgba(COL.main, 0.30);
      ctx.beginPath();
      ctx.arc(-hw * 0.20, hh * 0.66, hw * 0.32, 0.05, Math.PI - 0.15);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- shell */

  const hash01 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  /* ---------------------------------------------------------------- matrix */
  // Glyph rain, rebuilt on the rules the first attempt earned: the shell above is dark and
  // OPAQUE (a translucent one turns the face into a window onto the room's glyphs), one
  // glyph per cell so a trail is characters and not a smear, and a single capped additive
  // pass. Drawn into an offscreen canvas at 12 Hz and blitted: drawing every cell every
  // frame at 60 Hz halves the frame rate.
  const MATRIX = {
    cv: null, c: null, cols: [], x0: 0, y0: 0, w: 0, h: 0, ch: 16, cw: 10, last: -1, ready: false,
    CHARS: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<>[]{}/\\|=+-*:.',
  };

  function buildMatrix() {
    const dpr = DPR || 1;
    const ch = Math.max(8, dV(0.030) / clamp(P.matrixDensity ?? 1, 0.4, 2.2));
    const cw = ch * 0.60;
    const x0 = ux(-1.14), y0 = vy(-0.13);
    const w = dU(2.32), h = dV(1.38);
    const cv = MATRIX.cv || document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(MATRIX, { cv, c, x0, y0, w, h, ch, cw, ready: true, last: -1 });
    const n = Math.max(1, Math.floor(w / cw));
    MATRIX.cols = [];
    for (let i = 0; i < n; i++) {
      const h1 = hash01(i * 7.13), h2 = hash01(i * 3.71 + 11.7), h3 = hash01(i * 5.19 + 29.3);
      MATRIX.cols.push({ x: i * cw, seed: h1, speed: 0.5 + 1.0 * h2, len: 5 + Math.round(18 * h3) });
    }
  }

  function drawMatrix(hp, t) {
    if (!MATRIX.ready) buildMatrix();
    const trail = clamp(P.matrixTrail ?? 1, 0.2, 2.5);
    const glow = P.glow ?? 1;
    if (MATRIX.last < 0 || t - MATRIX.last >= 1 / 12) {
      MATRIX.last = t;
      const c = MATRIX.c;
      c.clearRect(0, 0, MATRIX.w, MATRIX.h);
      c.font = `${Math.round(MATRIX.ch * 0.94)}px "JetBrainsMono Nerd Font", "DejaVu Sans Mono", monospace`;
      c.textBaseline = 'top';
      const frame = Math.floor(t * 10);          // glyphs step at 10 Hz, columns at 12
      for (const col of MATRIX.cols) {
        const len = Math.round(col.len * trail);
        const span = MATRIX.h + (len + 1) * MATRIX.ch;
        const head = ((col.seed * span) + t * col.speed * MATRIX.ch * 7) % span - len * MATRIX.ch;
        for (let k = 0; k <= len; k++) {
          const y = head - k * MATRIX.ch;
          if (y < -MATRIX.ch || y > MATRIX.h) continue;
          const gi = Math.floor(hash01(col.x * 0.73 + k * 13.77 + (frame % 41) * 91.31) * MATRIX.CHARS.length);
          const a = k === 0 ? 1 : Math.pow(1 - k / (len + 1), 1.7);
          c.fillStyle = k === 0 ? rgba(COL.core, 0.95) : rgba(COL.main, 0.62 * a);
          c.fillText(MATRIX.CHARS[gi], col.x, y);
        }
      }
    }
    ctx.drawImage(MATRIX.cv, MATRIX.x0, MATRIX.y0, MATRIX.w, MATRIX.h);
    // glow pass, capped: the shell behind is opaque, so this stays additive on top of text
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.30 * glow;
    ctx.drawImage(MATRIX.cv, MATRIX.x0, MATRIX.y0, MATRIX.w, MATRIX.h);
    ctx.restore();
  }

  /* ------------------------------------------------------------- matrix pass */
  // Carried over from the first Rynette face, and the reason it read as a
  // hologram instead of smooth glass: the head is a grid of cells and each cell
  // is a fine vertical thread. Three sub-columns per cell with fixed gains
  // [0.52, 1.00, 0.68] produce the striation -- one flat column per cell reads
  // as a barcode instead. Per-column and per-row gains are what stop it looking
  // like a blurred photo on a mesh.
  //
  // The texture does not move with time, so it is built once per resize/pitch
  // and blitted twice a frame: multiply to cut the gaps between threads,
  // lighter at low alpha for the thread glow. Drawing it cell by cell per frame
  // (84 x 112 fillRects at 40 fps) is measurable; this is not.
  const THREAD = { cv: null, ready: false, key: '' };
  const SUB_GAIN = [0.52, 1.00, 0.68];

  function buildThreads(force) {
    const cols = clamp(Math.round(P.matPitch ?? 84), 20, 200);
    const cell = Math.max(3, Math.round(dU(2.04) / cols));
    const rowH = Math.max(3, Math.round(cell * 1.35));
    const x0 = Math.round(ux(-1.02));
    const y0 = Math.round(vy(-0.06));
    const w = Math.max(8, Math.round(dU(2.04)));
    const h = Math.max(8, Math.round(dV(1.20)));
    const key = `${cols}|${cell}|${rowH}|${x0}|${y0}|${w}|${h}`;
    if (!force && THREAD.ready && THREAD.key === key) return;
    THREAD.key = key;

    const cv = THREAD.cv || document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d', { willReadFrequently: true });
    const img = c.createImageData(w, h);
    const data = img.data;
    const gain = clamp(P.matGain ?? 0.7, 0, 1);

    // Tonal quantisation is the other half of the old face's look: each cell gets one
    // of a few fixed levels rather than a continuous gain, which is what stops the
    // grid reading as a blur and makes it read as a quantised portrait. Levels follow
    // a ramp (near-black -> hot), so a column is a tonal chunk, not a brightness value.
    const steps = clamp(Math.round(P.matLevels ?? 5), 1, 9);
    const RAMP = [];
    for (let i = 0; i < steps; i++) {
      RAMP.push(steps === 1 ? 1 : 0.52 + 0.48 * (i / (steps - 1)));
    }
    const pick = (h01) => RAMP[Math.min(steps - 1, Math.floor(h01 * steps))];

    const colVar = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(x / cell);
      const sub = x - ci * cell;
      const k = Math.min(2, Math.floor((sub / cell) * 3));
      const thread = 0.45 + 0.55 * SUB_GAIN[k];            // 0.736 .. 1.0
      const base = 1 - gain * (1 - thread) * 0.92;         // gap cut
      const tone = pick(hash01(ci * 12.9898 + 78.233));
      colVar[x] = clamp(base * (0.42 + 0.58 * tone), 0.2, 1);
    }
    const rows = Math.ceil(h / rowH);
    const rowVar = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      rowVar[r] = 1 - 0.13 * gain * (1 - pick(hash01(r * 3.71 + 5.3)));
    }
    const rowCut = 1 - 0.16 * gain;                        // the line between two rows

    for (let y = 0; y < h; y++) {
      const r = Math.floor(y / rowH);
      const onCut = (y % rowH) === rowH - 1;
      const rv = rowVar[r] * (onCut ? rowCut : 1);
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const v = (colVar[x] * rv * 255) | 0;
        const i = (row + x) * 4;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    Object.assign(THREAD, { cv, x0, y0, w, h, ready: true });
  }

  function drawThreads(t) {
    const amt = clamp(P.matThreads ?? 0, 0, 1);
    if (amt < 0.01 || OFF.has('threads')) return;
    buildThreads(false);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = amt;
    ctx.drawImage(THREAD.cv, THREAD.x0, THREAD.y0, THREAD.w, THREAD.h);
    // A flat additive pass here lifts the whole head by a constant and flattens the
    // key light into mush: the threads must darken the gaps, not brighten the face.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.025 * amt * (P.glow ?? 1);
    ctx.drawImage(THREAD.cv, THREAD.x0, THREAD.y0, THREAD.w, THREAD.h);
    ctx.restore();
  }

  /* --------------------------------------------------------------- front rain */
  // The other half of the old face: glyph rain that falls over the whole frame
  // but never over the portrait. Here it is drawn in front of the room and
  // clipped away from the head with an even-odd path, so the rain passes behind
  // nothing -- it is in the air in front of the face, not on the wall behind it.
  const RAIN = { cv: null, c: null, w: 0, h: 0, ch: 14, cw: 9, cols: [], last: -1, ready: false };

  function buildRain() {
    const ch = Math.max(9, (VH * 0.026) / clamp(P.matRainDensity ?? 1, 0.4, 2.4));
    const cw = ch * 0.62;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = RAIN.cv || document.createElement('canvas');
    cv.width = Math.max(1, Math.round(VW * dpr));
    cv.height = Math.max(1, Math.round(VH * dpr));
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    Object.assign(RAIN, { cv, c, w: VW, h: VH, ch, cw, ready: true, last: -1 });
    RAIN.cols = [];
    const nc = Math.max(1, Math.floor(VW / cw));
    for (let i = 0; i < nc; i++) {
      RAIN.cols.push({
        x: i * cw,
        seed: hash01(i * 3.17 + 1.7),
        speed: 0.55 + 1.10 * hash01(i * 7.73),
        len: 6 + Math.round(22 * hash01(i * 5.31 + 9.1)),
      });
    }
  }

  function drawRainFront(t) {
    const amt = clamp(P.matRain ?? 0, 0, 1);
    if (amt < 0.01 || OFF.has('rain')) return;
    if (!RAIN.ready) buildRain();
    const speed = clamp(P.matRainSpeed ?? 1, 0.1, 3);
    if (RAIN.last < 0 || t - RAIN.last >= 1 / 12) {
      RAIN.last = t;
      const c = RAIN.c;
      c.clearRect(0, 0, RAIN.w, RAIN.h);
      c.font = `${Math.round(RAIN.ch * 0.94)}px "JetBrainsMono Nerd Font", "DejaVu Sans Mono", monospace`;
      c.textBaseline = 'top';
      const frame = Math.floor(t * 10);          // glyphs step at 10 Hz, columns at 12
      for (const col of RAIN.cols) {
        const span = RAIN.h + (col.len + 1) * RAIN.ch;
        const head = ((col.seed * span) + t * col.speed * RAIN.ch * 9 * speed) % span - col.len * RAIN.ch;
        for (let k = 0; k <= col.len; k++) {
          const y = head - k * RAIN.ch;
          if (y < -RAIN.ch || y > RAIN.h) continue;
          const gi = Math.floor(hash01(col.x * 0.77 + k * 17.1 + (frame % 37) * 61.9) * BG.CHARS.length);
          const a = k === 0 ? 1 : Math.pow(1 - k / (col.len + 1), 1.9);
          c.fillStyle = k === 0 ? rgba(COL.core, 0.95) : rgba(COL.main, 0.72 * a);
          c.fillText(BG.CHARS[gi], col.x, y);
        }
      }
    }
    // in front of the room, never in front of the face
    ctx.save();
    const clip = new Path2D();
    clip.rect(0, 0, VW, VH);
    clip.addPath(headPath());
    ctx.clip(clip, 'evenodd');
    ctx.globalAlpha = amt;
    ctx.drawImage(RAIN.cv, 0, 0, RAIN.w, RAIN.h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.26 * amt;
    ctx.drawImage(RAIN.cv, 0, 0, RAIN.w, RAIN.h);
    ctx.restore();
  }

  /* ------------------------------------------------------------ sculpt field */
  // The measurement in compositeCells() can only see what the anatomy drew, and this
  // project's shell is a fairly even dark glass with soft washes -- measuring it alone
  // gives a flat green mask. The first Rynette face had definition because its tone
  // came from a sculpted luminance field: a key light, brow ridge, sunken sockets,
  // cheek volume, nose bridge, lip relief, jaw falling into shadow.
  //
  // So the field comes back, keyed to THIS anatomy's parameters (eyeY, eyeU, noseTop,
  // noseLength, mouthY, cheekbone, jawWidth...), so a slider moves the relief with the
  // feature. It is painted into the anatomy layer as a grey relief map and composited
  // with 'overlay': neutral grey changes nothing, lighter sculpts out, darker cuts in.
  //
  // Built once per resize / param change -- it does not animate -- then blitted by the
  // head's own translate, so breathing still moves it with the face.
  const SCULPT = { cv: null, c: null, w: 0, h: 0, key: '' };

  const g2 = (u, v, cu, cv, su, sv) => {
    const x = (u - cu) / su, y = (v - cv) / sv;
    return Math.exp(-(x * x + y * y) * 0.5);
  };

  function buildSculpt() {
    const cols = clamp(Math.round(P.matPitch ?? 90), 24, 200) * 2;
    const bx = ux(-1.08), by = vy(-0.08), bw = dU(2.16), bh = dV(1.30);
    const rows = Math.max(8, Math.round(bh / (bw / cols)));
    // the key must carry every param the field reads, or sliding the eye line
    // leaves a stale relief map behind the new features
    const key = [cols, rows, bx.toFixed(1), by.toFixed(1),
                 P.eyeY, P.eyeU, P.eyeW, P.noseTop, P.noseLength, P.noseWidth,
                 P.mouthY, P.mouthWidth, P.cheekbone, P.jawWidth, P.browHeight].join('|');
    if (SCULPT.key === key) return;
    SCULPT.key = key;

    const cv2 = SCULPT.cv || document.createElement('canvas');
    SCULPT.cv = cv2;
    cv2.width = cols; cv2.height = rows;
    const c2 = SCULPT.c || (SCULPT.c = cv2.getContext('2d', { willReadFrequently: true }));
    const img = c2.createImageData(cols, rows);
    const out = img.data;

    const eyeY = P.eyeY ?? 0.5;
    const eyeU = P.eyeU ?? 0.42;            // u units, 0..1 half-width apart
    const eyeW = P.eyeW ?? 0.46;
    const noseTop = P.noseTop ?? 0.49;
    const noseLen = P.noseLength ?? 0.17;
    const noseW = P.noseWidth ?? 0.20;
    const mouthY = P.mouthY ?? 0.78;
    const mouthW = P.mouthWidth ?? 0.19;
    const cheek = P.cheekbone ?? 1.0;
    const jaw = P.jawWidth ?? 1.0;
    const browH = P.browHeight ?? 0.056;

    for (let r = 0; r < rows; r++) {
      const v = by + ((r + 0.5) / rows) * bh;
      const vn = (v - HEAD.cy) / HEAD.h + 0.5;          // 0 crown -> 1 chin, in v units
      const hw = Math.max(0.05, halfWidth(clamp(vn, 0, 1)));
      for (let c = 0; c < cols; c++) {
        const x = bx + ((c + 0.5) / cols) * bw;
        const u = (x - HEAD.cx) / (HEAD.w * 0.5);       // -1..1 across the head
        const nx = Math.abs(u) / hw;
        let s = 0.5;

        // rounded volume, then the mass falling away below the cheekbone
        s -= 0.10 * Math.pow(clamp(nx, 0, 1.2), 1.8);
        s -= 0.20 * Math.pow(clamp((vn - 0.66) / 0.34, 0, 1), 1.5);

        // key light from the upper left, and the shadow side on the right
        s += 0.20 * g2(u, vn, -0.18, 0.20, 0.72, 0.17);
        s += 0.26 * g2(u, vn, -0.58, 0.60, 0.36, 0.18);
        s += 0.10 * g2(u, vn, 0.60, 0.58, 0.42, 0.20);
        s -= 0.22 * smoothstep(0.10, 0.85, u) * 0.5;

        // brow ridge, then the sockets under it
        s += 0.10 * g2(u, vn, 0, eyeY - browH * 1.4, 0.95, 0.030);
        s -= 0.16 * g2(u, vn, 0, eyeY - browH * 0.4, 0.95, 0.035);
        for (const side of [-1, 1]) {
          s -= 0.30 * g2(u, vn, side * eyeU, eyeY, eyeW * 0.55, 0.058);
        }

        // cheekbones either side of the nose, and their shadow underneath
        for (const side of [-1, 1]) {
          s += 0.14 * cheek * g2(u, vn, side * 0.62 * cheek, 0.585, 0.26, 0.09);
          s -= 0.12 * g2(u, vn, side * 0.50, 0.70, 0.30, 0.07);
        }

        // nose: bridge highlight, tip, base shadow, nostrils
        s += 0.30 * g2(u, vn, 0, noseTop + noseLen * 0.45, noseW * 0.38, noseLen * 0.85);
        s += 0.22 * g2(u, vn, 0, noseTop + noseLen, noseW * 0.55, 0.028);
        s -= 0.18 * g2(u, vn, 0, noseTop + noseLen * 1.18, noseW * 0.95, 0.020);
        for (const side of [-1, 1]) {
          s -= 0.20 * g2(u, vn, side * noseW * 0.52, noseTop + noseLen * 1.05, 0.035, 0.022);
        }
        s -= 0.10 * g2(u, vn, 0, noseTop + noseLen * 0.5, noseW * 0.12, noseLen * 0.6);

        // lips: the upper lip catches a little light, the lower lip a little more,
        // and the seam under it is the darkest thing on the face
        s += 0.14 * g2(u, vn, 0, mouthY - 0.012, mouthW * 0.95, 0.016);
        s += 0.20 * g2(u, vn, 0, mouthY + 0.020, mouthW * 0.80, 0.020);
        s -= 0.26 * g2(u, vn, 0, mouthY + 0.004, mouthW * 1.00, 0.006);
        s -= 0.12 * g2(u, vn, 0, mouthY + 0.050, mouthW * 0.60, 0.020);

        // chin catch, jaw corners falling into shadow
        s += 0.12 * g2(u, vn, 0, 0.905, 0.42, 0.055);
        for (const side of [-1, 1]) {
          s -= 0.16 * jaw * g2(u, vn, side * 0.72, 0.80, 0.18, 0.10);
        }

        // fade the relief out at the silhouette, or it draws its own hard edge
        s = 0.5 + (s - 0.5) * clamp((1 - nx) / 0.14, 0, 1);
        // ... and then re-centre it as absolute tone: 0.28 is unlit skin, the deltas
        // carry it up to the highlights and down to the shadow side. The cells measure
        // this value directly, so this number is the face's exposure, not a hint.
        // Clamp the field below 1.0 before mapping: the key light, the cheek catch and
        // the cheekbones all add, and where the sum passes 1 the tone saturates into a
        // flat plateau with a hard edge -- visible as polygonal patches once the tone
        // bands are posterised.
        const val = clamp(0.18 + (clamp(s, 0.05, 0.92) - 0.5) * 1.85, 0, 1) * 255;
        const o = (r * cols + c) * 4;
        out[o] = val; out[o + 1] = val; out[o + 2] = val; out[o + 3] = 255;
      }
    }
    c2.putImageData(img, 0, 0);
    SCULPT.bx = bx; SCULPT.by = by; SCULPT.bw = bw; SCULPT.bh = bh;
  }

  function drawSculpt(hp) {
    const amt = clamp(P.matSculpt ?? 1, 0, 1.5);
    if (amt < 0.01) return;
    buildSculpt();
    ctx.save();
    ctx.clip(hp);              // the field belongs to the head, not to the room
    // source-over, not overlay: this map IS the head's tone. Overlaying it on the
    // shell's own washes meant two lighting models fighting, and the cells measured
    // the winner rather than the face.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(1, amt);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(SCULPT.cv, SCULPT.bx, SCULPT.by, SCULPT.bw, SCULPT.bh);
    ctx.restore();
  }

  /* ------------------------------------------------------- cell quantiser */
  // The first Rynette face got its definition from one idea: the portrait is not
  // painted, it is measured. Draw the anatomy, measure it cell by cell, then rebuild
  // it out of quantised tones on a fixed ramp, each cell a fine vertical thread.
  //
  // Here the anatomy being measured is this project's -- shape, shading, eyes, brows,
  // nose, mouth -- and it is rendered onto its own transparent layer first, so the
  // measurement contains no room, no rain and no outline. Every slider therefore still
  // moves the definition: the cells are downstream of the anatomy, not a replacement
  // for it. The vector features are then drawn again on top at full resolution, which
  // is what keeps it a face and not a mosaic.
  const LAYER = { cv: null, c: null };
  const CELLS = { cv: null, c: null, sm: null, smc: null, img: null, colGain: null, cols: 0, rows: 0 };
  const SUBX = 3, SUBY = 2;                  // sub-pixels per cell: the thread profile
  let PORTRAIT = true;

  function rampStops(h, s) {
    // near-black teal -> deep -> matrix green -> hot -> white. Same six-stop shape as
    // the original face, keyed to the hue/sat sliders so the editor still owns colour.
    return [
      [0.00, hsl2rgb(h, s * 0.95, 0.015)],
      [0.18, hsl2rgb(h, s * 0.98, 0.060)],
      [0.40, hsl2rgb(h, s, 0.170)],
      [0.62, hsl2rgb(h, s, 0.360)],
      [0.82, hsl2rgb(h, s * 0.75, 0.640)],
      [0.94, hsl2rgb(h, s * 0.40, 0.840)],
      [1.00, hsl2rgb(h, s * 0.08, 0.980)],
    ];
  }

  function rampAt(L) {
    const r = COL.ramp || (COL.ramp = rampStops(P.hue ?? 186, P.sat ?? 0.78));
    let i = 0;
    while (i < r.length - 2 && L > r[i + 1][0]) i++;
    const p0 = r[i][0], c0 = r[i][1], p1 = r[i + 1][0], c1 = r[i + 1][1];
    const k = p1 > p0 ? clamp((L - p0) / (p1 - p0), 0, 1) : 0;
    return [lerp(c0[0], c1[0], k) | 0, lerp(c0[1], c1[1], k) | 0, lerp(c0[2], c1[2], k) | 0];
  }

  function buildLayer() {
    const layer = LAYER.cv || document.createElement('canvas');
    layer.width = cv.width;
    layer.height = cv.height;
    LAYER.c = layer.getContext('2d');          // transparent: alpha is the silhouette
    LAYER.cv = layer;
  }

  function compositeCells(t) {
    if (!LAYER.c) buildLayer();
    const cols = clamp(Math.round(P.matPitch ?? 90), 24, 200);
    const bx = ux(-1.08), by = vy(-0.08), bw = dU(2.16), bh = dV(1.30);
    const rows = Math.max(4, Math.round(bh / (bw / cols)));

    // 1. measure: downsample the anatomy to one pixel per cell. Drawing with smoothing
    //    on means each cell pixel is the average of what the anatomy actually drew --
    //    the key light, the cheek shadow, a lit iris, the dark of a mouth.
    let sm = CELLS.sm;
    if (!sm) { sm = document.createElement('canvas'); CELLS.sm = sm; }
    if (sm.width !== cols || sm.height !== rows) { sm.width = cols; sm.height = rows; }
    if (!CELLS.smc) CELLS.smc = sm.getContext('2d', { willReadFrequently: true });
    const smc = CELLS.smc;
    smc.clearRect(0, 0, cols, rows);
    smc.imageSmoothingEnabled = true;
    smc.drawImage(LAYER.cv, bx * DPR, by * DPR, bw * DPR, bh * DPR, 0, 0, cols, rows);
    const src = smc.getImageData(0, 0, cols, rows).data;

    // 2. rebuild: one flat tone per cell, drawn as SUBX threads by SUBY rows
    const tw = cols * SUBX, th = rows * SUBY;
    let cc = CELLS.cv;
    if (!cc) { cc = document.createElement('canvas'); CELLS.cv = cc; }
    if (cc.width !== tw || cc.height !== th) {
      cc.width = tw; cc.height = th; CELLS.img = null;
    }
    if (!CELLS.c) CELLS.c = cc.getContext('2d');
    if (!CELLS.img) CELLS.img = CELLS.c.createImageData(tw, th);
    const out = CELLS.img.data;
    out.fill(0);

    const black = clamp(P.matBlack ?? 0.03, 0, 0.45);
    const white = Math.max(black + 0.05, clamp(P.matWhite ?? 0.50, 0, 1.2));
    const levels = clamp(Math.round(P.matLevels ?? 1), 1, 9);
    const gain = clamp(P.matGain ?? 0.8, 0, 1);
    const expo = Math.max(0.2, P.matExposure ?? 1.6);

    // per-column gain: deterministic, so the grid has the texture of cloth rather than
    // of noise. This is what stopped the original face reading as a blurred photo.
    if (!CELLS.colGain || CELLS.colGain.length !== cols) CELLS.colGain = new Float32Array(cols);
    const colGain = CELLS.colGain;
    for (let c = 0; c < cols; c++) colGain[c] = 0.80 + 0.28 * hash01(c * 12.9898 + 78.233);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        const a = src[i + 3] / 255;
        if (a < 0.05) continue;                       // outside the silhouette
        const L = (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255;
        let q = clamp((L - black) / (white - black), 0, 1);
        q = clamp(Math.pow(q, 1 / expo), 0, 1);       // exposure, then quantise
        if (levels > 1) q = Math.round(q * (levels - 1)) / (levels - 1);
        const tone = rampAt(q);
        const dith = 1 + (hash01(r * 7.31 + c * 3.17) - 0.5) * 0.16 * gain;
        const cg = colGain[c] * dith;
        for (let sy = 0; sy < SUBY; sy++) {
          const rowCut = (sy === SUBY - 1 ? 1 - 0.20 * gain : 1);
          for (let sx = 0; sx < SUBX; sx++) {
            const g = (0.45 + 0.55 * SUB_GAIN[sx]) * cg * rowCut;
            const o = ((r * SUBY + sy) * tw + c * SUBX + sx) * 4;
            out[o] = Math.min(255, tone[0] * g);
            out[o + 1] = Math.min(255, tone[1] * g);
            out[o + 2] = Math.min(255, tone[2] * g);
            out[o + 3] = a * 255;
          }
        }
      }
    }
    CELLS.c.putImageData(CELLS.img, 0, 0);

    // 3. blit: smoothing off, or the threads turn into a smear
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cc, bx, by, bw, bh);
    ctx.restore();
  }

  function drawShell(t, hp) {
    const cx = ux(0);
    const glow = P.glow ?? 1;
    const fill = P.fill ?? 0.86;

    ctx.save();
    ctx.clip(hp);

    if (PORTRAIT) {
      // Cell mode draws ONE flat base and nothing else. Every wash, key light and
      // shadow here is an effect of the hologram, and each of them tints the
      // measurement, so the cells stop being the face's tone and become the shell's.
      // The base is mid-dark grey on purpose: 'overlay' sculpts up from a mid tone,
      // and over near-black the relief collapses.
      ctx.fillStyle = '#484848';
      ctx.fillRect(ux(-1.15), vy(-0.15), dU(2.3), dV(1.4));
      ctx.restore();
      return;
    }

    // dark glass body: the head occludes the room behind it
    const bg = ctx.createRadialGradient(cx - dU(0.16), vy(0.34), dU(0.03), cx, vy(0.52), dU(1.15));
    // dark but opaque: the head must occlude the room, or the rain shows through it and
    // the face reads as a ghost standing in front of the code
    bg.addColorStop(0, 'rgba(7,26,34,1)');
    bg.addColorStop(0.45, 'rgba(5,18,24,1)');
    bg.addColorStop(0.82, 'rgba(3,11,15,1)');
    bg.addColorStop(1, 'rgba(2,8,11,1)');
    ctx.fillStyle = bg;
    ctx.fillRect(ux(-1.1), vy(-0.1), dU(2.2), dV(1.2));

    // interior light wash
    const wash = ctx.createLinearGradient(ux(-0.9), vy(0.05), ux(0.9), vy(0.9));
    wash.addColorStop(0, rgba(COL.main, 0.10 * glow));
    wash.addColorStop(0.5, rgba(COL.main, 0.02));
    wash.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = wash;
    ctx.fillRect(ux(-1.1), vy(-0.1), dU(2.2), dV(1.2));

    /* planes: volume, then key light, then the shadow side */
    // top-down falloff: the crown catches light, the jaw falls into shadow
    const topLight = ctx.createLinearGradient(0, vy(0.02), 0, vy(0.95));
    topLight.addColorStop(0, 'rgba(120,220,240,0.10)');
    topLight.addColorStop(0.35, 'rgba(60,160,180,0.04)');
    topLight.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = topLight;
    ctx.fillRect(ux(-1.1), vy(-0.05), dU(2.2), dV(1.1));

    // cheekbone shadows and jaw shelf: what makes a face read as a volume
    for (const sgn of [-1, 1]) {
      const cb = ctx.createRadialGradient(ux(sgn * 0.62), vy(0.585), 1, ux(sgn * 0.62), vy(0.585), dU(0.34));
      cb.addColorStop(0, 'rgba(0,4,7,0.30)');
      cb.addColorStop(1, 'rgba(0,4,7,0)');
      ctx.fillStyle = cb;
      ctx.fillRect(ux(sgn * 0.62 - 0.34), vy(0.44), dU(0.68), dV(0.30));
    }
    const jawShadow = ctx.createLinearGradient(0, vy(0.66), 0, vy(0.99));
    jawShadow.addColorStop(0, 'rgba(0,4,7,0)');
    jawShadow.addColorStop(0.55, 'rgba(0,4,7,0.16)');
    jawShadow.addColorStop(1, 'rgba(0,4,7,0.38)');
    ctx.fillStyle = jawShadow;
    ctx.fillRect(ux(-1), vy(0.62), dU(2), dV(0.40));

    ctx.globalCompositeOperation = 'lighter';
    const key = ctx.createRadialGradient(ux(-0.45), vy(0.20), dU(0.04), ux(-0.35), vy(0.38), dU(1.25));
    key.addColorStop(0, rgba(COL.main, 0.13 * glow));
    key.addColorStop(0.45, rgba(COL.main, 0.05 * glow));
    key.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = key;
    ctx.fillRect(ux(-1.1), vy(-0.05), dU(2.2), dV(1.15));

    for (const [hu, hvv, hr, ha] of [[-0.05, 0.255, 0.42, 0.085], [0.62, 0.60, 0.26, 0.055], [-0.62, 0.60, 0.26, 0.05]]) {
      const hg = ctx.createRadialGradient(ux(hu), vy(hvv), 1, ux(hu), vy(hvv), dU(hr));
      hg.addColorStop(0, rgba(COL.main, ha * glow));
      hg.addColorStop(1, rgba(COL.main, 0));
      ctx.fillStyle = hg;
      ctx.fillRect(ux(hu - hr), vy(hvv - hr), dU(hr * 2), dV(hr * 2));
    }
    ctx.globalCompositeOperation = 'source-over';

    const sh = ctx.createLinearGradient(ux(0.20), 0, ux(1.04), 0);
    sh.addColorStop(0, 'rgba(0,4,7,0)');
    sh.addColorStop(1, 'rgba(0,4,7,0.40)');
    ctx.fillStyle = sh;
    ctx.fillRect(ux(0.15), vy(-0.05), dU(0.95), dV(1.1));
    for (const s of [-1, 1]) {
      const bg2 = ctx.createRadialGradient(ux(s * 0.38), vy((P.eyeY ?? 0.5) - 0.015), 1,
                                           ux(s * 0.38), vy((P.eyeY ?? 0.5) - 0.015), dU(0.34));
      bg2.addColorStop(0, 'rgba(0,4,7,0.22)');
      bg2.addColorStop(1, 'rgba(0,4,7,0)');
      ctx.fillStyle = bg2;
      ctx.fillRect(ux(-1), vy((P.eyeY ?? 0.5) - 0.16), dU(2), dV(0.30));
      const ch = ctx.createRadialGradient(ux(s * 0.60), vy(0.615), 1, ux(s * 0.60), vy(0.615), dU(0.36));
      ch.addColorStop(0, 'rgba(0,4,7,0.20)');
      ch.addColorStop(1, 'rgba(0,4,7,0)');
      ctx.fillStyle = ch;
      ctx.fillRect(ux(-1), vy(0.42), dU(2), dV(0.42));
    }

    // Surface effects and the thread overlay belong to the hologram mode only. In
    // cell mode the grid IS the surface, and the extra passes would be measured into
    // the tone map and turn the face to mush.
    if (!PORTRAIT) {
      const effect = clamp(Math.round(P.effect ?? 0), 0, 4);
      if (effect === 0) drawWire(hp, t);
      else if (effect === 1) drawMotes(hp, t);
      else if (effect === 3) drawCircuit(hp, t);
      else if (effect === 4) drawMatrix(hp, t);
      drawThreads(t);
    }

    // scan band
    const scan = P.scan ?? 0.55;
    if (!PORTRAIT && scan > 0.01 && !OFF.has('scan')) {
      const k = (t * (0.055 + 0.045 * look.speed) + 0.12) % 1;
      const y = vy(0.02 + k * 0.96);
      const hgt = dV(0.085);
      const g = ctx.createLinearGradient(0, y - hgt, 0, y + hgt * 0.35);
      g.addColorStop(0, rgba(COL.main, 0));
      g.addColorStop(0.72, rgba(COL.main, 0.13 * scan * glow));
      g.addColorStop(0.94, rgba(COL.core, 0.22 * scan * glow));
      g.addColorStop(1, rgba(COL.main, 0));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(ux(-1.05), y - hgt, dU(2.1), hgt * 1.35);
      ctx.globalCompositeOperation = 'source-over';
    }

    // cheek / brow modelling: two soft washes, no hard edges
    ctx.globalCompositeOperation = 'lighter';
    for (const s of [-1, 1]) {
      const cg = ctx.createRadialGradient(ux(s * 0.58), vy(0.64), 1, ux(s * 0.58), vy(0.64), dU(0.34));
      cg.addColorStop(0, rgba(COL.main, 0.07 * glow));
      cg.addColorStop(1, rgba(COL.main, 0));
      ctx.fillStyle = cg;
      ctx.fillRect(ux(-1), vy(0.40), dU(2), dV(0.45));
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    // rim light: soft halo + hot core stroke. Skipped in cell mode: the silhouette is
    // the cells themselves, and a stroked outline draws a mask around the face.
    if (!PORTRAIT) {
    ctx.save();
    ctx.strokeStyle = rgba(COL.main, 0.30 * glow * S.flick);
    ctx.lineWidth = 3.4;
    ctx.shadowColor = rgba(COL.main, 0.75);
    ctx.shadowBlur = 26 * glow;
    ctx.stroke(hp);
    ctx.shadowBlur = 0;
    const rg = ctx.createLinearGradient(ux(-1), vy(0), ux(1), vy(1));
    rg.addColorStop(0, rgba(COL.core, 0.85));
    rg.addColorStop(0.45, rgba(COL.main, 0.75));
    rg.addColorStop(1, rgba(COL.dim, 0.55));
    ctx.strokeStyle = rg;
    ctx.lineWidth = 1.4;
    ctx.stroke(hp);
    ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- eyes */
  function almond(hw, hh) {
    const p = new Path2D();
    p.moveTo(-hw, 0);
    p.bezierCurveTo(-hw * 0.46, -hh * 1.32, hw * 0.38, -hh * 1.26, hw, -hh * 0.08);
    p.bezierCurveTo(hw * 0.44, hh * 0.96, -hw * 0.46, hh * 0.90, -hw, 0);
    p.closePath();
    return p;
  }

  function drawEye(side, t) {
    const cx = ux(side * (P.eyeU ?? 0.415));
    const cy = vy(P.eyeY ?? 0.50);
    const w = dU(P.eyeW ?? 0.435);
    const hw = w / 2;
    const baseH = w * 0.34 * (P.eyeOpen ?? 1) * look.eye;
    const hh = Math.max(1.2, (baseH / 2) * (1 - S.blink));
    const glow = P.glow ?? 1;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(side, 1);
    ctx.rotate(-(P.eyeTilt ?? 0.06));

    // socket: dark above, faint bloom around
    const sd = ctx.createRadialGradient(0, -hh * 1.4, 1, 0, -hh * 1.5, hw * 1.25);
    sd.addColorStop(0, 'rgba(0,4,7,0.42)');
    sd.addColorStop(1, 'rgba(0,4,7,0)');
    ctx.fillStyle = sd;
    ctx.fillRect(-hw * 1.5, -hh * 4.2, hw * 3, hh * 3.6);

    const path = almond(hw, hh);

    // opening: dim sclera
    ctx.fillStyle = `rgba(1,7,11,${0.86 + 0.10 * (P.fill ?? 0.86)})`;
    ctx.fill(path);
    const scl = ctx.createLinearGradient(0, -hh * 1.2, 0, hh * 1.0);
    scl.addColorStop(0, rgba(COL.deep, 0.55));
    scl.addColorStop(0.45, rgba(COL.dim, 0.30));
    scl.addColorStop(1, rgba(COL.dim, 0.16));
    ctx.fillStyle = scl;
    ctx.fill(path);

    // iris
    ctx.save();
    ctx.clip(path);
    const ir = Math.min(hh * 1.95, hw * 0.56) * (P.irisSize ?? 1.05) * look.iris;
    // The eye is drawn mirrored (ctx.scale(side, 1)), so a local +x is outward for the
    // right eye and inward for the left. Gaze is a screen direction, so it must be
    // multiplied by side -- otherwise both irises swing outward and the face looks
    // wall-eyed. A small constant convergence (toward the nose) keeps it human.
    const converge = hw * (0.03 + 0.05 * S.listen);
    const gx = side * S.gazeX * hw * 0.42 - converge;
    const gy = S.gazeY * hh * 0.22 - (S.state === 'thinking' ? hh * 0.22 : 0);

    const ig = ctx.createRadialGradient(gx, gy, ir * 0.08, gx, gy, ir);
    ig.addColorStop(0.00, rgba(COL.core, 0.98));
    ig.addColorStop(0.30, rgba(COL.main, 0.95));
    ig.addColorStop(0.72, rgba(COL.dim, 0.92));
    ig.addColorStop(0.94, rgba(COL.deep, 0.95));
    ig.addColorStop(1.00, 'rgba(1,9,12,0.98)');
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.arc(gx, gy, ir, 0, TAU);
    ctx.fill();

    // fibres
    ctx.strokeStyle = rgba(COL.core, 0.26);
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * TAU + t * 0.04;
      ctx.beginPath();
      ctx.moveTo(gx + Math.cos(ang) * ir * 0.30, gy + Math.sin(ang) * ir * 0.30);
      ctx.lineTo(gx + Math.cos(ang) * ir * 0.90, gy + Math.sin(ang) * ir * 0.90);
      ctx.stroke();
    }

    // limbal ring
    ctx.strokeStyle = 'rgba(1,10,14,0.85)';
    ctx.lineWidth = Math.max(1.2, ir * 0.11);
    ctx.beginPath();
    ctx.arc(gx, gy, ir * 0.95, 0, TAU);
    ctx.stroke();

    // pupil
    const pr = ir * (P.pupilSize ?? 0.42);
    ctx.fillStyle = 'rgba(0,3,5,0.96)';
    ctx.beginPath();
    ctx.arc(gx, gy, pr, 0, TAU);
    ctx.fill();

    // catchlight
    ctx.fillStyle = rgba(COL.core, 0.9);
    ctx.beginPath();
    ctx.arc(gx - ir * 0.32, gy - ir * 0.36, Math.max(1, ir * 0.12), 0, TAU);
    ctx.fill();

    // lid shadow across the top of the eye
    const ls = ctx.createLinearGradient(0, -hh * 1.1, 0, hh * 0.1);
    ls.addColorStop(0, 'rgba(0,4,7,0.55)');
    ls.addColorStop(1, 'rgba(0,4,7,0)');
    ctx.fillStyle = ls;
    ctx.fillRect(-hw, -hh * 1.4, hw * 2, hh * 1.5);
    ctx.restore();

    // lids: a dark stroke underneath keeps them readable over bright code
    ctx.strokeStyle = 'rgba(0,3,5,0.75)';
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.bezierCurveTo(-hw * 0.46, -hh * 1.32, hw * 0.38, -hh * 1.26, hw, -hh * 0.08);
    ctx.stroke();
    ctx.strokeStyle = rgba(COL.core, 0.72 * glow);
    ctx.lineWidth = 1.9;
    ctx.lineJoin = 'round';
    ctx.shadowColor = rgba(COL.main, 0.55);
    ctx.shadowBlur = 6 * glow;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.bezierCurveTo(-hw * 0.46, -hh * 1.32, hw * 0.38, -hh * 1.26, hw, -hh * 0.08);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = rgba(COL.main, 0.38);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.bezierCurveTo(hw * 0.44, hh * 0.96, -hw * 0.46, hh * 0.90, -hw, 0);
    ctx.stroke();

    // crease
    ctx.strokeStyle = rgba(COL.main, 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-hw * 0.90, -hh * 1.35);
    ctx.bezierCurveTo(-hw * 0.36, -hh * 2.25, hw * 0.34, -hh * 2.10, hw * 0.96, -hh * 0.75);
    ctx.stroke();

    // corner accents
    ctx.fillStyle = rgba(COL.core, 0.6);
    ctx.beginPath();
    ctx.arc(-hw, 0, 1.5, 0, TAU);
    ctx.fill();

    // lashes: short tapered strokes off the upper lid, longer and denser
    // towards the outer corner
    const lashAmt = clamp(P.lashes ?? 0.9, 0, 2);
    if (lashAmt > 0.02 && !OFF.has('lashes')) {
      const p0 = [-hw, 0];
      const p1 = [-hw * 0.46, -hh * 1.32];
      const p2 = [hw * 0.38, -hh * 1.26];
      const p3 = [hw, -hh * 0.08];
      const at = (t) => {
        const mt = 1 - t;
        return [
          mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0],
          mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1],
        ];
      };
      const dirAt = (t) => {
        const mt = 1 - t;
        const dx = 3 * mt * mt * (p1[0] - p0[0]) + 6 * mt * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
        const dy = 3 * mt * mt * (p1[1] - p0[1]) + 6 * mt * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
        const m = Math.hypot(dx, dy) || 1;
        return [dx / m, dy / m];
      };
      const n = Math.round(6 + 9 * Math.min(1.2, lashAmt));
      const lashLen = w * 0.046 * (P.lashLength ?? 1);
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const t = 0.34 + (0.62 * i) / Math.max(1, n - 1);
        const [x, y] = at(t);
        const [dx, dy] = dirAt(t);
        // outward-and-up normal
        let nx = dy, ny = -dx;
        if (ny > 0) { nx = -nx; ny = -ny; }
        const len = lashLen * (0.45 + 0.85 * t) * (1 - 0.35 * Math.abs(S.blink - 0.5));
        const bend = len * 0.35;
        ctx.strokeStyle = rgba(COL.core, (0.16 + 0.24 * Math.min(1, lashAmt)) * glow);
        ctx.lineWidth = Math.max(0.7, w * 0.0065);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + nx * len * 0.6 + dx * bend, y + ny * len * 0.6 + dy * bend,
                             x + nx * len + dx * bend * 1.4, y + ny * len + dy * bend * 1.4);
        ctx.stroke();
      }
      // a few lower lashes when the setting is hot
      if (lashAmt > 0.8) {
        ctx.strokeStyle = rgba(COL.main, 0.22 * glow);
        for (let i = 0; i < 5; i++) {
          const t = 0.3 + 0.6 * i / 4;
          const x = lerp(-hw * 0.9, hw * 0.85, t);
          const y = hh * 0.92 * (1 - Math.pow(t - 0.5, 2) * 1.2);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + w * 0.012, y + w * 0.018 * (0.6 + 0.6 * t));
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- brows */
  function drawBrow(side) {
    const drift = side < 0 ? S.browL : S.browR;
    const bx = ux(side * (P.eyeU ?? 0.415));
    const by = vy((P.eyeY ?? 0.5) - (P.browHeight ?? 0.062) - look.brow * 0.008
                  - drift * 0.0055 - S.flash * 0.006);
    const len = dU((P.eyeW ?? 0.42) * (P.browLength ?? 1));
    const th = Math.max(0.9, dV(0.0085) * (P.browThickness ?? 0.95));
    const arch = dV(0.020) * (P.browArch ?? 0.45);
    const slant = dV(0.014) * ((P.browSlant ?? 0) + drift * 0.22);
    const glow = P.glow ?? 1;

    const N = 18;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const k = i / N;
      const x = lerp(-len * 0.52, len * 0.54, k);
      const lift = arch * Math.pow(Math.sin(Math.PI * clamp(k * 1.02, 0, 1)), 0.85);
      const y = -lift + slant * (k - 0.5) * 2;
      const taper = 0.30 + 0.70 * Math.pow(Math.sin(Math.PI * clamp(k * 0.94 + 0.03, 0, 1)), 0.65);
      pts.push([x, y, th * taper]);
    }
    ctx.save();
    ctx.translate(bx, by);
    ctx.scale(side, 1);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [x, y, tt] = pts[i];
      i ? ctx.lineTo(x, y - tt * 0.5) : ctx.moveTo(x, y - tt * 0.5);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const [x, y, tt] = pts[i];
      ctx.lineTo(x, y + tt * 0.5);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(-len * 0.5, 0, len * 0.55, 0);
    g.addColorStop(0, rgba(COL.main, 0.50));
    g.addColorStop(0.55, rgba(COL.main, 0.76));
    g.addColorStop(1, rgba(COL.dim, 0.34));
    ctx.fillStyle = 'rgba(2,8,12,0.85)';
    ctx.fill();
    ctx.fillStyle = g;
    ctx.shadowColor = rgba(COL.main, 0.65);
    ctx.shadowBlur = 12 * glow;
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- nose */
  function drawNose() {
    const vRoot = P.noseTop ?? 0.488;
    const vTip = vRoot + (P.noseLength ?? 0.175);
    const wA = P.noseWidth ?? 0.215;
    const shade = P.noseShade ?? 0.65;
    const glow = P.glow ?? 1;

    ctx.save();
    // the nose as a mass, not a line drawing: a soft dark form the rain cannot read through
    const mass = new Path2D();
    mass.moveTo(ux(-wA * 0.26), vy(vRoot));
    mass.quadraticCurveTo(ux(-wA * 0.36), vy((vRoot + vTip) * 0.5), ux(-wA * 0.86), vy(vTip + 0.014));
    mass.quadraticCurveTo(ux(0), vy(vTip + 0.046), ux(wA * 0.86), vy(vTip + 0.014));
    mass.quadraticCurveTo(ux(wA * 0.36), vy((vRoot + vTip) * 0.5), ux(wA * 0.26), vy(vRoot));
    mass.closePath();
    // A hologram has no skin to shade: a dark filled mass reads as a hole in the
    // face, which is exactly what a black teardrop in the middle of the screen looks
    // like. Keep the occlusion under the bridge only, let the edges do the modelling.
    const mg = ctx.createLinearGradient(0, vy(vRoot), 0, vy(vTip + 0.04));
    mg.addColorStop(0, 'rgba(2,8,12,0.06)');
    mg.addColorStop(0.55, 'rgba(2,8,12,0.20)');
    mg.addColorStop(0.92, 'rgba(2,8,12,0.20)');
    mg.addColorStop(1, 'rgba(2,8,12,0.05)');
    ctx.fillStyle = mg;
    ctx.fill(mass);


    // shadow on the far side of the bridge
    const ns = ctx.createLinearGradient(ux(0), vy(vRoot), ux(wA * 0.9), vy(vTip));
    ns.addColorStop(0, 'rgba(0,4,7,0)');
    ns.addColorStop(1, `rgba(0,4,7,${0.13 * shade})`);
    ctx.fillStyle = ns;
    ctx.beginPath();
    ctx.moveTo(ux(0), vy(vRoot + 0.01));
    ctx.quadraticCurveTo(ux(wA * 0.30), vy(vTip - 0.02), ux(wA * 0.55), vy(vTip));
    ctx.lineTo(ux(wA * 0.95), vy(vTip + 0.03));
    ctx.quadraticCurveTo(ux(wA * 0.55), vy(vRoot + 0.02), ux(wA * 0.10), vy(vRoot));
    ctx.closePath();
    ctx.fill();

    // bridge highlight / terminator
    const bg = ctx.createLinearGradient(ux(-wA * 0.28), vy(vRoot), ux(wA * 0.28), vy(vTip));
    bg.addColorStop(0, rgba(COL.core, 0.04 * shade));
    bg.addColorStop(0.55, rgba(COL.main, 0.06 * shade * glow));
    bg.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(ux(-wA * 0.26), vy(vRoot));
    ctx.quadraticCurveTo(ux(-wA * 0.30), vy(vTip - 0.02), ux(-wA * 0.42), vy(vTip));
    ctx.lineTo(ux(wA * 0.42), vy(vTip));
    ctx.quadraticCurveTo(ux(wA * 0.30), vy(vTip - 0.02), ux(wA * 0.26), vy(vRoot));
    ctx.closePath();
    ctx.fill();

    // bridge edges (shadowed, not drawn as wire)
    ctx.strokeStyle = `rgba(0,5,8,${0.30 * shade})`;
    ctx.lineWidth = 1.6;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(ux(sgn * wA * 0.30), vy(vRoot + 0.01));
      ctx.quadraticCurveTo(ux(sgn * wA * 0.34), vy(vRoot + (vTip - vRoot) * 0.60),
                           ux(sgn * wA * 0.42), vy(vTip - 0.012));
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(COL.main, 0.20 * shade * glow);
    ctx.lineWidth = 0.9;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(ux(sgn * wA * 0.22), vy(vRoot + 0.012));
      ctx.quadraticCurveTo(ux(sgn * wA * 0.25), vy(vRoot + (vTip - vRoot) * 0.55),
                           ux(sgn * wA * 0.32), vy(vTip - 0.016));
      ctx.stroke();
    }
    // ala wings: a shaded roll on each side
    for (const sgn of [-1, 1]) {
      const ag = ctx.createRadialGradient(ux(sgn * wA * 0.62), vy(vTip + 0.004), 1,
                                           ux(sgn * wA * 0.62), vy(vTip + 0.004), dU(wA * 0.55));
      ag.addColorStop(0, `rgba(0,5,8,${0.34 * shade})`);
      ag.addColorStop(1, 'rgba(0,5,8,0)');
      ctx.fillStyle = ag;
      ctx.fillRect(ux(sgn * wA * 0.62 - wA * 0.55), vy(vTip - 0.03), dU(wA * 1.1), dV(0.075));
    }
    // tip light
    const tg2 = ctx.createRadialGradient(ux(0), vy(vTip - 0.014), 1, ux(0), vy(vTip - 0.014), dU(wA * 0.55));
    tg2.addColorStop(0, rgba(COL.core, 0.13 * shade * glow));
    tg2.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = tg2;
    ctx.fillRect(ux(-wA), vy(vTip - 0.05), dU(wA * 2), dV(0.07));

    // nostrils
    const nost = P.nostril ?? 0.55;
    if (nost > 0.02) {
      const flare = 1 + 0.55 * S.nostril;          // breathing + the odd flare
      ctx.fillStyle = `rgba(0,4,6,${0.55 * nost})`;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(ux(s * wA * 0.60 * (1 + 0.06 * S.nostril)), vy(vTip + 0.020),
                    dU(wA * 0.15) * flare, dV(0.006) * (0.8 + 0.4 * S.nostril), s * 0.25, 0, TAU);
        ctx.fill();
      }
      // the wing lifts a touch as it flares
      ctx.strokeStyle = rgba(COL.main, (0.26 + 0.10 * S.nostril) * shade);
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(ux(s * wA * 0.44), vy(vTip - 0.006));
        ctx.quadraticCurveTo(ux(s * wA * (1.00 + 0.06 * S.nostril)), vy(vTip - 0.002),
                             ux(s * wA * 0.88), vy(vTip + 0.028 - 0.006 * S.nostril));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- mouth */
  // Lips: two cubic lenses (upper/lower) instead of a sampled polyline. Curves
  // also avoid the sampling loop entirely, which keeps the mouth predictable.
  function drawMouth() {
    const vM = P.mouthY ?? 0.778;
    const mw = dU(P.mouthWidth ?? 0.185);
    const lip = P.lipFullness ?? 1.15;
    const smile = P.smile ?? 0.08;
    const cupid = P.cupid ?? 0.55;
    const glow = P.glow ?? 1;
    const cyM = vy(vM);
    const a = S.aperture;
    const upH = dV(0.0105) * lip;
    const lowH = dV(0.0140) * lip;
    const N = 30;

    // Smile is geometry, not a vertical shift: the corners travel up while the
    // centre of the seam stays put, so the whole mouth bows into an arc. A
    // negative value bows it the other way, into a frown.
    const cornerY = cyM - smile * dV(0.030);
    const centreY = cyM + smile * dV(0.009);
    const mwS = mw * (1 + 0.09 * smile);            // a smile widens the mouth too
    const xAt = (i) => -mwS + (2 * mwS * i) / N;
    const t2 = (x) => Math.pow(Math.abs(x) / mwS, 2);
    const shape = (x) => Math.max(0, 1 - t2(x));
    const seam = (x) => centreY + (cornerY - centreY) * t2(x);
    const notch = (x) => cupid * upH * 0.45 * Math.exp(-Math.pow(x / (mwS * 0.13), 2));
    const upper = (x) => seam(x) - upH * (2.25 + 0.75 * cupid) * shape(x) + notch(x);
    const lower = (x) => seam(x) + lowH * (2.25 + 0.40 * lip) * shape(x);
    const lowerHi = (x) => seam(x) + lowH * (1.05 + 0.20 * lip) * shape(x);

    ctx.save();
    ctx.translate(ux(0), 0);

    // philtrum and mentolabial shadows seat the mouth in the face
    for (const [yc, hgt, alpha] of [[cyM - upH * 3.4, upH * 2.0, 0.16],
                                    [cyM + lowH * 3.2, lowH * 2.2, 0.20]]) {
      const sg = ctx.createLinearGradient(0, yc - hgt * 0.5, 0, yc + hgt * 0.5);
      sg.addColorStop(0, 'rgba(0,4,7,0)');
      sg.addColorStop(0.5, `rgba(0,4,7,${alpha})`);
      sg.addColorStop(1, 'rgba(0,4,7,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-mw * 1.5, yc - hgt, mw * 3, hgt * 2);
    }

    // lip body: enough occlusion to seat the mouth, not a solid black lozenge that
    // punches a hole through the hologram
    ctx.beginPath();
    ctx.moveTo(-mwS, cornerY);
    for (let i = 1; i <= N; i++) { const x = xAt(i); ctx.lineTo(x, upper(x)); }
    for (let i = N; i >= 0; i--) { const x = xAt(i); ctx.lineTo(x, lower(x)); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(2,8,12,0.46)';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-mwS, cornerY);
    for (let i = 1; i <= N; i++) { const x = xAt(i); ctx.lineTo(x, upper(x)); }
    for (let i = N; i >= 0; i--) { const x = xAt(i); ctx.lineTo(x, lower(x)); }
    ctx.closePath();
    const lg = ctx.createLinearGradient(0, cyM - upH * 3, 0, cyM + lowH * 3);
    lg.addColorStop(0, rgba(COL.main, 0.22 * glow));
    lg.addColorStop(0.45, rgba(COL.main, 0.07 * glow));
    lg.addColorStop(0.8, rgba(COL.main, 0.16 * glow));
    lg.addColorStop(1, rgba(COL.main, 0.04 * glow));
    ctx.fillStyle = lg;
    ctx.fill();

    // cavity while speaking
    if (a > 0.02) {
      ctx.beginPath();
      ctx.moveTo(-mwS * 0.96, cornerY);
      for (let i = 1; i <= N; i++) {
        const x = xAt(i) * 0.96;
        ctx.lineTo(x, seam(x) - a * dV(0.016) * shape(x));
      }
      for (let i = N; i >= 0; i--) {
        const x = xAt(i) * 0.96;
        ctx.lineTo(x, seam(x) + a * dV(0.030) * shape(x));
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,3,5,0.96)';
      ctx.fill();
      ctx.save();
      ctx.clip();
      const tg = ctx.createLinearGradient(0, cyM - a * dV(0.02), 0, cyM + a * dV(0.01));
      tg.addColorStop(0, rgba(COL.core, 0.55));
      tg.addColorStop(1, rgba(COL.core, 0));
      ctx.fillStyle = tg;
      ctx.fillRect(-mwS, cyM - a * dV(0.03), mwS * 2, a * dV(0.03));
      ctx.restore();
    }

    // seam: dark line with a thin bright inner edge
    ctx.strokeStyle = 'rgba(0,3,5,0.95)';
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = xAt(i);
      const y = seam(x) - (a > 0.02 ? a * dV(0.016) * shape(x) : 0);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = rgba(COL.core, 0.46 * glow);
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = xAt(i);
      const y = seam(x) - (a > 0.02 ? a * dV(0.016) * shape(x) : 0) - 0.7;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();

    // upper lip ridge and lower lip highlight follow the same arc
    ctx.strokeStyle = rgba(COL.main, 0.30);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = xAt(i);
      i ? ctx.lineTo(x, upper(x)) : ctx.moveTo(x, upper(x));
    }
    ctx.stroke();
    ctx.strokeStyle = rgba(COL.main, 0.20);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = xAt(i);
      i ? ctx.lineTo(x, lowerHi(x)) : ctx.moveTo(x, lowerHi(x));
    }
    ctx.stroke();

    // corners
    ctx.fillStyle = rgba(COL.core, 0.34 * glow);
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sgn * mwS, cornerY, 1.1, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- frame */
  let last = 0;
  let fpsAcc = 0, fpsN = 0;

  let lastPaint = 0;
  const FRAME_MS = 1000 / 40;      // 40 fps is plenty for a face and leaves the
                                  // compositor room to run its own animations
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastPaint < FRAME_MS) return;
    lastPaint = now;
    try {
    let dt = (now - last) / 1000;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.05);
    last = now;
    if (FREEZE !== null) dt = 1 / 60;

    S.t = FREEZE !== null ? FREEZE : S.t + dt;
    const t = S.t;

    // mood: ease in fast when the voice starts, drift out slowly when it stops
    MOOD.blend = approach(MOOD.blend, MOOD.target,
                          MOOD.target > MOOD.blend ? 5.0 : 0.9, dt);
    if (Math.abs(MOOD.blend - MOOD.target) < 0.002) MOOD.blend = MOOD.target;
    P = moodParams();

    updateSenses(dt, t);

    drawBackdrop(t);
    if (!PORTRAIT) drawBgEffect(t);

    PORTRAIT = clamp(Math.round(P.matPortrait ?? 0), 0, 1) === 0;
    const hp = headPath();

    if (PORTRAIT) {
      // pass 1: the anatomy, alone on its own layer
      const lc = LAYER.c;
      lc.setTransform(DPR, 0, 0, DPR, 0, 0);
      lc.clearRect(0, 0, VW, VH);
      ctx = lc;
      ctx.save();
      ctx.translate(0, S.breath);
      drawShell(t, hp);
      drawSculpt(hp);          /* the definition, before it is measured */
      // Ears are drawn with a bright rim + glow, which the measurement turns into
      // glowing tabs at the temples. Dimmed into the anatomy they read as ears again.
      ctx.save();
      ctx.globalAlpha = 0.5;
      drawEars();
      ctx.restore();
      ctx.restore();
      ctx = mainCtx;
      // pass 2: measure it, rebuild it as quantised cells. The vector features are
      // drawn below, on top of this, which is what keeps it reading as a face.
      compositeCells(t);
    }

    ctx.save();
    ctx.translate(0, S.breath);
    if (!PORTRAIT) {
      if (!OFF.has('projector')) drawProjector(t);
      drawShell(t, hp);
      drawEars();
    }

    // thinking ring (under the face, so the features stay on top)
    if (S.think > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(HEAD.cx, HEAD.cy);
      ctx.rotate(t * 0.35);
      ctx.strokeStyle = rgba(COL.main, 0.30 * S.think);
      ctx.lineWidth = 1.4;
      ctx.setLineDash([6, 16]);
      ctx.beginPath();
      ctx.ellipse(0, dV(0.02), dU(0.92), dV(0.62), 0, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // listening pulse at the base
    if (S.listen > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const k = (t * 0.8) % 1;
      ctx.strokeStyle = rgba(COL.main, 0.35 * S.listen * (1 - k));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(HEAD.cx, vy(1.16), dU(0.55 + 0.5 * k), dV(0.05 + 0.04 * k), 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }


    ctx.save();
    ctx.clip(hp);
    // Transparency is the features' own alpha, not the rain's
    ctx.globalAlpha = clamp(P.transparency ?? 1, 0, 1);
    if (!OFF.has('eyes')) { drawEye(-1, t); drawEye(1, t); }
    if (!OFF.has('brows')) { drawBrow(-1); drawBrow(1); }
    if (!OFF.has('nose')) drawNose();
    if (!OFF.has('mouth')) drawMouth();
    ctx.restore();
    ctx.restore();

    // rain in the air in front of the face (skipped over the head by the even-odd clip)
    drawRainFront(t);

    // vignette (cached per resize; scanlines live in CSS, not 360 fillRects a frame)
    // CRT finish: 3-pixel scanlines from a 1x3 pattern (one fillRect, not one per
    // line), then the vignette. The CSS #scan layer keeps the finer grain on top.
    const scanAmt = clamp(P.matScan ?? 0, 0, 1);
    if (scanAmt > 0.01 && !OFF.has('raster')) {
      if (!G.scanPat) {
        const p = document.createElement('canvas');
        p.width = 1; p.height = 3;
        const pc = p.getContext('2d');
        pc.fillStyle = '#000';
        pc.fillRect(0, 0, 1, 1);
        G.scanPat = ctx.createPattern(p, 'repeat');
      }
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.30 * scanAmt;
      ctx.fillStyle = G.scanPat;
      ctx.fillRect(0, 0, VW, VH);
      ctx.restore();
    }

    const vig = clamp(P.matVignette ?? 0.5, 0, 1);
    if (vig > 0.01) {
      if (!G.vignette) {
        G.vignette = ctx.createRadialGradient(VW * 0.5, VH * 0.5, Math.min(VW, VH) * 0.34,
                                               VW * 0.5, VH * 0.5, Math.max(VW, VH) * 0.80);
        G.vignette.addColorStop(0, 'rgba(0,0,0,0)');
        G.vignette.addColorStop(0.62, 'rgba(0,0,0,0.26)');
        G.vignette.addColorStop(1, 'rgba(0,0,0,0.88)');
      }
      ctx.save();
      ctx.globalAlpha = vig;
      ctx.fillStyle = G.vignette;
      ctx.fillRect(0, 0, VW, VH);
      ctx.restore();
    }

    // fps
    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 0.5) { S.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    } catch (err) {
      window.__frameErr = String((err && err.stack) || err);
    }
  }

  /* ---------------------------------------------------------------- api */
  function setParams(next) {
    // next is the tuned look; P is that look plus whatever mood is on top, rebuilt here and
    // every frame so a slider and a mood never fight over the same key
    BASE = Object.assign({}, BASE, next);
    P = moodParams();
    palette();
    layout();
    rebuildGeometry();
    buildMotes();
    buildCircuit();
    buildMatrix();
    buildBgEffect();
    buildThreads(false);
    buildRain();
  }

  window.__face = {
    setParams,
    getParams: () => Object.assign({}, BASE),
    setState(s) {
      if (s && s !== S.state) S.state = s;
      // thinking carries the server's own "curious" tag, so the pose is live before the voice
      MOOD.target = (s === 'speaking' || s === 'thinking') ? 1 : 0;
    },
    setMood(m) { if (m && MOODS[m] && m !== MOOD.name) { MOOD.name = m; } },
    get mood() { return { name: MOOD.name, blend: MOOD.blend, target: MOOD.target }; },
    setAmp(a) { S.amp = clamp(Number(a) || 0, 0, 1); },
    // energy = how loud, bright = where the voice's weight sits in the spectrum
    setProsody(energy, bright) {
      S.energy = clamp(Number(energy) || 0, 0, 1);
      S.bright = clamp(Number(bright) || 0, 0, 1);
    },
    setGaze(x, y) { S.tgx = clamp(Number(x) || 0, -1, 1); S.tgy = clamp(Number(y) || 0, -1, 1);
                   S.gazeX = S.tgx; S.gazeY = S.tgy; S.nextSaccade = 1e9; },
    get stats() {
      return { fps: S.fps, state: S.state, aperture: S.aperture, head: { ...HEAD },
               blinks: S.blinks, blink: S.blink, browL: S.browL, browR: S.browR,
               nostril: S.nostril, earL: S.earL, earR: S.earR,
               gazeX: S.gazeX, gazeY: S.gazeY, smile: P.smile,
               energy: S.pEnergy, bright: S.pBright };
    },
  };

  window.addEventListener('resize', resize);
  addEventListener('orientationchange', resize);

  // boot: schema defaults, then the saved parameters
  fetch('/face/schema.json', { cache: 'no-store' })
    .then((r) => r.json())
    .then((schema) => {
      const defaults = {};
      for (const g of schema.groups) for (const p of g.params) defaults[p.key] = p.default;
      window.__face.schema = schema;
      for (const g of schema.groups) {
        for (const p of g.params) {
          RANGE[p.key] = p.kind === 'select'
            ? [0, Math.max(0, (p.options || []).length - 1)]
            : [p.min, p.max];
        }
      }
      BASE = defaults;
      P = moodParams();
      return fetch('/params', { cache: 'no-store' });
    })
    .then((r) => (r.ok ? r.json() : {}))
    .then((saved) => {
      const clean = {};
      for (const [k, v] of Object.entries(saved || {})) {
        if (typeof v === 'number' && isFinite(v)) clean[k] = v;
      }
      setParams(clean);
      resize();
      document.dispatchEvent(new CustomEvent('face:ready'));
      requestAnimationFrame((n) => { last = n; requestAnimationFrame(frame); });
    })
    .catch(() => { resize(); requestAnimationFrame((n) => { last = n; requestAnimationFrame(frame); }); });
})();
