// BREAKLIGHT CV: segmentation manager (main thread). Pumps frames from the EXISTING camera <video> on its own cadence
// (requestVideoFrameCallback, throttled to the quality's rate) into a worker running MediaPipe ImageSegmenter (GPU
// delegate), and keeps the latest "person cutout" (camera RGB + soft alpha mask) for the mirror and the photo booth.
// Falls back to an inline (main-thread) segmenter if the worker can't start, and to a skeleton silhouette (tracker
// keypoints or the hero's bones) when segmentation is unavailable or there is no live camera (demo tracker).
// Privacy: frames and masks only ever live in this tab's memory; nothing is uploaded.
import { namedFromFrame, namedFromHero, drawSkeletonSilhouette } from './skeleton.js';

export const SEG_QUALITY = {
  high: { w: 480, fps: 30, recFps: 12, recW: 288 },
  medium: { w: 384, fps: 24, recFps: 12, recW: 224 },
  low: { w: 256, fps: 15, recFps: 10, recW: 176 },
};
const RING = 6;            // live cutouts kept alive (consumers may still be uploading an older one)

export function createSegmenter({ video = null, quality = 'high', model = 'pose-lite', useWorker = true, recordSeconds = 20, hero = null } = {}) {
  const S = {
    status: 'loading',      // 'loading' | 'ready' (model up) | 'unavailable'
    kind: 'none',           // what the latest frame is: 'seg' | 'skeleton' | 'none'
    delegate: null, inWorker: false, model,
    frame: null,            // { image, w, h, bbox, t, version, kind }
    version: 0,
    stats: { fps: 0, workerMs: 0, inferMs: 0, mainMs: 0, mainMax: 0, mainTotal: 0, dropped: 0, frames: 0 },
    quality: SEG_QUALITY[quality] ? quality : 'high',
    active: false,
    live: true,             // false: only the results replay is recording -> run at the (lower) record rate
    hero,
  };
  let worker = null, core = null, busy = false, lastSent = 0, rvfcId = 0, disposed = false;
  let id = 0, hiresPending = null, recording = false, lastRec = 0;
  const ring = [];
  const rec = [];           // { t, image } small cutouts for the results replay
  const resultTimes = [];
  let lastKp = null, lastKpAt = 0, lastSegAt = 0, skelAcc = 0;
  const skelCanvas = document.createElement('canvas');
  const skelCtx = skelCanvas.getContext('2d');
  let heroPts = {};

  const Q = () => SEG_QUALITY[S.quality];
  const videoLive = () => !!(video && video.srcObject && video.readyState >= 2 && video.videoWidth && !video.ended);
  const dims = (wTarget) => {
    const vw = video?.videoWidth || 16, vh = video?.videoHeight || 9;
    const w = Math.min(wTarget, vw);
    return { w: Math.round(w), h: Math.max(2, Math.round((w * vh) / vw)) };
  };

  // ------------------------------------------------------------------------------------------------ init
  const ready = (async () => {
    if (useWorker && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        worker = new Worker(new URL('./seg.worker.js', import.meta.url), { type: 'module' });
        const info = await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('worker init timeout')), 20000);
          worker.onmessage = (e) => { if (e.data.type === 'ready') { clearTimeout(to); resolve(e.data); } else if (e.data.type === 'error') { clearTimeout(to); reject(new Error(e.data.message)); } };
          worker.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || 'worker error')); };
          worker.postMessage({ type: 'init', wasmBase: new URL('/mediapipe/wasm', location.href).href, model, delegate: 'GPU' });
        });
        worker.onmessage = onWorker; worker.onerror = null;
        S.delegate = info.delegate; S.inWorker = true; S.status = 'ready';
        return true;
      } catch (e) {
        console.info('[cv] segmentation worker unavailable, trying inline:', e.message || e);
        try { worker?.terminate(); } catch { /* */ }
        worker = null;
      }
    }
    try {
      const { SegCore } = await import('./seg-core.js');
      core = new SegCore();
      const info = await core.init({ model, delegate: 'GPU' });
      S.delegate = info.delegate; S.status = 'ready';
      return true;
    } catch (e) {
      console.info('[cv] segmentation unavailable, using the skeleton silhouette:', e.message || e);
      S.status = 'unavailable'; core = null;
      return false;
    }
  })();

  // ------------------------------------------------------------------------------------------------ frame pump
  function schedule() {
    if (disposed || !S.active || !video || rvfcId) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) rvfcId = video.requestVideoFrameCallback(onVideoFrame);
    else rvfcId = requestAnimationFrame(() => onVideoFrame(performance.now()));
  }
  function onVideoFrame(now) {
    rvfcId = 0;
    if (disposed || !S.active) return;
    schedule();
    if (S.status !== 'ready' || !videoLive()) return;
    const interval = 1000 / (S.live ? Q().fps : Q().recFps);
    if (busy) { if (now - lastSent > interval) S.stats.dropped++; return; }
    if (now - lastSent < interval * 0.92) return;
    lastSent = now;
    send(false);
  }

  function send(hires) {
    const q = Q();
    const { w, h } = dims(hires ? 1280 : q.w);
    const t0 = performance.now();
    const t = t0;
    const wantRec = !hires && recording && t - lastRec >= 1000 / q.recFps;
    if (wantRec) lastRec = t;
    const small = wantRec ? dims(q.recW) : null;
    if (!hires) busy = true;
    if (worker) {
      createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: hires ? 'high' : 'low' }).then((bitmap) => {
        const t1 = performance.now();
        worker.postMessage({ type: 'frame', id: ++id, bitmap, t, small, hires, fresh: hires, smooth: 0.45 }, [bitmap]);
        mainCost(performance.now() - t1);
      }).catch(() => { if (!hires) busy = false; if (hires) resolveHires(null); });
      mainCost(performance.now() - t0);
    } else if (core) {
      // inline fallback: synchronous on the main thread (own cadence, still off the render loop's critical path)
      createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: hires ? 'high' : 'low' }).then((bitmap) => {
        const t1 = performance.now();
        try { onResult({ ...core.segment(bitmap, { t, small, fresh: hires }), t, hires }); }
        catch (e) { if (!hires) busy = false; else resolveHires(null); }
        mainCost(performance.now() - t1);
      }).catch(() => { if (!hires) busy = false; if (hires) resolveHires(null); });
    }
  }
  function mainCost(ms) {
    const s = S.stats;
    s.mainMs += (ms - s.mainMs) * 0.1;
    s.mainTotal += ms;
    s.mainMax = Math.max(s.mainMax * 0.995, ms);
  }

  function onWorker(e) {
    const m = e.data;
    if (m.type === 'result') onResult(m);
    else if (m.type === 'fail') { if (m.hires) resolveHires(null); else busy = false; }
  }

  function onResult(r) {
    const t0 = performance.now();
    if (r.hires) { resolveHires({ image: r.cutout, w: r.w, h: r.h, bbox: r.bbox, kind: 'seg', owned: true }); return; }
    busy = false;
    const s = S.stats;
    s.workerMs += (r.ms - s.workerMs) * 0.1;
    s.inferMs += ((r.infer ?? r.ms) - s.inferMs) * 0.1;
    s.frames++;
    resultTimes.push(t0); while (resultTimes.length && t0 - resultTimes[0] > 1000) resultTimes.shift();
    s.fps = resultTimes.length;
    lastSegAt = t0;
    pushFrame(r.cutout, r.w, r.h, r.bbox, 'seg', r.t);
    if (r.small) {
      rec.push({ t: r.t, image: r.small, bbox: r.bbox });
      const cap = recordSeconds * Q().recFps + 4;
      while (rec.length > cap) rec.shift().image.close?.();
    }
    mainCost(performance.now() - t0);
  }

  function pushFrame(image, w, h, bbox, kind, t) {
    const f = { image, w, h, bbox, t: t ?? performance.now(), version: ++S.version, kind };
    if (kind === 'seg') { ring.push(f); while (ring.length > RING) ring.shift().image.close?.(); }
    S.frame = f; S.kind = kind;
  }

  let resolveHiresFn = null;
  function resolveHires(v) { const r = resolveHiresFn; resolveHiresFn = null; hiresPending = null; r?.(v); }

  // ------------------------------------------------------------------------------------------------ skeleton fallback
  function skeletonFrame() {
    const now = performance.now();
    const pts = lastKp && now - lastKpAt < 600 ? lastKp : S.hero ? namedFromHero(S.hero, videoLive() ? video.videoWidth / video.videoHeight : 16 / 9, heroPts) : null;
    if (!pts) return false;
    const { w, h } = videoLive() ? dims(Q().w) : { w: Q().w, h: Math.round(Q().w * 9 / 16) };
    if (skelCanvas.width !== w || skelCanvas.height !== h) { skelCanvas.width = w; skelCanvas.height = h; }
    const bbox = drawSkeletonSilhouette(skelCtx, pts, w, h);
    pushFrame(skelCanvas, w, h, bbox, 'skeleton');
    return true;
  }

  // ------------------------------------------------------------------------------------------------ API
  const api = {
    get status() { return S.status; },
    get kind() { return S.kind; },
    get delegate() { return S.delegate; },
    get inWorker() { return S.inWorker; },
    get frame() { return S.frame; },
    get version() { return S.version; },
    get stats() { return S.stats; },
    get quality() { return S.quality; },
    get active() { return S.active; },
    get recording() { return recording; },
    ready,
    /** Start / stop pumping camera frames (segmentation only costs anything while active). */
    setActive(on) {
      on = !!on;
      if (on === S.active) return;
      S.active = on;
      if (on) schedule();
      else if (rvfcId && video) { try { video.cancelVideoFrameCallback?.(rvfcId); } catch { /* */ } rvfcId = 0; }
    },
    setQuality(q) { if (SEG_QUALITY[q]) S.quality = q; },
    /** live = something shows the silhouette now (full rate); false = only recording for the replay (record rate). */
    setLive(on) { S.live = !!on; },
    setVideo(v) { if (v === video) return; const was = S.active; api.setActive(false); video = v; if (was) api.setActive(true); },
    setHero(h) { S.hero = h; },
    /** Feed tracker frames (tracking.onFrame): keypoints for the skeleton fallback. */
    setTrackerFrame(f) { const p = namedFromFrame(f); if (p) { lastKp = p; lastKpAt = performance.now(); } },
    /** Per render frame: runs the skeleton fallback (~20 Hz) when segmentation frames are stale. Cheap otherwise. */
    update(dt) {
      if (!S.active) return;
      const segFresh = S.status === 'ready' && videoLive() && performance.now() - lastSegAt < 700;
      if (segFresh) return;
      skelAcc += dt;
      if (skelAcc < 1 / 20) return;
      skelAcc = 0;
      const t0 = performance.now();
      if (!skeletonFrame()) S.kind = 'none';
      mainCost(performance.now() - t0);
    },
    /** Record small cutouts for the results replay (ring of `recordSeconds`). */
    record(on) { recording = !!on; },
    clearRecording() { for (const r of rec) r.image.close?.(); rec.length = 0; },
    /** Recorded frames in [t0, t1] (performance.now() ms). */
    recordedRange() { return rec.length ? { t0: rec[0].t, t1: rec[rec.length - 1].t, n: rec.length } : null; },
    recordedAt(t) {
      if (!rec.length) return null;
      let lo = 0, hi = rec.length - 1;
      if (t <= rec[0].t) return rec[0];
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rec[mid].t <= t) lo = mid; else hi = mid - 1; }
      return rec[lo];
    },
    /** One full-resolution cutout (fresh mask, no smoothing) for the photo booth. Resolves null without segmentation. */
    captureHiRes() {
      if (hiresPending) return hiresPending;
      if (S.status !== 'ready' || !videoLive()) return Promise.resolve(null);
      hiresPending = new Promise((r) => { resolveHiresFn = r; });
      const to = setTimeout(() => resolveHires(null), 3000);
      hiresPending.finally(() => clearTimeout(to));
      send(true);
      return hiresPending;
    },
    /** Skeleton silhouette right now (photo booth fallback); returns a frame-like object or null. */
    skeletonNow() { return skeletonFrame() ? S.frame : null; },
    videoLive,
    dispose() {
      disposed = true; api.setActive(false);
      try { worker?.postMessage({ type: 'close' }); } catch { /* */ }
      setTimeout(() => worker?.terminate(), 200);
      core?.close();
      for (const f of ring) f.image.close?.(); ring.length = 0;
      api.clearRecording();
    },
  };
  return api;
}
