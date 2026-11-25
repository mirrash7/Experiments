// In-browser fallback tracker: MediaPipe Pose Landmarker (33 landmarks, 3D world coordinates).
// Runs fully on the GPU in the browser — no server needed.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import * as THREE from 'three';
import { camToThree } from '../pose.js';

const I = {
  nose: 0, leftEar: 7, rightEar: 8, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28, leftHeel: 29, rightHeel: 30, leftToe: 31, rightToe: 32,
};

const EXTRA = { leftPinky: 17, rightPinky: 18, leftIndex: 19, rightIndex: 20, leftThumb: 21, rightThumb: 22 };

export const MP_EDGES = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 19], [15, 17], [17, 19], [16, 20], [16, 18], [18, 20],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
  [0, 7], [0, 8],
];

export class MediaPipeSource {
  constructor(camera) {
    this.camera = camera;
    this.onPose = () => {};
    this.onStatus = () => {};
    this.landmarker = null;
    this.model = 'MediaPipe Pose (full, GPU)';
    this._unsub = null;
    this._busy = false;
    this._lastTs = 0;
  }

  async start() {
    this.stop();
    this.onStatus('connecting', 'Loading MediaPipe pose model…');
    if (!this.landmarker) {
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: '/models/pose_landmarker_full.task', delegate },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); this.model = 'MediaPipe Pose (full, CPU)'; }
    }
    this.onStatus('ready', `${this.model} ready`);
    this._unsub = this.camera.onFrame((video, t) => this._run(video, t));
  }

  stop() {
    if (this._unsub) this._unsub();
    this._unsub = null;
  }

  _run(video, tCapture) {
    if (this._busy || !this.landmarker || !video.videoWidth) return;
    this._busy = true;
    const t0 = performance.now();
    let ts = Math.max(this._lastTs + 1, Math.round(t0));
    this._lastTs = ts;
    let res;
    try { res = this.landmarker.detectForVideo(video, ts); } catch (e) { this._busy = false; return; }
    const infer = performance.now() - t0;
    this._busy = false;
    const timing = { inference: infer };
    const lm = res.landmarks?.[0], wl = res.worldLandmarks?.[0];
    if (!lm || !wl) {
      this.onPose({ source: 'mediapipe', tCapture, joints: null, conf: {}, kp2d: [], edges: MP_EDGES, timing });
      return;
    }
    const joints = {}, conf = {};
    for (const [name, idx] of Object.entries(I)) {
      joints[name] = camToThree(wl[idx].x, wl[idx].y, wl[idx].z);
      conf[name] = visible(lm[idx]);
    }
    joints.leftHand = avg(wl, [17, 19]); conf.leftHand = Math.min(visible(lm[17]), visible(lm[19]));
    joints.rightHand = avg(wl, [18, 20]); conf.rightHand = Math.min(visible(lm[18]), visible(lm[20]));
    joints.neck = joints.leftShoulder.clone().add(joints.rightShoulder).multiplyScalar(0.5);
    conf.neck = Math.min(conf.leftShoulder, conf.rightShoulder);

    // World landmarks are hip-centred. Recover root translation (x, y) from the 2D image using the torso
    // length as a ruler; depth from apparent torso size.
    const aspect = video.videoWidth / video.videoHeight;
    const hipN = { x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 };
    const shN = { x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2 };
    const torsoN = Math.hypot((shN.x - hipN.x) * aspect, shN.y - hipN.y);
    const torsoW = joints.neck.distanceTo(joints.leftHip.clone().add(joints.rightHip).multiplyScalar(0.5));
    const mPerN = torsoN > 1e-3 ? torsoW / torsoN : 1;
    const root = new THREE.Vector3((hipN.x - 0.5) * aspect * mPerN, -(hipN.y - 0.5) * mPerN, -mPerN * 1.2);
    for (const k of Object.keys(joints)) joints[k].add(root);

    // extra landmarks for the motion pipeline's keypoint solver: palm index/pinky/thumb give wrist twist
    const extra = {};
    for (const [name, idx] of Object.entries(EXTRA)) { extra[name] = camToThree(wl[idx].x, wl[idx].y, wl[idx].z).add(root); conf[name] = visible(lm[idx]); }
    const kp2d = lm.map((p) => ({ x: p.x, y: p.y, c: visible(p) }));
    this.onPose({ source: 'mediapipe', tCapture, tArrive: performance.now(), joints, conf, extra, kp2d, edges: MP_EDGES, timing, absolute: false });
  }
}

function visible(p) {
  const v = p.visibility ?? 1;
  const inside = p.x > -0.02 && p.x < 1.02 && p.y > -0.02 && p.y < 1.0;
  return inside ? v : Math.min(v, 0.1);
}

function avg(wl, idxs) {
  const v = new THREE.Vector3();
  for (const i of idxs) v.add(camToThree(wl[i].x, wl[i].y, wl[i].z));
  return v.divideScalar(idxs.length);
}
