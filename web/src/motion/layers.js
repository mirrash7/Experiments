// Animation layers on top of / under the tracked pose:
//   ProceduralBase   authored idle (what the hero does with any body part that is not tracked):
//                      'stance'  fighting stance: fists up at the chin, elbows in, knees soft, lead foot forward,
//                                breathing (chest + shoulders) and a slow weight shift over the feet  [default]
//                      'guard'   same arms on a square, upright stance
//                      'relaxed' arms hanging, palms toward the thighs
//                    Arms and legs are placed by pole-vector IK from target points relative to the hero's own
//                    rest skeleton (so it fits any VRM), torso by small Euler offsets.
//   Confidence       per-bone tracked weight with hysteresis: visible -> tracked; lost -> hold the last good
//                    pose for `hold` s, then fade to the procedural base over `fade` s
//   Accents          short procedural overlays on detected actions (punch snap with overshoot + shoulder lead +
//                    torso turn + fist, kick chamber -> snap extension -> retract, jump stretch / hang, landing
//                    squash), with impact timing for hit-stop / VFX (see Accents.sample -> out.impacts)
import * as THREE from 'three';
import { clamp, smoothstep, frameQuat } from './math.js';
import { poleIK } from './ik.js';

const E = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
const Z = new THREE.Vector3(0, 0, 1);

/** Inverse rest frame of a hinge bone: (bone direction, facing) -> used by poleIK. */
export function restInvFrame(rig, bone, child, facing) {
  return frameQuat(rig.restDir(bone, child), facing).invert();
}

export class ProceduralBase {
  constructor(style = 'stance', rig = null) {
    this.style = style; this.rig = rig;
    if (rig) {
      this.inv = {};
      for (const s of ['left', 'right']) {
        // elbows stick out backward when the arm flexes in the T-pose (-Z); knees stick out forward (+Z)
        this.inv[s + 'UpperArm'] = restInvFrame(rig, s + 'UpperArm', s + 'LowerArm', new THREE.Vector3(0, 0, -1));
        this.inv[s + 'LowerArm'] = restInvFrame(rig, s + 'LowerArm', s + 'Hand', new THREE.Vector3(0, 0, -1));
        this.inv[s + 'UpperLeg'] = restInvFrame(rig, s + 'UpperLeg', s + 'LowerLeg', Z);
        this.inv[s + 'LowerLeg'] = restInvFrame(rig, s + 'LowerLeg', s + 'Foot', Z);
      }
      this._fk = { rot: {}, pos: {} };
    }
  }

  /** VRM1-convention local rotations + hips offset (relative to rest hips height). */
  sample(t) {
    const br = Math.sin(t * 1.9), sway = Math.sin(t * 0.55), shift = Math.sin(t * 0.37 + 0.6);
    const fight = this.style === 'stance', guard = fight || this.style === 'guard';
    if (!this.rig) return this._legacy(t, br, sway, guard);
    const rig = this.rig, W = rig.restWorld;
    const H = rig.height ?? 1.6;
    // ---- torso (local Euler offsets)
    const lean = fight ? 0.07 : 0.02, yaw = fight ? 0.1 : 0;
    const r = {
      hips: E(0, yaw + sway * 0.025, shift * 0.025),
      spine: E(lean + br * 0.012, -yaw * 0.6 - sway * 0.012, -shift * 0.015),
      chest: E(br * 0.018, -yaw * 0.3, -shift * 0.01),
      upperChest: E(br * 0.012, 0, 0),
      neck: E(fight ? 0.04 : 0.02, Math.sin(t * 0.4) * 0.04, 0),
      head: E((fight ? 0.03 : -0.02) + Math.sin(t * 0.9) * 0.015, Math.sin(t * 0.33) * 0.06 - (fight ? yaw * 0.4 : 0), 0),
    };
    if (guard) {
      r.leftShoulder = E(0, 0, 0.04 + br * 0.015); r.rightShoulder = E(0, 0, -0.04 - br * 0.015);   // shoulders breathe
    }
    // weight shift: the pelvis travels over the feet (feet stay put), knees soften in the fighting stance
    const drop = fight ? 0.045 * H / 1.6 : 0.012;
    const hipsOffset = new THREE.Vector3(shift * (fight ? 0.03 : 0.012), -drop + br * 0.004, 0);
    const hips = new THREE.Vector3(0, rig.hipHeight, 0).add(hipsOffset);
    const fk = rig.fk(r, hips, this._fk);
    // ---- legs: feet planted at fixed spots, pole-vector IK from the moving pelvis
    for (const s of ['left', 'right']) {
      const sg = s === 'left' ? 1 : -1;
      const hip = fk.pos[s + 'UpperLeg'], rh = W[s + 'UpperLeg'];
      if (!hip || !W[s + 'Foot']) continue;
      const lead = fight ? (s === 'left' ? 1 : -1) : 0;                        // orthodox: left foot leads
      const foot = new THREE.Vector3(rh.x + sg * (fight ? 0.07 : 0.03) * H / 1.6, rig.ankleHeight, lead * 0.09 * H / 1.6 + (fight ? 0.01 : 0));
      const pole = new THREE.Vector3(sg * 0.25, 0, 1).normalize();             // knees track over the toes
      const [l1, l2] = rig.leg[s];
      const aW = new THREE.Quaternion(), bW = new THREE.Quaternion();
      poleIK(hip, l1, l2, foot, pole, this.inv[s + 'UpperLeg'], this.inv[s + 'LowerLeg'], aW, bW, 0.01);
      r[s + 'UpperLeg'] = fk.rot.hips.clone().invert().multiply(aW);
      r[s + 'LowerLeg'] = aW.clone().invert().multiply(bW);
      // foot flat on the floor, toes turned out (rear foot more)
      const out = sg * (fight ? (lead > 0 ? 0.25 : 0.55) : 0.15);
      r[s + 'Foot'] = bW.clone().invert().multiply(E(0, out, 0));
    }
    // ---- arms
    const ch = rig.present.has('upperChest') ? 'upperChest' : 'chest';
    const cW = fk.rot[ch], cP = fk.pos[ch];
    for (const s of ['left', 'right']) {
      const sg = s === 'left' ? 1 : -1;
      const sh = fk.pos[s + 'UpperArm'];
      if (!sh || !W[s + 'Hand']) continue;
      const [l1, l2] = rig.arm[s];
      let wrist, pole, twist;
      if (guard) {
        // fists at chin height, ~24 cm apart, ~22 cm in front of the face; elbows down and tucked in
        const chinY = (W.head ? W.head.y : W.neck.y + 0.08) - W[ch].y - 0.07;
        const lead = fight ? (s === 'left' ? 0.05 : -0.02) : 0;
        wrist = new THREE.Vector3(sg * 0.105, chinY + br * 0.006 - (fight && s === 'left' ? 0.0 : 0.02), 0.2 + lead).multiplyScalar(H / 1.6)
          .applyQuaternion(cW).add(cP);
        pole = new THREE.Vector3(sg * 0.35, -1, -0.15).applyQuaternion(cW);
        twist = 0.9;      // forearm roll: knuckles forward-up, palms facing in
      } else {
        wrist = new THREE.Vector3(W[s + 'UpperArm'].x + sg * 0.03, rig.hipHeight - 0.02, 0.03).add(hipsOffset);
        pole = new THREE.Vector3(sg * 0.3, 0, -1);
        twist = -0.35;     // palms toward the thighs
      }
      const aW = new THREE.Quaternion(), bW = new THREE.Quaternion();
      poleIK(sh, l1, l2, wrist, pole, this.inv[s + 'UpperArm'], this.inv[s + 'LowerArm'], aW, bW, 0.005);
      bW.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(sg, 0, 0), twist));
      r[s + 'UpperArm'] = fk.rot[s + 'Shoulder'].clone().invert().multiply(aW);
      r[s + 'LowerArm'] = aW.clone().invert().multiply(bW);
      r[s + 'Hand'] = guard ? E(0, 0, 0) : E(0, 0, sg * -0.08);
    }
    return { rotations: r, hipsOffset, hand: guard ? 'fist' : 'relaxed' };
  }

  // rig-less fallback (canonical skeleton unknown): the original Euler stance
  _legacy(t, br, sway, guard) {
    const r = {
      hips: E(0, sway * 0.03, sway * 0.012), spine: E(0.02 + br * 0.012, -sway * 0.015, 0),
      chest: E(br * 0.015, 0, -sway * 0.01), upperChest: E(br * 0.01, 0, 0),
      neck: E(0.02, Math.sin(t * 0.4) * 0.04, 0), head: E(-0.02 + Math.sin(t * 0.9) * 0.015, Math.sin(t * 0.33) * 0.06, 0),
      leftUpperLeg: E(-0.06, 0, 0.07), rightUpperLeg: E(-0.06, 0, -0.07), leftLowerLeg: E(0.12, 0, 0), rightLowerLeg: E(0.12, 0, 0),
      leftFoot: E(-0.06, 0, -0.07), rightFoot: E(-0.06, 0, 0.07),
      leftUpperArm: E(0.05, -0.1, -1.18 + br * 0.02), rightUpperArm: E(0.05, 0.1, 1.18 - br * 0.02),
      leftLowerArm: E(0, -0.3, 0), rightLowerArm: E(0, 0.3, 0),
    };
    return { rotations: r, hipsOffset: new THREE.Vector3(sway * 0.012, -0.012 + br * 0.003, 0), hand: guard ? 'fist' : 'relaxed' };
  }
}

/** Per-bone tracked weight with hysteresis + hold + fade. */
export class Confidence {
  constructor({ on = 0.5, off = 0.3, hold = 0.3, fade = 0.35, rise = 0.12 } = {}) {
    Object.assign(this, { on, off, hold, fade, rise });
    this.vis = {}; this.lostFor = {}; this.w = {};
  }
  reset() { this.vis = {}; this.lostFor = {}; this.w = {}; }
  /** c: per-bone confidence map; returns updated weights */
  update(bones, c, dt) {
    for (const b of bones) {
      const x = c[b] ?? 0;
      const v = this.vis[b] ? x > this.off : x > this.on;
      this.vis[b] = v;
      this.lostFor[b] = v ? 0 : (this.lostFor[b] ?? 1e9) + dt;
      const goal = v ? 1 : this.lostFor[b] < this.hold ? (this.w[b] ?? 0) : 0;
      const rate = v ? dt / this.rise : dt / this.fade;
      const w = this.w[b] ?? 0;
      this.w[b] = goal > w ? Math.min(goal, w + rate) : Math.max(goal, w - rate);
    }
    return this.w;
  }
}

const env = (t, attack, hold, release) => (t < 0 ? 0 : t < attack ? smoothstep(0, attack, t)
  : t < attack + hold ? 1 : 1 - smoothstep(attack + hold, attack + hold + release, t));
/** Snap envelope: ease-out-back attack (overshoots ~`over` above 1 and settles), hold, smooth release. */
function snapEnv(t, attack, hold, release, over = 0.12) {
  if (t < 0) return 0;
  if (t < attack) {
    const x = t / attack - 1, c1 = over * 14.5, c3 = c1 + 1;      // c1 = 1.70158 gives ~10 % overshoot
    return 1 + c3 * x * x * x + c1 * x * x;
  }
  if (t < attack + hold) return 1;
  return 1 - smoothstep(attack + hold, attack + hold + release, t);
}

export const ACCENT_TIMING = {
  punch: { attack: 0.07, hold: 0.07, release: 0.24, fistTail: 0.15, impact: 0.06 },
  kick: { chamber: 0.11, extend: 0.09, hold: 0.09, retract: 0.16, lower: 0.25, impact: 0.18 },
};
const DUR = {
  punchLeft: 0.38, punchRight: 0.38, kickLeft: 0.7, kickRight: 0.7, jump: 0.7, land: 0.35,
};

/**
 * Accents keyed by AVATAR side. trigger(name) with ActionDetector names (already side-mapped for mirror).
 * sample(t) -> {
 *   add: {bone: Quaternion}   additive local rotations (post-multiplied)
 *   reach: {left, right}      0..1 boost toward full arm extension
 *   wrist: {left, right}      0..1 straighten the wrist (fist in line with the forearm)
 *   kneeExt: {left, right}    0..1 extend a TRACKED knee (kick snap)
 *   free: {left, right}       true: do not foot-lock this foot (the accent moves it)
 *   hips: Vector3 offset, hand: {left, right} override pose or null, hang: 0..1,
 *   impacts: [{kind: 'punch'|'kick', side, strength}]   the frame an attack reaches full extension (once)
 * }
 */
export class Accents {
  constructor() { this.active = []; this.enabled = true; this._out = null; }
  trigger(name, t, info = {}) {
    if (!this.enabled) return false;
    const dur = DUR[name];
    if (!dur) return false;
    this.active = this.active.filter((a) => a.name !== name);
    this.active.push({ name, t0: t, dur, hit: false, strength: clamp(info.strength ?? 1, 0.3, 1.5) });
    return true;
  }
  sample(t, { legsTracked = true } = {}) {
    const out = { add: {}, reach: { left: 0, right: 0 }, wrist: { left: 0, right: 0 }, kneeExt: { left: 0, right: 0 },
      free: { left: false, right: false }, hips: new THREE.Vector3(), hand: { left: null, right: null }, hang: 0, impacts: [] };
    const addRot = (b, q) => { out.add[b] = out.add[b] ? out.add[b].multiply(q) : q; };
    const P = ACCENT_TIMING.punch, K = ACCENT_TIMING.kick;
    this.active = this.active.filter((a) => t - a.t0 < a.dur + (a.name.startsWith('punch') ? P.fistTail : 0));
    for (const a of this.active) {
      const u = t - a.t0;
      if (a.name.startsWith('punch')) {
        const side = a.name === 'punchLeft' ? 'left' : 'right', other = side === 'left' ? 'right' : 'left';
        const sg = side === 'left' ? 1 : -1;
        // fists for the whole accent + tail (both hands: punching fist + guard fist)
        out.hand[side] = 'fist'; if (!out.hand[other]) out.hand[other] = 'fist';
        if (u > a.dur) continue;
        const e = snapEnv(u, P.attack, P.hold, P.release, 0.12);          // overshoots ~12 %
        const lead = snapEnv(u + 0.025, P.attack, P.hold, P.release, 0.1);  // shoulder/hips lead the fist
        const ec = Math.min(e, 1);
        out.reach[side] = Math.max(out.reach[side], ec);
        out.wrist[side] = Math.max(out.wrist[side], smoothstep(0, 0.6, ec));
        const k = a.strength;
        // kinetic chain: hips -> chest -> shoulder (leading) -> fist (snap)
        addRot('hips', E(0, -sg * 0.09 * lead * k, 0));
        addRot('spine', E(0.03 * ec, -sg * 0.08 * lead * k, 0));
        addRot('chest', E(0, -sg * 0.13 * e * k, 0));
        addRot('upperChest', E(0, -sg * 0.16 * e * k, 0));
        addRot(`${side}Shoulder`, E(0, -sg * 0.3 * lead * k, -sg * 0.05 * lead));
        addRot(`${other}Shoulder`, E(0, sg * 0.08 * ec, 0));
        addRot('head', E(0.05 * ec, sg * 0.18 * ec, 0));                  // eyes stay on the target
        if (!a.hit && u >= P.impact) { a.hit = true; out.impacts.push({ kind: 'punch', side, strength: k }); }
      } else if (a.name.startsWith('kick')) {
        const side = a.name === 'kickLeft' ? 'left' : 'right', other = side === 'left' ? 'right' : 'left';
        const sg = side === 'left' ? 1 : -1;
        const t1 = K.chamber, t2 = t1 + K.extend, t3 = t2 + K.hold, t4 = t3 + K.retract, t5 = t4 + K.lower;
        // thigh: up through chamber, held while the shin snaps out and back, then lowered
        const thigh = u < t1 ? smoothstep(0, t1, u) : u < t4 ? 1 : 1 - smoothstep(t4, t5, u);
        // knee extension: 0 chambered -> 1 snapped out (ease-out-back) -> 0 retracted
        const ext = u < t1 ? 0 : u < t2 ? snapEnv(u - t1, K.extend, 0, 1, 0.08) : u < t3 ? 1 : u < t4 ? 1 - smoothstep(t3, t4, u) : 0;
        const k = a.strength;
        if (!legsTracked) {
          addRot(`${side}UpperLeg`, E(-1.45 * thigh * k, 0, 0));
          addRot(`${side}LowerLeg`, E(1.7 * thigh * (1 - Math.min(ext, 1)) + 0.05, 0, 0));
          addRot(`${side}Foot`, E(0.5 * Math.min(ext, 1), 0, 0));            // point the foot on the snap
          out.free[side] = thigh > 0.02;
        } else {
          out.kneeExt[side] = Math.max(out.kneeExt[side], Math.min(ext, 1));
          addRot(`${side}UpperLeg`, E(-0.3 * Math.min(ext, 1), 0, 0));       // a little extra height on the snap
        }
        // stance accent: torso leans back, hips pivot over the support foot, support knee bends
        addRot('hips', E(0, -sg * 0.12 * thigh, 0));
        addRot('spine', E(-0.16 * thigh, sg * 0.06 * thigh, 0));
        addRot('chest', E(-0.06 * thigh, 0, 0));
        addRot('head', E(0.12 * thigh, 0, 0));
        out.hips.y -= 0.025 * thigh;
        out.hips.x += -sg * 0.02 * thigh;
        out.hand[side] = out.hand[side] ?? 'fist'; out.hand[other] = out.hand[other] ?? 'fist';
        if (!a.hit && u >= K.impact) { a.hit = true; out.impacts.push({ kind: 'kick', side, strength: k }); }
      } else if (a.name === 'jump') {
        const e = env(u, 0.06, 0.25, 0.35);
        out.hang = e;
        addRot('spine', E(-0.06 * e, 0, 0));
        addRot('leftUpperArm', E(0, 0, 0.25 * e)); addRot('rightUpperArm', E(0, 0, -0.25 * e));
      } else if (a.name === 'land') {
        const e = env(u, 0.04, 0.03, 0.28);
        out.hips.y -= 0.07 * e;                     // squash: legs bend through IK because the feet stay locked
        addRot('spine', E(0.15 * e, 0, 0)); addRot('head', E(-0.08 * e, 0, 0));
      }
    }
    return out;
  }
}

export { clamp };
