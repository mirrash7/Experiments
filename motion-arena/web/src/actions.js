// Gesture / action triggers — the hooks a Kinect-style game will listen to.
// Works on the player-space pose (the player's own left/right; map to avatar sides yourself in mirror mode).
//
//   const det = new ActionDetector(); det.on((name, info) => ...); det.update(joints, conf, tCapture)
//   det.pushFrame(frame)   // same, through the built-in LIGHT one-euro filter (high cutoff: fires earlier than
//                          // a heavily smoothed stream; this is what the motion pipeline uses)
//
// Continuous states (held poses) fire once on entry; impulses (punch, jump, kick) fire on motion and then
// cool down. Every event carries `latencyRef` = the camera capture time of the frame that triggered it.
import * as THREE from 'three';
import { midpoint } from './pose.js';

/** Light one-euro on joint positions for the action stream: removes keypoint noise, adds only a few ms of lag. */
export class LightPoseFilter {
  constructor({ minCutoff = 5, beta = 3, dCutoff = 1.5 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.s = {};
  }
  reset() { this.s = {}; }
  apply(joints, tMs) {
    const out = {};
    for (const [name, v] of Object.entries(joints)) {
      if (!v) continue;
      let st = this.s[name];
      if (!st || tMs <= st.t) { st = this.s[name] = { x: v.clone(), dx: new THREE.Vector3(), t: tMs }; out[name] = v.clone(); continue; }
      const dt = Math.max(1e-3, (tMs - st.t) / 1000); st.t = tMs;
      const a = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
      st.dx.lerp(v.clone().sub(st.x).divideScalar(dt), a(this.dCutoff));
      st.x.lerp(v, a(this.minCutoff + this.beta * st.dx.length()));
      out[name] = st.x.clone();
    }
    return out;
  }
}

export const ACTIONS = {
  jump: { label: 'JUMP', kind: 'impulse', color: '#ffd23f' },
  squat: { label: 'SQUAT', kind: 'state', color: '#5ad1ff' },
  punchLeft: { label: 'LEFT PUNCH', kind: 'impulse', color: '#ff6b6b' },
  punchRight: { label: 'RIGHT PUNCH', kind: 'impulse', color: '#ff6b6b' },
  kickLeft: { label: 'LEFT KICK', kind: 'impulse', color: '#ff9f43' },
  kickRight: { label: 'RIGHT KICK', kind: 'impulse', color: '#ff9f43' },
  leftHandUp: { label: 'LEFT HAND UP', kind: 'state', color: '#7bed9f' },
  rightHandUp: { label: 'RIGHT HAND UP', kind: 'state', color: '#7bed9f' },
  handsUp: { label: 'HANDS UP', kind: 'state', color: '#2ed573' },
  guard: { label: 'GUARD', kind: 'state', color: '#70a1ff' },
  tPose: { label: 'T-POSE', kind: 'state', color: '#a29bfe' },
  leanLeft: { label: 'LEAN LEFT', kind: 'state', color: '#f8a5c2' },
  leanRight: { label: 'LEAN RIGHT', kind: 'state', color: '#f8a5c2' },
  stepLeft: { label: 'STEP LEFT', kind: 'state', color: '#c8d6e5' },
  stepRight: { label: 'STEP RIGHT', kind: 'state', color: '#c8d6e5' },
};

const PUNCH_PAIR_MS = 150;     // never both arms inside this window (a both-arms raise is not two punches)

export class ActionDetector {
  constructor() {
    this.listeners = new Set();
    this.state = {};
    this.lastFire = {};
    this.hist = [];
    this.calib = null;
    this._calibSamples = [];
    this.sensitivity = 1.0;
    this.filter = new LightPoseFilter();
    this._prevExt = {};
    this._kickArmed = { left: true, right: true };
    this.clock = null;          // optional () => ms (tests); default performance.now()
  }
  /** Feed a source PoseFrame through the light filter (player-space joints). */
  pushFrame(frame) {
    if (!frame?.joints) return;
    this.update(this.filter.apply(frame.joints, frame.tCapture), frame.conf, frame.tCapture);
  }
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  recalibrate() { this.calib = null; this._calibSamples = []; this.hist = []; this.filter?.reset(); this._kickArmed = { left: true, right: true }; }

  /** Torso forward (horizontal unit vector, player frame): shoulder line + hip line, crossed with up. */
  _forward(J) {
    const f = this._fwd ?? (this._fwd = new THREE.Vector3(0, 0, 1));
    const side = J.leftShoulder.clone().sub(J.rightShoulder);
    if (J.leftHip && J.rightHip) side.add(J.leftHip.clone().sub(J.rightHip));
    const g = new THREE.Vector3(-side.z, 0, side.x);       // side x up
    if (g.lengthSq() > 1e-6) f.lerp(g.normalize(), 0.5).normalize();
    return f;
  }

  _fire(name, t, extra = {}) {
    this.lastFire[name] = t;
    for (const cb of this.listeners) cb(name, { t, ...extra });
  }
  _setState(name, active, t, tCapture) {
    const was = !!this.state[name];
    this.state[name] = active;
    if (active && !was) this._fire(name, t, { tCapture });
  }
  _impulse(name, cond, t, tCapture, cooldown = 450, extra = {}) {
    const ok = cond && (t - (this.lastFire[name] ?? -1e9)) > cooldown;
    this.state[name] = cond;
    if (ok) this._fire(name, t, { tCapture, ...extra });
  }

  update(J, conf, tCapture) {
    const t = this.clock ? this.clock() : performance.now();
    const s = this.sensitivity;
    const hip = midpoint(J.leftHip, J.rightHip);
    const sh = midpoint(J.leftShoulder, J.rightShoulder);
    const torso = Math.max(0.25, sh.distanceTo(hip));          // body-size ruler (≈0.5 m)
    const ankles = midpoint(J.leftAnkle, J.rightAnkle);

    if (!this.calib) {
      this._calibSamples.push({ hip: hip.clone(), ankles: ankles.clone(), torso });
      if (this._calibSamples.length >= 15) {
        const c = { hip: new THREE.Vector3(), ankles: new THREE.Vector3(), torso: 0 };
        for (const x of this._calibSamples) { c.hip.add(x.hip); c.ankles.add(x.ankles); c.torso += x.torso; }
        const n = this._calibSamples.length;
        c.hip.divideScalar(n); c.ankles.divideScalar(n); c.torso /= n;
        this.calib = c;
      }
      return;
    }

    this.hist.push({ t: tCapture, J });
    while (this.hist.length > 2 && tCapture - this.hist[1].t >= 60) this.hist.shift();
    const old = this.hist[0];
    const dt = Math.max(0.016, (tCapture - old.t) / 1000);
    const vel = (name) => (J[name] && old.J[name] ? J[name].clone().sub(old.J[name]).divideScalar(dt) : new THREE.Vector3());
    const ok = (...n) => n.every((k) => (conf[k] ?? 0) > 0.4);
    const ruler = this.calib.torso;

    // Hands
    const headY = J.nose.y;
    const lUp = ok('leftWrist') && J.leftWrist.y > headY + 0.05;
    const rUp = ok('rightWrist') && J.rightWrist.y > headY + 0.05;
    this._setState('handsUp', lUp && rUp, t, tCapture);
    this._setState('leftHandUp', lUp && !rUp, t, tCapture);
    this._setState('rightHandUp', rUp && !lUp, t, tCapture);

    const armOut = (side) => {
      const S = J[side + 'Shoulder'], W = J[side + 'Wrist'];
      return ok(side + 'Wrist', side + 'Shoulder') && Math.abs(W.y - S.y) < 0.35 * ruler && Math.abs(W.x - S.x) > 0.9 * ruler;
    };
    this._setState('tPose', armOut('left') && armOut('right'), t, tCapture);

    // Guard: both fists up near the face, in front of the body (held)
    const nearFace = (side) => {
      const W = J[side + 'Wrist'], S = J[side + 'Shoulder'];
      return ok(side + 'Wrist', side + 'Shoulder') && J.nose && W.distanceTo(J.nose) < 0.8 * ruler && W.y > S.y - 0.1 * ruler && W.z > S.z + 0.1 * ruler;
    };
    this._setState('guard', nearFace('left') && nearFace('right') && !lUp && !rUp, t, tCapture);

    // Punches: a fast FORWARD extension of the arm. QA v3 r2 P0-1: the old rule (wrist speed along shoulder->wrist
    // + extension) also fired on every fast arm raise or spread (hands up, jump take-off, T-pose, wave), on both
    // arms at once. Now the wrist must move along the torso's forward axis (relative to the shoulder, so body
    // motion does not count), end up in front of the shoulder, stay between hip and head height; held arm-up
    // states and jump take-offs suppress punches, and the two arms never fire inside PUNCH_PAIR_MS (faster wins).
    const fwd = this._forward(J);
    const jumping = t - (this.lastFire.jump ?? -1e9) < 400 || (vel('leftHip').y + vel('rightHip').y) * 0.5 > 0.6;
    const cand = [];
    for (const side of ['left', 'right']) {
      const S = J[side + 'Shoulder'], E = J[side + 'Elbow'], W = J[side + 'Wrist'];
      if (!ok(side + 'Wrist', side + 'Elbow', side + 'Shoulder')) { this.state[side === 'left' ? 'punchLeft' : 'punchRight'] = false; continue; }
      const armLen = S.distanceTo(E) + E.distanceTo(W) + 1e-6;
      const ext = W.distanceTo(S) / armLen;                                   // 1 = straight arm
      const v = vel(side + 'Wrist').sub(vel(side + 'Shoulder'));
      const speed = v.length(), speedFwd = v.dot(fwd);
      const reachFwd = W.clone().sub(S).dot(fwd) / armLen;                     // 1 = arm straight forward
      const rising = ext - (this._prevExt[side] ?? ext) > 0.01;
      this._prevExt[side] = ext;
      const name = side === 'left' ? 'punchLeft' : 'punchRight';
      // fire on the way out: a fast extension that is already most of the way there, or a near-straight arm
      const early = ext > 0.72 && rising && speedFwd > 2.0 / s;
      const late = ext > 0.86 && speedFwd > 1.4 / s;
      const aimed = speedFwd > 0.6 * speed && reachFwd > 0.45;               // forward cone (~53 deg), fist out front
      const height = W.y > hip.y + 0.2 * ruler && W.y < headY + 0.12 * ruler;
      const blocked = this.state.handsUp || this.state.tPose || jumping || (side === 'left' ? lUp : rUp);
      const cond = (early || late) && aimed && height && !blocked;
      this.state[name] = cond;
      if (cond && t - (this.lastFire[name] ?? -1e9) > 350) cand.push({ name, side, speed: speedFwd, ext });
    }
    if (cand.length === 2) cand.splice(cand[0].speed >= cand[1].speed ? 1 : 0, 1);   // both at once: keep the faster
    for (const c of cand) {
      const otherName = c.side === 'left' ? 'punchRight' : 'punchLeft';
      if (t - (this.lastFire[otherName] ?? -1e9) < PUNCH_PAIR_MS) continue;     // the other arm just fired
      this._fire(c.name, t, { tCapture, side: c.side, speed: c.speed, ext: c.ext });
    }

    // Lower body
    const legsOk = ok('leftAnkle', 'rightAnkle', 'leftKnee', 'rightKnee');
    const dy = hip.y - this.calib.hip.y;
    const vy = vel('leftHip').add(vel('rightHip')).multiplyScalar(0.5).y;
    this._impulse('jump', dy > 0.13 * ruler / s && vy > 0.5 / s && (!legsOk || ankles.y - this.calib.ankles.y > 0.06 * ruler), t, tCapture, 600);
    this._setState('squat', dy < -0.32 * ruler * s && !this.state.jump, t, tCapture);

    // Kicks (QA v3 r2 P1-1): the foot must be rising (or driving forward, not falling) with the knee raised; one
    // kick per foot lift: the side re-arms only once the foot is back down level with the support foot, so the
    // lowering after a kick can never fire a second one.
    if (legsOk) {
      for (const side of ['left', 'right']) {
        const other = side === 'left' ? 'right' : 'left';
        const name = side === 'left' ? 'kickLeft' : 'kickRight';
        const A = J[side + 'Ankle'], B = J[other + 'Ankle'];
        const lift = A.y - B.y;
        if (lift < 0.12 * ruler) this._kickArmed[side] = true;
        const vA = vel(side + 'Ankle');
        const drive = vA.y + Math.max(0, vA.dot(fwd)) * 0.7;                    // upward + forward foot speed
        const knee = J[side + 'Knee'].y - J[other + 'Knee'].y > 0.12 * ruler;
        const cond = lift > 0.45 * ruler / s && knee && vA.y > -0.1 && drive > 0.9 / s;
        this.state[name] = cond;
        if (cond && this._kickArmed[side] && t - (this.lastFire[name] ?? -1e9) > 400) {
          this._kickArmed[side] = false;
          this._fire(name, t, { tCapture, side, speed: drive });
        }
      }
    }

    // Lean: torso tilt in the frontal plane
    const up = sh.clone().sub(hip);
    const tilt = Math.atan2(up.x, up.y);
    this._setState('leanLeft', tilt > 0.26, t, tCapture);
    this._setState('leanRight', tilt < -0.26, t, tCapture);

    // Side steps
    const dx = hip.x - this.calib.hip.x;
    this._setState('stepLeft', dx > 0.45 * ruler * 1.6, t, tCapture);
    this._setState('stepRight', dx < -0.45 * ruler * 1.6, t, tCapture);
  }
}
