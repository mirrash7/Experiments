// Tracker selection with automatic fallback (InstantHMR server -> MediaPipe in-browser -> demo player), webcam
// capture, and presence / loss detection for the pause state.
import { Camera } from '../../sources/camera.js';
import { HMRSource } from '../../sources/hmrSource.js';
import { MediaPipeSource } from '../../sources/mediapipeSource.js';
import { SyntheticSource } from '../../sources/syntheticSource.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Tracking {
  constructor({ video, onStatus = () => {} }) {
    this.video = video;
    this.camera = new Camera(video);
    this.source = null;
    this.kind = null;               // 'hmr' | 'mediapipe' | 'demo' | 'autoplay'
    this.onStatus = onStatus;
    this.lastPoseAt = 0;            // performance.now() of the last frame WITH a body
    this.lastFrameAt = 0;
    this.frames = 0;
    this.poseTimes = [];
    this.lastFrame = null;
    this.onFrame = null;            // optional game hook (called before the motion pipeline's push)
    this.lat = 0;                   // capture -> arrival (EMA, ms)
  }

  /** Tracker frames per second over the last second. */
  get fps() { const n = performance.now(); while (this.poseTimes.length && n - this.poseTimes[0] > 1000) this.poseTimes.shift(); return this.poseTimes.length; }
  /** Seconds since a body was last seen. */
  get lostFor() { return this.lastPoseAt ? (performance.now() - this.lastPoseAt) / 1000 : Infinity; }

  _hook(src) {
    src.onStatus = (k, t) => this.onStatus(k, t);
    src.onPose = (f) => {
      const now = performance.now();
      this.lastFrameAt = now; this.frames++;
      this.lastFrame = f;
      if (f.joints) {
        this.lastPoseAt = now;
        this.poseTimes.push(now);
        if (this.poseTimes.length > 120) this.poseTimes.shift();
        if (f.tCapture) this.lat += (now - f.tCapture - this.lat) * 0.1;
      }
      this.onFrame?.(f);
    };
  }

  /** Wait until a frame with a body arrives (true) or `ms` passes (false). */
  async _waitPose(ms, token) {
    const t0 = performance.now(), n0 = this.lastPoseAt;
    while (performance.now() - t0 < ms) {
      if (token !== this._token) return false;
      if (this.lastPoseAt > n0) return true;
      await sleep(100);
    }
    return false;
  }

  /**
   * Start a tracker. kind: 'auto' | 'hmr' | 'mediapipe' | 'demo', or a ready source object (autoplay).
   * Resolves to the kind actually running. 'auto' falls back hmr -> mediapipe -> demo.
   */
  async start(kind, { custom = null } = {}) {
    this.stop();
    const token = (this._token = Symbol('start'));
    if (custom) return this._run(custom, 'autoplay');
    const order = kind === 'auto' ? ['hmr', 'mediapipe', 'demo'] : [kind];
    for (const k of order) {
      if (token !== this._token) return null;
      try {
        if (k === 'demo') return this._run(new SyntheticSource(), 'demo');
        if (!this.camera.active) {
          this.onStatus('connecting', 'Opening camera…');
          await this.camera.start();
        }
        const src = k === 'hmr' ? new HMRSource(this.camera) : new MediaPipeSource(this.camera);
        this._hook(src);
        this.source = src; this.kind = k;
        await src.start();
        const ok = await this._waitPose(k === 'hmr' ? 4500 : 9000, token);
        if (ok || order.length === 1) return k;
        console.info(`[tracking] ${k}: no body within the timeout, falling back`);
        src.stop(); this.source = null;
      } catch (e) {
        console.info(`[tracking] ${k} unavailable: ${e?.name === 'NotAllowedError' ? 'camera permission denied' : e?.message || e}`);
        this.source?.stop?.(); this.source = null;
        if (order.length === 1) { this.onStatus('error', `${k} failed: ${e?.message || e}`); return this._run(new SyntheticSource(), 'demo'); }
      }
    }
    return this._run(new SyntheticSource(), 'demo');
  }

  _run(src, kind) {
    this._hook(src);
    this.source = src; this.kind = kind;
    if (kind === 'demo' || kind === 'autoplay') this.camera.stop();
    src.start();
    return kind;
  }

  stop() {
    this._token = null;
    this.source?.stop?.();
    this.source = null;
  }
}
