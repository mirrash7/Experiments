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

/**
 * Light one-euro on joint positions for the action stream: removes keypoint noise, adds only a few ms of lag.
 * Anisotropic option (`zMinCutoff`, `zBeta`): depth gets its own, slower one-euro. Monocular depth is 3-5x noisier
 * than x/y; the detector recovers fast depth changes from the image plane (bone foreshortening), so slow raw depth
 * costs no punch latency.
 */
export class LightPoseFilter {
  constructor({ minCutoff = 5, beta = 3, dCutoff = 1.5, zMinCutoff = null, zBeta = 0.4 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff, zMinCutoff, zBeta });
    this.s = {};
  }
  reset() { this.s = {}; }
  apply(joints, tMs) {
    const out = {};
    for (const [name, v] of Object.entries(joints)) {
      if (!v) continue;
      let st = this.s[name];
      if (!st || tMs <= st.t) { st = this.s[name] = { x: v.clone(), dx: new THREE.Vector3(), t: tMs, z: v.z, dz: 0 }; out[name] = v.clone(); continue; }
      const dt = Math.max(1e-3, (tMs - st.t) / 1000); st.t = tMs;
      const a = (c) => 1 / (1 + 1 / (2 * Math.PI * c * dt));
      st.dx.lerp(v.clone().sub(st.x).divideScalar(dt), a(this.dCutoff));
      st.x.lerp(v, a(this.minCutoff + this.beta * st.dx.length()));
      const o = st.x.clone();
      if (this.zMinCutoff != null) {
        st.dz += ((v.z - st.z) / dt - st.dz) * a(this.dCutoff);
        st.z += (v.z - st.z) * a(this.zMinCutoff + this.zBeta * Math.abs(st.dz));
        o.z = st.z;
      }
      out[name] = o;
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

/**
 * Tunables (exported for experiments / the motion lab). Lengths are in torso units (`ruler`, ~0.5 m) unless noted.
 * Punch cues (2 of 3 must agree, see update()): A = elbow extension speed of the depth-lifted arm, B = forward speed of
 * the lifted fist (2D foreshortening of the upper arm + forearm against their calibrated lengths), C = raw depth speed.
 */
export const DETECT = {
  punchWindowMs: 110,      // evidence window (baseline frame this far back)
  punchZ: 5,               // zExt + zFore + 0.5 zDepth (noise-normalised changes over the window)
  punchPrevZ: 2.5,         // previous frame's evidence needed to fire at once; else wait one frame for confirmation
  punchConfirmZ: 0.6,      // ... and the next frame must keep this fraction of punchZ (fires stamped with the first)
  punchBothFrac: 0.25, punchBothZ: 1.5,      // the other arm showing this much evidence too (and >= 25 % of this arm's)
  punchBothRatio: 0.45,    // ... and >= 45 % of this arm's physical extension + foreshortening change: both arms move
  punchRiseK: 0.2, punchMaxRise: 0.08,    // m, image-plane fist rise/drop allowed over the window (+ 0.2 x the depth gain)
  punchCueZ: 2.5,          // a cue "votes" above this
  punchVote: 1.75,         // soft votes needed: ext <= 1, fore <= 1, depth <= 0.6 (~2 of 3, depth weak)
  punchMinExt: 0.18, punchMinFore: 0.08,   // physical floor of the change over the window (ext, foreshortening)
  punchExt: 0.66,          // the arm must already be this extended (1 = straight)
  noise2D: 0.012,          // m, assumed x/y keypoint noise after the light filter (depth fusion weights)
  noiseDepth: 0.035,       // m, assumed depth noise of a bone's raw dz after the light filter
  xyMinCutoff: 2.5, xyBeta: 3,     // image-plane one-euro of the action stream
  zMinCutoff: 1.5, zBeta: 0.5,   // depth one-euro (slower: monocular depth is the noisy axis)
  legUp: 0.26,             // a foot this far above the other (or knee 0.2): kick in progress, no punches
  kickQuietMs: 280,        // ... and for this long after a kick fired / the foot came down
  leanSpeed: 1.6,          // rad/s torso tilt speed: dodge transition, no punches
  bodyVy: 0.45,            // m/s hips/head vertical speed: jump dip / duck transition, no punches
  duckHead: 0.3,           // head (nose) or shoulder drop below the calibrated standing height enters duck
  duckHeadExit: 0.2,
  duckSpeed: 0.35,         // m/s head drop speed needed in the last 0.8 s (a fast duck, not a slow slouch)
  handsUpOn: 0.55, handsUpOff: 0.35,   // handsUpConfidence hysteresis
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class ActionDetector {
  constructor() {
    this.listeners = new Set();
    this.state = {};
    this.lastFire = {};
    this.hist = [];
    this.calib = null;
    this._calibSamples = [];
    this.sensitivity = 1.0;
    this.filter = new LightPoseFilter({ minCutoff: DETECT.xyMinCutoff, beta: DETECT.xyBeta, zMinCutoff: DETECT.zMinCutoff, zBeta: DETECT.zBeta });
    this._kickArmed = { left: true, right: true };
    this.clock = null;          // optional () => ms (tests); default performance.now()
    /** Seated mode (desk / wheelchair play): duck = head or shoulder drop below the calibrated SEATED height only (no
     *  hip rule), and no jumps / kicks / leg gating (legs hidden or meaningless). Recalibrate after switching. */
    this.seated = false;
    /** 0..1: how sure the detector is that both hands are up (wrists above the head, or elbows high with the wrists
     *  clipped at the top of the frame / low confidence). `handsUp` uses hysteresis on it. */
    this.handsUpConfidence = 0;
    this.handConfidence = { left: 0, right: 0 };
    /** Debug counters: punch near-misses (one cue fired, no punch) and suppressed punch candidates by reason. */
    this.stats = { punchNearMiss: 0, suppressed: { kick: 0, jump: 0, lean: 0, body: 0, hands: 0 } };
    this._resetTracking();
  }
  _resetTracking() {
    this._len = { left: null, right: null };            // calibrated upper arm / forearm lengths (m)
    this._lastWristUp = { left: -1e9, right: -1e9 };    // last capture time a tracked wrist was above the head
    this._seenAt = { left: -1e9, right: -1e9 };
    this._handHold = { left: { c: 0, t: -1e9 }, right: { c: 0, t: -1e9 } };
    this._legQuietUntil = -1e9;
    this._noseBase = null; this._shBase = null;
    this._lastDrop = -1e9;                               // last capture time the head dropped fast
    this._stateOff = {};
    this._fh = [];                                       // punch feature history (~260 ms)
    this._pend = { left: null, right: null };            // punch waiting one frame for confirmation
    this._prevScore = { left: 0, right: 0 };
    this._lastEv = { left: { t: -1e9 }, right: { t: -1e9 } };
    const n0 = () => ({ ext: 2 * 0.04 ** 2, fore: 2 * 0.03 ** 2, rz: 2 * 0.04 ** 2 });
    this._noise = { left: n0(), right: n0() };           // running variance of frame-to-frame feature differences
  }
  /** Feed a source PoseFrame through the light filter (player-space joints). */
  pushFrame(frame) {
    if (!frame?.joints) return;
    this.update(this.filter.apply(frame.joints, frame.tCapture), frame.conf, frame.tCapture);
  }
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  recalibrate() {
    this.calib = null; this._calibSamples = []; this.hist = []; this.filter?.reset(); this._kickArmed = { left: true, right: true };
    this._resetTracking();
  }

  /** Torso forward (horizontal unit vector, player frame): shoulder line + hip line, crossed with up. */
  _forward(J) {
    const f = this._fwd ?? (this._fwd = new THREE.Vector3(0, 0, 1));
    const side = J.leftShoulder.clone().sub(J.rightShoulder);
    if (J.leftHip && J.rightHip) side.add(J.leftHip.clone().sub(J.rightHip));
    side.z *= 0.5;                                          // depth is the noisiest axis: trust the image-plane part
    const g = new THREE.Vector3(-side.z, 0, side.x);       // side x up
    if (g.lengthSq() > 1e-6) f.lerp(g.normalize(), 0.2).normalize();
    return f;
  }

  _fire(name, t, extra = {}) {
    this.lastFire[name] = t;
    for (const cb of this.listeners) cb(name, { t, ...extra });
  }
  _setState(name, active, t, tCapture, extra) {
    const was = !!this.state[name];
    this.state[name] = active;
    if (active && !was) this._fire(name, t, { tCapture, ...extra });
  }
  /** Held state with hysteresis: enters on `enter`, stays while `stay`, and only drops after `offFrames` misses. */
  _holdState(name, enter, stay, t, tCapture, offFrames = 2, extra) {
    const was = !!this.state[name];
    let on;
    if (was) {
      if (stay) { this._stateOff[name] = 0; on = true; } else on = ++this._stateOff[name] < offFrames;
    } else { on = enter; this._stateOff[name] = 0; }
    this._setState(name, on, t, tCapture, extra);
    return on;
  }
  _impulse(name, cond, t, tCapture, cooldown = 450, extra = {}) {
    const ok = cond && (t - (this.lastFire[name] ?? -1e9)) > cooldown;
    this.state[name] = cond;
    if (ok) this._fire(name, t, { tCapture, ...extra });
  }

  /**
   * Depth-lifted arm: the image-plane (x, y) of shoulder, elbow, wrist are trusted; each segment's depth is
   * recovered from its 2D foreshortening against the calibrated bone length (|dz| = sqrt(L^2 - d2D^2)), signed by
   * the (noisy) tracker depth, which only has to say "in front" or "behind" (biased to the front). Returns
   * {ext, reach, armLen} (ext: 1 = straight arm; reach: fist depth in front of the shoulder / arm length).
   */
  _liftArm(side, J, okArm) {
    const S = J[side + 'Shoulder'], E = J[side + 'Elbow'], W = J[side + 'Wrist'];
    if (!S || !E || !W) return { ext: 0, reach: 0, armLen: 0.55, wx: 0, wy: 0, glitch: true, fore: 1, missing: true };
    const u3 = S.distanceTo(E), f3 = E.distanceTo(W);
    let L = this._len[side];
    if (!L) L = this._len[side] = { u: u3, f: f3, n: 1 };
    else if (okArm && L.n < 1e6) {
      // running mean (first ~2 s), then a slow EMA; clamp outliers (dropouts, swaps)
      const a = L.n < 60 ? 1 / ++L.n : 0.01;
      L.u += (Math.min(u3, L.u * 1.4) - L.u) * a; L.f += (Math.min(f3, L.f * 1.4) - L.f) * a;
    }
    // per segment: lifted depth (exact when the bone points at the camera, ill-conditioned when it lies in the
    // image plane: d|dz| = l2D / |dz| * d l2D) fused with the raw tracker depth by inverse variance
    const s2 = DETECT.noise2D, sz2 = DETECT.noiseDepth * DETECT.noiseDepth;
    const seg = (A, B, len) => {
      const dx = B.x - A.x, dy = B.y - A.y, raw = B.z - A.z;
      const l2 = Math.sqrt(dx * dx + dy * dy);
      const mag = Math.sqrt(Math.max(0, len * len - l2 * l2));
      const lift = raw >= -0.5 * mag - 0.02 ? mag : -mag;
      const sl = Math.min(0.5, Math.max(0.004, (l2 / Math.max(mag, 0.03)) * s2));
      const w = sz2 / (sz2 + sl * sl);
      return { dx, dy, dz: w * lift + (1 - w) * raw, l2 };
    };
    // raw 3D lengths read long under depth noise (sqrt(l^2 + n^2)); a slightly short length is harmless (a bone in
    // the image plane lifts to 0 depth) while a long one invents depth for every in-plane bone: use 97 %
    const a = seg(S, E, L.u * 0.97), b = seg(E, W, L.f * 0.97);
    const wx = a.dx + b.dx, wy = a.dy + b.dy, wz = a.dz + b.dz;
    const armLen = L.u + L.f + 1e-6;
    // bone-length consistency (image plane only: the raw 3D length of a bone pointing at the camera is as noisy as
    // the depth): a segment much longer in 2D than its length is a tracking jump / swap: no punch from this frame
    const glitch = a.l2 > 1.3 * L.u || b.l2 > 1.3 * L.f;
    return { ext: Math.sqrt(wx * wx + wy * wy + wz * wz) / armLen, reach: wz / armLen, armLen, wx, wy, glitch,
      fore: (a.l2 + b.l2) / armLen };   // 2D-only: image length of the arm / its length (falls as the fist comes at the camera)
  }

  update(J, conf, tCapture) {
    const t = this.clock ? this.clock() : performance.now();
    const s = this.sensitivity;
    const D = DETECT;
    const hip = midpoint(J.leftHip, J.rightHip);
    const sh = midpoint(J.leftShoulder, J.rightShoulder);
    const torso = Math.max(0.25, sh.distanceTo(hip));          // body-size ruler (≈0.5 m)
    const ankles = J.leftAnkle && J.rightAnkle ? midpoint(J.leftAnkle, J.rightAnkle) : hip.clone();

    if (!this.calib) {
      this._calibSamples.push({ hip: hip.clone(), ankles: ankles.clone(), torso, nose: J.nose?.y ?? sh.y + 0.25, sh: sh.y });
      if (this._calibSamples.length >= 15) {
        const c = { hip: new THREE.Vector3(), ankles: new THREE.Vector3(), torso: 0, nose: 0, sh: 0 };
        for (const x of this._calibSamples) { c.hip.add(x.hip); c.ankles.add(x.ankles); c.torso += x.torso; c.nose += x.nose; c.sh += x.sh; }
        const n = this._calibSamples.length;
        c.hip.divideScalar(n); c.ankles.divideScalar(n); c.torso /= n; c.nose /= n; c.sh /= n;
        this.calib = c;
        this._noseBase = c.nose; this._shBase = c.sh;
      }
      return;
    }

    const ok = (...n) => n.every((k) => (conf[k] ?? 0) > 0.4);
    const ruler = this.calib.torso;
    const fwd = this._forward(J);
    // per-frame derived values, kept in the history for velocities over ~60 ms
    const arms = {};
    for (const side of ['left', 'right']) {
      const okArm = ok(side + 'Wrist', side + 'Elbow', side + 'Shoulder');
      const lift = this._liftArm(side, J, okArm);
      arms[side] = { ...lift, ok: okArm && !lift.missing, rz: lift.missing ? 0 : J[side + 'Wrist'].z - J[side + 'Shoulder'].z };
    }
    const up = sh.clone().sub(hip);
    const tilt = Math.atan2(up.x, up.y);
    const noseY = J.nose ? J.nose.y : sh.y + 0.25;
    this.hist.push({ t: tCapture, J, arms, tilt, noseY, shY: sh.y });
    while (this.hist.length > 2 && tCapture - this.hist[1].t >= 60) this.hist.shift();
    const old = this.hist[0];
    const dt = Math.max(0.016, (tCapture - old.t) / 1000);
    const vel = (name) => (J[name] && old.J[name] ? J[name].clone().sub(old.J[name]).divideScalar(dt) : new THREE.Vector3());

    // ---------------------------------------------------------------------------------------------- hands up
    // Per side confidence: tracked wrist above the head, or (QA design r1 P0-3) the elbow raised above the shoulder
    // while the wrist is clipped at the top of the frame / low confidence / near the head.
    const headY = noseY;
    const handConf = (side) => {
      const S = J[side + 'Shoulder'], E = J[side + 'Elbow'], W = J[side + 'Wrist'];
      if (!S) return 0;
      const cw = W ? conf[side + 'Wrist'] ?? 0 : 0, ce = E ? conf[side + 'Elbow'] ?? 0 : 0;
      let c = 0;
      if (cw > 0.4) {
        c = clamp01((W.y - headY + 0.02) / 0.08);
        if (c > 0.5) this._lastWristUp[side] = tCapture;
        // elbows clearly up and the wrist at least at head height: also hands up (wrist depth/height jitter)
        if (ce > 0.4 && E.y > S.y + 0.12 * ruler && W.y > headY - 0.06) c = Math.max(c, 0.75);
      } else if (ce > 0.4 && ok(side + 'Shoulder')) {
        const elev = clamp01((E.y - S.y - 0.05 * ruler) / (0.2 * ruler));
        const wristHint = !W || W.y > E.y ? 1 : 0.7;                     // missing, or extrapolated above the elbow
        const recent = tCapture - this._lastWristUp[side] < 1500 ? 1 : 0.85;
        c = elev * 0.9 * wristHint * recent;
      } else {
        // whole arm occluded / dropped out: hold the last confidence briefly (fading), do not flicker the state
        const h = this._handHold[side];
        return tCapture - h.t < 400 ? h.c * 0.97 : 0;
      }
      this._handHold[side] = { c, t: tCapture };
      return c;
    };
    const cl = handConf('left'), cr = handConf('right');
    this.handConfidence.left = cl; this.handConfidence.right = cr;
    this.handsUpConfidence = Math.min(cl, cr);
    const handsUp = this._holdState('handsUp', this.handsUpConfidence >= D.handsUpOn, this.handsUpConfidence >= D.handsUpOff, t, tCapture, 3,
      { confidence: this.handsUpConfidence });
    const lUp = this._holdState('leftHandRaised', cl >= D.handsUpOn, cl >= D.handsUpOff, t, tCapture, 3);
    const rUp = this._holdState('rightHandRaised', cr >= D.handsUpOn, cr >= D.handsUpOff, t, tCapture, 3);
    this._setState('leftHandUp', lUp && !rUp && !handsUp, t, tCapture);
    this._setState('rightHandUp', rUp && !lUp && !handsUp, t, tCapture);

    const armOut = (side) => {
      const S = J[side + 'Shoulder'], W = J[side + 'Wrist'];
      return ok(side + 'Wrist', side + 'Shoulder') && Math.abs(W.y - S.y) < 0.35 * ruler && Math.abs(W.x - S.x) > 0.9 * ruler;
    };
    const tp = armOut('left') && armOut('right');
    this._holdState('tPose', tp, tp, t, tCapture, 3);       // 3-frame hold: a dropped wrist does not re-fire it

    // Guard: both fists up near the face, in front of the body (held). In front = the lifted fist depth (the raw
    // tracker depth alone flickered the state under 5-8 cm depth noise); hysteresis on the way out.
    const nearFace = (side, m) => {
      const W = J[side + 'Wrist'], S = J[side + 'Shoulder'];
      const a = arms[side];
      return ok(side + 'Wrist', side + 'Shoulder') && J.nose && Math.hypot(W.x - J.nose.x, W.y - J.nose.y) < (0.75 + m) * ruler &&
        W.y > S.y - (0.1 + m) * ruler && a.reach * a.armLen > (0.1 - m) * ruler;
    };
    // an arm that drops out (occlusion, low confidence) keeps a held guard for up to 0.4 s
    const seen = (side) => ok(side + 'Wrist', side + 'Shoulder') ? (this._seenAt[side] = tCapture, true) : false;
    const keep = (side) => (seen(side) ? nearFace(side, 0.1) : tCapture - this._seenAt[side] < 400);
    this._holdState('guard', nearFace('left', 0) && nearFace('right', 0) && !lUp && !rUp,
      keep('left') && keep('right') && !handsUp, t, tCapture, 3);

    // --------------------------------------------------------------------------------- body motion (gates)
    const hipV = vel('leftHip').add(vel('rightHip')).multiplyScalar(0.5);
    const noseVy = (noseY - old.noseY) / dt;
    const tiltSpeed = Math.abs(tilt - old.tilt) / dt;
    const legsOk = !this.seated && ok('leftAnkle', 'rightAnkle', 'leftKnee', 'rightKnee');
    let legUp = false;
    if (legsOk) {
      const lift = Math.abs(J.leftAnkle.y - J.rightAnkle.y), knee = Math.abs(J.leftKnee.y - J.rightKnee.y);
      legUp = lift > D.legUp * ruler || knee > 0.2 * ruler;
      if (legUp) this._legQuietUntil = tCapture + D.kickQuietMs;
    }
    const kicking = legUp || tCapture < this._legQuietUntil || t - Math.max(this.lastFire.kickLeft ?? -1e9, this.lastFire.kickRight ?? -1e9) < D.kickQuietMs;
    const jumping = t - (this.lastFire.jump ?? -1e9) < 400 || hipV.y > 0.6;
    const bodyMoving = Math.abs(hipV.y) > D.bodyVy || noseVy < -D.bodyVy;
    const leaning = tiltSpeed > D.leanSpeed;

    // ------------------------------------------------------------------------------------------------ punches
    // QA design r1 P1-1: the punch no longer lives on the depth axis alone. Evidence over the last ~110 ms, each cue
    // normalised by its own running noise level (so the detector adapts to the tracker: a clean InstantHMR stream
    // fires on small, early changes, a noisy MediaPipe stream needs more):
    //   zExt   elbow extension of the depth-lifted arm (shoulder-elbow-wrist opening; torso pitch does not change it)
    //   zFore  image-plane foreshortening of the whole arm (pure 2D: the fist coming at the camera shortens it)
    //   zDepth raw tracker depth of the fist relative to the shoulder (weak vote, clamped)
    // fire when zExt + zFore + 0.5 zDepth >= punchZ with each of zExt and zFore (or zDepth) contributing. Gates kept
    // from QA v3 r2 (forward cone, fist in front of the shoulder, hip..head height, no held arm-up / T-pose / jump,
    // both arms never inside 150 ms) plus new ones: no punches while a leg is raised or just after a kick (balance
    // arm swing), during a jump dip / duck (fast vertical body motion), a dodge transition (fast torso tilt), or
    // while both arms extend together (guard raise, two-hand push, arm swings).
    const fh = this._fh;
    const prev = fh.length ? fh[fh.length - 1] : null;
    const ev = {};
    for (const side of ['left', 'right']) {
      const a = arms[side], n = this._noise[side];
      const p = prev?.arms[side];
      // baseline: the newest good frame at least the window old (or 0.6 window, after an occlusion)
      let base = null;
      for (let i = fh.length - 1; i >= 0; i--) {
        const age = tCapture - fh[i].t, x = fh[i].arms[side];
        if (age >= 0.6 * D.punchWindowMs && x.ok && !x.glitch) { base = fh[i]; if (age >= D.punchWindowMs) break; }
      }
      const b = base?.arms[side];
      if (!a.ok || !b || a.glitch) { ev[side] = null; continue; }
      // running noise per feature: winsorised EMA of the squared change over the window itself (not frame to frame:
      // the smoothed depth and wobbling monocular noise are correlated across frames)
      for (const k of ['ext', 'fore', 'rz']) {
        const d = a[k] - b[k];
        n[k] += (Math.min(d * d, 6.25 * n[k]) - n[k]) * 0.015;
        if (p?.ok && !p.glitch && tCapture - prev.t < 70) { const d1 = a[k] - p[k]; n['f' + k] = (n['f' + k] ?? n[k]) + (Math.min(d1 * d1, 6.25 * (n['f' + k] ?? n[k])) - (n['f' + k] ?? n[k])) * 0.015; }
      }
      const sd = (k, floor) => Math.max(floor, Math.sqrt(n[k]));
      const now = (k) => a[k];
      const dExt = now('ext') - b.ext, dFore = b.fore - now('fore'), dZ = now('rz') - b.rz;
      // image-plane fist displacement vs depth gain over the window: a punch travels mostly toward the camera; an
      // arm dropping to the side, spreading (T-pose) or raising moves the fist a lot in the image
      const d2 = Math.hypot(a.wx - b.wx, a.wy - b.wy), dReach = (a.reach - b.reach) * a.armLen;
      ev[side] = { dExt, dFore, dZ, d2, dReach, dy2: a.wy - b.wy, zExt: dExt / sd('ext', 0.02), zFore: dFore / sd('fore', 0.015),
        zDepth: Math.max(-2, Math.min(3, dZ / sd('rz', 0.02))), dt: (tCapture - base.t) / 1000 };
    }
    this._dbg = ev;
    fh.push({ t: tCapture, arms });
    while (fh.length > 2 && tCapture - fh[1].t >= 260) fh.shift();

    const cand = [];
    for (const side of ['left', 'right']) {
      const name = side === 'left' ? 'punchLeft' : 'punchRight';
      const e = ev[side], a = arms[side];
      if (!e) { this.state[name] = false; this._pend[side] = null; this._prevScore[side] = 0; continue; }
      const W = J[side + 'Wrist'];
      const score = e.zExt + e.zFore + 0.5 * e.zDepth;
      const v = (z) => clamp01(z / D.punchCueZ);                        // soft vote: full at punchCueZ
      const votes = v(e.zExt) + v(e.zFore) + 0.6 * v(e.zDepth);
      const big = e.dExt > D.punchMinExt && e.dFore > D.punchMinFore;                         // physical floor (noise-free streams)
      const pa = prev?.arms[side];
      const rising = !pa?.ok || a.ext - pa.ext > -0.04;
      const reached = a.ext > D.punchExt;
      // in front, travelling forward (not mainly up / down / sideways in the image)
      const aimed = a.reach > 0.4 && e.dReach > 0.8 * e.d2 && Math.abs(e.dy2) < D.punchMaxRise + D.punchRiseK * e.dReach;
      const height = W.y > hip.y + 0.2 * ruler && W.y < headY + 0.12 * ruler;
      // the other arm's evidence (its last value for up to 100 ms when it has none this frame, e.g. occluded)
      // (z-scores say "it moved", the physical ratio says "as much as this arm": the guard arm drifting while the torso
      // turns into a cross is ~20 %, a both-fists raise is ~100 %)
      const os = side === 'left' ? 'right' : 'left';
      const eo = ev[os] ?? (tCapture - this._lastEv[os].t < 100 ? this._lastEv[os] : null);
      const so = eo ? eo.zExt + eo.zFore + 0.5 * eo.zDepth : 0;
      const both = !!eo && so > D.punchBothZ && so > D.punchBothFrac * score && eo.zExt > 1 && eo.zFore > 0.5 &&
        eo.dExt > D.punchBothRatio * e.dExt && eo.dFore > D.punchBothRatio * e.dFore;
      const held = handsUp || this.state.tPose || (side === 'left' ? lUp : rUp) || both;
      const shape = reached && aimed && height && rising && big;
      const fresh = t - (this.lastFire[name] ?? -1e9) > 350;
      if (this.debug) e.cond = { score, votes, big, rising, reached, aimed, height, held, gate: kicking ? 'kick' : jumping ? 'jump' : leaning ? 'lean' : bodyMoving ? 'body' : '' };
      let cond = score >= D.punchZ / s && votes >= D.punchVote && shape && !held;
      if (cond && (kicking || jumping || bodyMoving || leaning)) {
        cond = false;
        if (fresh) this.stats.suppressed[kicking ? 'kick' : jumping ? 'jump' : leaning ? 'lean' : 'body']++;
      } else if (!cond && fresh && shape && !held && score >= 0.6 * D.punchZ) this.stats.punchNearMiss++;
      this.state[name] = cond;
      const pend = this._pend[side];
      this._pend[side] = null;
      const info = { name, side, speed: (e.dExt * a.armLen) / Math.max(0.05, e.dt), ext: a.ext, score, tCapture };
      if (pend && fresh && !held && !(kicking || jumping || bodyMoving || leaning) && score >= D.punchConfirmZ * D.punchZ / s &&
        a.ext > D.punchExt - 0.04 && a.reach > 0.35) {
        cand.push(pend);                     // confirmed: fires stamped with the first frame's capture time
      } else if (cond && fresh) {
        // a single-frame spike of evidence is how keypoint noise looks; a punch builds up over 2+ frames. Without a
        // build-up (previous frame's evidence < punchPrevZ) wait one frame for confirmation.
        if (this._prevScore[side] >= D.punchPrevZ / s) cand.push(info); else this._pend[side] = info;
      }
      this._prevScore[side] = score;
      this._lastEv[side] = { ...e, t: tCapture };
    }
    if (cand.length === 2) cand.splice(cand[0].speed >= cand[1].speed ? 1 : 0, 1);   // both at once: keep the faster
    for (const c of cand) {
      const otherName = c.side === 'left' ? 'punchRight' : 'punchLeft';
      if (t - (this.lastFire[otherName] ?? -1e9) < PUNCH_PAIR_MS) continue;     // the other arm just fired
      this._fire(c.name, t, { tCapture: c.tCapture, side: c.side, speed: c.speed, ext: c.ext, score: c.score, confirmed: c.tCapture !== tCapture });
    }

    // ------------------------------------------------------------------------------------------- lower body
    const dy = hip.y - this.calib.hip.y;
    const vy = hipV.y;
    if (!this.seated) this._impulse('jump', dy > 0.13 * ruler / s && vy > 0.5 / s && (!legsOk || ankles.y - this.calib.ankles.y > 0.06 * ruler), t, tCapture, 600);

    // Duck (= squat; QA design r1 P1-2): hips dropped, or the head / shoulders dropped fast below the calibrated
    // standing height (waist bend, bob: works without tracked knees). The standing baseline follows slow posture
    // drift while the player is upright and still.
    if (noseVy < -D.duckSpeed) this._lastDrop = tCapture;
    const headDrop = (this._noseBase - noseY) / ruler, shDrop = (this._shBase - sh.y) / ruler;
    const drop = Math.max(headDrop, shDrop);
    const hipDuck = !this.seated && dy < -0.32 * ruler * s;
    const fast = tCapture - this._lastDrop < 800;
    const ducking = this._holdState('squat',
      !this.state.jump && (hipDuck || (drop > D.duckHead * s && fast)),
      !this.state.jump && ((!this.seated && dy < -0.25 * ruler * s) || drop > D.duckHeadExit * s), t, tCapture, 3,
      { via: hipDuck ? 'hips' : 'head', seated: this.seated });
    this.state.duck = ducking;
    if (!ducking && Math.abs(noseVy) < 0.15 && Math.abs(hipV.y) < 0.15 && drop < 0.12 && drop > -0.12 && !jumping) {
      this._noseBase += (noseY - this._noseBase) * 0.01; this._shBase += (sh.y - this._shBase) * 0.01;
    }

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
    this._setState('leanLeft', tilt > 0.26, t, tCapture);
    this._setState('leanRight', tilt < -0.26, t, tCapture);

    // Side steps
    const dx = hip.x - this.calib.hip.x;
    this._setState('stepLeft', dx > 0.45 * ruler * 1.6, t, tCapture);
    this._setState('stepRight', dx < -0.45 * ruler * 1.6, t, tCapture);
  }
}
