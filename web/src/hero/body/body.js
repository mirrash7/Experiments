// Body package entry. Owner: WP2. See docs/character-art-spec.md 2.2 / 2.13 and hero/CONTRACTS.md.
//
// One continuous skinned skin mesh (+ its outline hull) made of ring lofts:
//   torso + neck  one loft (hips -> neck top), horizontal sections of an implicit anatomy volume
//                 (pelvis, abdomen + rectus, ribcage, lats, pecs, traps, clavicles, glutes, neck)
//   arm (x2)      shoulder root -> deltoid -> elbow -> forearm -> wrist -> palm -> knuckles, from the 2.2
//                 radius tables (Catmull-Rom) with muscle modulation; forearm-to-hand has no seam
//   digits (x2)   4 fingers + thumb (hands.js), relaxed rest pose, fist via morph targets
//   leg (x2)      hip -> thigh -> knee -> shin -> ankle -> foot -> toes in ONE loft: horizontal leg
//                 sections, a fan of sections around the ankle (heel), vertical foot sections to the toes
// Shoulder and hip roots overlap the torso under the costume (spec 2.13 hidden-junction rule) and share
// the same weight fields there (weights.js).
//
// Builder contract: buildBody(ctx) -> { meshes, update(dt, ctx), dispose(), api: { setHandPose } }.
//
// Exposes `detailAtlas` (CanvasTexture, also set on the shared body material via setDetailAtlas) and
// `bodyInfo` (tris, build ms, ring counts) on its result for QA tools; api.setFistAmount(v, side) for QA.
// REQUEST(WP3): neck loft ends at y 1.555 (inside the jaw) with radius dims.BODY.neckRadius; the head must
//   cover y >= 1.49 at the front and >= 1.50 at the back. Neck skin blends neck -> head over y 1.47..1.53.
// REQUEST(WP4): skin offsets are measured from this mesh; the shoulder/arm-root and thigh-top overlap
//   zones use weights.js fields (armOwn/legOwn), so cloth there should copy weights from the body
//   (copySkinFromNearest against parts.body.meshes[0].geometry) to stay locked to the skin.
// REQUEST(WP1/WP6): the body uses 4 morph targets (fistHalfL, fistL, fistHalfR, fistR); the hull mesh
//   shares morphTargetInfluences, so the outline material must keep the morph chunks.

import * as THREE from 'three';
import { ensureCharacterAttributes, createSkinnedPair } from '../geo/attributes.js';
import { setDetailAtlas } from '../materials/index.js';
import {
  smoothstep as S, bump, angDiff, lerp, profileSampler, ellipseRing, sdfRing, solidMid, pickRings,
  assembleLoft, roundEnd, makeGeometry, computeWeldedNormals, mirrorX,
} from './loft.js';
import { buildDigits } from './hands.js';
import { computeSkinWeights, PART } from './weights.js';
import { paintBodyAtlas, ATLAS_RECTS } from './detailAtlas.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ implicit primitives
function sdEll(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const k1 = Math.sqrt((px / rx) ** 2 + (py / ry) ** 2 + (pz / rz) ** 2);
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
/** Capsule with linearly varying radius (round cone, approximate). sz scales z (elliptic section). */
function sdCone(x, y, z, a, b, ra, rb, sz = 1) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = (b[2] - a[2]) * sz;
  const px = x - a[0], py = y - a[1], pz = (z - a[2]) * sz;
  const l2 = bx * bx + by * by + bz * bz;
  const t = Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / l2));
  return Math.hypot(px - bx * t, py - by * t, pz - bz * t) - (ra + (rb - ra) * t);
}
function smin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}
const smax = (a, b, k) => -smin(-a, -b, k);

// ------------------------------------------------------------------ torso volume (symmetric in x)
function makeTorsoSDF(dims) {
  const B = dims.BODY;
  const shX = dims.JOINT_WORLD.leftUpperArm[0];   // traps / clavicles end relative to the shoulder joint
  const nk = B.neckRadius;
  const neckBase = dims.JOINT_WORLD.neck[1];
  return (p) => {
    const x = Math.abs(p.x), y = p.y, z = p.z;
    let d = sdEll(x, y, z, 0, 0.885, -0.010, B.pelvisSkin.w / 2 - 0.004, 0.115, B.pelvisSkin.d / 2 - 0.003);   // pelvis
    d = smin(d, sdEll(x, y, z, 0, 1.05, -0.002, B.waist.w / 2 - 0.004, 0.17, B.waist.d / 2 - 0.003), 0.05);      // abdomen
    d = smin(d, sdEll(x, y, z, 0, 1.252, -0.014, B.chest.w / 2 - 0.013, 0.172, 0.088), 0.05);                   // ribcage
    d = smin(d, sdEll(x, y, z, 0.093, 1.215, -0.030, 0.056, 0.12, 0.058), 0.03);                                // lats (V taper)
    d = smin(d, sdEll(x, y, z, 0.058, 1.292, 0.044, 0.068, 0.050, 0.040), 0.014);                               // pecs
    d = smin(d, sdEll(x, y, z, 0.033, 1.105, 0.030, 0.042, 0.135, 0.052), 0.02);                                // rectus abdominis
    d = smin(d, sdCone(x, y, z, [0.030, neckBase - 0.012, -0.018], [shX - 0.020, 1.360, -0.008], 0.039, 0.039), 0.045); // traps -> shoulder
    d = smin(d, sdCone(x, y, z, [0.016, neckBase - 0.022, 0.040], [shX - 0.040, neckBase - 0.018, 0.006], 0.0095, 0.011), 0.014); // clavicles
    d = smin(d, sdEll(x, y, z, 0.066, 0.858, -0.052, 0.070, 0.074, 0.056), 0.03);                               // glutes
    d = smin(d, sdCone(x, y, z, [0, neckBase - 0.06, -0.012], [0, 1.565, -0.006], nk.w, nk.w * 0.86, nk.w / nk.d), 0.035); // neck (tapers into the jaw: no tube shows behind the jaw on head turns)
    return d;
  };
}

// ------------------------------------------------------------------ leg + foot volume (left leg)
function makeLegSDF(dims) {
  const J = dims.JOINT_WORLD, P = dims.PROFILES, F = dims.FOOT, sole = dims.SANDAL.sole;
  const hipY = J.leftThigh[1], kneeY = J.leftShin[1], thighL = dims.LENGTHS.thigh, shinL = dims.LENGTHS.shin;
  const lx = J.leftThigh[0];
  // combined table along L = hipY - y; thigh rows narrowed/shifted medially at the very top so the
  // thigh stays inside the pelvis / shorts (hidden region, see report)
  const rows = [
    [-0.09, 0.050, 0.060, [-0.022, 0, -0.006]],
    [0.0, 0.069, P.thigh[0][2] - 0.004, [-0.016, 0, -0.004]],
    [P.thigh[1][0] * thighL, 0.074, P.thigh[1][2], [-0.002, 0, 0]],
    ...P.thigh.slice(2, 4).map((r) => [r[0] * thighL, r[1], r[2], [0, 0, 0]]),
    [thighL, P.shin[0][1], P.shin[0][2], [0, 0, 0.004]],
    ...P.shin.slice(1).map((r) => [thighL + r[0] * shinL, r[1], r[2], r[3] || [0, 0, 0]]),
    [thighL + shinL + 0.035, P.shin[5][1] * 0.97, P.shin[5][2] * 0.97, [0, 0, -0.002]],
  ];
  const prof = profileSampler(rows);
  const Lk = hipY - kneeY;
  const legMod = (L, th) => {
    const back = angDiff(th, Math.PI), front = th;
    let m = 1;
    m += 0.085 * bump(L - (Lk - 0.012), 0.024) * bump(front, 0.6);           // patella
    m += 0.03 * bump(L - (Lk + 0.035), 0.02) * bump(front, 0.4);             // patellar tendon / tibial tuberosity
    m -= 0.045 * bump(L - (Lk + 0.01), 0.028) * bump(back, 0.55);            // popliteal hollow
    m += 0.05 * bump(L - (Lk + 0.10), 0.055) * bump(angDiff(th, -2.35), 0.7); // medial gastrocnemius (lower, back-inside)
    m += 0.03 * bump(L - (Lk + 0.075), 0.05) * bump(angDiff(th, 2.4), 0.6);   // lateral gastrocnemius
    m += 0.025 * bump(L - (Lk + 0.20), 0.12) * bump(front + 0.2, 0.35);       // tibia crest
    m -= 0.07 * bump(L - (thighL + shinL - 0.02), 0.04) * bump(back, 0.45);   // achilles narrowing
    m += 0.03 * bump(L - 0.25, 0.08) * bump(angDiff(th, 1.2), 0.6);           // vastus lateralis
    m += 0.035 * bump(L - (Lk - 0.07), 0.04) * bump(angDiff(th, -0.9), 0.5);  // vastus medialis teardrop
    return m;
  };
  const limb = (x, y, z) => {
    const L = hipY - y;
    const s = prof(L);
    const cx = lx + s.o[0], cz = s.o[2];
    const dx = x - cx, dz = z - cz;
    const th = Math.atan2(dx, dz);
    const rho = Math.hypot(dx / s.rw, dz / s.rd) / legMod(L, th);
    let d = (rho - 1) * Math.min(s.rw, s.rd);
    d = smax(d, (J.leftFoot[1] - 0.03) - y, 0.01); // the limb ends inside the heel
    return d;
  };
  const toes = [ // x, radius, tip z  (big toe first; medial is -x for the left foot)
    [lx - 0.032, F.bigToeWidth / 2, J.leftToe[2] + 0.002],
    [lx - 0.011, 0.0079, J.leftToe[2] - 0.004],
    [lx + 0.006, 0.0073, J.leftToe[2] - 0.012],
    [lx + 0.0215, 0.0068, J.leftToe[2] - 0.021],
    [lx + 0.0355, 0.0062, J.leftToe[2] - 0.031],
  ];
  const fy0 = sole; // bottom of the foot = top of the sandal sole
  return {
    toes,
    sdf: (p) => {
      const { x, y, z } = p;
      let f = sdEll(x, y, z, lx, fy0 + 0.031, -0.033, F.heelWidth / 2, 0.031, 0.034);               // heel
      f = smin(f, sdEll(x, y, z, lx + 0.002, fy0 + 0.020, 0.045, 0.040, 0.027, 0.085), 0.02);       // midfoot
      f = smin(f, sdEll(x, y, z, lx - 0.002, fy0 + 0.014, 0.108, F.ballWidth / 2, 0.017, 0.032), 0.02); // ball
      f = smin(f, sdCone(x, y, z, [lx, J.leftFoot[1] + 0.006, 0.012], [lx - 0.004, fy0 + 0.026, 0.104], 0.025, 0.015), 0.022); // instep
      for (const [tx, r, tip] of toes) {
        f = smin(f, sdCone(x, y, z, [tx, fy0 + r + 0.003, 0.108], [tx + (tx - lx) * 0.08, fy0 + r + 0.0015, tip - r], r * 1.05, r), 0.008);
      }
      f = smin(f, sdEll(x, y, z, lx - 0.024, J.leftFoot[1] + 0.004, 0.002, 0.010, 0.013, 0.012), 0.012); // medial malleolus
      f = smin(f, sdEll(x, y, z, lx + 0.026, J.leftFoot[1] - 0.006, -0.006, 0.010, 0.013, 0.012), 0.012); // lateral malleolus
      let d = smin(limb(x, y, z), f, 0.022);
      d = smax(d, fy0 - y, 0.004); // flat sole
      return d;
    },
    prof, legMod,
  };
}

// ------------------------------------------------------------------ arm rings (left arm, along +X)
function armRows(dims) {
  const J = dims.JOINT_WORLD, P = dims.PROFILES;
  const sh = J.leftUpperArm[0], el = J.leftForeArm[0], wr = J.leftHand[0];
  const ua = P.upperArm, fa = P.foreArm;
  // rows: [x, rY (frontal-plane width), rZ (depth), [0, oy, oz]]
  const rows = [
    // arm root (hidden under the shirt), placed relative to the joint (dims.SHOULDER_DECISION)
    [sh - 0.070, 0.042, 0.042, [0, -0.006, -0.004]],
    [sh - 0.035, 0.046, 0.045, [0, -0.009, -0.003]],
    ...ua.slice(0, 5).map((r, i) => [sh + r[0] * (el - sh), r[1] * (i < 2 ? 0.95 : 1), r[2], [0, (r[3] || [0, 0, 0])[1] - [0.011, 0.008, 0.002, 0, 0][i], (r[3] || [0, 0, 0])[2]]]),
    [el, fa[0][1], fa[0][2], [0, 0, 0]],
    [el + fa[1][0] * (wr - el), fa[1][1], fa[1][2], fa[1][3]],
    [el + fa[2][0] * (wr - el), fa[2][1], fa[2][2], [0, 0.002, 0]],
    // distal forearm: wrist is flat and wide across the palm (thumb-pinky axis = Z when palm down)
    ...fa.slice(3).map((r) => [el + r[0] * (wr - el), r[2], r[1], [0, 0, 0]]),
    // palm (dims.HAND.palm 0.085 L x 0.078 W x 0.026 T)
    [wr + 0.012, 0.0165, 0.030, [0, -0.001, 0.001]],
    [wr + 0.025, 0.0158, 0.035, [0, -0.0015, 0.002]],
    [wr + 0.045, 0.0145, dims.HAND.palm.w / 2 - 0.0005, [0, -0.001, 0.001]],
    [wr + 0.065, dims.HAND.palm.t / 2 + 0.0005, dims.HAND.palm.w / 2, [0, 0, 0]],
    [wr + 0.080, 0.0125, dims.HAND.palm.w / 2 - 0.0005, [0, 0.0005, 0]],
  ];
  return { rows, sh, el, wr, end: wr + 0.080 };
}

function armMod(x, th, dims) {
  const J = dims.JOINT_WORLD;
  const sh = J.leftUpperArm[0], el = J.leftForeArm[0], wr = J.leftHand[0];
  const back = angDiff(th, Math.PI), top = angDiff(th, Math.PI / 2), bot = angDiff(th, -Math.PI / 2);
  let m = 1;
  m += 0.022 * bump(x - (sh + 0.02), 0.04) * bump(top, 1.0);                 // deltoid cap
  m += 0.03 * bump(x - (sh + 0.025), 0.035) * bump(angDiff(th, 0.5), 0.6);   // anterior deltoid
  m += 0.04 * bump(x - (sh + 0.155), 0.05) * bump(th, 0.7);                  // biceps
  m += 0.035 * bump(x - (sh + 0.13), 0.055) * bump(back, 0.8);               // triceps
  m += 0.075 * bump(x - (el + 0.002), 0.013) * bump(back, 0.45);             // olecranon
  m -= 0.03 * bump(x - el, 0.018) * bump(th, 0.6);                           // inner elbow
  m += 0.03 * bump(x - el, 0.016) * (bump(top, 0.45) + bump(bot, 0.45));     // epicondyles
  m += 0.045 * bump(x - (el + 0.05), 0.04) * bump(angDiff(th, 1.0), 0.7);    // brachioradialis
  m += 0.03 * bump(x - (el + 0.06), 0.05) * bump(angDiff(th, 2.3), 0.7);     // extensors (dorsal, pinky side)
  m += 0.045 * bump(x - (wr - 0.012), 0.010) * bump(angDiff(th, 2.5), 0.45); // ulnar head
  // palm: thenar (thumb side, palmar), hypothenar, palm hollow, dorsal knuckle line
  m += 0.20 * bump(x - (wr + 0.025), 0.018) * bump(angDiff(th, -0.55), 0.55);
  m += 0.08 * bump(x - (wr + 0.04), 0.03) * bump(angDiff(th, -2.5), 0.5);
  m -= 0.10 * bump(x - (wr + 0.05), 0.02) * bump(bot, 0.5);
  m += 0.05 * bump(x - (wr + 0.08), 0.008) * bump(top, 0.9);
  return m;
}

// ------------------------------------------------------------------ builder
export function buildBody(ctx) {
  const { rig, palette, materials, dims } = ctx;
  const t0 = performance.now();
  const T = {};
  const { MAT } = palette;
  const J = dims.JOINT_WORLD;
  const R = ATLAS_RECTS;

  // ======== torso + neck
  const torsoSDF = makeTorsoSDF(dims);
  const TSEG = 32;
  const torsoFine = [];
  const yBot = 0.79, yTop = 1.555;
  let prev = null;
  const zAxisDown = V3(0, 0, -1);
  for (let y = yBot; y <= yTop + 1e-6; y += 0.004) {
    const mid = solidMid(torsoSDF, V3(0, y, -0.25), V3(0, 0, 1), 0, 0.5, 0.003);
    const c = V3(0, y, mid ? mid.t - 0.25 : -0.01);
    // e2 = -Z puts the UV seam on the back midline (hidden by the shirt)
    prev = sdfRing({ c, e1: V3(1, 0, 0), e2: zAxisDown, sdf: torsoSDF, segs: TSEG, guess: prev?.radii, rMax: 0.32, symmetric: true });
    torsoFine.push(prev);
  }
  const torsoRings = pickRings(torsoFine, 0.021, (r) => (r.c.y > 1.37 && r.c.y < 1.46 ? 0.6 : 1));
  const torsoRaw = assembleLoft(torsoRings, {
    capStart: { pole: V3(0, yBot - 0.012, torsoRings[0].c.z) },
    capEnd: { pole: V3(0, yTop + 0.012, torsoRings[torsoRings.length - 1].c.z) },
    rect: R.torso,
  });

  T.arm0 = performance.now();
  // ======== left arm (+palm)
  const AR = armRows(dims);
  const armProf = profileSampler(AR.rows);
  const ASEG = 20;
  const armFine = [];
  for (let x = AR.rows[0][0]; x <= AR.end + 1e-6; x += 0.003) {
    const s = armProf(x);
    const superE = lerp(2, 2.7, S(AR.wr - 0.002, AR.wr + 0.06, x));
    // e2 = -Y (underside) puts the seam under the arm / on the palm centre
    const e1 = V3(0, 0, 1), e2 = V3(0, -1, 0);
    const mod = (a) => armMod(x, Math.atan2(-Math.cos(a), Math.sin(a)), dims);
    armFine.push(ellipseRing({ c: V3(x, J.leftUpperArm[1] + s.o[1], s.o[2]), e1, e2, rw: s.rd, rd: s.rw, mod, segs: ASEG, superE }));
  }
  const armDense = (r) => {
    const x = r.c.x;
    return Math.abs(x - AR.el) < 0.055 || Math.abs(x - AR.wr) < 0.035 ? 0.62 : 1;
  };
  const armRings = pickRings(armFine, 0.02, armDense);
  const armEnd = roundEnd(armRings[armRings.length - 1], V3(1, 0, 0), 0.011, 3, 0.9);
  const armRaw = assembleLoft([...armRings, ...armEnd.rings], {
    capStart: { pole: V3(AR.rows[0][0] - 0.012, J.leftUpperArm[1] - 0.002, -0.004) }, capEnd: { pole: armEnd.pole }, rect: R.arm,
  });

  T.dig0 = performance.now();
  // ======== left digits: rest (relaxed) + morph keyframes
  const wrist = V3(...J.leftHand);
  const digitRects = { index: R.index, middle: R.middle, ring: R.ring, pinky: R.pinky, thumb: R.thumb };
  const dRest = buildDigits(dims, wrist, 'relaxed', digitRects);
  const dHalf = buildDigits(dims, wrist, 'half', digitRects);
  const dFist = buildDigits(dims, wrist, 'fist', digitRects);
  const catDigits = (set) => {
    const out = { positions: [], uvs: [], index: [] };
    for (const { raw } of set.digits) {
      const base = out.positions.length / 3;
      out.positions.push(...raw.positions); out.uvs.push(...raw.uvs);
      for (const i of raw.index) out.index.push(i + base);
    }
    return out;
  };
  const digRaw = catDigits(dRest), digHalf = catDigits(dHalf), digFist = catDigits(dFist);

  T.leg0 = performance.now();
  // ======== left leg + foot
  const LEG = makeLegSDF(dims);
  const legSDF = LEG.sdf;
  const LSEG = 24;
  const lx = J.leftThigh[0];
  const legFine = [];
  let lp = null;
  const pivot = V3(lx, J.leftFoot[1] + 0.045, 0.072); // fan pivot line (along X) in front of the ankle
  const toeWeight = (k) => (k > 0 ? (a) => 1 + 0.8 * k * bump(angDiff(a, Math.PI), 1.2) : null);
  const centreAlong = (p0, dir, t0x, t1x) => {
    const m = solidMid(legSDF, p0, dir, t0x, t1x, 0.0025);
    return m ? p0.clone().addScaledVector(dir, m.t) : null;
  };
  const refineX = (c) => {
    const m = solidMid(legSDF, V3(c.x - 0.09, c.y, c.z), V3(1, 0, 0), 0, 0.18, 0.0025);
    if (m) c.x = c.x - 0.09 + m.t;
    return c;
  };
  // (1) horizontal sections down the leg
  for (let y = 0.955; y >= pivot.y - 1e-6; y -= 0.004) {
    const L = J.leftThigh[1] - y;
    const s = LEG.prof(L);
    const c = V3(lx + s.o[0], y, s.o[2]);
    if (y > J.leftFoot[1] + 0.085) {
      // above the ankle the volume is exactly the analytic limb: sample it directly (fast path)
      const mod = (a) => LEG.legMod(L, Math.atan2(Math.sin(a), -Math.cos(a)));
      lp = ellipseRing({ c, e1: V3(1, 0, 0), e2: V3(0, 0, -1), rw: s.rw, rd: s.rd, mod, segs: LSEG });
      lp.radii = null;
    } else {
      lp = sdfRing({ c, e1: V3(1, 0, 0), e2: V3(0, 0, -1), sdf: legSDF, segs: LSEG, guess: lp?.radii });
    }
    lp.zone = 0;
    legFine.push(lp);
  }
  // (2) fan around the ankle: half-planes through the pivot line
  for (let phi = 2.25; phi <= 90 - 1e-6; phi += 2.25) {
    const a = (phi * Math.PI) / 180;
    const dir = V3(0, -Math.sin(a), -Math.cos(a));
    let c = centreAlong(pivot, dir, 0.0, 0.2) || legFine[legFine.length - 1].c.clone();
    c = refineX(c);
    lp = sdfRing({ c, e1: V3(1, 0, 0), e2: dir, sdf: legSDF, segs: LSEG, guess: lp?.radii });
    lp.zone = 1;
    legFine.push(lp);
  }
  // (3) vertical sections along the foot to the toe tips
  let lastC = null;
  for (let z = pivot.z; z <= 0.2; z += 0.003) {
    const k = S(0.02 + pivot.z, 0.11, z);
    let c = centreAlong(V3(lx - 0.01, 0, z), V3(0, 1, 0), 0.0, 0.12);
    if (!c) break;
    // keep the centre on the solid's x mid at that height (follows the big toe medially)
    c = refineX(c);
    if (!(legSDF(c) < 0)) break;
    const ring = sdfRing({ c, e1: V3(1, 0, 0), e2: V3(0, -1, 0), sdf: legSDF, segs: LSEG, guess: lp?.radii, weightFn: toeWeight(k) });
    let maxR = 0;
    for (let i = 0; i < ring.radii.length; i++) maxR = Math.max(maxR, ring.radii[i]);
    if (maxR < 0.0065) break;
    ring.zone = 2;
    lp = ring; lastC = c;
    legFine.push(ring);
  }
  const legDense = (r) => {
    if (r.zone === 0) return Math.abs(r.c.y - J.leftShin[1]) < 0.07 ? 0.62 : r.c.y < 0.2 ? 0.75 : 1;
    if (r.zone === 1) return 0.7;
    return r.c.z > 0.105 ? 0.42 : 0.8;
  };
  const legRings = pickRings(legFine, 0.021, legDense);
  const legRaw = assembleLoft(legRings, {
    capStart: { pole: V3(legRings[0].c.x, 0.968, legRings[0].c.z) },
    capEnd: { pole: lastC.clone().add(V3(0, 0, 0.0025)) },
    rect: R.leg,
  });

  T.asm0 = performance.now();
  // ======== assemble both sides
  const parts = [];
  const pushPart = (raw, part, opts = {}) => parts.push({ raw, part, ...opts });
  pushPart(torsoRaw, PART.TORSO);
  pushPart(armRaw, PART.ARM);
  pushPart(mirrorX(armRaw), PART.ARM);
  pushPart(digRaw, PART.DIGIT, { morph: [digHalf, digFist], side: 'left' });
  pushPart(mirrorX(digRaw), PART.DIGIT, { morph: [mirrorX(digHalf), mirrorX(digFist)], side: 'right' });
  pushPart(legRaw, PART.LEG);
  pushPart(mirrorX(legRaw), PART.LEG);

  const positions = [], uvs = [], index = [], partOf = [];
  const morphHL = [], morphFL = [], morphHR = [], morphFR = []; // full-length position arrays
  for (const P of parts) {
    const base = positions.length / 3;
    const n = P.raw.positions.length / 3;
    positions.push(...P.raw.positions); uvs.push(...P.raw.uvs);
    for (const i of P.raw.index) index.push(i + base);
    for (let i = 0; i < n; i++) partOf.push(P.part);
    for (const [arrH, arrF, sd] of [[morphHL, morphFL, 'left'], [morphHR, morphFR, 'right']]) {
      if (P.morph && P.side === sd) { arrH.push(...P.morph[0].positions); arrF.push(...P.morph[1].positions); } else { arrH.push(...P.raw.positions); arrF.push(...P.raw.positions); }
    }
  }
  const geo = makeGeometry({ positions, uvs, index });
  const restN = geo.attributes.normal.array;

  // ---- character attributes
  const nV = positions.length / 3;
  const shadeBias = new Float32Array(nV), outlineWidth = new Float32Array(nV).fill(dims.OUTLINE.width.default);
  const SB = dims.SHADING.shadeBias;
  for (let i = 0; i < nV; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2], X = Math.abs(x), part = partOf[i];
    let b = 0;
    if (part === PART.DIGIT) { outlineWidth[i] = dims.OUTLINE.width.finger; b = -0.06; }
    // armpit hollow
    b += SB.crease * bump(Math.hypot(X - (J.leftUpperArm[0] - 0.015), y - 1.295, (z + 0.005) * 0.8), 0.04);
    // under the chin / jaw shadow on the neck front
    if (part === PART.TORSO) b += SB.crease * S(J.head[1] - 0.025, J.head[1] - 0.005, y) * S(-0.03, 0.03, z); // neck crease under the jaw: 0 -> -0.3 over 0.02 up to 1.49 (WP3 request, QA P0-11)
    // pec underside crease
    if (part === PART.TORSO && z > 0.02 && X > 0.012 && X < 0.135) {
      const yp = 1.246 + 0.9 * (X - 0.055) ** 2;
      b += -0.24 * bump(y - (yp - 0.006), 0.009) * S(0.012, 0.03, X);
    }
    // collar line at the neck base (under the shirt collar)
    if (part === PART.TORSO) b += -0.12 * bump(y - (J.neck[1] + 0.012), 0.012) * S(0.0, 0.03, -z + 0.03);
    // behind the knee / inner elbow / inner thigh / crotch
    if (part === PART.LEG) {
      b += -0.26 * bump(y - (J.leftShin[1] - 0.008), 0.02) * S(-0.02, -0.042, z) * bump(X - J.leftThigh[0], 0.03);
      b += -0.16 * S(0.05, 0.015, X) * S(0.62, 0.78, y);
    }
    if (part === PART.ARM) b += -0.14 * bump(X - J.leftForeArm[0], 0.02) * S(0.01, 0.03, z);
    if (part === PART.TORSO && y < 0.86) b += SB.crease * S(0.05, 0.0, X);
    shadeBias[i] = Math.max(SB.min, Math.min(SB.max, b));
  }
  geo.setAttribute('shadeBias', new THREE.BufferAttribute(shadeBias, 1));
  geo.setAttribute('outlineWidth', new THREE.BufferAttribute(outlineWidth, 1));
  ensureCharacterAttributes(geo, { matId: MAT.SKIN });

  T.sw0 = performance.now();
  // ---- skin weights
  const sw = computeSkinWeights(new Float32Array(positions), index, partOf, rig, dims);
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sw.skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw.skinWeight, 4));

  T.morph0 = performance.now();
  // ---- fist morph targets (relative): half + full keyframes per hand (piecewise-linear drive)
  const morphPos = [], morphNor = [];
  const names = ['fistHalfL', 'fistL', 'fistHalfR', 'fistR'];
  for (const arr of [morphHL, morphFL, morphHR, morphFR]) {
    const d = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) d[i] = arr[i] - positions[i];
    const nPose = computeWeldedNormals(geo, new Float32Array(arr));
    const dn = new Float32Array(nPose.length);
    for (let i = 0; i < nPose.length; i++) dn[i] = nPose[i] - restN[i];
    morphPos.push(new THREE.BufferAttribute(d, 3));
    morphNor.push(new THREE.BufferAttribute(dn, 3));
  }
  geo.morphAttributes.position = morphPos;
  geo.morphAttributes.normal = morphNor;
  geo.morphTargetsRelative = true;

  T.atlas0 = performance.now();
  // ---- detail atlas (shared by everything on the body material; uv (0,0) corner stays black)
  const paintGeos = {
    torso: makeGeometry(torsoRaw), arm: makeGeometry(armRaw), leg: makeGeometry(legRaw),
    digits: dRest.digits.map((d) => ({ name: d.name, geo: makeGeometry(d.raw), nail: d.raw.nail })),
  };
  const atlas = paintBodyAtlas({ dims, palette, ...paintGeos, toes: LEG.toes });
  [paintGeos.torso, paintGeos.arm, paintGeos.leg, ...paintGeos.digits.map((d) => d.geo)].forEach((g) => g.dispose());
  setDetailAtlas(materials.body, atlas);

  T.end0 = performance.now();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const meshes = createSkinnedPair(geo, materials.body, materials.outline, rig, { name: 'body' });
  const mesh = meshes[0];
  mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
  mesh.morphTargetInfluences = new Array(names.length).fill(0);
  for (const m of meshes.slice(1)) { m.morphTargetDictionary = mesh.morphTargetDictionary; m.morphTargetInfluences = mesh.morphTargetInfluences; }

  // ---- hand pose state
  const handPose = { left: 'relaxed', right: 'relaxed' };
  const fist = { left: 0, right: 0 };
  const FIST_RATE = 14; // 1/s exponential approach (~0.1 s to close)
  const drive = () => {
    const I = mesh.morphTargetInfluences;
    for (const [sd, o] of [['left', 0], ['right', 2]]) {
      const f = fist[sd];
      I[o] = f <= 0.5 ? 2 * f : 2 - 2 * f;
      I[o + 1] = f <= 0.5 ? 0 : 2 * f - 1;
    }
  };

  const tris = index.length / 3;
  const bodyInfo = {
    tris, vertices: nV, buildMs: Math.round(performance.now() - t0), stageMs: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, Math.round(v - t0)])),
    rings: { torso: torsoRings.length, arm: armRings.length, leg: legRings.length }, segs: { torso: TSEG, arm: ASEG, leg: LSEG, digit: 10 },
  };

  return {
    meshes,
    detailAtlas: atlas,
    bodyInfo,
    update(dt) {
      const k = 1 - Math.exp(-FIST_RATE * (dt || 0));
      for (const sd of ['left', 'right']) fist[sd] += ((handPose[sd] === 'fist' ? 1 : 0) - fist[sd]) * k;
      drive();
    },
    api: {
      /** pose: 'relaxed' | 'fist'; side: 'left' | 'right' | 'both'. Drives the fist morph targets. */
      setHandPose(pose, side = 'both') {
        for (const s of side === 'both' ? ['left', 'right'] : [side]) handPose[s] = pose === 'fist' ? 'fist' : 'relaxed';
      },
      getHandPose: (side) => handPose[side],
      /** QA: set the fist amount immediately (0..1). */
      setFistAmount(v, side = 'both') { for (const s of side === 'both' ? ['left', 'right'] : [side]) fist[s] = v; drive(); },
    },
    dispose() {
      setDetailAtlas(materials.body, null);
      geo.dispose();
      atlas.dispose();
    },
  };
}
