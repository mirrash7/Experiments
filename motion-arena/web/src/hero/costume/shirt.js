// Shirt (WP4): one continuous skinned SDF shell (torso + both sleeves, smooth-union welded armholes),
// extracted with Surface Nets, cut exactly (front V, neck, hem, scalloped bell cuffs), smoothed, then
// thickened with rolled rims. Stand-and-fall collar lofted on the real neckline edge, 4 gold buttons
// merged with copied weights, painted detail (costume atlas). Owner: WP4. Spec 2.6.

import {
  clamp, smoothstep, smin, sampleKeys, sample1, monotone, ellipseDist, makeTube, gradient,
  surfaceNets, clipMesh, smoothMesh, thicken, topology, vertexNormals, removeSmallComponents,
  rayHit, loftRings, boundaryDistance, garmentWeights, blendToBone, moveWeight, packWeights, toGeometry, vcount, lap,
  gridAxis, smoothSurfaceNormals,
} from './sdf.js';

export const SHIRT_ATLAS = { torso: [0, 0, 0.5, 0.5], sleeveL: [0.5, 0, 0.5, 0.25], sleeveR: [0.5, 0.25, 0.5, 0.25], yoke: [0, 0.9, 0.2, 0.1] };
export const BLANK_UV = [0.995, 0.995];
const TAU = Math.PI * 2;
// Extraction grid (QA r1 P0-1): rectilinear and non-uniform. Coarse (VOXEL_SCALE x spec 1.2 cm) over the broad torso
// and sleeve panels, where Laplacian smoothing + SDF re-projection + clean normals keep the surface smooth; the
// spec 1.2 cm only where detail lives: around the sleeve axis band in y/z (scalloped bell cuffs, armholes) and
// along x at the cuff. Cut edges are exact regardless of voxel size.
const VOXEL_SCALE = 2.6;
const FINE = 1.0;
/** Inner-shell band (m from any cut edge): the inside is only visible near openings; deeper in the bell cuff. */
const INNER_BAND = { torso: 0.032, sleeve: 0.085 };

/** Skin model of the torso used to size the cloth (from dims.BODY; interpolated keys between). */
export function torsoSkinKeys(B) {
  return [
    [0.80, 0.138, 0.094], [0.84, 0.142, 0.095], [B.pelvisSkin.y, B.pelvisSkin.w / 2, B.pelvisSkin.d / 2],
    [B.waist.y, B.waist.w / 2, B.waist.d / 2], [1.15, 0.137, 0.088], [B.chest.y, B.chest.w / 2, B.chest.d / 2],
    [1.33, 0.155, 0.090], [1.38, 0.132, 0.078], [1.42, 0.058, 0.050], [1.46, 0.047, 0.043], [1.52, 0.044, 0.040],
  ];
}

/** Garment parameters shared by shirt, sash and atlas painting. */
export function shirtShape(dims) {
  const S = dims.SHIRT, B = dims.BODY, J = dims.JOINT_WORLD, SA = dims.SASH;
  const armY = J.leftUpperArm[1];
  const elbowX = J.leftForeArm[0];
  const xEnd = elbowX + S.sleeveEndForearmT * dims.LENGTHS.foreArm;     // 0.51
  const xCuff = xEnd - S.cuff.length;                                     // 0.425
  const collarY = 1.335;                                                  // V top / collar points
  const sashTop = SA.frontY + SA.width / 2;
  const hemFront = sashTop - S.hemTuck;                                   // tucked 0.02 under the sash
  const hemSide = SA.frontY - SA.width / 2 - S.skirt;                     // 0.04 skirt below the sash
  const halfGap = monotone([[0.80, S.opening.hem], [hemFront, S.opening.hem], [B.chest.y, S.opening.nipple], [collarY, S.opening.collar], [1.6, S.opening.collar]]);
  // hem height by angle from the front (radians)
  const hemY = (th) => {
    const a = Math.abs(th);
    return hemFront + (hemSide - hemFront) * smoothstep(0.7, Math.PI / 2, a) + (-S.backHemExtra) * smoothstep(Math.PI / 2, Math.PI, a);
  };
  // neckline height by angle from the BACK (radians, 0 = back centre)
  const neckY = monotone([[0, 1.452], [0.87, 1.448], [1.57, 1.440], [2.18, 1.415], [2.62, 1.375], [2.83, collarY], [Math.PI, 1.30]]);
  const seamX = (y) => 0.205 + 0.15 * (y - armY);                         // armhole seam (|x|)
  const yokeY = 1.385;
  const buttonsY = [];
  const first = collarY - S.buttons.belowCollar, last = sashTop + S.buttons.aboveSash;
  for (let i = 0; i < S.buttons.count; i++) buttonsY.push(first + ((last - first) * i) / (S.buttons.count - 1));
  return { armY, elbowX, xEnd, xCuff, collarY, sashTop, hemFront, hemSide, halfGap, hemY, neckY, seamX, yokeY, buttonsY };
}

/** Shirt outer-surface SDF (before cuts). shortsSdf keeps the skirt outside the shorts. */
export function makeShirtSdf(dims, sh, shortsSdf) {
  const S = dims.SHIRT;
  const skin = torsoSkinKeys(dims.BODY);
  const fit = monotone([[0.80, S.fit.hem + 0.018], [0.87, S.fit.hem + 0.010], [0.93, S.fit.hem], [dims.BODY.waist.y, S.fit.waist], [dims.BODY.chest.y, S.fit.chest], [1.6, S.fit.chest]]);
  const tmp = [];
  const torso = (x, y, z) => {
    sampleKeys(skin, y, tmp);
    let off = fit(y);
    // panels hang slightly outward near the opening (chest to waist)
    if (z > 0) off += 0.008 * smoothstep(0.20, 0.11, Math.abs(x)) * smoothstep(1.27, 1.12, y) * smoothstep(0.93, 1.0, y);
    return Math.max(ellipseDist(x, z, tmp[0] + off, tmp[1] + off), y - 1.56);
  };
  const { r0, r1, ampRadial, scallops } = S.cuff;
  const rTop = Math.min(r1, S.cuff.maxR) - 0.003;   // leaves room for the rolled rim bulge: measured max <= cuff.maxR
  // QA r1 P0-6: slim sleeve head (shoulder width 0.52 -> ~0.46): the body shrink-wrap adds the real deltoid back
  const sleeveR = monotone([[0.12, 0.050], [0.19, 0.046], [0.30, 0.048], [0.38, 0.049], [sh.xCuff, r0]]);
  const sleeve = (side) => makeTube({
    a: [side * 0.12, sh.armY, 0], b: [side * (sh.xEnd + 0.03), sh.armY, 0], up: [0, 1, 0],
    radius: (t, ang) => {
      const ax = 0.12 + t * (sh.xEnd + 0.03 - 0.12);
      let r;
      if (ax <= sh.xCuff) r = sleeveR(ax);
      else {
        const s = clamp((ax - sh.xCuff) / S.cuff.length, 0, 1.3);
        const c = Math.min(s, 1);
        r = r0 + (rTop - ampRadial - r0) * Math.pow(c, 1.6) + ampRadial * (0.5 + 0.5 * Math.cos(scallops * ang)) * c * c;
      }
      return [r, r, r * 1.03];
    },
    capA: true, capB: true,
  });
  const sL = sleeve(1), sR = sleeve(-1);
  const k = S.sdfK;
  return (x, y, z) => {
    let d = torso(x, y, z);
    if (x > 0.05) d = smin(d, sL(x, y, z), k);
    else if (x < -0.05) d = smin(d, sR(x, y, z), k);
    if (shortsSdf && y < 0.98) {
      const f = smoothstep(0.98, 0.92, y);
      const d2 = smin(d, shortsSdf(x, y, z) - 0.014, 0.02);
      d = d + (d2 - d) * f;
    }
    return d;
  };
}

/**
 * Build the shirt. Returns { geometry, buttonGeoInfo, sdf, outerSdf, shape }.
 * ctx: hero build ctx; opts: { shortsSdf, bodyGeo }
 */
export function buildShirt(ctx, { shortsSdf, bodyGeo, sdf: sdfIn = null }) {
  const { dims, rig, palette } = ctx;
  const { MAT } = palette;
  const S = dims.SHIRT;
  const sh = shirtShape(dims);
  const sdf = sdfIn || makeShirtSdf(dims, sh, shortsSdf);

  // ---- extract
  const hC = S.voxel * VOXEL_SCALE, hF = S.voxel * FINE;
  const grid = {
    xs: gridAxis(-(sh.xEnd + 0.035), sh.xEnd + 0.035, (x) => (Math.abs(x) > sh.xCuff - 0.02 ? hF * 1.2 : hC), true),
    ys: gridAxis(0.80, 1.53, (y) => (Math.abs(y - sh.armY) < 0.06 ? hF * 1.1 : hC)),
    zs: gridAxis(-0.20, 0.22, (z) => (Math.abs(z) < 0.06 ? hF * 1.1 : hC)),
  };
  let m = surfaceNets(sdf, null, null, grid);
  lap('shirt.nets');
  // ---- cuts (positive = removed)
  const cutHem = (x, y, z) => sh.hemY(Math.atan2(x, z)) - y;
  const cutNeck = (x, y, z) => Math.min(y - sh.neckY(Math.atan2(Math.abs(x), -z)), 0.13 - Math.hypot(x, z + 0.005));
  const cutFront = (x, y, z) => Math.min(sh.halfGap(y) - Math.abs(x), z - 0.02);
  const cutSleeve = (x, y, z) => {
    const ax = Math.abs(x);
    if (ax < 0.3) return -1;
    const psi = Math.atan2(z, y - sh.armY);
    return ax - (sh.xEnd + S.cuff.ampAxial * Math.cos(S.cuff.scallops * psi));
  };
  for (const cut of [cutHem, cutNeck, cutFront, cutSleeve]) m = clipMesh(m, cut, { surf: sdf }).m;
  m = removeSmallComponents(m, 60);
  lap('shirt.cuts');
  smoothMesh(m, { passes: S.smoothPasses, lambda: 0.5, boundaryLambda: 0.12, surf: sdf });
  lap('shirt.smooth');

  // ---- label splits (exact region / colour boundaries): placket band, armhole seam, yoke, z = 0 (sleeve UV wrap)
  const tagFns = {
    placket: (x, y, z) => Math.min(sh.halfGap(y) + S.opening.placket - Math.abs(x), z - 0.02),
    seam: (x, y) => Math.abs(x) - sh.seamX(y),
    yoke: (x, y) => y - sh.yokeY,
    zero: (x, y, z) => z,
  };
  // Apply splits sequentially; recompute per-triangle labels from centroids afterwards (exact because
  // every label boundary is now a mesh edge).
  for (const f of Object.values(tagFns)) m = clipMesh(m, f, { keepBoth: true, snap: 0 }).m;

  lap('shirt.labels');
  // ---- collar path: boundary vertices on the neck cut, ordered along the boundary loop
  const topo0 = topology(m);
  const nOuter = vcount(m);
  // QA r1 P0-4: clean normals (blurred SDF gradient blended with the mesh normal, then normal-only smoothing)
  const N0 = smoothSurfaceNormals(m, sdf, topo0.neighbors, { e: 0.008, wSdf: 0.75, passes: 4, meshNormals: vertexNormals(m) });
  const onNeck = (i) => topo0.boundary[i] && Math.abs(cutNeck(m.P[3 * i], m.P[3 * i + 1], m.P[3 * i + 2])) < 0.003 && m.P[3 * i + 1] > sh.collarY - 0.01 && Math.abs(m.P[3 * i]) < 0.15;
  let neckPath = [];
  for (let i = 0; i < nOuter; i++) {
    if (!onNeck(i) || onNeck(topo0.bPrev[i])) continue;
    const run = [];
    for (let v = i, g = 0; v >= 0 && onNeck(v) && g < 500; v = topo0.bNext[v], g++) run.push(v);
    if (run.length > neckPath.length) neckPath = run;
  }

  // ---- thickness + rims
  lap('shirt.normals');
  const bd = boundaryDistance(m, topo0);
  const th = thicken(m, -S.innerOffset, { rimSegments: 2, bulge: 0.3, normals: N0,
    innerMask: bd.map((d, i) => (d < (Math.abs(m.P[3 * i]) > 0.3 ? INNER_BAND.sleeve : INNER_BAND.torso) ? 1 : 0)) });
  const M = th.m;
  const n = vcount(M);
  const topo = topology(M);
  const Pn = M.P;

  // ---- per-triangle regions: 0 torso, 1 yoke, 2/3 sleeveL front/back, 4/5 sleeveR front/back
  const triRegion = new Int32Array(M.T.length / 3);
  for (let t = 0; t < M.T.length; t += 3) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { const i = th.src[M.T[t + k]]; x += m.P[3 * i]; y += m.P[3 * i + 1]; z += m.P[3 * i + 2]; }
    x /= 3; y /= 3; z /= 3;
    let r = 0;
    if (Math.abs(x) > sh.seamX(y)) r = (x > 0 ? 2 : 4) + (z >= 0 ? 0 : 1);
    else if (y > sh.yokeY) r = 1;
    triRegion[t / 3] = r;
  }
  // placket band per triangle (outer layer only)
  const triPlacket = new Uint8Array(M.T.length / 3);
  for (let t = 0; t < M.T.length; t += 3) {
    let x = 0, y = 0, z = 0, outer = true;
    for (let k = 0; k < 3; k++) { const v = M.T[t + k]; if (th.layer[v] !== 0) outer = false; const i = th.src[v]; x += m.P[3 * i]; y += m.P[3 * i + 1]; z += m.P[3 * i + 2]; }
    if (outer && tagFns.placket(x / 3, y / 3, z / 3) > 0) triPlacket[t / 3] = 1;
  }

  lap('shirt.thicken');
  // ---- skin weights
  const upper = ['hips', 'spine', 'chest', 'neck', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftForeArm', 'rightForeArm',
    'leftUpperArmTwist', 'rightUpperArmTwist', 'leftElbowHelper', 'rightElbowHelper', 'leftThigh', 'rightThigh', 'leftHipHelper', 'rightHipHelper'];
  const W = garmentWeights(M, rig, {
    srcGeo: bodyGeo, bones: upper, neighbors: topo.neighbors, smoothPasses: 3,
    // segment fallback: legs only influence the skirt
    segFilter: (i, x, y, z, seg) => !seg.bone.endsWith('Thigh') || y < 0.9,
  });
  const B = rig.boneOrder.length, bi = rig.boneIndex;
  for (let v = 0; v < n; v++) {
    const i = th.src[v];
    const x = m.P[3 * i], y = m.P[3 * i + 1], z = m.P[3 * i + 2], ax = Math.abs(x);
    const o = v * B;
    // thighs/hip helpers: at most half of what the skin has (skirt is loose), none above the sash
    for (const b of ['leftThigh', 'rightThigh', 'leftHipHelper', 'rightHipHelper']) {
      const f = 0.5 * smoothstep(0.93, 0.87, y);
      const w = W[o + bi[b]] * (1 - f);
      W[o + bi[b]] -= w; W[o + bi.hips] += w;
    }
    // neckline (and the collar copied from it) stays on chest/neck: arm raises must not drag it
    const nf = smoothstep(0.17, 0.11, Math.hypot(x, z)) * smoothstep(1.33, 1.38, y);
    if (nf > 0) for (const b of ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftUpperArmTwist', 'rightUpperArmTwist']) moveWeight(W, B, v, bi[b], bi.chest, nf);
    // lower shirt follows the hips (stays under the sash in a twist)
    blendToBone(W, B, v, bi.hips, 0.6 * smoothstep(1.0, 0.94, y) * (ax < sh.seamX(y) ? 1 : 0));
    // hem jiggle bones (WP5): up to 45% at the skirt edge
    const hemAmt = 0.45 * smoothstep(0.93, sh.hemSide, y);
    if (hemAmt > 0) {
      const thAng = Math.abs(Math.atan2(x, z));
      const back = smoothstep(1.9, 2.6, thAng);
      blendToBone(W, B, v, bi.shirtHemBack, hemAmt * back);
      blendToBone(W, B, v, x >= 0 ? bi.shirtHemL : bi.shirtHemR, hemAmt * (1 - back));
    }
    // bell cuff: 70% forearm / 30% sleeveCuff jiggle bone
    if (ax > sh.xCuff - 0.01) {
      const c = smoothstep(sh.xCuff - 0.01, sh.xCuff + 0.04, ax);
      const fa = x > 0 ? bi.leftForeArm : bi.rightForeArm;
      blendToBone(W, B, v, fa, 0.5 * smoothstep(sh.elbowX - 0.01, sh.xEnd, ax));
      blendToBone(W, B, v, x > 0 ? bi.sleeveCuffL : bi.sleeveCuffR, S.cuffWeights.sleeveCuff * c);
    }
  }
  lap('shirt.wblend');
  const packed = packWeights(W, B, n);
  lap('shirt.weights');

  // ---- UVs
  const uvTorso = (x, y, z) => { const a = Math.atan2(x, -z); return [0.5 + a / TAU, (y - 0.80) / 0.70]; };
  const atlas = (rect, u, v) => [rect[0] + clamp(u, 0, 1) * rect[2], rect[1] + clamp(v, 0, 1) * rect[3]];
  const uvFn = (v, reg) => {
    if (th.layer[v] !== 0) return BLANK_UV;
    const i = th.src[v];
    const x = m.P[3 * i], y = m.P[3 * i + 1], z = m.P[3 * i + 2];
    if (reg === 0) { const [u, vv] = uvTorso(x, y, z); return atlas(SHIRT_ATLAS.torso, u, vv); }
    if (reg === 1) return atlas(SHIRT_ATLAS.yoke, (x + 0.25) / 0.5, (z + 0.12) / 0.24);
    const left = reg < 4, front = reg % 2 === 0;
    let psi = Math.atan2(z, y - sh.armY);
    if (Math.abs(psi) > 2.8) psi = front ? Math.abs(psi) : -Math.abs(psi);
    const u = (psi + Math.PI) / TAU;
    const vv = (Math.abs(x) - sh.seamX(y)) / 0.36;
    return atlas(left ? SHIRT_ATLAS.sleeveL : SHIRT_ATLAS.sleeveR, u, vv);
  };

  // ---- colour / shading
  const triOf = new Int32Array(n).fill(-1);
  for (let t = 0; t < M.T.length; t += 3) for (let k = 0; k < 3; k++) if (triPlacket[t / 3]) triOf[M.T[t + k]] = 1;
  // final normals: outer = clean N0, inner = -N0, rim = its own mesh normal
  const Nr = vertexNormals(M), NF = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const L = th.layer[v], i = th.src[v];
    for (let c = 0; c < 3; c++) NF[3 * v + c] = L === 0 ? N0[3 * i + c] : L === 1 ? -N0[3 * i + c] : Nr[3 * v + c];
  }
  const geometry = toGeometry(M, {
    SI: packed.SI, SW: packed.SW, normals: NF,
    region: (t) => triRegion[t] * 2 + triPlacket[t],
    uv: (v, reg) => uvFn(v, reg >> 1),
    matId: (v, reg) => (th.layer[v] !== 0 || (reg & 1) ? MAT.SHIRT_INNER : MAT.SHIRT),
    shadeBias: (v) => {
      const i = th.src[v];
      const x = m.P[3 * i], y = m.P[3 * i + 1], z = m.P[3 * i + 2], ax = Math.abs(x);
      if (th.layer[v] === 1) return -0.3;
      let b = 0;
      // armpit crease, skirt under the sash, under the collar
      b -= 0.32 * smoothstep(0.05, 0.0, Math.abs(ax - sh.seamX(y))) * smoothstep(1.34, 1.27, y) * smoothstep(1.16, 1.22, y) * smoothstep(0.07, 0.02, Math.abs(z));
      const SA = dims.SASH, tf = Math.abs(Math.atan2(x, z));
      const sb = SA.frontY + (SA.backY - SA.frontY) * (1 - Math.cos(tf)) / 2 - SA.width / 2;
      b -= 0.32 * smoothstep(sb - 0.02, sb - 0.008, y) * smoothstep(sb - 0.05, sb - 0.03, y);
      if (Math.hypot(x, z) < 0.14) b -= 0.25 * smoothstep(0.025, 0.005, sh.neckY(Math.atan2(ax, -z)) - y);
      // QA r1 P0-4: back panel sits a touch further into the light so the default key leaves it lit to the side terminator
      if (ax < sh.seamX(y)) b += 0.05 * smoothstep(-0.01, -0.07, z);
      return clamp(b, -0.5, 0.5);
    },
    outlineWidth: () => dims.OUTLINE.width.default,
  });

  lap('shirt.toGeo');
  // ---- collar (lofted on the neckline edge) and buttons, returned as separate geometries
  const collar = neckPath.length > 4 ? buildCollar(ctx, m, N0, neckPath, packed, th, sh) : null;
  const buttons = buildButtons(ctx, sdf, sh, M, packed, th);

  lap('shirt.collarButtons');
  const debug = { neckPath: neckPath.map((i) => [m.P[3 * i], m.P[3 * i + 1], m.P[3 * i + 2]].map((c) => +c.toFixed(3))) };
  const layerTris = [0, 0, 0];
  for (let t = 0; t < M.T.length; t += 3) layerTris[Math.max(th.layer[M.T[t]], th.layer[M.T[t + 1]], th.layer[M.T[t + 2]])]++;
  debug.layerTris = layerTris; debug.grid = [grid.xs.length, grid.ys.length, grid.zs.length];
  return { geometry, collar, buttons, sdf, shape: sh, triCount: M.T.length / 3, debug };
}

// --------------------------------------------------------------------------------------------- collar
function buildCollar(ctx, m, N0, path, packed, th, sh) {
  const { dims, palette } = ctx;
  const { MAT } = palette;
  const C = dims.SHIRT.collar;
  // ordered points (orient from wearer's right to left so the loft is consistent)
  let pts = path.map((i) => [m.P[3 * i], m.P[3 * i + 1], m.P[3 * i + 2]]);
  let nrm = path.map((i) => [N0[3 * i], N0[3 * i + 1], N0[3 * i + 2]]);
  if (pts[0][0] > pts[pts.length - 1][0]) { pts.reverse(); nrm.reverse(); path = path.slice().reverse(); }
  // resample by arc length (smooth)
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const L = len[len.length - 1];
  const R = 24;
  const at = (arr, s) => {
    let j = 1; while (j < len.length - 1 && len[j] < s) j++;
    const t = clamp((s - len[j - 1]) / Math.max(len[j] - len[j - 1], 1e-9), 0, 1);
    return [0, 1, 2].map((k) => arr[j - 1][k] + (arr[j][k] - arr[j - 1][k]) * t);
  };
  let P = [], Nn = [];
  for (let r = 0; r <= R; r++) { const s = (L * r) / R; P.push(at(pts, s)); Nn.push(at(nrm, s)); }
  for (let pass = 0; pass < 4; pass++) {
    P = P.map((p, i) => (i === 0 || i === R ? p : p.map((c, k) => c * 0.5 + (P[i - 1][k] + P[i + 1][k]) * 0.25)));
    Nn = Nn.map((p, i) => (i === 0 || i === R ? p : p.map((c, k) => c * 0.5 + (Nn[i - 1][k] + Nn[i + 1][k]) * 0.25)));
  }
  const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // profile in (a = along edge-out direction e, b = along surface normal), closed loop; inner flags
  const prof = (endF) => {
    const st = C.stand * (1 - 0.35 * endF), fall = C.fall * (1 + 0.55 * endF), out = 0.006 + 0.012 * endF;
    return [
      [-0.004, -0.0015, 1], [st * 0.5, -0.0025, 1], [st, -0.001, 1], [st + 0.004, 0.003, 0], [st + 0.002, 0.0075, 0],
      [st - fall * 0.35, 0.010 + out * 0.4, 0], [st - fall * 0.75, 0.013 + out * 0.8, 0], [st - fall, 0.014 + out, 0],
      [st - fall - 0.0015, 0.0105 + out, 1], [st - fall * 0.72, 0.009 + out * 0.75, 1], [st - fall * 0.3, 0.006 + out * 0.3, 1],
      [st * 0.55, 0.0035, 1], [-0.002, 0.002, 1],
    ];
  };
  const rings = [], inner = [];
  for (let r = 0; r <= R; r++) {
    const s = r / R;
    const tng = norm(P[Math.min(r + 1, R)].map((c, k) => c - P[Math.max(r - 1, 0)][k]));
    const nb = norm(Nn[r]);
    let e = norm(cross(tng, nb));
    if (e[1] < 0) e = e.map((c) => -c);              // edge-out direction points up toward the neck
    const endF = Math.max(smoothstep(0.22, 0, s), smoothstep(0.78, 1, s));
    const ring = [];
    for (const [a, b, inn] of prof(endF)) {
      ring.push([P[r][0] + e[0] * a + nb[0] * b, P[r][1] + e[1] * a + nb[1] * b, P[r][2] + e[2] * a + nb[2] * b]);
      if (r === 0) inner.push(inn);
    }
    rings.push(ring);
  }
  const lo = loftRings(rings, { capStart: true, capEnd: true });
  // orientation: make the first quad face outward along the profile winding; check vs centroid of ring
  const geoM = lo.m;
  // weights: copy from the nearest shirt edge vertex for each ring
  const n = vcount(geoM), SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const r = lo.ringOf[v];
    const s = (L * r) / R;
    let j = 1; while (j < len.length - 1 && len[j] < s) j++;
    const src = path[j]; // outer-layer vertex index equals source index in thickened mesh
    for (let c = 0; c < 4; c++) { SI[v * 4 + c] = packed.SI[src * 4 + c]; SW[v * 4 + c] = packed.SW[src * 4 + c]; }
  }
  // winding check: normal of a stand-inner quad should point toward the neck (−e) ... use signed volume
  fixWindingByVolume(geoM);
  return toGeometry(geoM, {
    SI, SW,
    uv: () => BLANK_UV,
    matId: (v) => (lo.idxIn[v] >= 0 && inner[lo.idxIn[v]] ? MAT.SHIRT_INNER : MAT.SHIRT),
    shadeBias: (v) => (lo.idxIn[v] >= 0 && inner[lo.idxIn[v]] ? -0.25 : 0),
    outlineWidth: () => 1,
  });
}

/** Closed meshes: make the signed volume positive (outward winding). */
export function fixWindingByVolume(m) {
  let vol = 0;
  const P = m.P;
  for (let t = 0; t < m.T.length; t += 3) {
    const a = 3 * m.T[t], b = 3 * m.T[t + 1], c = 3 * m.T[t + 2];
    vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  if (vol < 0) for (let t = 0; t < m.T.length; t += 3) { const b = m.T[t + 1]; m.T[t + 1] = m.T[t + 2]; m.T[t + 2] = b; }
  return m;
}

// --------------------------------------------------------------------------------------------- buttons
function buildButtons(ctx, sdf, sh, M, packed, th) {
  const { dims, palette } = ctx;
  const Bt = dims.SHIRT.buttons;
  const P = [], T = [], SIa = [], SWa = [], centres = [];
  const g = [0, 0, 0];
  const segs = 12;
  const r = Bt.diameter / 2, hgt = Bt.height;
  // lathe profile (radius, height above surface)
  const prof = [[0, hgt], [r * 0.45, hgt * 0.94], [r * 0.8, hgt * 0.72], [r, hgt * 0.32], [r * 0.98, -0.0015]];
  for (const y of sh.buttonsY) {
    const x = -(sh.halfGap(y) + Bt.inset);       // wearer's right panel
    const t = rayHit(sdf, x, y, 0.3, 0, 0, -1, 0.3, 0.002);
    const z = 0.3 - t;
    gradient(sdf, x, y, z, 2e-4, g);
    const l = Math.hypot(...g); const nx = g[0] / l, ny = g[1] / l, nz = g[2] / l;
    // tangent frame
    let ux = 0, uy = 1, uz = 0;
    const d = ux * nx + uy * ny + uz * nz; ux -= nx * d; uy -= ny * d; uz -= nz * d;
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;
    const base = P.length / 3;
    // nearest outer shirt vertex -> rigid weights for the whole button
    let best = 0, bd = Infinity;
    for (let v = 0; v < th.layer.length; v++) {
      if (th.layer[v] !== 0) continue;
      const dd = (M.P[3 * v] - x) ** 2 + (M.P[3 * v + 1] - y) ** 2 + (M.P[3 * v + 2] - z) ** 2;
      if (dd < bd) { bd = dd; best = v; }
    }
    centres.push([x, y, z]);
    P.push(x + nx * hgt, y + ny * hgt, z + nz * hgt);
    for (let k = 1; k < prof.length; k++) for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const [pr, ph] = prof[k];
      P.push(x + (ux * ca + wx * sa) * pr + nx * ph, y + (uy * ca + wy * sa) * pr + ny * ph, z + (uz * ca + wz * sa) * pr + nz * ph);
    }
    for (let s = 0; s < segs; s++) T.push(base, base + 1 + s, base + 1 + ((s + 1) % segs));
    for (let k = 1; k < prof.length - 1; k++) for (let s = 0; s < segs; s++) {
      const a = base + 1 + (k - 1) * segs + s, b = base + 1 + (k - 1) * segs + ((s + 1) % segs);
      const c = a + segs, e = b + segs;
      T.push(a, c, b, b, c, e);
    }
    const cnt = P.length / 3 - base;
    for (let k = 0; k < cnt; k++) for (let c = 0; c < 4; c++) { SIa.push(packed.SI[best * 4 + c]); SWa.push(packed.SW[best * 4 + c]); }
  }
  const m = { P, T };
  // the lathe loops are ordered with the frame (u, w, n) — fix winding per button by volume sign of each
  fixWindingPerButton(m, centres, segs, prof.length);
  return toGeometry(m, {
    SI: Uint16Array.from(SIa), SW: Float32Array.from(SWa),
    uv: () => BLANK_UV, matId: () => palette.MAT.GOLD, shadeBias: () => 0, outlineWidth: () => 0.7,
  });
}
function fixWindingPerButton(m, centres, segs) {
  // check the top-cap triangle normal against the dome direction (vertex 0 - ring centre)
  const P = m.P;
  const a = m.T[0], b = m.T[1], c = m.T[2];
  const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const [cx, cy, cz] = centres[0];
  const dot = nx * (P[0] - cx) + ny * (P[1] - cy) + nz * (P[2] - cz);
  if (dot < 0) for (let t = 0; t < m.T.length; t += 3) { const q = m.T[t + 1]; m.T[t + 1] = m.T[t + 2]; m.T[t + 2] = q; }
  void segs;
}

// --------------------------------------------------------------------------------------------- painting
/**
 * Paint shirt detail into the costume atlas canvas (R line, G shade, B highlight; additive).
 * shirtSdf is used to place the left-panel thread loops on the real surface.
 */
export function paintShirt(g, size, dims, sh, shirtSdf) {
  const S = dims.SHIRT;
  const px = (rect, u, v) => [(rect[0] + u * rect[2]) * size, (1 - (rect[1] + v * rect[3])) * size];
  const torso = (a, y) => px(SHIRT_ATLAS.torso, 0.5 + a / TAU, (y - 0.80) / 0.70);
  const stroke = (pts, w, col, dash = null) => {
    g.save(); g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke(); g.restore();
  };
  const R = 'rgb(255,0,0)', G = 'rgb(0,200,0)', RG = 'rgb(160,90,0)';
  // hem stitching (dashed line following the hem, 1.2 cm above it)
  const hem = [];
  for (let k = 0; k <= 200; k++) {
    const a = -Math.PI + (k / 200) * TAU;            // a from back; theta from front = pi - |a|
    hem.push(torso(a, sh.hemY(Math.PI - Math.abs(a)) + 0.012));
  }
  stroke(hem, 1.6, R, [5, 4]);
  // side folds under the arms
  for (const s of [1, -1]) {
    for (const [y0, y1, da] of [[1.29, 1.17, 0.18], [1.26, 1.13, 0.30], [1.22, 1.12, 0.08]]) {
      const a0 = s * (Math.PI / 2 + 0.05), a1 = s * (Math.PI / 2 + 0.05 + da);
      stroke([torso(a0, y0), torso((a0 + a1) / 2, (y0 + y1) / 2 + 0.01), torso(a1, y1)], 2.4, RG);
    }
  }
  // thread loops on the wearer's left panel, mirrored to the button heights
  for (const y of sh.buttonsY) {
    const x = sh.halfGap(y) + S.buttons.inset;
    const t = rayHit(shirtSdf, x, y, 0.3, 0, 0, -1, 0.3, 0.002);
    const z = 0.3 - t;
    const a = Math.atan2(x, -z);
    const [cx, cy] = torso(a, y);
    const [ex] = torso(Math.atan2(x - S.buttons.inset + 0.002, -z), y);
    g.save(); g.strokeStyle = R; g.lineWidth = 1.8;
    g.beginPath(); g.ellipse((cx + ex) / 2, cy, Math.abs(ex - cx) / 2 + 2, 3.2, 0, 0, TAU); g.stroke(); g.restore();
  }
  // sleeves: armhole seam, inner-elbow folds, under-arm folds
  for (const rect of [SHIRT_ATLAS.sleeveL, SHIRT_ATLAS.sleeveR]) {
    const sp = (u, v) => px(rect, u, v);
    stroke([sp(0, 0.025), sp(1, 0.025)], 2.0, R);
    stroke([sp(0, 0.055), sp(1, 0.055)], 1.2, R, [4, 4]);
    const vE = (sh.elbowX - 0.2) / 0.36;
    for (const [du, dv, l] of [[-0.06, -0.03, 0.10], [0.0, 0.02, 0.13], [0.07, -0.01, 0.09]]) {
      stroke([sp(0.75 + du - l / 2, vE + dv), sp(0.75 + du, vE + dv + 0.035), sp(0.75 + du + l / 2, vE + dv)], 2.4, RG);
    }
    for (const u0 of [0.02, 0.98]) {
      const s = u0 < 0.5 ? 1 : -1;
      stroke([sp(u0, 0.06), sp(u0 + s * 0.05, 0.18)], 2.2, RG);
      stroke([sp(u0 + s * 0.04, 0.05), sp(u0 + s * 0.10, 0.14)], 2.0, RG);
    }
  }
  // shoulder seam on the yoke (planar top view: u = x, v = z)
  const yk = (x, z) => px(SHIRT_ATLAS.yoke, (x + 0.25) / 0.5, (z + 0.12) / 0.24);
  for (const s of [1, -1]) stroke([yk(s * 0.07, -0.012), yk(s * 0.25, -0.004)], 2.0, R);
  void G;
}
