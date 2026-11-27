// BREAKLIGHT CV: the Mirror "pour" (QA art r2 P1-3). The silhouette the player sees dissolves into a borderless stream of
// light particles that arc into the hero's on-screen body and land in a flash ON the hero (a soft additive rim light
// around the hero's silhouette that swells and fades, a faint chest bloom and a ground ring). No panel, no DOM box: one transparent full-screen 2D canvas, removed at the end.
//
// Sources: the pixels of whatever shows the silhouette (the mirror's own canvas in cv-lab, the UI's calibration canvas
// in the game, or any element / rect passed in). Targets: random points on the hero's bone capsules (head, torso, limbs)
// re-projected every frame through the live camera, so the stream keeps hitting the body even while the camera moves
// (calibrate -> title cut) or the hero animates. Source and target points are paired by height (head flows to head).
import * as THREE from 'three';

const SEGMENTS = [   // [boneA, boneB, radius (fraction of hero height), weight]
  ['head', 'headTop', 0.07, 1.6], ['neck', 'head', 0.045, 0.5], ['chest', 'neck', 0.07, 1], ['spine', 'chest', 0.085, 1.4], ['hips', 'spine', 0.08, 1.2],
  ['leftUpperArm', 'rightUpperArm', 0.04, 0.8],
  ['leftUpperArm', 'leftForeArm', 0.032, 0.8], ['leftForeArm', 'leftHand', 0.028, 0.7], ['leftHand', 'leftHandTip', 0.02, 0.3],
  ['rightUpperArm', 'rightForeArm', 0.032, 0.8], ['rightForeArm', 'rightHand', 0.028, 0.7], ['rightHand', 'rightHandTip', 0.02, 0.3],
  ['leftThigh', 'leftShin', 0.05, 1.1], ['leftShin', 'leftFoot', 0.038, 0.9], ['leftFoot', 'leftToe', 0.025, 0.3],
  ['rightThigh', 'rightShin', 0.05, 1.1], ['rightShin', 'rightFoot', 0.038, 0.9], ['rightFoot', 'rightToe', 0.025, 0.3],
];
const COLORS = ['#7ef9ff', '#bff6ff', '#ffffff', '#fff1c4', '#ffc85a'];   // travel progress: cyan -> white -> gold
const _v = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Sample lit pixels of a canvas-like element shown at `rect` (CSS px). Returns [{x, y, a}] (CSS px). */
export function sampleSource(img, rect, { max = 1800, res = 220 } = {}) {
  const iw = img.videoWidth || img.naturalWidth || img.width, ih = img.videoHeight || img.naturalHeight || img.height;
  if (!iw || !ih || !rect || rect.width < 2 || rect.height < 2) return [];
  const sw = Math.max(16, Math.round(res * Math.min(1, iw / ih))), sh = Math.max(16, Math.round(res * Math.min(1, ih / iw)));
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const g = c.getContext('2d', { willReadFrequently: true });
  try { g.drawImage(img, 0, 0, sw, sh); } catch { return []; }
  let d;
  try { d = g.getImageData(0, 0, sw, sh).data; } catch { return []; }
  const pts = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4, a = d[i + 3];
    if (a < 30) continue;
    const L = (d[i] + d[i + 1] + d[i + 2]) / 765;
    if (L * (a / 255) < 0.05) continue;
    pts.push({ x: rect.left + ((x + Math.random()) / sw) * rect.width, y: rect.top + ((y + Math.random()) / sh) * rect.height, a: a / 255 });
  }
  // even subsample
  if (pts.length > max) { const out = []; const step = pts.length / max; for (let k = 0; k < max; k++) out.push(pts[Math.floor(k * step + Math.random() * step * 0.9)]); return out; }
  return pts;
}

/** Points in a box (fallback when there is nothing to sample): a soft standing-figure ellipse cloud. */
export function boxSource(rect, n = 700) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = Math.random(), u = (Math.random() - 0.5) * (t < 0.15 ? 0.25 : t < 0.55 ? 0.55 : 0.35);
    pts.push({ x: rect.left + rect.width * (0.5 + u), y: rect.top + rect.height * (0.05 + t * 0.9), a: 1 });
  }
  return pts;
}

/**
 * Run the pour. o: { sources [{x,y,a}], hero (loadVRMHero result), camera, canvas (renderer canvas, for its CSS rect),
 * rect (fallback target, CSS px), duration ms, flash bool, onArrive() at the flash, zIndex, timeScale (slow-mo for
 * captures) }. Resolves when done.
 */
export function runPour({ sources, hero = null, camera = null, canvas = null, rect = null, duration = 1500, flash = true, onArrive = null, zIndex = 60, timeScale = 1 } = {}) {
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const W = innerWidth, H = innerHeight;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.className = 'blcv-pour';
  Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', width: `${W}px`, height: `${H}px`, pointerEvents: 'none', zIndex: String(zIndex) });
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);

  // ---- targets on the hero's bones
  const B = hero?.bones;
  const segs = B?.hips ? SEGMENTS.filter(([a, b]) => B[a] && B[b]) : [];
  const Hh = hero?.info?.height || 1.6;
  const bonePos = {};
  const readBones = () => { for (const [a, b] of segs) { (bonePos[a] ||= new THREE.Vector3()); (bonePos[b] ||= new THREE.Vector3()); B[a].getWorldPosition(bonePos[a]); B[b].getWorldPosition(bonePos[b]); } };
  const crect = () => canvas?.getBoundingClientRect?.() || { left: 0, top: 0, width: W, height: H };
  let CR = crect();
  const project = (p, out) => {
    _v.copy(p).applyMatrix4(_m);
    out.x = CR.left + (_v.x * 0.5 + 0.5) * CR.width; out.y = CR.top + (0.5 - _v.y * 0.5) * CR.height; out.ok = _v.z < 1;
    return out;
  };
  const updM = () => { camera.updateMatrixWorld(); _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); CR = crect(); };
  const N = sources.length;
  const totalW = segs.reduce((s, x) => s + x[3], 0);
  const parts = new Array(N);
  if (segs.length && camera) { readBones(); updM(); }
  const tgt = [];
  for (let i = 0; i < N; i++) {
    if (segs.length && camera) {
      let r = Math.random() * totalW, si = 0;
      while (si < segs.length - 1 && (r -= segs[si][3]) > 0) si++;
      const off = new THREE.Vector3().randomDirection().multiplyScalar(segs[si][2] * Hh * Math.cbrt(Math.random()));
      const t = Math.random();
      const wy = bonePos[segs[si][0]].y + (bonePos[segs[si][1]].y - bonePos[segs[si][0]].y) * t + off.y;
      tgt.push({ si, t, off, key: -wy });
    } else {
      const R = rect || { left: W / 2 - 80, top: H * 0.3, width: 160, height: H * 0.5 };
      const ty = Math.random();
      tgt.push({ sx: R.left + R.width * (0.5 + (Math.random() - 0.5) * (ty < 0.15 ? 0.35 : 0.7)), sy: R.top + R.height * ty, key: ty });
    }
  }
  // pair by height: highest source pixel -> highest target point
  const srcOrder = sources.map((s, i) => i).sort((a, b) => sources[a].y - sources[b].y);
  tgt.sort((a, b) => a.key - b.key);
  const travel = duration * 0.55;
  for (let k = 0; k < N; k++) {
    const s = sources[srcOrder[k]];
    const rank = k / Math.max(1, N - 1);
    parts[k] = {
      x0: s.x, y0: s.y, a: s.a, t: tgt[k],
      delay: duration * (0.06 + rank * 0.2 + Math.random() * 0.14),   // the head leaves first, the stream follows
      dur: travel * (0.8 + Math.random() * 0.4),
      lift: 0.03 + Math.random() * 0.09, swirl: (Math.random() - 0.5) * 0.35, size: 1.1 + Math.random() * 1.5,
      px: s.x, py: s.y, done: false,
    };
  }

  const tp = { x: 0, y: 0, ok: true };
  const targetXY = (p) => {
    const T = p.t;
    if (T.si === undefined) { tp.x = T.sx; tp.y = T.sy; return tp; }
    const [a, b] = segs[T.si];
    _v.copy(bonePos[a]).lerp(bonePos[b], T.t).add(T.off);
    return project(_v, tp);
  };
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

  // ---- hero rim light (QA art r3 P2-4): the arrival glow is a soft additive rim + bloom AROUND the hero's silhouette,
  // never a fill. The silhouette is approximated by the bone capsules, drawn as ONE union mask (source-over, so the
  // shoulder line and the torso never double up into a band) at half resolution; the rim is the blurred mask with a
  // softly-eroded copy cut out of it (a feathered edge, no hard line), tinted, plus a wider faint bloom.
  const pa = { x: 0, y: 0, ok: true }, pb = { x: 0, y: 0, ok: true };
  const RS = 0.5;   // mask resolution (x CSS px)
  const mW = Math.max(2, Math.round(W * RS)), mH = Math.max(2, Math.round(H * RS));
  const mkC = () => { const c = document.createElement('canvas'); c.width = mW; c.height = mH; return c; };
  const maskC = mkC(), rimC = mkC();
  const mg = maskC.getContext('2d'), rg = rimC.getContext('2d');
  const hasFilter = typeof rg.filter === 'string';
  /** Draw `src` into `dst` blurred by `px` (mask px), with the given composite op. ctx.filter, or a shadow fallback. */
  function blurDraw(dst, src, px, op) {
    dst.save(); dst.globalCompositeOperation = op;
    if (hasFilter) { dst.filter = `blur(${px.toFixed(1)}px)`; dst.drawImage(src, 0, 0); }
    else { dst.shadowColor = '#fff'; dst.shadowBlur = px * 2; dst.shadowOffsetX = mW + 50; dst.drawImage(src, -(mW + 50), 0); }
    dst.restore();
  }
  let pxPerM = 0;
  /** The hero's capsule silhouette into maskC (white, union). Returns false when there is nothing to draw. */
  function drawMask() {
    if (!segs.length || !camera) return false;
    project(bonePos.hips || bonePos[segs[0][0]], pa);
    _v.copy(bonePos.hips || bonePos[segs[0][0]]); _v.y += Hh; project(_v, pb);
    pxPerM = Math.abs(pa.y - pb.y) / Hh;
    mg.clearRect(0, 0, mW, mH);
    mg.save(); mg.scale(RS, RS);
    mg.lineCap = 'round'; mg.lineJoin = 'round'; mg.strokeStyle = '#fff'; mg.fillStyle = '#fff';
    for (const [a, b, r] of segs) {
      project(bonePos[a], pa); project(bonePos[b], pb);
      mg.lineWidth = Math.max(2, r * Hh * pxPerM * 1.7);
      mg.beginPath(); mg.moveTo(pa.x, pa.y); mg.lineTo(pb.x, pb.y); mg.stroke();
    }
    mg.restore();
    return true;
  }
  /** Soft rim light around the hero. alpha 0..1, spread: rim width (x hero-height px), color css. */
  function rimLight(alpha, spread, color) {
    if (alpha <= 0.01 || !drawMask()) return;
    const hpx = Hh * pxPerM * RS;                       // hero height in mask px
    const rimPx = Math.max(2, hpx * 0.022 * spread);
    rg.clearRect(0, 0, mW, mH);
    blurDraw(rg, maskC, rimPx, 'source-over');           // soft halo around (and inside) the silhouette
    blurDraw(rg, maskC, rimPx * 0.9, 'destination-out'); // hollow it out: a dilated-then-eroded ring...
    blurDraw(rg, maskC, rimPx * 2.6, 'source-over');     // ...plus a wide soft bloom that falls off outward
    blurDraw(rg, maskC, rimPx * 0.6, 'destination-out'); // keep the body itself clear (only a feathered inner edge)
    rg.save(); rg.globalCompositeOperation = 'source-in'; rg.fillStyle = color; rg.fillRect(0, 0, mW, mH); rg.restore();
    g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = Math.min(1, alpha);
    g.imageSmoothingEnabled = true;
    g.drawImage(rimC, 0, 0, W, H);
    g.drawImage(rimC, 0, 0, W, H);                       // two passes: brighter core of the rim without a wider spread
    g.restore();
  }
  function groundRing(k) {
    if (!segs.length || !camera) return;
    const c = new THREE.Vector3().copy(bonePos.leftFoot || bonePos.hips).add(bonePos.rightFoot || bonePos.hips).multiplyScalar(0.5);
    c.y = Math.min(c.y, 0.03);
    const rad = (0.25 + 1.1 * k) * Hh * 0.5;
    g.save(); g.globalCompositeOperation = 'lighter';
    g.strokeStyle = '#ffd77a'; g.globalAlpha = (1 - k) * 0.9; g.lineWidth = 3 + 5 * (1 - k); g.shadowColor = '#ffb040'; g.shadowBlur = 18;
    g.beginPath();
    for (let i = 0; i <= 48; i++) { const th = (i / 48) * Math.PI * 2; _v.set(c.x + Math.cos(th) * rad, c.y, c.z + Math.sin(th) * rad); project(_v, pa); if (i) g.lineTo(pa.x, pa.y); else g.moveTo(pa.x, pa.y); }
    g.stroke(); g.restore();
  }
  function chestBurst(k) {
    let x, y, R;
    if (segs.length && camera && bonePos.chest) { project(bonePos.chest, pa); x = pa.x; y = pa.y; _v.copy(bonePos.chest); _v.y += Hh * 0.5; project(_v, pb); R = Math.abs(pb.y - y) * 1.6; }
    else { const r = rect || { left: W / 2 - 80, top: H * 0.3, width: 160, height: H * 0.5 }; x = r.left + r.width / 2; y = r.top + r.height * 0.35; R = r.height * 0.8; }
    R *= 0.35 + 0.9 * k;
    const gr = g.createRadialGradient(x, y, 0, x, y, R);
    const f = (1 - k) * (1 - k);   // smooth ease-out
    gr.addColorStop(0, `rgba(255,248,224,${0.32 * f})`); gr.addColorStop(0.25, `rgba(255,206,120,${0.2 * f})`); gr.addColorStop(0.6, `rgba(126,249,255,${0.07 * f})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect(x - R, y - R, R * 2, R * 2); g.restore();
  }

  return new Promise((resolve) => {
    const t0 = performance.now();
    const flashAt = duration * 0.86, flashLen = 560, end = duration + flashLen;
    let arrived = 0, flashed = false;
    const step = () => {
      const t = (performance.now() - t0) * timeScale;
      if (segs.length && camera) { readBones(); updM(); }
      g.clearRect(0, 0, W, H);
      const P = COLORS.map(() => new Path2D()), PG = COLORS.map(() => new Path2D());
      const trail = new Path2D();
      arrived = 0;
      for (const p of parts) {
        const k = (t - p.delay) / p.dur;
        if (k >= 1) { arrived++; continue; }
        const T = targetXY(p);
        let x, y, kk = 0;
        if (k <= 0) {
          // waiting: the silhouette shimmers in place (it IS the silhouette for these first frames)
          x = p.x0 + Math.sin(t * 0.02 + p.x0) * 0.6; y = p.y0 + Math.cos(t * 0.017 + p.y0) * 0.6;
        } else {
          kk = ease(k);
          const dx = T.x - p.x0, dy = T.y - p.y0;
          const cx = p.x0 + dx * 0.5 - dy * p.swirl, cy = p.y0 + dy * 0.5 - H * p.lift - Math.abs(dx) * 0.15;
          const u = 1 - kk;
          x = u * u * p.x0 + 2 * u * kk * cx + kk * kk * T.x;
          y = u * u * p.y0 + 2 * u * kk * cy + kk * kk * T.y;
          trail.moveTo(p.px, p.py); trail.lineTo(x, y);
        }
        p.px = x; p.py = y;
        const ci = Math.min(COLORS.length - 1, Math.floor(kk * COLORS.length));
        const r = p.size * (k <= 0 ? 1.1 : 1.6 - kk * 0.8);
        P[ci].moveTo(x + r, y); P[ci].arc(x, y, r, 0, Math.PI * 2);
        PG[ci].moveTo(x + r * 3.2, y); PG[ci].arc(x, y, r * 3.2, 0, Math.PI * 2);
      }
      g.save();
      g.globalCompositeOperation = 'lighter';
      // fade-in of the stream so the first frame matches the silhouette, fade-out after the flash
      const master = Math.min(1, t / 90) * (t > flashAt ? Math.max(0, 1 - (t - flashAt) / 250) : 1);
      g.globalAlpha = 0.35 * master; g.strokeStyle = '#ffe8b0'; g.lineWidth = 1.4; g.stroke(trail);
      for (let i = 0; i < COLORS.length; i++) { g.fillStyle = COLORS[i]; g.globalAlpha = 0.16 * master; g.fill(PG[i]); g.globalAlpha = 0.95 * master; g.fill(P[i]); }
      g.restore();
      // build-up glow on the hero as particles land, then the flash
      const fr = arrived / Math.max(1, N);
      if (t < flashAt) rimLight(fr * 0.55, 0.8, '#ffd9a0');
      else {
        if (!flashed) { flashed = true; try { onArrive?.(); } catch { /* */ } }
        const k = Math.min(1, (t - flashAt) / flashLen);
        // smooth envelope: swells for the first ~20% (from the build-up level), then eases out to nothing
        const env = k < 0.2 ? 0.55 + 0.45 * Math.sin((k / 0.2) * Math.PI * 0.5) : Math.pow(1 - (k - 0.2) / 0.8, 2);
        if (flash) { rimLight(env, 1 + k * 0.9, '#ffe2a8'); chestBurst(k); groundRing(k); }
        else rimLight(env * 0.6, 1, '#ffd9a0');
      }
      if (t < end) requestAnimationFrame(step);
      else { cv.remove(); resolve({ particles: N, targets: segs.length ? 'bones' : 'rect' }); }
    };
    requestAnimationFrame(step);
  });
}
