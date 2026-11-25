// Secondary motion (WP5): verlet sash tails + CPU ribbon, jiggle springs (shirt hem, sleeve cuffs, hair),
// velocity fur squash. Owner: WP5. Spec 2.12, acceptance WP5 (section 3), QA H.
//
//   const dyn = createDynamics(ctx);      // after all builders ran (needs ctx.parts.costume.api for the sash)
//   dyn.update(dt, ctx);                  // each frame, after rig.updateHelpers + part updates, before materials
//   dyn.reset();                          // teleport / recalibration (also auto-detected: big hips jumps)
//
// Integration: substeps of <= 1/120 s (n = ceil(dt·120), max 4 per frame; up to 8 when a collider sweeps
// fast), simulated time capped at 4/120 s so a 100 ms hitch can't explode anything (the rest is dropped).
// Kinematic inputs (anchor, colliders) are interpolated across the substeps. Inputs are low-passed with a
// 60 ms EMA (dims.DYNAMICS.velocityEmaMs) and clamped. No allocations per frame.
//
// REQUEST(WP6): call hero.resetDynamics() from the game's recalibrate handler and after any root teleport
//   (main.js `retarget.recalibrate()` sites). Large jumps are auto-detected, this just makes it explicit.
//
// QA r2 P1-4 (tail flares sideways for 3-6 frames on fast pose changes). Causes: (1) on a preset snap the knot slides
// up to 0.85 rad around the band and the hips can jump, so the pinned root and the rest-shape targets teleported and
// the distance/shape constraints turned that into a whip; (2) the 60 ms EMA hips velocity used as the damping
// reference kept dragging the tail along the snap direction for ~4-6 frames after the body had stopped; (3) colliders
// teleporting through the tail (raised thigh) kicked it at up to 5 m/s. Fixes: VerletChain.capture() carries the chain
// rigidly with the part of the anchor / knot motion that exceeds plausible speeds (anchor 3 m/s / 10 rad/s, knot
// relative to hips 0.8 m/s / 6 rad/s) and blends the rest frame forward by the same fraction; the damping reference
// is the hips velocity clamped to 2.5 m/s BEFORE the EMA; the per-frame relative speed cap drops from 3 m/s to
// 1.2 m/s while a collider moves implausibly fast (snap). The ribbon low-passes the knot axis.

// QA r3 P0-1 (tail 0.119 m under the floor in Deep squat): (1) floor constraint. The floor is the ground plane the
// character is planted in: the world y of hero.root's PARENT origin (the arena floor, y = 0). Not hero.root's own y:
// the pose presets plant the feet by moving root.position.y (-0.555 m in Deep squat), the game's retargeter moves the
// hips instead and keeps the root on the floor, so root.parent is the plane in both. `dyn.floorY` (number) overrides
// it. Tail particles stay >= floor + FLOOR_CLEAR with tangential friction (VerletChain._floor), and the rendered
// ribbon (rings between particles, cut-end corners) is lifted ring by ring to >= floor + 0.006 (sashRibbon), lying
// flat (ring normal -> up, twist / curl / S-bend relaxed) where it touches. (2) Deep knot-side hip flexion (> ~80 deg):
// the long tail's rest targets blend to a drape that runs from the knot along the upper-outer surface of the knot-side
// thigh collider and over the knee (DRAPE_*), with a stiffer rest spring and a relaxed knot ceiling, so the tail
// rests on the thigh instead of hanging to the floor.

import * as THREE from 'three';
import { MotionTracker, JiggleBone, emaAlpha } from './springs.js';
import { VerletChain, createColliders } from './verlet.js';
import { createSashRibbon } from './sashRibbon.js';
import { TAIL_STYLE } from '../costume/accessories.js';

/** Spring layout: [helper, group, lever (bone-local m)]. Levers point from the pivot to the cloth/hair mass. */
const SPRINGS = [
  ['shirtHemL', 'shirtHem', [0.010, -0.085, 0.010]],
  ['shirtHemR', 'shirtHem', [-0.010, -0.085, 0.010]],
  ['shirtHemBack', 'shirtHem', [0, -0.085, -0.010]],
  ['sleeveCuffL', 'sleeveCuff', [0.060, 0, 0]],
  ['sleeveCuffR', 'sleeveCuff', [-0.060, 0, 0]],
  ['hairBangs', 'hair', [0, -0.080, 0.025]],
  ['hairL', 'hair', [0.012, -0.120, 0]],
  ['hairR', 'hair', [-0.012, -0.120, 0]],
  ['hairBack', 'hair', [0, -0.150, -0.020]],
];
/** Feel tuning per group (dims has k/d/max): input gains + noise dead-zones (m/s², rad/s²) after the EMA. */
const GAINS = {
  shirtHem: { gain: 0.55, gravityGain: 0.12, deadA: 0.6, deadAlpha: 4 },
  sleeveCuff: { gain: 0.35, gravityGain: 0.05, deadA: 1.0, deadAlpha: 30 },
  hair: { gain: 0.45, gravityGain: 0.25, deadA: 0.8, deadAlpha: 25 },
};
/** WP2 fallback colliders (root-space rest -> bone-local) when the costume api is missing. */
function fallbackColliders(rig) {
  const W = rig.restWorld;
  const defs = [{ type: 'ellipsoid', bone: 'hips', center: [0, 0.885 - W.hips.y, -0.01], radii: [0.145, 0.115, 0.095] }];
  for (const [s, sx] of [['left', 1], ['right', -1]]) {
    defs.push({ type: 'capsule', bone: `${s}Thigh`, a: [sx * 0.080 - sx * 0.088, 0, 0], b: [0, 0.465 - 0.865, 0], r0: 0.075, r1: 0.052 });
    defs.push({ type: 'capsule', bone: `${s}Shin`, a: [0, 0, 0], b: [0, 0.09 - 0.465, 0], r0: 0.052, r1: 0.031 });
  }
  return defs;
}

/** Resample a polyline (Vector3[]) to n points by arc length. */
function resample(pts, n) {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const tot = L[L.length - 1], out = [];
  for (let k = 0; k < n; k++) {
    const s = (tot * k) / (n - 1);
    let j = 1; while (j < L.length - 1 && L[j] < s) j++;
    const t = THREE.MathUtils.clamp((s - L[j - 1]) / Math.max(L[j] - L[j - 1], 1e-9), 0, 1);
    out.push(new THREE.Vector3().lerpVectors(pts[j - 1], pts[j], t));
  }
  return out;
}

/** Relative speed cap (m/s) normally / while a collider snaps; plausible-motion limits for the rigid carry. */
const MAX_REL = 3.0, MAX_REL_SNAP = 1.2, SNAP_SPEED = [3.0, 6.0], AV_MAX = 2.5;
const TELEPORT = [0.2, 9], PREROLL = 10;
const CARRY = Object.freeze({ anchorLin: 3.0, anchorAng: 10, knotLin: 0.8, knotAng: 6 });
/** Particle floor clearance (m, >= the 0.006 ribbon clearance + the ribbon's half thickness and fold relief). */
const FLOOR_CLEAR = 0.012;
/** Thigh drape: knot-side hip flexion window (rad), weight time constant (s), hold stiffness (1/s²), ceiling relief (m). */
const DRAPE_FLEX = [70 * Math.PI / 180, 92 * Math.PI / 180], DRAPE_TAU = 0.12, DRAPE_K = 90, DRAPE_LIFT = 0.25;
/**
 * Drape line on the thigh: starts DRAPE_ANG (rad) from the thigh's top toward its outer side, runs along the thigh to
 * DRAPE_END (capsule parameter) while wrapping to DRAPE_ANG1 (past the outer side), then falls straight down.
 */
const DRAPE_ANG = 0.6, DRAPE_ANG1 = 1.85, DRAPE_END = 0.72, DRAPE_GAP = 0.004, DRAPE_NP = 8;
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _du = new THREE.Vector3(), _dt = new THREE.Vector3(), _dl = new THREE.Vector3(), _dr = new THREE.Vector3(), _dc = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export function createDynamics(ctx) {
  const { rig, dims } = ctx;
  const D = dims.DYNAMICS;
  const HZ = D.hz, MAX_SUB = D.maxSubsteps, MAX_SUB_FAST = 8;
  const tau = D.velocityEmaMs / 1000;
  const costume = ctx.parts.costume;
  const api = costume?.api;

  // ---------------------------------------------------------------- springs
  const springs = [];
  for (const [name, group, lever] of SPRINGS) {
    const bone = rig.helpers[name];
    if (!bone) continue;
    const P = D[group];
    const maxDeg = name === 'hairBangs' ? D.hair.bangsMaxDeg : P.maxDeg;
    const { gain, gravityGain, deadA, deadAlpha } = GAINS[group];
    springs.push(new JiggleBone(bone, { k: P.k, d: P.d, maxDeg, lever, gain, gravityGain, tracker: { tauV: tau, deadA, deadAlpha } }));
  }

  // ---------------------------------------------------------------- sash
  const hips = rig.all.hips;
  const hipsTracker = new MotionTracker({ tauV: tau, deadA: 0, deadAlpha: 0 });
  const avPrev = new THREE.Vector3(), avF = new THREE.Vector3();   // damping reference: clamped, then EMA
  let avValid = false;
  const chains = [];
  let colliders = [];
  let ribbon = null;
  let drape = null;
  const env = { floorY: -Infinity };         // shared with the ribbon (world floor height this frame)
  if (api?.sash?.longTail) {
    const C = api.colliders;
    const defs = C ? [C.hips, ...(C.thighs || []), ...(C.furCuffs || []), ...(C.shins || [])].filter(Boolean) : fallbackColliders(rig);
    colliders = createColliders(defs, rig);
    for (const c of colliders) c.teleportProbe = c.bone === rig.all.hips || /Thigh$/.test(c.bone.name);
    const S = D.sash;
    // The knot (api.sash.knot, child of hips) blends hips/knot-side HipHelper and slides around the band with hip
    // flexion; the chain root is pinned to it and the near-knot rest drape follows it (fading toward the tip).
    const knot = api.sash.knot;
    const knotW = (n) => Array.from({ length: n }, (_, i) => 1 - 0.5 * THREE.MathUtils.smoothstep(i / (n - 1), 0.1, 0.9));
    // QA r2 P1-4: softer bending + heavier air drag toward the tip so the wide tail whips like cloth, not a flag
    const mk = (tail, shapeK, phase) => new VerletChain({
      restLocal: resample(tail.restPointsHips, tail.particles), anchor: hips, knot, knotW: knotW(tail.particles),
      gravity: S.gravity, damping: S.damping, airDrag: 0.010, stiffness: S.stiffness, bend: 0.22,
      shapeK, iterations: 3, margin: tail.thickness / 2 + 0.011, maxRelSpeed: MAX_REL, ceiling: 0.004, rootPushMax: 0.035,
      carry: CARRY,
      wind: S.wind * 1.5, windPhase: phase,
    });
    const LT = api.sash.longTail, ST = api.sash.shortTail;
    const long = mk(LT, [0, 320, 110, 45, 20, 11, 7, 5].slice(0, LT.particles).concat(Array(Math.max(0, LT.particles - 8)).fill(5)), 0);
    const short = mk(ST, [0, 320, 80, 25, 10, 6, 5, 5].slice(0, ST.particles).concat(Array(Math.max(0, ST.particles - 8)).fill(5)), 2.1);
    chains.push(long, short);
    for (const ch of chains) ch.o.floorClear = FLOOR_CLEAR;
    long.altK = DRAPE_K;
    // thigh drape setup: knot side, its thigh capsule, the long tail's root in knot-local space
    const kSide = knot && knot.position.x >= 0 ? 'left' : 'right';
    drape = {
      sign: kSide === 'left' ? 1 : -1, thigh: rig.all[`${kSide}Thigh`], chain: long,
      col: colliders.find((c) => c.type === 'capsule' && c.bone === rig.all[`${kSide}Thigh`]) || null,
      root: new THREE.Vector3(long.rest[0], long.rest[1], long.rest[2]).applyMatrix4(long.k0inv),
      poly: new Float32Array((DRAPE_NP + 3) * 3), cum: new Float32Array(DRAPE_NP + 3), w: 0, flex: 0,
    };
    if (!knot || !drape.col) drape = null;
    if (api.sash.ribbon) ribbon = createSashRibbon([{ chain: long }, { chain: short }], { rig, slot: api.sash.ribbon, knot, curl: TAIL_STYLE.curl, twistRelax: TAIL_STYLE.twistRelax, env });
  }

  // ---------------------------------------------------------------- fur squash (knee lift speed)
  const fur = api?.setFurSquash ? ['left', 'right'].map((side) => ({ side, shin: rig.all[`${side}Shin`], y: 0, vy: 0, amt: 0, sent: 0, valid: false })) : [];

  // ---------------------------------------------------------------- state / stats
  let time = 0;
  let needReset = true;
  const stats = { ms: 0, msMax: 0, substeps: 0, resets: 0, redrapes: 0, penetration: 0, frames: 0, sleeping: false, sleptFrames: 0 };
  // sleep (QA r1 P1-6): when nothing moves (static pose, settled tails + springs) skip the simulation and the
  // ribbon rebuild/upload entirely; any anchor/collider motion wakes it the same frame
  const SLEEP_AFTER = 12, SLEEP_MOTION = 2e-5, SLEEP_SPEED = 0.004, SLEEP_OMEGA = 0.004;
  let calm = 0;
  let sleeping = false;
  const springsCalm = () => {
    for (let i = 0; i < springs.length; i++) {
      const sp = springs[i];
      if (sp.omega.lengthSq() > SLEEP_OMEGA * SLEEP_OMEGA || sp.tracker.aOut.lengthSq() > 0 || sp.tracker.alphaOut.lengthSq() > 0) return false;
    }
    return true;
  };

  // ---------------------------------------------------------------- floor + thigh drape
  const dynApi = { floorY: null };
  function floorY() {
    if (typeof dynApi.floorY === 'number') return dynApi.floorY;
    const par = rig.root?.parent;
    return par ? par.matrixWorld.elements[13] : 0;
  }
  /**
   * Knot-side hip flexion -> drape weight; when > 0 write the long tail's alternate targets: root (knot frame) -> a
   * line along the thigh capsule's upper-outer surface (current frame) wrapping to its outer side -> straight down,
   * resampled at the chain's rest lengths.
   */
  function updateDrape(dt, snap) {
    const D = drape, ch = D.chain, c = D.col;
    // flexion in the hips frame: angle of the thigh axis from hips-down in the sagittal plane (110 deg in Deep squat)
    _du.subVectors(c.B[1], c.A[1]);
    const len = _du.length();
    if (len < 1e-6) { ch.altW = 0; return; }
    _du.divideScalar(len);
    _dt.copy(_du).applyQuaternion(_q.copy(_qh).invert());
    D.flex = Math.atan2(Math.max(_dt.z, 0), -_dt.y);
    const target = THREE.MathUtils.smoothstep(D.flex, DRAPE_FLEX[0], DRAPE_FLEX[1]);
    D.w = snap ? target : D.w + (target - D.w) * emaAlpha(dt, DRAPE_TAU);
    if (D.w < 1e-3) { D.w = target < 1e-3 ? 0 : D.w; ch.altW = 0; return; }
    ch.altW = D.w;
    ch.ceilLift = DRAPE_LIFT;
    const s = c.scale, m = ch.o.margin + DRAPE_GAP;
    // drape line direction around the thigh: its top (world up off the axis) rotated toward its outer side
    _dt.set(0, 1, 0).addScaledVector(_du, -_du.y);
    if (_dt.lengthSq() < 1e-6) _dt.set(0, 0, 1);
    _dt.normalize();
    _dl.set(hips.matrixWorld.elements[0], hips.matrixWorld.elements[1], hips.matrixWorld.elements[2]).multiplyScalar(D.sign);
    _dl.addScaledVector(_du, -_dl.dot(_du)).addScaledVector(_dt, -_dl.dot(_dt));
    if (_dl.lengthSq() < 1e-6) _dl.crossVectors(_du, _dt); else _dl.normalize();
    const P = D.poly, cum = D.cum;
    _dr.copy(D.root).applyMatrix4(api.sash.knot.matrixWorld);       // the chain's knot-driven root
    let k = 0;
    P[0] = _dr.x; P[1] = _dr.y; P[2] = _dr.z; cum[0] = 0; k = 1;
    // where the root projects onto the axis (start a little past it)
    const t0 = THREE.MathUtils.clamp(_dc.subVectors(_dr, c.A[1]).dot(_du) / len + 0.08, 0.05, DRAPE_END - 0.2);
    for (let i = 0; i < DRAPE_NP; i++, k++) {
      const u = i / (DRAPE_NP - 1), t = t0 + (DRAPE_END - t0) * u;
      const r = (c.r0 + (c.r1 - c.r0) * t) * s + m;
      const ang = DRAPE_ANG + (DRAPE_ANG1 - DRAPE_ANG) * u * u * (3 - 2 * u);
      _dc.copy(c.A[1]).addScaledVector(_du, len * t).addScaledVector(_dt, r * Math.cos(ang)).addScaledVector(_dl, r * Math.sin(ang));
      P[k * 3] = _dc.x; P[k * 3 + 1] = _dc.y; P[k * 3 + 2] = _dc.z;
    }
    // then straight down off the outer side
    P[k * 3] = _dc.x; P[k * 3 + 1] = _dc.y - 2; P[k * 3 + 2] = _dc.z; k++;
    for (let i = 1; i < k; i++) cum[i] = cum[i - 1] + Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2], P[i * 3 + 2] - P[i * 3 - 1]);
    // resample at the chain's rest arc lengths
    const alt = ch.alt, sc = ch.as;
    let acc = 0, seg = 1;
    alt[0] = P[0]; alt[1] = P[1]; alt[2] = P[2];
    for (let i = 1; i < ch.n; i++) {
      acc += ch.len[i - 1] * sc;
      while (seg < k - 1 && cum[seg] < acc) seg++;
      const f = THREE.MathUtils.clamp((acc - cum[seg - 1]) / Math.max(cum[seg] - cum[seg - 1], 1e-9), 0, 1), a = (seg - 1) * 3, b = seg * 3;
      alt[i * 3] = P[a] + (P[b] - P[a]) * f; alt[i * 3 + 1] = P[a + 1] + (P[b + 1] - P[a + 1]) * f; alt[i * 3 + 2] = P[a + 2] + (P[b + 2] - P[a + 2]) * f;
    }
  }
  const _qh = new THREE.Quaternion();

  function reset() {
    hipsTracker.reset(); avValid = false; avF.set(0, 0, 0);
    for (let i = 0; i < springs.length; i++) springs[i].reset();
    for (let i = 0; i < chains.length; i++) chains[i].valid = false;
    for (let i = 0; i < fur.length; i++) { fur[i].valid = false; fur[i].vy = 0; fur[i].amt = 0; }
    needReset = true;
    sleeping = false; calm = 0;
    stats.resets++;
  }

  function update(dt) {
    const t0 = performance.now();
    dt = dt > 0.1 ? 0.1 : dt > 0 ? dt : 0;
    if (dt <= 0) { ribbon?.update(0); return; }
    time += dt;
    const first = needReset;

    // ---- teleport / recalibration snap detection on the hips
    hips.matrixWorld.decompose(_p, _q, _a);
    hipsTracker.update(dt, _p, _q);
    if (!first && (hipsTracker.jump > 0.5 * _a.x || hipsTracker.turn > 1.2)) { reset(); hipsTracker.update(dt, _p, _q); }
    const fresh = needReset;
    needReset = false;

    // ---- per-frame inputs
    for (let i = 0; i < springs.length; i++) springs[i].sense(dt);
    let motion = 0, limbJump = 0;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      c.capture(fresh);
      if (c.motion > motion) motion = c.motion;
      if (c.teleportProbe && c.motion > limbJump) limbJump = c.motion;
    }
    // teleport (preset snap / tracker pop: a limb moved > 0.2 m at > 9 m/s in one frame): re-drape the tails in the new
    // pose instead of sweeping the limb through them (that sweep threw the tail around the leg, QA r2 P1-4)
    // (hips + thighs only: a real fast kick moves the shin's ankle end at up to ~10 m/s, the thigh hem at ~3-4 m/s)
    const teleport = !fresh && limbJump > TELEPORT[0] && limbJump / dt > TELEPORT[1];
    if (teleport) { for (let i = 0; i < colliders.length; i++) colliders[i].settle(); stats.redrapes++; }
    // implausibly fast collider (pose snap): cap the tail's relative speed for this frame
    const snap = THREE.MathUtils.smoothstep(motion / dt, SNAP_SPEED[0], SNAP_SPEED[1]);
    const maxRel = MAX_REL + (MAX_REL_SNAP - MAX_REL) * snap;
    if (!avValid || fresh) { avPrev.copy(_p); avF.set(0, 0, 0); avValid = true; }
    _b.subVectors(_p, avPrev).divideScalar(dt);
    if (_b.lengthSq() > AV_MAX * AV_MAX) _b.setLength(AV_MAX);
    avF.lerp(_b, emaAlpha(dt, tau));
    avPrev.copy(_p);
    env.floorY = floorY();
    for (let i = 0; i < chains.length; i++) chains[i].floorY = env.floorY;
    if (drape) { _qh.copy(_q); updateDrape(dt, fresh || teleport || !drape.chain.valid); }
    if (fresh || teleport) ribbon?.snap();
    for (let i = 0; i < chains.length; i++) {
      const ch = chains[i];
      if (!ch.valid || teleport) ch.reset(); else ch.capture(dt);
      ch.av.copy(avF);
      ch.maxRelFrame = maxRel;
      const am = ch.ap[0].distanceTo(ch.ap[1]) + ch.aq[0].angleTo(ch.aq[1]) * 0.5 + ch.knotMotion();
      if (am > motion) motion = am;
    }

    // ---- sleep / wake
    if (!fresh && motion < SLEEP_MOTION && hipsTracker.turn < 1e-5) {
      if (sleeping) { stats.sleeping = true; stats.sleptFrames++; stats.ms += (performance.now() - t0 - stats.ms) * 0.05; return; }
    } else { sleeping = false; calm = 0; }
    stats.sleeping = sleeping;
    const simT0 = Math.min(dt, MAX_SUB / HZ);
    for (let i = 0; i < chains.length; i++) chains[i].broadphase(colliders, simT0);
    if (teleport) {                                   // pre-roll: settle the fresh drape against the new limb placement
      for (let i = 0; i < colliders.length; i++) colliders[i].at(1);
      for (let k = 0; k < PREROLL; k++) for (let i = 0; i < chains.length; i++) chains[i].step(1 / HZ, 1, colliders, time);
      for (let i = 0; i < chains.length; i++) chains[i].v.fill(0);
    }

    // ---- substeps
    const simT = Math.min(dt, MAX_SUB / HZ);
    let n = Math.min(MAX_SUB, Math.max(1, Math.ceil(dt * HZ - 1e-6)));
    const nFast = Math.ceil(motion / 0.025);
    if (nFast > n) n = Math.min(MAX_SUB_FAST, nFast);
    const h = simT / n;
    for (let s = 0; s < n; s++) {
      const t = (s + 1) / n;
      for (let i = 0; i < colliders.length; i++) colliders[i].at(t);
      const tm = time - simT + h * (s + 1);
      for (let i = 0; i < chains.length; i++) chains[i].step(h, t, colliders, tm);
      for (let i = 0; i < springs.length; i++) springs[i].step(h);
    }
    for (let i = 0; i < springs.length; i++) springs[i].apply();
    // settle check -> sleep after SLEEP_AFTER calm frames
    let fast = 0;
    for (let i = 0; i < chains.length; i++) if (chains[i].maxSpeed > fast) fast = chains[i].maxSpeed;
    if (motion < SLEEP_MOTION && fast < SLEEP_SPEED && springsCalm()) { if (++calm >= SLEEP_AFTER) sleeping = true; } else calm = 0;
    let pen = 0, fpen = 0;
    for (let i = 0; i < chains.length; i++) {
      if (!chains[i].healthy()) { chains[i].reset(); stats.resets++; }
      if (chains[i].maxPen > pen) pen = chains[i].maxPen;
      if (chains[i].floorPen > fpen) fpen = chains[i].floorPen;
    }
    stats.floorPen = fpen;
    stats.drape = drape ? drape.w : 0;
    ribbon?.update(dt);

    // ---- fur squash from knee lift speed (knee height relative to the hips)
    if (fur.length) {
      const kV = emaAlpha(dt, tau);
      for (let i = 0; i < fur.length; i++) {
        const f = fur[i];
        _b.setFromMatrixPosition(f.shin.matrixWorld);
        const y = _b.y - _p.y;
        if (!f.valid) { f.y = y; f.valid = true; }
        f.vy += ((y - f.y) / dt - f.vy) * kV;
        f.y = y;
        const sm = THREE.MathUtils.smoothstep(f.vy, 0.5, 2.0) * D.furSquash;
        f.amt += (sm - f.amt) * emaAlpha(dt, sm > f.amt ? 0.03 : 0.18);
        if (Math.abs(f.amt - f.sent) > 0.002 || (f.amt < 0.002 && f.sent !== 0)) {
          f.sent = f.amt < 0.002 ? 0 : f.amt;
          api.setFurSquash(f.side, f.sent);
        }
      }
    }

    const ms = performance.now() - t0;
    stats.frames++;
    stats.ms += (ms - stats.ms) * 0.05;
    stats.msMax = Math.max(stats.msMax * 0.995, ms);
    stats.substeps = n;
    stats.penetration = pen;
  }

  /**
   * QA: penetration of the rendered ribbon into the limb colliders (margin 0) at the current frame.
   * Returns { maxPen (m), verts (count deeper than tol), total, worst: collider bone }.
   */
  const _mw = new THREE.Matrix4(), _rest = new THREE.Matrix4(), _n = new THREE.Vector3();
  function measurePenetration(tol = 0.002) {
    if (!ribbon) return null;
    const pos = ribbon.geometry.attributes.position, v0 = ribbon.vertexStart, v1 = v0 + ribbon.vertexCount;
    _rest.makeTranslation(rig.restWorld.hips.x, rig.restWorld.hips.y, rig.restWorld.hips.z).invert();
    _mw.copy(hips.matrixWorld).multiply(_rest);
    for (let c = 0; c < colliders.length; c++) colliders[c].at(1);
    let maxPen = 0, verts = 0, worst = null;
    for (let i = v0; i < v1; i++) {
      _a.fromBufferAttribute(pos, i).applyMatrix4(_mw);
      let d = 1e9, wb = null;
      for (let c = 0; c < colliders.length; c++) { const e = colliders[c].sdf(_a.x, _a.y, _a.z, 0, _n); if (e < d) { d = e; wb = colliders[c].bone.name + ':' + colliders[c].type; } }
      if (-d > tol) verts++;
      if (-d > maxPen) { maxPen = -d; worst = wb; }
    }
    return { maxPen: +maxPen.toFixed(4), verts, total: v1 - v0, worst };
  }

  /** QA: lowest point of the rendered tails (world y) and how many tail vertices are below `floor` (default: the floor). */
  function measureFloor(floor = floorY()) {
    if (!ribbon) return null;
    const pos = ribbon.geometry.attributes.position, v0 = ribbon.vertexStart, v1 = v0 + ribbon.vertexCount;
    _rest.makeTranslation(rig.restWorld.hips.x, rig.restWorld.hips.y, rig.restWorld.hips.z).invert();
    _mw.copy(hips.matrixWorld).multiply(_rest);
    let minY = Infinity, below = 0;
    for (let i = v0; i < v1; i++) {
      _a.fromBufferAttribute(pos, i).applyMatrix4(_mw);
      if (_a.y < minY) minY = _a.y;
      if (_a.y < floor) below++;
    }
    return { minY: +minY.toFixed(4), clearance: +(minY - floor).toFixed(4), below, total: v1 - v0, floor };
  }

  return Object.assign(dynApi, {
    meshes: ribbon ? ribbon.meshes : [],
    update, reset, stats, measurePenetration, measureFloor, drape: () => (drape ? { w: drape.w, flex: drape.flex } : null),
    springs, chains, colliders, ribbon,
    dispose() {
      ribbon?.dispose();
      for (const s of springs) s.reset();
      for (const f of fur) api.setFurSquash(f.side, 0);
    },
  });
}

export default createDynamics;
