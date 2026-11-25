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
  }
  /** Feed a source PoseFrame through the light filter (player-space joints). */
  pushFrame(frame) {
    if (!frame?.joints) return;
    this.update(this.filter.apply(frame.joints, frame.tCapture), frame.conf, frame.tCapture);
  }
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  recalibrate() { this.calib = null; this._calibSamples = []; this.hist = []; this.filter?.reset(); }

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
    const t = performance.now();
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

    // Punches: fast, extending arm
    for (const side of ['left', 'right']) {
      const S = J[side + 'Shoulder'], E = J[side + 'Elbow'], W = J[side + 'Wrist'];
      if (!ok(side + 'Wrist', side + 'Elbow')) continue;
      const ext = W.distanceTo(S) / (S.distanceTo(E) + E.distanceTo(W) + 1e-6); // 1 = straight arm
      const v = vel(side + 'Wrist');
      const away = W.clone().sub(S).normalize();
      const speedOut = v.dot(away);
      const name = side === 'left' ? 'punchLeft' : 'punchRight';
      const rising = ext - (this._prevExt[side] ?? ext) > 0.01;
      this._prevExt[side] = ext;
      // fire on the way out: a fast extension that is already most of the way there, or a near-straight arm
      const early = ext > 0.72 && rising && speedOut > 2.4 / s;
      const late = ext > 0.86 && speedOut > 1.6 / s;
      this._impulse(name, (early || late) && W.y > hip.y + 0.2 * ruler, t, tCapture, 350, { side, speed: speedOut, ext });
    }

    // Lower body
    const legsOk = ok('leftAnkle', 'rightAnkle', 'leftKnee', 'rightKnee');
    const dy = hip.y - this.calib.hip.y;
    const vy = vel('leftHip').add(vel('rightHip')).multiplyScalar(0.5).y;
    this._impulse('jump', dy > 0.13 * ruler / s && vy > 0.5 / s && (!legsOk || ankles.y - this.calib.ankles.y > 0.06 * ruler), t, tCapture, 600);
    this._setState('squat', dy < -0.32 * ruler * s && !this.state.jump, t, tCapture);

    if (legsOk) {
      for (const side of ['left', 'right']) {
        const other = side === 'left' ? 'right' : 'left';
        const A = J[side + 'Ankle'], B = J[other + 'Ankle'];
        const vA = vel(side + 'Ankle');
        this._impulse(side === 'left' ? 'kickLeft' : 'kickRight', A.y - B.y > 0.45 * ruler / s && vA.length() > 1.0 / s, t, tCapture, 600);
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
