// BREAKLIGHT CV: skeleton-based silhouette (fallback when segmentation isn't available, or with the demo tracker / no
// camera). Normalises keypoints from any tracker frame (MediaPipe 33, the synthetic demo player) or projects the hero's
// bones from a virtual front camera, and rasterises a soft body shape (torso, tapered limbs, head) into a canvas in the
// same "unmirrored camera image" space as the segmentation cutout.
import * as THREE from 'three';

const MP = { nose: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28 };
export const BODY_NAMES = Object.keys(MP);

/** Named 2D points {name: {x, y, c}} (normalised image coords) from a tracker frame, or null if the layout is unknown. */
export function namedFromFrame(f) {
  const kp = f?.kp2d;
  if (!kp || !kp.length) return null;
  const out = {};
  if (f.source === 'mediapipe' || kp.length === 33) {
    for (const n of BODY_NAMES) { const p = kp[MP[n]]; if (p) out[n] = p; }
    return out;
  }
  const names = f.joints ? Object.keys(f.joints) : null;
  if (names && names.length === kp.length) {
    for (const n of BODY_NAMES) { const i = names.indexOf(n); if (i >= 0) out[n] = kp[i]; }
    if (!out.nose && names.includes('head')) out.nose = kp[names.indexOf('head')];
    return out.leftShoulder && out.rightShoulder ? out : null;
  }
  return null;
}

const HERO_BONES = { nose: 'head', leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm', leftElbow: 'leftForeArm', rightElbow: 'rightForeArm',
  leftWrist: 'leftHand', rightWrist: 'rightHand', leftHip: 'leftThigh', rightHip: 'rightThigh', leftKnee: 'leftShin', rightKnee: 'rightShin',
  leftAnkle: 'leftFoot', rightAnkle: 'rightFoot' };
const _v = new THREE.Vector3(), _h = new THREE.Vector3();

/**
 * Named 2D points from the hero's bones, seen from the front (as a webcam would see the player: the hero's left is image
 * right). aspect = target width / height. `out` is reused.
 */
export function namedFromHero(hero, aspect = 16 / 9, out = {}) {
  const b = hero?.bones;
  if (!b?.hips) return null;
  b.hips.getWorldPosition(_h);
  const height = hero.info?.height || 1.6;
  const span = height / 0.78;               // person ~78% of the frame height
  const cy = height * 0.52;
  for (const n of BODY_NAMES) {
    const bone = b[HERO_BONES[n]];
    if (!bone) continue;
    bone.getWorldPosition(_v);
    if (n === 'nose') _v.y += height * 0.045;
    const p = out[n] || (out[n] = { x: 0, y: 0, c: 1 });
    p.x = 0.5 + (_v.x - _h.x) / (span * aspect);
    p.y = 0.5 - (_v.y - cy) / span;
    p.c = 1;
  }
  return out;
}

/**
 * Rasterise a body silhouette from named points into ctx (canvas w x h). Returns the bbox (normalised) or null.
 * Smooth capsule body (round-capped limbs, joint discs, oval head) in mid grey, plus thin WHITE bone core lines: the
 * hologram shader (neon.js holoShade, uSkel = 1) draws the alpha edge as the neon outline and the white lines as the
 * inner lines of a capsule hologram, like the calibration guide. Alpha is the mask (photo booth / card use only alpha).
 */
export function drawSkeletonSilhouette(ctx, P, w, h) {
  ctx.clearRect(0, 0, w, h);
  const ok = (n) => P[n] && (P[n].c ?? 1) > 0.2;
  if (!ok('leftShoulder') || !ok('rightShoulder')) return null;
  const X = (n) => P[n].x * w, Y = (n) => P[n].y * h;
  const sw = Math.max(6, Math.hypot(X('leftShoulder') - X('rightShoulder'), Y('leftShoulder') - Y('rightShoulder')));
  const FILL = '#7a7a7a';
  ctx.fillStyle = FILL; ctx.strokeStyle = FILL;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const mx = (X('leftShoulder') + X('rightShoulder')) / 2, my = (Y('leftShoulder') + Y('rightShoulder')) / 2;
  const hx = ok('nose') ? X('nose') : mx, hy = ok('nose') ? Y('nose') : my - sw * 0.7;
  const hasHips = ok('leftHip') && ok('rightHip');
  // torso: rounded quad (shoulders -> hips), slightly tapered at the waist
  if (hasHips) {
    ctx.beginPath();
    ctx.moveTo(X('leftShoulder'), Y('leftShoulder')); ctx.lineTo(X('rightShoulder'), Y('rightShoulder'));
    ctx.lineTo(X('rightHip'), Y('rightHip')); ctx.lineTo(X('leftHip'), Y('leftHip')); ctx.closePath();
    ctx.lineWidth = sw * 0.32; ctx.fill(); ctx.stroke();
  }
  const limbs = [];
  for (const s of ['left', 'right']) limbs.push([s + 'Shoulder', s + 'Elbow', 0.24], [s + 'Elbow', s + 'Wrist', 0.2], [s + 'Hip', s + 'Knee', 0.32], [s + 'Knee', s + 'Ankle', 0.25]);
  for (const [a, b, wd] of limbs) { if (!ok(a) || !ok(b)) continue; ctx.lineWidth = wd * sw; ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke(); }
  for (const s of ['left', 'right']) {
    if (ok(s + 'Wrist')) { ctx.beginPath(); ctx.arc(X(s + 'Wrist'), Y(s + 'Wrist'), sw * 0.14, 0, Math.PI * 2); ctx.fill(); }
    if (ok(s + 'Ankle')) { ctx.beginPath(); ctx.ellipse(X(s + 'Ankle'), Y(s + 'Ankle') + sw * 0.05, sw * 0.15, sw * 0.1, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.lineWidth = sw * 0.24; ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(hx, hy - sw * 0.05, sw * 0.26, sw * 0.32, 0, 0, Math.PI * 2); ctx.fill();
  // bone core lines (white): spine, collarbone, pelvis, limbs, head ring
  ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, sw * 0.035);
  const seg = (a, b) => { if (!ok(a) || !ok(b)) return; ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke(); };
  seg('leftShoulder', 'rightShoulder');
  if (hasHips) {
    seg('leftHip', 'rightHip');
    const px = (X('leftHip') + X('rightHip')) / 2, py = (Y('leftHip') + Y('rightHip')) / 2;
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(px, py); ctx.stroke();
  }
  for (const [a, b] of limbs) seg(a, b);
  ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(hx, hy + sw * 0.2); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(hx, hy - sw * 0.05, sw * 0.17, sw * 0.22, 0, 0, Math.PI * 2); ctx.stroke();
  for (const n of BODY_NAMES) if (n !== 'nose' && ok(n)) { ctx.beginPath(); ctx.arc(X(n), Y(n), Math.max(1.2, sw * 0.04), 0, Math.PI * 2); ctx.fill(); }
  // bbox
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const n of BODY_NAMES) if (ok(n)) { x0 = Math.min(x0, P[n].x); x1 = Math.max(x1, P[n].x); y0 = Math.min(y0, P[n].y); y1 = Math.max(y1, P[n].y); }
  const pad = sw / w * 0.4;
  return { x0: x0 - pad, y0: Math.min(y0, (hy - sw * 0.4) / h), x1: x1 + pad, y1: y1 + pad * 0.5, cov: 0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
