// Webcam -> VRM hero motion pipeline. See README.md in this folder for the API and the stage diagram.
//
// per tracker frame (push):  actions (light filter) -> solve world bone rotations (MHR FK or keypoints)
//   -> floor/yaw calibration -> mirror -> local rotations (+ forearm twist split, hinge limits)
//   -> per-bone predictor samples, root sample, contacts, hand state
// per render frame (update): predict to render time + tracking spring -> confidence blend with the
//   procedural base (hold, then fade) -> action accents -> foot lock + leg IK + pelvis -> arm reach IK
//   -> look-at -> pose {hips, rotations} -> hero.applyHumanoidPose(pose)
import * as THREE from 'three';
import { MHRSkeleton } from './mhrFK.js';
import { HeroRig, swapSide, BODY_BONES } from './heroRig.js';
import { MHRSolver, KeypointSolver } from './solvers.js';
import { BoneTrack, PointTrack, PREDICT } from './track.js';
import { FootContact, FootLock, twoBoneIK, clampHinge, poleIK, clampWrist } from './ik.js';
import { ProceduralBase, Confidence, Accents, restInvFrame } from './layers.js';
import { HandPoser } from './hands.js';
import { Metrics } from './metrics.js';
import { OneEuro3, fromTo, mirrorQuat, twistOf, quatPow, smoothstep, clamp } from './math.js';
import { ActionDetector } from '../actions.js';

const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _qI = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();

export const DEFAULTS = {
  mirror: true,               // avatar is the player's mirror image (left/right swapped, x reflected)
  solver: 'auto',             // 'auto' (MHR params when the frame has them, else keypoints) | 'mhr' | 'keypoints'
  limits: true,               // elbow/knee hinge limits (no hyper-extension)
  mhrParamLimits: false,      // soft-clamp MHR params to the rig's min/max (fitting priors; distorts real poses)
  twistSplit: 0.5,            // fraction of the wrist twist moved into the forearm
  predict: true, predictMs: 50, maxHorizonMs: 110,   // extrapolation lead (latency hidden) and hard horizon cap
  noiseAware: true,           // predictor: horizon saturation + noise-adaptive spring half-life (track.js)
  spring: true, springScale: 1,
  confidence: true, base: true, baseStyle: 'stance', accents: true,   // baseStyle 'stance' | 'guard' | 'relaxed'
  wristLimits: true, wristFlex: 0.785, wristDev: 0.52,   // wrist flexion/extension +-45 deg, deviation +-30 deg
  kneePole: true,             // leg IK bends the knee in the plane of (tracked knee direction | foot forward)
  expressions: true,          // call hero.setExpression(name) on action events (also emitted as 'expression')
  handOverride: null,         // debug: {left, right} hand pose forced ('fist' | 'open' | 'relaxed' | 'point')
  hands: 'pose',              // 'pose' (classified authored poses) | 'tracked' (MHR fingers) | 'off'
  ikArms: true, reachRemap: true, ikLegs: true, footLock: true, pelvis: true,
  root: { scale: [1, 1, 1], zDeadzone: 0.04, zCutoff: 0.8, follow: true },
  autoCalibrate: true, calibrateYaw: true,
  lookAt: null, lookAtWeight: 0.7,   // THREE.Vector3 in hero root space, or null
  convention: 'vrm1',         // 'vrm1' (faces +Z, left = +X) | 'vrm0' (normalized frame of a rotateVRM0'd VRM0)
  apply: true,                // call hero.applyHumanoidPose(pose) from update()
};

// bone -> keypoints whose confidence gates it (player names, before mirroring)
function boneConfKeys(b) {
  const side = b.startsWith('left') ? 'left' : b.startsWith('right') ? 'right' : '';
  const k = b.replace(/^(left|right)/, '');
  if (b === 'hips') return ['leftHip', 'rightHip'];
  if (['spine', 'chest', 'upperChest'].includes(b)) return ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];
  if (b === 'neck' || b === 'head') return ['nose'];
  if (k === 'Shoulder') return [side + 'Shoulder'];
  if (k === 'UpperArm') return [side + 'Shoulder', side + 'Elbow'];
  if (k === 'LowerArm') return [side + 'Elbow', side + 'Wrist'];
  if (k === 'UpperLeg') return [side + 'Hip', side + 'Knee'];
  if (k === 'LowerLeg') return [side + 'Knee', side + 'Ankle'];
  if (k === 'Foot' || k === 'Toes') return [side + 'Ankle'];
  return [side + 'Wrist'];   // hand + fingers
}

/** Convert a VRM1-convention pose to the normalized frame of a VRM 0.x model turned by VRMUtils.rotateVRM0. */
export function toVRM0Pose(pose, out = { hips: new THREE.Vector3(), rotations: {} }) {
  out.hips.set(-pose.hips.x, pose.hips.y, -pose.hips.z);
  for (const [b, q] of Object.entries(pose.rotations)) (out.rotations[b] ??= new THREE.Quaternion()).set(-q.x, q.y, -q.z, q.w);
  return out;
}

/** Tiny event emitter: pipeline.events.on(type, cb) -> off(). */
export class Emitter {
  constructor() { this.l = {}; }
  on(type, cb) { (this.l[type] ??= new Set()).add(cb); return () => this.l[type]?.delete(cb); }
  emit(type, data) { const s = this.l[type]; if (s) for (const cb of s) { try { cb(data); } catch (e) { console.error(e); } } }
}

// action -> expression preset (hero.setExpression names). Combos (3 hits within 1.6 s) grin.
const ACTION_EXPRESSION = { punchLeft: 'determined', punchRight: 'determined', kickLeft: 'angry', kickRight: 'angry', jump: 'happy',
  handsUp: 'happy', squat: 'determined', guard: 'determined', tPose: 'relaxed' };

export async function createMotionPipeline({ hero = null, source = null, options = {}, vrm = null, mhr = null, actions = null } = {}) {
  const skel = mhr ?? await MHRSkeleton.load(options.rigUrl);
  return new MotionPipeline({ hero, source, options, vrm, mhr: skel, actions });
}

export class MotionPipeline {
  constructor({ hero, source, options, vrm, mhr, actions }) {
    this.hero = hero;
    this.options = { ...DEFAULTS, ...options, root: { ...DEFAULTS.root, ...(options.root ?? {}) } };
    this.rig = new HeroRig({ vrm: vrm ?? hero?.vrm ?? null, info: hero?.info ?? options.heroInfo ?? {} });
    this.mhr = mhr;
    this.mhrSolver = new MHRSolver(mhr, this.rig, { limits: this.options.limits });
    this.kpSolver = new KeypointSolver(this.rig);
    this.actions = actions ?? new ActionDetector();
    this.metrics = new Metrics();
    this.base = new ProceduralBase(this.options.baseStyle, this.rig);
    this.events = new Emitter();
    this.hitStopUntil = 0; this.hitStopScale = 1; this._frozenDisplay = null;
    this._hits = []; this._landPending = 0;
    this.legInv = {};
    for (const s of ['left', 'right']) {
      if (!this.rig.present.has(s + 'Foot')) continue;
      this.legInv[s + 'UpperLeg'] = restInvFrame(this.rig, s + 'UpperLeg', s + 'LowerLeg', Z);
      this.legInv[s + 'LowerLeg'] = restInvFrame(this.rig, s + 'LowerLeg', s + 'Foot', Z);
    }
    this.conf = new Confidence();
    this.accents = new Accents();
    this.hands = new HandPoser(this.rig);
    this.tracks = {}; for (const b of this.rig.bones) this.tracks[b] = new BoneTrack(b);
    this.hipsTrack = new PointTrack({ halflife: 0.05, maxSpeed: 4 });
    this.contact = { left: new FootContact(), right: new FootContact() };
    this.locks = { left: new FootLock(), right: new FootLock() };
    this.zFilter = new OneEuro3(this.options.root.zCutoff, 0.6);
    this.calib = null; this._calibSamples = []; this.floorOffset = 0;
    this.held = {}; this.boneConf = {};
    this.latency = 60;
    this.pelvisDrop = 0;
    this.jump = { active: false, t: 0 };
    this.handConf = { left: 0, right: 0 };
    this.lastFrame = null; this.lastSample = null;
    this.pose = { hips: new THREE.Vector3(0, this.rig.hipHeight, 0), rotations: {} };
    this._vrm0 = { hips: new THREE.Vector3(), rotations: {} };
    this.state = { calibrated: false, solver: 'none', contacts: { left: true, right: true }, locked: { left: false, right: false },
      weights: {}, hands: this.hands.state, legsTracked: false, fk: null, debug: {} };
    this._t = 0;
    this.actions.on((name, info) => this._onAction(name, info));
    if (source) this.setSource(source);
  }

  /** Hook a tracking source (chains any existing onPose handler). */
  setSource(source) {
    if (this.source && this._prevOnPose !== undefined) this.source.onPose = this._prevOnPose;
    this.source = source;
    if (!source) return;
    this._prevOnPose = source.onPose;
    const prev = source.onPose;
    source.onPose = (f) => { if (prev && prev !== source.onPose) prev(f); this.push(f); };
    this.reset();
  }

  reset() {
    for (const t of Object.values(this.tracks)) t.reset();
    this.hipsTrack.reset(); this.zFilter.reset(); this.conf.reset();
    this.locks.left.reset(); this.locks.right.reset();
    this.held = {}; this.metrics.reset();
    this._prevFoot = null; this._prevFootRaw = null; this.pelvisDrop = 0; this._twist = null;
  }

  /** Re-run the standing calibration (floor plane, facing, player size) over the next ~0.6 s. */
  calibrate() {
    this.calib = null; this._calibSamples = []; this._calibTries = 0; this.floorOffset = 0;
    this.state.calibrated = false; this._forceCalib = true;
    this.actions.recalibrate();
    this.reset();
  }

  _onAction(name, info) {
    const o = this.options;
    const mapped = o.mirror ? name.replace(/Left$/, '#').replace(/Right$/, 'Left').replace(/#$/, 'Right') : name;
    if (name === 'jump') this.jump = { active: true, t: performance.now() };
    const strength = name.startsWith('punch') ? clamp((info?.speed ?? 3) / 3.5, 0.6, 1.3) : 1;
    const fired = o.accents && this.accents.trigger(mapped, this._t, { strength });
    this.events.emit('action', { name: mapped, playerName: name, t: this._t, accent: !!fired });
    // expressions: combos (3 attacks inside 1.6 s) grin, everything else maps through ACTION_EXPRESSION
    let ex = ACTION_EXPRESSION[name];
    if (/^(punch|kick)/.test(name)) {
      const now = performance.now();
      this._hits = this._hits.filter((x) => now - x < 1600); this._hits.push(now);
      if (this._hits.length >= 3) { ex = 'happy'; this._hits.length = 0; }
    }
    if (ex) this.requestExpression(ex);
  }

  /** Ask the hero for an expression preset (emits 'expression'; calls hero.setExpression when options.expressions). */
  requestExpression(name) {
    this.events.emit('expression', { name });
    if (this.options.expressions && this.hero?.setExpression) this.hero.setExpression(name);
  }

  /**
   * Hit-stop: for `ms`, time inside the pipeline runs at `scale` (springs, accents, base) and the displayed
   * tracking time is frozen, so the pose holds on the impact frame; afterwards the tracking spring catches up
   * (~1-2 half-lives, 40-60 ms). Called by the fx module on punch/kick impacts.
   */
  hitStop(ms = 65, scale = 0.05) {
    const now = performance.now();
    if (now < this.hitStopUntil) { this.hitStopUntil = Math.max(this.hitStopUntil, now + ms * 0.5); return; }
    this.hitStopUntil = now + ms; this.hitStopScale = scale; this._frozenDisplay = null;
  }

  // ------------------------------------------------------------------------------------------ tracker frames
  push(frame) {
    const tArrive = performance.now();
    this.lastFrame = frame;
    if (!frame?.joints) return;
    const o = this.options;
    const t = frame.tCapture ?? tArrive;
    this.metrics.track.push(tArrive - t);
    this.latency += (tArrive - t - this.latency) * 0.1;
    this.actions.pushFrame(frame);

    const s0 = performance.now();
    // 1. world rotations of the VRM bones in the camera-aligned three frame
    let solved;
    const useMHR = frame.mhr && o.solver !== 'keypoints';
    if (useMHR) {
      this.mhrSolver.limits = o.mhrParamLimits;
      solved = this.mhrSolver.solve(frame);
      this.state.solver = 'mhr';
      this.state.fk = solved.fk;
      if (frame.j3d && frame.camT) {
        const e = this.mhr.keypointError(solved.fk, frame.camT, frame.j3d);
        this.metrics.fkErr.push(e.mean); this.metrics.fkMax.push(e.max);
      }
    } else {
      solved = this.kpSolver.solve(frame);
      this.state.solver = 'keypoints';
    }
    const J = frame.joints;
    // 2. calibration: floor plane (up + height), facing, player size
    this._calibrate(frame, solved);
    const C = this.calib.C, org = this.calib.origin;
    const toFloor = (p) => p.clone().sub(org).applyQuaternion(C).add(new THREE.Vector3(0, -this.floorOffset, 0));
    let world = {};
    for (const [b, q] of Object.entries(solved.world)) world[b] = q.clone().premultiply(C);
    let hips = toFloor(solved.hips);
    let pts = {};
    for (const [n, p] of Object.entries(J)) if (p) pts[n] = toFloor(p);
    // 3. mirror (avatar = mirror image): reflect x, swap sides
    let conf = frame.conf ?? {};
    if (o.mirror) {
      const w2 = {}, p2 = {}, c2 = {};
      for (const [b, q] of Object.entries(world)) w2[swapSide(b)] = mirrorQuat(q.clone());
      for (const [n, p] of Object.entries(pts)) p2[swapSide(n)] = new THREE.Vector3(-p.x, p.y, p.z);
      for (const [n, c] of Object.entries(conf)) c2[swapSide(n)] = c;
      world = w2; pts = p2; conf = c2; hips = new THREE.Vector3(-hips.x, hips.y, hips.z);
    }
    // 4. local rotations over the hero's bone hierarchy
    const rig = this.rig, local = {};
    for (const b of rig.bones) {
      if (!world[b]) continue;
      const p = rig.parent[b];
      if (!p) { local[b] = world[b].clone(); continue; }
      if (!world[p]) continue;
      local[b] = world[p].clone().invert().multiply(world[b]);
    }
    // forearm twist split: move part of the wrist's twist (about the forearm axis) into the forearm
    for (const s of ['left', 'right']) {
      const la = local[s + 'LowerArm'], h = local[s + 'Hand'];
      if (!la || !h || !rig.restWorld[s + 'Hand']) continue;
      const axis = rig.restDir(s + 'LowerArm', s + 'Hand');
      // twist angle about the forearm, unwrapped for continuity: theta and theta - 2 pi are the same hand
      // rotation but their halves differ by pi, which used to flip the forearm 180 deg near +-pi
      let th = 2 * Math.atan2(h.x * axis.x + h.y * axis.y + h.z * axis.z, h.w);
      th = Math.atan2(Math.sin(th), Math.cos(th));
      const prevTh = this._twist?.[s];
      if (prevTh !== undefined) { while (th - prevTh > Math.PI) th -= 2 * Math.PI; while (th - prevTh < -Math.PI) th += 2 * Math.PI; }
      th = clamp(th, -1.6 * Math.PI, 1.6 * Math.PI);
      (this._twist ??= {})[s] = th;
      const part = new THREE.Quaternion().setFromAxisAngle(axis, th * o.twistSplit);
      la.multiply(part); h.premultiply(part.invert());
    }
    if (o.limits) {
      for (const s of ['left', 'right']) {
        // elbows: flexion is -Y (left) / +Y (right) in the VRM1 normalized frame; knees: +X. No hyper-extension.
        if (local[s + 'LowerArm']) clampHinge(local[s + 'LowerArm'], Y, s === 'left' ? -2.7 : -0.05, s === 'left' ? 0.05 : 2.7);
        if (local[s + 'LowerLeg']) clampHinge(local[s + 'LowerLeg'], new THREE.Vector3(1, 0, 0), -0.05, 2.6);
      }
    }
    for (const [b, q] of Object.entries(local)) this.tracks[b]?.push(q, t);

    // 5. root: floor-frame hips -> hero hips (hip-height ratio), heavier filtering + dead-zone on depth
    const k = rig.hipHeight / this.calib.hipHeight;
    const rs = o.root.scale;
    let z = this.zFilter.filter(hips, t).z;
    const dz = o.root.zDeadzone; z = Math.abs(z) < dz ? 0 : z - Math.sign(z) * dz;
    const heroHips = new THREE.Vector3(
      o.root.follow ? hips.x * k * rs[0] : 0,
      rig.hipHeight + (hips.y - this.calib.hipHeight) * k * rs[1],
      o.root.follow ? z * k * rs[2] : 0);
    this.hipsTrack.push(heroHips, t);
    this.kScale = k;

    // 6. per-bone confidence (avatar names)
    for (const b of rig.bones) {
      const keys = boneConfKeys(o.mirror ? swapSide(b) : b).map((n) => (o.mirror ? swapSide(n) : n));
      this.boneConf[b] = Math.min(...keys.map((n) => conf[n] ?? (frame.source === 'synthetic' ? 1 : 0)));
    }
    this.state.legsTracked = Math.min(this.boneConf.leftLowerLeg ?? 0, this.boneConf.rightLowerLeg ?? 0) > 0.4;

    // 7. contacts from the player's feet (height above the calibrated floor + horizontal speed), avatar sides
    const sinceJump = (performance.now() - this.jump.t) / 1000;
    const airborne = this.jump.active && (sinceJump < 0.2 || hips.y > this.calib.hipHeight + 0.05);
    let lowest = Infinity;
    for (const s of ['left', 'right']) {
      const cand = [pts[s + 'Toe'], pts[s + 'Heel'], pts[s + 'Ankle'] && pts[s + 'Ankle'].clone().setY(pts[s + 'Ankle'].y - 0.07)].filter(Boolean);
      if (!cand.length) continue;
      const low = cand.reduce((a, b) => (b.y < a.y ? b : a));
      lowest = Math.min(lowest, low.y);
      this.contact[s].push(low, t, airborne);
      this.state.contacts[s] = this.state.legsTracked ? this.contact[s].contact : true;
    }
    // landing: after a jump, both feet back on the floor
    if (this.jump.active && sinceJump > 0.25 && this.contact.left.contact && this.contact.right.contact) {
      this.jump.active = false;
      if (o.accents) this.accents.trigger('land', this._t);
      this._landPending = clamp(sinceJump / 0.6, 0.5, 1.2);
    } else if (this.jump.active && sinceJump > 2) this.jump.active = false;
    // slow floor refinement while both feet are planted
    if (this.calib.done && this.state.legsTracked && this.contact.left.contact && this.contact.right.contact && Number.isFinite(lowest)) {
      this.floorOffset += clamp(lowest, -0.05, 0.05) * 0.02;
    }

    // 8. hand state from hand keypoints (InstantHMR); player hands -> avatar hands under mirror. A source may also
    //    send a ready classification: frame.handState = {left, right} (player sides).
    if (frame.handState) {
      for (const ps of ['left', 'right']) if (frame.handState[ps]) this.hands.state[o.mirror ? swapSide(ps) : ps] = frame.handState[ps];
      this._handInfoT = tArrive;
    }
    if (frame.kp3d) {
      this._handInfoT = tArrive;
      for (const ps of ['left', 'right']) {
        const as = o.mirror ? swapSide(ps) : ps;          // player's hand -> avatar side
        this.handConf[as] = conf[as + 'Wrist'] ?? 0;
        this.hands.classify(frame.kp3d, ps, this.handConf[as], as);
      }
    }

    // 9. metrics inputs: raw world rotations (jitter) and the player's wrists/ankles in hero scale (latency)
    this.metrics.rawJitter.push(null, t, world);
    const sig = this._signal(pts, k);
    if (sig) this.metrics.pushInput(t, sig);
    this.metrics.solveMs.push(performance.now() - s0);
    this.lastSample = { t, pts, hips, world, local, k };
    this.state.debug.points = pts;
  }

  // latency probe signal: wrists relative to the hips (pose lag, independent of the heavier root filtering)
  _signal(pts, k) {
    const a = pts.leftWrist, b = pts.rightWrist, h = pts.leftHip && pts.rightHip && pts.leftHip.clone().add(pts.rightHip).multiplyScalar(0.5);
    if (!a || !b || !h) return null;
    return [a.x - h.x, a.y - h.y, a.z - h.z, b.x - h.x, b.y - h.y, b.z - h.z].map((x) => x * k);
  }

  _calibrate(frame, solved) {
    const J = frame.joints, c = frame.conf ?? {};
    const ok = (...n) => n.every((x) => J[x] && (frame.source === 'synthetic' || (c[x] ?? 0) > 0.5));
    if (!this.calib) {
      // provisional: camera up, origin under the first hips
      const h = solved.hips.clone();
      this.calib = { C: new THREE.Quaternion(), origin: new THREE.Vector3(h.x, h.y - 0.9, h.z), hipHeight: 0.9, done: false };
    }
    if (this.calib.done || !this.options.autoCalibrate && !this._forceCalib) return;
    if (!ok('leftHip', 'rightHip', 'leftShoulder', 'rightShoulder', 'neck')) return;
    const feet = ok('leftAnkle', 'rightAnkle');
    const ankleMid = feet ? J.leftAnkle.clone().add(J.rightAnkle).multiplyScalar(0.5) : null;
    const hipMid = J.leftHip.clone().add(J.rightHip).multiplyScalar(0.5);
    const up = (ankleMid ? J.neck.clone().sub(ankleMid) : J.neck.clone().sub(hipMid)).normalize();
    const footPts = ['leftToe', 'rightToe', 'leftHeel', 'rightHeel'].map((n) => J[n]).filter(Boolean);
    this._calibSamples.push({ up, left: J.leftHip.clone().sub(J.rightHip), hips: solved.hips.clone(), feet: feet ? footPts : null });
    // prefer a still window (hips within 6 cm over 15 frames); if the player never holds still, calibrate on
    // the last 30 frames after 2 s anyway (floor and facing are averages, motion only adds a little noise)
    const S = this._calibSamples;
    this._calibTries = (this._calibTries ?? 0) + 1;
    const still = S.length >= 15 && S.slice(-15).every((x) => x.hips.distanceTo(S.at(-15).hips) < 0.06);
    const timeout = this._calibTries > 50 && S.length >= 30;
    if (S.length > 60) S.shift();
    if (!still && !timeout) return;
    S.splice(0, S.length - (still ? 15 : 30));
    const U = new THREE.Vector3(), L = new THREE.Vector3(), H = new THREE.Vector3();
    for (const x of S) { U.add(x.up); L.add(x.left); H.add(x.hips); }
    U.normalize(); H.divideScalar(S.length);
    let floorD;
    if (S[0].feet && S[0].feet.length) {
      floorD = S.reduce((s, x) => s + Math.min(...x.feet.map((p) => p.dot(U))), 0) / S.length;
    } else floorD = H.dot(U) - 0.92;        // legs not visible: assume an average hip height
    const q1 = fromTo(U, Y);
    const l1 = L.clone().applyQuaternion(q1);
    const q2 = this.options.calibrateYaw ? new THREE.Quaternion().setFromAxisAngle(Y, Math.atan2(l1.z, l1.x)) : new THREE.Quaternion();
    const hipHeight = Math.max(0.5, H.dot(U) - floorD);
    this.calib = { C: q2.multiply(q1), origin: H.clone().addScaledVector(U, -hipHeight), hipHeight, done: true };
    this._forceCalib = false;
    this.floorOffset = 0;
    this.state.calibrated = true;
    if (this.kpSolver && J.nose && J.leftEar && J.rightEar) {
      // neutral head: the nose-vs-ear-line pitch while standing still is "looking straight"
      const em = J.leftEar.clone().add(J.rightEar).multiplyScalar(0.5);
      const f = J.nose.clone().sub(em).applyQuaternion(this.calib.C);
      this.kpSolver.headPitch = clamp(Math.atan2(-f.y, Math.hypot(f.x, f.z)), -0.6, 0.6) * -1;
    }
    this.reset();
  }

  // ------------------------------------------------------------------------------------------ render frames
  /**
   * Advance the pipeline to `renderTime` (performance.now() timebase) and return the pose
   * {hips: Vector3, rotations: {VRMHumanBoneName: Quaternion}} (also applied to the hero when options.apply).
   */
  update(dt, renderTime = performance.now()) {
    const u0 = performance.now();
    dt = clamp(dt || 1 / 60, 1e-4, 0.1);
    // hit-stop: internal time slows down and the displayed tracking time freezes on the impact frame
    const stopped = u0 < this.hitStopUntil;
    if (stopped) dt *= this.hitStopScale;
    this._t += dt;
    const o = this.options, rig = this.rig;
    let tDisplay = renderTime - Math.max(0, this.latency - o.predictMs);
    if (stopped) { this._frozenDisplay ??= tDisplay; tDisplay = this._frozenDisplay; } else this._frozenDisplay = null;
    const topts = { predict: o.predict, spring: o.spring, springScale: o.springScale, maxHorizon: o.maxHorizonMs / 1000, noiseAware: o.noiseAware };
    if (this.lastSample) this.metrics.lead.push(Math.min(o.maxHorizonMs, Math.max(0, tDisplay - this.lastSample.t)));

    // 1. tracked (predicted + spring) locals
    const tracked = {};
    for (const b of rig.bones) { const q = this.tracks[b].update(tDisplay, dt, topts); if (q) tracked[b] = q; }
    const trackedHips = this.hipsTrack.update(tDisplay, dt, topts);
    // filter-stage jitter (prediction + spring only), same bones/frame as the raw solver jitter
    if (tracked.hips && !stopped) this._pushFilterJitter(tracked, renderTime);
    // 2. confidence -> weights; hold last good, then fade to the procedural base
    const fresh = this.lastFrame && renderTime - (this.lastFrame.tCapture ?? 0) < 600 && this.lastFrame.joints;
    const cmap = {};
    for (const b of rig.bones) cmap[b] = fresh && tracked[b] ? (o.confidence ? this.boneConf[b] ?? 0 : 1) : 0;
    const W = this.conf.update(rig.bones, cmap, dt);
    this.base.style = o.baseStyle;
    // the procedural base only matters where some bone is not fully tracked (skip its IK when everything is)
    let needBase = false;
    for (const b of rig.bones) if ((W[b] ?? 0) < 0.999 && !/(Thumb|Index|Middle|Ring|Little)/.test(b)) { needBase = true; break; }
    const base = o.base && needBase ? this.base.sample(this._t) : (this._noBase ??= { rotations: {}, hipsOffset: new THREE.Vector3(), hand: 'relaxed' });
    const rot = this.pose.rotations;
    for (const b of rig.bones) {
      const r = rot[b] ?? (rot[b] = new THREE.Quaternion());
      if (base.rotations[b]) r.copy(base.rotations[b]); else r.identity();
      if (this.conf.vis[b] && tracked[b]) this.held[b] = (this.held[b] ?? new THREE.Quaternion()).copy(tracked[b]);
      const src = this.conf.vis[b] ? tracked[b] : this.held[b];
      const finger = /(Thumb|Index|Middle|Ring|Little)/.test(b);
      const w = src && (!finger || o.hands === 'tracked') ? W[b] ?? 0 : 0;
      if (w > 0) r.slerp(src, w);
    }
    // 3. hips: tracked root weighted by hips confidence, base offset otherwise
    const wh = W.hips ?? 0;
    const hips = this.pose.hips;
    const restHips = new THREE.Vector3(0, rig.hipHeight, 0).add(base.hipsOffset);
    hips.copy(restHips);
    if (trackedHips) hips.lerp(trackedHips, wh);
    // 4. accents
    const legsTracked = this.state.legsTracked && (W.leftLowerLeg ?? 0) > 0.5;
    const acc = o.accents ? this.accents.sample(this._t, { legsTracked }) : null;
    // punch aim (QA v3 r2 P1-2): the tracked shoulder->hand direction BEFORE the accent turns the torso, so the
    // arm IK can keep the fist travelling straight while the chest rotates under it
    let aim = null;
    if (acc && (acc.reach.left > 0.01 || acc.reach.right > 0.01)) {
      const f0 = rig.fk(rot, hips, this._aimFK ??= { rot: {}, pos: {} });
      for (const s of ['left', 'right']) {
        if (acc.reach[s] <= 0.01 || !f0.pos[s + 'Hand'] || (W[s + 'LowerArm'] ?? 0) < 0.3) continue;
        const d = (this._aimDir ??= { left: new THREE.Vector3(), right: new THREE.Vector3() })[s].copy(f0.pos[s + 'Hand']).sub(f0.pos[s + 'UpperArm']);
        if (d.lengthSq() > 1e-8) (aim ??= {})[s] = d.normalize();
      }
    }
    if (acc) {
      for (const [b, q] of Object.entries(acc.add)) if (rot[b]) rot[b].multiply(q);
      hips.add(acc.hips);
      if (acc.hang > 0 && hips.y > rig.hipHeight) hips.y += (hips.y - rig.hipHeight) * 0.3 * acc.hang;   // anime hang time
      // kick snap on a tracked leg: extend the knee toward straight
      for (const s of ['left', 'right']) if (acc.kneeExt[s] > 0 && rot[s + 'LowerLeg']) rot[s + 'LowerLeg'].slerp(_qI, acc.kneeExt[s] * 0.92);
    }
    // 5. hands: accent override > tracked classification (recent hand data) > base stance (untracked arm) >
    //    guard heuristic (tracked wrist up near the face, no hand data) > relaxed
    const handInfo = this._handInfoT && u0 - this._handInfoT < 500;
    const fkPrev = this.state.heroFK;
    for (const s of ['left', 'right']) {
      let goal = o.handOverride?.[s] ?? acc?.hand[s] ?? null;
      if (!goal) {
        if (handInfo) goal = this.hands.state[s];
        else if ((W[s + 'LowerArm'] ?? 0) < 0.5) goal = base.hand ?? 'relaxed';
        else if (fkPrev?.pos.head && fkPrev.pos[s + 'Hand']) {
          const d = fkPrev.pos[s + 'Hand'].distanceTo(fkPrev.pos.head), up = fkPrev.pos[s + 'Hand'].y > fkPrev.pos[s + 'UpperArm'].y - 0.12;
          goal = d < 0.32 * rig.height / 1.6 && up ? 'fist' : 'relaxed';
        } else goal = 'relaxed';
      }
      this.hands.override[s] = goal;
    }
    if (o.hands === 'pose') this.hands.apply(rot, dt, rig.present);
    // 6. IK on the hero skeleton
    let fk = rig.fk(rot, hips);
    const fkPre = { left: fk.pos.leftFoot?.clone(), right: fk.pos.rightFoot?.clone() };
    if (o.ikLegs && rig.present.has('leftFoot')) {
      const targets = {};
      for (const s of ['left', 'right']) {
        const contact = (legsTracked ? this.contact[s].contact : true) && o.footLock && !(acc?.free[s]);
        const reach = { hip: fk.pos[s + 'UpperLeg'].clone().setY(fk.pos[s + 'UpperLeg'].y - (o.pelvis ? 0.18 : 0)),
          max: (rig.leg[s][0] + rig.leg[s][1]) * 1.0 };
        targets[s] = this.locks[s].update(fk.pos[s + 'Foot'], contact, rig.ankleHeight, dt, reach).clone();
        this.state.locked[s] = this.locks[s].locked;
        if (!this.locks[s].locked) targets[s].y = Math.max(targets[s].y, rig.ankleHeight * 0.85);   // keep the foot above the floor
      }
      // pelvis: lower the hips when a planted foot is out of reach; keep the knees soft (never a locked plank)
      let drop = 0;
      if (o.pelvis) {
        for (const s of ['left', 'right']) {
          if (!this.locks[s].locked) continue;
          const hp = fk.pos[s + 'UpperLeg'], L = (rig.leg[s][0] + rig.leg[s][1]) * 0.97;
          const d = targets[s].clone().sub(hp), horiz = Math.hypot(d.x, d.z);
          if (horiz < L) drop = Math.max(drop, (hp.y - targets[s].y) - Math.sqrt(L * L - horiz * horiz));
        }
      }
      drop = clamp(drop, 0, 0.18);
      // drop at once when a planted foot needs it (no under-reach), recover smoothly
      this.pelvisDrop = drop > this.pelvisDrop ? drop : this.pelvisDrop + (drop - this.pelvisDrop) * (1 - Math.exp(-dt / 0.08));
      if (this.pelvisDrop > 1e-4) { hips.y -= this.pelvisDrop; fk = rig.fk(rot, hips); }
      const hipFwd = _v1.set(0, 0, 1).applyQuaternion(fk.rot.hips).setY(0).normalize();
      for (const s of ['left', 'right']) {
        const ul = s + 'UpperLeg', ll = s + 'LowerLeg', ft = s + 'Foot';
        const footW = fk.rot[ft].clone();
        const aR = fk.rot[ul].clone(), bR = fk.rot[ll].clone();
        if (o.kneePole && this.legInv[ul]) {
          // knee pole: the tracked/authored knee direction when the leg is visibly bent, else foot forward
          // (knees track over the toes), never behind the hips' forward
          const hp = fk.pos[ul], kn = fk.pos[ll], an = fk.pos[ft];
          const axis = _v2.copy(an).sub(hp); const al = axis.length() || 1; axis.divideScalar(al);
          const off = _v3.copy(kn).sub(hp); off.addScaledVector(axis, -off.dot(axis));
          const bend = smoothstep(0.06, 0.25, off.length() / rig.leg[s][0]);
          const footFwd = _v4.set(0, 0, 1).applyQuaternion(footW).setY(0);
          if (footFwd.lengthSq() < 1e-6) footFwd.copy(hipFwd); footFwd.normalize();
          const pole = _v5.copy(footFwd).add(hipFwd).normalize();
          if (off.lengthSq() > 1e-8) pole.lerp(off.normalize(), bend);
          if (pole.dot(hipFwd) < 0.2) pole.addScaledVector(hipFwd, 0.2 - pole.dot(hipFwd));
          poleIK(hp, rig.leg[s][0], rig.leg[s][1], targets[s], pole.normalize(), this.legInv[ul], this.legInv[ll], aR, bR, 0.015);
        } else twoBoneIK(fk.pos[ul], fk.pos[ll], fk.pos[ft], aR, bR, targets[s], 0.015);
        // planted foot: flatten pitch/roll toward the floor, keep heading
        if (this.locks[s].locked) {
          const f = Z.clone().applyQuaternion(footW);
          const flat = new THREE.Quaternion().setFromAxisAngle(Y, Math.atan2(f.x, f.z));
          footW.slerp(flat, 0.8);
        }
        rot[ul].copy(fk.rot[rig.parent[ul]]).invert().multiply(aR);
        rot[ll].copy(aR).invert().multiply(bR);
        rot[ft].copy(bR).invert().multiply(footW);
      }
      fk = rig.fk(rot, hips);
      for (const s of ['left', 'right']) if (this.locks[s].locked) this.metrics.ikErr.push(fk.pos[s + 'Foot'].distanceTo(targets[s]));
    }
    if (o.ikArms) {
      for (const s of ['left', 'right']) {
        const ua = s + 'UpperArm', la = s + 'LowerArm', hd = s + 'Hand';
        if (!fk.pos[hd]) continue;
        const boost = acc ? acc.reach[s] : 0;
        if ((W[la] ?? 0) < 0.3 && boost < 0.01) continue;
        const L = rig.arm[s][0] + rig.arm[s][1];
        const sh = fk.pos[ua], wr = fk.pos[hd];
        const d = wr.clone().sub(sh), ext = d.length() / L;
        let e = ext;
        if (o.reachRemap && ext > 0.8) e = 0.8 + 0.2 * smoothstep(0.8, 0.95, ext);
        e = e + (1 - e) * boost;
        if (Math.abs(e - ext) < 0.004 && !aim?.[s]) continue;
        const aR = fk.rot[ua].clone(), bR = fk.rot[la].clone();
        let el = fk.pos[la], hand = fk.pos[hd];
        d.normalize();
        if (aim?.[s]) {
          // swing the whole arm about the shoulder back onto the tracked direction (weighted by the accent), then
          // extend along it: the accent's torso twist no longer drags the fist across the body
          const q = quatPow(fromTo(d, aim[s]), boost);
          aR.premultiply(q); bR.premultiply(q);
          el = el.clone().sub(sh).applyQuaternion(q).add(sh); hand = hand.clone().sub(sh).applyQuaternion(q).add(sh);
          d.copy(hand).sub(sh).normalize();
        }
        const target = sh.clone().addScaledVector(d, e * L);
        twoBoneIK(sh, el, hand, aR, bR, target, 0.01);
        rot[ua].copy(fk.rot[rig.parent[ua]]).invert().multiply(aR);
        rot[la].copy(aR).invert().multiply(bR);
        // the hand keeps its LOCAL rotation (it travels with the forearm); keeping its world rotation bent the
        // wrist back ~90 deg whenever the reach boost straightened the arm (QA P0-3)
      }
    }
    // wrist limits (+-45 deg flexion/extension, +-30 deg deviation), fist straight in line with the forearm
    if (o.wristLimits) {
      for (const s of ['left', 'right']) {
        const q = rot[s + 'Hand']; if (!q) continue;
        clampWrist(q, s, o.wristFlex, o.wristDev, acc ? acc.wrist[s] : 0);
      }
    }
    fk = rig.fk(rot, hips);
    // 7. look-at (head 70 %, neck 30 %, limited)
    if (o.lookAt && fk.pos.head) {
      const dir = o.lookAt.clone().sub(fk.pos.head).normalize();
      const headW = fk.rot.head, fwd = Z.clone().applyQuaternion(headW);
      const full = fromTo(fwd, dir);
      const ang = 2 * Math.acos(clamp(full.w, -1, 1));
      const lim = Math.min(1, 1.0 / Math.max(ang, 1e-6));
      const want = quatPow(full, lim * o.lookAtWeight);
      const neckPart = quatPow(want, 0.3), headPart = quatPow(want, 0.7);
      if (rot.neck && fk.rot[rig.parent.neck]) {
        const nW = neckPart.clone().multiply(fk.rot.neck);
        rot.neck.copy(fk.rot[rig.parent.neck]).invert().multiply(nW);
        const hW = headPart.clone().multiply(neckPart).multiply(headW);
        rot.head.copy(nW).invert().multiply(hW);
      }
      fk = rig.fk(rot, hips);
    }
    // 8. events on the final pose: impacts (fist / foot at full extension), landings
    if (acc?.impacts.length) {
      for (const im of acc.impacts) {
        const s = im.side;
        const end = im.kind === 'punch' ? s + 'Hand' : s + 'Foot', from = im.kind === 'punch' ? s + 'LowerArm' : s + 'LowerLeg';
        if (!fk.pos[end] || !fk.pos[from]) continue;
        const dir = fk.pos[end].clone().sub(fk.pos[from]).normalize();
        const pos = fk.pos[end].clone().addScaledVector(dir, (im.kind === 'punch' ? 0.07 : 0.12) * rig.height / 1.6);
        this.events.emit('impact', { ...im, pos, dir, space: 'hero' });
      }
    }
    if (this._landPending && fk.pos.leftFoot) {
      this.events.emit('land', { strength: this._landPending, feet: [fk.pos.leftFoot.clone(), fk.pos.rightFoot.clone()], space: 'hero' });
      this._landPending = 0;
    }
    // 9. metrics on the final pose
    if (!stopped) this.metrics.finalJitter.push(null, renderTime, fk.rot);
    for (const s of ['left', 'right']) {
      if (!fk.pos[s + 'Foot']) continue;
      const prev = this._prevFoot?.[s], prevRaw = this._prevFootRaw?.[s];
      if (prev && this.locks[s].locked && this.state.legsTracked) {
        this.metrics.skateOut.push(Math.hypot(fk.pos[s + 'Foot'].x - prev.x, fk.pos[s + 'Foot'].z - prev.z) / dt);
        if (prevRaw && fkPre[s]) this.metrics.skateRaw.push(Math.hypot(fkPre[s].x - prevRaw.x, fkPre[s].z - prevRaw.z) / dt);
      }
    }
    this.metrics.contactFrac.push(this.locks.left.locked && this.locks.right.locked ? 1 : 0);
    this._prevFoot = { left: fk.pos.leftFoot?.clone(), right: fk.pos.rightFoot?.clone() };
    this._prevFootRaw = fkPre;
    if (fk.pos.leftHand && !stopped) {
      const a = fk.pos.leftHand, b = fk.pos.rightHand, h = fk.pos.leftUpperLeg.clone().add(fk.pos.rightUpperLeg).multiplyScalar(0.5);
      this.metrics.pushOutput(renderTime, [a.x - h.x, a.y - h.y, a.z - h.z, b.x - h.x, b.y - h.y, b.z - h.z]);
    }
    this.state.weights = W;
    this.state.heroFK = fk;
    this.state.hitStop = stopped;
    this.metrics.updateMs.push(performance.now() - u0);

    const out = o.convention === 'vrm0' ? toVRM0Pose(this.pose, this._vrm0) : this.pose;
    if (o.apply && this.hero?.applyHumanoidPose) this.hero.applyHumanoidPose(out);
    return out;
  }

  // world rotations of the jitter bones from the filter-stage locals (chain multiply, no full FK)
  _pushFilterJitter(tracked, t) {
    const rig = this.rig, w = this._jw ??= {};
    for (const end of ['hips', 'head', 'leftHand', 'rightHand']) {
      if (!rig.present.has(end)) continue;
      const q = w[end] ??= new THREE.Quaternion();
      q.identity();
      for (let b = end; b; b = rig.parent[b]) { const l = tracked[b]; if (l) q.premultiply(l); }
    }
    this.metrics.outJitter.push(null, t, w);
  }

  /** Live predictor tuning constants (track.js PREDICT), for experiments. */
  get predictTuning() { return PREDICT; }
  get bones() { return this.rig.bones; }
  dispose() { this.setSource(null); }
}

export { BODY_BONES };
