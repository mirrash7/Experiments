// Ring-loft generator for the hero body. Owner: WP2.
//
// A loft is a list of rings (closed cross-sections) connected into a quad grid, optionally closed by
// poles. Rings are produced by helpers here:
//   - ellipseRing(): elliptical cross-section with a per-angle radius modulation (muscle shapes)
//   - sdfRing():     cross-section of an implicit volume, found by ray-casting from the ring centre
// Every ring is resampled by (weighted) arc length so vertices are evenly spread even on flat sections
// (palm, foot), with column 0 always at angle 0 (the ring's e2 direction = "front"/"top").
//
// Coordinates are root-space rest (T-pose) metres, like every hero geometry (CONTRACTS.md §2).

import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Hermite smoothstep from e0 to e1 (e0 may be > e1 for a falling edge). */
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export const lerp = (a, b, t) => a + (b - a) * t;
/** Gaussian bump exp(-(x/s)^2). */
export const bump = (x, s) => Math.exp(-(x * x) / (s * s));
/** Wrapped angle difference in (-PI, PI]. */
export function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

// ---------------------------------------------------------------- profiles

/**
 * Catmull-Rom (centripetal-free, uniform-in-t with clamped ends) sampler over a dims.PROFILES table.
 * rows: [[t, rw, rd, [ox, oy, oz]?], ...]. Returns (t) => { rw, rd, o: [x,y,z] }.
 * Non-uniform knot spacing is handled by evaluating the cubic Hermite with finite-difference tangents.
 */
export function profileSampler(rows) {
  const n = rows.length;
  const ts = rows.map((r) => r[0]);
  const ch = (r, k) => (k < 3 ? r[k] : (r[3] || [0, 0, 0])[k - 3]);
  const val = (i, k) => ch(rows[Math.max(0, Math.min(n - 1, i))], k);
  const tan = (i, k) => {
    if (i <= 0) return (val(1, k) - val(0, k)) / (ts[1] - ts[0]);
    if (i >= n - 1) return (val(n - 1, k) - val(n - 2, k)) / (ts[n - 1] - ts[n - 2]);
    return (val(i + 1, k) - val(i - 1, k)) / (ts[i + 1] - ts[i - 1]);
  };
  return (t) => {
    t = Math.max(ts[0], Math.min(ts[n - 1], t));
    let i = 0;
    while (i < n - 2 && t > ts[i + 1]) i++;
    const h = ts[i + 1] - ts[i], u = (t - ts[i]) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
    const out = [];
    for (let k = 1; k < 6; k++) out.push(h00 * val(i, k) + h10 * h * tan(i, k) + h01 * val(i + 1, k) + h11 * h * tan(i + 1, k));
    return { rw: out[0], rd: out[1], o: [out[2], out[3], out[4]] };
  };
}

// ---------------------------------------------------------------- rings

const POLAR = 120; // polar samples before arc-length resampling

/**
 * Resample a closed polar curve (array of Vector3, index 0 at angle 0) to `segs` points spaced by
 * weighted arc length. weightFn(alpha) >= 0 boosts density (default uniform).
 */
function resampleClosed(pts, alphas, segs, weightFn) {
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const w = weightFn ? 0.5 * (weightFn(alphas[i]) + weightFn(alphas[(i + 1) % n] + (i + 1 === n ? TAU : 0))) : 1;
    cum[i + 1] = cum[i] + a.distanceTo(b) * w;
  }
  const total = cum[n];
  const out = [], outA = [];
  let j = 0;
  for (let k = 0; k < segs; k++) {
    const target = (k / segs) * total;
    while (j < n - 1 && cum[j + 1] < target) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const f = (target - cum[j]) / span;
    out.push(new THREE.Vector3().lerpVectors(pts[j], pts[(j + 1) % n], f));
    outA.push(alphas[j] + f * (TAU / n));
  }
  return { pts: out, alphas: outA, perimeter: total };
}

/**
 * Elliptical ring. The point at angle a (from e2 toward e1) is
 *   c + e1 * (rw * sin a) * m(a) + e2 * (rd * cos a) * m(a)
 * where m(a) = mod(a) (muscle modulation, default 1). rw is the radius along e1, rd along e2.
 * Returns { c, e1, e2, axis, pts, alphas, perimeter }.
 */
export function ellipseRing({ c, e1, e2, rw, rd, mod = null, segs, weightFn = null, superE = 2 }) {
  const pts = [], alphas = [];
  for (let i = 0; i < POLAR; i++) {
    const a = (i / POLAR) * TAU;
    const s = Math.sin(a), co = Math.cos(a);
    // superellipse radius in the polar direction (superE = 2 is a plain ellipse)
    const r = Math.pow(Math.pow(Math.abs(s / rw), superE) + Math.pow(Math.abs(co / rd), superE), -1 / superE);
    const m = mod ? mod(a) : 1;
    pts.push(new THREE.Vector3().copy(c).addScaledVector(e1, s * r * m).addScaledVector(e2, co * r * m));
    alphas.push(a);
  }
  const res = resampleClosed(pts, alphas, segs, weightFn);
  return { c: c.clone(), e1: e1.clone(), e2: e2.clone(), axis: new THREE.Vector3().crossVectors(e1, e2).normalize(), ...res };
}

/**
 * Cross-section of an implicit volume `inside(p) -> signed distance (negative inside)` in the plane
 * through c spanned by e1/e2, found by ray-casting from c. The section must be star-shaped around c.
 * guess: optional array (POLAR) of radii from a neighbouring ring (speeds up the search).
 */
/**
 * symmetric: the sdf is mirror-symmetric about the plane spanned by e2 and the ring axis (a -> -a), so only
 * half the polar samples are marched and the rest mirrored (torso: halves the build cost, same result).
 */
export function sdfRing({ c, e1, e2, sdf, segs, rMax = 0.4, guess = null, weightFn = null, step = 0.004, symmetric = false }) {
  const pts = [], alphas = [], radii = new Float64Array(POLAR);
  const p = new THREE.Vector3(), dir = new THREE.Vector3();
  const f = (r) => sdf(p.copy(c).addScaledVector(dir, r));
  const half = POLAR / 2;
  for (let i = 0; i < POLAR; i++) {
    const a = (i / POLAR) * TAU;
    dir.copy(e1).multiplyScalar(Math.sin(a)).addScaledVector(e2, Math.cos(a));
    if (symmetric && i > half) {
      radii[i] = radii[POLAR - i];
      pts.push(new THREE.Vector3().copy(c).addScaledVector(dir, radii[i]));
      alphas.push(a);
      continue;
    }
    let lo, hi;
    let r0 = guess ? Math.max(0.002, guess[i]) : (i > 0 ? radii[i - 1] : 0.02);
    if (f(r0) < 0) { // inside: march out
      lo = r0; hi = r0 + step;
      while (f(hi) < 0 && hi < rMax) { lo = hi; hi += step; }
    } else { // outside: march in
      hi = r0; lo = r0 - step;
      while (lo > 0 && f(lo) >= 0) { hi = lo; lo -= step; }
      if (lo <= 0) lo = 0;
    }
    for (let k = 0; k < 6; k++) { const m = 0.5 * (lo + hi); if (f(m) < 0) lo = m; else hi = m; } // 0.06 mm
    radii[i] = 0.5 * (lo + hi);
    pts.push(new THREE.Vector3().copy(c).addScaledVector(dir, radii[i]));
    alphas.push(a);
  }
  const res = resampleClosed(pts, alphas, segs, weightFn);
  return { c: c.clone(), e1: e1.clone(), e2: e2.clone(), axis: new THREE.Vector3().crossVectors(e1, e2).normalize(), radii, ...res };
}

/** Find the mid point of the solid along a line through p0 with direction d (entry/exit by marching). */
export function solidMid(sdf, p0, d, tMin, tMax, step = 0.002) {
  const p = new THREE.Vector3();
  let tin = null, tout = null, prev = sdf(p.copy(p0).addScaledVector(d, tMin)) < 0;
  if (prev) tin = tMin;
  for (let t = tMin + step; t <= tMax; t += step) {
    const ins = sdf(p.copy(p0).addScaledVector(d, t)) < 0;
    if (ins && !prev && tin === null) tin = t;
    if (!ins && prev) tout = t;
    prev = ins;
  }
  if (tin === null) return null;
  if (tout === null) tout = tMax;
  return { t: 0.5 * (tin + tout), tin, tout };
}

// ---------------------------------------------------------------- loft assembly

/**
 * Adaptive ring placement: given a fine list of candidate rings (ordered), keep a subset so the max
 * vertex displacement between kept consecutive rings stays near `spacing` (metres), with an optional
 * per-ring spacing multiplier densityFn(ring) (< 1 = denser, e.g. near joints).
 */
export function pickRings(fine, spacing, densityFn = null) {
  const out = [fine[0]];
  let acc = 0;
  for (let i = 1; i < fine.length; i++) {
    const a = fine[i - 1], b = fine[i];
    let d = 0;
    for (let k = 0; k < a.pts.length; k++) d = Math.max(d, a.pts[k].distanceTo(b.pts[k]));
    acc += d;
    const sp = spacing * (densityFn ? densityFn(b) : 1);
    if (acc >= sp || i === fine.length - 1) { out.push(b); acc = 0; }
  }
  return out;
}

/**
 * Connect rings into an indexed grid. Each ring has `pts` (segs points). A duplicated seam column
 * (k = segs) carries u = 1. Caps: { start, end } each null | { pole: Vector3 } (fan to a pole vertex).
 * uv: { rect: [u0, v0, u1, v1] } — u runs around (column fraction), v runs along by arc length.
 * Returns { positions: number[], uvs: number[], index: number[], ringOf: number[], vcount }.
 * Winding is chosen so faces point away from the ring centres.
 */
export function assembleLoft(rings, { capStart = null, capEnd = null, rect = [0, 0, 1, 1], flipV = false } = {}) {
  const segs = rings[0].pts.length;
  const positions = [], uvs = [], index = [], ringOf = [];
  // v by mean arc length between rings
  const vcum = [0];
  for (let i = 1; i < rings.length; i++) {
    let d = 0;
    for (let k = 0; k < segs; k++) d += rings[i].pts[k].distanceTo(rings[i - 1].pts[k]);
    vcum.push(vcum[i - 1] + d / segs);
  }
  const capLen = (cap, ring) => (cap ? cap.pole.distanceTo(ring.c) * 1.2 : 0);
  const l0 = capLen(capStart, rings[0]), l1 = capLen(capEnd, rings[rings.length - 1]);
  const total = vcum[vcum.length - 1] + l0 + l1;
  const [u0, v0, u1, v1] = rect;
  const V = (s) => { const t = s / total; return flipV ? v1 - t * (v1 - v0) : v0 + t * (v1 - v0); };
  for (let i = 0; i < rings.length; i++) {
    for (let k = 0; k <= segs; k++) {
      const p = rings[i].pts[k % segs];
      positions.push(p.x, p.y, p.z);
      uvs.push(u0 + (k / segs) * (u1 - u0), V(l0 + vcum[i]));
      ringOf.push(i);
    }
  }
  const row = segs + 1;
  // orientation test on the first quad of a middle ring
  const mid = Math.min(rings.length - 2, Math.max(0, rings.length >> 1));
  const A = rings[mid].pts[0], Bv = rings[mid + 1].pts[0], C = rings[mid].pts[1];
  const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(Bv, A), new THREE.Vector3().subVectors(C, A));
  const out = new THREE.Vector3().subVectors(A, rings[mid].c);
  const flip = n.dot(out) < 0;
  const tri = (a, b, c) => (flip ? index.push(a, c, b) : index.push(a, b, c));
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < segs; k++) {
      const a = i * row + k, b = (i + 1) * row + k, c = a + 1, d = b + 1;
      tri(a, b, c); tri(c, b, d);
    }
  }
  const addPole = (cap, ringIdx, isStart) => {
    const pi = positions.length / 3;
    positions.push(cap.pole.x, cap.pole.y, cap.pole.z);
    uvs.push(0.5 * (u0 + u1), isStart ? V(0) : V(total));
    ringOf.push(ringIdx);
    for (let k = 0; k < segs; k++) {
      const a = ringIdx * row + k, c = a + 1;
      if (isStart) tri(pi, a, c); else tri(a, pi, c);
    }
  };
  if (capStart) addPole(capStart, 0, true);
  if (capEnd) addPole(capEnd, rings.length - 1, false);
  return { positions, uvs, index, ringOf, vcount: positions.length / 3, length: total };
}

/**
 * Generate extra rings that round off a loft end: shrink the last ring toward a pole like a
 * hemi-ellipsoid of depth `depth` along `axisDir`. Returns { rings, pole }.
 */
export function roundEnd(ring, axisDir, depth, steps = 3, power = 1) {
  const rings = [];
  for (let s = 1; s <= steps; s++) {
    const a = (s / (steps + 1)) * (Math.PI / 2);
    const sc = Math.pow(Math.cos(a), power), off = Math.sin(a) * depth;
    const c = ring.c.clone().addScaledVector(axisDir, off);
    rings.push({
      c, e1: ring.e1, e2: ring.e2,
      pts: ring.pts.map((p) => new THREE.Vector3().subVectors(p, ring.c).multiplyScalar(sc).add(c)),
    });
  }
  return { rings, pole: ring.c.clone().addScaledVector(axisDir, depth) };
}

// ---------------------------------------------------------------- geometry utilities

/**
 * Indexed BufferGeometry from raw arrays. Normals are computed with seam-welding (vertices sharing a
 * position within 1e-6 get the same normal) so UV seams never show a shading crease.
 */
export function makeGeometry({ positions, uvs, index }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  computeWeldedNormals(g);
  return g;
}

/** Area-weighted vertex normals, averaged across duplicate positions (seams). */
export function computeWeldedNormals(g, positionsOverride = null) {
  const pos = positionsOverride || g.attributes.position.array;
  const idx = g.index.array;
  const n = pos.length / 3;
  const acc = new Float32Array(n * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    for (const v of [a, b, c]) { acc[v] += nx; acc[v + 1] += ny; acc[v + 2] += nz; }
  }
  const weld = weldMap(pos);
  const sum = new Map();
  for (let i = 0; i < n; i++) {
    const k = weld[i];
    let s = sum.get(k);
    if (!s) sum.set(k, (s = [0, 0, 0]));
    s[0] += acc[i * 3]; s[1] += acc[i * 3 + 1]; s[2] += acc[i * 3 + 2];
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = sum.get(weld[i]);
    const l = Math.hypot(s[0], s[1], s[2]) || 1;
    out[i * 3] = s[0] / l; out[i * 3 + 1] = s[1] / l; out[i * 3 + 2] = s[2] / l;
  }
  if (!positionsOverride) g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return out;
}

/** Map each vertex to the lowest vertex index sharing its position (tolerance 1e-6 m). */
export function weldMap(pos, tol = 1e-6) {
  const n = pos.length / 3, inv = 1 / tol, map = new Map(), out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * inv)},${Math.round(pos[i * 3 + 1] * inv)},${Math.round(pos[i * 3 + 2] * inv)}`;
    const e = map.get(k);
    if (e === undefined) { map.set(k, i); out[i] = i; } else out[i] = e;
  }
  return out;
}

/** Mirror raw arrays across x = 0 (positions only; reverses winding). */
export function mirrorX({ positions, uvs, index, ...rest }) {
  const p = positions.slice();
  for (let i = 0; i < p.length; i += 3) p[i] = -p[i];
  const idx = [];
  for (let t = 0; t < index.length; t += 3) idx.push(index[t], index[t + 2], index[t + 1]);
  return { positions: p, uvs: uvs.slice(), index: idx, ...rest };
}
