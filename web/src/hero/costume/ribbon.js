// Sash tail ribbon geometry core (WP4 / WP5 shared). Owner: WP4 (+ WP5 driver in dynamics/sashRibbon.js). Spec 2.6.
//
// One topology for both tails, used twice:
//   - costume/accessories.js writes the REST drape once (static tails merged into the costume mesh);
//   - dynamics/sashRibbon.js rewrites the same vertex range every frame from the verlet particles (QA r2 P2-4: the
//     dynamic tails live inside the costume geometry, so they share its draw, outline hull and ONE shadow draw).
// Soft-cloth look (QA r2 P1-4): taper w0 -> w1, 3 lengthwise folds whose depth/phase drift along the length (deeper
// near the knot where the cloth is gathered), rolled edge beads (thicker than the middle), progressive twist, a
// slanted cut end, and a dynamic curl across the width (edges cup toward the body when the tail wraps a thigh).
// Ring centres follow a Catmull-Rom spline through the input points; ring frames come from per-point desired
// normals. Writer allocates nothing.
// QA r3 P1-1 (long tail read as a flat even-width board from 3/4 / side): stronger taper (style w1), fold relief built
// into the section on both faces (one corrugated sheet, ±6-8 mm, fold count easing from 3 at the knot to ~2 at the
// tip, amplitude swelling and fading along the length), a gentle S-bend of the centre line along the ring normal
// (`sBend`, one period over the length, i.e. an S in side view), and an extra `twistLow` degrees of twist over the
// lower third. S-bend and twist both scale with the writer's twistK (relaxed near limbs and on the floor).

import { BLANK_UV } from './shirt.js';

const DEG = Math.PI / 180;
/** Segments per flat face (FACE + 1 points), points per rounded edge bead. */
export const RIBBON_FACE = 10;
const BEAD = 3;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * tails: [{ rings, w0, w1, thickness (middle), edge (bead thickness), cutDeg, twistDeg, twistLow, sBend (m), foldAmp: [root, tip], seed }]
 * Returns the layout: { S, nv, ni, index (Uint16|Uint32), bias, tails: [...] } (tails carry per-ring constants).
 */
export function ribbonLayout(tails, { crease = -0.3 } = {}) {
  const S = 2 * (RIBBON_FACE + 1) + 2 * BEAD;
  let nv = 0, ni = 0;
  const T = tails.map((t) => {
    const o = { ...t, R: t.rings, side0: nv };
    nv += t.rings * S;
    o.cap0 = nv; nv += S + 1;
    o.cap1 = nv; nv += S + 1;
    ni += (t.rings - 1) * S * 6 + 2 * S * 3;
    o.ringA = new Float32Array(t.rings * S); o.ringB = new Float32Array(t.rings * S);
    o.ringNA = new Float32Array(t.rings * S); o.ringNB = new Float32Array(t.rings * S);
    o.ringTw = new Float32Array(t.rings);
    o.ringS = new Float32Array(t.rings);
    o.cut = Math.tan((t.cutDeg || 0) * DEG);
    return o;
  });
  const index = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
  const bias = new Float32Array(nv);
  let ii = 0;
  const A = new Float32Array(S), B = new Float32Array(S), F = new Float32Array(S);
  for (const t of T) {
    const seed = t.seed || 0;
    for (let r = 0; r < t.R; r++) {
      const s = r / (t.R - 1);
      // taper + a slow width ripple (soft cloth never has dead-straight edges)
      const w = (t.w0 + (t.w1 - t.w0) * s) * (1 + 0.035 * Math.sin(s * Math.PI * 4.4 + seed * 3) * smooth(0, 0.2, s));
      const amp = (t.foldAmp[0] + (t.foldAmp[1] - t.foldAmp[0]) * smooth(0, 0.7, s)) * (0.88 + 0.22 * Math.sin(s * Math.PI * 2.6 + seed * 1.7));
      sectionAt(w, t.thickness, t.edge, amp, s, seed, A, B, F);
      // 2D outward normals of the closed loop (central differences; loop runs top face +a, so the left normal is out)
      for (let k = 0; k < S; k++) {
        const kp = (k + S - 1) % S, kn = (k + 1) % S;
        const ea = A[kn] - A[kp], eb = B[kn] - B[kp];
        const l = Math.hypot(ea, eb) || 1;
        t.ringA[r * S + k] = A[k]; t.ringB[r * S + k] = B[k];
        t.ringNA[r * S + k] = -eb / l; t.ringNB[r * S + k] = ea / l;
        // crease shading: under the knot, and in the fold valleys (concave side of each face)
        bias[t.side0 + r * S + k] = r < 2 ? crease : Math.max(-0.5, -0.38 * smooth(0.15, 1, F[k]));
      }
      // progressive twist (none at the knot) + the lower-third twist, a little wobble so it reads as cloth, not a screw
      const tw0 = t.twistDeg || 0;
      t.ringTw[r] = DEG * (tw0 * (smooth(0.08, 0.66, s) + 0.15 * Math.sin(s * Math.PI * 2 + seed)) + (t.twistLow || 0) * smooth(0.64, 1, s));
      // S-bend along the ring normal: out, back in, out again toward the tip; none at the knot
      t.ringS[r] = (t.sBend || 0) * Math.sin(Math.PI * 2 * (s - 0.06) / 0.94) * smooth(0.0, 0.22, s);
    }
    for (let r = 0; r < t.R - 1; r++) for (let k = 0; k < S; k++) {
      const a = t.side0 + r * S + k, b = t.side0 + r * S + ((k + 1) % S), c = a + S, d = b + S;
      index[ii++] = a; index[ii++] = b; index[ii++] = c;
      index[ii++] = b; index[ii++] = d; index[ii++] = c;
    }
    for (let k = 0; k < S; k++) {
      const k1 = (k + 1) % S;
      index[ii++] = t.cap0 + S; index[ii++] = t.cap0 + k1; index[ii++] = t.cap0 + k;   // start cap faces -tangent
      index[ii++] = t.cap1 + S; index[ii++] = t.cap1 + k; index[ii++] = t.cap1 + k1;   // end cap faces +tangent
      bias[t.cap0 + k] = crease; bias[t.cap1 + k] = bias[t.side0 + (t.R - 1) * S + k];
    }
    bias[t.cap0 + S] = crease;
  }
  return { S, nv, ni, index, bias, tails: T };
}

/**
 * Closed section at ring parameter s: top face (-w/2 -> +w/2), bead, bottom face back, bead. A = across, B = normal
 * offset, F = valley factor (0..1, 1 = deepest concave point of that face; 0 on the beads).
 */
function sectionAt(w, tc, te, amp, s, seed, A, B, F) {
  const re = te / 2, h0 = tc / 2;
  const a0 = -w / 2 + re, a1 = w / 2 - re;
  // 3 lengthwise folds: phase drifts slowly along the length so the folds wander like gathered cloth
  // fold count eases from 3 (gathered at the knot) to ~2 (open toward the tip)
  const ph = seed + s * 2.3, ph2 = seed * 0.7 + s * 1.1, fq = 3.0 - 1.1 * smooth(0.1, 0.9, s);
  const fold = (u) => amp * (0.78 * Math.sin((u * fq + 0.15) * Math.PI + ph) + 0.22 * Math.sin((u * (fq + 2)) * Math.PI + ph2))
    * smooth(0, 0.14, u) * smooth(1, 0.86, u);
  const half = (u) => h0 + (re - h0) * Math.max(smooth(0.13, 0, u), smooth(0.87, 1, u));   // edge beads
  let k = 0;
  for (let i = 0; i <= RIBBON_FACE; i++, k++) {
    const u = i / RIBBON_FACE, f = fold(u);
    A[k] = a0 + u * (a1 - a0); B[k] = f + half(u); F[k] = amp > 0 ? Math.max(0, -f / amp) : 0;
  }
  for (let j = 1; j <= BEAD; j++, k++) { const al = Math.PI / 2 - (j / (BEAD + 1)) * Math.PI; A[k] = a1 + Math.cos(al) * re; B[k] = Math.sin(al) * re; F[k] = 0; }
  for (let i = RIBBON_FACE; i >= 0; i--, k++) {
    const u = i / RIBBON_FACE, f = fold(u);
    A[k] = a0 + u * (a1 - a0); B[k] = f - half(u); F[k] = amp > 0 ? Math.max(0, f / amp) : 0;
  }
  for (let j = 1; j <= BEAD; j++, k++) { const al = -Math.PI / 2 - (j / (BEAD + 1)) * Math.PI; A[k] = a0 + Math.cos(al) * re; B[k] = Math.sin(al) * re; F[k] = 0; }
}

/**
 * Write one tail into the vertex buffers (vertex offset `base` added to the layout indices).
 * P, N: Float32Array(n*3) centre points + desired outward normals (any length, re-orthogonalised here);
 * curl: Float32Array(n) curl per point (1/m, > 0 cups the edges toward -normal); twistK: Float32Array(n) twist
 * scale per point (0..1) or null. fallback: {x,y,z} normal used when degenerate.
 * out: { pos, nrm, onrm } Float32Arrays of the whole geometry.
 */
export function writeRibbonTail(L, t, P, N, n, curl, twistK, fallback, out, base) {
  const S = L.S, R = t.R, cut = t.cut;
  const { pos, nrm, onrm } = out;
  let pnx = fallback.x, pny = fallback.y, pnz = fallback.z;
  for (let r = 0; r < R; r++) {
    const u = (r / (R - 1)) * (n - 1);
    let i = Math.floor(u); if (i > n - 2) i = n - 2;
    const f = u - i;
    const i0 = i - 1, i1 = i, i2 = i + 1, i3 = i + 2;
    const f2 = f * f, f3 = f2 * f;
    const h0 = -0.5 * f3 + f2 - 0.5 * f, h1 = 1.5 * f3 - 2.5 * f2 + 1, h2 = -1.5 * f3 + 2 * f2 + 0.5 * f, h3 = 0.5 * f3 - 0.5 * f2;
    const d0 = -1.5 * f2 + 2 * f - 0.5, d1 = 4.5 * f2 - 5 * f, d2 = -4.5 * f2 + 4 * f + 0.5, d3 = 1.5 * f2 - f;
    let cx = 0, cy = 0, cz = 0, tx = 0, ty = 0, tz = 0;
    for (let c = 0; c < 3; c++) {
      const p1 = P[i1 * 3 + c], p2 = P[i2 * 3 + c];
      const p0 = i0 >= 0 ? P[i0 * 3 + c] : 2 * p1 - p2;
      const p3 = i3 < n ? P[i3 * 3 + c] : 2 * p2 - p1;
      const val = h0 * p0 + h1 * p1 + h2 * p2 + h3 * p3, der = d0 * p0 + d1 * p1 + d2 * p2 + d3 * p3;
      if (c === 0) { cx = val; tx = der; } else if (c === 1) { cy = val; ty = der; } else { cz = val; tz = der; }
    }
    let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl < 1e-8) { tx = 0; ty = -1; tz = 0; tl = 1; }
    tx /= tl; ty /= tl; tz /= tl;
    let nx = N[i1 * 3] + (N[i2 * 3] - N[i1 * 3]) * f, ny = N[i1 * 3 + 1] + (N[i2 * 3 + 1] - N[i1 * 3 + 1]) * f, nz = N[i1 * 3 + 2] + (N[i2 * 3 + 2] - N[i1 * 3 + 2]) * f;
    let d = nx * tx + ny * ty + nz * tz;
    nx -= tx * d; ny -= ty * d; nz -= tz * d;
    let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 0.25 && r > 0) {             // degenerate (tail along the desired normal): carry the previous ring
      nx = pnx; ny = pny; nz = pnz; d = nx * tx + ny * ty + nz * tz;
      nx -= tx * d; ny -= ty * d; nz -= tz * d; nl = Math.hypot(nx, ny, nz);
    }
    if (nl < 1e-6) { nx = fallback.x; ny = fallback.y; nz = fallback.z; nl = Math.hypot(nx, ny, nz) || 1; }
    nx /= nl; ny /= nl; nz /= nl;
    let ax = ty * nz - tz * ny, ay = tz * nx - tx * nz, az = tx * ny - ty * nx;
    const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    nx = ay * tz - az * ty; ny = az * tx - ax * tz; nz = ax * ty - ay * tx;
    pnx = nx; pny = ny; pnz = nz;
    const tk = twistK ? twistK[i1] + (twistK[i2] - twistK[i1]) * f : 1;
    const so = t.ringS[r] * tk;                                     // S-bend: centre offset along the ring normal
    cx += nx * so; cy += ny * so; cz += nz * so;
    const tw = t.ringTw[r] * tk, ca = Math.cos(tw), sa = Math.sin(tw);
    const Ax = ax * ca + nx * sa, Ay = ay * ca + ny * sa, Az = az * ca + nz * sa;
    const Nx = nx * ca - ax * sa, Ny = ny * ca - ay * sa, Nz = nz * ca - az * sa;
    const cu = curl[i1] + (curl[i2] - curl[i1]) * f;
    const ro = r * S, last = r === R - 1, first = r === 0, vb = base + t.side0 + ro;
    for (let k = 0; k < S; k++) {
      const a = t.ringA[ro + k], b = t.ringB[ro + k] - cu * a * a;
      let px = cx + Ax * a + Nx * b, py = cy + Ay * a + Ny * b, pz = cz + Az * a + Nz * b;
      if (last) { px += tx * cut * a; py += ty * cut * a; pz += tz * cut * a; }
      const sn = t.ringNB[ro + k];
      let vn = t.ringNA[ro + k] + 2 * cu * a * sn;
      const vl = 1 / Math.sqrt(vn * vn + sn * sn); vn *= vl; const vb2 = sn * vl;
      const qx = Ax * vn + Nx * vb2, qy = Ay * vn + Ny * vb2, qz = Az * vn + Nz * vb2;
      const o = (vb + k) * 3;
      pos[o] = px; pos[o + 1] = py; pos[o + 2] = pz;
      nrm[o] = qx; nrm[o + 1] = qy; nrm[o + 2] = qz;
      if (first || last) {
        // ends: hull normal leans along the tangent so the cap and side hull vertices coincide (no crack)
        const sg = first ? -0.7 : 0.7;
        let ox = qx + tx * sg, oy = qy + ty * sg, oz = qz + tz * sg; const ol = 1 / (Math.sqrt(ox * ox + oy * oy + oz * oz) || 1);
        ox *= ol; oy *= ol; oz *= ol;
        onrm[o] = ox; onrm[o + 1] = oy; onrm[o + 2] = oz;
        const oc = (base + (first ? t.cap0 : t.cap1) + k) * 3;
        pos[oc] = px; pos[oc + 1] = py; pos[oc + 2] = pz;
        onrm[oc] = ox; onrm[oc + 1] = oy; onrm[oc + 2] = oz;
      } else { onrm[o] = qx; onrm[o + 1] = qy; onrm[o + 2] = qz; }
    }
    if (first || last) {
      let cnx, cny, cnz;
      if (first) { cnx = -tx; cny = -ty; cnz = -tz; } else {
        cnx = tx - cut * Ax; cny = ty - cut * Ay; cnz = tz - cut * Az;
        const l = Math.hypot(cnx, cny, cnz); cnx /= l; cny /= l; cnz /= l;
      }
      const cb = base + (first ? t.cap0 : t.cap1);
      let mx = 0, my = 0, mz = 0;
      for (let k = 0; k < S; k++) {
        const oc = (cb + k) * 3;
        nrm[oc] = cnx; nrm[oc + 1] = cny; nrm[oc + 2] = cnz;
        mx += pos[oc]; my += pos[oc + 1]; mz += pos[oc + 2];
      }
      const oc = (cb + S) * 3;
      pos[oc] = mx / S; pos[oc + 1] = my / S; pos[oc + 2] = mz / S;
      nrm[oc] = cnx; nrm[oc + 1] = cny; nrm[oc + 2] = cnz;
      onrm[oc] = cnx; onrm[oc + 1] = cny; onrm[oc + 2] = cnz;
    }
  }
}

/**
 * Section indices worth probing against colliders (body side): the lower points of both edge beads and five points
 * across the bottom (-normal) face, which faces the limb the tail wraps, and two on the top face.
 */
export function ribbonProbes() {
  const b0 = RIBBON_FACE + 1 + BEAD, e0 = 2 * (RIBBON_FACE + 1) + BEAD;   // first bottom-face point (u = 1), a0 bead start
  // QA r3: both lower bead points on each side and five bottom-face points incl. the face ends (the deeper fold relief
  // left 2-3 mm between the old probes during drape transitions)
  return Int32Array.from([RIBBON_FACE + 2, RIBBON_FACE + 3, e0, e0 + 1, b0, b0 + 2, b0 + (RIBBON_FACE >> 1), b0 + RIBBON_FACE - 3, b0 + RIBBON_FACE,
    2, RIBBON_FACE - 2]);                                  // + the top face (a ribbon flipped by a fast move)
}

/** Constant per-vertex attributes for a layout (uv, matId, shadeBias, outlineWidth). */
export function ribbonConstAttributes(L, { matId, outlineWidth }) {
  const uv = new Float32Array(L.nv * 2), mat = new Float32Array(L.nv), ow = new Float32Array(L.nv);
  for (let v = 0; v < L.nv; v++) { uv[v * 2] = BLANK_UV[0]; uv[v * 2 + 1] = BLANK_UV[1]; mat[v] = matId; ow[v] = outlineWidth; }
  return { uv, mat, ow, bias: L.bias };
}
