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
  const ctx = cv.getContext('2d', { alpha: false });

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
  let P = {};                       // parameters (schema defaults, then /params)
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
    layout();
    rebuildGeometry();
    buildRain();
    buildRoom();
    buildMotes();
  }

  /* ---------------------------------------------------------------- anatomy */
  // Right half of the silhouette, crown -> chin. u is the half width at that v.
  // Params bend this one curve; nothing else stores a face.
  const SILHOUETTE = [
    [0.000, 0.000], [0.225, 0.008], [0.450, 0.028], [0.660, 0.062], [0.820, 0.108],
    [0.915, 0.170], [0.955, 0.245], [0.968, 0.320], [0.966, 0.395], [0.958, 0.462],
    [0.944, 0.525], [0.922, 0.585], [0.900, 0.640], [0.884, 0.692], [0.864, 0.744],
    [0.830, 0.796], [0.775, 0.844], [0.690, 0.888], [0.570, 0.928], [0.425, 0.960],
    [0.255, 0.985], [0.100, 0.998], [0.000, 1.000],
  ];

  const G = { pts: [], hw: new Float32Array(257) };

  function rebuildGeometry() {
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
      return [uu, vv];
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

  /* ---------------------------------------------------------------- state */
  const S = {
    state: 'idle',
    t: 0,
    blink: 0, blinkPhase: 0, nextBlink: 2.4, doubleBlink: 0, blinks: 0,
    gazeX: 0, gazeY: 0, tgx: 0, tgy: 0, nextSaccade: 2.0,
    browL: 0, browR: 0, browTL: 0, browTR: 0, nextBrow: 2.2, flash: 0, nextFlash: 6,
    nostril: 0, nextNostril: 3, earL: 0, earR: 0,
    aperture: 0,
    amp: 0,
    breath: 0,
    listen: 0, think: 0,
    flick: 1, nextFlick: 3,
    fps: 60,
  };

  const look = { eye: 1, brow: 0, iris: 1, speed: 1 };

  function updateSenses(dt, t) {
    // breathing: a slow lift of the whole head
    S.breath = Math.sin(t * 0.9) * 2.2 * (P.breath ?? 0.6);

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
    for (let i = G.pts.length - 2; i >= 1; i--) {
      const [u, v] = G.pts[i];
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

  /* ---------------------------------------------------------------- code rain */
  // One shared glyph buffer per frame, drawn twice: dim across the room, brighter
  // inside the head so the face itself is made of falling code. A canvas buffer
  // decays under a destination-out wash, so every glyph leaves its own trail.
  const RAIN = {
    buf: document.createElement('canvas'),
    c: null,
    atlas: document.createElement('canvas'),
    headAtlas: document.createElement('canvas'),
    ac: null,
    glyphW: 16, glyphH: 22, count: 44,
    cols: [], w: 0, h: 0, ready: false, phase: 0,
  };
  const GLYPH_SETS = [
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEF<>[]{}/\\|=+*',
    '01',
    '⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⡀⡁⡂⡃⡄⡅⡆⡇⣀⣁⣂⣃⣄⣅⣆⣇⣿',
    'ᚠᚡᚢᚣᚤᚥᚦᚧᚨᚩᚪᚫᚬᚭᚮᚯᚰᚱᚲᚳᚴᚵᚶᚷᚸᚹᚺᚻᚼᚽᚾᚿᛀᛁᛂᛃᛄᛅᛆᛇᛈᛉᛊᛋᛌᛍᛎᛏᛐᛑᛒᛓ',
    '⎔⎕⌁⌂⌃⌄⌅⌆⌇⌈⌉⌊⌋⌌⌍⌎⌏⌐⌑⌒⌓⌔⌕⌖⌗⌘⌙⌚⌛⌜⌝⌞⌟⌠⌡⌢⌣⌤⌥⌦⌧⌨〈〉⌫⌬',
  ];
  const glyphSet = () => GLYPH_SETS[clamp(Math.round(P.charset ?? 0), 0, GLYPH_SETS.length - 1)];

  function buildRain() {
    RAIN.w = Math.round(VW);
    RAIN.h = Math.round(VH);
    RAIN.buf.width = RAIN.w;
    RAIN.buf.height = RAIN.h;
    RAIN.c = RAIN.buf.getContext('2d');
    RAIN.c.clearRect(0, 0, RAIN.w, RAIN.h);

    // two atlases: body glyphs in the palette colour, and a near-white head set
    // so the leading character of every column burns brighter than its trail
    const gw = RAIN.glyphW, gh = RAIN.glyphH;
    const fonts = `500 ${Math.round(gh * 0.78)}px "JetBrainsMono Nerd Font", monospace`;
    const headCol = hsl2rgb(P.hue ?? 186, (P.sat ?? 0.78) * 0.55, 0.84);
    for (const [canvas, colour] of [[RAIN.atlas, rgba(COL.main, 1)], [RAIN.headAtlas, rgba(headCol, 1)]]) {
      canvas.width = gw * RAIN.count;
      canvas.height = gh;
      const a = canvas.getContext('2d');
      a.clearRect(0, 0, canvas.width, gh);
      a.font = fonts;
      a.textAlign = 'center';
      a.textBaseline = 'middle';
      a.fillStyle = colour;
      const set = glyphSet();
      for (let i = 0; i < RAIN.count; i++) a.fillText(set[(i * 7 + 3) % set.length], i * gw + gw / 2, gh * 0.54);
    }

    const cols = Math.max(24, Math.round(VW / gw));
    RAIN.cols = [];
    for (let i = 0; i < cols; i++) {
      RAIN.cols.push({
        x: i * gw + (gw - gw) / 2,
        y: rnd(-VH, VH),
        sp: rnd(55, 170),
        b: rnd(0.35, 1),
        cell: -1,
      });
    }
    RAIN.ready = true;
  }

  function rainStep(dt, speed) {
    if (!RAIN.ready) return;
    const c = RAIN.c;
    // fade what is already there: this is what turns glyphs into trails
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,0.034)';
    c.fillRect(0, 0, RAIN.w, RAIN.h);
    c.globalCompositeOperation = 'source-over';

    const gw = RAIN.glyphW, gh = RAIN.glyphH;
    for (const col of RAIN.cols) {
      col.y += col.sp * speed * dt;
      if (col.y > RAIN.h + gh) {
        col.y = -rnd(40, VH * 0.9);
        col.sp = rnd(55, 170);       // px per second
        col.b = rnd(0.35, 1);
        col.cell = -1;
      }
      const cell = Math.floor(col.y / gh);
      if (cell !== col.cell) {
        // one glyph per cell, so the trail is discrete characters, not a smear
        col.cell = cell;
        const gi = Math.floor(Math.random() * RAIN.count);
        c.globalAlpha = Math.min(1, col.b);
        c.drawImage(RAIN.atlas, gi * gw, 0, gw, gh, Math.round(col.x), cell * gh, gw, gh);
      }
      // the head itself, brighter and slightly behind the leading cell
      const hi = Math.floor(Math.random() * RAIN.count);
      c.globalAlpha = Math.min(1, 0.55 + col.b * 0.45);
      c.drawImage(RAIN.headAtlas, hi * gw, 0, gw, gh, Math.round(col.x), Math.round(col.y), gw, gh);
    }
    c.globalAlpha = 1;
  }

  function drawRain(alpha, clipPath) {
    if (!RAIN.ready || alpha <= 0.01) return;
    ctx.save();
    if (clipPath) ctx.clip(clipPath);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(RAIN.buf, 0, 0);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- room rain */
  // The room gets its own buffer: short trails and a wider spacing, so it reads as
  // sparse falling characters instead of the face layer's long trails drawn dim --
  // that veil is what looked like a ghost of the matrix.
  const ROOM = {
    cv: document.createElement('canvas'), c: null, cols: [],
    w: 0, h: 0, gw: 14, gh: 20, ready: false, lastCell: 0,
  };

  function buildRoom() {
    ROOM.w = Math.round(VW);
    ROOM.h = Math.round(VH);
    ROOM.cv.width = ROOM.w;
    ROOM.cv.height = ROOM.h;
    ROOM.c = ROOM.cv.getContext('2d');
    ROOM.c.clearRect(0, 0, ROOM.w, ROOM.h);
    ROOM.cols = [];
    const spacing = 30;
    for (let x = 0; x < ROOM.w; x += spacing) {
      ROOM.cols.push({ x, y: rnd(-VH, VH), sp: rnd(40, 120), b: rnd(0.30, 0.85), cell: -1 });
    }
    ROOM.ready = true;
  }

  function stepRoom(dt, speed) {
    if (!ROOM.ready || !RAIN.atlas) return;
    const c = ROOM.c;
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,0.075)';
    c.fillRect(0, 0, ROOM.w, ROOM.h);
    c.globalCompositeOperation = 'source-over';
    const { gw, gh } = ROOM;
    for (const col of ROOM.cols) {
      col.y += col.sp * speed * dt;
      if (col.y > ROOM.h + gh) {
        col.y = -rnd(60, VH * 0.7);
        col.sp = rnd(40, 120);
        col.b = rnd(0.30, 0.85);
        col.cell = -1;
      }
      const cell = Math.floor(col.y / gh);
      if (cell !== col.cell) {
        col.cell = cell;
        const gi = Math.floor(Math.random() * RAIN.count);
        c.globalAlpha = col.b;
        c.drawImage(RAIN.atlas, gi * RAIN.glyphW, 0, RAIN.glyphW, RAIN.glyphH,
                    Math.round(col.x), cell * gh, gw, gh);
      }
    }
    c.globalAlpha = 1;
  }

  function drawRoom(alpha) {
    if (!ROOM.ready || alpha <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(ROOM.cv, 0, 0);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- face effects */
  // Effect 0 is the code rain (drawn below); 1 is the old latitude/longitude shell,
  // 2 is drifting motes, 3 is bare glass.
  const MOTES = { list: [], ready: false };

  function buildMotes() {
    MOTES.list = [];
    const n = 90;
    for (let i = 0; i < n; i++) {
      MOTES.list.push({
        u: rnd(-0.95, 0.95), v: rnd(0.04, 0.98),
        r: rnd(0.6, 2.1), sp: rnd(0.010, 0.045), ph: rnd(0, TAU),
      });
    }
    MOTES.ready = true;
  }

  function drawWire(hp, t) {
    const glow = (P.glow ?? 1) * (0.4 + 0.6 * (P.faceRain ?? 2.6) / 3);
    ctx.save();
    ctx.clip(hp);
    ctx.globalCompositeOperation = 'lighter';
    const lat = 18;
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
    for (let j = 1; j <= 7; j++) {
      const u0 = Math.cos(Math.PI * j / 8);
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
    const k = (t * 0.06) % 1;
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
    const amt = Math.min(1.6, (P.faceRain ?? 2.6) / 2);
    ctx.save();
    ctx.clip(hp);
    ctx.globalCompositeOperation = 'lighter';
    for (const m of MOTES.list) {
      const v = 0.98 - (((0.98 - m.v) + t * m.sp) % 0.96);     // drifts upward
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
  function drawBackdrop(t) {
    const bg = ctx.createRadialGradient(VW * 0.5, VH * 0.42, 0, VW * 0.5, VH * 0.52, Math.max(VW, VH) * 0.78);
    bg.addColorStop(0, 'rgb(4,16,22)');
    bg.addColorStop(0.5, 'rgb(2,9,13)');
    bg.addColorStop(1, 'rgb(1,4,6)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, VW, VH);

    // the room carries the same code when code is the effect; otherwise it stays dim
    const rain = P.rain ?? 0.32;
    const eff = Math.round(P.effect ?? 0);
    if (eff === 0 || eff === 4) {
      if (eff === 4) {
        // distant rain: the same buffer, smaller and dimmer
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, rain * 0.55);
        ctx.translate(VW / 2, VH / 2);
        ctx.scale(0.55, 0.55);
        ctx.translate(-VW / 2, -VH / 2);
        ctx.drawImage(RAIN.buf, 0, 0);
        ctx.restore();
      }
      drawRoom(rain);
    }

    // horizon glow, so the rain has a floor to stand on
    const horizon = VH * 0.80;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const hg = ctx.createLinearGradient(0, horizon - VH * 0.05, 0, horizon + VH * 0.10);
    hg.addColorStop(0, rgba(COL.main, 0));
    hg.addColorStop(0.5, rgba(COL.main, 0.06 * Math.min(1, rain)));
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

  /* ---------------------------------------------------------------- hair */
  const HAIR_STYLES = ['Bald', 'Buzz cut', 'Short', 'Side part', 'Bob', 'Long', 'Topknot', 'Crest', 'Curly'];

  function hairStyle() {
    return clamp(Math.round(P.hairStyle ?? 2), 0, HAIR_STYLES.length - 1);
  }

  // Only two styles put hair outside the silhouette: a bun and a crest. Everything
  // else stays inside the head outline -- hair is a face feature here, not a shell.
  function drawHairBehind() {
    const style = hairStyle();
    const hair = P.hair ?? 0.85;
    if (hair < 0.02 || (style !== 6 && style !== 7)) return;
    const glow = P.glow ?? 1;
    const path = new Path2D();
    if (style === 6) {
      path.ellipse(ux(0), vy(-0.20), dU(0.30), dV(0.21), 0, 0, TAU);
    } else {
      path.moveTo(ux(-0.13), vy(-0.02));
      path.bezierCurveTo(ux(-0.24), vy(-0.26), ux(-0.15), vy(-0.42), ux(0), vy(-0.48));
      path.bezierCurveTo(ux(0.15), vy(-0.42), ux(0.24), vy(-0.26), ux(0.13), vy(-0.02));
      path.closePath();
    }
    ctx.save();
    const g = ctx.createLinearGradient(0, vy(-0.5), 0, vy(0.05));
    g.addColorStop(0, `rgba(9,40,52,${0.34 * hair})`);
    g.addColorStop(1, `rgba(6,26,34,${0.30 * hair})`);
    ctx.fillStyle = g;
    ctx.fill(path);
    ctx.strokeStyle = rgba(COL.main, 0.34 * hair * glow);
    ctx.lineWidth = 1;
    ctx.stroke(path);
    ctx.restore();
  }

  // Hair that frames the face: a band along each side, kept inside the head
  // outline so nothing wraps around the skull.
  function drawHairSides() {
    const style = hairStyle();
    const hair = P.hair ?? 0.85;
    if (hair < 0.02) return;
    if (style !== 4 && style !== 5 && style !== 8) return;
    const hv = P.hairline ?? 0.245;
    const vEnd = style === 5 ? 0.995 : style === 4 ? 0.80 : 0.62;
    const curly = style === 8;

    for (const sgn of [-1, 1]) {
      const p = new Path2D();
      const top = hv - 0.015;
      const N = 18;
      const outer = (v) => halfWidth(v) * 0.985;
      // the band is a thin strip hugging the silhouette: inner is a fraction of the
      // way IN from the edge, not a fraction of the half width (that put hair in the
      // middle of the face)
      const band = (v) => {
        const t = clamp((v - top) / (vEnd - top), 0, 1);
        const base = (style === 5 ? 0.24 : style === 4 ? 0.21 : 0.19) - 0.07 * Math.sin(Math.PI * t);
        const wave = curly ? 0.022 * Math.sin(t * Math.PI * 7) : 0;
        return clamp(base + wave, 0.08, 0.34);
      };
      const inner = (v) => halfWidth(v) * (1 - band(v));
      p.moveTo(ux(sgn * outer(top)), vy(top));
      for (let i = 1; i <= N; i++) {
        const v = top + (vEnd - top) * (i / N);
        p.lineTo(ux(sgn * outer(v)), vy(v));
      }
      // rounded bottom
      const vB = vEnd;
      p.quadraticCurveTo(ux(sgn * (outer(vB) + inner(vB)) * 0.5), vy(vB + 0.045),
                         ux(sgn * inner(vB)), vy(vB));
      for (let i = N - 1; i >= 0; i--) {
        const v = top + (vEnd - top) * (i / N);
        p.lineTo(ux(sgn * inner(v)), vy(v));
      }
      p.closePath();

      const g = ctx.createLinearGradient(ux(sgn * outer(top)), 0, ux(sgn * inner(top)), 0);
      g.addColorStop(0, `rgba(9,40,52,${0.20 * hair})`);
      g.addColorStop(1, 'rgba(4,18,24,0)');
      ctx.fillStyle = g;
      ctx.fill(p);

      // strands follow the band
      ctx.strokeStyle = rgba(COL.main, 0.38 * hair);
      ctx.lineWidth = 1;
      ctx.lineWidth = 1;
      for (let k = 1; k <= 6; k++) {
        const f = k / 7;
        const wob = curly ? 0.006 * Math.sin(k * 2.1) : 0;
        ctx.strokeStyle = rgba(COL.main, (0.30 - 0.03 * k) * hair);
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const v = top + (vEnd - top) * (i / N);
          const u = outer(v) + (inner(v) - outer(v)) * clamp(f + wob, 0, 1);
          const x = ux(sgn * u);
          i ? ctx.lineTo(x, vy(v)) : ctx.moveTo(x, vy(v));
        }
        ctx.stroke();
      }
    }
  }

  // Drawn inside the head clip: the cap over the hairline, shaped per style.
  function drawHairFront() {
    const style = hairStyle();
    const hair = P.hair ?? 0.85;
    if (hair < 0.02) return;
    if (style === 0) return;                       // bald
    const hv = P.hairline ?? 0.245;
    const glow = P.glow ?? 1;
    const hwH = halfWidth(hv) * 1.005;
    const crest = style === 7;

    const line = new Path2D();
    line.moveTo(ux(-hwH), vy(hv - 0.012));
    if (style === 1) {                             // buzz: a high, even line
      line.quadraticCurveTo(ux(0), vy(hv - 0.060), ux(hwH), vy(hv - 0.012));
    } else if (style === 3) {                      // side part: sweeps one way
      line.bezierCurveTo(ux(-hwH * 0.34), vy(hv - 0.070),
                         ux(hwH * 0.30), vy(hv + 0.020), ux(hwH), vy(hv + 0.028));
    } else if (style === 8) {                      // curly: a scalloped hairline
      const N = 30;
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const u = lerp(-hwH, hwH, t);
        const wave = 0.0105 * Math.sin(t * Math.PI * 9.5) + 0.0055 * Math.cos(t * Math.PI * 17);
        const lift = -0.010 * Math.sin(Math.PI * t);
        line.lineTo(ux(u), vy(hv + wave + lift));
      }
    } else if (crest) {                            // crest: a shaved band
      line.quadraticCurveTo(ux(0), vy(hv - 0.020), ux(hwH), vy(hv - 0.012));
    } else {                                       // widow's peak
      line.quadraticCurveTo(ux(-hwH * 0.55), vy(hv + 0.030), ux(-hwH * 0.16), vy(hv + 0.006));
      line.quadraticCurveTo(ux(0), vy(hv - 0.004), ux(hwH * 0.16), vy(hv + 0.006));
      line.quadraticCurveTo(ux(hwH * 0.55), vy(hv + 0.030), ux(hwH), vy(hv - 0.012));
    }

    const cap = new Path2D(line);
    cap.lineTo(ux(hwH), vy(-0.06));
    cap.lineTo(ux(-hwH), vy(-0.06));
    cap.closePath();

    const density = crest ? hair * 0.5 : hair;
    ctx.save();
    ctx.clip(cap);
    // A faint tint only: a solid fill swallowed the mesh and the scan band, which
    // is the whole hologram. The hair is read from its strands, not its mass.
    const g = ctx.createLinearGradient(0, vy(-0.02), 0, vy(hv + 0.04));
    g.addColorStop(0, `rgba(9,40,52,${0.10 * density})`);
    g.addColorStop(0.8, `rgba(6,26,34,${0.07 * density})`);
    g.addColorStop(1, 'rgba(4,16,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ux(-1.1), vy(-0.1), dU(2.2), dV(hv + 0.16));

    // no regular strand comb: the rain is the texture
    ctx.restore();

    // shadow on the forehead: clipping the cap shifted down makes its edge follow
    // the hairline curve instead of cutting a straight band across the face
    const sh = ctx.createLinearGradient(0, vy(hv - 0.012), 0, vy(hv + 0.060));
    sh.addColorStop(0, `rgba(0,4,7,${0.16 * density})`);
    sh.addColorStop(0.55, `rgba(0,4,7,${0.07 * density})`);
    sh.addColorStop(1, 'rgba(0,4,7,0)');
    ctx.save();
    ctx.translate(0, dV(0.060));
    ctx.clip(cap);
    ctx.fillStyle = sh;
    ctx.fillRect(ux(-1.1), vy(hv - 0.02), dU(2.2), dV(0.10));
    ctx.restore();

    // fringe: short strokes that cross the hairline so the edge is not a band
    ctx.save();
    ctx.clip(cap);
    for (let i = -9; i <= 9; i++) {
      const u = i / 9.6;
      const x = ux(u * hwH * 0.96);
      const drop = (0.030 + 0.022 * Math.cos(u * Math.PI * 0.9)) * (0.5 + 0.5 * hair);
      ctx.strokeStyle = rgba(COL.main, 0.14 * hair);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x, vy(hv - 0.012));
      ctx.quadraticCurveTo(x * 1.004, vy(hv + drop * 0.6), x * 0.996, vy(hv + drop));
      ctx.stroke();
    }
    ctx.restore();

    // no hairline stroke: the hair ends at its own fade, not at a drawn line

    if (crest) {
      // the ridge continues over the crown
      ctx.strokeStyle = rgba(COL.core, 0.35 * hair);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ux(0), vy(hv * 0.35));
      ctx.lineTo(ux(0), vy(-0.02));
      ctx.stroke();
    }
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
      ctx.rotate(-((P.earTilt ?? 0.1) + 0.05 * tw * side));
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
  function drawShell(t, hp) {
    const cx = ux(0);
    const glow = P.glow ?? 1;
    const fill = P.fill ?? 0.86;

    ctx.save();
    ctx.clip(hp);

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

    drawHairFront();

    // the same falling rain, bright where it crosses the face and dim in the room:
    // one system, modulated by the silhouette rather than a second texture
    if (RAIN.ready) {
      // transparency * faceRain = how much code the face carries; whole passes stack,
      // so the top of the slider is genuinely brighter instead of clamping at 1
      const effect = clamp(Math.round(P.effect ?? 0), 0, 4);
      if (effect === 1) drawWire(hp, t);
      else if (effect === 2) drawMotes(hp, t);
      const fr = (effect === 0 || effect === 4) ? Math.max(0, P.faceRain ?? 2.6) : 0;
      if (fr > 0.02) {
        // Source-over, so the code keeps its hue at full strength. Additive stacking
        // is what turned the face white: six passes of any colour clip to white.
        // Additive, but capped: six additive passes clip to white, and repeated
        // source-over lays a milky film over the head, which is the "ghost" look.
        // One to three passes at a bounded total keeps the glyphs crisp and coloured.
        const total = clamp(fr * 0.24, 0, 1.35);
        const passes = Math.max(1, Math.ceil(total));
        ctx.save();
        ctx.clip(hp);
        ctx.globalCompositeOperation = 'lighter';
        if (effect === 4) {
          ctx.save();
          ctx.translate(HEAD.cx, HEAD.cy);
          ctx.scale(0.55, 0.55);
          ctx.translate(-HEAD.cx, -HEAD.cy);
          ctx.globalAlpha = Math.min(0.8, total * 0.45);
          ctx.drawImage(RAIN.buf, 0, 0);
          ctx.restore();
        }
        for (let i = 0; i < passes; i++) {
          ctx.globalAlpha = Math.min(1, total - i);
          ctx.drawImage(RAIN.buf, 0, 0);
        }
        ctx.restore();
      }
    }

    // scan band
    const scan = P.scan ?? 0.55;
    if (scan > 0.01 && !OFF.has('scan')) {
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

    // rim light: soft halo + hot core stroke
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
    const mg = ctx.createLinearGradient(0, vy(vRoot), 0, vy(vTip + 0.04));
    mg.addColorStop(0, 'rgba(2,8,12,0.18)');
    mg.addColorStop(0.6, 'rgba(2,8,12,0.55)');
    mg.addColorStop(1, 'rgba(2,8,12,0.72)');
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

    // lip body: an opaque dark base first, so the rain stops at the mouth
    ctx.beginPath();
    ctx.moveTo(-mwS, cornerY);
    for (let i = 1; i <= N; i++) { const x = xAt(i); ctx.lineTo(x, upper(x)); }
    for (let i = N; i >= 0; i--) { const x = xAt(i); ctx.lineTo(x, lower(x)); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(2,8,12,0.92)';
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

  function frame(now) {
    requestAnimationFrame(frame);
    try {
    let dt = (now - last) / 1000;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.05);
    last = now;
    if (FREEZE !== null) dt = 1 / 60;

    S.t = FREEZE !== null ? FREEZE : S.t + dt;
    const t = S.t;

    updateSenses(dt, t);
    rainStep(dt, (P.rainSpeed ?? 1));
    stepRoom(dt, (P.rainSpeed ?? 1));

    drawBackdrop(t);

    ctx.save();
    ctx.translate(0, S.breath);
    if (!OFF.has('projector')) drawProjector(t);
    drawHairBehind();
    const hp = headPath();
    drawShell(t, hp);
    drawEars();

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
    if (!OFF.has('hair')) drawHairSides();
    // Transparency is the features' own alpha, not the rain's
    ctx.globalAlpha = clamp(P.transparency ?? 1, 0, 1);
    if (!OFF.has('eyes')) { drawEye(-1, t); drawEye(1, t); }
    if (!OFF.has('brows')) { drawBrow(-1); drawBrow(1); }
    if (!OFF.has('nose')) drawNose();
    if (!OFF.has('mouth')) drawMouth();
    ctx.restore();
    ctx.restore();

    // vignette (cached per resize; scanlines live in CSS, not 360 fillRects a frame)
    if (!G.vignette) {
      G.vignette = ctx.createRadialGradient(VW * 0.5, VH * 0.5, Math.min(VW, VH) * 0.35,
                                             VW * 0.5, VH * 0.5, Math.max(VW, VH) * 0.78);
      G.vignette.addColorStop(0, 'rgba(0,0,0,0)');
      G.vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    }
    ctx.fillStyle = G.vignette;
    ctx.fillRect(0, 0, VW, VH);

    // fps
    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 0.5) { S.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    } catch (err) {
      window.__frameErr = String((err && err.stack) || err);
    }
  }

  /* ---------------------------------------------------------------- api */
  function setParams(next) {
    const hueBefore = COL.main.join(), satBefore = COL.core.join();
    P = Object.assign({}, P, next);
    palette();
    if (COL.main.join() !== hueBefore || COL.core.join() !== satBefore) {
      buildRain();
      RAIN.c.clearRect(0, 0, RAIN.w, RAIN.h);
      buildRoom();
    }
    layout();
    rebuildGeometry();
    buildRain();
    buildRoom();
    buildMotes();
  }

  window.__face = {
    setParams,
    getParams: () => Object.assign({}, P),
    setState(s) { if (s && s !== S.state) { S.state = s; } },
    setAmp(a) { S.amp = clamp(Number(a) || 0, 0, 1); },
    setGaze(x, y) { S.tgx = clamp(Number(x) || 0, -1, 1); S.tgy = clamp(Number(y) || 0, -1, 1);
                   S.gazeX = S.tgx; S.gazeY = S.tgy; S.nextSaccade = 1e9; },
    get stats() {
      return { fps: S.fps, state: S.state, aperture: S.aperture, head: { ...HEAD },
               blinks: S.blinks, blink: S.blink, browL: S.browL, browR: S.browR,
               nostril: S.nostril, earL: S.earL, earR: S.earR,
               gazeX: S.gazeX, gazeY: S.gazeY, smile: P.smile };
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
      P = defaults;
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
