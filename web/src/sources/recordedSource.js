// Recorded clips: replay a tracking session through the motion pipeline exactly like a live source, and record
// one from any live source. Two clip kinds:
//   { kind: 'hmr-raw', fps, latencyMs, frames: [{ t, msg }] }   raw InstantHMR server replies (protocol 2), t ms
//        from clip start; replayed through parseHMRPose, so they get MHR params, keypoints, conf like live
//   { kind: 'frames', frames: [{ t, lat, frame }] }             serialized PoseFrames from any source
// Replay re-stamps capture times onto the live clock (tCapture = now - latency) and loops.
import * as THREE from 'three';
import { parseHMRPose } from './hmrSource.js';

const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const arr = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];

export function serializeFrame(f) {
  const o = { ...f };
  o.joints = f.joints ? Object.fromEntries(Object.entries(f.joints).map(([k, v]) => [k, arr(v)])) : null;
  if (f.extra) o.extra = Object.fromEntries(Object.entries(f.extra).map(([k, v]) => [k, arr(v)]));
  if (f.kp3d) delete o.kp3d;                 // rebuilt from j3d
  if (f.mhr) o.mhr = Array.from(f.mhr, (x) => +x.toFixed(5));
  if (f.shape) o.shape = Array.from(f.shape, (x) => +x.toFixed(4));
  delete o.tCapture; delete o.tArrive;
  return o;
}

export function deserializeFrame(o, tCapture, tArrive) {
  const f = { ...o, tCapture, tArrive };
  if (o.joints) f.joints = Object.fromEntries(Object.entries(o.joints).map(([k, v]) => [k, vec(v)]));
  if (o.extra) f.extra = Object.fromEntries(Object.entries(o.extra).map(([k, v]) => [k, vec(v)]));
  if (o.j3d) f.kp3d = o.j3d.map((j) => new THREE.Vector3(j[0], -j[1], -j[2]));
  if (o.mhr) f.mhr = Float32Array.from(o.mhr);
  if (o.shape) f.shape = Float32Array.from(o.shape);
  return f;
}

export class RecordedSource {
  constructor(clip, { loop = true, speed = 1 } = {}) {
    this.clip = clip; this.loop = loop; this.speed = speed;
    this.onPose = () => {}; this.onStatus = () => {};
    this.model = `Recorded clip (${clip.kind}, ${clip.frames.length} frames)`;
    this._timer = null;
  }
  static async load(url, opts) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`clip ${url}: HTTP ${r.status}`);
    return new RecordedSource(await r.json(), opts);
  }
  get duration() { return this.clip.frames.at(-1).t + 1000 / (this.clip.fps ?? 25); }
  start() {
    this.stop();
    this._t0 = performance.now(); this._i = 0; this._loopN = 0;
    this.onStatus('ready', this.model);
    this._timer = setInterval(() => this._tick(), 4);
  }
  stop() { clearInterval(this._timer); this._timer = null; }
  _tick() {
    const F = this.clip.frames;
    const now = performance.now();
    const lat = this.clip.latencyMs ?? 60;
    const clipT = (now - this._t0) * this.speed - lat;   // capture time (clip clock) of frames arriving now
    while (this._i < F.length && F[this._i].t <= clipT - this._loopN * this.duration) {
      const fr = F[this._i++];
      const tCapture = this._t0 + (fr.t + this._loopN * this.duration) / this.speed;
      let frame;
      if (this.clip.kind === 'hmr-raw') {
        frame = parseHMRPose(fr.msg, { tCapture, tSent: now - (fr.msg.timing?.total ?? 15), encode: 0, w: fr.msg.w, h: fr.msg.h }, now);
      } else frame = deserializeFrame(fr.frame, now - (fr.lat ?? lat), now);
      frame.clipIndex = this._i - 1;
      this.onPose(frame);
    }
    if (this._i >= F.length) {
      if (!this.loop) { this.stop(); this.onStatus('done', 'clip finished'); return; }
      this._i = 0; this._loopN++;
    }
  }
}

/** Records PoseFrames from any source (call push(frame) from onPose); stop() returns a 'frames' clip. */
export class Recorder {
  constructor() { this.frames = []; this.t0 = null; this.active = false; }
  start() { this.frames = []; this.t0 = null; this.active = true; }
  push(f) {
    if (!this.active || !f) return;
    if (this.t0 === null) this.t0 = f.tCapture;
    this.frames.push({ t: +(f.tCapture - this.t0).toFixed(1), lat: +((f.tArrive ?? performance.now()) - f.tCapture).toFixed(1), frame: serializeFrame(f) });
  }
  stop() { this.active = false; return { kind: 'frames', fps: 30, frames: this.frames }; }
}
