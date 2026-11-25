// InstantHMR source: streams JPEG frames to the local Python server (server/hmr_server.py) over a WebSocket
// and turns its 70 MHR keypoints into the canonical pose.
import { camToThree } from '../pose.js';

// MHR70 indices (vendor/InstantHMR/instanthmr/skeleton.py)
const I = {
  nose: 0, leftEar: 3, rightEar: 4, leftShoulder: 5, rightShoulder: 6, leftElbow: 7, rightElbow: 8,
  leftHip: 9, rightHip: 10, leftKnee: 11, rightKnee: 12, leftAnkle: 13, rightAnkle: 14,
  leftToe: 15, leftHeel: 17, rightToe: 18, rightHeel: 20, rightWrist: 41, leftWrist: 62, neck: 69,
};
const RIGHT_FINGERS = range(25, 41); // index..pinky joints of the right hand
const LEFT_FINGERS = range(46, 62);
function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

export const HMR_EDGES = [
  [0, 69], [69, 5], [69, 6], [5, 9], [6, 10], [9, 10], [5, 7], [7, 62], [6, 8], [8, 41],
  [9, 11], [11, 13], [13, 17], [13, 15], [10, 12], [12, 14], [14, 20], [14, 18],
  [62, 42], [62, 46], [62, 50], [62, 54], [62, 58], [41, 21], [41, 25], [41, 29], [41, 33], [41, 37],
];

export class HMRSource {
  constructor(camera, { url = 'ws://127.0.0.1:8791', sendWidth = 640, quality = 0.75 } = {}) {
    this.camera = camera;
    this.url = url;
    this.sendWidth = sendWidth;
    this.quality = quality;
    this.maxInFlight = 1;
    this.onPose = () => {};
    this.onStatus = () => {};
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
    this.model = '';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this._encoding = false;
    this._unsub = null;
    this.stats = { rtt: 0, encode: 0 };
  }

  start() {
    this.stop();
    this.onStatus('connecting', `Connecting to ${this.url}…`);
    const ws = (this.ws = new WebSocket(this.url));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.onStatus('connected', 'Connected — waiting for model');
    ws.onerror = () => this.onStatus('error', 'Cannot reach InstantHMR server. Start it with ./server/run.sh');
    ws.onclose = () => { if (this.ws === ws) this.onStatus('error', 'InstantHMR server disconnected'); };
    ws.onmessage = (e) => this._onMessage(e.data);
    this._unsub = this.camera.onFrame((video, t) => this._maybeSend(video, t));
  }

  stop() {
    if (this._unsub) this._unsub();
    this._unsub = null;
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
    this.pending.clear();
  }

  _maybeSend(video, tCapture) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this._encoding) return;
    // Drop stale requests (server hiccup) so we never deadlock.
    const now = performance.now();
    for (const [id, p] of this.pending) if (now - p.tSent > 1500) this.pending.delete(id);
    if (this.pending.size >= this.maxInFlight) return;
    if (!video.videoWidth) return;

    const w = this.sendWidth, h = Math.round((video.videoHeight / video.videoWidth) * w);
    if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
    const t0 = performance.now();
    this.ctx.drawImage(video, 0, 0, w, h);
    this._encoding = true;
    const id = this.nextId++ >>> 0;
    this.canvas.toBlob(async (blob) => {
      this._encoding = false;
      if (!blob || this.ws !== ws || ws.readyState !== 1) return;
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const buf = new Uint8Array(4 + jpeg.length);
      new DataView(buf.buffer).setUint32(0, id, true);
      buf.set(jpeg, 4);
      const tSent = performance.now();
      this.pending.set(id, { tCapture, tSent, encode: tSent - t0, w, h });
      ws.send(buf);
    }, 'image/jpeg', this.quality);
  }

  _onMessage(data) {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data);
    if (msg.type === 'hello') {
      this.model = msg.model || '';
      this.onStatus('ready', `InstantHMR ready — ${this.model}`);
      return;
    }
    if (msg.type !== 'pose') return;
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (!p) return;
    const now = performance.now();
    const rtt = now - p.tSent;
    const timing = {
      encode: p.encode,
      decode: msg.timing?.decode ?? 0,
      detect: msg.timing?.detect ?? 0,
      hmr: msg.timing?.hmr ?? 0,
      server: msg.timing?.total ?? 0,
      transport: Math.max(0, rtt - (msg.timing?.total ?? 0)),
      rtt,
    };
    if (msg.model) this.model = msg.model;
    const person = msg.persons?.[0];
    if (!person) {
      this.onPose({ source: 'hmr', tCapture: p.tCapture, joints: null, conf: {}, kp2d: [], edges: HMR_EDGES, timing });
      return;
    }
    const J = person.j3d, K = person.j2d;
    const joints = {}, conf = {};
    const c = Math.max(0.05, Math.min(1, person.conf ?? 1));
    for (const [name, idx] of Object.entries(I)) {
      joints[name] = camToThree(J[idx][0], J[idx][1], J[idx][2]);
      conf[name] = c;
    }
    joints.leftHand = centroid(J, LEFT_FINGERS); conf.leftHand = c;
    joints.rightHand = centroid(J, RIGHT_FINGERS); conf.rightHand = c;

    // Keypoints near the frame edge (or outside it) are extrapolated: lower their confidence so the
    // avatar keeps a neutral pose for limbs the camera can't see.
    const W = msg.w || p.w, H = msg.h || p.h;
    const kp2d = K.map(([u, v]) => {
      const inside = u > -0.02 * W && u < 1.02 * W && v > -0.02 * H && v < 1.0 * H;
      return { x: u / W, y: v / H, c: inside ? c : 0.1 };
    });
    for (const [name, idx] of Object.entries(I)) conf[name] = Math.min(conf[name], kp2d[idx].c);
    conf.leftHand = conf.leftWrist; conf.rightHand = conf.rightWrist;

    this.onPose({ source: 'hmr', tCapture: p.tCapture, joints, conf, kp2d, edges: HMR_EDGES, timing, absolute: true });
  }
}

function centroid(J, idxs) {
  let x = 0, y = 0, z = 0;
  for (const i of idxs) { x += J[i][0]; y += J[i][1]; z += J[i][2]; }
  const n = idxs.length;
  return camToThree(x / n, y / n, z / n);
}
