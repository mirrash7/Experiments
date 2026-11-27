// Body helpers shared by the UI: access to the latest tracker frame, distance guidance from 2D keypoint bounds,
// skeleton drawing (glowing, selfie-mirrored) and small filters. No allocations in the per-frame paths except
// where noted.

/** Latest tracker frame from the motion pipeline, or null when it is stale (> maxAgeMs since capture). */
export function freshFrame(motion, maxAgeMs = 600, now = performance.now()) {
  const f = motion?.lastFrame;
  if (!f || !f.joints) return null;
  const t = f.tCapture ?? f.tArrive ?? 0;
  return now - t < maxAgeMs ? f : null;
}

/** Synthetic frames carry pre-mirrored (selfie) 2D keypoints; camera trackers carry raw image coordinates. */
export const kpIsSelfie = (frame) => frame?.source === 'synthetic';

/** Selfie-view x (0 = screen left of a mirror view, where the player's own left appears). */
export const selfieX = (frame, x) => (kpIsSelfie(frame) ? x : 1 - x);

const BOUNDS = { minX: 0, maxX: 0, minY: 0, maxY: 0, n: 0 };
// torso + head + feet keypoints per tracker layout (wrists / hands excluded so a wide hook or a T-pose never reads as
// "off-frame"): MediaPipe 33 landmarks, InstantHMR's 70-joint layout (sources/hmrSource.js I), synthetic = joint-name order
const CORE_NAMES = ['nose', 'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip', 'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel'];
const CORE_IDX = { mediapipe: [0, 11, 12, 23, 24, 27, 28, 29, 30], hmr: [0, 5, 6, 9, 10, 13, 14, 17, 20] };
function coreIndices(frame) {
  const kp = frame.kp2d;
  if (frame.source === 'mediapipe' && kp.length >= 31) return CORE_IDX.mediapipe;
  if (frame.source === 'hmr' && kp.length >= 21) return CORE_IDX.hmr;
  if (frame.source === 'synthetic' && frame.joints) {
    const names = Object.keys(frame.joints);
    if (names.length !== kp.length) return null;
    const idx = CORE_NAMES.map((n) => names.indexOf(n)).filter((i) => i >= 0);
    return idx.length >= 5 ? idx : null;
  }
  return null;
}
/** Bounding box of the confident 2D keypoints (selfie view). Reuses one object. coreOnly: head / torso / feet only. */
export function kpBounds(frame, minC = 0.45, coreOnly = false) {
  const kp = frame?.kp2d;
  BOUNDS.n = 0;
  if (!kp || !kp.length) return BOUNDS;
  const idx = coreOnly ? coreIndices(frame) : null;
  const N = idx ? idx.length : kp.length;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
  for (let k = 0; k < N; k++) {
    const p = kp[idx ? idx[k] : k];
    if (!p || (p.c ?? 1) < minC) continue;
    const x = selfieX(frame, p.x);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; n++;
  }
  Object.assign(BOUNDS, { minX: x0, maxX: x1, minY: y0, maxY: y1, n });
  return BOUNDS;
}

/**
 * Distance guidance from the keypoint bounds: 'too-close' | 'too-far' | 'off-left' | 'off-right' | null.
 * 'off-left' = the player is off to THEIR left (screen left in the rear gameplay camera) → tell them to move right.
 * upperBodyOnly: feet may be out of frame.
 */
export function measureDistance(frame, { upperBodyOnly = false } = {}) {
  if (!frame) return null;
  const b = kpBounds(frame, 0.45, true);
  if (b.n < 5) return null;
  const c = frame.conf || {};
  const cx = (b.minX + b.maxX) / 2;
  const feet = Math.min(c.leftAnkle ?? 1, c.rightAnkle ?? 1);
  if (cx < 0.28 || b.minX < 0.005) return 'off-left';
  if (cx > 0.72 || b.maxX > 0.995) return 'off-right';
  // the nose sits ~0.06 frame below the top of the head: extend the box upwards for the size / clip tests
  const top = b.minY - 0.06;
  if (!upperBodyOnly && (feet < 0.35 || b.maxY > 0.985 || b.maxY - top > 0.93 || top < -0.03)) return 'too-close';
  if (upperBodyOnly && (top < -0.01 || b.maxY - top > 0.97)) return 'too-close';
  if (b.maxY - top < (upperBodyOnly ? 0.25 : 0.4)) return 'too-far';
  return null;
}

export const DISTANCE_TEXT = {
  'too-close': { title: 'STEP BACK', sub: 'Your whole body needs to fit in view', arrow: 'down' },
  'too-far': { title: 'STEP FORWARD', sub: 'Come a little closer to the camera', arrow: 'up' },
  'off-left': { title: 'MOVE RIGHT', sub: 'You are drifting out of frame', arrow: 'right' },
  'off-right': { title: 'MOVE LEFT', sub: 'You are drifting out of frame', arrow: 'left' },
};

/**
 * Draw a glowing skeleton (kp2d normalized image coords) into a 2D canvas context.
 * map(x, y) → [px, py] maps normalized selfie-view coords to canvas pixels.
 */
export function drawSkeleton(g, frame, kp2d, edges, map, { width = 3, color = '#7ff7ff', core = '#ffffff', glow = 14, joints = true, alpha = 1 } = {}) {
  if (!kp2d || !edges) return;
  const selfie = frame ? kpIsSelfie(frame) : true;
  const P = (p) => map(selfie ? p.x : 1 - p.x, p.y);
  g.save();
  g.globalAlpha = alpha;
  g.lineCap = 'round'; g.lineJoin = 'round';
  // glow pass
  g.shadowColor = color; g.shadowBlur = glow;
  g.strokeStyle = color; g.lineWidth = width * 2.2;
  g.beginPath();
  for (let i = 0; i < edges.length; i++) {
    const a = kp2d[edges[i][0]], b = kp2d[edges[i][1]];
    if (!a || !b || Math.min(a.c ?? 1, b.c ?? 1) < 0.3) continue;
    const pa = P(a), pb = P(b);
    g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]);
  }
  g.stroke();
  // core pass
  g.shadowBlur = 0; g.strokeStyle = core; g.lineWidth = width * 0.8;
  g.stroke();
  if (joints) {
    g.fillStyle = core; g.shadowColor = color; g.shadowBlur = glow * 0.6;
    g.beginPath();
    for (let i = 0; i < kp2d.length; i++) {
      const p = kp2d[i];
      if (!p || (p.c ?? 1) < 0.45) continue;
      const q = P(p);
      g.moveTo(q[0] + width, q[1]); g.arc(q[0], q[1], width, 0, 6.2832);
    }
    g.fill();
  }
  g.restore();
}

/** One-euro filter on a scalar (render-rate). */
export class OneEuro {
  constructor(minCutoff = 1.5, beta = 1, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; this.dx = 0; }
  reset(x = null) { this.x = x; this.dx = 0; }
  filter(x, dt) {
    if (this.x === null || !(dt > 0)) { this.x = x; this.dx = 0; return x; }
    const a = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
    const dx = (x - this.x) / dt;
    this.dx += (dx - this.dx) * a(this.dCutoff);
    this.x += (x - this.x) * a(this.minCutoff + this.beta * Math.abs(this.dx));
    return this.x;
  }
}

/** Torso forward (horizontal unit vector, player frame) from the shoulder + hip lines; writes into out {x,z}. */
export function torsoForward(J, out = { x: 0, z: 1 }) {
  let sx = J.leftShoulder.x - J.rightShoulder.x, sz = J.leftShoulder.z - J.rightShoulder.z;
  if (J.leftHip && J.rightHip) { sx += J.leftHip.x - J.rightHip.x; sz += J.leftHip.z - J.rightHip.z; }
  const fx = -sz, fz = sx, L = Math.hypot(fx, fz) || 1;
  out.x = fx / L; out.z = fz / L;
  return out;
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Create an element with classes / attributes / children. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

/** A hand-cursor button. */
export function uiButton(label, onClick, { cls = '', icon = null, sub = null, id = null } = {}) {
  const b = h('button', { class: 'bl-btn ' + cls, 'data-ui-button': id || '', type: 'button' },
    h('span', { class: 'bl-btn-fill' }),
    icon ? h('span', { class: 'bl-btn-icon', html: icon }) : null,
    h('span', { class: 'bl-btn-label' }, label, sub ? h('small', {}, sub) : null));
  b.addEventListener('click', (e) => { if (b.disabled) return; onClick?.(e); });
  return b;
}
