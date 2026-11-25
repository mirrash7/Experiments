// Canvas-painted body detail atlas (1024²). Owner: WP2. Contract (materials/index.js, WP1):
//   R = line mask (toward the material's line colour), G = force shade, B = highlight (lit side only).
//   Linear data: NoColorSpace. flipY = false, so uv (u, v) is canvas pixel (u * S, v * S).
//   The atlas is shared by every mesh on the `body` material (costume included): uv (0,0) and the
//   whole 0.02-wide border stay black, so geometry with no painted detail maps there.
//
// Strokes are authored in 3D (front-projected points on the torso, (x, angle) on the arm, (y, angle) on
// the leg, nail frames from hands.js / toe table) and projected onto the rest-pose loft geometry by ray
// casting, which returns the interpolated uv. Stroke width is converted from metres to pixels with the
// local uv scale, so lines keep an even world width despite loft uv stretch. Left/right limbs share uv
// (mirrored), so limbs are painted once from the left side; the torso is painted on both sides.

import * as THREE from 'three';

/** uv rects [u0, v0, u1, v1] for every body loft (shared by left/right limbs). */
export const ATLAS_RECTS = Object.freeze({
  torso: [0.02, 0.02, 0.62, 0.62],
  leg: [0.64, 0.02, 0.98, 0.72],
  arm: [0.02, 0.64, 0.24, 0.98],
  index: [0.26, 0.64, 0.32, 0.82],
  middle: [0.335, 0.64, 0.395, 0.82],
  ring: [0.41, 0.64, 0.47, 0.82],
  pinky: [0.485, 0.64, 0.545, 0.82],
  thumb: [0.56, 0.64, 0.62, 0.82],
});

const CH = { R: [255, 0, 0], G: [0, 255, 0], B: [0, 0, 255] };

export function paintBodyAtlas({ dims, torso, arm, leg, digits, toes }) {
  const S = dims.SHADING.detailAtlas;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const meshes = { torso: triSoup(torso), arm: triSoup(arm), leg: triSoup(leg) };
  for (const d of digits) meshes[d.name] = triSoup(d.geo);

  const J = dims.JOINT_WORLD;
  const armY = J.leftUpperArm[1], legX = J.leftThigh[0];
  /** projectors: return { o, d } rays */
  const P = {
    torso: ([x, y]) => ({ o: new THREE.Vector3(x, y, 0.5), d: new THREE.Vector3(0, 0, -1) }),
    torsoBack: ([x, y]) => ({ o: new THREE.Vector3(x, y, -0.5), d: new THREE.Vector3(0, 0, 1) }),
    arm: ([x, th]) => ({ o: new THREE.Vector3(x, armY + 0.3 * Math.sin(th), 0.3 * Math.cos(th)), d: new THREE.Vector3(0, -Math.sin(th), -Math.cos(th)) }),
    leg: ([y, th]) => ({ o: new THREE.Vector3(legX + 0.3 * Math.sin(th), y, 0.3 * Math.cos(th)), d: new THREE.Vector3(-Math.sin(th), 0, -Math.cos(th)) }),
  };
  const hit = (meshKey, ray) => raycastSoup(meshes[meshKey], ray.o, ray.d);

  /**
   * Paint a polyline. pts: authored points for the projector; widthM: world width (m);
   * ch: 'R'|'G'|'B'; alpha; taper: 0 = none, 1 = pointed ends; soft: halo multiplier.
   */
  function stroke(meshKey, proj, pts, widthM, ch, alpha = 1, { taper = 1, soft = 1.9, samples = 2 } = {}) {
    // densify
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      for (let s = 0; s < samples; s++) {
        const t = s / samples;
        dense.push(pts[i].map((v, k) => v + (pts[i + 1][k] - v) * t));
      }
    }
    dense.push(pts[pts.length - 1]);
    const H = dense.map((q) => hit(meshKey, proj(q)));
    const n = H.length;
    const [r, gg, b] = CH[ch];
    for (let pass = 0; pass < 2; pass++) {
      const wMul = pass === 0 ? soft : 1, aMul = pass === 0 ? 0.35 : 0.75;
      for (let i = 0; i < n - 1; i++) {
        const A = H[i], B = H[i + 1];
        if (!A || !B) continue;
        if (Math.abs(A.uv.x - B.uv.x) > 0.1 || Math.abs(A.uv.y - B.uv.y) > 0.1) continue; // uv seam
        const dPx = Math.hypot((A.uv.x - B.uv.x) * S, (A.uv.y - B.uv.y) * S);
        const dM = A.p.distanceTo(B.p) || 1e-6;
        const pxPerM = dPx / dM || 600;
        const t = (i + 0.5) / (n - 1);
        const tap = taper ? Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.55 * taper) : 1;
        g.strokeStyle = `rgba(${r},${gg},${b},${alpha * aMul})`;
        g.lineWidth = Math.max(0.8, widthM * pxPerM * tap * wMul);
        g.beginPath();
        g.moveTo(A.uv.x * S, A.uv.y * S);
        g.lineTo(B.uv.x * S, B.uv.y * S);
        g.stroke();
      }
    }
  }
  const both = (meshKey, proj, pts, ...rest) => {
    stroke(meshKey, proj, pts, ...rest);
    stroke(meshKey, proj, pts.map(([x, y]) => [-x, y]), ...rest);
  };
  const curve = (fn, a, b, n = 12) => Array.from({ length: n + 1 }, (_, i) => fn(a + ((b - a) * i) / n));

  /** Filled patch from a ring of 3D rays (nails). */
  function fillPatch(meshKey, rays, ch, alpha) {
    const H = rays.map((ray) => hit(meshKey, ray)).filter(Boolean);
    if (H.length < 3) return;
    const [r, gg, b] = CH[ch];
    g.fillStyle = `rgba(${r},${gg},${b},${alpha})`;
    g.beginPath();
    H.forEach((h, i) => (i ? g.lineTo(h.uv.x * S, h.uv.y * S) : g.moveTo(h.uv.x * S, h.uv.y * S)));
    g.closePath();
    g.fill();
    return H;
  }
  function outlinePatch(H, ch, alpha, widthPx) {
    const [r, gg, b] = CH[ch];
    g.strokeStyle = `rgba(${r},${gg},${b},${alpha})`;
    g.lineWidth = widthPx;
    g.beginPath();
    H.forEach((h, i) => (i ? g.lineTo(h.uv.x * S, h.uv.y * S) : g.moveTo(h.uv.x * S, h.uv.y * S)));
    g.closePath();
    g.stroke();
  }
  /** Nail: superellipse in the frame (c, n, f), projected along -n. */
  function nail(meshKey, c, n, f, len, w, { lunule = true, lineA = 0.8, lineW = 0.0013, fillB = 0.75, fillG = 0, tipB = 0, rays: nRays = 28 } = {}) {
    const side = new THREE.Vector3().crossVectors(n, f).normalize();
    const shape = (sc, f0 = 0) => {
      const out = [];
      for (let i = 0; i < nRays; i++) {
        const a = (i / nRays) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const ex = ca > 0 ? 3.2 : 2.2;
        const rx = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / ex), ry = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / 3);
        const p = c.clone().addScaledVector(f, f0 + rx * len * 0.5 * sc).addScaledVector(side, ry * w * 0.5 * sc);
        out.push({ o: p.clone().addScaledVector(n, 0.03), d: n.clone().negate() });
      }
      return out;
    };
    // squarer at the tip (front), rounder at the cuticle
    const rays = shape(1);
    const H = fillB > 0 ? fillPatch(meshKey, rays, 'B', fillB) : null;
    const HG = fillG > 0 ? fillPatch(meshKey, rays, 'G', fillG) : null;
    if (tipB > 0) {   // lighter free edge: a crescent at the tip end of the nail (front of the frame)
      const tip = shape(0.5, len * 0.27).filter((r, i) => Math.cos((i / nRays) * Math.PI * 2) > -0.2);
      if (tip.length > 2) fillPatch(meshKey, tip, 'B', tipB);
    }
    const HO = H || HG;
    if (HO && lineA > 0) {
      const j = Math.min(HO.length - 1, nRays >> 1);
      const pxPerM = HO.length > 2 ? Math.hypot((HO[0].uv.x - HO[j].uv.x) * S, (HO[0].uv.y - HO[j].uv.y) * S) / (HO[0].p.distanceTo(HO[j].p) || 1) : 1000;
      outlinePatch(HO, 'R', lineA, Math.max(1, lineW * pxPerM));
    }
    if (lunule) { // cuticle line slightly darker
      const pts = [];
      for (let i = -4; i <= 4; i++) {
        const t = i / 4;
        pts.push(c.clone().addScaledVector(f, -len * 0.30 + 0.12 * len * t * t).addScaledVector(side, t * w * 0.38));
      }
      const H2 = pts.map((p) => hit(meshKey, { o: p.clone().addScaledVector(n, 0.03), d: n.clone().negate() })).filter(Boolean);
      if (H2.length > 2) {
        const pxPerM = Math.hypot((H2[0].uv.x - H2[H2.length - 1].uv.x) * S, (H2[0].uv.y - H2[H2.length - 1].uv.y) * S) / (H2[0].p.distanceTo(H2[H2.length - 1].p) || 1);
        g.strokeStyle = 'rgba(255,0,0,0.25)';
        g.lineWidth = Math.max(0.8, 0.0008 * pxPerM);
        g.beginPath();
        H2.forEach((h, i) => (i ? g.lineTo(h.uv.x * S, h.uv.y * S) : g.moveTo(h.uv.x * S, h.uv.y * S)));
        g.stroke();
      }
    }
  }

  // ================================================================ torso
  const neckY = J.neck[1];
  // pec lower contour: sternum -> under the pec -> up into the armpit
  const pecY = (x) => 1.243 + 0.9 * (x - 0.05) ** 2 + 9 * Math.max(0, x - 0.10) ** 2;
  const pecPts = [...curve((x) => [x, pecY(x)], 0.014, 0.118, 14), [0.126, 1.268], [0.130, 1.29]];
  both('torso', P.torso, pecPts, 0.0034, 'R', 0.95);
  // under-pec forced shade band (anime shadow shape)
  both('torso', P.torso, curve((x) => [x, pecY(x) - 0.0045], 0.02, 0.112, 12), 0.0085, 'G', 0.95, { taper: 1.6, soft: 1.2 });
  // pec top highlight
  both('torso', P.torso, curve((x) => [x, 1.322 - 0.6 * (x - 0.07) ** 2], 0.04, 0.10, 6), 0.006, 'B', 0.45, { taper: 1.5 });
  // sternum
  stroke('torso', P.torso, [[0, 1.335], [0, 1.30], [0, 1.262]], 0.0022, 'R', 0.55);
  // clavicles (+ highlight above)
  both('torso', P.torso, curve((x) => [x, neckY - 0.022 + 0.004 * Math.sin(Math.PI * (x - 0.02) / 0.11) - 0.012 * (x > 0.10 ? (x - 0.10) / 0.03 : 0)], 0.022, 0.125, 10), 0.0024, 'R', 0.7);
  both('torso', P.torso, curve((x) => [x, neckY - 0.014 + 0.004 * Math.sin(Math.PI * (x - 0.02) / 0.11)], 0.03, 0.11, 8), 0.004, 'B', 0.35, { taper: 1.5 });
  // jugular notch
  both('torso', P.torso, [[0.014, neckY - 0.016], [0.004, neckY - 0.026]], 0.0018, 'R', 0.5);
  // sternocleidomastoid
  both('torso', P.torso, curve((t) => [0.036 - 0.022 * t, 1.485 - 0.074 * t + 0.01 * t * (1 - t)], 0, 1, 8), 0.0018, 'R', 0.45);
  // linea alba + abs (3 tendinous rows) + rectus outer edge
  stroke('torso', P.torso, curve((y) => [0, y], 1.228, 1.0, 14), 0.0024, 'R', 0.7);
  // each tendinous row: short, bowed down in the middle of the block, kicking up at the outer edge
  for (const [yr, len, a] of [[1.172, 0.050, 0.8], [1.108, 0.054, 0.75], [1.046, 0.050, 0.6]]) {
    both('torso', P.torso, curve((t) => [0.007 + len * t, yr - 0.006 * Math.sin(Math.PI * t) + 0.012 * t ** 3], 0, 1, 8), 0.0026, 'R', a, { taper: 1 });
    // small forced-shade wedge under the outer end of each row (block relief)
    both('torso', P.torso, curve((t) => [0.03 + 0.03 * t, yr - 0.004 - 0.006 * Math.sin(Math.PI * t) + 0.01 * t ** 3], 0, 1, 5), 0.004, 'G', 0.55, { taper: 2, soft: 1.1 });
  }
  both('torso', P.torso, curve((t) => [0.068 - 0.006 * t * t - 0.02 * Math.max(0, t - 0.8) * 5, 1.205 - 0.215 * t], 0, 1, 12), 0.0022, 'R', 0.45);
  // navel
  stroke('torso', P.torso, curve((a) => [0.0035 * Math.sin(a), 0.986 + 0.006 * Math.cos(a)], Math.PI * 0.15, Math.PI * 1.85, 10), 0.0018, 'R', 0.8, { taper: 0.4 });
  stroke('torso', P.torso, [[0, 0.982], [0, 0.988]], 0.004, 'G', 0.8, { taper: 0.5, soft: 1 });
  // serratus ticks + oblique + adonis lines
  for (let k = 0; k < 3; k++) {
    const y = 1.212 - k * 0.026;
    both('torso', P.torso, [[0.104 + k * 0.003, y], [0.121 + k * 0.002, y + 0.013]], 0.0018, 'R', 0.5);
  }
  both('torso', P.torso, curve((t) => [0.104 - 0.016 * t, 1.12 - 0.13 * t], 0, 1, 8), 0.002, 'R', 0.35);
  both('torso', P.torso, curve((t) => [0.098 - 0.06 * t, 0.988 - 0.085 * t - 0.01 * t * (1 - t)], 0, 1, 8), 0.0024, 'R', 0.5);
  // back: spine groove and shoulder-blade hints (mostly under the shirt, but read in the shirtless QA view)
  stroke('torso', P.torsoBack, curve((y) => [0, y], 1.38, 0.98, 12), 0.0024, 'R', 0.35);
  both('torso', P.torsoBack, curve((t) => [0.055 + 0.02 * Math.sin(Math.PI * t), 1.33 - 0.11 * t], 0, 1, 8), 0.002, 'R', 0.3);

  // ================================================================ arm (painted once, mirrored)
  const el = J.leftForeArm[0], wr = J.leftHand[0];
  // inner elbow crease and olecranon
  stroke('arm', P.arm, curve((th) => [el - 0.001 + 0.006 * (th / 0.55) ** 2, th], -0.55, 0.55, 10), 0.0016, 'R', 0.32);
  stroke('arm', P.arm, curve((th) => [el + 0.012 - 0.012 * Math.cos((th - Math.PI) * 2), th], Math.PI - 0.55, Math.PI + 0.55, 10), 0.0018, 'R', 0.45);
  // biceps / deltoid separation (shows when the sleeve rides up) and forearm brachioradialis edge
  stroke('arm', P.arm, curve((t) => [J.leftUpperArm[0] + 0.07 + 0.06 * t, 0.9 - 0.6 * t], 0, 1, 8), 0.0016, 'R', 0.18);
  stroke('arm', P.arm, curve((t) => [el + 0.04 + 0.12 * t, 0.35 + 0.25 * t], 0, 1, 8), 0.0016, 'R', 0.3);
  // wrist creases (palm side, two arcs either side of the seam) + dorsal knuckle ticks
  stroke('arm', P.arm, curve((th) => [wr + 0.004, th], -Math.PI / 2 + 0.08, -0.35, 6), 0.0014, 'R', 0.4);
  stroke('arm', P.arm, curve((th) => [wr + 0.004, th], -Math.PI + 0.35, -Math.PI / 2 - 0.08, 6), 0.0014, 'R', 0.4);
  stroke('arm', P.arm, curve((th) => [wr + 0.03 + 0.01 * Math.cos(th + 0.5), th], -0.95, -0.15, 6), 0.0014, 'R', 0.35); // thenar crease

  // ================================================================ digits: fingernails + knuckle creases
  for (const d of digits) {
    const N = d.nail;
    nail(d.name, N.c, N.n, N.f, N.len, N.w);
  }

  // ================================================================ leg: knee, shin, ankle, toenails
  const kn = J.leftShin[1];
  stroke('leg', P.leg, curve((th) => [kn + 0.034 - 0.012 * (th / 0.55) ** 2, th], -0.55, 0.55, 10), 0.0022, 'R', 0.55); // patella top
  stroke('leg', P.leg, curve((th) => [kn - 0.006 + 0.012 * (th / 0.5) ** 2, th], -0.5, 0.5, 10), 0.002, 'R', 0.5);     // patella bottom
  stroke('leg', P.leg, curve((t) => [kn + 0.075 - 0.04 * t, -0.95 + 0.25 * t], 0, 1, 6), 0.0018, 'R', 0.35);          // vastus medialis
  stroke('leg', P.leg, curve((t) => [kn - 0.03 - 0.2 * t, -0.42 + 0.1 * t], 0, 1, 10), 0.0016, 'R', 0.28);            // tibia / calf edge
  stroke('leg', P.leg, curve((t) => [kn + 0.02 - 0.012 * t, 0.15 * (t - 0.5)], 0, 1, 4), 0.009, 'B', 0.3, { taper: 1.5 }); // patella highlight
  stroke('leg', P.leg, curve((y) => [y, 0.12], kn - 0.05, J.leftFoot[1] + 0.07, 10), 0.006, 'B', 0.28, { taper: 1.5 });     // shin highlight
  // ankle bones (medial / lateral malleolus arcs)
  const an = J.leftFoot[1];
  stroke('leg', P.leg, curve((a) => [an + 0.004 + 0.009 * Math.cos(a), -Math.PI / 2 + 0.22 * Math.sin(a)], 0.3, Math.PI - 0.3, 8), 0.0014, 'R', 0.22);
  stroke('leg', P.leg, curve((a) => [an - 0.006 + 0.009 * Math.cos(a), Math.PI / 2 + 0.22 * Math.sin(a)], 0.3, Math.PI - 0.3, 8), 0.0014, 'R', 0.22);
  // toenails (from above), QA r3 P2-6: small clean painted shapes, a touch pinker / lighter than the skin, never white
  // blobs. Nail bed = faint forced-shade wash (G, a hint of the warm pink shade tone in light), soft highlight wash
  // (B) with a lighter free edge at the tip. No dark outline: the foot uv squeezes a toenail to ~3 texels across, so a
  // 1 px line ring read as a brown smudge. Kept well inside the toe's top so it never wraps.
  const sole = dims.SANDAL.sole;
  for (const [tx, r, tip] of toes) {
    const c = new THREE.Vector3(tx + (tx - legX) * 0.08, sole + 2 * r + 0.004, tip - r * 1.3);
    nail('leg', c, new THREE.Vector3(0, 1, 0.25).normalize(), new THREE.Vector3(0, -0.25, 1).normalize(), r * 0.95, r * 0.88,
      { lunule: false, lineA: 0, fillB: 0.32, fillG: 0.06, tipB: 0.22, rays: 24 });
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  tex.name = 'heroBodyDetailAtlas';
  tex.userData.canvas = canvas;
  return tex;
}

/** Flatten an indexed geometry into triangle arrays (v0, edge1, edge2, uv) for fast ray casts. */
function triSoup(geo) {
  const P = geo.attributes.position.array, U = geo.attributes.uv.array, I = geo.index.array;
  const n = I.length / 3;
  const T = new Float32Array(n * 9), UV = new Float32Array(n * 6);
  for (let t = 0; t < n; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      T[t * 9 + k] = P[a * 3 + k];
      T[t * 9 + 3 + k] = P[b * 3 + k] - P[a * 3 + k];
      T[t * 9 + 6 + k] = P[c * 3 + k] - P[a * 3 + k];
    }
    UV[t * 6] = U[a * 2]; UV[t * 6 + 1] = U[a * 2 + 1];
    UV[t * 6 + 2] = U[b * 2]; UV[t * 6 + 3] = U[b * 2 + 1];
    UV[t * 6 + 4] = U[c * 2]; UV[t * 6 + 5] = U[c * 2 + 1];
  }
  return { T, UV, n };
}

/** Nearest double-sided ray/triangle hit (Moller-Trumbore). Returns { uv: Vector2, p: Vector3 } or null. */
function raycastSoup(S, o, d) {
  const { T, UV, n } = S;
  let best = Infinity, bi = -1, bu = 0, bv = 0;
  const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
  for (let t = 0; t < n; t++) {
    const k = t * 9;
    const e1x = T[k + 3], e1y = T[k + 4], e1z = T[k + 5], e2x = T[k + 6], e2y = T[k + 7], e2z = T[k + 8];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = ox - T[k], sy = oy - T[k + 1], sz = oz - T[k + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt > 1e-6 && tt < best) { best = tt; bi = t; bu = u; bv = v; }
  }
  if (bi < 0) return null;
  const w = 1 - bu - bv, j = bi * 6;
  return {
    uv: new THREE.Vector2(w * UV[j] + bu * UV[j + 2] + bv * UV[j + 4], w * UV[j + 1] + bu * UV[j + 3] + bv * UV[j + 5]),
    p: new THREE.Vector3(ox + dx * best, oy + dy * best, oz + dz * best),
  };
}
