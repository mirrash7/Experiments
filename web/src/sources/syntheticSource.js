// Synthetic tracker: an animated "player" for testing the avatar, HUD and triggers without a webcam.
// Cycles through waves, punches, squats, jumps and a T-pose. Emits poses at ~30 Hz like a real tracker.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

export class SyntheticSource {
  constructor() {
    this.onPose = () => {};
    this.onStatus = () => {};
    this.model = 'Synthetic demo player';
    this._timer = null;
    this._t0 = 0;
  }
  start() {
    this.stop();
    this._t0 = performance.now();
    this.onStatus('ready', 'Synthetic player (no camera needed)');
    this._timer = setInterval(() => this._emit(), 33);
  }
  stop() { clearInterval(this._timer); this._timer = null; }

  _emit() {
    const now = performance.now();
    const t = (now - this._t0) / 1000;
    const phase = Math.floor(t / 4) % 6; // 4 s per move
    const u = (t % 4) / 4;
    const s = Math.sin(u * Math.PI * 2);
    let hipY = 0.95, hipX = Math.sin(t * 0.4) * 0.15;
    let lArm = { sh: V(0.18, 1.45, 0), el: V(0.22, 1.18, 0.02), wr: V(0.24, 0.92, 0.05) };
    let rArm = { sh: V(-0.18, 1.45, 0), el: V(-0.22, 1.18, 0.02), wr: V(-0.24, 0.92, 0.05) };
    let lKnee = V(0.1, 0.5, 0.02), rKnee = V(-0.1, 0.5, 0.02), lAnk = V(0.1, 0.08, 0), rAnk = V(-0.1, 0.08, 0);
    let lean = 0;

    if (phase === 0) { // wave right hand
      rArm.el = V(-0.42, 1.55, 0.02);
      rArm.wr = V(-0.45 + Math.sin(t * 9) * 0.12, 1.85, 0.05);
    } else if (phase === 1) { // punches alternate
      const pl = Math.max(0, Math.sin(u * Math.PI * 8));
      const pr = Math.max(0, -Math.sin(u * Math.PI * 8));
      lArm.el = V(0.2, 1.3, 0.15 + pl * 0.15); lArm.wr = V(0.12, 1.38, 0.2 + pl * 0.45);
      rArm.el = V(-0.2, 1.3, 0.15 + pr * 0.15); rArm.wr = V(-0.12, 1.38, 0.2 + pr * 0.45);
    } else if (phase === 2) { // squats
      const d = (1 - Math.cos(u * Math.PI * 4)) / 2;
      hipY = 0.95 - d * 0.35;
      lKnee = V(0.14, 0.5 - d * 0.05, 0.02 + d * 0.32); rKnee = V(-0.14, 0.5 - d * 0.05, 0.02 + d * 0.32);
      lArm.el = V(0.2, 1.3 - d * 0.3, 0.25 * d); lArm.wr = V(0.15, 1.3 - d * 0.32, 0.45 * d);
      rArm.el = V(-0.2, 1.3 - d * 0.3, 0.25 * d); rArm.wr = V(-0.15, 1.3 - d * 0.32, 0.45 * d);
    } else if (phase === 3) { // jumps
      const j = Math.max(0, Math.sin(u * Math.PI * 6));
      const up = j * 0.22;
      hipY += up; lKnee.y += up; rKnee.y += up; lAnk.y += up; rAnk.y += up;
      lArm.el = V(0.35, 1.6 + up, 0); lArm.wr = V(0.3, 1.95 + up, 0);
      rArm.el = V(-0.35, 1.6 + up, 0); rArm.wr = V(-0.3, 1.95 + up, 0);
      lArm.sh.y += up; rArm.sh.y += up;
    } else if (phase === 4) { // T-pose
      lArm.el = V(0.45, 1.45, 0); lArm.wr = V(0.72, 1.45, 0);
      rArm.el = V(-0.45, 1.45, 0); rArm.wr = V(-0.72, 1.45, 0);
      lean = s * 0.25;
    } else { // knee raises / kick
      const k = Math.max(0, Math.sin(u * Math.PI * 4));
      lKnee = V(0.1, 0.5 + k * 0.4, 0.02 + k * 0.35); lAnk = V(0.1, 0.08 + k * 0.45, k * 0.25);
      lArm.el = V(0.3, 1.25, 0.1); lArm.wr = V(0.25, 1.45, 0.25);
      rArm.el = V(-0.3, 1.25, 0.1); rArm.wr = V(-0.25, 1.45, 0.25);
    }

    const off = V(hipX, hipY - 0.95, 0);
    const lean3 = (v) => { const r = v.clone(); const y = r.y - hipY; r.x += Math.sin(lean) * y; return r; };
    const shift = (v) => lean3(v.clone().add(V(hipX, 0, 0)));
    const sh = (v) => shift(v.clone().add(V(0, hipY - 0.95, 0)));
    const joints = {
      leftHip: V(0.1 + hipX, hipY, 0), rightHip: V(-0.1 + hipX, hipY, 0),
      leftShoulder: sh(lArm.sh), rightShoulder: sh(rArm.sh),
      leftElbow: shift(lArm.el.clone().add(V(0, phase === 3 || phase === 2 ? 0 : hipY - 0.95, 0))),
      rightElbow: shift(rArm.el.clone().add(V(0, phase === 3 || phase === 2 ? 0 : hipY - 0.95, 0))),
      leftWrist: shift(lArm.wr), rightWrist: shift(rArm.wr),
      leftKnee: lKnee.clone().add(V(hipX, 0, 0)), rightKnee: rKnee.clone().add(V(hipX, 0, 0)),
      leftAnkle: lAnk.clone().add(V(hipX, 0, 0)), rightAnkle: rAnk.clone().add(V(hipX, 0, 0)),
    };
    joints.neck = joints.leftShoulder.clone().add(joints.rightShoulder).multiplyScalar(0.5).add(V(0, 0.05, 0));
    joints.nose = joints.neck.clone().add(V(Math.sin(lean) * 0.2, 0.2, 0.09));
    joints.leftEar = joints.neck.clone().add(V(0.07 + Math.sin(lean) * 0.2, 0.18, -0.02));
    joints.rightEar = joints.neck.clone().add(V(-0.07 + Math.sin(lean) * 0.2, 0.18, -0.02));
    const hand = (wr, el) => wr.clone().add(wr.clone().sub(el).normalize().multiplyScalar(0.09));
    joints.leftHand = hand(joints.leftWrist, joints.leftElbow);
    joints.rightHand = hand(joints.rightWrist, joints.rightElbow);
    joints.leftHeel = joints.leftAnkle.clone().add(V(0, -0.06, -0.05));
    joints.rightHeel = joints.rightAnkle.clone().add(V(0, -0.06, -0.05));
    joints.leftToe = joints.leftAnkle.clone().add(V(0, -0.07, 0.17));
    joints.rightToe = joints.rightAnkle.clone().add(V(0, -0.07, 0.17));
    void off;
    // Synthetic "player" faces the camera: its left is at +x already (camera's right). Place in front of camera.
    for (const k of Object.keys(joints)) joints[k].z -= 2.5;

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
    this.onPose({ source: 'synthetic', tCapture: now - 20, joints, conf, kp2d, edges, timing: { inference: 0 }, absolute: true });
  }
}
