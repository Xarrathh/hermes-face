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
    // the visible head is shorter when the forehead is squeezed, so shift the centre by
    // half of what was lost -- otherwise the face sits low with a gap over its head
    const crown = clamp(P.forehead ?? 1, 0.5, 1.5);
    HEAD.cy = VH * 0.435 - (0.46 * (1 - crown) * h) / 2;
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
    CELLS.dirty = true;
    CELLS.last = undefined;
    layout();
    rebuildGeometry();
    buildRain();
  }

  /* ---------------------------------------------------------------- anatomy */
  // Right half of the silhouette, crown -> chin. u is the half width at that v.
  // Params bend this one curve; nothing else stores a face.
  // Right half of the silhouette, crown -> chin, u = half width at that v. This is the
  // whole face SHAPE: everything else bends this one curve.
  //
  // It is a real cranium profile rather than an egg: the widest point is the zygomatic
  // arch just under the eyes, not high up on the skull; there is a temple hollow above
  // it; the jaw runs down to a corner and then turns forward instead of tapering in a
  // single sweep; and the chin ends as a flat arc.
  const SILHOUETTE = [
    [0.000, 0.000], [0.300, 0.016], [0.520, 0.042], [0.680, 0.076], [0.790, 0.118],
    [0.860, 0.166], [0.905, 0.216], [0.936, 0.268], [0.954, 0.312], [0.962, 0.352],
    [0.956, 0.392], [0.946, 0.424], [0.950, 0.452], [0.960, 0.486], [0.962, 0.516],
    [0.952, 0.552], [0.934, 0.588], [0.912, 0.624], [0.890, 0.658], [0.874, 0.690],
    [0.868, 0.722], [0.856, 0.752], [0.826, 0.786], [0.782, 0.818], [0.722, 0.848],
    [0.646, 0.878], [0.556, 0.906], [0.462, 0.932], [0.372, 0.954], [0.290, 0.972],
    [0.216, 0.986], [0.160, 0.996], [0.132, 1.000],
  ];
  // The chin is a rounded arc, not a point. Ending the curve at u = 0 gave every
  // face a tapered elf chin however narrow the jaw was set; chinWidth then had
  // almost nothing left to widen. CHIN_U is the half width of the chin's bottom arc.
  const CHIN_U = 0.132;

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
    // Forehead: everything above the brow is pulled toward a fixed pivot, so a smaller
    // value shortens the skull and a larger one builds it up. The features live in v and
    // are not touched, which is why this changes the forehead and nothing else.
    const crown = clamp(P.forehead ?? 1, 0.5, 1.5);
    if (Math.abs(crown - 1) > 0.001) {
      const pivot = clamp((P.eyeY ?? 0.5) - 0.05, 0.26, 0.54);
      pts = pts.map(([u, v]) => (v < pivot ? [u, pivot - (pivot - v) * crown] : [u, v]));
    }

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
    yaw: 0, pitch: 0, roll: 0, nod: 0, tYaw: 0, tPitch: 0, nextTurn: 2.5,
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

    // head movement: the eyes lead, the head follows a beat later. Targets are re-drawn
    // every few seconds and biased toward wherever the gaze went, which is what makes it
    // look like the face is looking at things rather than swinging on a sine wave.
    const hm = clamp(P.headTurn ?? 0.6, 0, 1);
    S.nextTurn -= dt;
    if (S.nextTurn <= 0) {
      S.nextTurn = rnd(1.8, 5.0);
      const bias = clamp(S.tgx, -1, 1) * 0.55;
      S.tYaw = clamp(bias + rnd(-0.7, 0.7), -1, 1);
      S.tPitch = clamp(-S.tgy * 0.45 + rnd(-0.35, 0.35), -1, 1);
    }
    S.yaw = approach(S.yaw, S.tYaw * hm, 1.9, dt);
    S.pitch = approach(S.pitch, S.tPitch * hm, 1.7, dt);
    // a slow roll: a head that is perfectly level reads as a cut-out
    S.roll = approach(S.roll, Math.sin(t * 0.37) * 0.03 * hm + S.yaw * 0.02, 1.2, dt);
    // nods while speaking, a slow sway while thinking: the pitch the renderers use
    S.nod = (S.state === 'speaking' ? Math.sin(t * 3.1) * 0.16 * clamp(S.amp * 2, 0, 1) : 0)
            + (S.state === 'thinking' ? Math.sin(t * 0.9) * 0.10 : 0);

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

  /* ---------------------------------------------------------------- backdrop */

  function drawBackdrop(t) {
    const bg = ctx.createRadialGradient(VW * 0.5, VH * 0.42, 0, VW * 0.5, VH * 0.52, Math.max(VW, VH) * 0.78);
    bg.addColorStop(0, 'rgb(4,16,22)');
    bg.addColorStop(0.5, 'rgb(2,9,13)');
    bg.addColorStop(1, 'rgb(1,4,6)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, VW, VH);
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
      // not near-black: over the dark rim of the cell face a black fill reads as a hole,
      // and the ear becomes a hoop. A dim green body makes it part of the head.
      ctx.fillStyle = 'rgba(13,38,46,0.97)';  // tone inside, so it reads as an ear, not a hoop
      ctx.fill();
      ctx.strokeStyle = rgba(COL.main, 0.92);
      ctx.lineWidth = 2.6;      // it has to survive being quantised into cells
      ctx.shadowColor = rgba(COL.main, 0.55);
      ctx.shadowBlur = 10 * (P.glow ?? 1);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // helix
      ctx.strokeStyle = rgba(COL.main, 0.62);
      ctx.lineWidth = 1.6;
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

  /* --------------------------------------------------------------- front rain */
  // The other half of the old face: glyph rain that falls over the whole frame
  // but never over the portrait. Here it is drawn in front of the room and
  // clipped away from the head with an even-odd path, so the rain passes behind
  // nothing -- it is in the air in front of the face, not on the wall behind it.
  const RAIN = { cv: null, c: null, w: 0, h: 0, ch: 14, cw: 9, cols: [], last: -1, ready: false };
  // its own glyph set: the rain borrowed the room effect's charset, and the room is gone
  const RAIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<>[]{}/\\|=+-*:.';

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
          const gi = Math.floor(hash01(col.x * 0.77 + k * 17.1 + (frame % 37) * 61.9) * RAIN_CHARS.length);
          const a = k === 0 ? 1 : Math.pow(1 - k / (col.len + 1), 1.9);
          c.fillStyle = k === 0 ? rgba(COL.core, 0.95) : rgba(COL.main, 0.72 * a);
          c.fillText(RAIN_CHARS[gi], col.x, y);
        }
      }
    }
    // in front of the room, never in front of the face
    ctx.save();
    const clip = new Path2D();
    clip.rect(0, 0, VW, VH);
    clip.addPath(headPath());
    ctx.clip(clip, 'evenodd');
    // One blit, not two: the additive pass was a second full-screen composite for a
    // faint glow, which is the expensive half of the rain.
    ctx.globalAlpha = Math.min(1, amt * 1.18);
    ctx.drawImage(RAIN.cv, 0, 0, RAIN.w, RAIN.h);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- helpers */
  // These two lived inside the hologram passes that were just deleted, and every cell
  // path needs them: hash01 for the deterministic per-column/row gain, SUB_GAIN for
  // the three-thread profile. Without them resize() threw and the frame loop never
  // started -- a black canvas with no error on screen.
  const hash01 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const SUB_GAIN = [0.52, 1.00, 0.68];         // left, middle, right sub-pixel of a cell

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
                 P.mouthY, P.mouthWidth, P.matLight, P.matLightY, P.matLightSpread].join('|');
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

    for (let r = 0; r < rows; r++) {
      const v = by + ((r + 0.5) / rows) * bh;
      const vn = (v - HEAD.cy) / HEAD.h + 0.5;          // 0 crown -> 1 chin, in v units
      const hw = Math.max(0.05, halfWidth(clamp(vn, 0, 1)));
      for (let c = 0; c < cols; c++) {
        const x = bx + ((c + 0.5) / cols) * bw;
        const u = (x - HEAD.cx) / (HEAD.w * 0.5);       // -1..1 across the head
        const nx = Math.abs(u) / hw;
        let s = 0.5;

        // ONE lamp, in front. A single wide bloom over the brow and the upper cheeks is
        // the light source; every other term subtracts from it. The previous version had
        // a key from the upper left plus a side ramp, two cheek fills, cheekbone shadows
        // and jaw-corner shadows, which stacked into "lit from the side with six
        // shadows" -- correct shading, wrong read.
        const light = clamp(P.matLight ?? 1, 0, 2);
        // Height and spread are parameters because the default bloom sat high on the
        // skull, and with no hairline to cap it the forehead read as the biggest thing
        // on the face. A lower, tighter key lights the brow and the cheeks instead.
        const lightY = clamp(P.matLightY ?? 0.24, 0.05, 0.60);
        const lightSpread = clamp(P.matLightSpread ?? 0.38, 0.15, 0.60);
        s += 0.24 * light * g2(u, vn, 0, lightY, 1.02, lightSpread);

        // the light falls off to the edges and to the jaw: symmetric, one term each
        s -= 0.26 * Math.pow(clamp(nx, 0, 1.25), 2.2);
        s -= 0.22 * Math.pow(clamp((vn - 0.58) / 0.42, 0, 1), 1.5);

        // sockets: the only shadows with a job -- they seat the eyes in the face
        for (const side of [-1, 1]) {
          s -= 0.20 * g2(u, vn, side * eyeU, eyeY, eyeW * 0.55, 0.055);
        }

        // nose: one highlight down the bridge, one soft shadow under the tip
        // narrower and weaker than it was: at 0.16 over 0.36 nose-widths it read as a bright
        // stripe down every face, which is what made the nose look like a beak
        s += 0.10 * g2(u, vn, 0, noseTop + noseLen * 0.52, noseW * 0.26, noseLen * 0.72);
        s -= 0.13 * g2(u, vn, 0, noseTop + noseLen * 1.15, noseW * 0.95, 0.022);

        // mouth: the seam, and a small chin catch under it
        s -= 0.15 * g2(u, vn, 0, mouthY + 0.004, mouthW * 1.00, 0.007);
        s += 0.07 * g2(u, vn, 0, 0.905, 0.45, 0.060);

        // fade the relief out at the silhouette, or it draws its own hard edge
        s = 0.5 + (s - 0.5) * clamp((1 - nx) / 0.14, 0, 1);
        // ... and then re-centre it as absolute tone: 0.28 is unlit skin, the deltas
        // carry it up to the highlights and down to the shadow side. The cells measure
        // this value directly, so this number is the face's exposure, not a hint.
        // Clamp the field below 1.0 before mapping: the key light, the cheek catch and
        // the cheekbones all add, and where the sum passes 1 the tone saturates into a
        // flat plateau with a hard edge -- visible as polygonal patches once the tone
        // bands are posterised.
        const val = clamp(0.25 + (clamp(s, 0.05, 0.92) - 0.5) * 1.70, 0, 1) * 255;
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
    // The measurement (getImageData + a 45k-cell rebuild + putImageData) is the hot part
    // and does not need 40 Hz: the head eases at ~2/s and blinks in ~130 ms. 20 Hz is
    // indistinguishable and halves that cost. The blit still runs every frame.
    const due = (CELLS.last === undefined) || CELLS.dirty || (t - CELLS.last >= 0.033);
    if (!due) { blitCells(); return; }
    CELLS.last = t;
    CELLS.dirty = false;
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

    // "the cells fall off to the back": a front-facing head curves away at the rim,
    // so tone and coverage both drop there. This is what turns a flat green mask into
    // a volume -- without it the silhouette is a cut-out with a hard edge.
    const round = clamp(P.matRound ?? 0.7, 0, 1);
    const yaw = S.yaw, pitch = S.pitch + S.nod;

    // the ear ellipses, in the same u/v units the cell loop uses (mirrors drawEars)
    const earSize = P.earSize ?? 1.1;
    const earOut = P.earOut ?? 0.55;
    const earV = (P.earY ?? 0.44) + 0.095 * earSize;
    const earRU = 0.040 * earSize + 0.014 * earOut;
    const earRV = 0.095 * earSize;
    const earHW = halfWidth(clamp(earV, 0, 1)) + 0.004 + 0.008 * earOut;
    const earU = [-earHW, earHW];

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
      // per-row geometry for the falloff: v in v-units and the silhouette half-width
      const yCell = by + ((r + 0.5) / rows) * bh;
      const vn = (yCell - HEAD.cy) / HEAD.h + 0.5;
      const hw = Math.max(0.05, halfWidth(clamp(vn, 0, 1)));
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 4;
        const a = src[i + 3] / 255;
        const xCell = bx + ((c + 0.5) / cols) * bw;
        const u = (xCell - HEAD.cx) / (HEAD.w * 0.5);
        const nx = Math.abs(u) / hw;
        if (a < 0.05) continue;                       // outside the silhouette
        const L = (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255;
        let q = clamp((L - black) / (white - black), 0, 1);
        q = clamp(Math.pow(q, 1 / expo), 0, 1);       // exposure, then quantise
        if (levels > 1) q = Math.round(q * (levels - 1)) / (levels - 1);
        const tone = rampAt(q);
        // The turn's light, done per cell instead of as two clipped gradient fills over
        // the whole head (which measured at ~6.8 ms a frame on this iGPU -- more than the
        // rain and the CRT together). The side the head turns toward lifts, the side it
        // turns away from drops, and looking up flattens the brow.
        const shade = clamp(1 + 1.05 * yaw * u * Math.min(1, nx * 1.2)
                              + 0.55 * pitch * (vn - 0.45), 0.35, 1.9);
        const dith = 1 + (hash01(r * 7.31 + c * 3.17) - 0.5) * 0.16 * gain;
        // 1 in the middle of the face, 1-round at the rim; the crown curves away too,
        // just less, or the top of the head turns into a dark cap
        let fall = (1 - round * smoothstep(0.70, 1.05, nx)) *
                   (1 - round * 0.32 * (1 - smoothstep(0.01, 0.14, vn)));
        // An ear sits outside the silhouette, where that falloff is fully black -- which
        // is why measuring the ears in made them disappear. Inside an ear ellipse the
        // cell gets the ear's own gentle falloff instead.
        for (let e = 0; e < earU.length; e++) {
          const dx = (u - earU[e]) / earRU, dy = (vn - earV) / earRV;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 1) fall = Math.max(fall, 1 - round * 0.5 * smoothstep(0.5, 1.0, d));
        }
        const cg = colGain[c] * dith * (0.45 + 0.55 * fall) * shade;
        for (let sy = 0; sy < SUBY; sy++) {
          const rowCut = (sy === SUBY - 1 ? 1 - 0.20 * gain : 1);
          for (let sx = 0; sx < SUBX; sx++) {
            const g = (0.45 + 0.55 * SUB_GAIN[sx]) * cg * rowCut;
            const o = ((r * SUBY + sy) * tw + c * SUBX + sx) * 4;
            out[o] = Math.min(255, tone[0] * g);
            out[o + 1] = Math.min(255, tone[1] * g);
            out[o + 2] = Math.min(255, tone[2] * g);
            out[o + 3] = a * fall * 255;
          }
        }
      }
    }
    CELLS.c.putImageData(CELLS.img, 0, 0);

    CELLS.bx = bx; CELLS.by = by; CELLS.bw = bw; CELLS.bh = bh;
    blitCells();
  }

  // smoothing off, or the threads turn into a smear
  function blitCells() {
    if (!CELLS.cv || CELLS.bx === undefined) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(CELLS.cv, CELLS.bx, CELLS.by, CELLS.bw, CELLS.bh);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- shell */
  // There is no hologram any more, so the head has no shell to light: this fills one
  // flat base inside the silhouette and the sculpt field supplies every tone.
  function drawCellBase(hp) {
    ctx.save();
    ctx.clip(hp);
    ctx.fillStyle = '#484848';
    ctx.fillRect(ux(-1.15), vy(-0.15), dU(2.3), dV(1.4));
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
    // lip gloss: a multiplier rather than a fixed strength, so the wet look can go from
    // matte to lacquered without touching anything else
    const glossAmt = clamp(P.lipGloss ?? 1, 0, 2);
    const cyM = vy(vM);
    const a = S.aperture;
    const upH = dV(0.0142) * lip;
    const lowH = dV(0.0190) * lip;
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
    const lipPath = () => {
      ctx.beginPath();
      ctx.moveTo(-mwS, cornerY);
      for (let i = 1; i <= N; i++) { const x = xAt(i); ctx.lineTo(x, upper(x)); }
      for (let i = N; i >= 0; i--) { const x = xAt(i); ctx.lineTo(x, lower(x)); }
      ctx.closePath();
    };

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
    lipPath();
    // Opaque. The translucent body was designed to sit on a hologram you could see
    // through; on a cell face it just lets the cells show through the lips, which reads
    // as a transparent mouth however high the Features transparency goes.
    ctx.fillStyle = 'rgb(4,15,20)';      // fully solid: the lips occlude the cells
    ctx.fill();

    lipPath();
    const lg = ctx.createLinearGradient(0, cyM - upH * 3, 0, cyM + lowH * 3);
    lg.addColorStop(0, rgba(COL.dim, 0.46 * glow));
    lg.addColorStop(0.45, rgba(COL.deep, 0.62 * glow));
    lg.addColorStop(0.78, rgba(COL.main, 0.30 * glow));
    lg.addColorStop(1, rgba(COL.dim, 0.34 * glow));
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

    // ---- volume: a lip is a rounded surface, so it carries one soft specular band just
    // under the seam that falls away to nothing at the bottom edge. Additive because this
    // is light rather than paint, and clipped to the lip so it cannot spill on the face.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    lipPath();
    ctx.clip();
    const gloss = ctx.createLinearGradient(0, seam(0) - lowH * 0.2, 0, lower(0) + lowH * 0.9);
    gloss.addColorStop(0, rgba(COL.core, 0.06 * glow * glossAmt));
    gloss.addColorStop(0.30, rgba(COL.core, 0.26 * glow * glossAmt));   // the specular band
    gloss.addColorStop(0.55, rgba(COL.core, 0.10 * glow * glossAmt));
    gloss.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = gloss;
    ctx.fillRect(-mwS, seam(0), mwS * 2, lowH * 8);
    ctx.restore();

    // The upper lip is a rounded surface as well, so it gets its own band along the top
    // ridge -- weaker than the lower lip, because it faces away from a light that is in
    // front of the face. Without it the mouth reads as one lit lip and one dead one.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    lipPath();
    ctx.clip();
    const upTop = upper(0);
    const upGloss = ctx.createLinearGradient(0, upTop - upH * 0.15, 0, seam(0) + upH * 0.15);
    upGloss.addColorStop(0, rgba(COL.core, 0.04 * glow * glossAmt));
    upGloss.addColorStop(0.32, rgba(COL.core, 0.17 * glow * glossAmt));   // ridge band
    upGloss.addColorStop(0.72, rgba(COL.core, 0.06 * glow * glossAmt));
    upGloss.addColorStop(1, rgba(COL.main, 0));
    ctx.fillStyle = upGloss;
    ctx.fillRect(-mwS, upTop - upH * 4, mwS * 2, Math.max(2, seam(0) - upTop + upH * 6));
    ctx.restore();

    // ---- halo: a faint bloom around the whole mouth. At cell resolution this is what
    // makes the lips sit in front of the face instead of being drawn on it.
    ctx.save();
    lipPath();
    ctx.strokeStyle = rgba(COL.main, 0.20 * glow * glossAmt);
    ctx.lineWidth = 2.0;
    ctx.shadowColor = rgba(COL.main, 0.60 * glow * glossAmt);
    ctx.shadowBlur = 14 * glow;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

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
  const FRAME_MS = 1000 / 30;      // 30 fps: the head eases at under 2/s and the rain
                                   // steps at 12 Hz, so 30 is indistinguishable from 40
                                   // here -- and it is a quarter of the CPU. Old note: 40 fps is plenty for a face and leaves the
                                  // compositor room to run its own animations
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastPaint < FRAME_MS) return;
    lastPaint = now;
    // cost of one drawn frame, smoothed: the only number that is not at the mercy of
    // whatever else the machine is doing. Process CPU measurements drift by ±5 points
    // between runs; this does not.
    const drawT0 = performance.now();
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

    const hp = headPath();

    // pass 1: the anatomy, alone on its own layer -- one flat base, the sculpt field,
    // the ears. No room, no rain, no shell lighting: the cells must measure the face.
    // The head turns by parallax: the silhouette shifts and narrows, the features shift
    // further than it does. That difference is the whole 3D cue -- there is no mesh here.
    const yaw = S.yaw, pitch = S.pitch + S.nod;
    const dxHead = yaw * dU(0.075), dyHead = pitch * dV(0.032);
    const dxFace = yaw * dU(0.160), dyFace = pitch * dV(0.070);

    const lc = LAYER.c;
    lc.setTransform(DPR, 0, 0, DPR, 0, 0);
    lc.clearRect(0, 0, VW, VH);
    ctx = lc;
    ctx.save();
    ctx.translate(HEAD.cx + dxHead, HEAD.cy + dyHead);
    ctx.rotate(S.roll);
    ctx.scale(1 - 0.22 * Math.abs(yaw), 1 - 0.10 * Math.abs(pitch));
    ctx.translate(-HEAD.cx, -HEAD.cy + S.breath);
    drawCellBase(hp);
    drawSculpt(hp);
    // Ears are part of the anatomy again: they get measured into the cells like the rest
    // of the head. The rim falloff is taught about them (see compositeCells), which is
    // what was eating them when they were measured in before.
    if (!OFF.has('ears')) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      drawEars();
      ctx.restore();
    }
    ctx.restore();
    ctx = mainCtx;

    // pass 2: measure it, rebuild it as quantised cells
    compositeCells(t);

    ctx.save();
    ctx.translate(0, S.breath);

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
    ctx.translate(dxFace, dyFace);   // features travel further than the silhouette
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

    const drawMs = performance.now() - drawT0;
    S.drawMs = S.drawMs ? S.drawMs * 0.88 + drawMs * 0.12 : drawMs;

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
    CELLS.dirty = true;
    P = moodParams();
    palette();
    layout();
    rebuildGeometry();
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
    // a probe for exactly this class of bug: "the frame runs but nothing paints"
    debug: () => ({
      onMain: ctx === mainCtx, vw: VW, vh: VH, dpr: DPR,
      layer: !!LAYER.c, cells: !!CELLS.cv, sculpt: !!SCULPT.cv,
      head: { ...HEAD }, err: window.__frameErr || null,
    }),
    get stats() {
      return { fps: S.fps, state: S.state, aperture: S.aperture, head: { ...HEAD },
               blinks: S.blinks, blink: S.blink, browL: S.browL, browR: S.browR,
               nostril: S.nostril, earL: S.earL, earR: S.earR,
               drawMs: Math.round((S.drawMs || 0) * 100) / 100,
               yaw: S.yaw, pitch: S.pitch, roll: S.roll,
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
