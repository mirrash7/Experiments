// Cloth-mesh toolkit for the costume (WP4): SDF primitives, Surface Nets extraction, exact implicit cuts,
// Laplacian smoothing with surface re-projection, real-thickness shells with rolled rims, garment skin
// weights (segment IDW + transfer from the body + Laplacian weight smoothing) and BufferGeometry assembly
// with UV-seam unwelding. Owner: WP4. Pure functions; no three.js scene objects are created here.
//
// Conventions: an SDF is f(x, y, z) -> signed distance (negative inside), root-space rest coordinates.
// A working mesh is { P: number[] (xyz flat), T: number[] (triangle indices flat) }, CCW = outward.

import * as THREE from 'three';

// ------------------------------------------------------------------------------------------------ profiling
/** Build-time profiler: lap('name') accumulates ms since the previous lap into PROF. */
export const PROF = { t: 0, laps: {} };
export function profReset() { PROF.t = performance.now(); PROF.laps = {}; }
export function lap(name) { const t = performance.now(); PROF.laps[name] = (PROF.laps[name] || 0) + Math.round((t - PROF.t) * 10) / 10; PROF.t = t; }

// ------------------------------------------------------------------------------------------------ math
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
/** Polynomial smooth min (k = blend radius, metres). */
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export const smax = (a, b, k) => -smin(-a, -b, k);

/** Catmull-Rom through keys [[t, v0, v1, ...], ...] (sorted by t), clamped at the ends. Returns number[]. */
export function sampleKeys(keys, t, out = []) {
  const n = keys.length, m = keys[0].length - 1;
  if (t <= keys[0][0]) { for (let k = 0; k < m; k++) out[k] = keys[0][k + 1]; return out; }
  if (t >= keys[n - 1][0]) { for (let k = 0; k < m; k++) out[k] = keys[n - 1][k + 1]; return out; }
  let i = 0;
  while (i < n - 2 && t > keys[i + 1][0]) i++;
  const k0 = keys[Math.max(i - 1, 0)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(i + 2, n - 1)];
  const u = (t - k1[0]) / (k2[0] - k1[0]);
  const u2 = u * u, u3 = u2 * u;
  for (let k = 1; k <= m; k++) {
    // tangents scaled for non-uniform spacing, clamped (monotone-ish) to avoid overshoot
    const d1 = k2[0] - k1[0];
    const m1 = k1 === k0 ? (k2[k] - k1[k]) : ((k2[k] - k0[k]) / (k2[0] - k0[0])) * d1;
    const m2 = k3 === k2 ? (k2[k] - k1[k]) : ((k3[k] - k1[k]) / (k3[0] - k1[0])) * d1;
    out[k - 1] = (2 * u3 - 3 * u2 + 1) * k1[k] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2[k] + (u3 - u2) * m2;
  }
  return out;
}
export const sample1 = (keys, t) => sampleKeys(keys, t, [0])[0];

/** Approximate 2D ellipse distance (iq). */
export function ellipseDist(x, z, rx, rz) {
  const k0 = Math.hypot(x / rx, z / rz);
  const k1 = Math.hypot(x / (rx * rx), z / (rz * rz));
  if (k1 < 1e-12) return -Math.min(rx, rz);
  return (k0 * (k0 - 1)) / k1;
}
/** Approximate ellipsoid distance (iq). */
export function sdEllipsoid(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = x - cx, py = y - cy, pz = z - cz;
  const k0 = Math.hypot(px / rx, py / ry, pz / rz);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  if (k1 < 1e-12) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}
export function sdSphere(x, y, z, cx, cy, cz, r) { return Math.hypot(x - cx, y - cy, z - cz) - r; }
/** Torus around the Y axis (ring radius R, tube radius r) centred at c. */
export function sdTorusY(x, y, z, cx, cy, cz, R, r) { const q = Math.hypot(x - cx, z - cz) - R; return Math.hypot(q, y - cy) - r; }

/** Hash-based 3D value noise in [-1, 1] and a 3-octave fBm. */
function hash3(i, j, k) {
  let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function valueNoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c = (a, b, d) => hash3(xi + a, yi + b, zi + d);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w) * 2 - 1;
}
export function fbm3(x, y, z, octaves = 3) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let o = 0; o < octaves; o++) { s += a * valueNoise3(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
/** Deterministic PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------------------------------------ shapes
/**
 * Elliptic loft along +Y: keys [[y, rx, rz, cz?]] (Catmull-Rom). Capped by planes at yMin / yMax.
 * Returns f(x, y, z).
 */
export function makeLoftY(keys, { yMin = -Infinity, yMax = Infinity, offset = null } = {}) {
  const tmp = [];
  return (x, y, z) => {
    sampleKeys(keys, y, tmp);
    const o = offset ? offset(x, y, z) : 0;
    let d = ellipseDist(x, z - (tmp[2] || 0), tmp[0] + o, tmp[1] + o);
    if (yMin > -Infinity) d = Math.max(d, yMin - y);
    if (yMax < Infinity) d = Math.max(d, y - yMax);
    return d;
  };
}

/**
 * Tube along segment a->b with an elliptic, optionally asymmetric cross-section.
 * radius(t, angle) -> [rWidthPos, rWidthNeg, rDepth, centreW, centreD], t in [0,1]; angle = atan2(v, u).
 * `up` = the width axis hint (orthonormalised against the axis). Caps are planar (cut garments anyway).
 */
export function makeTube({ a, b, up = [0, 1, 0], radius, capA = true, capB = true }) {
  const A = new THREE.Vector3(...a), D = new THREE.Vector3(...b).sub(A);
  const L = D.length(); D.divideScalar(L);
  const U = new THREE.Vector3(...up); U.addScaledVector(D, -U.dot(D)).normalize();
  const V = new THREE.Vector3().crossVectors(D, U);
  return (x, y, z) => {
    const qx = x - A.x, qy = y - A.y, qz = z - A.z;
    const t = (qx * D.x + qy * D.y + qz * D.z) / L;
    const tc = clamp(t, 0, 1);
    const u = qx * U.x + qy * U.y + qz * U.z, v = qx * V.x + qy * V.y + qz * V.z;
    const r = radius(tc, Math.atan2(v, u));
    const uu = u - (r[3] || 0), vv = v - (r[4] || 0);
    const dr = ellipseDist(uu, vv, uu >= 0 ? r[0] : r[1], r[2]);
    let da = -Infinity;
    if (capA) da = Math.max(da, -t * L);
    if (capB) da = Math.max(da, (t - 1) * L);
    if (da <= 0) return dr;
    return dr > 0 ? Math.hypot(dr, da) : da;
  };
}

/** Numerical gradient (central differences). */
export function gradient(f, x, y, z, e = 2e-4, out = [0, 0, 0]) {
  out[0] = (f(x + e, y, z) - f(x - e, y, z)) / (2 * e);
  out[1] = (f(x, y + e, z) - f(x, y - e, z)) / (2 * e);
  out[2] = (f(x, y, z + e) - f(x, y, z - e)) / (2 * e);
  return out;
}

// ------------------------------------------------------------------------------------------------ surface nets
/**
 * Grid axis coordinates from lo to hi with a spacing function step(c) (metres). symmetric: mirrored about
 * 0 and 0 is always a sample plane (left/right symmetry of the cloth).
 */
export function gridAxis(lo, hi, step, symmetric = false) {
  if (typeof step === 'number') { const h = step; step = () => h; }
  const out = [];
  if (symmetric) {
    const half = [0];
    for (let c = 0; c < Math.max(-lo, hi);) { c += step(c); half.push(c); }
    for (let i = half.length - 1; i > 0; i--) if (-half[i] >= lo - step(half[i])) out.push(-half[i]);
    for (const c of half) if (c <= hi + step(c)) out.push(c);
    return Float64Array.from(out);
  }
  for (let c = lo; c < hi + 1e-9;) { out.push(c); c += step(c); }
  out.push(out[out.length - 1] + step(hi));
  return Float64Array.from(out);
}

/**
 * Naive Surface Nets on a rectilinear (optionally non-uniform) grid. `grid` is either a voxel size h (uniform
 * grid aligned to multiples of h, x = 0 is a sample plane) or { xs, ys, zs } coordinate arrays.
 * Narrow band: values are first sampled on every other node; a fine node whose coarse neighbour is further
 * than `band` from the surface inherits that value (its sign cannot change), so only nodes near the surface
 * pay for an SDF evaluation. Returns a quad-dominant triangle mesh { P, T } with outward (CCW) winding; each
 * quad is split along its shorter diagonal.
 */
export function surfaceNets(f, bmin, bmax, grid) {
  let xs, ys, zs;
  if (typeof grid === 'number') {
    const h = grid;
    const ax = (a, b) => { const i0 = Math.floor(a / h), i1 = Math.ceil(b / h); const r = new Float64Array(i1 - i0 + 1); for (let i = i0; i <= i1; i++) r[i - i0] = i * h; return r; };
    xs = ax(bmin[0], bmax[0]); ys = ax(bmin[1], bmax[1]); zs = ax(bmin[2], bmax[2]);
  } else ({ xs, ys, zs } = grid);
  const nx = xs.length, ny = ys.length, nz = zs.length, nxy = nx * ny;
  let hmax = 0;
  for (const a of [xs, ys, zs]) for (let i = 1; i < a.length; i++) hmax = Math.max(hmax, a[i] - a[i - 1]);
  const band = hmax * 4.0;
  const val = new Float32Array(nx * ny * nz);
  // coarse pass (even indices + the last index on each axis)
  const ev = (n) => { const r = []; for (let i = 0; i < n; i += 2) r.push(i); if ((n - 1) % 2) r.push(n - 1); return r; };
  const cx = ev(nx), cy = ev(ny), cz = ev(nz);
  const evald = new Uint8Array(nx * ny * nz);
  for (const k of cz) for (const j of cy) for (const i of cx) {
    let v = f(xs[i], ys[j], zs[k]); if (v === 0) v = 1e-9;
    const o = i + nx * j + nxy * k; val[o] = v; evald[o] = 1;
  }
  const near = (i, n) => (i % 2 === 0 || i === n - 1 ? i : i - 1);
  for (let k = 0; k < nz; k++) {
    const kc = near(k, nz);
    for (let j = 0; j < ny; j++) {
      const jc = near(j, ny);
      for (let i = 0; i < nx; i++) {
        const o = i + nx * j + nxy * k;
        if (evald[o]) continue;
        const vc = val[near(i, nx) + nx * jc + nxy * kc];
        if (vc > band || vc < -band) { val[o] = vc; continue; }
        let v = f(xs[i], ys[j], zs[k]); if (v === 0) v = 1e-9;
        val[o] = v;
      }
    }
  }
  const cell = new Int32Array(nx * ny * nz).fill(-1);
  const P = [];
  const C = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const CO = C.map(([a, b, c]) => a + nx * b + nxy * c);
  const g = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const o = i + nx * j + nxy * k;
    let mask = 0;
    for (let c = 0; c < 8; c++) { g[c] = val[o + CO[c]]; if (g[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    const x0 = xs[i], dx = xs[i + 1] - x0, y0 = ys[j], dy = ys[j + 1] - y0, z0 = zs[k], dz = zs[k + 1] - z0;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of E) {
      if ((g[a] < 0) === (g[b] < 0)) continue;
      const t = g[a] / (g[a] - g[b]);
      sx += C[a][0] + (C[b][0] - C[a][0]) * t; sy += C[a][1] + (C[b][1] - C[a][1]) * t; sz += C[a][2] + (C[b][2] - C[a][2]) * t;
      cnt++;
    }
    cell[o] = P.length / 3;
    P.push(x0 + (sx / cnt) * dx, y0 + (sy / cnt) * dy, z0 + (sz / cnt) * dz);
  }
  const T = [];
  const quad = (q0, q1, q2, q3, dx, dy, dz) => {
    const a0 = 3 * q0, a1 = 3 * q1, a2 = 3 * q2, a3 = 3 * q3;
    const ux = P[a2] - P[a0], uy = P[a2 + 1] - P[a0 + 1], uz = P[a2 + 2] - P[a0 + 2];
    const vx = P[a3] - P[a1], vy = P[a3 + 1] - P[a1 + 1], vz = P[a3 + 2] - P[a1 + 2];
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    if (nxv * dx + nyv * dy + nzv * dz < 0) { const t = q1; q1 = q3; q3 = t; }
    const d02 = ux * ux + uy * uy + uz * uz, d13 = vx * vx + vy * vy + vz * vz;
    if (d02 <= d13) T.push(q0, q1, q2, q0, q2, q3);
    else T.push(q0, q1, q3, q1, q2, q3);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = i + nx * j + nxy * k;
    const v0 = val[o];
    if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1) {
      const v1 = val[o + 1];
      if ((v0 < 0) !== (v1 < 0)) {
        const a = cell[o - nx - nxy], b = cell[o - nxy], c = cell[o], d = cell[o - nx];
        if (a >= 0 && b >= 0 && c >= 0 && d >= 0) quad(a, b, c, d, Math.sign(v1 - v0), 0, 0);
      }
    }
    if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
      const v1 = val[o + nx];
      if ((v0 < 0) !== (v1 < 0)) {
        const a = cell[o - 1 - nxy], b = cell[o - nxy], c = cell[o], d = cell[o - 1];
        if (a >= 0 && b >= 0 && c >= 0 && d >= 0) quad(a, b, c, d, 0, Math.sign(v1 - v0), 0);
      }
    }
    if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
      const v1 = val[o + nxy];
      if ((v0 < 0) !== (v1 < 0)) {
        const a = cell[o - 1 - nx], b = cell[o - nx], c = cell[o], d = cell[o - 1];
        if (a >= 0 && b >= 0 && c >= 0 && d >= 0) quad(a, b, c, d, 0, 0, Math.sign(v1 - v0));
      }
    }
  }
  return { P, T };
}

// ------------------------------------------------------------------------------------------------ mesh ops
export const vcount = (m) => m.P.length / 3;
export const tcount = (m) => m.T.length / 3;

/** Newton-project every vertex (or those with mask[i]) onto f = 0. */
export function projectToSurface(m, f, { iters = 3, mask = null, maxStep = 0.02 } = {}) {
  const g = [0, 0, 0], P = m.P;
  for (let i = 0; i < P.length / 3; i++) {
    if (mask && !mask[i]) continue;
    for (let it = 0; it < iters; it++) {
      const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
      const d = f(x, y, z);
      if (Math.abs(d) < 1e-6) break;
      gradient(f, x, y, z, 2e-4, g);
      const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (gg < 1e-12) break;
      let s = -d / gg;
      const len = Math.abs(s) * Math.sqrt(gg);
      if (len > maxStep) s *= maxStep / len;
      P[3 * i] += g[0] * s; P[3 * i + 1] += g[1] * s; P[3 * i + 2] += g[2] * s;
    }
  }
  return m;
}

/** Drop unreferenced vertices. Returns { m, remap } (remap: old -> new or -1). */
export function compact(m) {
  const n = vcount(m), remap = new Int32Array(n).fill(-1), P = [];
  for (const i of m.T) if (remap[i] < 0) { remap[i] = P.length / 3; P.push(m.P[3 * i], m.P[3 * i + 1], m.P[3 * i + 2]); }
  return { m: { P, T: m.T.map((i) => remap[i]) }, remap };
}

/**
 * Exact implicit cut: keeps the part where cut(p) <= 0, splitting triangles along cut = 0.
 * Vertices close to the cut are first slid onto it (tangentially to `surf`, if given) to avoid slivers.
 * keepBoth: keeps both sides and returns triangle side labels (0 = cut <= 0, 1 = cut > 0).
 * Returns { m, side? , onCut: Uint8Array (vertex lies on the cut) }.
 */
export function clipMesh(m, cut, { keepBoth = false, surf = null, snap = 0.004 } = {}) {
  const P = m.P.slice(), n0 = P.length / 3;
  const fv = [];
  const g = [0, 0, 0], sn = [0, 0, 0];
  for (let i = 0; i < n0; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    let v = cut(x, y, z);
    if (snap > 0 && Math.abs(v) < snap * 2) {
      gradient(cut, x, y, z, 2e-4, g);
      if (surf) {
        gradient(surf, x, y, z, 2e-4, sn);
        const l = Math.hypot(sn[0], sn[1], sn[2]) || 1;
        const d = (g[0] * sn[0] + g[1] * sn[1] + g[2] * sn[2]) / (l * l);
        g[0] -= sn[0] * d; g[1] -= sn[1] * d; g[2] -= sn[2] * d;
      }
      const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (gg > 1e-10 && Math.abs(v) / Math.sqrt(gg) < snap) {
        const s = -v / gg;
        P[3 * i] += g[0] * s; P[3 * i + 1] += g[1] * s; P[3 * i + 2] += g[2] * s;
        v = cut(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
        if (Math.abs(v) < 1e-4) v = 0;
      }
    }
    fv.push(v);
  }
  const cache = new Map();
  const edgeVert = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * 4194304 + hi;
    let e = cache.get(key);
    if (e === undefined) {
      const t = fv[lo] / (fv[lo] - fv[hi]);
      e = P.length / 3;
      P.push(P[3 * lo] + (P[3 * hi] - P[3 * lo]) * t, P[3 * lo + 1] + (P[3 * hi + 1] - P[3 * lo + 1]) * t, P[3 * lo + 2] + (P[3 * hi + 2] - P[3 * lo + 2]) * t);
      fv.push(0);
      cache.set(key, e);
    }
    return e;
  };
  const T = [], side = [];
  const emit = (poly, s) => {
    if (poly.length < 3) return;
    for (let k = 1; k < poly.length - 1; k++) {
      const a = poly[0], b = poly[k], c = poly[k + 1];
      if (a === b || b === c || a === c) continue;
      T.push(a, b, c); side.push(s);
    }
  };
  for (let t = 0; t < m.T.length; t += 3) {
    const tri = [m.T[t], m.T[t + 1], m.T[t + 2]];
    for (const s of keepBoth ? [1, -1] : [1]) {
      const poly = [];
      for (let e = 0; e < 3; e++) {
        const cur = tri[e], nxt = tri[(e + 1) % 3];
        const fc = s * fv[cur], fn = s * fv[nxt];
        if (fc <= 0) poly.push(cur);
        if ((fc < 0 && fn > 0) || (fc > 0 && fn < 0)) poly.push(edgeVert(cur, nxt));
      }
      // drop polygons that only touch the cut (all vertices on it)
      if (poly.every((i) => fv[i] === 0)) continue;
      emit(poly, s > 0 ? 0 : 1);
    }
  }
  const { m: out, remap } = compact({ P, T });
  const onCut = new Uint8Array(out.P.length / 3);
  for (let i = 0; i < fv.length; i++) if (remap[i] >= 0 && fv[i] === 0) onCut[remap[i]] = 1;
  return keepBoth ? { m: out, side, onCut } : { m: out, onCut };
}

/** Merge vertices closer than tol; removes degenerate triangles. */
export function weld(m, tol = 1e-5) {
  const inv = 1 / tol, map = new Map(), remap = new Int32Array(vcount(m)), P = [];
  for (let i = 0; i < vcount(m); i++) {
    const k = `${Math.round(m.P[3 * i] * inv)},${Math.round(m.P[3 * i + 1] * inv)},${Math.round(m.P[3 * i + 2] * inv)}`;
    let j = map.get(k);
    if (j === undefined) { j = P.length / 3; map.set(k, j); P.push(m.P[3 * i], m.P[3 * i + 1], m.P[3 * i + 2]); }
    remap[i] = j;
  }
  const T = [];
  for (let t = 0; t < m.T.length; t += 3) {
    const a = remap[m.T[t]], b = remap[m.T[t + 1]], c = remap[m.T[t + 2]];
    if (a !== b && b !== c && a !== c) T.push(a, b, c);
  }
  return { P, T };
}

/** Vertex adjacency (array of neighbour Int32Array views, CSR-backed) and boundary info. */
export function topology(m) {
  const n = vcount(m), T = m.T, nt = T.length;
  const cnt = new Int32Array(n + 1);
  for (let t = 0; t < nt; t++) cnt[T[t] + 1] += 2;
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const fill = cnt.slice(0, n), ent = new Int32Array(nt * 2);
  for (let t = 0; t < nt; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = T[t + e], b = T[t + (e + 1) % 3], c = T[t + (e + 2) % 3];
      ent[fill[a]++] = b * 2 + 1;      // a -> b forward in this triangle
      ent[fill[a]++] = c * 2;          // c -> a
    }
  }
  const uniq = new Int32Array(nt * 2), off = new Int32Array(n + 1);
  const boundary = new Uint8Array(n), bEdges = [];
  const bNext = new Int32Array(n).fill(-1), bPrev = new Int32Array(n).fill(-1);
  let u = 0;
  for (let a = 0; a < n; a++) {
    off[a] = u;
    const seg = ent.subarray(cnt[a], cnt[a + 1]);
    seg.sort();
    for (let s = 0; s < seg.length;) {
      const b = seg[s] >> 1;
      let e = s, fwd = 0, back = 0;
      while (e < seg.length && seg[e] >> 1 === b) { if (seg[e] & 1) fwd++; else back++; e++; }
      uniq[u++] = b;
      if (fwd + back === 1) {
        boundary[a] = boundary[b] = 1;
        if (fwd) { bEdges.push(a, b); bNext[a] = b; bPrev[b] = a; }
      }
      s = e;
    }
  }
  off[n] = u;
  const neighbors = new Array(n);
  for (let a = 0; a < n; a++) neighbors[a] = uniq.subarray(off[a], off[a + 1]);
  return { neighbors, boundary, bEdges, bNext, bPrev };
}

/** Area-weighted vertex normals (Float32Array n*3). */
export function vertexNormals(m) {
  const n = vcount(m), N = new Float32Array(n * 3), P = m.P;
  for (let t = 0; t < m.T.length; t += 3) {
    const a = m.T[t], b = m.T[t + 1], c = m.T[t + 2];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { N[3 * i] += nx; N[3 * i + 1] += ny; N[3 * i + 2] += nz; }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(N[3 * i], N[3 * i + 1], N[3 * i + 2]) || 1;
    N[3 * i] /= l; N[3 * i + 1] /= l; N[3 * i + 2] /= l;
  }
  return N;
}

/**
 * Laplacian smoothing. Interior vertices move toward their neighbour average and are re-projected onto
 * `surf`; boundary vertices are smoothed as a curve (boundary neighbours only, weaker) and re-projected
 * too, so cut edges stay clean but lose voxel stair-steps. `fixed` (Uint8Array) pins vertices.
 */
export function smoothMesh(m, { passes = 3, lambda = 0.5, boundaryLambda = 0.25, surf = null, fixed = null, topo = null } = {}) {
  const tp = topo || topology(m);
  const n = vcount(m), P = m.P, Q = new Float64Array(n * 3);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0, c = 0, lam = lambda;
      if (fixed && fixed[i]) { Q[3 * i] = P[3 * i]; Q[3 * i + 1] = P[3 * i + 1]; Q[3 * i + 2] = P[3 * i + 2]; continue; }
      if (tp.boundary[i]) {
        lam = boundaryLambda;
        for (const j of [tp.bNext[i], tp.bPrev[i]]) if (j >= 0) { sx += P[3 * j]; sy += P[3 * j + 1]; sz += P[3 * j + 2]; c++; }
      } else {
        for (const j of tp.neighbors[i]) { sx += P[3 * j]; sy += P[3 * j + 1]; sz += P[3 * j + 2]; c++; }
      }
      if (!c) { Q[3 * i] = P[3 * i]; Q[3 * i + 1] = P[3 * i + 1]; Q[3 * i + 2] = P[3 * i + 2]; continue; }
      Q[3 * i] = P[3 * i] + (sx / c - P[3 * i]) * lam;
      Q[3 * i + 1] = P[3 * i + 1] + (sy / c - P[3 * i + 1]) * lam;
      Q[3 * i + 2] = P[3 * i + 2] + (sz / c - P[3 * i + 2]) * lam;
    }
    for (let i = 0; i < n * 3; i++) P[i] = Q[i];
    if (surf) projectToSurface(m, surf, { iters: pass === passes - 1 ? 2 : 1, mask: fixed ? fixed.map((f) => (f ? 0 : 1)) : null });
  }
  return m;
}

/**
 * Real cloth thickness: outer surface (as is), inner surface offset by -normal * thickness (reversed),
 * and a rolled rim (half-round, `rimSegments` rows) along every boundary loop, welded to both shells so
 * normals stay smooth and the outline hull wraps the edge. bulge > 0 makes the rim a little proud.
 * Returns { m, layer: Uint8Array (0 outer, 1 inner, 2 rim), src: Int32Array (source vertex), rimT: Float32Array }.
 */
export function thicken(m, thickness, { rimSegments = 3, bulge = 0.25, normals = null, thicknessFn = null, innerMask = null } = {}) {
  const n = vcount(m), N = normals || vertexNormals(m), tp = topology(m);
  const P = m.P.slice(), T = m.T.slice();
  const layer = [], src = [], rimT = [];
  for (let i = 0; i < n; i++) { layer.push(0); src.push(i); rimT.push(0); }
  const th = new Float32Array(n);
  for (let i = 0; i < n; i++) th[i] = thicknessFn ? thicknessFn(i, P[3 * i], P[3 * i + 1], P[3 * i + 2]) : thickness;
  // inner shell
  for (let i = 0; i < n; i++) {
    P.push(P[3 * i] - N[3 * i] * th[i], P[3 * i + 1] - N[3 * i + 1] * th[i], P[3 * i + 2] - N[3 * i + 2] * th[i]);
    layer.push(1); src.push(i); rimT.push(1);
  }
  // inner shell (optionally only a band near the edges: innerMask[v] = 1; the rest is hidden by the body)
  for (let t = 0; t < m.T.length; t += 3) {
    if (innerMask && !(innerMask[m.T[t]] || innerMask[m.T[t + 1]] || innerMask[m.T[t + 2]])) continue;
    T.push(m.T[t] + n, m.T[t + 2] + n, m.T[t + 1] + n);
  }
  // rim rows: per boundary vertex, outward edge direction E = d x N averaged over its two boundary edges
  const S = Math.max(1, rimSegments);
  const rimRow = new Map(); // vertex -> [row0 .. rowS] indices
  const Edir = new Map();
  for (let e = 0; e < tp.bEdges.length; e += 2) {
    const a = tp.bEdges[e], b = tp.bEdges[e + 1];
    const dx = P[3 * b] - P[3 * a], dy = P[3 * b + 1] - P[3 * a + 1], dz = P[3 * b + 2] - P[3 * a + 2];
    for (const v of [a, b]) {
      const nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2];
      const ex = dy * nz - dz * ny, ey = dz * nx - dx * nz, ez = dx * ny - dy * nx;
      const acc = Edir.get(v) || [0, 0, 0];
      acc[0] += ex; acc[1] += ey; acc[2] += ez;
      Edir.set(v, acc);
    }
  }
  for (const [v, e] of Edir) {
    const l = Math.hypot(e[0], e[1], e[2]) || 1;
    const ex = e[0] / l, ey = e[1] / l, ez = e[2] / l;
    const row = [v];
    const t2 = th[v] / 2;
    const cx = P[3 * v] - N[3 * v] * t2, cy = P[3 * v + 1] - N[3 * v + 1] * t2, cz = P[3 * v + 2] - N[3 * v + 2] * t2;
    for (let k = 1; k < S; k++) {
      const al = (Math.PI * k) / S, c = Math.cos(al), s = Math.sin(al) * (1 + bulge);
      row.push(P.length / 3);
      P.push(cx + N[3 * v] * t2 * c + ex * t2 * s, cy + N[3 * v + 1] * t2 * c + ey * t2 * s, cz + N[3 * v + 2] * t2 * c + ez * t2 * s);
      layer.push(2); src.push(v); rimT.push(k / S);
    }
    row.push(v + n);
    rimRow.set(v, row);
  }
  for (let e = 0; e < tp.bEdges.length; e += 2) {
    const A = rimRow.get(tp.bEdges[e]), Bv = rimRow.get(tp.bEdges[e + 1]);
    for (let k = 0; k < S; k++) T.push(Bv[k], A[k], A[k + 1], Bv[k], A[k + 1], Bv[k + 1]);
  }
  // drop unreferenced inner vertices (keeps indices of outer vertices unchanged: they all stay referenced)
  const used = new Uint8Array(P.length / 3);
  for (const i of T) used[i] = 1;
  const remap = new Int32Array(P.length / 3).fill(-1), P2 = [], L2 = [], S2 = [], R2 = [];
  for (let i = 0; i < used.length; i++) if (used[i] || i < n) { remap[i] = P2.length / 3; P2.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); L2.push(layer[i]); S2.push(src[i]); R2.push(rimT[i]); }
  return { m: { P: P2, T: T.map((i) => remap[i]) }, layer: Uint8Array.from(L2), src: Int32Array.from(S2), rimT: Float32Array.from(R2) };
}

/** Geodesic-ish distance from the mesh boundary (multi-source Dijkstra over edges). */
export function boundaryDistance(m, topo = null) {
  const tp = topo || topology(m), n = vcount(m), D = new Float32Array(n).fill(Infinity), P = m.P;
  const heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let mn = k; if (l < heap.length && heap[l][0] < heap[mn][0]) mn = l; if (r < heap.length && heap[r][0] < heap[mn][0]) mn = r; if (mn === k) break; [heap[mn], heap[k]] = [heap[k], heap[mn]]; k = mn; } } return top; };
  for (let i = 0; i < n; i++) if (tp.boundary[i]) { D[i] = 0; push(0, i); }
  while (heap.length) {
    const [d, i] = pop();
    if (d > D[i]) continue;
    for (const j of tp.neighbors[i]) {
      const nd = d + Math.hypot(P[3 * i] - P[3 * j], P[3 * i + 1] - P[3 * j + 1], P[3 * i + 2] - P[3 * j + 2]);
      if (nd < D[j]) { D[j] = nd; push(nd, j); }
    }
  }
  return D;
}

/** Append mesh b into a (in place); returns the vertex offset of b. */
export function appendMesh(a, b) {
  const off = vcount(a);
  for (const v of b.P) a.P.push(v);
  for (const i of b.T) a.T.push(i + off);
  return off;
}

// ------------------------------------------------------------------------------------------------ parametric
/**
 * Loft a closed cross-section along a path. rings: array of rings, each an array of [x,y,z] points (same
 * count). closedPath: connect last ring to first. capStart/capEnd: fan-cap open ends (centroid vertex).
 * Returns { m, ringOf: Int32Array, idxIn: Int32Array } (per vertex ring index / index within ring; caps -1).
 */
export function loftRings(rings, { closedPath = false, capStart = false, capEnd = false } = {}) {
  const R = rings.length, C = rings[0].length, P = [], T = [], ringOf = [], idxIn = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { P.push(...rings[r][c]); ringOf.push(r); idxIn.push(c); }
  const id = (r, c) => (r % R) * C + (c % C);
  const rmax = closedPath ? R : R - 1;
  for (let r = 0; r < rmax; r++) for (let c = 0; c < C; c++) {
    const a = id(r, c), b = id(r, c + 1), d = id(r + 1, c), e = id(r + 1, c + 1);
    T.push(a, d, b, b, d, e);
  }
  // caps are oriented to match the side walls: the shared edge must run opposite to the wall's edge
  const cap = (r) => {
    let cx = 0, cy = 0, cz = 0;
    for (let c = 0; c < C; c++) { cx += rings[r][c][0]; cy += rings[r][c][1]; cz += rings[r][c][2]; }
    const ci = P.length / 3; P.push(cx / C, cy / C, cz / C); ringOf.push(r); idxIn.push(-1);
    // wall quad at ring 0 emits edge (a=id(0,c) -> b=id(0,c+1)) in triangle (a, d, b) as b->a ... see T.push(a, d, b)
    // first ring: wall triangle (a, d, b) contains edge b->a, so the cap must contain a->b
    const first = r === 0;
    for (let c = 0; c < C; c++) { const a = id(r, c), b = id(r, c + 1); if (first) T.push(ci, a, b); else T.push(ci, b, a); }
  };
  if (capStart) cap(0);
  if (capEnd) cap(R - 1);
  return { m: { P, T }, ringOf: Int32Array.from(ringOf), idxIn: Int32Array.from(idxIn) };
}

/** Make sure a mesh's winding is outward relative to a reference point inside (flips all if needed). */
export function orientOutward(m, cx, cy, cz) {
  let s = 0;
  const P = m.P;
  for (let t = 0; t < m.T.length; t += 3) {
    const a = m.T[t], b = m.T[t + 1], c = m.T[t + 2];
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    s += nx * (P[3 * a] - cx) + ny * (P[3 * a + 1] - cy) + nz * (P[3 * a + 2] - cz);
  }
  if (s < 0) for (let t = 0; t < m.T.length; t += 3) { const b = m.T[t + 1]; m.T[t + 1] = m.T[t + 2]; m.T[t + 2] = b; }
  return m;
}

// ------------------------------------------------------------------------------------------------ skinning
/** Dense weights helper: W = Float32Array(n * B). */
export function denseWeights(n, B) { return new Float32Array(n * B); }

const _sa = new THREE.Vector3(), _sb = new THREE.Vector3(), _sp = new THREE.Vector3();
function segDist(px, py, pz, a, b) {
  _sb.subVectors(b, a); _sp.set(px - a.x, py - a.y, pz - a.z);
  const t = clamp(_sp.dot(_sb) / Math.max(_sb.lengthSq(), 1e-12), 0, 1);
  return _sp.addScaledVector(_sb, -t).length();
}

/**
 * Inverse-distance weights to bone segments (like geo/attributes skinToSegments, but dense so it can be
 * smoothed). segs: [{ bone, a, b, r }]; filter(i, x, y, z, seg) -> bool. Writes into W.
 */
export function weightsFromSegments(m, rig, W, B, segs, { power = 6, filter = null, mask = null } = {}) {
  const idx = segs.map((s) => rig.boneIndex[s.bone]);
  for (let i = 0; i < vcount(m); i++) {
    if (mask && !mask[i]) continue;
    const x = m.P[3 * i], y = m.P[3 * i + 1], z = m.P[3 * i + 2];
    let sum = 0;
    const o = i * B;
    for (let k = 0; k < B; k++) W[o + k] = 0;
    for (let s = 0; s < segs.length; s++) {
      if (filter && !filter(i, x, y, z, segs[s])) continue;
      let d = segDist(x, y, z, segs[s].a, segs[s].b);
      if (segs[s].r) d -= segs[s].r * 0.5;
      const w = Math.pow(Math.max(d, 1e-3), -power);
      W[o + idx[s]] += w; sum += w;
    }
    if (sum > 0) for (let k = 0; k < B; k++) W[o + k] /= sum;
  }
  return W;
}

/**
 * Transfer weights from a skinned BufferGeometry (e.g. the body) by k-nearest source vertices (IDW).
 * Only vertices with a source within maxDist are written; returns a Uint8Array mask of written vertices.
 * The source is indexed once into a flat spatial hash (typed arrays) and cached on the geometry.
 */
function sourceIndex(srcGeo, cell) {
  const cache = srcGeo.userData || (srcGeo.userData = {});
  const ck = `__costumeIdx${cell}`;
  if (cache[ck]) return cache[ck];
  const sp = srcGeo.attributes.position, n = sp.count, X = new Float32Array(n * 3);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++) {
    X[3 * v] = sp.getX(v); X[3 * v + 1] = sp.getY(v); X[3 * v + 2] = sp.getZ(v);
    for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], X[3 * v + c]); hi[c] = Math.max(hi[c], X[3 * v + c]); }
  }
  const inv = 1 / cell;
  const o = lo.map((l) => Math.floor(l * inv) - 1), dim = hi.map((h, c) => Math.floor(h * inv) - o[c] + 2);
  const cellOf = (v) => (Math.floor(X[3 * v] * inv) - o[0]) + dim[0] * ((Math.floor(X[3 * v + 1] * inv) - o[1]) + dim[1] * (Math.floor(X[3 * v + 2] * inv) - o[2]));
  const start = new Int32Array(dim[0] * dim[1] * dim[2] + 1), items = new Int32Array(n);
  for (let v = 0; v < n; v++) start[cellOf(v) + 1]++;
  for (let i = 0; i < start.length - 1; i++) start[i + 1] += start[i];
  const fill = start.slice();
  for (let v = 0; v < n; v++) items[fill[cellOf(v)]++] = v;
  const si = srcGeo.attributes.skinIndex, sw = srcGeo.attributes.skinWeight;
  const SI = new Uint16Array(n * 4), SWt = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) for (let c = 0; c < 4; c++) { SI[v * 4 + c] = si.getComponent(v, c); SWt[v * 4 + c] = sw.getComponent(v, c); }
  return (cache[ck] = { X, start, items, o, dim, inv, SI, SW: SWt });
}

export function transferWeights(m, W, B, srcGeo, { k = 6, maxDist = 0.12, cell = 0.03, mask = null, boneFilter = null } = {}) {
  const { X, start, items, o, dim, inv, SI, SW } = sourceIndex(srcGeo, cell);
  const done = new Uint8Array(vcount(m));
  const R = Math.ceil(maxDist * inv);
  const bd = new Float64Array(k), bv = new Int32Array(k);
  const allowed = new Uint8Array(B);
  for (let b = 0; b < B; b++) allowed[b] = !boneFilter || boneFilter(b) ? 1 : 0;
  for (let i = 0; i < vcount(m); i++) {
    if (mask && !mask[i]) continue;
    const x = m.P[3 * i], y = m.P[3 * i + 1], z = m.P[3 * i + 2];
    const ci = Math.floor(x * inv) - o[0], cj = Math.floor(y * inv) - o[1], ck = Math.floor(z * inv) - o[2];
    let cnt = 0;
    for (let r = 0; r <= R; r++) {
      for (let c = -r; c <= r; c++) {
        const kz = ck + c; if (kz < 0 || kz >= dim[2]) continue;
        const ac = Math.abs(c);
        for (let b = -r; b <= r; b++) {
          const jy = cj + b; if (jy < 0 || jy >= dim[1]) continue;
          const shell = ac === r || Math.abs(b) === r;
          for (let a = -r; a <= r; a += (shell || a === r ? 1 : 2 * r)) {
            const ix = ci + a; if (ix < 0 || ix >= dim[0]) continue;
            const cid = ix + dim[0] * (jy + dim[1] * kz);
            for (let q = start[cid]; q < start[cid + 1]; q++) {
              const v = items[q];
              const dx = X[3 * v] - x, dy = X[3 * v + 1] - y, dz = X[3 * v + 2] - z;
              const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (d > maxDist || (cnt === k && d >= bd[k - 1])) continue;
              let s2 = cnt < k ? cnt++ : k - 1;
              while (s2 > 0 && bd[s2 - 1] > d) { bd[s2] = bd[s2 - 1]; bv[s2] = bv[s2 - 1]; s2--; }
              bd[s2] = d; bv[s2] = v;
            }
            if (r === 0) break;
          }
        }
      }
      if (cnt >= k && bd[k - 1] < r / inv) break;
    }
    if (!cnt) continue;
    const ow = i * B;
    for (let q = 0; q < B; q++) W[ow + q] = 0;
    let sum = 0;
    const d0 = bd[0];
    for (let q = 0; q < cnt; q++) {
      const v = bv[q], dd = Math.max(bd[q] - d0 * 0.8, 0.002), w = 1 / (dd * dd);
      for (let c = 0; c < 4; c++) {
        const bi = SI[v * 4 + c], bw = SW[v * 4 + c];
        if (bw <= 0 || !allowed[bi]) continue;
        W[ow + bi] += w * bw; sum += w * bw;
      }
    }
    if (sum > 0) { for (let q = 0; q < B; q++) W[ow + q] /= sum; done[i] = 1; }
  }
  return done;
}

/** Laplacian smoothing of dense weights over mesh adjacency. fixed[i] pins a vertex; bones limits the columns. */
export function smoothWeights(W, B, neighbors, { passes = 2, alpha = 0.5, fixed = null, bones = null } = {}) {
  const n = neighbors.length, tmp = new Float32Array(W);
  let cols = bones || Array.from({ length: B }, (_, k) => k);
  cols = Int32Array.from(cols.filter((k) => { for (let i = 0; i < n; i++) if (W[i * B + k] > 0) return true; return false; }));
  const nc = cols.length;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const o = i * B, nb = neighbors[i], nn = nb.length;
      if ((fixed && fixed[i]) || !nn) continue;
      const inv = alpha / nn;
      for (let c = 0; c < nc; c++) {
        const k = cols[c];
        let s = 0;
        for (let q = 0; q < nn; q++) s += W[nb[q] * B + k];
        tmp[o + k] = W[o + k] * (1 - alpha) + s * inv;
      }
    }
    W.set(tmp);
  }
  return W;
}

/** Mix a fraction of vertex i's weights onto bone b (keeps the sum). */
export function blendToBone(W, B, i, b, amount) {
  if (amount <= 0) return;
  const o = i * B;
  for (let k = 0; k < B; k++) W[o + k] *= 1 - amount;
  W[o + b] += amount;
}
/** Move `amount` of the weight currently on bone `from` to bone `to`. */
export function moveWeight(W, B, i, from, to, amount) {
  const o = i * B, w = W[o + from] * amount;
  W[o + from] -= w; W[o + to] += w;
}

/** Dense -> top-4 normalized skinIndex (Uint16) / skinWeight (Float32) arrays. */
export function packWeights(W, B, n) {
  const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4), top = [];
  for (let i = 0; i < n; i++) {
    top.length = 0;
    const o = i * B;
    for (let k = 0; k < B; k++) if (W[o + k] > 1e-4) top.push([W[o + k], k]);
    top.sort((a, b) => b[0] - a[0]);
    const t = top.slice(0, 4);
    const s = t.reduce((a, x) => a + x[0], 0);
    if (!t.length) { SW[i * 4] = 1; continue; }
    t.forEach(([w, k], c) => { SI[i * 4 + c] = k; SW[i * 4 + c] = w / s; });
  }
  return { SI, SW };
}

// ------------------------------------------------------------------------------------------------ assembly
/**
 * Build an indexed character BufferGeometry from a working mesh.
 * opts:
 *   normals       Float32Array n*3 (default: area-weighted of m)
 *   region(t)     triangle -> region id (vertices are duplicated where regions meet: UV / matId seams)
 *   uv(i, region) -> [u, v] in atlas space
 *   wrap(region)  -> u period (e.g. 0.5) if that region's u wraps (triangles straddling it get +period)
 *   matId(i, region), shadeBias(i, region), outlineWidth(i, region)
 *   W, B          dense weights (or SI / SW packed arrays)
 * Positions in root-space rest coordinates. outlineNormal is position-welded (geo/attributes).
 */
export function toGeometry(m, opts) {
  const n = vcount(m);
  const N = opts.normals || vertexNormals(m);
  const packed = opts.SI ? { SI: opts.SI, SW: opts.SW } : packWeights(opts.W, opts.B, n);
  const keyMap = new Map();
  const pos = [], nor = [], uvs = [], mat = [], sb = [], ow = [], si = [], sw = [], idx = [], srcV = [];
  const vert = (i, reg, shift) => {
    const key = i * 64 + reg * 2 + (shift ? 1 : 0);
    let v = keyMap.get(key);
    if (v !== undefined) return v;
    v = pos.length / 3; keyMap.set(key, v); srcV.push(i);
    pos.push(m.P[3 * i], m.P[3 * i + 1], m.P[3 * i + 2]);
    nor.push(N[3 * i], N[3 * i + 1], N[3 * i + 2]);
    const uv = opts.uv ? opts.uv(i, reg) : [0, 0];
    uvs.push(uv[0] + (shift || 0), uv[1]);
    mat.push(opts.matId(i, reg));
    sb.push(opts.shadeBias ? opts.shadeBias(i, reg) : 0);
    ow.push(opts.outlineWidth ? opts.outlineWidth(i, reg) : 1);
    for (let c = 0; c < 4; c++) { si.push(packed.SI[i * 4 + c]); sw.push(packed.SW[i * 4 + c]); }
    return v;
  };
  for (let t = 0; t < m.T.length; t += 3) {
    const reg = opts.region ? opts.region(t / 3) : 0;
    const tri = [m.T[t], m.T[t + 1], m.T[t + 2]];
    let shift = [0, 0, 0];
    const period = opts.wrap ? opts.wrap(reg) : 0;
    if (period && opts.uv) {
      const us = tri.map((i) => opts.uv(i, reg)[0]);
      const mx = Math.max(...us);
      if (mx - Math.min(...us) > period * 0.5) shift = us.map((u) => (mx - u > period * 0.5 ? period : 0));
    }
    for (let k = 0; k < 3; k++) idx.push(vert(tri[k], reg, shift[k]));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('matId', new THREE.Float32BufferAttribute(mat, 1));
  geo.setAttribute('shadeBias', new THREE.Float32BufferAttribute(sb, 1));
  geo.setAttribute('outlineWidth', new THREE.Float32BufferAttribute(ow, 1));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.setIndex(idx);
  geo.userData.srcVertex = Int32Array.from(srcV);
  return geo;
}

/** Monotone cubic (Fritsch-Carlson) 1-D interpolator through keys [[t, v], ...]. Returns f(t). */
export function monotone(keys) {
  const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  const d = [], m = new Array(n).fill(0);
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
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** Remove connected components with fewer than minTris triangles. */
export function removeSmallComponents(m, minTris = 40) {
  const n = vcount(m), parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < m.T.length; t += 3) {
    const a = find(m.T[t]), b = find(m.T[t + 1]), c = find(m.T[t + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const count = new Map();
  for (let t = 0; t < m.T.length; t += 3) { const r = find(m.T[t]); count.set(r, (count.get(r) || 0) + 1); }
  const T = [];
  for (let t = 0; t < m.T.length; t += 3) if (count.get(find(m.T[t])) >= minTris) T.push(m.T[t], m.T[t + 1], m.T[t + 2]);
  return compact({ P: m.P, T }).m;
}

/** March along a ray from (ox,oy,oz) in direction (dx,dy,dz) (unit) and return the first t where f <= 0. */
export function rayHit(f, ox, oy, oz, dx, dy, dz, tMax = 0.5, step = 0.002) {
  let prev = f(ox, oy, oz);
  if (prev <= 0) return 0;
  for (let t = step; t <= tMax; t += step) {
    const v = f(ox + dx * t, oy + dy * t, oz + dz * t);
    if (v <= 0) { // bisect
      let a = t - step, b = t;
      for (let k = 0; k < 20; k++) { const mdl = (a + b) / 2; if (f(ox + dx * mdl, oy + dy * mdl, oz + dz * mdl) <= 0) b = mdl; else a = mdl; }
      return b;
    }
    prev = v;
  }
  return -1;
}

/**
 * Garment skin weights: segment IDW base (allowed bones only), overridden by a k-NN transfer from the
 * body geometry where available (so cloth deforms exactly like the skin it covers), then Laplacian
 * weight smoothing over the cloth topology. Returns dense W (n * B).
 */
export function garmentWeights(m, rig, { srcGeo = null, bones, neighbors, smoothPasses = 2, power = 5, maxDist = 0.12, segFilter = null } = {}) {
  const B = rig.boneOrder.length, n = vcount(m), W = denseWeights(n, B);
  const allowed = new Set(bones.map((b) => rig.boneIndex[b]));
  const segs = rig.segments.filter((s) => bones.includes(s.bone));
  // body transfer first; the segment IDW fallback only where no body vertex is in range
  const done = srcGeo && srcGeo.attributes.skinIndex ? transferWeights(m, W, B, srcGeo, { maxDist, boneFilter: (b) => allowed.has(b) }) : null;
  weightsFromSegments(m, rig, W, B, segs, { power, filter: segFilter, mask: done ? done.map((d) => 1 - d) : null });
  if (neighbors && smoothPasses) smoothWeights(W, B, neighbors, { passes: smoothPasses, bones: [...allowed] });
  return W;
}

/**
 * Approximate signed distance to a mesh surface from its vertices + normals (nearest vertex, sign from
 * its normal). Used to shrink-wrap cloth around the real body: cloth = min(design, bodySdf - clearance)
 * guarantees clearance wherever the body is bigger than the design. Far from any vertex returns +maxDist.
 * filter(x, y, z) limits which source vertices participate.
 */
export function makePointCloudSdf(geo, { cell = 0.025, maxDist = 0.05, filter = null } = {}) {
  const p = geo.attributes.position, nr = geo.attributes.normal;
  const inv = 1 / cell, grid = new Map();
  const key = (i, j, k) => (i + 512) * 1048576 + (j + 512) * 1024 + (k + 512);
  const X = [], Y = [], Z = [], NX = [], NY = [], NZ = [];
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    if (filter && !filter(x, y, z)) continue;
    const id = X.length;
    X.push(x); Y.push(y); Z.push(z);
    if (nr) { NX.push(nr.getX(v)); NY.push(nr.getY(v)); NZ.push(nr.getZ(v)); } else { NX.push(0); NY.push(0); NZ.push(0); }
    const kk = key(Math.floor(x * inv), Math.floor(y * inv), Math.floor(z * inv));
    let a = grid.get(kk); if (!a) grid.set(kk, (a = [])); a.push(id);
  }
  const R = Math.ceil(maxDist * inv);
  return (x, y, z) => {
    const ci = Math.floor(x * inv), cj = Math.floor(y * inv), ck = Math.floor(z * inv);
    let best = maxDist * maxDist, bi = -1;
    for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) for (let c = -R; c <= R; c++) {
      const list = grid.get(key(ci + a, cj + b, ck + c));
      if (!list) continue;
      for (const id of list) {
        const dx = x - X[id], dy = y - Y[id], dz = z - Z[id], d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; bi = id; }
      }
    }
    if (bi < 0) return maxDist;
    const d = Math.sqrt(best);
    const s = (x - X[bi]) * NX[bi] + (y - Y[bi]) * NY[bi] + (z - Z[bi]) * NZ[bi];
    return s >= 0 ? d : -d;
  };
}

/**
 * Smooth signed distance to a mesh from its vertices + normals, splatted onto a regular grid and sampled
 * trilinearly. Each source vertex adds a Wendland-weighted point-to-plane distance to the grid nodes within
 * radius R, so the field is smooth at the scale of R (no nearest-vertex facets: shrink-wrapped cloth stays
 * smooth and its normals stay clean). Far from the source (no weight) returns +far.
 * Cost: one splat per source vertex (~(2R/cell)^3 nodes), then O(1) per query.
 */
export function makeSplatSdf(geo, { bmin, bmax, cell = 0.0125, R = 0.026, far = 0.05, filter = null } = {}) {
  const p = geo.attributes.position, nr = geo.attributes.normal;
  const pa = p.array, na = nr.array, stride = p.isInterleavedBufferAttribute ? p.data.stride : 3;
  const ox = bmin[0], oy = bmin[1], oz = bmin[2], inv = 1 / cell;
  const nx = Math.ceil((bmax[0] - ox) * inv) + 2, ny = Math.ceil((bmax[1] - oy) * inv) + 2, nz = Math.ceil((bmax[2] - oz) * inv) + 2;
  const nxy = nx * ny;
  const SW = new Float32Array(nx * ny * nz), SD = new Float32Array(nx * ny * nz);
  const R2 = R * R, rc = Math.ceil(R * inv);
  for (let v = 0; v < p.count; v++) {
    const x = pa[v * stride], y = pa[v * stride + 1], z = pa[v * stride + 2];
    if (x < bmin[0] - R || x > bmax[0] + R || y < bmin[1] - R || y > bmax[1] + R || z < bmin[2] - R || z > bmax[2] + R) continue;
    if (filter && !filter(x, y, z)) continue;
    const vx = na[v * 3], vy = na[v * 3 + 1], vz = na[v * 3 + 2];
    const ci = Math.round((x - ox) * inv), cj = Math.round((y - oy) * inv), ck = Math.round((z - oz) * inv);
    for (let k = Math.max(0, ck - rc); k <= Math.min(nz - 1, ck + rc); k++) {
      const gz = oz + k * cell - z;
      for (let j = Math.max(0, cj - rc); j <= Math.min(ny - 1, cj + rc); j++) {
        const gy = oy + j * cell - y;
        for (let i = Math.max(0, ci - rc); i <= Math.min(nx - 1, ci + rc); i++) {
          const gx = ox + i * cell - x;
          const d2 = gx * gx + gy * gy + gz * gz;
          if (d2 >= R2) continue;
          const q = 1 - Math.sqrt(d2) / R, w = q * q * q * q * (4 * (1 - q) + 1);   // Wendland C2
          const o = i + nx * j + nxy * k;
          SW[o] += w; SD[o] += w * (gx * vx + gy * vy + gz * vz);
        }
      }
    }
  }
  const w0 = 0.02;
  for (let o = 0; o < SW.length; o++) SD[o] = (SD[o] + w0 * far) / (SW[o] + w0);
  return (x, y, z) => {
    let fx = (x - ox) * inv, fy = (y - oy) * inv, fz = (z - oz) * inv;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return far;
    const i = fx | 0, j = fy | 0, k = fz | 0;
    fx -= i; fy -= j; fz -= k;
    const o = i + nx * j + nxy * k;
    const c00 = SD[o] + (SD[o + 1] - SD[o]) * fx, c10 = SD[o + nx] + (SD[o + nx + 1] - SD[o + nx]) * fx;
    const c01 = SD[o + nxy] + (SD[o + nxy + 1] - SD[o + nxy]) * fx, c11 = SD[o + nxy + nx] + (SD[o + nxy + nx + 1] - SD[o + nxy + nx]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    return c0 + (c1 - c0) * fz;
  };
}

/**
 * Clean normals for an SDF-built surface: normalize(wSdf * grad f (central differences at `e`, i.e. a
 * slightly blurred gradient) + (1 - wSdf) * mesh normal), then `passes` Laplacian passes over the topology.
 * Kills the lumpy Surface-Nets / re-projection normals that break toon terminators into islands.
 */
export function smoothSurfaceNormals(m, f, neighbors, { e = 0.006, wSdf = 0.7, passes = 3, meshNormals = null } = {}) {
  const n = vcount(m), N = new Float32Array(n * 3), Nm = meshNormals || vertexNormals(m), g = [0, 0, 0], P = m.P;
  for (let i = 0; i < n; i++) {
    gradient(f, P[3 * i], P[3 * i + 1], P[3 * i + 2], e, g);
    const l = Math.hypot(g[0], g[1], g[2]);
    if (l > 1e-9 && g[0] * Nm[3 * i] + g[1] * Nm[3 * i + 1] + g[2] * Nm[3 * i + 2] > 0) {
      for (let c = 0; c < 3; c++) N[3 * i + c] = (g[c] / l) * wSdf + Nm[3 * i + c] * (1 - wSdf);
    } else for (let c = 0; c < 3; c++) N[3 * i + c] = Nm[3 * i + c];
  }
  const tmp = new Float32Array(n * 3);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const nb = neighbors[i];
      let sx = N[3 * i], sy = N[3 * i + 1], sz = N[3 * i + 2];
      for (const j of nb) { sx += N[3 * j]; sy += N[3 * j + 1]; sz += N[3 * j + 2]; }
      const l = Math.hypot(sx, sy, sz) || 1;
      tmp[3 * i] = sx / l; tmp[3 * i + 1] = sy / l; tmp[3 * i + 2] = sz / l;
    }
    N.set(tmp);
  }
  for (let i = 0; i < n; i++) { const l = Math.hypot(N[3 * i], N[3 * i + 1], N[3 * i + 2]) || 1; N[3 * i] /= l; N[3 * i + 1] /= l; N[3 * i + 2] /= l; }
  return N;
}

/** Sphere-traced inward cast: metres travelled from radius r0 along -(dx, 0, dz) at height y until f <= 0. */
export function castInward(f, dx, y, dz, r0, minStep = 0.0015) {
  let t = 0, tPrev = 0;
  for (let it = 0; it < 200 && t < r0; it++) {
    const d = f(dx * (r0 - t), y, dz * (r0 - t));
    if (d <= 0) {
      let a = tPrev, b = t;
      for (let k = 0; k < 12; k++) { const m = (a + b) / 2; if (f(dx * (r0 - m), y, dz * (r0 - m)) <= 0) b = m; else a = m; }
      return b;
    }
    tPrev = t;
    t += Math.max(d * 0.8, minStep);
  }
  return r0;
}
