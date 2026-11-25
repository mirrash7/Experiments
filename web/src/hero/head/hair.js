// Hair package entry (spec 2.5, art-directed toward docs/reference.jpg). Owner: WP3. QA round 2 (D1/D3/P1-1/P1-5).
//
// A messy, voluminous, jet-black mop made of FEW, BIG, bold pointed clumps (32), each wide at the root with a
// confident taper to a sharp tip. Front silhouette 0.265 m = 1.42 temple widths (0.186) (lead's compromise between the spec's
// 1.30 and the reference's volume); the mass hugs the skull above the temples and flares out only at the tips.
//   cap      one closed shell (skull offset ~0.018 at the sides, 0.032 on top, 0.008 at the front hairline);
//            hairline 0.70 H at the front, 0.56 H at the temples, down to the nape.
//   bangs    7: five readable points across the forehead + two overlapping (one crossing), longest centre-left.
//   sides    3 per side (mirrored with asymmetry): temple lock toward the cheek, over-ear flare, behind-ear flare.
//   top      8: chunky crown clumps; a high pair in the coronal band breaks the top of the front silhouette.
//   back     6: down the back of the head, the outer two flaring out behind the ears.
//   nape     5: three that follow the head-neck line down to y ~1.48 (no bare occiput in profile) + two flicks.
// Each clump: a flattened, slightly crescent cross-section swept along a path on the skull (slerp root -> tip
// direction with a sideways bow), buried at the root, its offset rising to `lift` at the tip (pow curve `lp`,
// high on the sides so they hug the head and kick out late), with twist. 10 rings x 8 sides; ~6.0k tris
// total (sub-budget 8k). Closed meshes, FrontSide only.
//
// Shading: normals 65 % (dims.HAIR.normalProxyBlend) from an inflated hair-envelope ellipsoid + 35 % real, so
// the toon terminator reads as one mass; `outlineNormal` (hull + rim direction) = real normals 45 % toward the
// proxy, so the hull still separates clumps but the rim stays on the outer silhouette (no inner-edge scratches).
// Angel ring: `tangent` = root -> tip direction of the clump path, `clumpJitter` = per clump in [0, 1),
// `hairUV` (vec2) = (across: cos of the cross-section angle on the outer face, 2 on the inner face; along:
// root -> tip in [0, 1], -1 on the cap). materials/hair.js paints ONE broken band at a single head-space
// height (rest-pose y, 0.74 H) and uses hairUV / clumpJitter only to break it into zigzag per-clump segments.
// Skinning: head, plus hairBangs / hairL / hairR / hairBack ramping in from root to tip (WP5 springs).
//
// Builder contract: buildHair(ctx) -> { meshes, update?(dt, ctx), dispose(), api }

import * as THREE from 'three';
import { allocSkin, createSkinnedPair, mergeCharacterGeometries } from '../geo/attributes.js';
import { createHeadShape } from './head.js';

const D2R = Math.PI / 180;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Unit direction from yaw (0 = +Z front, +90 = +X character's left) and elevation (degrees). */
function dir(yaw, elev) {
  const y = yaw * D2R, e = elev * D2R;
  return new THREE.Vector3(Math.cos(e) * Math.sin(y), Math.sin(e), Math.cos(e) * Math.cos(y));
}
function toYawElev(d) {
  return [Math.atan2(d.x, d.z) / D2R, Math.asin(Math.max(-1, Math.min(1, d.y))) / D2R];
}

/**
 * Clump table. root/tip: [yawDeg, elevDeg] directions from the skull centre. lift: tip offset above the
 * cap (m). w: half base width (m). bow: sideways bend of the path (deg). twist (deg).
 * lp: lift curve power (high = hugs the head, kicks out late). kick: world-space tip push (m). bone: spring helper.
 */
function clumpTable(HAIR, rand) {
  const B = [];
  const jit = (a) => (rand() * 2 - 1) * a;
  // ---- bangs (7): tips at brow height, five points across the forehead, two overlapping; longest centre-left
  const bangs = [
    { root: [-5, 68], tip: [-10, 0], w: 0.043, lift: 0.012, bow: 3, twist: -8 },      // longest, centre-left
    { root: [17, 66], tip: [19, 9], w: 0.039, lift: 0.012, bow: -4, twist: 8 },
    { root: [-30, 63], tip: [-34, 6], w: 0.038, lift: 0.013, bow: -4, twist: 10 },
    { root: [39, 62], tip: [44, 7], w: 0.037, lift: 0.014, bow: 4, twist: -8 },
    { root: [-55, 56], tip: [-63, 6], w: 0.035, lift: 0.015, bow: -3, twist: 12 },
    { root: [-16, 64], tip: [4, 18], w: 0.034, lift: 0.016, bow: 6, twist: 6 },        // crossing L -> R, behind
    { root: [55, 57], tip: [62, 8], w: 0.037, lift: 0.015, bow: 4, twist: -10 },
  ];
  for (const b of bangs) B.push({ g: 'bangs', lp: 1.6, bone: 'hairBangs', gain: 0.9, taper: 1.0, ...b });

  // ---- sides, 3 per side (listed for the LEFT, +X side; the right side mirrors with small differences)
  const sides = [
    { root: [73, 54], tip: [79, 2], w: 0.036, lift: 0.012, lp: 2.0, bow: 3, kick: [0.0, 0, 0.004] },          // temple lock, toward the cheek
    { root: [96, 54], tip: [103, 6], w: 0.040, lift: 0.024, lp: 2.2, bow: -4, kick: [0.003, -0.004, 0] },     // over the ear, flares at the tip
    { root: [122, 50], tip: [126, -14], w: 0.040, lift: 0.026, lp: 2.0, bow: 4, kick: [0.003, -0.006, -0.004] }, // behind the ear
  ];
  const SIDE_TWIST = 30; // the tips turn their flat face toward the front so they read as bold wedges, not edges
  sides.forEach((s, i) => {
    B.push({ g: 'sides', bone: 'hairL', gain: 1, taper: 1.0, twist: SIDE_TWIST + jit(6), ...s });
    const dy = [0, -3, -2][i], dyaw = [2, -3, -2][i];
    B.push({
      g: 'sides', bone: 'hairR', gain: 1, taper: 1.0, twist: -SIDE_TWIST + jit(6), ...s,
      root: [-s.root[0] - dyaw * 0.5, s.root[1]], tip: [-s.tip[0] - dyaw, s.tip[1] + dy],
      lift: s.lift * (1 + jit(0.08)), bow: -s.bow, kick: s.kick && [-s.kick[0], s.kick[1], s.kick[2]],
    });
  });

  // ---- top (8): chunky crown clumps; the high pair lies in the coronal band so their tips break the top of
  // the front silhouette (tallest 10-20 deg off centre), the rest give the bumpy top / back outline
  const top = [
    { root: [-64, 76], tip: [-94, 30], w: 0.044, lift: 0.026, lp: 1.7 },   // upper-side spike (R)
    // QA r3 P2-2: this high pair read as two thin "horns" (~3:1 from the front). Base +30 %, path ~15 % shorter
    // (tip higher and less far out), lift lower and kicking out later, so they read as chunky crown locks.
    { root: [-10, 86], tip: [-54, 58], w: 0.055, lift: 0.033, lp: 1.5, twist: -10 },  // tallest, right of centre (screen left)
    { root: [10, 86], tip: [49, 60], w: 0.052, lift: 0.030, lp: 1.5, twist: 10 },     // high, left
    { root: [-30, 84], tip: [-22, 56], w: 0.044, lift: 0.024 },            // forward over the fringe roots
    { root: [60, 76], tip: [92, 32], w: 0.044, lift: 0.026, lp: 1.7 },     // upper-side spike (L)
    { root: [128, 84], tip: [108, 46], w: 0.046, lift: 0.030 },
    { root: [-128, 84], tip: [-110, 48], w: 0.046, lift: 0.030 },
    { root: [178, 86], tip: [176, 44], w: 0.048, lift: 0.028 },
  ];
  for (const t of top) B.push({ g: 'top', lp: 1.4, rampT: 0.3, bow: jit(8), taper: 1.0, gain: 0.6, ...t, twist: t.twist ?? jit(14) });

  // ---- back (6): down the back of the head; the outer two flare behind the ears
  const back = [
    { root: [180, 62], tip: [183, 0], w: 0.048, lift: 0.026 },
    { root: [150, 60], tip: [142, -2], w: 0.046, lift: 0.028 },
    { root: [211, 60], tip: [220, 0], w: 0.046, lift: 0.028 },
    { root: [132, 54], tip: [124, -16], w: 0.042, lift: 0.024, kick: [0.004, -0.004, 0] },
    { root: [228, 54], tip: [237, -14], w: 0.042, lift: 0.024, kick: [-0.004, -0.004, 0] },
    { root: [164, 76], tip: [158, 22], w: 0.044, lift: 0.022 },
  ];
  for (const b of back) B.push({ g: 'back', bone: 'hairBack', gain: 0.85, lp: 1.5, bow: jit(6), twist: jit(12), taper: 1.0, ...b });

  // ---- nape (5): three follow the head-neck line down to y ~1.48; the outer two flick outward
  const nape = [
    { root: [180, 18], tip: [181, -64], w: 0.052, lift: 0.010, lp: 1.6, kick: [0, -0.030, -0.002] },
    { root: [157, 16], tip: [152, -58], w: 0.044, lift: 0.012, lp: 1.6, kick: [0.004, -0.022, -0.002] },
    { root: [204, 16], tip: [209, -58], w: 0.044, lift: 0.012, lp: 1.6, kick: [-0.004, -0.022, -0.002] },
    { root: [132, 6], tip: [114, -40], w: 0.032, lift: 0.024, lp: 1.3, kick: [0.008, -0.004, 0] },   // flick, covers behind the ear
    { root: [228, 6], tip: [246, -38], w: 0.032, lift: 0.024, lp: 1.3, kick: [-0.008, -0.004, 0] },  // flick
  ];
  for (const n of nape) B.push({ g: 'nape', bone: 'hairBack', gain: 1, bow: jit(6), twist: jit(12), taper: 1.0, ...n });
  return { B };
}

export function buildHair(ctx) {
  const { rig, palette, materials, dims } = ctx;
  const { HAIR, BODY } = dims;
  const MAT = palette.MAT;
  const shape = createHeadShape(dims);
  const H = BODY.skullHeight, chinY = BODY.chinY;
  const C = shape.center;
  const rand = mulberry(0x5eed7);

  // inflated hair-envelope proxy for normals (one mass)
  const proxyC = new THREE.Vector3(0, chinY + 0.60 * H, -0.02);
  const proxyR = new THREE.Vector3(0.138, 0.148, 0.160);
  const proxyN = (p, out) => out.set((p.x - proxyC.x) / proxyR.x ** 2, (p.y - proxyC.y) / proxyR.y ** 2, (p.z - proxyC.z) / proxyR.z ** 2).normalize();
  const PROXY_BLEND = HAIR.normalProxyBlend ?? 0.65;
  const OUTLINE_PROXY = 0.45;

  const surf = (d, off = 0) => shape.surfaceAlong(d).addScaledVector(d, off);
  // cap thickness: thicker on top and at the back, slim at the sides (the mass hugs the skull above the
  // temples), thin at the front hairline (bangs cover it)
  const capOffAt = (d) => {
    const [yaw, elev] = toYawElev(d);
    const front = Math.max(0, Math.cos(yaw * D2R));
    const thin = front * (1 - smoothstep(28, 62, elev));
    const side = Math.abs(Math.sin(yaw * D2R)) * (1 - smoothstep(40, 75, elev));
    return 0.026 + 0.006 * smoothstep(35, 80, elev) - 0.008 * side - 0.018 * thin;
  };
  const geos = [];
  const B = rig.boneIndex;

  // ------------------------------------------------------------------ cap
  {
    const NC = 40, NR = 11; // QA r2: hair <= 8k tris
    const hlH = (ay) => {
      const k = [[0, 0.70], [35, 0.68], [62, 0.58], [80, 0.56], [96, 0.50], [108, 0.32], [124, 0.16], [150, 0.08], [180, 0.06]];
      for (let i = 0; i < k.length - 1; i++) if (ay <= k[i + 1][0]) { const t = (ay - k[i][0]) / (k[i + 1][0] - k[i][0]); return k[i][1] + (k[i + 1][1] - k[i][1]) * smoothstep(0, 1, t); }
      return 0.10;
    };
    const hlElev = (yaw) => {
      const target = chinY + hlH(Math.abs(((yaw + 540) % 360) - 180)) * H;
      let lo = -70, hi = 85;
      for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (surf(dir(yaw, m)).y > target) hi = m; else lo = m; }
      return (lo + hi) / 2;
    };
    const pos = [], tan = [], jit = [], ow = [], idx = [], ring = [], huv = [];
    for (let j = 0; j < NC; j++) ring.push(hlElev(-180 + (360 * j) / NC));
    const top = new THREE.Vector3(0, 1, 0);
    pos.push(...surf(top, capOffAt(top)).toArray()); tan.push(0, 0, -1); jit.push(rand()); ow.push(1); huv.push(2, -1);
    for (let i = 1; i <= NR; i++) for (let j = 0; j < NC; j++) {
      const yaw = -180 + (360 * j) / NC, t = i / NR;
      const elev = 90 - (90 - ring[j]) * t;
      const d = dir(yaw, elev);
      const off = capOffAt(d) * (1 - 0.8 * smoothstep(0.8, 1, t));
      const p = surf(d, off);
      pos.push(p.x, p.y, p.z);
      const p2 = surf(dir(yaw, elev - 2), off);
      const T = p2.sub(p).normalize();
      tan.push(T.x, T.y, T.z);
      jit.push(0.5); huv.push(2, -1);
      ow.push(i === NR ? 0 : 1);
    }
    for (let j = 0; j < NC; j++) idx.push(0, 1 + j, 1 + ((j + 1) % NC));
    for (let i = 1; i < NR; i++) for (let j = 0; j < NC; j++) {
      const a = 1 + (i - 1) * NC + j, b = 1 + (i - 1) * NC + ((j + 1) % NC), c = a + NC, d = b + NC;
      idx.push(a, d, b, a, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    finish(g, { tan, jit, ow, huv, weights: () => [[B.head, 1]] });
    geos.push(g);
  }

  // ------------------------------------------------------------------ clumps
  const { B: table } = clumpTable(HAIR, rand);
  const RINGS = 10, SIDES = 8; // 32 clumps x 160 tris + cap 840 = 5960 (sub-budget 8k)
  const stats = [];
  const tmp = new THREE.Vector3();
  table.forEach((c) => {
    const rootD = dir(...c.root), tipD = dir(...c.tip);
    const omega = rootD.angleTo(tipD);
    const perp = new THREE.Vector3().crossVectors(rootD, tipD).normalize();
    const bow = (c.bow || 0) * D2R;
    const kick = c.kick ? new THREE.Vector3(...c.kick) : null;
    const th0 = c.w * 0.5;
    const rampT = c.rampT ?? (c.g === 'bangs' ? 0.22 : 0.36);
    // path sample: direction on the skull + radial offset
    const pathDir = (t, out) => {
      const s = Math.sin(omega);
      out.copy(rootD).multiplyScalar(Math.sin((1 - t) * omega) / s).addScaledVector(tipD, Math.sin(t * omega) / s);
      return out.addScaledVector(perp, Math.tan(bow * Math.sin(Math.PI * t))).normalize();
    };
    const pathPos = (t, out) => {
      const d = pathDir(t, tmp.clone());
      const base = capOffAt(d) - th0 * 0.15;
      const off = base - (HAIR.clumpBury + th0) * (1 - smoothstep(0, rampT, t)) + c.lift * Math.pow(t, c.lp);
      out.copy(shape.surfaceAlong(d)).addScaledVector(d, off);
      if (kick) out.addScaledVector(kick, t * t);
      return out;
    };
    const tipsAt = [];
    const pos = [], tan = [], jit = [], ow = [], idx = [], tArr = [], huv = [];
    const J = rand();
    const p = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
    const T = new THREE.Vector3(), N = new THREE.Vector3(), Bn = new THREE.Vector3();
    let len = 0, prev = null;
    const twist = (c.twist || 0) * D2R;
    for (let r = 0; r < RINGS; r++) {
      const t = r / RINGS;
      pathPos(t, p);
      pathPos(Math.max(0, t - 0.02), pa); pathPos(Math.min(1, t + 0.02), pb);
      T.copy(pb).sub(pa).normalize();
      if (prev) len += prev.distanceTo(p);
      prev = p.clone();
      N.copy(p).sub(C).projectOnPlane(T).normalize();      // radial (thickness axis)
      Bn.crossVectors(T, N).normalize();                    // width axis, tangential to the head
      const tw = twist * (t * 1.6 - 0.3);
      const ct = Math.cos(tw), st = Math.sin(tw);
      // bold wedge: widest where it leaves the cap, then a confident, near-straight taper into a sharp point
      const prof = Math.pow(1 - t, c.taper) * (1 + 0.35 * t) * (0.8 + 0.2 * smoothstep(0, rampT, t));
      const w = c.w * prof, th = w * 0.46;
      for (let s = 0; s < SIDES; s++) {
        const a = (2 * Math.PI * s) / SIDES;
        const ca = Math.cos(a), sa = Math.sin(a);
        // crescent: outer face domed, inner face flatter and slightly concave
        const cw = ca * w, sh = sa > 0 ? sa * th : sa * th * 0.45 + 0.15 * th * (1 - ca * ca);
        const ox = cw * ct - sh * st, oy = cw * st + sh * ct;
        pos.push(p.x + Bn.x * ox + N.x * oy, p.y + Bn.y * ox + N.y * oy, p.z + Bn.z * ox + N.z * oy);
        tan.push(T.x, T.y, T.z); jit.push(J); tArr.push(t); huv.push(sa < -1e-6 ? 2 : ca, t);
        ow.push(t < 0.18 ? 0 : t < 0.35 ? smoothstep(0.18, 0.35, t) : 1 - (1 - dims.OUTLINE.width.hairTip) * smoothstep(0.45, 1, t));
      }
    }
    // tip vertex + root cap centre
    pathPos(1, p); pathPos(0.97, pa); T.copy(p).sub(pa).normalize();
    len += prev.distanceTo(p);
    tipsAt.push(p.clone());
    const tipI = pos.length / 3; pos.push(p.x, p.y, p.z); tan.push(T.x, T.y, T.z); jit.push(J); tArr.push(1); ow.push(dims.OUTLINE.width.hairTip); huv.push(0, 1);
    pathPos(0, p); pathPos(0.03, pb); T.copy(pb).sub(p).normalize();
    const rootI = pos.length / 3; pos.push(p.x, p.y, p.z); tan.push(T.x, T.y, T.z); jit.push(J); tArr.push(0); ow.push(0); huv.push(2, 0);
    for (let r = 0; r < RINGS - 1; r++) for (let s = 0; s < SIDES; s++) {
      const a = r * SIDES + s, b = r * SIDES + ((s + 1) % SIDES), cc = a + SIDES, d = b + SIDES;
      idx.push(a, cc, d, a, d, b);
    }
    const last = (RINGS - 1) * SIDES;
    for (let s = 0; s < SIDES; s++) {
      idx.push(last + s, tipI, last + ((s + 1) % SIDES));
      idx.push(s, ((s + 1) % SIDES), rootI);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    // spring helper: bangs / sides by side / nape; crown + mid split by where the tip ends up
    let bone = c.bone;
    const tip = tipsAt[0];
    if (!bone) {
      if (tip.z > 0.03) bone = 'hairBangs';
      else if (tip.z < -0.06 || Math.abs(tip.x) < 0.07) bone = 'hairBack';
      else bone = tip.x > 0 ? 'hairL' : 'hairR';
    }
    const bb = new THREE.Box3().setFromArray(pos);
    stats.push({ g: c.g, bone, len, aspect: len / (2 * c.w), tip: tip.toArray().map((v) => +v.toFixed(3)),
      maxAbsX: +Math.max(-bb.min.x, bb.max.x).toFixed(3), minY: +bb.min.y.toFixed(3) });
    const gain = c.gain ?? 1;
    finish(g, { tan, jit, ow, huv, weights: (i) => { const s = smoothstep(0.1, 0.85, tArr[i]) * gain; return [[B.head, 1 - s], [B[bone], s]]; } });
    geos.push(g);
  });
  const aspectMax = Math.max(...stats.map((s) => s.aspect));

  function finish(g, { tan, jit, ow, huv, weights }) {
    g.computeVertexNormals();
    const n = g.attributes.normal, p = g.attributes.position, cnt = p.count;
    // outlineNormal (outline hull + rim direction): real normals half-way to the proxy (QA r2 D3), so the rim
    // band stays on the outer silhouette instead of firing on every inner clump edge as scattered scratches;
    // the hull still separates clumps.
    const on = new Float32Array(cnt * 3);
    const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), o = new THREE.Vector3();
    for (let i = 0; i < cnt; i++) {
      v.fromBufferAttribute(p, i); a.fromBufferAttribute(n, i); proxyN(v, b);
      o.copy(a).multiplyScalar(1 - OUTLINE_PROXY).addScaledVector(b, OUTLINE_PROXY).normalize();
      on[3 * i] = o.x; on[3 * i + 1] = o.y; on[3 * i + 2] = o.z;
      a.multiplyScalar(1 - PROXY_BLEND).addScaledVector(b, PROXY_BLEND).normalize();
      n.setXYZ(i, a.x, a.y, a.z);
    }
    g.setAttribute('outlineNormal', new THREE.Float32BufferAttribute(on, 3));
    g.setAttribute('tangent', new THREE.Float32BufferAttribute(tan, 3));
    g.setAttribute('clumpJitter', new THREE.Float32BufferAttribute(jit, 1));
    g.setAttribute('hairUV', new THREE.Float32BufferAttribute(huv, 2));
    g.setAttribute('outlineWidth', new THREE.Float32BufferAttribute(ow, 1));
    g.setAttribute('matId', new THREE.Float32BufferAttribute(new Float32Array(cnt).fill(MAT.HAIR), 1));
    g.setAttribute('shadeBias', new THREE.Float32BufferAttribute(new Float32Array(cnt), 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(cnt * 2), 2)); // no detail atlas
    allocSkin(g);
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    for (let i = 0; i < cnt; i++) {
      const w = weights(i);
      si.setXYZW(i, w[0][0], w[1]?.[0] ?? 0, 0, 0);
      sw.setXYZW(i, w[0][1], w[1]?.[1] ?? 0, 0, 0);
    }
  }

  const geo = mergeCharacterGeometries(geos);
  const meshes = createSkinnedPair(geo, materials.hair, materials.outline, rig, { name: 'hair' });
  const tris = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  return {
    meshes,
    api: { clumps: table.length, stats, aspectMax, tris, geo },
    dispose() { geo.dispose(); },
  };
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
