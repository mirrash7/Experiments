// Synthetic tracker: an animated "player" for testing the avatar, HUD, triggers and combat VFX without a webcam.
// Emits poses at ~30 Hz like a real tracker. A 28 s loop of 4 s moves, every move starting from / returning to a
// fighting guard:
//   0 guard (breathing + weight shift over planted feet)   1 jab / cross (L, R alternating, full extension)
//   2 front kicks (chamber -> snap extension -> retract, L then R)   3 squats (knees forward, torso leans in)
//   4 jumps (dip, take-off, land)   5 T-pose + lean (upper body only)   6 wave
// Joints come from a tiny two-bone IK on a fixed skeleton (thigh 0.45, shin 0.43, upper arm 0.28, forearm 0.27 m)
// so knees and elbows always bend in a plausible plane, and the feet never slide unless the player steps.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const LEG = [0.45, 0.43], ARM = [0.28, 0.27];

/** Mid joint of a two-bone chain a -> c with lengths l1, l2, bending toward `pole` (end clamped to reach). */
function limb(a, c, [l1, l2], pole) {
  const d = c.clone().sub(a); let L = d.length();
  const max = (l1 + l2) * 0.999;
  if (L > max) { d.multiplyScalar(max / L); c.copy(a).add(d); L = max; }
  d.normalize();
  const n = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + L * L - l2 * l2) / (2 * l1 * L)));
  return a.clone().addScaledVector(d, l1 * cosA).addScaledVector(n, l1 * Math.sqrt(1 - cosA * cosA));
}

export const SYN_PHASES = ['guard', 'punch', 'kick', 'squat', 'jump', 'tpose', 'wave'];

// Options (all optional): rate Hz (30), latencyMs simulated capture->arrival delay (20), noise metres of
// gaussian keypoint noise (0), still: true = stand still, arms relaxed (jitter tests), phase: lock to one move
// (index into SYN_PHASES or its name).
export class SyntheticSource {
  constructor({ rate = 30, latencyMs = 20, noise = 0, still = false, phase = null } = {}) {
    this.onPose = () => {};
    this.onStatus = () => {};
    this.model = 'Synthetic demo player';
    this._timer = null;
    this._t0 = 0;
    Object.assign(this, { rate, latencyMs, noise, still, phase });
  }
  start() {
    this.stop();
    this._t0 = performance.now();
    this.onStatus('ready', 'Synthetic player (no camera needed)');
    this._timer = setInterval(() => this._emit(), 1000 / this.rate);
  }
  stop() { clearInterval(this._timer); this._timer = null; }

  /** Pose (player frame, metres, facing +z, player's left = +x) at time t (s). */
  pose(t) {
    const N = SYN_PHASES.length;
    let phase = this.phase;
    if (typeof phase === 'string') phase = SYN_PHASES.indexOf(phase);
    if (phase === null || phase === undefined || phase < 0) phase = Math.floor(t / 4) % N;
    const u = t % 4;                                    // seconds into the move
    const still = this.still;
    // ---- defaults: guard stance
    let hipY = 0.92, hipX = 0.025 * Math.sin(t * 1.3), hipZ = 0, yaw = 0.08, lean = 0, pitch = 0.06;
    const ank = { left: V(0.15, 0.08, 0.07), right: V(-0.15, 0.08, -0.07) };   // left foot leads
    const breath = Math.sin(t * 1.9) * 0.006;
    const guardW = (sg) => V(sg * 0.12, 1.4 + breath, 0.27);
    let wr = { left: guardW(1), right: guardW(-1) };
    let elbowPole = { left: V(0.4, -1, -0.25), right: V(-0.4, -1, -0.25) };
    let hand = { left: 'fist', right: 'fist' };
    let palmRef = { left: V(0, 1, 0.3), right: V(0, 1, 0.3) };   // index knuckle direction (vertical fist)
    let shZ = { left: 0, right: 0 }, shY = 0;
    let toeOut = { left: 0.25, right: 0.5 };                     // fighting stance: toes out, rear foot more

    if (still) {
      hipY = 0.95; hipX = 0; yaw = 0; pitch = 0;
      ank.left.set(0.1, 0.08, 0); ank.right.set(-0.1, 0.08, 0);
      wr = { left: V(0.27, 0.95, 0.08), right: V(-0.27, 0.95, 0.08) };
      elbowPole = { left: V(0.3, 0, -1), right: V(-0.3, 0, -1) };
      hand = { left: 'relaxed', right: 'relaxed' }; palmRef = { left: V(0, 0, 1), right: V(0, 0, 1) };
      toeOut = { left: 0.12, right: 0.12 };
    } else if (phase === 1) { // jab / cross: one punch every 0.5 s, alternating, fast out (0.11 s), hold, retract
      const k = Math.floor(u / 0.5), v = u % 0.5;
      const side = k % 2 === 0 ? 'left' : 'right', sg = side === 'left' ? 1 : -1;
      const p = v < 0.11 ? sm(0, 0.11, v) : v < 0.17 ? 1 : 1 - sm(0.17, 0.4, v);
      const target = V(sg * 0.05, 1.47, 0.62);
      wr[side] = guardW(sg).lerp(target, p);
      palmRef[side] = V(0, 1, 0.3).lerp(V(-sg, 0.35, 0), p);   // turn the fist over (palm down) on the way out
      shZ[side] = 0.07 * p; shZ[side === 'left' ? 'right' : 'left'] = -0.04 * p;
      yaw = 0.08 - sg * 0.22 * p; hipX += sg * 0.01 * p;
    } else if (phase === 2) { // front kicks: L at 0 s, R at 2 s
      const side = u < 2 ? 'left' : 'right', sg = side === 'left' ? 1 : -1, v = u % 2;
      const other = side === 'left' ? 'right' : 'left';
      const T = [0.25, 0.37, 0.47, 0.67, 0.95];
      const chamber = v < T[0] ? sm(0, T[0], v) : v < T[3] ? 1 : 1 - sm(T[3], T[4], v);
      const ext = v < T[0] ? 0 : v < T[1] ? sm(T[0], T[1], v) : v < T[2] ? 1 : 1 - sm(T[2], T[3], v);
      const base = ank[side].clone();
      const chamberAnk = V(base.x * 0.7, 0.5, 0.12), extAnk = V(base.x * 0.6, 0.9, 0.78);
      ank[side] = base.lerp(chamberAnk, chamber).lerp(extAnk, ext);
      ank[other].set(-sg * 0.11, 0.08, 0);
      hipY = 0.92 - 0.03 * chamber; lean = 0; pitch = 0.06 - 0.16 * chamber; hipX = -sg * 0.05 * chamber;
      yaw = 0.08 + sg * 0.1 * chamber;
    } else if (phase === 3) { // squats: two per move, hips back + down, torso leans in, arms out for balance
      const d = (1 - Math.cos(u * Math.PI)) / 2;
      ank.left.set(0.16, 0.08, 0); ank.right.set(-0.16, 0.08, 0); toeOut = { left: 0.35, right: 0.35 };
      hipY = 0.93 - d * 0.36; hipZ = -0.1 * d; pitch = 0.04 + 0.42 * d; yaw = 0;
      wr = { left: guardW(1).lerp(V(0.14, 1.32, 0.48), d), right: guardW(-1).lerp(V(-0.14, 1.32, 0.48), d) };
      palmRef = { left: V(0, 1, 0.3).lerp(V(-1, 0.4, 0), d), right: V(0, 1, 0.3).lerp(V(1, 0.4, 0), d) };
    } else if (phase === 4) { // jumps: 3 per move (1.33 s): dip 0.25 s, air 0.45 s, land squash
      const v = u % (4 / 3);
      const dip = v < 0.25 ? Math.sin((v / 0.25) * Math.PI) * 0.08 : v > 0.7 && v < 0.95 ? Math.sin(((v - 0.7) / 0.25) * Math.PI) * 0.07 : 0;
      const air = v >= 0.25 && v < 0.7 ? Math.sin(((v - 0.25) / 0.45) * Math.PI) * 0.24 : 0;
      // knees tuck at the apex (feet rise ~6 cm more than the hips): no straight-leg "plank" jump
      const tuck = (air / 0.24) * 0.06;
      ank.left.set(0.14, 0.08 + air + tuck, -0.3 * tuck); ank.right.set(-0.14, 0.08 + air + tuck, -0.3 * tuck);
      hipY = 0.94 - dip + air; yaw = 0; pitch = 0.05 + dip; toeOut = { left: 0.2, right: 0.2 };
      wr = { left: V(0.3, 1.92 + air, 0.02), right: V(-0.3, 1.92 + air, 0.02) };
      elbowPole = { left: V(1, 0, -0.2), right: V(-1, 0, -0.2) };
      // loose hands (not flat open palms), palms facing in
      hand = { left: 'relaxed', right: 'relaxed' }; palmRef = { left: V(0, 0, 1), right: V(0, 0, 1) };
    } else if (phase === 5) { // T-pose, leaning the upper body left / right (feet stay put)
      ank.left.set(0.12, 0.08, 0); ank.right.set(-0.12, 0.08, 0); toeOut = { left: 0.15, right: 0.15 };
      hipY = 0.95; yaw = 0; pitch = 0; lean = Math.sin(u / 4 * Math.PI * 2) * 0.28;
      wr = { left: V(0.73, 1.45, 0), right: V(-0.73, 1.45, 0) };
      elbowPole = { left: V(0, -0.3, -1), right: V(0, -0.3, -1) };
      hand = { left: 'open', right: 'open' }; palmRef = { left: V(0, 0, 1), right: V(0, 0, 1) };
    } else if (phase === 6) { // wave (right hand), left hand relaxed
      ank.left.set(0.11, 0.08, 0); ank.right.set(-0.11, 0.08, 0);
      hipY = 0.95; yaw = 0; pitch = 0;
      wr = { left: V(0.27, 0.95, 0.08), right: V(-0.45 + Math.sin(t * 9) * 0.12, 1.85, 0.05) };
      elbowPole = { left: V(0.3, 0, -1), right: V(-1, -0.6, 0) };
      // waving hand: open, palm toward the camera (index side toward the midline), so it reads as a wave and
      // not as a hand seen edge-on (which read as "pointing", QA v3 r2 P2-10)
      hand = { left: 'relaxed', right: 'open' }; palmRef = { left: V(0, 0, 1), right: V(1, 0.15, 0) };
      toeOut = { left: 0.15, right: 0.15 };
    }

    // ---- torso: hips centre, yaw (turn), pitch (lean forward), lean (sideways), upper body only
    const hc = V(hipX, hipY, hipZ);
    const rotUpper = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, -lean, 'YXZ'));
    const up = (x, y, z) => V(x, y, z).applyQuaternion(rotUpper).add(hc);
    const J = {};
    J.leftHip = V(0.1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw * 0.5)).add(hc);
    J.rightHip = V(-0.1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw * 0.5)).add(hc);
    J.leftShoulder = up(0.18, 0.5 + shY, shZ.left);
    J.rightShoulder = up(-0.18, 0.5 + shY, shZ.right);
    J.neck = J.leftShoulder.clone().add(J.rightShoulder).multiplyScalar(0.5).add(up(0, 0.05, 0).sub(hc));
    J.nose = J.neck.clone().add(up(0, 0.2, 0.09).sub(hc));
    J.leftEar = J.neck.clone().add(up(0.07, 0.18, -0.02).sub(hc));
    J.rightEar = J.neck.clone().add(up(-0.07, 0.18, -0.02).sub(hc));
    // arms: wrist targets given relative to the stance (world), shifted with the hips (not the lean)
    const shift = V(hipX, (phase === 4 ? 0 : hipY - 0.92), hipZ);
    for (const s of ['left', 'right']) {
      let w = wr[s].clone().add(phase === 5 || phase === 4 ? V(0, 0, 0) : shift);
      if (phase === 5) w = up(w.x, w.y - hipY, w.z);
      const S = J[s + 'Shoulder'];
      const el = limb(S, w, ARM, elbowPole[s].clone().applyQuaternion(rotUpper));
      J[s + 'Elbow'] = el; J[s + 'Wrist'] = w;
      // knees bend forward over the toes (pole forward + a little outward)
      const H = J[s + 'Hip'], A = ank[s].clone();
      const sgn = s === 'left' ? 1 : -1;
      J[s + 'Knee'] = limb(H, A, LEG, V(sgn * (0.2 + 0.6 * toeOut[s]), 0, 1));
      J[s + 'Ankle'] = A;
    }
    const handPt = (wr2, el) => wr2.clone().add(wr2.clone().sub(el).normalize().multiplyScalar(0.09));
    J.leftHand = handPt(J.leftWrist, J.leftElbow);
    J.rightHand = handPt(J.rightWrist, J.rightElbow);
    for (const s of ['left', 'right']) {
      const A = J[s + 'Ankle'], K = J[s + 'Knee'];
      // foot: points along the shin's forward when lifted (kick), flat forward when planted
      const shin = A.clone().sub(K).normalize();
      const lifted = Math.min(1, Math.max(0, (A.y - 0.1) / 0.3));
      const a = (s === 'left' ? 1 : -1) * toeOut[s];
      const fwd = V(Math.sin(a), 0, Math.cos(a)).lerp(shin.clone().add(V(0, 0, 0.5)).normalize(), lifted * 0.8).normalize();
      J[s + 'Heel'] = A.clone().add(V(0, -0.06, 0)).addScaledVector(fwd, -0.05);
      J[s + 'Toe'] = A.clone().add(V(0, -0.07, 0)).addScaledVector(fwd, 0.17);
    }
    // palm landmarks (index / pinky knuckles) so solvers recover the wrist twist; ref = index knuckle direction
    const extra = {};
    for (const side of ['left', 'right']) {
      const W = J[side + 'Wrist'], H = J[side + 'Hand'];
      const along = H.clone().sub(W).normalize();
      let ref = palmRef[side].clone().applyQuaternion(rotUpper);
      ref.addScaledVector(along, -ref.dot(along));
      if (ref.lengthSq() < 1e-4) ref = V(0, 1, 0).addScaledVector(along, -along.y);
      ref.normalize();
      extra[side + 'Index'] = H.clone().addScaledVector(ref, 0.035);
      extra[side + 'Pinky'] = H.clone().addScaledVector(ref, -0.035);
    }
    return { joints: J, extra, hand, phase };
  }

  _emit() {
    const now = performance.now();
    // the pose is that of the capture time; it "arrives" latencyMs later (now)
    const t = this.still ? 0.5 : (now - this.latencyMs - this._t0) / 1000;
    const { joints, extra, hand } = this.pose(t);
    // Synthetic "player" faces the camera: its left is at +x already (camera's right). Place in front of camera.
    for (const k of Object.keys(joints)) joints[k].z -= 2.5;
    for (const k of Object.keys(extra)) extra[k].z -= 2.5;
    if (this.noise > 0) {
      const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) * Math.SQRT2; };
      for (const v of [...Object.values(joints), ...Object.values(extra)]) v.add(V(g() * this.noise, g() * this.noise, g() * this.noise));
    }

    const conf = {};
    for (const k of Object.keys(joints)) conf[k] = 1;
    // Fake 2D projection for the overlay
    const kp2d = [], names = Object.keys(joints);
    for (const k of names) { const p = joints[k]; kp2d.push({ x: 0.5 - p.x / 2.4, y: 0.95 - p.y / 2.2, c: 1 }); }
    const idx = (n) => names.indexOf(n);
    const edges = [['leftShoulder', 'rightShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
      ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'], ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'],
      ['leftHip', 'rightHip'], ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
      ['neck', 'nose']].map(([a, b]) => [idx(a), idx(b)]);
    this.onPose({ source: 'synthetic', tCapture: now - this.latencyMs, tArrive: now, joints, conf, extra, kp2d, edges,
      handState: hand, timing: { inference: 0 }, absolute: true });
  }
}
