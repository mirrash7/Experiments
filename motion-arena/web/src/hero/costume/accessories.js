// Accessories (WP4): sash band (double wrap, fitted to the real shirt/shorts surface) + chunky wrapped knot with a
// loop flap (QA r2 P1-4) + rest-draped soft-cloth tails (costume/ribbon.js; WP5 rewrites them in place), cloud-lobed fur cuffs
// (smooth-union sphere clusters shrink-wrapped by a parametric torus, fBm fluff, CPU back-squash),
// and strapped sandals (straps snapped to the real foot skin, QA r3 P2-6). Owner: WP4. Spec 2.6 / 2.12.

import { clamp, smoothstep, smin, mix, fbm3, rng, rayHit, gradient, loftRings, toGeometry, vcount, ellipseDist, orientOutward } from './sdf.js';
import * as THREE from 'three';
import { BLANK_UV, fixWindingByVolume } from './shirt.js';
import { ribbonLayout, writeRibbonTail, ribbonConstAttributes } from './ribbon.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** Knot share on the knot-side HipHelper (lead r1: knot / tail root sank 5.5 cm into the raised thigh in squat). */
export const KNOT_HELPER = 0.45;
/**
 * QA r2 P1-4 knot (knot-local metres: x along the band toward the hip side, y up, z out of the band surface). Art-direction
 * override of spec 2.6's small square knot: core ~0.092 W + flap -> ~0.115 total width, like the reference's bulky knot.
 */
export const KNOT_STYLE = Object.freeze({
  cx: 0.053, cy: 0.045, cz: 0.029, zc: 0.012, wx: -0.004, foldDepth: 0.007, crease: -0.42,
  wrapW: 0.030, wrapT: 0.0065,
  flapDeg: -38, flapLen: 0.084, flapW: 0.050, flapT: 0.026, flapY: -0.004, flapZ: 0.011,
  longRoot: [0.004, -0.038, 0.010], shortRoot: [0.028, -0.032, 0.003],
});
/**
 * QA r2 P1-4 tails: wide soft cloth, deep wandering folds, edge beads, twist, slanted cut. QA r3 P1-1: long tail tapers
 * 0.11 -> 0.065, fold relief ±6-8 mm in the geometry all the way down, S-bend (sBend) and +32 deg twist over the lower
 * third (twistLow) so it no longer reads as a board from 3/4 / side.
 */
export const TAIL_STYLE = Object.freeze({
  long: Object.freeze({ rings: 18, w0: 0.110, w1: 0.065, thickness: 0.0045, edge: 0.0080, cutDeg: 22, twistDeg: 8, twistLow: 32, sBend: 0.018, foldAmp: [0.0080, 0.0066], seed: 0.4 }),
  short: Object.freeze({ rings: 9, w0: 0.084, w1: 0.066, thickness: 0.0045, edge: 0.0075, cutDeg: 18, twistDeg: -18, twistLow: -8, sBend: 0.005, foldAmp: [0.0072, 0.0058], seed: 2.1 }),
  twistRelax: 0.6,   // twist scale drops to 1 - twistRelax at full collider proximity (an edge never turns into the leg)
  curl: 4.0,   // 1/m: edge cup toward the body at full collider proximity (edge offset = curl * a^2, ~0.012 at a = 0.055)
});
const twoBoneSkin = (n, b0, b1, w1of) => { const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4); for (let v = 0; v < n; v++) { const w = w1of(v); SI[v * 4] = b0; SW[v * 4] = 1 - w; SI[v * 4 + 1] = b1; SW[v * 4 + 1] = w; } return { SI, SW }; };
const rigidSkin = (n, bone) => { const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4); for (let v = 0; v < n; v++) { SI[v * 4] = bone; SW[v * 4] = 1; } return { SI, SW }; };
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Closed rounded-rect cross-section (width w across, thickness t) with optional longitudinal folds. */
function ribbonSection(w, t, { folds = 0, foldAmp = 0, perSide = 8 } = {}) {
  const pts = []; // [across, normalOffset]
  const r = t / 2;
  for (let i = 0; i <= perSide; i++) {
    const u = i / perSide, a = -w / 2 + r + u * (w - 2 * r);
    pts.push([a, r + foldAmp * Math.sin(u * Math.PI * folds) ** 2]);
  }
  for (let k = 1; k < 4; k++) { const al = Math.PI / 2 - (k / 4) * Math.PI; pts.push([w / 2 - r + Math.cos(al) * r, Math.sin(al) * r]); }
  for (let i = perSide; i >= 0; i--) {
    const u = i / perSide, a = -w / 2 + r + u * (w - 2 * r);
    pts.push([a, -r + foldAmp * Math.sin(u * Math.PI * folds) ** 2]);
  }
  for (let k = 1; k < 4; k++) { const al = -Math.PI / 2 - (k / 4) * Math.PI; pts.push([-w / 2 + r + Math.cos(al) * r, Math.sin(al) * r]); }
  return pts;
}

// --------------------------------------------------------------------------------------------- sash
/**
 * surfR(theta, y): outer radius of the garments under the sash along direction (sin theta, 0, cos theta).
 * Returns { geometry (band + knot), tails: { geometry, long, short }, knot frame, ... }.
 */
export function buildSash(ctx, { surfR, collide }) {
  const { dims, rig, palette } = ctx;
  const SA = dims.SASH, MAT = palette.MAT;
  const bi = rig.boneIndex;
  const yc = (th) => SA.frontY + (SA.backY - SA.frontY) * (1 - Math.cos(th)) / 2;
  const knotTh = SA.knot.yawDeg * DEG;
  const NT = 40;   // QA r2 P1-5 tri headroom (was 48)
  const w = SA.width, tk = SA.thickness * 0.8;

  // ---- band: two wraps, each a closed section lofted around the hips
  const layers = [
    { y0: -w / 2, y1: w / 2 - 0.004, base: 0.0 },
    { y0: -w / 2 + SA.foldOffset, y1: w / 2 + 0.002, base: tk * 0.9 },
  ];
  const R0 = new Float32Array(NT), R1 = new Float32Array(NT);
  for (let i = 0; i < NT; i++) {
    const th = (i / NT) * TAU;
    // the wrap must clear the garments at every height it covers (cloth bulges between the edges)
    let rmax = 0;
    for (let k = 0; k <= 6; k++) rmax = Math.max(rmax, surfR(th, yc(th) - w / 2 - 0.004 + ((w + 0.008) * k) / 6));
    R0[i] = R1[i] = rmax + SA.offset;
  }
  // smooth the fitted radii around the loop (removes panel steps)
  for (let p = 0; p < 6; p++) for (const R of [R0, R1]) {
    const c = R.slice();
    for (let i = 0; i < NT; i++) R[i] = Math.max(c[i], 0.25 * c[(i + NT - 1) % NT] + 0.5 * c[i] + 0.25 * c[(i + 1) % NT]);
  }
  const bandGeos = [];
  layers.forEach((L, li) => {
    const sec = [];
    const S = 3;
    for (let k = 0; k <= S; k++) sec.push([L.y0 + ((L.y1 - L.y0) * k) / S, 0, k === 0 || k === S ? 0.35 : 0]);
    // closed loop: inner face (bottom->top), rounded top, outer face (top->bottom, bulged), rounded bottom
    const prof = [];
    for (let k = 0; k <= S; k++) prof.push([sec[k][0], 0, 1]);
    prof.push([L.y1 + tk * 0.45, tk * 0.5, 0]);
    for (let k = S; k >= 0; k--) { const u = k / S; prof.push([sec[k][0], tk + 0.0022 * Math.sin(u * Math.PI), 0]); }
    prof.push([L.y0 - tk * 0.45, tk * 0.5, 0]);
    const rings = [];
    for (let i = 0; i < NT; i++) {
      const th = (i / NT) * TAU;
      const dx = Math.sin(th), dz = Math.cos(th);
      const near = Math.exp(-((Math.atan2(Math.sin(th - knotTh), Math.cos(th - knotTh))) ** 2) / 0.35);
      const ring = [];
      for (const [dy, dr] of prof) {
        const t = (dy - L.y0) / (L.y1 - L.y0);
        const rr = mix(R0[i], R1[i], clamp((dy + w / 2) / w, -0.2, 1.2)) + L.base + dr;
        // gathers: radial waves that bunch toward the knot, slight vertical pinch near it
        const gather = (0.0012 + 0.0022 * near) * Math.sin(th * 9 + t * 2.4 + li * 1.7);
        const pinch = near * 0.010 * (t - 0.5);
        ring.push([dx * (rr + gather), yc(th) + dy - pinch, dz * (rr + gather)]);
      }
      rings.push(ring);
    }
    const lo = loftRings(rings, { closedPath: true });
    fixWindingByVolume(lo.m);
    const n = vcount(lo.m);
    // near the knot the band follows the knot-side HipHelper a little, so the knot can ride up with the thigh
    const knotHelper = Math.sin(knotTh) >= 0 ? bi.leftHipHelper : bi.rightHipHelper;
    const sk = twoBoneSkin(n, bi.hips, knotHelper, (v) => { const th = (lo.ringOf[v] / NT) * TAU; return KNOT_HELPER * 0.6 * Math.exp(-((Math.atan2(Math.sin(th - knotTh), Math.cos(th - knotTh))) ** 2) / 0.12); });
    bandGeos.push(toGeometry(lo.m, {
      ...sk, uv: () => BLANK_UV, matId: () => MAT.SASH,
      shadeBias: (v) => {
        const k = lo.idxIn[v], y = lo.m.P[3 * v + 1], th = (lo.ringOf[v] / NT) * TAU;
        if (k <= S) return -0.3;                                     // inner face
        // crease shadow on the lower wrap just under the outer wrap's edge
        if (li === 0) { const dy = y - yc(th); return -0.32 * smoothstep(-w / 2 + SA.foldOffset + 0.004, -w / 2 + SA.foldOffset - 0.002, dy) * smoothstep(-w / 2 - 0.01, -w / 2 + 0.004, dy); }
        return 0;
      },
    }));
  });

  // ---- knot (QA r2 P1-4): a chunky wrapped knot like the reference, not a small square pad. Everything is authored in
  // a knot-local frame (x along the band toward the hip side, y up, z out of the band surface) and bent around the
  // fitted band, so it hugs the hips: a bunched "bow-tie" core pinched at a vertical wrap, diagonal fabric folds
  // radiating from the wrap, the wrap band itself, and one short loop flap toward the hip side. Rigid on hips /
  // knot-side HipHelper (KNOT_HELPER) and slid around the band with hip flexion by costume/index.js.
  const bandR = (th) => {                                        // band outer radius at angle th (interpolated)
    const f = ((th / TAU) * NT % NT + NT) % NT, i = Math.floor(f), t = f - i;
    return R0[i] * (1 - t) + R0[(i + 1) % NT] * t + 2 * tk;
  };
  const Rk = bandR(knotTh), yk = yc(knotTh);
  const toWorld = (x, y, z) => { const th = knotTh + x / Rk, r = bandR(th) + z; return [Math.sin(th) * r, yc(th) + y, Math.cos(th) * r]; };
  const out = [Math.sin(knotTh), 0, Math.cos(knotTh)], up = [0, 1, 0], tan = [Math.cos(knotTh), 0, -Math.sin(knotTh)];
  const K = KNOT_STYLE;
  const kc = toWorld(0, 0, K.zc);
  const sp = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
  /** Closed blob from rings over v (back -> front) of segU points; surf(u, v) -> [x, y, z, crease]. */
  const blob = (segU, segV, surf) => {
    const rings = [], cre = [];
    for (let j = 1; j < segV; j++) {
      const v = -Math.PI / 2 + (j / segV) * Math.PI, ring = [];
      for (let i = 0; i < segU; i++) { const s = surf(-Math.PI + (i / segU) * TAU, v); ring.push(toWorld(s[0], s[1], s[2])); cre.push(s[3]); }
      rings.push(ring);
    }
    const lo = loftRings(rings, { capStart: true, capEnd: true });
    fixWindingByVolume(lo.m);
    return { m: lo.m, crease: (vi) => (lo.idxIn[vi] < 0 ? 0 : cre[lo.ringOf[vi] * segU + lo.idxIn[vi]]) };
  };
  // core: bunched bow-tie, pinched where the wrap passes, folds on the outer face
  const core = blob(22, 12, (u, v) => {
    const cv = Math.cos(v), sv = Math.sin(v);
    let x = K.cx * sp(cv, 0.75) * sp(Math.cos(u), 0.7);
    let y = K.cy * sp(cv, 0.75) * sp(Math.sin(u), 0.7);
    let z = K.cz * sp(sv, 0.8);
    const waist = Math.exp(-(((x - K.wx) / 0.017) ** 2));
    y *= 1 - 0.24 * waist;
    const front = smoothstep(-0.25, 0.55, sv);
    if (z > 0) z *= 1 - 0.14 * waist;
    const side = Math.sign(x - K.wx) || 1;
    const fold = Math.sin((Math.abs(x - K.wx) / K.cx) * 7.5 + (y / K.cy) * 2.4 * side + 0.9);
    z += K.foldDepth * fold * front * (1 - waist);
    y += 0.0025 * fold * (1 - front) * Math.sign(y);
    return [x, y, K.zc + z, clamp(0.85 * waist * front + Math.max(0, -fold) * front * 0.8, 0, 1)];
  });
  // wrap: the band passing vertically around the waist (open arc with caps, its back half tucks into the band)
  const wrapRings = [], wrapSec = ribbonSection(K.wrapW, K.wrapT, { perSide: 2 });
  const NW = 9;
  for (let j = 0; j < NW; j++) {
    const ph = -1.85 + (j / (NW - 1)) * 3.7;                        // angle in the (z, y) plane, 0 = straight out
    const ay = K.cy * 0.76 + 0.004, az = K.cz * 0.86 + 0.0035;
    const y = ay * sp(Math.sin(ph), 0.8), z = K.zc + az * sp(Math.cos(ph), 0.8);
    let ny = Math.sin(ph) / ay, nz = Math.cos(ph) / az; const nl = Math.hypot(ny, nz); ny /= nl; nz /= nl;
    const bulge = 0.0018 * Math.cos(ph * 2.0);
    wrapRings.push(wrapSec.map(([a, b]) => toWorld(K.wx + a * (1 + 0.12 * Math.cos(ph)), y + ny * (b + K.wrapT / 2 + bulge), z + nz * (b + K.wrapT / 2 + bulge))));
  }
  const wrapLo = loftRings(wrapRings, { capStart: true, capEnd: true });
  fixWindingByVolume(wrapLo.m);
  // loop flap toward the hip side, a folded loop: pinched at the wrap, crease along its middle
  const fa = K.flapDeg * DEG, fd = [Math.cos(fa), Math.sin(fa)], fp = [-fd[1], fd[0]];
  const flap = blob(16, 10, (u, v) => {
    const cv = Math.cos(v), sv = Math.sin(v);
    const s = sp(cv, 0.7) * sp(Math.cos(u), 0.65), w = sp(cv, 0.7) * sp(Math.sin(u), 0.65);
    const along = (s + 1) / 2;                                       // 0 root .. 1 tip
    const pinch = 0.45 + 0.55 * smoothstep(0, 0.45, along);
    const crease = Math.exp(-((w / 0.32) ** 2));
    const L = K.flapLen, hw = K.flapW / 2 * pinch, hz = K.flapT / 2 * pinch * (sv > 0 ? 1 - 0.4 * crease : 1);
    const x = K.wx + fd[0] * along * L + fp[0] * w * hw, y = K.flapY + fd[1] * along * L + fp[1] * w * hw;
    return [x, y, K.zc + K.flapZ + hz * sp(sv, 0.8) - 0.006 * along * along, sv > 0 ? 0.9 * crease * smoothstep(0.1, 0.4, along) : 0.3];
  });
  const kHelperIdx = Math.sin(knotTh) >= 0 ? bi.leftHipHelper : bi.rightHipHelper;
  const knotGeos = [];
  for (const [m, cr, extra] of [[core.m, core.crease, 0], [wrapLo.m, (vi) => (wrapLo.idxIn[vi] >= 0 && (wrapLo.idxIn[vi] % 6 === 0) ? 0.5 : 0), 0.02], [flap.m, flap.crease, 0]]) {
    const n = vcount(m);
    knotGeos.push(toGeometry(m, {
      ...twoBoneSkin(n, bi.hips, kHelperIdx, () => KNOT_HELPER), uv: () => BLANK_UV, matId: () => MAT.SASH,
      shadeBias: (v) => clamp(K.crease * cr(v) + extra, -0.5, 0.5),
    }));
  }

  // ---- tails: draped polylines (rest), ribbon geometry
  const drape = (start, length, rings, clearance, sideDrift) => {
    const pts = [start.slice()];
    const step = 0.004;
    let p = start.slice(), acc = 0;
    const g = [0, 0, 0];
    let guard = 0;
    while (acc < length && guard++ < 2000) {
      let q = [p[0] + sideDrift[0] * step, p[1] - step, p[2] + sideDrift[2] * step];
      for (let it = 0; it < 6; it++) {
        const d = collide(q[0], q[1], q[2]);
        if (d >= clearance) break;
        gradient(collide, q[0], q[1], q[2], 2e-4, g);
        const gl = Math.hypot(g[0], g[1], g[2]) || 1;
        q = add(q, [g[0] / gl, 0, g[2] / gl], clearance - d + 0.0005);
      }
      acc += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      p = q; pts.push(p.slice());
    }
    // relax kinks (cloth drapes in smooth curves), re-applying the collision push after each pass
    for (let pass = 0; pass < 12; pass++) {
      for (let i = 1; i < pts.length - 1; i++) for (let k = 0; k < 3; k += 2) pts[i][k] = pts[i][k] * 0.5 + (pts[i - 1][k] + pts[i + 1][k]) * 0.25;
      for (let i = 1; i < pts.length; i++) {
        const q = pts[i];
        for (let it = 0; it < 4; it++) {
          const d = collide(q[0], q[1], q[2]);
          if (d >= clearance) break;
          gradient(collide, q[0], q[1], q[2], 2e-4, g);
          const gl = Math.hypot(g[0], g[2]) || 1;
          q[0] += (g[0] / gl) * (clearance - d + 0.0005); q[2] += (g[2] / gl) * (clearance - d + 0.0005);
        }
      }
    }
    // resample to `rings` points by arc length
    const L = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
    const tot = L[L.length - 1], res = [];
    for (let r = 0; r < rings; r++) {
      const s = (tot * r) / (rings - 1);
      let j = 1; while (j < L.length - 1 && L[j] < s) j++;
      const t = clamp((s - L[j - 1]) / Math.max(L[j] - L[j - 1], 1e-9), 0, 1);
      res.push([0, 1, 2].map((k) => pts[j - 1][k] + (pts[j][k] - pts[j - 1][k]) * t));
    }
    return res;
  };
  const LT = SA.longTail, ST = SA.shortTail, TS = TAIL_STYLE;
  const lStart = toWorld(K.longRoot[0], K.longRoot[1], K.longRoot[2]);
  const sStart = toWorld(K.shortRoot[0], K.shortRoot[1], K.shortRoot[2]);
  const longPts = drape(lStart, LT.length, TS.long.rings, 0.018, [0.08, 0, 0.0]);
  const shortPts = drape(sStart, ST.length, TS.short.rings, 0.026, [0.15, 0, -0.1]);
  // one layout shared with the dynamic driver (dynamics/sashRibbon.js rewrites the same vertices every frame)
  const layout = ribbonLayout([TS.long, TS.short], { crease: dims.SHADING.shadeBias.crease });
  const consts = ribbonConstAttributes(layout, { matId: MAT.SASH, outlineWidth: dims.OUTLINE.width.sashTail });
  const pos = new Float32Array(layout.nv * 3), nrm = new Float32Array(layout.nv * 3), onrm = new Float32Array(layout.nv * 3);
  const ringOfV = new Float32Array(layout.nv);                    // 0..1 along the tail, for the static skin
  [longPts, shortPts].forEach((pts, ti) => {
    const t = layout.tails[ti], n = pts.length;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), curl = new Float32Array(n), twK = new Float32Array(n);
    const gc = [0, 0, 0];
    pts.forEach((p, i) => {
      const s = i / (n - 1);
      P.set(p, i * 3);
      gradient(collide, p[0], p[1], p[2], 2e-4, gc);
      const nn = norm([gc[0], 0, gc[2]]), b = smoothstep(0.0, 0.15, s);
      N.set(norm([mix(out[0], nn[0], b), 0, mix(out[2], nn[2], b)]), i * 3);
      const prox = 1 - smoothstep(0.02, 0.09, collide(p[0], p[1], p[2]));
      curl[i] = TS.curl * prox * b; twK[i] = 1 - TS.twistRelax * prox;
    });
    writeRibbonTail(layout, t, P, N, n, curl, twK, { x: out[0], y: out[1], z: out[2] }, { pos, nrm, onrm }, 0);
    for (let r = 0; r < t.R; r++) for (let k = 0; k < layout.S; k++) ringOfV[t.side0 + r * layout.S + k] = r / (t.R - 1);
    for (let k = 0; k <= layout.S; k++) { ringOfV[t.cap0 + k] = 0; ringOfV[t.cap1 + k] = 1; }
  });
  const si = new Uint16Array(layout.nv * 4), sw = new Float32Array(layout.nv * 4);
  for (let v = 0; v < layout.nv; v++) {
    const s = ringOfV[v], a = 0.45 * Math.pow(s, 1.1), g = KNOT_HELPER * (1 - s);   // root rides with the knot
    const ws = [[bi.hips, (1 - a) * (1 - a) * (1 - g)], [kHelperIdx, 2 * a * (1 - a) * (1 - g) + g], [Math.sin(knotTh) >= 0 ? bi.leftThigh : bi.rightThigh, a * a * (1 - g)]];
    ws.forEach(([b, wv], c) => { si[v * 4 + c] = b; sw[v * 4 + c] = wv; });
  }
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tailGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  tailGeo.setAttribute('uv', new THREE.BufferAttribute(consts.uv, 2));
  tailGeo.setAttribute('matId', new THREE.BufferAttribute(consts.mat, 1));
  tailGeo.setAttribute('shadeBias', new THREE.BufferAttribute(Float32Array.from(consts.bias), 1));
  tailGeo.setAttribute('outlineWidth', new THREE.BufferAttribute(consts.ow, 1));
  tailGeo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  tailGeo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  tailGeo.setIndex(new THREE.BufferAttribute(Uint32Array.from(layout.index), 1));
  tailGeo.userData.restOutlineNormal = onrm;
  const tailInfo = (pts, st, len) => ({ restPoints: pts, w0: st.w0, w1: st.w1, cutDeg: st.cutDeg, length: len, thickness: st.thickness });
  return {
    geometries: bandGeos, knotGeometries: knotGeos, tailGeometries: [tailGeo], ribbonLayout: layout,
    knot: { position: kc, tangent: tan, up, out },
    longTail: tailInfo(longPts, TS.long, LT.length),
    shortTail: tailInfo(shortPts, TS.short, ST.length),
    bandRadius: { R0, R1, yc },
  };
}

// --------------------------------------------------------------------------------------------- fur cuffs
/**
 * Cloud-lobed fur cuff around one shorts hem (QA r1 P0-10: no "lifesaver"). The cross-section is not a thin
 * torus around the hem rim but a fur bank that fills the whole leg opening, from just off the thigh skin to a
 * slim 0.016 lip outside the rim, extended axially (hangs toward the knee): seen end-on (high knee / front kick)
 * there is no hole and no clean ring, only lumps meeting the leg. Lumps: an outer row, a lower hanging row, an
 * inner fill row, plus random tufts; all irregular in size and placement. The inward face is in the deep tone.
 * rimAt(a) -> { cx, cz, r, nx, nz } hem ellipse point at angle a (0 = front); skinAt(a) -> thigh skin radius.
 * Returns { geometry, meta (squash centre + back weight per vertex), boneName }.
 */
export function buildFurCuff(ctx, { sd, legX, y, rimAt, skinAt = null, seed = 7 }) {
  const { dims, rig, palette } = ctx;
  const F = dims.FUR;
  const rand = rng(seed + (sd > 0 ? 0 : 101));
  const skin = skinAt || (() => dims.SHORTS.thighRAtHem);
  const ax = sd * legX;
  const LIP = 0.016, TOP = 0.012, BOTTOM = 0.034;                         // radial lip outside the rim; axial extent
  const sideF = (a) => mix(0.75, 1.0, smoothstep(-0.35, 0.6, Math.sin(a)));  // a little thinner on the inner side
  const sec = (a) => {                                                    // per-angle cross-section frame
    const rm = rimAt(a), ux = sd * Math.sin(a), uz = Math.cos(a);
    const rIn = Math.min(skin(a) + 0.003, rm.r - 0.02), rOut = rm.r + LIP * sideF(a);
    return { ux, uz, rIn, rOut, rRim: rm.r };
  };
  const lobes = [];
  const add = (a, s, yy, r) => lobes.push({ a, s, y: yy, r, x: ax + sd * Math.sin(a) * s, z: Math.cos(a) * s });
  const NO = F.lobes - 2;
  for (let i = 0; i < NO; i++) {                                          // outer row (silhouette lip), some tufts proud
    const a = ((i + (rand() - 0.5) * 0.5) / NO) * TAU, c = sec(a), sf = sideF(a);
    const r = mix(0.013, 0.024, rand()) * sf;
    add(a, c.rOut - r * mix(0.65, 1.0, rand()), y + (rand() - 0.65) * 0.012, r);
  }
  for (let i = 0; i < NO; i++) {                                          // lower row, hangs toward the knee
    const a = ((i + 0.5 + (rand() - 0.5) * 0.55) / NO) * TAU, c = sec(a), sf = sideF(a);
    const r = mix(0.015, 0.023, rand()) * sf;
    add(a, c.rOut - r * mix(1.0, 1.45, rand()), y - BOTTOM + r * mix(0.85, 1.15, rand()), r);
  }
  const NIN = 11;
  for (let i = 0; i < NIN; i++) {                                         // inner fill row: overlaps the thigh, so the
    const a = ((i + (rand() - 0.5) * 0.6) / NIN) * TAU, c = sec(a);       // opening's inner edge is an irregular lump line
    const r = Math.min(mix(0.015, 0.024, rand()), (c.rRim - c.rIn) / 2 + 0.006);
    add(a, c.rIn + r * mix(0.55, 0.85, rand()), y - 0.012 + (rand() - 0.5) * 0.014, r);
  }
  for (let i = 0; i < 12; i++) {                                          // random tufts break any regular ring
    const a = rand() * TAU, c = sec(a), up = rand() < 0.6;
    add(a, mix(c.rIn + 0.008, c.rOut - 0.006, rand()), up ? y + 0.001 : y - BOTTOM + 0.009, mix(0.011, 0.016, rand()));
  }
  const NA = 42, NP = 12, K = 0.0085;   // QA r2 P1-5: NA 46 -> 42
  const near = [];                                                        // candidate lobes per sample angle
  for (let j = 0; j < NA; j++) {
    const a = (j / NA) * TAU;
    near.push(lobes.filter((L) => Math.abs(Math.atan2(Math.sin(L.a - a), Math.cos(L.a - a))) < 0.75));
  }
  const P = [], meta = [], depth = [], valley = [];
  for (let j = 0; j < NA; j++) {
    const a = (j / NA) * TAU, c = sec(a);
    const sc = (c.rIn + c.rOut) / 2, yc = y - (BOTTOM - TOP) / 2;
    const as = (c.rOut - c.rIn) / 2 - 0.010, ay = (BOTTOM + TOP) / 2 - 0.011;
    const cand = near[j];
    // cloud SDF in the section plane (s radial from the leg axis, yy up); lobes are 3D spheres
    const cloud = (s, yy) => {
      const px = ax + c.ux * s, pz = c.uz * s;
      let d = ellipseDist(s - sc, yy - yc, as, ay);
      for (const L of cand) d = smin(d, Math.hypot(px - L.x, yy - L.y, pz - L.z) - L.r, K);
      return d;
    };
    for (let k = 0; k < NP; k++) {
      const phi = (k / NP) * TAU, ds = Math.cos(phi), dy = Math.sin(phi);
      // march inward from outside to the outermost crossing, then bisect
      let hi = 0.07, lo = hi;
      while (lo > 0 && cloud(sc + ds * lo, yc + dy * lo) > 0) lo -= 0.004;
      lo = Math.max(lo, 0); hi = Math.min(lo + 0.004, 0.07);
      for (let it = 0; it < 9; it++) { const md = (lo + hi) / 2; if (cloud(sc + ds * md, yc + dy * md) <= 0) lo = md; else hi = md; }
      let rho = (lo + hi) / 2;
      const s0 = sc + ds * rho, y0 = yc + dy * rho;
      rho += 0.0026 * fbm3((ax + c.ux * s0) * 48, y0 * 48, c.uz * s0 * 48, 3);
      const sF = Math.max(sc + ds * rho, c.rIn - 0.012), yF = yc + dy * rho;
      const px = ax + c.ux * sF, pz = c.uz * sF;
      P.push(px, yF, pz);
      depth.push(ds);                                                     // -1 = faces the leg (inside the opening)
      let vd = 1;                                                         // > 0 between tufts (smooth-union crease)
      const qx = ax + c.ux * s0, qz = c.uz * s0;                          // measured before the fluff noise
      for (const L of cand) vd = Math.min(vd, Math.hypot(qx - L.x, y0 - L.y, qz - L.z) - L.r);
      valley.push(vd);
      const back = smoothstep(-0.15, -0.85, Math.cos(a)) * smoothstep(0.6, -0.4, dy * 0.6 + 0.2);
      meta.push(ax + c.ux * sc, yc, c.uz * sc, back);
    }
  }
  const T = [];
  for (let j = 0; j < NA; j++) for (let k = 0; k < NP; k++) {
    const a0 = j * NP + k, a1 = j * NP + ((k + 1) % NP), b0 = ((j + 1) % NA) * NP + k, b1 = ((j + 1) % NA) * NP + ((k + 1) % NP);
    T.push(a0, b0, a1, a1, b0, b1);
  }
  const m = fixWindingByVolume({ P, T });
  const n = vcount(m);
  const bone = rig.boneIndex[sd > 0 ? 'leftThigh' : 'rightThigh'];
  const geometry = toGeometry(m, {
    ...rigidSkin(n, bone), uv: () => BLANK_UV, matId: () => palette.MAT.FUR,
    // inward face (inside the leg opening) in the deep tone, underside in shade: never a bright clean hole
    // crevices between tufts in shade (clumps read as fur, not a smooth torus), inward face (inside the leg opening)
    // in the deep tone, underside a little darker: never a bright clean ring or hole
    shadeBias: (v) => clamp(-0.26 * smoothstep(0.0008, 0.0035, valley[v]) - 0.36 * smoothstep(-0.2, -0.7, depth[v])
      + (P[3 * v + 1] < y - BOTTOM + 0.008 ? -0.08 : 0), -0.5, 0.5),
    outlineWidth: () => dims.OUTLINE.width.fur,
  });
  return { geometry, meta: Float32Array.from(meta), boneName: sd > 0 ? 'leftThigh' : 'rightThigh' };
}

// --------------------------------------------------------------------------------------------- sandals
/** Strap clearance over the real foot skin (inner face of the strap), metres. QA r3 P2-6: 1.5-2.5 mm. */
export const SANDAL_STRAP_CLEAR = Object.freeze({ min: 0.0015, target: 0.002, max: 0.0025 });

/**
 * Query surface over the real (WP2) foot skin, rest pose: the body mesh triangles of one foot. raycast(o, d) -> first hit
 * { p, n (smooth), tri, bary }; closest(p) -> { d (signed by the smooth normal), q, n, tri, bary }; weightsAt(tri, bary)
 * -> the skin influences of the hit point (barycentric blend of its 3 vertices, top 4, normalized).
 */
export function makeFootSurface(geo, sd, { yMax = 0.17 } = {}) {
  const P = geo.attributes.position.array, NA = geo.attributes.normal?.array, I = geo.index ? geo.index.array : null;
  const SI = geo.attributes.skinIndex?.array, SW = geo.attributes.skinWeight?.array;
  const nT = I ? I.length / 3 : P.length / 9, vid = (t, k) => (I ? I[t * 3 + k] : t * 3 + k);
  const tris = [];
  for (let t = 0; t < nT; t++) {
    const a = vid(t, 0), b = vid(t, 1), c = vid(t, 2);
    if (P[a * 3 + 1] > yMax || P[b * 3 + 1] > yMax || P[c * 3 + 1] > yMax) continue;
    if (Math.sign(P[a * 3] + P[b * 3] + P[c * 3]) !== sd) continue;
    tris.push(a, b, c);
  }
  const n = tris.length / 3, C = new Float32Array(n * 4);
  for (let t = 0; t < n; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    for (let k = 0; k < 3; k++) C[t * 4 + k] = (P[a * 3 + k] + P[b * 3 + k] + P[c * 3 + k]) / 3;
    let r = 0;
    for (const v of [a, b, c]) r = Math.max(r, Math.hypot(P[v * 3] - C[t * 4], P[v * 3 + 1] - C[t * 4 + 1], P[v * 3 + 2] - C[t * 4 + 2]));
    C[t * 4 + 3] = r;
  }
  const vp = (v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const smoothN = (t, w) => {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    if (!NA) return norm(cross(sub(vp(b), vp(a)), sub(vp(c), vp(a))));
    return norm([0, 1, 2].map((k) => w[0] * NA[a * 3 + k] + w[1] * NA[b * 3 + k] + w[2] * NA[c * 3 + k]));
  };
  function raycast(o, d) {
    let best = Infinity, bt = -1, bu = 0, bv = 0;
    for (let t = 0; t < n; t++) {
      const a = vp(tris[t * 3]), e1 = sub(vp(tris[t * 3 + 1]), a), e2 = sub(vp(tris[t * 3 + 2]), a);
      const p = cross(d, e2), det = dot(e1, p);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det, s = sub(o, a), u = dot(s, p) * inv;
      if (u < 0 || u > 1) continue;
      const q = cross(s, e1), v = dot(d, q) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = dot(e2, q) * inv;
      if (tt > 1e-6 && tt < best) { best = tt; bt = t; bu = u; bv = v; }
    }
    if (bt < 0) return null;
    const bary = [1 - bu - bv, bu, bv];
    return { p: add(o, d, best), n: smoothN(bt, bary), tri: bt, bary };
  }
  function closestOnTri(p, t) {   // Ericson, returns [point, bary]
    const A = vp(tris[t * 3]), B = vp(tris[t * 3 + 1]), Cc = vp(tris[t * 3 + 2]);
    const ab = sub(B, A), ac = sub(Cc, A), ap = sub(p, A), d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return [A, [1, 0, 0]];
    const bp = sub(p, B), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return [B, [0, 1, 0]];
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const w = d1 / (d1 - d3); return [add(A, ab, w), [1 - w, w, 0]]; }
    const cp = sub(p, Cc), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return [Cc, [0, 0, 1]];
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [add(A, ac, w), [1 - w, 0, w]]; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [add(B, sub(Cc, B), w), [0, 1 - w, w]]; }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return [add(add(A, ab, v), ac, w), [1 - v - w, v, w]];
  }
  function closest(p) {
    let best = Infinity, bt = -1, bq = null, bb = null;
    for (let t = 0; t < n; t++) {
      const dc = Math.hypot(p[0] - C[t * 4], p[1] - C[t * 4 + 1], p[2] - C[t * 4 + 2]) - C[t * 4 + 3];
      if (dc > best) continue;
      const [q, bary] = closestOnTri(p, t), dl = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (dl < best) { best = dl; bt = t; bq = q; bb = bary; }
    }
    if (bt < 0) return null;
    const nn = smoothN(bt, bb);
    return { d: best * (dot(sub(p, bq), nn) >= 0 ? 1 : -1), q: bq, n: nn, tri: bt, bary: bb };
  }
  function weightsAt(t, bary) {
    if (!SI) return null;
    const acc = new Map();
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      for (let c = 0; c < 4; c++) { const w = SW[v * 4 + c] * bary[k]; if (w > 0) acc.set(SI[v * 4 + c], (acc.get(SI[v * 4 + c]) || 0) + w); }
    }
    const top = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4), s = top.reduce((u, e) => u + e[1], 0) || 1;
    return top.map(([b, w]) => [b, w / s]);
  }
  /** Mid x and top y of the foot cross-section near z (from the triangle centroids). */
  function sectionAt(z, half = 0.006) {
    let x0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let t = 0; t < n; t++) if (Math.abs(C[t * 4 + 2] - z) < half && C[t * 4 + 1] < 0.1) { x0 = Math.min(x0, C[t * 4]); x1 = Math.max(x1, C[t * 4]); y1 = Math.max(y1, C[t * 4 + 1]); }
    return x0 < x1 ? { mx: (x0 + x1) / 2, top: y1 } : null;
  }
  return { raycast, closest, weightsAt, sectionAt, triCount: n };
}

/**
 * Strapped sandal (QA r3 P2-6). Sole: a bevelled slab built in separate pieces (bottom, wall, top bevel, top face) so the
 * top edge reads as one crisp line. Straps: clean bands snapped to the REAL skinned foot surface of the body mesh (rest
 * pose, makeFootSurface): each strap is a contour of rays cast at the foot, offset along the skin normal so its inner face
 * sits SANDAL_STRAP_CLEAR.target outside the skin, then every ring is pushed out until its whole section clears
 * SANDAL_STRAP_CLEAR.min. Each ring copies the skin weights of the foot point under it, so the bands ride the ankle blend
 * exactly like the skin they cover (no poke-through when the ankle flexes). Without a body the spec foot is used.
 */
export function buildSandal(ctx, sd, { foot = null, footPts = null } = {}) {
  const { dims, rig, palette } = ctx;
  const SN = dims.SANDAL, FT = dims.FOOT, J = dims.JOINT_WORLD;
  const MAT = palette.MAT;
  const CL = SANDAL_STRAP_CLEAR;
  const cx = sd * J.leftFoot[0];
  const heelZ = J.leftToe[2] - FT.length, toeZ = J.leftToe[2];
  const o = SN.outlineOffset;
  // foot half-width (skin) along z, then the sole adds the outline offset
  let halfW = (z) => {
    const t = (z - heelZ) / (toeZ - heelZ);
    const k = [[0, 0.0], [0.03, 0.020], [0.12, FT.heelWidth / 2], [0.45, FT.heelWidth / 2 + 0.006], [0.75, FT.ballWidth / 2], [0.9, FT.ballWidth / 2 - 0.004], [0.97, 0.030], [1, 0.0]];
    let i = 0; while (i < k.length - 2 && t > k[i + 1][0]) i++;
    const u = clamp((t - k[i][0]) / (k[i + 1][0] - k[i][0]), 0, 1), s = u * u * (3 - 2 * u);
    return Math.max(0, k[i][1] + (k[i + 1][1] - k[i][1]) * s);
  };
  // fit to the real foot (WP2) where it is wider than the spec foot: max |x - cx| per 5 mm z-bin near the sole
  if (footPts && footPts.length) {
    const bins = new Map();
    for (const [x, y, z] of footPts) {
      if (Math.sign(x) !== sd || y > 0.045) continue;
      const k = Math.round(z / 0.005);
      bins.set(k, Math.max(bins.get(k) || 0, Math.abs(x - cx)));
    }
    const specHalfW = halfW;
    const fitted = (z) => {
      let w = 0, n = 0;
      for (let k = -2; k <= 2; k++) { const v = bins.get(Math.round(z / 0.005) + k); if (v !== undefined) { w += v; n++; } }
      return n ? w / n : 0;
    };
    halfW = (z) => Math.max(specHalfW(z), fitted(z) * 0.98);
  }
  const ballZ = heelZ + 0.75 * (toeZ - heelZ);
  const spring = (z) => Math.max(0, z - ballZ) * Math.tan(SN.toeSpringDeg * DEG);
  const medialShift = (z) => -sd * 0.004 * smoothstep(ballZ - 0.04, toeZ, z);  // big toe side fuller
  const footBone = rig.boneIndex[sd > 0 ? 'leftFoot' : 'rightFoot'];
  const geos = [];

  // ---- sole: outline loop (top view), ellipse-capped ends
  const NZ = 18, zs = [];
  for (let i = 0; i <= NZ; i++) { const t = (1 - Math.cos((i / NZ) * Math.PI)) / 2; zs.push(heelZ - o + t * (toeZ - heelZ + 2 * o)); }
  const loop = [];
  // half widths per station, relaxed so the fitted (per-bin) foot width gives a smooth, clean outline (no saw teeth)
  const hws = zs.map((z, i) => halfW(Math.min(Math.max(z, heelZ), toeZ)) + o * Math.sin((i / NZ) * Math.PI));
  for (let pass = 0; pass < 4; pass++) { const c = hws.slice(); for (let i = 1; i < NZ; i++) hws[i] = Math.max(c[i] * 0.9, 0.5 * c[i] + 0.25 * (c[i - 1] + c[i + 1])); }
  const hw = (i) => hws[i];
  for (let i = 0; i <= NZ; i++) loop.push([cx + medialShift(zs[i]) + hw(i), zs[i]]);
  for (let i = NZ - 1; i >= 1; i--) loop.push([cx + medialShift(zs[i]) - hw(i), zs[i]]);
  // 2D outward normal of the loop (inset along it, not toward the centroid: even bevel all round)
  const ccx = loop.reduce((s, p) => s + p[0], 0) / loop.length, ccz = loop.reduce((s, p) => s + p[1], 0) / loop.length;
  const L = loop.length;
  const ln = loop.map((p, i) => {
    const a = loop[(i + L - 1) % L], b = loop[(i + 1) % L];
    let nx = b[1] - a[1], nz = -(b[0] - a[0]); const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    if (nx * (p[0] - ccx) + nz * (p[1] - ccz) < 0) { nx = -nx; nz = -nz; }
    return [nx, nz];
  });
  const BEV = 0.0028, TOPB = 0.0024;
  // toe spring curves the UNDERSIDE up (rocker); the footbed stays flat so it never rises into the toes (QA r3 P2-6:
  // the sprung footbed poked up between the toes as brown specks)
  const ring = (y, ins, spr) => loop.map(([x, z], i) => [x - ln[i][0] * ins, y + (spr ? spring(z) : 0), z - ln[i][1] * ins]);
  const rB0 = ring(0, BEV, true), rB1 = ring(BEV, 0, true), rT0 = ring(SN.sole - TOPB, 0, false), rT1 = ring(SN.sole, TOPB, false);
  const cIn = [ccx, SN.sole / 2, ccz];
  const solePiece = (rings, opts, bias) => {
    const lo = loftRings(rings, { closedPath: false, ...opts });
    orientOutward(lo.m, ...cIn);
    geos.push(toGeometry(lo.m, { ...rigidSkin(vcount(lo.m), footBone), uv: () => BLANK_UV, matId: () => MAT.SOLE, shadeBias: typeof bias === 'function' ? (v) => bias(lo, v) : () => bias }));
  };
  // separate pieces = split normals at each bevel edge (crisp edge lines, no smeared shading over the rim)
  solePiece([rB0, rB1], { capStart: true }, -0.2);                       // underside + lower bevel
  solePiece([rB1.map((p) => p.slice()), rT0], {}, 0);                    // side wall
  solePiece([rT0.map((p) => p.slice()), rT1], {}, 0.08);                 // top bevel (catches light: crisp rim)
  solePiece([rT1.map((p) => p.slice())], { capStart: true }, 0);         // footbed

  // ---- straps
  const topY = SN.sole;
  const strapSec = ribbonSection(SN.strapW, SN.strapT, { perSide: 2 });
  const T2 = SN.strapT / 2;
  // spec-foot fallback (no body): elliptic arch, half width a(z), height b(z) above the sole top
  const footH = (z) => {
    const t = (z - heelZ) / (toeZ - heelZ);
    const k = [[0, 0.030], [0.12, 0.052], [0.3, FT.instepHeight], [0.5, FT.instepHeight - 0.004], [0.75, 0.034], [0.9, 0.024], [1, 0.012]];
    let i = 0; while (i < k.length - 2 && t > k[i + 1][0]) i++;
    const u = clamp((t - k[i][0]) / (k[i + 1][0] - k[i][0]), 0, 1), s = u * u * (3 - 2 * u);
    return k[i][1] + (k[i + 1][1] - k[i][1]) * s;
  };
  const stats = { minClear: Infinity, maxClear: 0 };
  /**
   * rays: [{ o, d }] cast at the foot (outside -> in), in path order. Ends drop into the sole slab. The band's centre line
   * is the skin hit + n * (target clearance + half thickness).
   */
  const strap = (rays, fallback) => {
    const C = [], Nn = [], W = [];
    for (let i = 0; i < rays.length; i++) {
      const h = foot ? foot.raycast(rays[i].o, rays[i].d) : null;
      if (h) { C.push(add(h.p, h.n, CL.target + T2)); Nn.push(h.n); W.push(foot.weightsAt(h.tri, h.bary)); }
      else { const [p, nn] = fallback(i / (rays.length - 1)); const n0 = norm(nn); C.push(add(p, n0, CL.target + T2)); Nn.push(n0); W.push(null); }
    }
    // relax the centre line (ends fixed) and the normals
    for (let pass = 0; pass < 6; pass++) {
      const c2 = C.map((p) => p.slice()), n2 = Nn.map((p) => p.slice());
      for (let i = 1; i < C.length - 1; i++) for (let k = 0; k < 3; k++) { C[i][k] = c2[i][k] * 0.5 + (c2[i - 1][k] + c2[i + 1][k]) * 0.25; Nn[i][k] = n2[i][k] * 0.5 + (n2[i - 1][k] + n2[i + 1][k]) * 0.25; }
      for (let i = 0; i < Nn.length; i++) Nn[i] = norm(Nn[i]);
    }
    // anchor both ends in the sole: one more ring straight down to just under the footbed
    const drop = (p) => [p[0], Math.min(p[1], topY) - 0.003, p[2]];
    if (C[0][1] > topY + 0.001) { C.unshift(drop(C[0])); Nn.unshift(Nn[0].slice()); W.unshift('sole'); }
    const e = C.length - 1;
    if (C[e][1] > topY + 0.001) { C.push(drop(C[e])); Nn.push(Nn[e].slice()); W.push('sole'); }
    const N = C.length - 1;
    const frames = C.map((p, i) => {
      const tg = norm(add(C[Math.min(i + 1, N)], C[Math.max(i - 1, 0)], -1));
      const across = norm(cross(tg, Nn[i]));
      return { across, up: norm(cross(across, tg)) };
    });
    const ringPts = (i, lift = 0) => strapSec.map(([a, b]) => add(add(C[i], frames[i].across, a), frames[i].up, b + lift));
    // push each ring out until its whole section clears the skin (min clearance), never pulling it in
    if (foot) {
      for (let it = 0; it < 4; it++) {
        let moved = false;
        for (let i = 0; i <= N; i++) {
          if (W[i] === 'sole') continue;
          let mn = Infinity;
          for (const p of ringPts(i)) { const c = foot.closest(p); if (c) mn = Math.min(mn, c.d); }
          if (mn < CL.min + 0.0002) { C[i] = add(C[i], frames[i].up, CL.target - mn); moved = true; }
        }
        if (!moved) break;
      }
      for (let i = 0; i <= N; i++) {
        if (W[i] === 'sole') continue;
        let mn = Infinity;
        for (const p of ringPts(i)) { const c = foot.closest(p); if (c) mn = Math.min(mn, c.d); }
        stats.minClear = Math.min(stats.minClear, mn); stats.maxClear = Math.max(stats.maxClear, mn);
      }
    }
    const rings2 = C.map((_, i) => ringPts(i));
    const lo = loftRings(rings2, { capStart: true, capEnd: true });
    fixWindingByVolume(lo.m);
    const n = vcount(lo.m), SIa = new Uint16Array(n * 4), SWa = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      // per vertex: the influences of the nearest skin point (so the band shears with the skin across its width too)
      let w = W[lo.ringOf[v]];
      if (w && w !== 'sole' && foot) { const c = foot.closest([lo.m.P[3 * v], lo.m.P[3 * v + 1], lo.m.P[3 * v + 2]]); if (c) w = foot.weightsAt(c.tri, c.bary); }
      if (!w || w === 'sole') { SIa[v * 4] = footBone; SWa[v * 4] = 1; continue; }
      w.forEach(([b, wv], c) => { SIa[v * 4 + c] = b; SWa[v * 4 + c] = wv; });
    }
    // inner face (toward the skin) a touch darker: reads as a band with thickness, not a painted stripe
    const inner = (v) => { const k = lo.idxIn[v]; return k >= 0 && strapSec[k][1] < 0 ? -0.12 : 0; };
    geos.push(toGeometry(lo.m, { SI: SIa, SW: SWa, uv: () => BLANK_UV, matId: () => MAT.STRAP, shadeBias: inner }));
  };
  const NS = 13;
  // arch over the foot in the plane z = zf(t) (t 0 = lateral sole edge, 1 = medial), rays aimed at the section centre
  const arch = (zf, a0 = -0.32) => {
    const rays = [];
    for (let i = 0; i < NS; i++) {
      const t = i / (NS - 1), z = zf(t), sec = foot ? foot.sectionAt(z) : null;
      const mx = sec ? sec.mx : cx + medialShift(z);
      const ang = a0 + t * (Math.PI - 2 * a0), lat = Math.cos(ang) * sd;
      const c = [mx, topY + 0.02, z], d = [lat, Math.sin(ang), 0];
      rays.push({ o: add(c, d, 0.15), d: [-d[0], -d[1], -d[2]] });
    }
    const fb = (t) => {
      const z = zf(t), ang = t * Math.PI, a = halfW(clamp(z, heelZ, toeZ)) + 0.002, b = footH(z), lat = Math.cos(ang) * sd;
      return [[cx + medialShift(z) + lat * a, topY + spring(z) + Math.sin(ang) * b, z], [lat / a, Math.sin(ang) / b, 0]];
    };
    strap(rays, fb);
  };
  arch(() => ballZ - 0.012);                                              // toe strap (base of toes)
  arch((t) => mix(0.028, ballZ - 0.055, t));                              // diagonal instep strap toward the ankle
  // heel strap: horizontal rays around the back of the heel, rising to the ankle sides, ends dropping into the sole
  {
    const rays = [], czh = heelZ + 0.045, sec = foot ? foot.sectionAt(heelZ + 0.03) : null, hx = sec ? sec.mx : cx;
    for (let i = 0; i < NS; i++) {
      const u = (i / (NS - 1)) * 2 - 1, be = u * Math.PI * 0.6;
      const y = topY + 0.008 + (0.014 + 0.012 * Math.abs(Math.sin(be))) * (1 - smoothstep(0.72, 1.0, Math.abs(u)));
      const d = [Math.sin(be), 0, -Math.cos(be)], c = [hx, y, czh];
      rays.push({ o: add(c, d, 0.15), d: [-d[0], 0, -d[2]] });
    }
    strap(rays, (t) => {
      const be = (t - 0.5) * Math.PI * 1.15, rx = FT.heelWidth / 2 + 0.006, rz = 0.05;
      return [[cx + Math.sin(be) * rx, topY + 0.020 + 0.016 * Math.abs(Math.sin(be)), czh - Math.cos(be) * rz], [Math.sin(be) / rx, 0, -Math.cos(be) / rz]];
    });
  }
  geos.strapClearance = stats;
  return geos;
}

/** Collider definitions for WP5 (bone-local). */
export function colliderDefs(dims, shorts) {
  const J = dims.JOINT_WORLD, L = dims.LENGTHS;
  const hipsY = J.hips[1];
  return {
    hips: { type: 'ellipsoid', bone: 'hips', center: [0, 0.905 - hipsY, -0.005], radii: [dims.BODY.pelvisShorts.w / 2 + 0.01, 0.11, dims.BODY.pelvisShorts.d / 2 + 0.01] },
    thighs: ['left', 'right'].map((s) => ({ type: 'capsule', bone: `${s}Thigh`, a: [0, 0, 0], b: [0, -(J.leftThigh[1] - shorts.hemY), 0], r0: 0.112, r1: dims.SHORTS.openingR, skinR: dims.DYNAMICS.sash.thighR })),
    furCuffs: ['left', 'right'].map((s) => ({ type: 'torus', bone: `${s}Thigh`, center: [0, -(J.leftThigh[1] - shorts.hemY), 0], ringR: dims.FUR.ringR, tubeR: dims.FUR.tubeR + 0.006 })),
    shins: ['left', 'right'].map((s) => ({ type: 'capsule', bone: `${s}Shin`, a: [0, 0, 0], b: [0, -L.shin, 0], r0: 0.056, r1: 0.034 })),
  };
}

