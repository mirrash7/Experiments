// BREAKLIGHT CV: person-segmentation core. Runs inside the worker (seg.worker.js) or inline on the main thread as a
// fallback. Input: an ImageBitmap of the camera frame (already downscaled). Output: a "cutout" ImageBitmap (camera RGB,
// alpha = smoothed person mask), an optional small replay bitmap, and mask stats (bbox / coverage / centroid).
// Everything stays on this device: frames never leave the browser.
import { FilesetResolver, ImageSegmenter, PoseLandmarker } from '@mediapipe/tasks-vision';

export const SEG_MODELS = {
  // PoseLandmarker with outputSegmentationMasks: the mask is predicted on the person ROI, so it stays sharp for a
  // full-body player 2-3 m away (the selfie models are trained on close-ups). Also yields 2D landmarks.
  'pose-lite': '/models/pose_landmarker_lite.task',          // ~5.8 MB (default for the game)
  'pose-full': '/models/pose_landmarker_full.task',          // ~9.4 MB (already shipped for the MediaPipe tracker)
  selfie: '/models/selfie_segmenter.tflite',                 // ImageSegmenter 256x256 float16, ~250 KB: close-ups only
};

export class SegCore {
  constructor() {
    this.seg = null; this.delegate = null; this.channel = 0; this.labels = [];
    this.prev = null; this.prevW = 0; this.prevH = 0;
    this.lastTs = 0;
    this.maskCanvas = null; this.maskCtx = null; this.maskImg = null;
    this.cut = null; this.cutCtx = null;
    this.small = null; this.smallCtx = null;
  }

  async init({ wasmBase = '/mediapipe/wasm', model = 'pose-lite', delegate = 'GPU' } = {}) {
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);
    const url = SEG_MODELS[model] || model;
    this.isPose = /^pose|\.task$/.test(model);
    const Task = this.isPose ? PoseLandmarker : ImageSegmenter;
    const opts = (d) => this.isPose
      ? { baseOptions: { modelAssetPath: url, delegate: d }, runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: true,
        minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4 }
      : { baseOptions: { modelAssetPath: url, delegate: d }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false };
    try { this.seg = await Task.createFromOptions(fileset, opts(delegate)); this.delegate = delegate; }
    catch (e) {
      if (delegate === 'CPU') throw e;
      this.seg = await Task.createFromOptions(fileset, opts('CPU')); this.delegate = 'CPU';
    }
    this.labels = this.isPose ? ['person'] : this.seg.getLabels?.() || [];
    const pi = this.labels.findIndex((l) => /person/i.test(l));
    this.channel = pi >= 0 ? pi : -1;   // -1: single-channel model (or last channel)
    this.model = model;
    return { delegate: this.delegate, labels: this.labels };
  }

  _canvas(name, w, h) {
    let c = this[name];
    if (!c || c.width !== w || c.height !== h) {
      c = this[name] = new OffscreenCanvas(w, h);
      this[name + 'Ctx'] = c.getContext('2d', { willReadFrequently: name === 'maskCanvas' });
      if (name === 'maskCanvas') this.maskImg = new ImageData(w, h);
    }
    return this[name + 'Ctx'];
  }

  /**
   * Segment one frame. bitmap: ImageBitmap (closed here). opts: { t, smooth 0..1, lo, hi, small: {w,h}|null, fresh }.
   * Returns { cutout: ImageBitmap, small: ImageBitmap|null, bbox, ms } (bitmaps are transferable).
   */
  segment(bitmap, { t = performance.now(), smooth = 0.45, lo = 0.25, hi = 0.75, small = null, fresh = false } = {}) {
    const t0 = performance.now();
    const w = bitmap.width, h = bitmap.height;
    const ts = Math.max(this.lastTs + 1, Math.round(t));
    this.lastTs = ts;
    const res = this.isPose ? this.seg.detectForVideo(bitmap, ts) : this.seg.segmentForVideo(bitmap, ts);
    const masks = (this.isPose ? res.segmentationMasks : res.confidenceMasks) || [];
    const m = this.isPose ? masks[0] : masks[this.channel >= 0 && this.channel < masks.length ? this.channel : masks.length - 1];
    const lm = this.isPose && res.landmarks?.[0] ? res.landmarks[0].map((p) => ({ x: p.x, y: p.y, c: p.visibility ?? 1 })) : null;
    const conf = m ? m.getAsFloat32Array() : null;
    const tInfer = performance.now() - t0;

    const mctx = this._canvas('maskCanvas', w, h);
    const img = this.maskImg, px = img.data;
    const n = w * h;
    const usePrev = !fresh && this.prev && this.prevW === w && this.prevH === h;
    if (!usePrev) { this.prev = new Float32Array(n); this.prevW = w; this.prevH = h; }
    const prev = this.prev;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, cov = 0, cx = 0, cy = 0;
    const inv = 1 / Math.max(1e-3, hi - lo);
    for (let i = 0; i < n; i++) {
      let v = conf ? conf[i] : 0;
      if (usePrev) { const p = prev[i]; v = v > p ? p + (v - p) * (1 - smooth * 0.6) : p + (v - p) * (1 - smooth); }   // rise fast, fall slower
      prev[i] = v;
      let a = (v - lo) * inv; a = a < 0 ? 0 : a > 1 ? 1 : a; a = a * a * (3 - 2 * a);
      const o = i * 4;
      px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = a * 255;
      if (a > 0.5) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; cov++; cx += x; cy += y; }
    }
    res.close?.();
    mctx.putImageData(img, 0, 0);

    const cctx = this._canvas('cut', w, h);
    cctx.globalCompositeOperation = 'copy';
    cctx.drawImage(bitmap, 0, 0, w, h);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(this.maskCanvas, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    bitmap.close();

    let smallBmp = null;
    if (small) {
      const sctx = this._canvas('small', small.w, small.h);
      sctx.clearRect(0, 0, small.w, small.h);
      sctx.drawImage(this.cut, 0, 0, small.w, small.h);
      smallBmp = this.small.transferToImageBitmap();
    }
    const cutout = this.cut.transferToImageBitmap();
    const bbox = cov ? { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, cov: cov / n, cx: cx / cov / w, cy: cy / cov / h } : null;
    return { cutout, small: smallBmp, bbox, w, h, lm, ms: performance.now() - t0, infer: tInfer };
  }

  close() { try { this.seg?.close(); } catch { /* */ } this.seg = null; }
}
