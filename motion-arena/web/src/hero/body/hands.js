// Hand digits (4 fingers + thumb) for the LEFT hand in root-space rest coordinates. Owner: WP2.
//
// The palm is part of the arm loft (body.js), so forearm -> wrist -> palm is one continuous surface.
// Each digit is a closed ring loft built straight along its own axis, then bent at its joints with a
// smooth "bend deformer" (rotation about a pivot near the palmar side, ramped over a short window), so the
// same topology can be generated for any pose. body.js builds the digits at the relaxed pose (rest
// geometry) and at half-fist / full-fist poses (morph keyframes) — see buildDigits().
//
// Frame (left hand, T-pose, palm down): fingers point +X, dorsal (nail side) is +Y, thumb side is +Z.

import * as THREE from 'three';
import { ellipseRing, assembleLoft, roundEnd, smoothstep, bump } from './loft.js';

const DEG = Math.PI / 180;

/** Pose tables (degrees). Fingers: [MCP, PIP, DIP] flexion. Thumb: CMC swing + [MCP, IP]. */
export const HAND_POSE_ANGLES = {
  relaxed: {
    finger: (dims) => dims.HAND.relaxedCurlDeg, // 15 / 25 / 15 per spec 2.2
    spread: [3, 0.5, -2, -5],                     // index..pinky splay (deg, + toward thumb)
    thumb: { cmcIn: 12, cmcDown: 0, mcp: 6, ip: 10 },
  },
  half: {
    finger: () => [45, 52, 32],
    spread: [3, 1, -2, -5],
    thumb: { cmcIn: 40, cmcDown: 6, mcp: 20, ip: 18 },
  },
  fist: {
    finger: () => [88, 102, 62],
    spread: [1, 0, -1, -2],
    thumb: { cmcIn: 72, cmcDown: 8, mcp: 24, ip: 20 },
  },
};

/**
 * Digit layout derived from dims.HAND (palm 0.085 L x 0.078 W, fingers 0.090, pinky 0.8x, thumb 0.060
 * rooted 0.025 from the wrist on +Z, angled 40 deg forward).
 */
export function digitLayout(dims, wrist) {
  const H = dims.HAND;
  const kx = wrist.x + H.palm.l;              // knuckle line x (0.785)
  const halfW = H.palm.w / 2;
  const th = H.fingerThickness;               // [0.016, 0.018] diameters
  const L = H.fingerLength;
  // index, middle, ring, pinky (z from thumb side to pinky side)
  const fingers = [
    { name: 'index', z: halfW * 0.66, x: kx - 0.002, len: L * 0.94, d: th[1] * 0.98 },
    { name: 'middle', z: halfW * 0.22, x: kx + 0.001, len: L, d: th[1] },
    { name: 'ring', z: -halfW * 0.22, x: kx - 0.002, len: L * 0.94, d: th[1] * 0.94 },
    { name: 'pinky', z: -halfW * 0.64, x: kx - 0.009, len: L * H.pinkyScale, d: th[0] * 0.92 },
  ];
  const thumb = {
    name: 'thumb',
    root: new THREE.Vector3(wrist.x + H.thumb.rootFromWrist, wrist.y - 0.007, halfW * 0.62),
    len: H.thumb.length, d: th[1] * 1.08,
    yaw: H.thumb.angleDeg * DEG,              // forward (+Z) from the +X axis
    pitch: 12 * DEG,                          // down toward the palm side
  };
  return { fingers, thumb, knuckleX: kx };
}

/**
 * Bend a straight digit described in local coords. Local frame: f (along), u (dorsal), w = f x u.
 * joints: [{ s, angle, axis: 'w'|'u'|custom Vector3 (local), pivotU }] applied distal -> proximal.
 * Each joint rotates points with local s > joint.s about an axis through (s, pivotU), ramped over +-win.
 */
function bendLocal(p, joints, win) {
  // p: {s, u, w} -> mutated Vector3 in local coords (x=s, y=u, z=w)
  for (let j = joints.length - 1; j >= 0; j--) {
    const J = joints[j];
    const k = smoothstep(-win, win, p.x - J.s);
    if (k <= 0 || !J.angle) continue;
    const pivot = new THREE.Vector3(J.s, J.pivotU, 0);
    p.sub(pivot).applyAxisAngle(J.axis, J.angle * k).add(pivot);
  }
  return p;
}

/**
 * Build one digit loft. Returns raw arrays + anchors (nail centre / normal in root space).
 *   origin: Vector3 root position (knuckle), frame: { f, u, w } unit vectors (root space)
 *   len: visible length from the knuckle, d: diameter, segLen: [prox, mid, dist] fractions,
 *   joints: flexion angles (rad) [a0, a1, a2], extraRoot: Vector3 rotation applied at the root (thumb CMC)
 */
function buildDigit({ origin, frame, len, d, segFrac, flex, rootRot = null, buried = 0.012, segs, rect, isThumb = false }) {
  const rw = d * 0.55, rt = d * 0.45; // half width (w), half thickness (u)
  const sJ = [0, segFrac[0] * len, (segFrac[0] + segFrac[1]) * len];
  const fine = [];
  const s0 = -buried, s1 = len - rt * 0.9; // round end supplies the rest
  const N = 22;
  // local ring sampler: straight digit along +x
  const ringAt = (s) => {
    const t = (s - s0) / (s1 - s0);
    // taper + joint knuckle bulges + distal pad
    const taper = 1 - 0.20 * smoothstep(0.1, 1, t);
    const knuckle = 1 + 0.07 * bump(s - sJ[1], 0.006) + 0.05 * bump(s - sJ[2], 0.005) + (isThumb ? 0.05 * bump(s - sJ[1] * 0.2, 0.01) : 0.04 * bump(s - 0.002, 0.008));
    const rW = rw * taper * knuckle, rT = rt * taper * knuckle;
    // palmar pad of each phalanx (u < 0 side) and flatter nail (u > 0 side) near the tip
    const nailFlat = smoothstep(sJ[2] + 0.004, len - 0.006, s);
    const mod = (a) => {
      const up = Math.cos(a); // a = 0 -> palmar (e2 = -u), so cos a > 0 is palmar
      const pad = 0.10 * Math.max(0, up) * (0.5 + 0.5 * Math.sin(Math.PI * ((s - sJ[2]) / (len - sJ[2]) || 0)) * (s > sJ[2] ? 1 : 0.4));
      const flat = -0.12 * nailFlat * Math.max(0, -up) ** 2;
      return 1 + pad + flat;
    };
    return ellipseRing({
      c: new THREE.Vector3(s, 0, 0), e1: new THREE.Vector3(0, 0, 1), e2: new THREE.Vector3(0, -1, 0),
      rw: rW, rd: rT, mod, segs, superE: 2.2,
    });
  };
  for (let i = 0; i <= N; i++) fine.push(ringAt(s0 + (i / N) * (s1 - s0)));
  const end = roundEnd(fine[fine.length - 1], new THREE.Vector3(1, 0, 0), rt * 0.95, 3, 0.8);
  const rings = [...fine, ...end.rings];
  const raw = assembleLoft(rings, {
    capStart: { pole: new THREE.Vector3(s0 - rt * 0.6, 0, 0) }, capEnd: { pole: end.pole }, rect,
  });
  // bend + place
  const joints = [0, 1, 2].map((j) => ({
    s: sJ[j], angle: flex[j] || 0, axis: new THREE.Vector3(0, 0, -1), pivotU: -rt * 0.35,
  }));
  const M = new THREE.Matrix4().makeBasis(frame.f, frame.u, frame.w);
  const toRoot = (v) => {
    bendLocal(v, joints, 0.0065);
    v.applyMatrix4(M);
    if (rootRot) v.applyQuaternion(rootRot);
    return v.add(origin);
  };
  const v = new THREE.Vector3();
  for (let i = 0; i < raw.positions.length; i += 3) {
    v.set(raw.positions[i], raw.positions[i + 1], raw.positions[i + 2]);
    toRoot(v);
    raw.positions[i] = v.x; raw.positions[i + 1] = v.y; raw.positions[i + 2] = v.z;
  }
  // nail anchor: centre of the distal phalanx, dorsal surface
  const sNail = sJ[2] + 0.62 * (len - sJ[2]);
  const nailC = toRoot(new THREE.Vector3(sNail, rt * 0.9, 0));
  const nailUp = toRoot(new THREE.Vector3(sNail, rt * 0.9 + 0.02, 0)).sub(nailC).normalize();
  const nailF = toRoot(new THREE.Vector3(sNail + 0.01, rt * 0.9, 0)).sub(nailC).normalize();
  return { ...raw, nail: { c: nailC, n: nailUp, f: nailF, len: (len - sJ[2]) * 0.55, w: rw * 1.35 } };
}

/**
 * Build all five LEFT-hand digits for a pose name ('relaxed' | 'half' | 'fist').
 * rects: { index, middle, ring, pinky, thumb } UV rects. Returns { digits: [{ name, raw }], nails }.
 */
export function buildDigits(dims, wrist, pose, rects, segs = 10) {
  const P = HAND_POSE_ANGLES[pose];
  const lay = digitLayout(dims, wrist);
  const curl = P.finger(dims).map((a) => a * DEG);
  const out = [];
  lay.fingers.forEach((F, i) => {
    const spread = P.spread[i] * DEG;
    const f = new THREE.Vector3(Math.cos(spread), 0, Math.sin(spread));
    const u = new THREE.Vector3(0, 1, 0);
    const w = new THREE.Vector3().crossVectors(f, u);
    // relaxed fingers sit slightly lower toward the pinky (palm arch)
    const origin = new THREE.Vector3(F.x, wrist.y + 0.002 - 0.0025 * i, F.z);
    const raw = buildDigit({
      origin, frame: { f, u, w }, len: F.len, d: F.d, segFrac: [0.46, 0.30, 0.24],
      flex: curl.map((a, j) => a * (i === 3 && j === 0 ? 1.08 : 1)), segs, rect: rects[F.name],
    });
    out.push({ name: F.name, raw });
  });
  // thumb: forward (yaw toward +Z) and down (pitch toward -Y), nail facing out/up
  const T = lay.thumb, tp = P.thumb;
  const yaw = T.yaw, pitch = T.pitch;
  const f = new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)).normalize();
  // nail side: mostly +Y/+Z, roll the thumb ~70 deg so the pad faces the index finger
  const upHint = new THREE.Vector3(-0.35, 0.55, 0.75).normalize();
  const w = new THREE.Vector3().crossVectors(f, upHint).normalize();
  const u = new THREE.Vector3().crossVectors(w, f).normalize();
  // CMC: swing the whole thumb across the palm (about the hand's X axis + toward the palm)
  const qCmc = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), tp.cmcDown * DEG)                                       // roll down toward the palm
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tp.cmcIn * DEG * 0.9)); // swing across (toward -Z)
  const metacarpal = 0.030; // buried in the thenar mass, gives the thumb a proper base
  const raw = buildDigit({
    origin: T.root, frame: { f, u, w }, len: T.len + metacarpal, d: T.d, segFrac: [metacarpal / (T.len + metacarpal) + 0.0, 0.29, 0.31],
    flex: [0, tp.mcp * DEG, tp.ip * DEG], rootRot: qCmc, buried: 0.004, segs, rect: rects.thumb, isThumb: true,
  });
  out.push({ name: 'thumb', raw });
  return { digits: out, layout: lay };
}
