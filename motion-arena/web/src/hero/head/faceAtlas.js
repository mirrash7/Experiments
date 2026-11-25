// Canvas-generated face atlases (spec 2.4). Owner: WP3.
//
// Two textures, generated once at load (no per-frame canvas work):
//
//   eyeTex  1024² DataTexture, 4×4 cells of 256². One cell per EYE STATE stores four MASKS (linear):
//             R = eye opening (sclera + iris visible), G = upper-lid shadow band, B = dark lash lines, A = lower line.
//           Extra cells: IRIS colour (premultiplied sRGB RGBA, normal + surprised) and HIGHLIGHT masks
//             (R = main catch-light, G = secondary dot, B = bottom rim crescent; normal + surprised).
//           The eye shader composites: sclera/lid band (masked by R) -> iris (gaze-offset UV) -> highlights
//           (screen-stable, shift a fraction of the gaze) -> lower line -> lash. So the iris layer can move
//           freely and is always clipped by whatever lid shape the current eye state has.
//
//   featTex 1024×2048 DataTexture (premultiplied sRGB RGBA): 11 mouth cells (8 expression shapes + 3 talk
//           visemes), 5 brow cells, the painted nose wedge and the blush oval.
//
// Every cell is drawn in METRES on the face (canvas transform: origin = feature centre, +y up), so every
// size in dims.FACE maps 1:1. Canonical cells are the character's LEFT eye / brow (+X, outer side = +u);
// the shader mirrors u for the right side. Lines are drawn bolder than the spec minimums so they stay
// >= 1.5 px at the 80 px game-cam face size (spec 2.14).
//
// Cell rects are returned as [u0, v0, du, dv] for `texCoord = rect.xy + localUv * rect.zw`, localUv in
// [0,1]² with v up (the canvas is stored top row first, so dv is negative).

import * as THREE from 'three';

const EYE_CELL = 256, EYE_TEX = 1024;
const FEAT_W = 1024, FEAT_H = 2048;

/** Physical quad sizes (metres) the cells map onto. head.js builds the decal patches with these. */
export const QUADS = Object.freeze({
  eye: [0.066, 0.066],
  mouth: [0.124, 0.062],
  mouthOriginY: 0.022, // metres from the TOP of the mouth quad to the mouth centre (open shapes hang below)
  brow: [0.050, 0.0375],
  nose: [0.032, 0.024],
  blush: [0.050, 0.0375],
});

export const EYE_STATES = ['open', 'half', 'closed', 'happyClosed', 'surprised', 'determined', 'wince'];
export const MOUTH_SHAPES = ['neutral', 'smile', 'grin', 'laugh', 'surprised', 'determined', 'effort', 'shout', 'talk1', 'talk2', 'talk3'];
export const BROW_SHAPES = ['relaxed', 'raised', 'angry', 'effort', 'worried'];

// ------------------------------------------------------------------------------------------ drawing utils
function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}
/** Set a metres transform: origin at (px, py) canvas pixels, scale S px/m, +y up. */
function metres(ctx, px, py, S) { ctx.setTransform(S, 0, 0, -S, px, py); }

function cubicPts(p0, p1, p2, p3, n = 32) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}
function quadPts(p0, p1, p2, n = 32) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * Fill a variable-width stroke along a polyline (metres). widthAt(t) gives the full width at t in [0,1].
 * caps: 'round' | 'point' | 'flat' per end ([start, end]).
 */
function taper(ctx, pts, widthAt, caps = ['round', 'round']) {
  const n = pts.length, L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const w = widthAt(i / (n - 1)) / 2;
    L.push([pts[i][0] - ty * w, pts[i][1] + tx * w]);
    R.push([pts[i][0] + ty * w, pts[i][1] - tx * w]);
  }
  ctx.beginPath();
  ctx.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i][0], L[i][1]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
  ctx.closePath();
  ctx.fill();
  const cap = (i, kind) => {
    if (kind !== 'round') return;
    const w = widthAt(i / (n - 1)) / 2;
    if (w <= 1e-6) return;
    ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], w, 0, Math.PI * 2); ctx.fill();
  };
  cap(0, caps[0]); cap(n - 1, caps[1]);
}
function pathFromPts(ctx, pts, close = true) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
}
function ellipsePath(ctx, x, y, rx, ry, rot = 0) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); }

// --------------------------------------------------------------------------------------------- eye shapes
/**
 * Eye geometry in metres, canonical LEFT eye (outer corner at +x). Built from dims.FACE.eye.
 * Upper lid strongly arched, lower lid flatter (spec 2.4).
 */
function eyeShape(FACE, scale = 1) {
  const w = FACE.eye.width, h = FACE.eye.height;
  const k = (x, y) => [x * scale, y * scale];
  const sx = w / 0.040, sy = h / 0.046; // shape authored for the spec 0.040 × 0.046 eye
  const P = (x, y) => k(x * sx, y * sy);
  const Ci = P(-0.0195, -0.0015), Co = P(0.0205, 0.0035);
  const upper = cubicPts(Ci, P(-0.0205, 0.0310), P(0.0190, 0.0330), Co, 40);
  const lower = cubicPts(Co, P(0.0215, -0.0270), P(-0.0185, -0.0310), Ci, 40);
  return { Ci, Co, upper, lower, outline: [...upper, ...lower.slice(1)], top: 0.0241 * sy * scale, bottom: -0.0215 * sy * scale, sx, sy, scale };
}

function lashAlong(ctx, pts, wIn, wOut, flick, Co, FACE, sx = 1) {
  // thick at the outer third, thin at the inner corner
  taper(ctx, pts, (t) => lerp(wIn, wOut, smooth(0.15, 0.72, t)), ['round', 'round']);
  if (flick) {
    const L = FACE.lash.flickLength * 1.15 * sx, a = (FACE.lash.flickDeg * Math.PI) / 180;
    const tip = [Co[0] + Math.cos(a) * L, Co[1] + Math.sin(a) * L];
    const base0 = [Co[0] - 0.0028 * sx, Co[1] + 0.0022], base1 = [Co[0] + 0.0004, Co[1] - 0.0016];
    ctx.beginPath(); ctx.moveTo(base0[0], base0[1]);
    ctx.quadraticCurveTo(Co[0] + 0.0022 * sx, Co[1] + 0.0032, tip[0], tip[1]);
    ctx.quadraticCurveTo(Co[0] + 0.0030 * sx, Co[1] + 0.0002, base1[0], base1[1]);
    ctx.closePath(); ctx.fill();
  }
}

/** Draw the four eye masks for a state. Each target is { ctx } of a 256² mask canvas (white on black). */
function drawEyeState(state, m, FACE) {
  const S = EYE_CELL / QUADS.eye[0];
  for (const c of Object.values(m)) { c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, EYE_CELL, EYE_CELL); metres(c, EYE_CELL / 2, EYE_CELL / 2, S); c.fillStyle = '#fff'; c.strokeStyle = '#fff'; }
  const lw = FACE.lash;
  const wIn = Math.max(lw.inner, 0.0018), wOut = Math.max(lw.outer, 0.0045) * 1.2;
  const lowW = Math.max(FACE.lowerLine.width, 0.0012) * 1.4;
  const lidBand = FACE.scleraLidBand * FACE.eye.height;

  const openWithLid = (E, lidPts /* null = full */) => {
    // R: opening (optionally below a lid curve)
    const R = m.R;
    R.save();
    if (lidPts) { pathFromPts(R, [...lidPts, [0.05, -0.05], [-0.05, -0.05]]); R.clip(); }
    pathFromPts(R, E.outline); R.fill();
    R.restore();
    // G: lid shadow band = opening minus opening shifted down by the band height (follows the lid arc)
    const G = m.G;
    G.save();
    if (lidPts) { pathFromPts(G, [...lidPts, [0.05, -0.05], [-0.05, -0.05]]); G.clip(); }
    pathFromPts(G, E.outline); G.fill();
    G.globalCompositeOperation = 'destination-out';
    G.save();
    if (lidPts) {
      G.translate(0, -lidBand * 0.6);
      pathFromPts(G, [...lidPts, [0.05, -0.05], [-0.05, -0.05]]); G.fill();
    } else {
      G.translate(0, -lidBand);
      pathFromPts(G, E.outline); G.fill();
    }
    G.restore();
    G.restore();
    G.globalCompositeOperation = 'source-over';
  };
  const lowerLine = (E, frac = FACE.lowerLine.fraction) => {
    const n = Math.round(E.lower.length * frac);
    const pts = E.lower.slice(0, n);
    taper(m.A, pts, (t) => lowW * (1 - 0.65 * smooth(0.5, 1, t)), ['round', 'round']);
  };

  if (state === 'open' || state === 'surprised') {
    const E = eyeShape(FACE, state === 'surprised' ? 1.1 : 1);
    openWithLid(E, null);
    const k = state === 'surprised' ? 0.85 : 1;
    lashAlong(m.B, E.upper, wIn * k, wOut * k, true, E.Co, FACE, E.sx);
    lowerLine(E, state === 'surprised' ? 0.6 : FACE.lowerLine.fraction);
  } else if (state === 'half' || state === 'determined') {
    const E = eyeShape(FACE, 1);
    let lid;
    if (state === 'half') {
      // lid at 45 % cover, gently arched
      const yTop = E.top - 0.45 * FACE.eye.height;
      lid = quadPts([-0.0215 * E.sx, yTop - 0.0024], [0.001, yTop + 0.0030], [0.0225 * E.sx, yTop + 0.0008], 30);
    } else {
      // top lid flat at 25 % cover, slanted 8 deg down-in (inner end lower)
      const yC = E.top - 0.25 * FACE.eye.height, s = Math.tan((8 * Math.PI) / 180);
      lid = quadPts([-0.0215 * E.sx, yC - s * 0.0215], [0.0, yC + 0.0012], [0.0225 * E.sx, yC + s * 0.0225], 30);
    }
    openWithLid(E, lid);
    // lash along the lid, clipped to the eye's horizontal extent
    const inside = lid.filter((p) => p[0] > E.Ci[0] + 0.0004 && p[0] < E.Co[0] + 0.0006);
    const Co = inside[inside.length - 1];
    lashAlong(m.B, inside, wIn * 1.3, wOut * 1.05, true, Co, FACE, E.sx);
    lowerLine(E);
  } else if (state === 'closed') {
    const E = eyeShape(FACE, 1);
    const pts = quadPts([E.Ci[0], E.Ci[1] - 0.001], [0.001, -0.0095], [E.Co[0], E.Co[1] - 0.0015], 30);
    lashAlong(m.B, pts, wIn * 1.4, wOut, true, pts[pts.length - 1], FACE, E.sx);
  } else if (state === 'happyClosed') {
    const E = eyeShape(FACE, 1);
    const pts = quadPts([-0.0185 * E.sx, -0.0055], [0.0005, 0.0175], [0.0195 * E.sx, -0.0040], 30);
    const w = Math.max(0.0035, 0.0048);
    taper(m.B, pts, (t) => w * (0.75 + 0.25 * Math.sin(Math.PI * t)), ['round', 'round']);
  } else if (state === 'wince') {
    // chevron pointing to the nose: '<' on the canonical left eye (screen right), '>' on the mirrored right eye
    const E = eyeShape(FACE, 1);
    const w = 0.0052;
    const a = [0.0160 * E.sx, 0.0115], b = [-0.0130 * E.sx, 0.0012], c = [0.0160 * E.sx, -0.0085];
    taper(m.B, quadPts(a, [0.002, 0.0085], b, 16), (t) => w * (0.7 + 0.3 * t), ['round', 'round']);
    taper(m.B, quadPts(b, [0.002, -0.0045], c, 16), (t) => w * (1 - 0.3 * t), ['round', 'round']);
  }
}

function drawIris(ctx, FACE, C, surprised) {
  const S = EYE_CELL / QUADS.eye[0];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, EYE_CELL, EYE_CELL);
  metres(ctx, EYE_CELL / 2, EYE_CELL / 2, S);
  const ir = irisGeom(FACE, surprised);
  const g = ctx.createLinearGradient(0, ir.cy + ir.ry, 0, ir.cy - ir.ry);
  g.addColorStop(0, C.irisTop); g.addColorStop(0.6, C.irisTop); g.addColorStop(1, C.irisBottom);
  ctx.fillStyle = g;
  ellipsePath(ctx, 0, ir.cy, ir.rx, ir.ry); ctx.fill();
  // pupil: slightly darker centre, a touch above the iris centre
  ctx.fillStyle = C.pupil;
  ellipsePath(ctx, 0, ir.cy + ir.ry * 0.06, ir.rx * ir.pupil, ir.ry * ir.pupil); ctx.fill();
  // thin darker ring
  ctx.strokeStyle = C.irisRing; ctx.lineWidth = 0.0013;
  ellipsePath(ctx, 0, ir.cy, ir.rx - 0.00065, ir.ry - 0.00065); ctx.stroke();
}
function irisGeom(FACE, surprised) {
  const sy = FACE.eye.height / 0.046;
  if (surprised) {
    const ry = (0.65 * FACE.eye.height * 1.1) / 2;
    return { rx: ry * 0.84, ry, cy: 0.0006 * sy, pupil: FACE.eye.pupilSurprised };
  }
  const ry = (FACE.eye.irisFrac * FACE.eye.height) / 2;
  return { rx: ry * 0.845, ry, cy: 0.0030 * sy, pupil: FACE.eye.pupilFrac };
}
/** Highlight masks into R/G/B mask canvases (canonical left eye: catch-light upper OUTER = +x). */
function drawHighlights(m, FACE, surprised) {
  const S = EYE_CELL / QUADS.eye[0];
  for (const c of Object.values(m)) { c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#000'; c.fillRect(0, 0, EYE_CELL, EYE_CELL); metres(c, EYE_CELL / 2, EYE_CELL / 2, S); c.fillStyle = '#fff'; }
  const ir = irisGeom(FACE, surprised);
  const iw = ir.rx * 2;
  // 1. main catch-light: ellipse 0.30 iris width, upper outer quadrant, crisp
  const mw = (FACE.highlight.main * iw) / 2;
  ellipsePath(m.R, ir.rx * 0.36, ir.cy + ir.ry * 0.38, mw * 1.05, mw * 1.25, -0.35); m.R.fill();
  // 2. secondary dot: 0.12 iris, lower inner
  const sw = (FACE.highlight.secondary * iw) / 2;
  ellipsePath(m.G, -ir.rx * 0.38, ir.cy - ir.ry * 0.46, sw * 1.15, sw * 1.15); m.G.fill();
  // 3. bottom rim crescent (shader draws it at 40 %)
  m.B.save();
  ellipsePath(m.B, 0, ir.cy, ir.rx * 0.86, ir.ry * 0.86); m.B.clip();
  ellipsePath(m.B, 0, ir.cy - ir.ry * 0.05, ir.rx * 0.86, ir.ry * 0.86); m.B.fill();
  m.B.globalCompositeOperation = 'destination-out';
  ellipsePath(m.B, 0, ir.cy + ir.ry * 0.22, ir.rx * 0.95, ir.ry * 0.95); m.B.fill();
  m.B.restore();
  m.B.globalCompositeOperation = 'source-over';
}

// ------------------------------------------------------------------------------------------- mouth shapes
/**
 * Open mouth: corners at (±w/2, yc), top edge through topMid, bottom edge down to `bottom`.
 * teeth = upper teeth band height (one white band, no separations), tongue = fraction of the opening.
 */
function openMouth(ctx, C, o) {
  const { w, yc, topMid, bottom, teeth = 0, lowTeeth = 0, tongue = 0, lineW = 0.0030, roundTop = 0, crease = 0, cornerRound = 0 } = o;
  const hw = w / 2;
  const L = [-hw, yc], R = [hw, yc];
  const top = roundTop
    ? cubicPts(L, [-hw * 0.9, topMid + (topMid - yc) * 0.35], [hw * 0.9, topMid + (topMid - yc) * 0.35], R, 40)
    : quadPts(L, [0, 2 * topMid - yc], R, 40);
  const by = (bottom - 0.25 * yc) / 0.75; // cubic mid = 0.25*yc + 0.75*cy
  const bot = cubicPts(R, [hw * (0.98 - cornerRound * 0.1), by], [-hw * (0.98 - cornerRound * 0.1), by], L, 40);
  const outline = [...top, ...bot.slice(1)];
  ctx.save();
  pathFromPts(ctx, outline); ctx.fillStyle = C.mouthInterior; ctx.fill();
  ctx.clip();
  if (tongue > 0) {
    ctx.fillStyle = C.tongue;
    const th = (topMid - bottom) * tongue;
    ellipsePath(ctx, hw * 0.06, bottom + th * 0.55, hw * 0.62, th * 1.05); ctx.fill();
    // tongue centre groove
    ctx.strokeStyle = 'rgba(160,50,64,0.55)'; ctx.lineWidth = 0.0012;
    ctx.beginPath(); ctx.moveTo(hw * 0.06, bottom + th * 1.2); ctx.lineTo(hw * 0.06, bottom + th * 0.55); ctx.stroke();
  }
  if (teeth > 0) {
    // one white band following the top edge
    const band = [...top, ...top.slice().reverse().map(([x, y]) => [x, y - teeth * (1 - 0.55 * (Math.abs(x) / hw) ** 3)])];
    pathFromPts(ctx, band); ctx.fillStyle = C.teeth; ctx.fill();
    // soft shade line along the teeth bottom
    ctx.strokeStyle = C.teethShade; ctx.lineWidth = teeth * 0.28;
    pathFromPts(ctx, top.map(([x, y]) => [x, y - teeth * (1 - 0.55 * (Math.abs(x) / hw) ** 3) + teeth * 0.14]), false); ctx.stroke();
  }
  if (lowTeeth > 0) {
    const band = [...bot, ...bot.slice().reverse().map(([x, y]) => [x, y + lowTeeth * (1 - 0.6 * (Math.abs(x) / hw) ** 3)])];
    pathFromPts(ctx, band); ctx.fillStyle = C.teethShade; ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = C.mouthLine; ctx.lineWidth = lineW; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  pathFromPts(ctx, outline); ctx.stroke();
  // corner pulls: crease ticks up into the cheeks
  if (crease > 0) {
    ctx.fillStyle = C.mouthLine;
    for (const s of [-1, 1]) {
      const p0 = [s * (hw - 0.0005), yc + 0.0005];
      const pts = quadPts(p0, [s * (hw + crease * 0.55), yc + crease * 0.25], [s * (hw + crease * 0.7), yc + crease * 1.05], 12);
      taper(ctx, pts, (t) => lineW * (1 - 0.8 * t), ['round', 'point']);
    }
  }
  return outline;
}

function drawMouth(name, ctx, C, FACE) {
  const W = FACE.W, M = FACE.mouths;
  const lw = 0.0030;
  ctx.fillStyle = C.mouthLine;
  switch (name) {
    case 'neutral': {
      const hw = (M.neutral.w * W) / 2, up = M.neutral.cornerUp;
      taper(ctx, quadPts([-hw, up], [0, -up * 0.6], [hw, up], 24), (t) => lw * (0.75 + 0.25 * Math.sin(Math.PI * t)));
      break;
    }
    case 'smile': {
      const hw = (M.smile.w * W) / 2, up = M.smile.cornerUp;
      taper(ctx, quadPts([-hw, up], [0, -up * 1.1], [hw, up], 28), (t) => lw * (0.7 + 0.35 * Math.sin(Math.PI * t)));
      for (const s of [-1, 1]) taper(ctx, quadPts([s * (hw + 0.0008), up + 0.0032], [s * (hw + 0.0026), up + 0.0006], [s * (hw + 0.0016), up - 0.0026], 10), (t) => lw * 0.8 * (1 - 0.6 * t));
      break;
    }
    case 'grin': {
      const g = M.grin, hw = (g.w * W) / 2;
      openMouth(ctx, C, { w: g.w * W, yc: 0.0110, topMid: 0.0072, bottom: 0.0072 - g.h, teeth: g.teeth, tongue: 0.30, lineW: lw, crease: 0.0060 });
      void hw;
      break;
    }
    case 'laugh': {
      const g = M.laugh;
      openMouth(ctx, C, { w: g.w * W, yc: 0.0125, topMid: 0.0090, bottom: 0.0090 - g.h, teeth: 0.0090, tongue: 0.36, lineW: lw, crease: 0.0065 });
      break;
    }
    case 'surprised': {
      const g = M.surprised, rx = (g.w * W) / 2, ry = g.h / 2;
      ctx.save(); ellipsePath(ctx, 0, -0.004, rx, ry); ctx.fillStyle = C.mouthInterior; ctx.fill(); ctx.clip();
      ctx.fillStyle = C.tongue; ellipsePath(ctx, 0, -0.004 - ry * 0.95, rx * 0.8, ry * 0.45); ctx.fill(); ctx.restore();
      ctx.strokeStyle = C.mouthLine; ctx.lineWidth = lw; ellipsePath(ctx, 0, -0.004, rx, ry); ctx.stroke();
      break;
    }
    case 'determined': {
      // clenched grin: both teeth rows, dark centre line, corners slightly down at the outer 10 %
      const g = M.determined, hw = (g.w * W) / 2, hh = g.h / 2;
      const top = [], bot = [];
      for (let i = 0; i <= 40; i++) {
        const x = -hw + (2 * hw * i) / 40, ax = Math.abs(x) / hw;
        const droop = -0.0035 * smooth(0.88, 1.0, ax);
        const round = hh * (1 - Math.sqrt(Math.max(0, 1 - smooth(0.82, 1.0, ax) ** 2)));
        top.push([x, hh + 0.0012 * (1 - ax * ax) * -1 + droop - round + 0.001]);
        bot.push([x, -hh + droop + round * 0.9]);
      }
      const outline = [...top, ...bot.reverse()];
      ctx.save(); pathFromPts(ctx, outline); ctx.fillStyle = C.teeth; ctx.fill(); ctx.clip();
      ctx.fillStyle = C.teethShade; ctx.fillRect(-hw, -hh - 0.004, 2 * hw, hh * 0.85);
      ctx.strokeStyle = C.mouthLine; ctx.lineWidth = lw * 0.8;
      pathFromPts(ctx, top.map(([x, y], i) => [x, (y + bot[bot.length - 1 - i][1]) / 2]), false); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = C.mouthLine; ctx.lineWidth = lw; ctx.lineJoin = 'round';
      pathFromPts(ctx, outline); ctx.stroke();
      break;
    }
    case 'effort': {
      const g = M.effort, hwT = (g.w * W) / 2, hwB = hwT * 0.62;
      const yT = 0.0060, yB = yT - g.h;
      const outline = [
        ...quadPts([-hwT, yT], [0, yT - 0.0016], [hwT, yT], 20),
        ...quadPts([hwT, yT], [hwT * 0.98, yB + 0.002], [hwB, yB], 10).slice(1),
        ...quadPts([hwB, yB], [0, yB - 0.0028], [-hwB, yB], 20).slice(1),
        ...quadPts([-hwB, yB], [-hwT * 0.98, yB + 0.002], [-hwT, yT], 10).slice(1),
      ];
      ctx.save(); pathFromPts(ctx, outline); ctx.fillStyle = C.mouthInterior; ctx.fill(); ctx.clip();
      ctx.fillStyle = C.tongue; ellipsePath(ctx, 0, yB - 0.001, hwB * 0.8, g.h * 0.28); ctx.fill();
      ctx.fillStyle = C.teeth; ctx.fillRect(-hwT, yT - 0.0072, 2 * hwT, 0.01);
      ctx.fillStyle = C.teethShade; ctx.fillRect(-hwT, yT - 0.0072, 2 * hwT, 0.0012);
      ctx.restore();
      ctx.strokeStyle = C.mouthLine; ctx.lineWidth = lw; ctx.lineJoin = 'round';
      pathFromPts(ctx, outline); ctx.stroke();
      break;
    }
    case 'shout': {
      const g = M.shout;
      openMouth(ctx, C, { w: g.w * W, yc: 0.0020, topMid: 0.0115, bottom: 0.0115 - g.h, teeth: 0.0055, tongue: 0.42, lineW: lw, roundTop: 1, cornerRound: 1 });
      break;
    }
    default: {
      // talk visemes: open smiles of growing height (setMouthOpen)
      const lvl = +name.slice(4);
      const h = [0, 0.011, 0.019, 0.029][lvl], w = [0, 0.054, 0.060, 0.064][lvl];
      openMouth(ctx, C, { w, yc: 0.0050, topMid: 0.0025, bottom: 0.0025 - h, teeth: 0.0045 + lvl * 0.0008, tongue: lvl > 1 ? 0.32 : 0, lineW: lw, crease: 0.0035 });
    }
  }
}

function drawBrow(name, ctx, C, FACE, skin) {
  // canonical LEFT brow: inner end at -x. Thick (inner) to thin (outer), slight arch. Bolder than spec
  // minimum so it still reads at 80 px.
  const len = FACE.brow.lengthOfEye * FACE.eye.width; // 0.030
  const hl = len / 2;
  const wIn = Math.max(FACE.brow.thickInner, 0.0040) * 1.45, wOut = Math.max(FACE.brow.thickOuter, 0.0015) * 1.5;
  let p0, p1, p2, wi = wIn;
  switch (name) {
    case 'raised': p0 = [-hl, -0.0010]; p1 = [-0.0015, 0.0095]; p2 = [hl, -0.0005]; break;
    case 'angry': { const s = Math.tan((22 * Math.PI) / 180) * hl; p0 = [-hl, -s]; p1 = [0, 0.0006]; p2 = [hl, s]; wi = wIn * 1.15; break; }
    case 'effort': { const s = Math.tan((20 * Math.PI) / 180) * hl; p0 = [-hl, -s * 0.9]; p1 = [-0.004, -s * 0.55]; p2 = [hl, s * 1.05]; wi = wIn * 1.1; break; }
    case 'worried': p0 = [-hl, 0.0050]; p1 = [0.0015, 0.0042]; p2 = [hl, -0.0042]; break;
    default: p0 = [-hl, -0.0014]; p1 = [0.0005, 0.0062]; p2 = [hl, -0.0006];
  }
  const pts = quadPts(p0, p1, p2, 30);
  const wAt = (t) => lerp(wi, wOut, smooth(0.0, 1.0, t)) * (t < 0.06 ? 0.85 + t * 2.5 : 1);
  // thin, crisp skin-coloured rim (anime brows drawn over the fringe): invisible over the forehead, a
  // hairline-thin light edge where the brow crosses dark bangs, so it still reads. No feathered backing
  // (that showed as tan boxes on the hair).
  ctx.fillStyle = skin;
  taper(ctx, pts, (t) => wAt(t) + 0.0013, ['round', 'round']);
  ctx.fillStyle = C.brow;
  taper(ctx, pts, wAt, ['round', 'point']);
}

function drawNose(ctx, C) {
  // canonical: light from the character's RIGHT (-x), shade wedge on the +x side of the nose.
  ctx.fillStyle = C.noseWedge;
  ctx.beginPath();
  ctx.moveTo(0.0006, 0.0050);
  ctx.quadraticCurveTo(0.0030, 0.0002, 0.0046, -0.0034);
  ctx.quadraticCurveTo(0.0022, -0.0036, -0.0004, -0.0030);
  ctx.quadraticCurveTo(0.0008, 0.0010, 0.0006, 0.0050);
  ctx.fill();
  // 1-px highlight tick on the lit side of the ridge
  ctx.fillStyle = '#FFEBDA';
  taper(ctx, quadPts([-0.0007, 0.0044], [-0.0011, 0.0026], [-0.0013, 0.0006], 8), () => 0.0009);
}

function drawBlush(ctx, C, FACE) {
  const rx = FACE.blush.w / 2, ry = FACE.blush.h / 2;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  const col = new THREE.Color(C.blush);
  const rgba = (a) => `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
  // THREE.Color from a hex string is linear; convert the bytes back to sRGB for the canvas
  col.convertLinearToSRGB();
  g.addColorStop(0, rgba(FACE.blush.opacity * 1.6)); g.addColorStop(0.55, rgba(FACE.blush.opacity * 1.2)); g.addColorStop(1, rgba(0));
  ctx.save(); ctx.scale(rx, ry); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.fillStyle = C.blushHatch;
  for (const x of [-0.0068, 0, 0.0068]) taper(ctx, [[x - 0.0018, -0.0030], [x + 0.0018, 0.0030]], () => 0.0011, ['round', 'round']);
}

// ------------------------------------------------------------------------------------------- packing
function premultiply(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; d[i] = Math.round(d[i] * a); d[i + 1] = Math.round(d[i + 1] * a); d[i + 2] = Math.round(d[i + 2] * a); }
  return img;
}
function makeDataTexture(data, w, h, name) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace; // masks are linear; RGBA cells are premultiplied sRGB decoded in the shader
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8; // QA r2 P2-2: sharper decals at grazing yaw (clamped to the GPU max by three)
  tex.flipY = false;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}
const rect = (x, y, w, h, W, H) => [x / W, (y + h) / H, w / W, -h / H];

/**
 * Build the face atlases.
 * @param {{ dims, palette }} ctx  dims.FACE + palette.FACE_COLORS
 * @returns {{ eyeTex, featTex, cells, quads, dispose() }}
 */
export function createFaceAtlas({ dims, palette }) {
  const FACE = dims.FACE, C = palette.FACE_COLORS;
  const cells = { eye: {}, mouth: {}, brow: {} };

  // ---- eyes
  const eyeData = new Uint8Array(EYE_TEX * EYE_TEX * 4);
  const masks = {};
  for (const ch of ['R', 'G', 'B', 'A']) masks[ch] = canvas2d(EYE_CELL, EYE_CELL)[1];
  const putMasks = (slot) => {
    const cx = (slot % 4) * EYE_CELL, cy = Math.floor(slot / 4) * EYE_CELL;
    const imgs = ['R', 'G', 'B', 'A'].map((k) => masks[k].getImageData(0, 0, EYE_CELL, EYE_CELL).data);
    for (let y = 0; y < EYE_CELL; y++) for (let x = 0; x < EYE_CELL; x++) {
      const s = (y * EYE_CELL + x) * 4, o = ((cy + y) * EYE_TEX + cx + x) * 4;
      eyeData[o] = imgs[0][s]; eyeData[o + 1] = imgs[1][s]; eyeData[o + 2] = imgs[2][s]; eyeData[o + 3] = imgs[3][s];
    }
    return rect(cx, cy, EYE_CELL, EYE_CELL, EYE_TEX, EYE_TEX);
  };
  EYE_STATES.forEach((st, i) => { drawEyeState(st, masks, FACE); cells.eye[st] = putMasks(i); });
  const [ic, ictx] = canvas2d(EYE_CELL, EYE_CELL);
  const putRGBA = (slot) => {
    const cx = (slot % 4) * EYE_CELL, cy = Math.floor(slot / 4) * EYE_CELL;
    const d = premultiply(ictx.getImageData(0, 0, EYE_CELL, EYE_CELL)).data;
    for (let y = 0; y < EYE_CELL; y++) eyeData.set(d.subarray(y * EYE_CELL * 4, (y + 1) * EYE_CELL * 4), ((cy + y) * EYE_TEX + cx) * 4);
    return rect(cx, cy, EYE_CELL, EYE_CELL, EYE_TEX, EYE_TEX);
  };
  drawIris(ictx, FACE, C, false); cells.iris = putRGBA(8);
  drawIris(ictx, FACE, C, true); cells.irisSurprised = putRGBA(9);
  masks.A.setTransform(1, 0, 0, 1, 0, 0); masks.A.fillStyle = '#000'; masks.A.fillRect(0, 0, EYE_CELL, EYE_CELL);
  drawHighlights({ R: masks.R, G: masks.G, B: masks.B }, FACE, false); cells.highlight = putMasks(10);
  drawHighlights({ R: masks.R, G: masks.G, B: masks.B }, FACE, true); cells.highlightSurprised = putMasks(11);
  const eyeTex = makeDataTexture(eyeData, EYE_TEX, EYE_TEX, 'heroEyeAtlas');

  // ---- features (mouth / brows / nose / blush), premultiplied sRGB RGBA
  const [fc, f] = canvas2d(FEAT_W, FEAT_H);
  f.clearRect(0, 0, FEAT_W, FEAT_H);
  const MW = 512, MH = 256;
  MOUTH_SHAPES.forEach((name, i) => {
    const x = (i % 2) * MW, y = Math.floor(i / 2) * MH;
    f.save(); f.beginPath(); f.rect(x, y, MW, MH); f.clip();
    metres(f, x + MW / 2, y + QUADS.mouthOriginY * (MW / QUADS.mouth[0]), MW / QUADS.mouth[0]);
    drawMouth(name, f, C, FACE);
    f.restore();
    cells.mouth[name] = rect(x, y, MW, MH, FEAT_W, FEAT_H);
  });
  const BW = 256, BH = 192, by0 = 6 * MH;
  const small = [...BROW_SHAPES.map((b) => ['brow', b]), ['nose'], ['blush']];
  small.forEach(([kind, name], i) => {
    const x = (i % 4) * BW, y = by0 + Math.floor(i / 4) * BH;
    f.save(); f.beginPath(); f.rect(x, y, BW, BH); f.clip();
    if (kind === 'brow') { metres(f, x + BW / 2, y + BH / 2, BW / QUADS.brow[0]); drawBrow(name, f, C, FACE, palette.PALETTE[palette.MAT.SKIN].base); cells.brow[name] = rect(x, y, BW, BH, FEAT_W, FEAT_H); }
    if (kind === 'nose') { metres(f, x + BW / 2, y + BH / 2, BW / QUADS.nose[0]); drawNose(f, C); cells.nose = rect(x, y, BW, BH, FEAT_W, FEAT_H); }
    if (kind === 'blush') { metres(f, x + BW / 2, y + BH / 2, BW / QUADS.blush[0]); drawBlush(f, C, FACE); cells.blush = rect(x, y, BW, BH, FEAT_W, FEAT_H); }
    f.restore();
  });
  const featData = new Uint8Array(premultiply(f.getImageData(0, 0, FEAT_W, FEAT_H)).data.buffer);
  const featTex = makeDataTexture(featData, FEAT_W, FEAT_H, 'heroFeatureAtlas');
  fc.width = fc.height = 1; ic.width = ic.height = 1; // release canvas memory

  return {
    eyeTex, featTex, cells, quads: QUADS,
    dispose() { eyeTex.dispose(); featTex.dispose(); },
  };
}

/** Debug: draw both atlases into a canvas (QA only; not used at runtime). */
export function debugAtlasCanvas(atlas) {
  const [c, x] = canvas2d(2048, 2048);
  const put = (tex, ox, premul) => {
    const { data, width, height } = tex.image;
    const img = x.createImageData(width, height);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (premul) { const k = a ? 255 / a : 0; img.data[i] = data[i] * k; img.data[i + 1] = data[i + 1] * k; img.data[i + 2] = data[i + 2] * k; img.data[i + 3] = a; }
      else { img.data[i] = data[i]; img.data[i + 1] = data[i + 1]; img.data[i + 2] = Math.max(data[i + 2], data[i + 3]); img.data[i + 3] = 255; }
    }
    x.putImageData(img, ox, 0);
  };
  put(atlas.eyeTex, 0, false);
  put(atlas.featTex, 1024, true);
  return c;
}
