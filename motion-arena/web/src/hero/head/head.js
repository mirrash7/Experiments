// Head + face package entry (spec 2.3, 2.4). Owner: WP3.
//
//   skull   deformed 56×44 UV sphere driven by an analytic head shape (createHeadShape): per-height
//           cross-sections (half width, front plane, back; QA r1 refit in HEAD_FIT), flat face plane via a soft
//           z clamp (0.02 knee), cheekbones at the eye line, jaw tapering to a rounded chin point,
//           back-of-skull bulge, 0.007 triangular nose point (QA r2 P1-2), lower face pulled back + rounded U chin
//           (QA r2 P1-6, HEAD_FIT.chinHalf / mouthZ / chinForward). Ears (C-shaped helix, painted inner line)
//           merged in. Front-face normals transferred from a smooth ellipsoid proxy (80 % proxy / 20 % real),
//           outline normals kept from the real surface. Rigid on the head bone, ctx.materials.face.
//   face    three decal layers parented to the head bone, each SHRINK-WRAPPED onto the head shape (arc-length
//           wrap round horizontal slices, lifted along the true normal, faded at grazing angles), so nothing can
//           leave the head silhouette. Eyes + brows get a per-view anime cheat (faceRig: wider + slid toward the
//           camera when seen obliquely) so they read at 3/4 and in profile:
//             eyes     (2 quads, 1 draw): mask-composited sclera / iris (gaze) / highlights / lash lines
//             features (mouth + painted nose wedge + blush, 1 draw; teeth turn to mouth interior from 0.52 facing,
//                      before the lip fade, QA r2 P2-2)
//             brows    (2 quads, 1 draw) pulled toward the camera along the view ray so they read OVER the
//                      bangs (screen position unchanged, depth wins against hair within 3 cm but still loses
//                      to an arm in front of the face), faded out when facing away.
//           Atlases: faceAtlas.js. State machine / api: faceRig.js.
//
// Builder contract: buildHead(ctx) -> { meshes, update(dt, ctx), dispose(), api }
// api: { expressions, setExpression(name) -> name, blink(0..1), setMouthOpen(0..1), setGaze(x, y), ... }
//
// ---- Neck seam (WP2 <-> WP3), keep in sync with body/body.js:
//   * WP2 neck loft: cone (0, ~1.36, -0.012) -> (0, 1.565, -0.006), half width dims.BODY.neckRadius.w (0.044)
//     tapering to ~0.038 at the top, ends INSIDE the head.
//   * Head shell: covers y >= chinY (1.490) at the front; the back half narrows ("jaw angle") to a nape plug of
//     half width HEAD_FIT.napeHalf (0.036, inside the neck = hidden) below h 0.17 (y 1.533) and opens out to the
//     full skull width by h HEAD_FIT.waistH[1] (y 1.612). So the neck visibly enters the skull base behind the
//     jaw (no horizontal jaw shelf on 70 deg turns) and the neck top (1.565) is always enclosed.
//   * Skin blend: inside the neck footprint (r = hypot(x/0.044, z/0.040) < NECK_FOOT[0], feathered to [1]) head
//     vertices blend neck -> head over y NECK_BLEND = 1.47 .. 1.55 (widened from 1.53 in QA r1). WP2's neck
//     skin should use the same window so both sides of the seam move identically.
//   * Jaw underside shadeBias is a soft gradient (-0.3 max) driven by the real normal, not a step.
// REQUEST(WP2): shadeBias -0.3 on the neck crease just under the jaw, ramping to 0 over 0.02.
// REQUEST(WP0): QA r1 head refit lives in HEAD_FIT below (skull 0.186 temples / 0.172 eye line / 0.138 jaw,
//   measured with ears ~0.204, h/w 1.25). Please mirror into dims.BODY.skullWidth and set
//   dims.HEAD.sphereSegments to [56, 44] (tri budget: head <= 6k). dims.FACE.ear.x is now derived from the surface.
// REQUEST(WP1): head/hair uvs are (0,0) (no detail atlas). Face front vertices carry outlineWidth 0 and the hull
//   width rises smoothly to 1 at the cheek/jaw silhouette, so (1 - outlineWidth) on matId SKIN head vertices is the
//   face-front mask for QA P1-2 (view-dependent silhouette line). Ears: inner helix fold through shadeBias -0.35.

import * as THREE from 'three';
import { ensureCharacterAttributes, skinRigid, createSkinnedPair, mergeCharacterGeometries } from '../geo/attributes.js';
import { createFaceAtlas } from './faceAtlas.js';
import { createFaceRig } from './faceRig.js';
import { FACE_PARS_GLSL, FACE_FUNC_GLSL } from '../materials/faceShadow.js';

// ------------------------------------------------------------------------------------------ head shape
/** Monotone cubic (Fritsch-Carlson) interpolation through (xs, ys). */
function monotone(xs, ys) {
  const n = xs.length, d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
/** QA round 1 head refit (see REQUEST(WP0) above). Metres. */
const HEAD_FIT = Object.freeze({
  temples: 0.186, cheeks: 0.170, jaw: 0.140, // full widths at h 0.60 / eye line / h 0.27
  // QA r2 P1-6 lower-face refit: chin half width at chin + 0.012 (QA: 0.05 -> 0.06 full), mouth plane z, chin tip
  // in front of the mouth plane (spec 0.008 -> 0.0025 so the chin no longer projects in profile).
  chinHalf: 0.030, mouthZ: 0.0755, chinForward: 0.0025,
  // QA r2 P1-2 nose point (h = fraction of skull height; tip = dims.FACE.nose.tickH + tipOffH)
  nose: { topH: 0.385, tipOffH: -0.005, underH: 0.024, tipHalf: 0.0085, topHalf: 0.0045, gain: 1.3 },
  napeHalf: 0.036, waistH: [0.20, 0.48], waistPow: 1.6,
  segments: [56, 44], ear: { rings: 7, seg: 16, out: 0.003 },
});
const NECK_BLEND = [1.47, 1.55], NECK_FOOT = [1.1, 1.8];

const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function smin(a, b, k) { const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k)); return b + (a - b) * h - k * h * (1 - h); }

/**
 * Analytic head shape in ROOT-SPACE REST coordinates. h = (y - chinY) / skullHeight in [0, 1].
 * Cross-section at h: half width wx(h); a front half-ellipse (depth dfE) soft-clamped to the face plane
 * zf(h) with a dims.HEAD.faceClampKnee knee; a back half-ellipse to zb(h). Above h = DOME it is a
 * superellipse dome to the skull top. Shared with hair.js (cap + clump placement) and the decals.
 */
export function createHeadShape(dims) {
  const { BODY, HEAD, FACE } = dims;
  const H = BODY.skullHeight, chinY = BODY.chinY;
  const chinH = HEAD.chinWidthAboveChin / H;
  const DOME = 0.6;
  const F = HEAD_FIT;
  const halfT = F.temples / 2;
  const domeZc = -0.015, domeFront = 0.093, domeBack = -(HEAD.backBulge + 0.012); // ear line z -0.012
  const hs = [0, 0.004, 0.012, 0.025, chinH, 0.08, 0.12, 0.17, 0.22, 0.27, 0.34, FACE.eye.centreH, 0.47, 0.54, DOME];
  // QA r1 P0-5: narrower, rounder V. Convex outline (slope falls monotonically) = soft youthful cheek, no jaw corner.
  // QA r2 P1-6: rounder, younger lower face. The chin is a broad U (F.chinHalf at chin + 0.012, was the spec's
  // 0.025 V point) blending into slightly fuller lower cheeks; temples / eye-line cheeks / skull unchanged.
  const WX = monotone(hs, [0, 0.0095, 0.0160, 0.0225, F.chinHalf, 0.0385, 0.0478, 0.0565, 0.0636, F.jaw / 2, 0.078, F.cheeks / 2, 0.0895, 0.0925, halfT]);
  // QA r2 P1-6: profile. Everything below the nose is pulled back (mouth plane 0.079 -> F.mouthZ, chin tip
  // 0.087 -> F.mouthZ + F.chinForward, only ~2.5 mm proud of the mouth instead of 8 mm) and the chin's underside is
  // rounded (front 0.050 -> 0.044 at the bottom), so the lower face no longer reads as a forward "muzzle" and the
  // nose (below) becomes the most forward point under the eyes. Eye line and up unchanged.
  const mouthZ = F.mouthZ;
  const ZF = monotone(hs, [0.044, 0.055, 0.0635, 0.0700, 0.0750, mouthZ + F.chinForward, mouthZ + F.chinForward * 0.55, mouthZ, 0.0790, 0.0845, 0.0890, 0.091, 0.093, 0.094, domeFront]);
  // low back: a nape plug down to y ~1.50 over the back of WP2's neck (neck loft ends at 1.565 inside the head)
  const ZB = monotone(hs, [0.050, 0.010, -0.030, -0.044, -0.047, -0.046, -0.044, -0.047, -0.058, -0.079, -0.105, -0.114, -0.119, -0.1215, domeBack]);
  const P = 2.2;
  const FACE_BULGE = 0.040; // ellipse overshoot past the face plane: flat face, both eyes read at 3/4
  // back half: from the side (x = wx at z = zc) it narrows toward the neck ("jaw angle"), so behind the jaw the
  // neck rises into the skull base instead of meeting a wide horizontal shelf on head turns (QA r1 P0-11).
  function waistAt(h, wx) {
    const lowW = F.napeHalf * smoothstep(0.0, 0.03, h);
    return lowW + (Math.max(wx, lowW) - lowW) * smoothstep(F.waistH[0], F.waistH[1], h);
  }
  function section(h) {
    if (h >= DOME) {
      const t = Math.min(1, (h - DOME) / (1 - DOME));
      const f = Math.pow(Math.max(0, 1 - Math.pow(t, P)), 1 / P);
      const zf = domeZc + (domeFront - domeZc) * f, zb = domeZc + (domeBack - domeZc) * f;
      return { wx: halfT * f, wbw: halfT * f, zf, zb, zc: domeZc, bulge: FACE_BULGE * (1 - smoothstep(0.62, 0.85, h)) };
    }
    const zf = ZF(h), zb = ZB(h);
    const zc = Math.min(zf, Math.max(domeZc, zb + 0.25 * (zf - zb)));
    const wx = WX(h);
    return { wx, wbw: waistAt(h, wx), zf, zb, zc, bulge: FACE_BULGE * smoothstep(0.0, 0.12, h) };
  }
  /** Back-half half width at depth fraction s in [0,1] (0 = side at zc, 1 = back at zb), times sqrt(1-s^2) ellipse. */
  function backHalfW(S, s) {
    return (S.wbw + (S.wx - S.wbw) * Math.pow(Math.max(0, 1 - s), F.waistPow)) * Math.sqrt(Math.max(0, 1 - s * s));
  }
  // nose ridge (2.3; QA r2 P1-2): a small anime nose POINT in profile. Short triangular ridge from just under the
  // eye line (F.nose.topH, a slight nasion dip) to the tip at the painted tick height, a sharp 6 mm underside, and a
  // triangular (crested) cross-section only ~F.nose.tipHalf wide, so from the front it is a 1-2 column crease
  // under the 80 % proxy normals (no ball), while in profile the tip stands proud of the pulled-back lower face.
  const NOSE = F.nose;
  const tipH = FACE.nose.tickH + NOSE.tipOffH;
  function nose(x, h) {
    if (h > NOSE.topH || h < tipH - NOSE.underH) return 0;
    const t = h >= tipH ? (h - tipH) / (NOSE.topH - tipH) : 0;
    const p = h >= tipH ? Math.pow(1 - t, 1.3) : 1 - (tipH - h) / NOSE.underH; // concave ridge -> a point
    const hw = NOSE.tipHalf + (NOSE.topHalf - NOSE.tipHalf) * t;
    return HEAD.noseRidge * NOSE.gain * Math.max(0, p) * Math.max(0, 1 - Math.abs(x) / hw);
  }
  function zFront(x, h, S = section(h)) {
    const u = Math.min(1, Math.abs(x) / Math.max(S.wx, 1e-6));
    const ell = S.zc + (S.zf - S.zc + S.bulge) * Math.sqrt(1 - u * u);
    return smin(ell, S.zf, HEAD.faceClampKnee) + nose(x, h);
  }
  function inside(x, y, z) {
    const h = (y - chinY) / H;
    if (h < 0 || h > 1) return false;
    const S = section(h);
    const ax = Math.abs(x);
    if (z >= S.zc) return ax < S.wx && z <= zFront(x, h, S);
    if (z < S.zb) return false;
    const s = (S.zc - z) / Math.max(S.zc - S.zb, 1e-6);
    return ax < backHalfW(S, s);
  }
  /** Front surface z at (x, y), x clamped into the face. */
  function frontZ(x, y) {
    const h = Math.min(1, Math.max(0, (y - chinY) / H));
    const S = section(h);
    return zFront(Math.max(-S.wx * 0.985, Math.min(S.wx * 0.985, x)), h, S);
  }
  const center = new THREE.Vector3(0, chinY + 0.5 * H, -0.012);
  /** Skull surface point along a direction from `from` (default skull centre), by bisection. */
  function surfaceAlong(dir, from = center, out = new THREE.Vector3(), maxR = 0.3) {
    let lo = 0, hi = maxR;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      if (inside(from.x + dir.x * mid, from.y + dir.y * mid, from.z + dir.z * mid)) lo = mid; else hi = mid;
    }
    return out.copy(dir).multiplyScalar(lo).add(from);
  }
  return { H, chinY, section, backHalfW, zFront, frontZ, inside, surfaceAlong, center, nose };
}

/**
 * Shrink-wrap sampler for the face decals: maps decal coordinates (s = signed ARC LENGTH round the head from
 * the face midline, y = height) onto the real head surface. Each height row is a horizontal slice of the head
 * shape sampled by rays from a vertical axis, with cumulative arc length, so a decal keeps its painted width
 * on curvature (no projection stretch) and wraps round the cheek instead of hanging off it (QA r1 P0-8).
 */
function createSurfaceWrap(shape) {
  const rows = new Map();
  const STEP = 1.5 * (Math.PI / 180), MAXA = 150 * (Math.PI / 180);
  const n = Math.round(MAXA / STEP);
  const dir = new THREE.Vector3(), from = new THREE.Vector3(), pt = new THREE.Vector3();
  function row(y) {
    const key = y.toFixed(5);
    let r = rows.get(key);
    if (r) return r;
    const h = Math.min(1, Math.max(0, (y - shape.chinY) / shape.H));
    const S = shape.section(h);
    from.set(0, y, Math.max(shape.center.z, (S.zf + S.zb) / 2));
    const pts = [], arc = [];
    for (let k = -n; k <= n; k++) {
      const a = k * STEP;
      dir.set(Math.sin(a), 0, Math.cos(a));
      shape.surfaceAlong(dir, from, pt, 0.2);
      pts.push(pt.x, pt.y, pt.z);
    }
    // cumulative arc, zero at the midline (k = 0 -> index n)
    arc.length = 2 * n + 1; arc[n] = 0;
    const d = (i, j) => Math.hypot(pts[3 * i] - pts[3 * j], pts[3 * i + 2] - pts[3 * j + 2]);
    for (let i = n + 1; i <= 2 * n; i++) arc[i] = arc[i - 1] + d(i, i - 1);
    for (let i = n - 1; i >= 0; i--) arc[i] = arc[i + 1] - d(i, i + 1);
    r = { pts, arc };
    rows.set(key, r);
    return r;
  }
  /** Surface point at arc length s (m, + toward the character's left) on the slice at height y. */
  function at(s, y, out = new THREE.Vector3()) {
    const { pts, arc } = row(y);
    let lo = 0, hi = arc.length - 1;
    if (s <= arc[lo]) return out.fromArray(pts, 0);
    if (s >= arc[hi]) return out.fromArray(pts, 3 * hi);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arc[m] <= s) lo = m; else hi = m; }
    const t = (s - arc[lo]) / Math.max(arc[hi] - arc[lo], 1e-9);
    return out.set(
      pts[3 * lo] + (pts[3 * hi] - pts[3 * lo]) * t, y, pts[3 * lo + 2] + (pts[3 * hi + 2] - pts[3 * lo + 2]) * t);
  }
  /** Arc length of the surface point nearest to x on the front of the slice (for placing decal centres by x). */
  function arcOfX(x, y) {
    const { pts, arc } = row(y);
    const mid = (arc.length - 1) / 2;
    let i = mid;
    if (x >= 0) { while (i < arc.length - 1 && pts[3 * (i + 1)] <= x && pts[3 * (i + 1)] >= pts[3 * i]) i++; }
    else { while (i > 0 && pts[3 * (i - 1)] >= x && pts[3 * (i - 1)] <= pts[3 * i]) i--; }
    return arc[i];
  }
  return { at, arcOfX };
}

// ------------------------------------------------------------------------------------------ geometry
function buildSkull(shape, dims, MAT) {
  const [NC, NR] = HEAD_FIT.segments; // dims.HEAD.sphereSegments (64x48) is over the 6k head budget
  const { H, chinY } = shape;
  const pos = [], hArr = [];
  const idx = [];
  const ring = (i) => 1 + (i - 1) * NC;
  // bottom pole
  { const S = shape.section(0); pos.push(0, chinY, (S.zf + S.zb) / 2); hArr.push(0); }
  for (let i = 1; i < NR; i++) {
    const h = i / NR, S = shape.section(h);
    for (let j = 0; j < NC; j++) {
      const s = -Math.PI + (2 * Math.PI * j) / NC;
      const a = s - 0.4 * Math.sin(s); // denser around the face, coarser at the back
      const ca = Math.cos(a), sa = Math.sin(a);
      let x, z;
      if (ca >= 0) { x = S.wx * sa; z = shape.zFront(x, h, S); }
      else { const sb = -ca; x = Math.sign(sa) * shape.backHalfW(S, sb); z = S.zc - (S.zc - S.zb) * sb; }
      pos.push(x, chinY + h * H, z); hArr.push(h);
    }
  }
  const top = pos.length / 3;
  { const S = shape.section(1); pos.push(0, chinY + H, S.zc); hArr.push(1); }
  for (let j = 0; j < NC; j++) idx.push(0, ring(1) + ((j + 1) % NC), ring(1) + j);
  for (let i = 1; i < NR - 1; i++) for (let j = 0; j < NC; j++) {
    const a = ring(i) + j, b = ring(i) + ((j + 1) % NC), c = ring(i + 1) + j, d = ring(i + 1) + ((j + 1) % NC);
    idx.push(a, b, d, a, d, c);
  }
  for (let j = 0; j < NC; j++) idx.push(ring(NR - 1) + j, ring(NR - 1) + ((j + 1) % NC), top);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const n = geo.attributes.normal, p = geo.attributes.position, cnt = p.count;
  geo.setAttribute('outlineNormal', new THREE.Float32BufferAttribute(n.array.slice(), 3));

  // normal transfer from a smooth ellipsoid proxy over the front 60 % of the face (2.3, mandatory)
  const PX = dims.HEAD.normalProxy;
  const pc = new THREE.Vector3(0, chinY + 0.5 * H, shape.frontZ(0, chinY + dims.FACE.eye.centreH * H) - PX.rz);
  const v = new THREE.Vector3(), np = new THREE.Vector3(), nr = new THREE.Vector3();
  const bias = new Float32Array(cnt), ow = new Float32Array(cnt);
  for (let i = 0; i < cnt; i++) {
    v.fromBufferAttribute(p, i);
    const h = hArr[i];
    nr.fromBufferAttribute(n, i);
    const front = smoothstep(-0.005, 0.035, v.z) * (1 - smoothstep(0.72, 0.86, h));
    np.set((v.x - pc.x) / (PX.rx * PX.rx), (v.y - pc.y) / (PX.ry * PX.ry), (v.z - pc.z) / (PX.rz * PX.rz)).normalize();
    const w = PX.blend * front;
    const nb = nr.clone().multiplyScalar(1 - w).addScaledVector(np, w).normalize();
    n.setXYZ(i, nb.x, nb.y, nb.z);
    // shadeBias: forehead / nose bridge +0.15, under the chin -0.3 (2.8)
    const ny = nr.y;
    let b = 0.15 * front * smoothstep(0.5, 0.6, h);
    b += 0.15 * smoothstep(0.012, 0.0, Math.abs(v.x)) * smoothstep(0.30, 0.34, h) * (1 - smoothstep(0.42, 0.48, h)) * front;
    // jaw underside: soft gradient with the real normal (no step where the neck enters, QA r1 P0-11)
    const jawB = dims.SHADING.shadeBias.crease * smoothstep(-0.15, -0.8, ny) * (1 - smoothstep(0.10, 0.30, h));
    // QA r3 P2-5: where the neck enters the jaw underside the head must not be lit while the neck right below is
    // shaded. The head's side field is a HORIZONTAL N.L (it ignores the key's elevation) while the neck uses 3D
    // N.L, so with the same -0.3 crease the down-facing jaw underside stayed lit a few mm behind the point where
    // the neck's crease shade (body.js: crease * S(-0.03, 0.03, z)) starts: a stepped notch across the seam at
    // 80 deg. Inside the neck footprint, just above the seam, the head takes a deeper crease (1.5x the neck's
    // profile; same deep tone) so the jaw shade always covers the neck's, fading out by y 1.55.
    const nr2 = Math.hypot(v.x / dims.BODY.neckRadius.w, v.z / dims.BODY.neckRadius.d);
    const seam = (1 - smoothstep(NECK_FOOT[0], NECK_FOOT[1], nr2)) * (1 - smoothstep(NECK_BLEND[0] + 0.04, NECK_BLEND[1], v.y));
    const neckB = 1.5 * dims.SHADING.shadeBias.crease * smoothstep(-0.03, 0.03, v.z);
    b += jawB + Math.min(0, neckB - jawB) * seam;
    // ... and its shading normal turns toward straight down (so the face field uses true 3D N.L there, like the
    // neck, instead of the elevation-blind horizontal term that lit it from the side)
    if (ny < -0.3 && seam > 0) {
      const k = 0.85 * seam * smoothstep(-0.3, -0.6, ny) * smoothstep(-0.008, 0.016, v.z); // front half, as the neck crease
      n.setXYZ(i, nb.x * (1 - k), nb.y * (1 - k) - k, nb.z * (1 - k));
      nb.fromBufferAttribute(n, i).normalize(); n.setXYZ(i, nb.x, nb.y, nb.z);
    }
    bias[i] = b;
    // painted face lines replace the hull on the face front; jaw / chin silhouette keep it
    ow[i] = 1 - smoothstep(0.62, 0.92, nr.z) * smoothstep(0.08, 0.16, h) * (1 - smoothstep(0.7, 0.8, h));
  }
  geo.setAttribute('shadeBias', new THREE.BufferAttribute(bias, 1));
  geo.setAttribute('outlineWidth', new THREE.BufferAttribute(ow, 1));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(cnt * 2), 2));
  const mat = new Float32Array(cnt).fill(MAT.SKIN);
  geo.setAttribute('matId', new THREE.BufferAttribute(mat, 1));
  return geo;
}

/** One ear (side = +1 left / -1 right): C-shaped helix rim, concha bowl, painted inner line. */
function buildEar(shape, dims, MAT, side) {
  const E = dims.FACE.ear, H = shape.H, chinY = shape.chinY;
  const RINGS = HEAD_FIT.ear.rings, SEG = HEAD_FIT.ear.seg;
  const a0 = E.w / 2, b0 = E.h / 2;
  const pos = [], mats = [], bias = [];
  // front (outward) disc then back disc; ring RINGS is the shared rim
  const pushDisc = (front) => {
    for (let r = 0; r <= RINGS; r++) {
      const rr = r / RINGS;
      for (let s = 0; s < SEG; s++) {
        const th = (2 * Math.PI * s) / SEG; // th = 0 -> forward (+s axis)
        const cy = Math.sin(th), cz = Math.cos(th);
        const egg = 1 + 0.18 * cy;           // wider at the top
        const lobe = cy < 0 ? 1 - 0.12 * cy * cy : 1;
        const S = rr * a0 * egg * lobe, T = rr * b0;
        const helix = 0.35 + 0.65 * smoothstep(0.55, -0.25, cz); // ridge opens toward the face (C shape)
        let out;
        if (front) {
          out = (0.0035 + E.d * 0.42 * helix * Math.exp(-(((rr - 0.80) / 0.13) ** 2)) + 0.0015 * Math.exp(-(((rr - 0.45) / 0.1) ** 2))) * (1 - rr ** 10);
        } else out = -E.d * 0.38 * (1 - rr * rr);
        pos.push(out, T * cy, S * cz);
        // inner helix fold reads through the crease tone (shadeBias) instead of a per-vertex matId stripe
        mats.push(MAT.SKIN);
        bias.push(front ? -0.3 * smoothstep(0.74, 0.45, rr) * smoothstep(0.75, 0.0, cz) : 0);
      }
    }
  };
  pushDisc(true); pushDisc(false);
  const idx = [], off = (RINGS + 1) * SEG;
  const id = (d, r, s) => d * off + r * SEG + (s % SEG);
  for (let d = 0; d < 2; d++) for (let r = 0; r < RINGS; r++) for (let s = 0; s < SEG; s++) {
    const a = id(d, r, s), b = id(d, r, s + 1), c = id(d, r + 1, s), e = id(d, r + 1, s + 1);
    if (d === 0) idx.push(a, e, c, a, b, e); else idx.push(a, c, e, a, e, b);
  }
  // weld the rim: make back-disc rim vertices reference front rim (same positions -> share index)
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (v >= off && v - off >= RINGS * SEG) idx[i] = v - off;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // orient: outward = side*X, yaw 18 deg forward, tilted back 12 deg; mirror for the right ear
  const m = new THREE.Matrix4();
  const yaw = new THREE.Matrix4().makeRotationY(side * -(18 * Math.PI) / 180);
  const tilt = new THREE.Matrix4().makeRotationX(-(E.tiltBackDeg * Math.PI) / 180);
  const mir = new THREE.Matrix4().makeScale(side, 1, 1);
  const cy = chinY + ((E.topH + E.bottomH) / 2) * H;
  // sits on the (refit, narrower) skull side instead of the fixed dims x 0.098
  const ex = shape.surfaceAlong(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, cy, E.z)).x + HEAD_FIT.ear.out;
  m.makeTranslation(side * ex, cy, E.z).multiply(tilt).multiply(yaw).multiply(mir);
  geo.applyMatrix4(m);
  if (side < 0) { const ix = geo.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } }
  geo.computeVertexNormals();
  const cnt = geo.attributes.position.count;
  geo.setAttribute('outlineNormal', new THREE.Float32BufferAttribute(geo.attributes.normal.array.slice(), 3));
  geo.setAttribute('matId', new THREE.Float32BufferAttribute(mats, 1));
  geo.setAttribute('shadeBias', new THREE.Float32BufferAttribute(bias, 1));
  geo.setAttribute('outlineWidth', new THREE.Float32BufferAttribute(new Float32Array(cnt).fill(0.7), 1));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(cnt * 2), 2));
  return geo;
}

/**
 * Shrink-wrapped decal patch (head-local positions). Every grid vertex is placed ON the head surface via the
 * arc-length wrap (u runs round the head, v straight up), then lifted along the true surface normal, so the
 * decal follows curvature, wraps onto the side plane and can never leave the head silhouette.
 * quads: [{ cx (x of the centre on the face), cy, w, h (metres of surface), nx, ny, side, part }]
 */
function buildDecal(wrap, quads, headY, lift = 0.0006) {
  const pos = [], uv = [], sideA = [], partA = [], idx = [];
  const p = new THREE.Vector3();
  for (const q of quads) {
    const base = pos.length / 3;
    const cs = wrap.arcOfX(q.cx, q.cy);
    for (let j = 0; j <= q.ny; j++) for (let i = 0; i <= q.nx; i++) {
      const u = i / q.nx, v = j / q.ny;
      wrap.at(cs + (u - 0.5) * q.w, q.cy + (v - 0.5) * q.h, p);
      pos.push(p.x, p.y, p.z);
      uv.push(u, v); sideA.push(q.side ?? 1); partA.push(q.part ?? 0);
    }
    for (let j = 0; j < q.ny; j++) for (let i = 0; i < q.nx; i++) {
      const a = base + j * (q.nx + 1) + i, b = a + 1, c = a + q.nx + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const P = geo.attributes.position, N = geo.attributes.normal;
  for (let i = 0; i < P.count; i++) {
    P.setXYZ(i, P.getX(i) + N.getX(i) * lift, P.getY(i) + N.getY(i) * lift - headY, P.getZ(i) + N.getZ(i) * lift);
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(sideA, 1));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(partA, 1));
  geo.computeBoundingSphere();
  return geo;
}

/** Head-local surface point + normal of a decal patch centre (for the per-view eye cheat in faceRig). */
function decalAnchor(wrap, x, y, headY) {
  const s = wrap.arcOfX(x, y), e = 0.002;
  const p = wrap.at(s, y), pu = wrap.at(s + e, y), pd = wrap.at(s - e, y);
  const tu = pu.sub(pd);
  const n = new THREE.Vector3(-tu.z, 0, tu.x).normalize(); // horizontal normal (the cheat is about yaw)
  return { centre: new THREE.Vector3(p.x, p.y - headY, p.z), normal: n };
}

/**
 * Match WP2's neck weights on the jaw underside / nape: inside the neck footprint the head blends
 * neck -> head over y NECK_BLEND (same window as the neck loft), so the seam never opens on turn / tilt.
 * Outside the footprint (chin front, cheeks) stays rigid on the head so the face never deforms.
 */
function blendNeckSeam(geo, rig, dims) {
  const { w: nw, d: nd } = dims.BODY.neckRadius;
  const iN = rig.boneIndex.neck, iH = rig.boneIndex.head;
  const p = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y > NECK_BLEND[1]) continue;
    const r = Math.hypot(x / nw, z / nd);            // 1 = neck surface
    const foot = 1 - smoothstep(NECK_FOOT[0], NECK_FOOT[1], r);       // footprint mask, feathered just outside the neck
    const wn = (1 - smoothstep(NECK_BLEND[0], NECK_BLEND[1], y)) * foot;
    if (wn <= 1e-4) continue;
    si.setXYZW(i, iH, iN, 0, 0); sw.setXYZW(i, 1 - wn, wn, 0, 0);
  }
}

// ------------------------------------------------------------------------------------------ decal shaders
const DECAL_VERT = /* glsl */`
attribute float aSide;
attribute float aPart;
uniform float uPull;
uniform float uPullMinFacing;
uniform float uHeadY;  // rest y of the head bone (decal positions are head-local)
varying vec2 vUv;
varying float vSide;
varying float vPart;
varying float vFacing;
varying vec3 vRestPos; // rest-space position / normal for the face shade field (brows, QA r3 P2-3)
varying vec3 vRestN;
void main() {
  vUv = uv; vSide = aSide; vPart = aPart;
  vRestPos = position + vec3( 0.0, uHeadY, 0.0 ); vRestN = normal;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vec3 n = normalize( normalMatrix * normal );
  bool ortho = projectionMatrix[ 3 ][ 3 ] == 1.0;
  vec3 viewDir = ortho ? vec3( 0.0, 0.0, 1.0 ) : normalize( -mv.xyz );
  vFacing = dot( n, viewDir );
  // pull toward the camera ALONG THE VIEW RAY: same screen position, nearer depth (never moves the decal
  // off the surface on screen, so it cannot leave the head silhouette)
  mv.xyz += viewDir * ( uPull / max( vFacing, uPullMinFacing ) );
  gl_Position = projectionMatrix * mv;
}`;
const DECAL_COMMON = /* glsl */`
uniform sampler2D uTex;
uniform float uOpacity;
uniform vec2 uFade;
varying vec2 vUv;
varying float vSide;
varying float vPart;
varying float vFacing;
vec2 cellUv( vec4 r, vec2 uv ) { uv = clamp( uv, 0.004, 0.996 ); return r.xy + uv * r.zw; }
float inCell( vec2 uv ) { return step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 ); }
vec3 s2l( vec3 c ) { return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) ); }
vec3 unpremul( vec4 c ) { return c.a > 0.003 ? s2l( clamp( c.rgb / c.a, 0.0, 1.0 ) ) : vec3( 0.0 ); }
// grazing-angle clip: fades the decal out before it reaches the head silhouette
float facingFade() { return smoothstep( uFade.x, uFade.y, vFacing ); }
// per-view anime cheat (faceRig): the painted feature covers more surface when seen obliquely (k < 1) and slides
// toward the camera side (sh), so eyes / brows stay readable at 3/4 and in profile. Mesh u spans uMargin cells.
uniform vec4 uView;   // x,y: k, shift for the LEFT (+X) side; z,w: right side
uniform float uMargin;
vec2 viewUv( vec2 uv ) {
  vec2 ks = vSide > 0.0 ? uView.xy : uView.zw;
  return vec2( 0.5 + ( uv.x - 0.5 - ks.y ) * uMargin * ks.x, uv.y );
}
`;
const EYE_FRAG = /* glsl */`
${DECAL_COMMON}
uniform vec4 uCellA, uCellB, uIris, uHi;
uniform float uMix, uHiFollow;
uniform vec2 uGaze;
uniform vec3 uSclera, uLidBand, uLash, uLower, uCrescent, uCatch;
void main() {
  vec2 uvE = viewUv( vUv );
  float inside = inCell( uvE );
  if ( inside < 0.5 ) discard;
  vec2 uvS = vec2( vSide < 0.0 ? 1.0 - uvE.x : uvE.x, uvE.y );
  vec4 m = mix( texture2D( uTex, cellUv( uCellA, uvS ) ), texture2D( uTex, cellUv( uCellB, uvS ) ), uMix );
  vec3 col = mix( uSclera, uLidBand, m.g );
  vec2 uvI = uvE - uGaze;
  vec4 ir = texture2D( uTex, cellUv( uIris, uvI ) ) * inCell( uvI );
  col = mix( col, unpremul( ir ), ir.a );
  vec2 uvH = uvE - uGaze * uHiFollow;
  uvH.x = vSide < 0.0 ? 1.0 - uvH.x : uvH.x;
  vec4 hi = texture2D( uTex, cellUv( uHi, uvH ) ) * inCell( uvH );
  col = mix( col, uCrescent, hi.b * 0.4 * ir.a );
  col = mix( col, uCatch, max( hi.r, hi.g ) );
  float a = m.r;
  col = mix( col, uLower, m.a ); a = max( a, m.a );
  col = mix( col, uLash, m.b ); a = max( a, m.b );
  gl_FragColor = vec4( col, a * facingFade() * uOpacity );
  #include <colorspace_fragment>
}`;
const FEAT_FRAG = /* glsl */`
${DECAL_COMMON}
uniform vec4 uMouthA, uMouthB, uNose, uBlush;
uniform float uMouthMix, uNoseFlip, uBlushAlpha;
uniform vec2 uMouthView; // x: shift toward the camera side (mesh u), y: mesh margin (cells per mesh width)
uniform vec2 uTeethFade; // QA r2 P2-2: teeth fade window on facing (earlier than the lips / interior)
uniform vec3 uMouthInterior;
void main() {
  vec4 c;
  if ( vPart < 0.5 ) {
    // anime 3/4 cheat: the mouth slides toward the near cheek so it never hugs the far silhouette
    vec2 uv = vec2( 0.5 + ( vUv.x - 0.5 - uMouthView.x ) * uMouthView.y, vUv.y );
    if ( inCell( uv ) < 0.5 ) discard;
    c = mix( texture2D( uTex, cellUv( uMouthA, uv ) ), texture2D( uTex, cellUv( uMouthB, uv ) ), uMouthMix );
    // grazing teeth (QA r2 P2-2): the white teeth band turns into mouth interior BEFORE the general grazing fade,
    // so at 60-90 deg the open mouth reads as one dark shape and no half-faded / mip-smeared white survives at
    // the far corner. Teeth = the bright, low-chroma texels (teeth #FFF, teeth shade #D9DEEA); tongue / lips stay.
    if ( c.a > 0.003 ) {
      vec3 sc = clamp( c.rgb / c.a, 0.0, 1.0 );
      // bright + low chroma (also catches the anti-aliased teeth / lip-line edge texels; tongue is high chroma)
      float lo = min( sc.r, min( sc.g, sc.b ) ), hi = max( sc.r, max( sc.g, sc.b ) );
      float teeth = smoothstep( 0.32, 0.55, lo ) * ( 1.0 - smoothstep( 0.16, 0.30, hi - lo ) );
      float keep = smoothstep( uTeethFade.x, uTeethFade.y, vFacing );
      c.rgb = mix( c.rgb, uMouthInterior * c.a, teeth * ( 1.0 - keep ) );
    }
  } else if ( vPart < 1.5 ) {
    vec2 uv = vUv; if ( uNoseFlip > 0.5 ) uv.x = 1.0 - uv.x;
    c = texture2D( uTex, cellUv( uNose, uv ) );
  } else {
    vec2 uv = vUv; if ( vSide < 0.0 ) uv.x = 1.0 - uv.x;
    c = texture2D( uTex, cellUv( uBlush, uv ) ) * uBlushAlpha;
  }
  gl_FragColor = vec4( unpremul( c ), c.a * facingFade() * uOpacity );
  #include <colorspace_fragment>
}`;
const BROW_FRAG = /* glsl */`
${DECAL_COMMON}
${FACE_PARS_GLSL}
${FACE_FUNC_GLSL}
uniform vec4 uCellA, uCellB;
uniform float uMix;
uniform vec2 uOffset;
uniform vec3 uShadeTint;  // skin shade / skin base (linear): multiplies the brow + its skin rim in face shade
uniform float uShadeOn;   // 0 when the face material has no shade field (stub materials)
uniform vec2 uSideFade;   // per-side opacity (x: LEFT +X brow, y: right), faceRig far-side yaw fade (QA r3 P2-4)
varying vec3 vRestPos;
varying vec3 vRestN;
void main() {
  vec2 uvB = viewUv( vUv );
  vec2 uv = vec2( vSide < 0.0 ? 1.0 - uvB.x : uvB.x, uvB.y ) - uOffset;
  float inside = inCell( uv );
  if ( inside < 0.5 ) discard;
  vec4 c = mix( texture2D( uTex, cellUv( uCellA, uv ) ), texture2D( uTex, cellUv( uCellB, uv ) ), uMix );
  // QA r3 P2-3: the decal is unlit, so its thin skin-coloured rim glowed as a pale halo where the brow crosses
  // the face shadow. Evaluate the SAME face shade field the skin uses (SDF map + head-space N.L, same
  // threshold) at the brow's rest-space surface point and tint the whole cell by shade/base there: the rim
  // becomes exactly the skin shade tone in shadow (invisible on shaded forehead), the dark brow barely moves.
  vec2 face = heroFaceField( vRestPos, normalize( vRestN ), 0.0 );
  float ef = max( fwidth( face.x ) * 0.75, 1e-4 );
  float lit = mix( 1.0, smoothstep( -ef, ef, face.x ), uShadeOn );
  vec3 col = unpremul( c ) * mix( uShadeTint, vec3( 1.0 ), lit );
  float side = vSide > 0.0 ? uSideFade.x : uSideFade.y;
  gl_FragColor = vec4( col, c.a * facingFade() * side * uOpacity );
  #include <colorspace_fragment>
}`;

function decalMaterial(frag, uniforms, name) {
  const m = new THREE.ShaderMaterial({
    name, uniforms, vertexShader: DECAL_VERT, fragmentShader: frag,
    transparent: true, depthWrite: false, depthTest: true,
  });
  m.toneMapped = false;
  return m;
}

// ------------------------------------------------------------------------------------------ builder
export function buildHead(ctx) {
  const { rig, palette, materials, dims, options = {} } = ctx;
  const { MAT, FACE_COLORS: C } = palette;
  const { BODY, FACE } = dims;
  const H = BODY.skullHeight, chinY = BODY.chinY;
  const headY = dims.JOINT_WORLD.head[1];
  const shape = createHeadShape(dims);

  // ---- skull + ears (one skinned mesh, rigid on head)
  const parts = [buildSkull(shape, dims, MAT), buildEar(shape, dims, MAT, 1), buildEar(shape, dims, MAT, -1)];
  for (const g of parts) skinRigid(g, rig, 'head');
  blendNeckSeam(parts[0], rig, dims);
  const geo = mergeCharacterGeometries(parts);
  ensureCharacterAttributes(geo, { matId: MAT.SKIN });
  const meshes = createSkinnedPair(geo, materials.face, materials.outline, rig, { name: 'head' });

  // ---- face atlases + decal layers (rigid on the head bone)
  const atlas = createFaceAtlas({ dims, palette });
  const Q = atlas.quads;
  const eyeY = chinY + FACE.eye.centreH * H, eyeX = (FACE.eye.spacingW * FACE.W) / 2;
  const mouthY = chinY + FACE.mouth.centreH * H;
  const browY = chinY + FACE.brow.centreH * H;
  const browX = eyeX - FACE.brow.innerInset + (FACE.brow.lengthOfEye * FACE.eye.width) / 2;
  const noseY = chinY + FACE.nose.tickH * H;
  const blushY = eyeY - 0.027, blushX = eyeX + 0.007;

  const col = (hex) => new THREE.Color(hex);
  // feature atlas texels are premultiplied sRGB bytes (decoded by unpremul() in the shader): compare in that space
  const srgbBytes = (hex) => { const c = new THREE.Color(hex).convertLinearToSRGB(); return new THREE.Vector3(c.r, c.g, c.b); };
  const v4 = () => new THREE.Vector4();
  // per-view eye / brow cheat (written by faceRig each frame; shared by both layers)
  const view = { uView: { value: new THREE.Vector4(1, 0, 1, 0) } };
  const EYE_MARGIN = 2.0, BROW_MARGIN = 2.0, MOUTH_MARGIN = 1.5;
  const mouthView = new THREE.Vector2(0, MOUTH_MARGIN);
  const faceU = materials.face?.uniforms || {};
  const skinBase = palette.color(MAT.SKIN, 'base'), skinShade = palette.color(MAT.SKIN, 'shade');
  const shadeTint = new THREE.Vector3(skinShade.r / skinBase.r, skinShade.g / skinBase.g, skinShade.b / skinBase.b);
  const U = {
    eye: {
      uTex: { value: atlas.eyeTex }, uOpacity: { value: 1 }, uPull: { value: 0.0015 }, uPullMinFacing: { value: 0.5 },
      uFade: { value: new THREE.Vector2(0.0, 0.14) }, uMargin: { value: EYE_MARGIN }, ...view,
      uCellA: { value: v4() }, uCellB: { value: v4() }, uMix: { value: 0 }, uIris: { value: v4() }, uHi: { value: v4() },
      uGaze: { value: new THREE.Vector2() }, uHiFollow: { value: 0.5 },
      uSclera: { value: col(C.sclera) }, uLidBand: { value: col(C.lidBand) }, uLash: { value: col(C.lash) },
      uLower: { value: col(C.lowerLine) }, uCrescent: { value: col(C.rimCrescent) }, uCatch: { value: col(C.catchLight) },
    },
    feat: {
      uTex: { value: atlas.featTex }, uOpacity: { value: 1 }, uPull: { value: 0.0015 }, uPullMinFacing: { value: 0.5 },
      // QA r2 P2-2: short, late grazing fade (was 0.16..0.40): the mouth is either solid or gone, so no translucent
      // mouth / teeth wash over the far cheek at 60-80 deg (the wrap already keeps it inside the silhouette)
      uFade: { value: new THREE.Vector2(0.10, 0.22) }, uMargin: { value: 1 }, ...view,
      uMouthA: { value: v4() }, uMouthB: { value: v4() }, uMouthMix: { value: 0 }, uMouthView: { value: mouthView },
      uTeethFade: { value: new THREE.Vector2(0.30, 0.52) }, uMouthInterior: { value: srgbBytes(C.mouthInterior) },
      uNose: { value: new THREE.Vector4().fromArray(atlas.cells.nose) }, uNoseFlip: { value: 0 },
      uBlush: { value: new THREE.Vector4().fromArray(atlas.cells.blush) }, uBlushAlpha: { value: 0 },
    },
    brow: {
      uTex: { value: atlas.featTex }, uOpacity: { value: 1 }, uPull: { value: 0.06 }, uPullMinFacing: { value: 0.35 },
      // QA r3 P2-4: grazing clip as late as the mouth's (was 0.02..0.16): the pulled brow draws over the hair, so
      // its outer end must be gone before it reaches the cheek / temple silhouette (plus the far-side yaw fade)
      uFade: { value: new THREE.Vector2(0.10, 0.22) }, uMargin: { value: BROW_MARGIN }, ...view,
      uCellA: { value: v4() }, uCellB: { value: v4() }, uMix: { value: 0 }, uOffset: { value: new THREE.Vector2() },
      uSideFade: { value: new THREE.Vector2(1, 1) }, uHeadY: { value: headY },
      // QA r3 P2-3: face shade on the brow layer (shared uniform objects of the face material)
      uFaceMap: faceU.uFaceMap || { value: null }, uHeadLight: faceU.uHeadLight || { value: new THREE.Vector3(0, 0, 1) },
      uFaceFrame: faceU.uFaceFrame || { value: new THREE.Vector4(FACE.W, H, chinY, 0) },
      uShadeOn: { value: faceU.uFaceMap && faceU.uHeadLight && faceU.uFaceFrame ? 1 : 0 },
      uShadeTint: { value: shadeTint },
    },
  };
  const wrap = createSurfaceWrap(shape);
  const eyeGeo = buildDecal(wrap, [-1, 1].map((s) => ({ cx: s * eyeX, cy: eyeY, w: Q.eye[0] * EYE_MARGIN, h: Q.eye[1], nx: 18, ny: 8, side: s })), headY);
  const featGeo = buildDecal(wrap, [
    { cx: 0, cy: mouthY + Q.mouthOriginY - Q.mouth[1] / 2, w: Q.mouth[0] * MOUTH_MARGIN, h: Q.mouth[1], nx: 32, ny: 10, part: 0 },
    { cx: 0, cy: noseY, w: Q.nose[0], h: Q.nose[1], nx: 4, ny: 4, part: 1 },
    { cx: -blushX, cy: blushY, w: Q.blush[0], h: Q.blush[1], nx: 6, ny: 4, part: 2, side: -1 },
    { cx: blushX, cy: blushY, w: Q.blush[0], h: Q.blush[1], nx: 6, ny: 4, part: 2, side: 1 },
  ], headY, 0.0009);
  const browGeo = buildDecal(wrap, [-1, 1].map((s) => ({ cx: s * browX, cy: browY, w: Q.brow[0] * BROW_MARGIN, h: Q.brow[1], nx: 10, ny: 5, side: s })), headY, 0.0008);

  const eyeMat = decalMaterial(EYE_FRAG, U.eye, 'heroFaceEyes');
  const featMat = decalMaterial(FEAT_FRAG, U.feat, 'heroFaceFeatures');
  const browMat = decalMaterial(BROW_FRAG, U.brow, 'heroFaceBrows');
  const headBone = rig.bones.head;
  const decals = [
    [eyeGeo, eyeMat, 'faceEyes', 2], [featGeo, featMat, 'faceFeatures', 1], [browGeo, browMat, 'faceBrows', 3],
  ].map(([g, m, name, order]) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name; mesh.renderOrder = order; mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.raycast = () => {};
    headBone.add(mesh);
    return mesh;
  });

  const face = createFaceRig({
    atlas, uniforms: U, dims, expression: options.expression, headBone,
    eyeCentre: new THREE.Vector3(0, eyeY - headY, shape.frontZ(eyeX, eyeY)),
    headLight: materials.face?.uniforms?.uHeadLight || null,
    view: view.uView.value, margins: { eye: EYE_MARGIN, brow: BROW_MARGIN },
    eyeAnchors: { left: decalAnchor(wrap, eyeX, eyeY, headY), right: decalAnchor(wrap, -eyeX, eyeY, headY) },
    mouthAnchor: decalAnchor(wrap, 0, mouthY, headY), mouthView,
    browFade: U.brow.uSideFade.value,
  });

  return {
    meshes: [...meshes, ...decals],
    update(dt, c) { face.update(dt, c); },
    api: { ...face.api, atlas, shape },
    dispose() {
      for (const m of decals) { headBone.remove(m); m.geometry.dispose(); m.material.dispose(); }
      geo.dispose();
      atlas.dispose();
    },
  };
}
