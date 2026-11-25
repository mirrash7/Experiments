// Shorts (WP4): one continuous skinned SDF shell (pelvis loft smooth-union two baggy asymmetric leg tubes,
// k = 0.05), crotch arch carved so the legs read separately, Surface Nets, exact cuts (waist under the
// sash, hems), thickness + rims, rolled double cuff band, painted denim detail. Weights blend
// hips -> HipHelper -> thigh (quadratic Bernstein) so a squat / high knee keeps volume. Owner: WP4.

import {
  clamp, smoothstep, smin, smax, monotone, ellipseDist, makeTube, surfaceNets, clipMesh, smoothMesh,
  thicken, topology, vertexNormals, removeSmallComponents, garmentWeights, packWeights, toGeometry, vcount,
  loftRings, boundaryDistance, lap, gridAxis, smoothSurfaceNormals,
} from './sdf.js';
import { BLANK_UV, fixWindingByVolume } from './shirt.js';

export const SHORTS_ATLAS = { pelvis: [0, 0.5, 0.5, 0.4], legL: [0.5, 0.5, 0.25, 0.4], legR: [0.75, 0.5, 0.25, 0.4], roll: [0.25, 0.905, 0.6, 0.07] };
/** QA r1 P1-4: roll band proud of the leg (spec dims.SHORTS.roll.proud is 0.008; REQUEST(WP0) -> 0.010). */
const ROLL_PROUD = 0.010;
/** Extraction voxel (m) and inner-shell band from the hem (m). */
const VOXEL = 0.025, INNER_BAND = 0.028;
const TAU = Math.PI * 2;

export function shortsShape(dims) {
  const SH = dims.SHORTS, SA = dims.SASH, J = dims.JOINT_WORLD;
  const legX = J.leftThigh[0], hipY = J.leftThigh[1];
  const hemY = SH.hemY;
  const topFront = SA.frontY + SA.width / 2 - 0.010, topBack = SA.backY + SA.width / 2 - 0.004;
  const topY = (th) => topFront + (topBack - topFront) * (1 - Math.cos(th)) / 2;  // th from front
  const crotchY = 0.765, gapHalf = 0.009;
  const legRegionY = 0.78;
  return { legX, hipY, hemY, topY, crotchY, gapHalf, legRegionY };
}

/** Outer shorts SDF (no cuts). Also returns leg cross-section radii at y for the cuff / fur fit. */
export function makeShortsSdf(dims, s) {
  const SH = dims.SHORTS, P = dims.BODY.pelvisShorts;
  // QA r1 P0-7: hip silhouette 0.40 -> 0.34 W. The pelvis loft carries the hip width; the leg tubes taper in at
  // the top (so their smooth union no longer widens the hips) and keep the baggy 0.105 opening at the hem.
  const pelvisRx = monotone([[0.78, 0.128], [0.84, 0.148], [0.90, P.w / 2 - 0.012], [0.95, 0.150], [1.02, 0.146]]);
  const pelvisRz = monotone([[0.78, 0.098], [0.84, 0.110], [0.90, P.d / 2 - 0.006], [0.95, 0.108], [1.02, 0.104]]);
  const pelvisCz = monotone([[0.78, -0.012], [0.86, -0.006], [0.95, 0.0]]);
  const rOut = monotone([[s.hemY, SH.openingR], [0.66, 0.100], [0.76, 0.088], [0.84, 0.074], [0.92, 0.066]]);
  const rIn = monotone([[s.hemY, 0.068], [0.70, 0.079], [0.78, 0.086], [0.90, 0.095]]);
  const rZ = monotone([[s.hemY, 0.100], [0.70, 0.104], [0.90, 0.112]]);
  const legTop = 0.92, legBot = s.hemY - 0.03;
  const leg = (side) => makeTube({
    a: [side * s.legX, legTop, 0], b: [side * s.legX, legBot, 0], up: [side, 0, 0],
    radius: (t) => { const y = legTop + (legBot - legTop) * t; return [rOut(y), rIn(y), rZ(y)]; },
    capA: true, capB: true,
  });
  const lL = leg(1), lR = leg(-1);
  const pelvis = (x, y, z) => Math.max(ellipseDist(x, z - pelvisCz(y), pelvisRx(y), pelvisRz(y)), 0.80 - y, y - 1.05);
  const sdf = (x, y, z) => {
    let d = smin(pelvis(x, y, z), Math.min(lL(x, y, z), lR(x, y, z)), SH.sdfK);
    const sep = Math.max(Math.abs(x) - s.gapHalf, y - s.crotchY);
    d = smax(d, -sep, 0.012);
    return d;
  };
  return { sdf, rOut, rIn, rZ };
}

export function buildShorts(ctx, { bodyGeo, shape, sdfInfo }) {
  const { dims, rig, palette } = ctx;
  const { MAT } = palette;
  const s = shape, { sdf, rOut, rIn, rZ } = sdfInfo;
  const grid = { xs: gridAxis(-0.26, 0.26, VOXEL, true), ys: gridAxis(s.hemY - 0.03, 1.06, VOXEL), zs: gridAxis(-0.17, 0.17, VOXEL * 0.95) };
  let m = surfaceNets(sdf, null, null, grid);
  lap('shorts.nets');
  const cutTop = (x, y, z) => y - s.topY(Math.abs(Math.atan2(x, z)));
  const cutHem = (x, y) => (s.hemY - 0.002) - y;
  for (const c of [cutTop, cutHem]) m = clipMesh(m, c, { surf: sdf }).m;
  m = removeSmallComponents(m, 60);
  smoothMesh(m, { passes: 3, lambda: 0.5, boundaryLambda: 0.15, surf: sdf });
  lap('shorts.cutsmooth');
  for (const f of [(x) => x, (x) => Math.abs(x) - s.legX, (x, y) => y - s.legRegionY]) m = clipMesh(m, f, { keepBoth: true, snap: 0 }).m;

  const topo0 = topology(m);
  // crotch front and seat (QA r1 P1-3): the pelvis underside faces down into the crotch and shaded as a blob; bias its
  // normals forward / backward so only the painted/biased crease line at the gap remains
  const crotchW = (x, y, z) => smoothstep(0.05, 0.02, Math.abs(x)) * smoothstep(s.crotchY - 0.05, s.crotchY - 0.01, y) * smoothstep(s.crotchY + 0.08, s.crotchY + 0.03, y) * smoothstep(0.01, 0.05, Math.abs(z));
  const N0 = smoothSurfaceNormals(m, sdf, topo0.neighbors, { e: 0.008, wSdf: 0.7, passes: 3, meshNormals: vertexNormals(m) });
  for (let i = 0; i < vcount(m); i++) {
    const w = 0.85 * crotchW(m.P[3 * i], m.P[3 * i + 1], m.P[3 * i + 2]);
    if (w <= 0) continue;
    const fz = Math.sign(m.P[3 * i + 2]);                                // front and back (seat) alike
    const nx = N0[3 * i] * (1 - w), ny = N0[3 * i + 1] * (1 - w) - 0.2 * w, nz = N0[3 * i + 2] * (1 - w) + 0.98 * fz * w, l = Math.hypot(nx, ny, nz);
    N0[3 * i] = nx / l; N0[3 * i + 1] = ny / l; N0[3 * i + 2] = nz / l;
  }
  const bd = boundaryDistance(m, topo0);
  const th = thicken(m, 0.005, { rimSegments: 2, bulge: 0.3, normals: N0, innerMask: bd.map((d) => (d < INNER_BAND ? 1 : 0)) });
  const M = th.m, n = vcount(M), topo = topology(M);
  const Nr = vertexNormals(M), NF = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const L = th.layer[v], i = th.src[v];
    for (let c = 0; c < 3; c++) NF[3 * v + c] = L === 0 ? N0[3 * i + c] : L === 1 ? -N0[3 * i + c] : Nr[3 * v + c];
  }
  const SP = (v) => [m.P[3 * th.src[v]], m.P[3 * th.src[v] + 1], m.P[3 * th.src[v] + 2]];

  lap('shorts.thicken');
  // regions: 0/1 pelvis x>=0 / x<0 ; 2/3 legL inner/outer ; 4/5 legR inner/outer
  const triRegion = new Int32Array(M.T.length / 3);
  for (let t = 0; t < M.T.length; t += 3) {
    let x = 0, y = 0;
    for (let k = 0; k < 3; k++) { const p = SP(M.T[t + k]); x += p[0]; y += p[1]; }
    x /= 3; y /= 3;
    triRegion[t / 3] = y > s.legRegionY ? (x >= 0 ? 0 : 1) : (x >= 0 ? 2 : 4) + (Math.abs(x) >= s.legX ? 1 : 0);
  }

  // weights: transfer from the body, then the Bernstein hips -> HipHelper -> thigh blend is imposed
  const bones = ['hips', 'spine', 'leftThigh', 'rightThigh', 'leftHipHelper', 'rightHipHelper'];
  // (the imposed blend below defines every weight: no body transfer needed)
  const B = rig.boneOrder.length, bi = rig.boneIndex;
  const W = new Float32Array(n * B);
  void bones; void garmentWeights;
  for (let v = 0; v < n; v++) {
    const [x, y, z] = SP(v);
    const o = v * B;
    for (let k = 0; k < B; k++) W[o + k] = 0;
    // leg share: depends on height below the hip joint; the back (buttock) blends lower than the front
    const front = smoothstep(-0.05, 0.08, z);
    const yTop = s.hipY + 0.035 + 0.03 * front, yBot = s.hipY - 0.13 - 0.03 * (1 - front);
    const a = smoothstep(yTop, yBot, y);
    // near the crotch centre both legs share
    // near the crotch apex both legs share; below it each inner leg wall belongs to its own thigh only
    const share = smoothstep(s.crotchY - 0.035, s.crotchY + 0.005, y);
    const side = (x >= 0 ? 1 : 0) * (1 - share) + smoothstep(-0.03, 0.03, x) * share;   // 1 = left
    const ws = [[bi.hips, (1 - a) * (1 - a)]];
    const hl = 2 * a * (1 - a), tl = a * a;
    ws.push([bi.leftHipHelper, hl * side], [bi.rightHipHelper, hl * (1 - side)], [bi.leftThigh, tl * side], [bi.rightThigh, tl * (1 - side)]);
    for (const [b, w] of ws) W[o + b] += w;
  }
  // smooth the imposed weights a little across the topology
  for (let p = 0; p < 2; p++) {
    const tmp = new Float32Array(W);
    for (let v = 0; v < n; v++) {
      const nb = topo.neighbors[v]; if (!nb.length) continue;
      for (const b of [bi.hips, bi.leftHipHelper, bi.rightHipHelper, bi.leftThigh, bi.rightThigh]) {
        let sum = 0; for (const j of nb) sum += W[j * B + b];
        tmp[v * B + b] = W[v * B + b] * 0.5 + (sum / nb.length) * 0.5;
      }
    }
    W.set(tmp);
  }
  const packed = packWeights(W, B, n);
  lap('shorts.weights');

  const atlas = (rect, u, v) => [rect[0] + clamp(u, 0, 1) * rect[2], rect[1] + clamp(v, 0, 1) * rect[3]];
  const uv = (v, reg) => {
    if (th.layer[v] !== 0) return BLANK_UV;
    const [x, y, z] = SP(v);
    if (reg < 2) {
      let a = Math.atan2(x, z);
      if (Math.abs(a) > 2.8) a = reg === 0 ? Math.abs(a) : -Math.abs(a);
      return atlas(SHORTS_ATLAS.pelvis, 0.5 + a / TAU, (y - 0.75) / 0.27);
    }
    const sd = reg < 4 ? 1 : -1, outer = reg % 2 === 1;
    let psi = Math.atan2(sd * (x - sd * s.legX), z);
    if (Math.abs(psi) > 2.8) psi = outer ? Math.abs(psi) : -Math.abs(psi);
    return atlas(sd > 0 ? SHORTS_ATLAS.legL : SHORTS_ATLAS.legR, 0.5 + psi / TAU, (y - (s.hemY - 0.02)) / 0.27);
  };
  const SA = dims.SASH;
  const sashBottom = (th) => SA.frontY + (SA.backY - SA.frontY) * (1 - Math.cos(th)) / 2 - SA.width / 2;
  const geometry = toGeometry(M, {
    SI: packed.SI, SW: packed.SW, normals: NF,
    region: (t) => triRegion[t], uv,
    matId: () => MAT.SHORTS,
    shadeBias: (v) => {
      if (th.layer[v] === 1) return -0.3;
      const [x, y, z] = SP(v);
      let b = 0;
      const sb = sashBottom(Math.abs(Math.atan2(x, z)));
      b -= 0.32 * smoothstep(sb - 0.02, sb - 0.008, y);                                                                   // under the sash
      // inner thigh / crotch crease (QA r1 P1-3: half the radius, capped above the deep-tone threshold: a line, not a stain)
      b -= 0.22 * smoothstep(0.018, 0.006, Math.abs(x)) * smoothstep(0.68, 0.74, y) * smoothstep(0.80, 0.77, y);
      return b;
    },
  });

  lap('shorts.toGeo');
  const rolls = [];
  for (const sd of [1, -1]) rolls.push(buildRoll(ctx, s, rOut, rIn, rZ, sd));
  lap('shorts.rolls');
  return { geometry, rolls, triCount: M.T.length / 3 };
}

/** Roll band profile: [dy above y0, radial offset off the leg, atlas v]. Two proud rolls with a deep fold between. */
function rollProfile(R) {
  const P = ROLL_PROUD, h = R.h;
  return [
    [0, -0.004, 0.00], [0.0012, 0.0035, 0.06], [0.005, P * 0.82, 0.16], [0.0095, P, 0.26], [0.0140, P * 0.72, 0.36],
    [0.0172, P * 0.22, 0.45], [0.0200, P * 0.72, 0.54], [0.0250, P, 0.64], [0.0300, P * 0.78, 0.74], [h - 0.0012, P * 0.28, 0.84],
    [h, -0.001, 0.90], [h - 0.003, -0.006, 0.95], [0.004, -0.006, 1.0],
  ];
}

function buildRoll(ctx, s, rOut, rIn, rZ, sd) {
  const { dims, rig, palette } = ctx;
  const R = dims.SHORTS.roll;
  const y0 = s.hemY + 0.010;
  const C = 28;
  const prof = rollProfile(R);
  const rings = [];
  for (let c = 0; c < C; c++) {
    const a = (c / C) * TAU;                        // around the leg; 0 = front
    const ux = Math.sin(a), uz = Math.cos(a);      // outward = +x side for ux*sd > 0
    const ring = [];
    for (const [dy, off] of prof) {
      const y = y0 + dy;
      const rx = ux * sd >= 0 ? rOut(y) : rIn(y), rz = rZ(y);
      const r = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uz * uz) / (rz * rz));
      ring.push([sd * s.legX + ux * (r + off), y, uz * (r + off)]);
    }
    rings.push(ring);
  }
  // loft across the ring index (profile is the "ring", circle is the path); the profile loop is closed by loftRings
  const lo = loftRings(rings, { closedPath: true });
  const m = lo.m;
  fixWindingByVolume(m);
  const n = vcount(m), SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
  const ti = rig.boneIndex[sd > 0 ? 'leftThigh' : 'rightThigh'];
  for (let v = 0; v < n; v++) { SI[v * 4] = ti; SW[v * 4] = 1; }
  const A = SHORTS_ATLAS.roll;
  return toGeometry(m, {
    SI, SW,
    // painted fold line + top-edge highlight live in the roll strip of the atlas (u constant: horizontal stripes)
    uv: (v) => [A[0] + A[2] * 0.5, A[1] + A[3] * prof[lo.idxIn[v]][2]],
    matId: () => palette.MAT.SHORTS,
    shadeBias: (v) => { const k = lo.idxIn[v]; return k === 5 ? -0.18 : (k >= 10 ? -0.3 : 0); },
  });
}

// --------------------------------------------------------------------------------------------- painting
export function paintShorts(g, size, dims, s) {
  const px = (rect, u, v) => [(rect[0] + u * rect[2]) * size, (1 - (rect[1] + v * rect[3])) * size];
  const pel = (a, y) => px(SHORTS_ATLAS.pelvis, 0.5 + a / TAU, (y - 0.75) / 0.27);
  const leg = (sd, psi, y) => px(sd > 0 ? SHORTS_ATLAS.legL : SHORTS_ATLAS.legR, 0.5 + psi / TAU, (y - (s.hemY - 0.02)) / 0.27);
  const R = 'rgb(255,0,0)', B = 'rgb(0,0,255)', G = 'rgb(0,170,0)';
  const stroke = (pts, w, col, dash = null) => {
    g.save(); g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke(); g.restore();
  };
  const curve = (fn, n = 24) => Array.from({ length: n + 1 }, (_, i) => fn(i / n));
  const top = s.topY(0);
  // fly: centre line + J stitch
  stroke(curve((t) => pel(0, top - 0.005 - t * 0.15)), 2.2, R);
  stroke(curve((t) => {
    const y = top - 0.01 - t * 0.12;
    const a = 0.16 * (1 - smoothstep(0.7, 1.0, t)) + 0.01;
    return pel(-a, y - 0.02 * smoothstep(0.75, 1, t));
  }), 1.6, B, [4, 3]);
  // front pockets (slanted openings) + stitching
  for (const sd of [1, -1]) {
    stroke(curve((t) => pel(sd * (0.58 + 0.62 * t), top - 0.008 - 0.085 * Math.pow(t, 0.8))), 2.4, R);
    stroke(curve((t) => pel(sd * (0.50 + 0.62 * t), top - 0.016 - 0.090 * Math.pow(t, 0.8))), 1.4, B, [4, 3]);
    // back yoke (V towards the centre back) and patch pockets
    stroke(curve((t) => pel(sd * (2.05 + t * (Math.PI - 2.05)), top - 0.035 - 0.03 * t)), 2.0, R);
    stroke(curve((t) => pel(sd * (2.05 + t * (Math.PI - 2.05)), top - 0.045 - 0.03 * t)), 1.3, B, [4, 3]);
    const pc = sd * 2.55, pw = 0.30, py0 = top - 0.085, py1 = top - 0.18;
    const pocket = [pel(pc - pw, py0), pel(pc + pw, py0), pel(pc + pw, py1 + 0.02), pel(pc, py1), pel(pc - pw, py1 + 0.02), pel(pc - pw, py0)];
    stroke(pocket, 2.0, R);
    const inset = [pel(pc - pw + 0.05, py0 - 0.006), pel(pc + pw - 0.05, py0 - 0.006), pel(pc + pw - 0.05, py1 + 0.025), pel(pc, py1 + 0.008), pel(pc - pw + 0.05, py1 + 0.025), pel(pc - pw + 0.05, py0 - 0.006)];
    stroke(inset, 1.3, B, [4, 3]);
    // waistband stitch line
    stroke(curve((t) => pel(sd * t * Math.PI, s.topY(t * Math.PI) - 0.03)), 1.3, B, [4, 3]);
    // crotch folds (front, near the inseam)
    stroke([pel(sd * 0.25, 0.80), pel(sd * 0.55, 0.785)], 2.2, G);
    stroke([pel(sd * 0.18, 0.79), pel(sd * 0.42, 0.765)], 2.0, G);
    // legs: outer side seam, inseam, folds behind the knee area and at the front
    stroke(curve((t) => leg(sd, Math.PI / 2, s.hemY + t * 0.24)), 2.0, R);
    stroke(curve((t) => leg(sd, Math.PI / 2 - 0.12, s.hemY + t * 0.24)), 1.3, B, [4, 3]);
    stroke(curve((t) => leg(sd, -Math.PI / 2, s.hemY + t * 0.22)), 1.8, R);
    for (const [p0, y0, p1, y1] of [[2.6, 0.62, 3.0, 0.60], [-2.6, 0.63, -3.0, 0.605], [2.4, 0.66, 2.9, 0.645]]) stroke([leg(sd, p0, y0), leg(sd, p1, y1)], 2.4, G);
    stroke([leg(sd, -0.4, 0.70), leg(sd, 0.1, 0.68)], 2.0, G);
  }
  // pelvis side seams continue the leg seams
  for (const sd of [1, -1]) stroke(curve((t) => pel(sd * Math.PI / 2, 0.76 + t * (top - 0.04 - 0.76))), 2.0, R);
  // roll band strip (QA r1 P1-4): fold line in the groove, soft shade under each roll, 1-px highlight on the top edges
  const A = SHORTS_ATLAS.roll, prof = rollProfile(dims.SHORTS.roll);
  const row = (k) => (1 - (A[1] + A[3] * prof[k][2])) * size;
  const band = (y, w, col) => { g.save(); g.fillStyle = col; g.fillRect(A[0] * size, y - w / 2, A[2] * size, w); g.restore(); };
  band(row(5), 3.2, R);
  band((row(4) + row(5)) / 2, 3, 'rgb(0,150,0)');
  band((row(0) + row(1)) / 2, 3, 'rgb(0,150,0)');
  band(row(7), 1.6, B);
  band(row(3), 1.2, B);
}
