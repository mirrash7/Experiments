// BREAKLIGHT CV: "Mirror Moment". Real-time person segmentation of the player's camera feed rendered as a neon
// silhouette, used three ways:
//   calibrate: the live silhouette canvas (`.canvas`) inside the T-pose guide, which pours into the hero on lock
//              (`pourInto(screenRect)`);
//   echo:      a giant translucent echo of the player behind the hero during Overdrive (`.object3d`, worldScene);
//   replay:    the recorded silhouette for the results side-by-side (`record(true)` during the run, then
//              `playReplay({from, to, rate})` / `setReplayTime(perfMs)`).
// Segmentation runs in a worker on its own cadence (segmenter.js); with no camera / no model it falls back to a skeleton
// silhouette from the tracker keypoints or the hero's bones. Nothing leaves the browser.
import * as THREE from 'three';
import { createSegmenter } from './segmenter.js';
import { createStylizer } from './stylizer.js';
import { createEcho } from './echo.js';
import { PALETTES } from './neon.js';

const MODES = ['off', 'calibrate', 'echo', 'replay'];
const _box = new THREE.Box3(), _v = new THREE.Vector3();

/**
 * @param {object} o
 * @param {HTMLVideoElement} o.video     the game's camera <video> (tracking.video); may have no stream (demo tracker)
 * @param {THREE.WebGLRenderer} o.renderer
 * @param {THREE.Scene} [o.scene]        worldScene: the echo is added here
 * @param {THREE.Camera} o.camera
 * @param {object} [o.hero]              loadVRMHero() result (skeleton fallback + heroScreenRect)
 * @param {'low'|'medium'|'high'} [o.quality]
 */
export function createMirror({ video = null, renderer = null, scene = null, camera = null, hero = null, quality = 'high', canvasSize = [640, 360],
  echo: echoOpts = {}, model = 'pose-lite', segmenter = null, useWorker = true } = {}) {
  const seg = segmenter || createSegmenter({ video, quality, model, hero, useWorker });
  const sty = createStylizer({ width: canvasSize[0], height: canvasSize[1] });
  const echo = createEcho(echoOpts);
  if (scene) scene.add(echo.object3d);

  const st = {
    mode: 'off', quality, time: 0, pulse: 0, lastBeat: -1, paletteName: 'calibrate', paletteOverride: null,
    framing: 'full', echoFraming: 'auto', pouring: false, recording: false,
    replay: null,           // { from, to, rate, loop, t, ext }
    history: [],            // recent seg frames (ghost)
    crop: [0, 0, 1, 1], echoCrop: { x: 0, y: 0, w: 1, h: 1 }, cropInit: false, echoCropInit: false,
    domMs: 0, echoMs: 0,
  };
  const echoPal = {};
  const getEchoPal = (name, p) => (echoPal[name] ||= { a: new THREE.Color(p.a), b: new THREE.Color(p.b) });
  const lowQ = () => st.quality === 'low';

  const liveMode = () => st.mode === 'calibrate' || st.mode === 'echo';
  function needSeg() { return liveMode() || st.recording || st.boothHold > 0; }
  function syncActive() { seg.setLive(liveMode() || st.boothHold > 0); seg.setActive(needSeg()); seg.record(st.recording); }
  st.boothHold = 0;

  /** Smoothed crop around the person's bbox (source uv) for a target aspect. */
  function autoCrop(cur, frame, targetAspect, dt, init) {
    const b = frame?.bbox;
    const fa = frame ? frame.w / frame.h : 16 / 9;
    let x = 0, y = 0, w = 1, h = 1;
    if (b && b.y1 > b.y0) {
      h = Math.min(1, Math.max(0.4, (b.y1 - b.y0) * 1.32));
      w = (h * targetAspect) / fa;
      if (w > 1) { w = 1; h = Math.min(1, (w * fa) / targetAspect); }
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2 - h * 0.02;
      x = Math.min(1 - w, Math.max(0, cx - w / 2));
      y = Math.min(1 - h, Math.max(0, cy - h / 2));
    }
    const k = init ? 1 : 1 - Math.exp(-dt * 3);
    cur.x += (x - cur.x) * k; cur.y += (y - cur.y) * k; cur.w += (w - cur.w) * k; cur.h += (h - cur.h) * k;
    return cur;
  }
  const domCropObj = { x: 0, y: 0, w: 1, h: 1 };

  /** A ~3-frame-old segmentation frame for the trailing ghost outline (only while live segmentation is flowing). */
  function ghostFrame(frame) {
    if (!frame || frame.kind !== 'seg' || st.history.length < 4) return null;
    const g = st.history[st.history.length - 4];
    return frame.t - g.t < 600 ? g : null;
  }

  function palette() {
    if (st.paletteOverride) return st.paletteOverride;
    return PALETTES[st.paletteName] || PALETTES.calibrate;
  }

  function domUniforms(frame, extra = {}) {
    if (st.framing === 'auto' || extra.auto) { autoCrop(domCropObj, frame, sty.canvas.width / sty.canvas.height, extra.dt ?? 0.016, !st.cropInit); st.cropInit = true; st.crop = [domCropObj.x, domCropObj.y, domCropObj.w, domCropObj.h]; }
    else st.crop = [0, 0, 1, 1];
    const ghost = ghostFrame(frame);
    return {
      palette: palette(), time: st.time, pulse: st.pulse, intensity: 1, mirror: true,
      detail: frame?.kind === 'seg' ? 1 : 0.5, fill: 0.85, pour: 0, crop: st.crop,
      ghost: lowQ() ? null : ghost, ghostAmt: st.mode === 'calibrate' ? 0.6 : 0, ...extra,
      mirror: extra.mirror ?? true,
    };
  }

  const api = {
    canvas: sty.canvas,
    object3d: echo.object3d,
    segmenter: seg,
    echo,
    get mode() { return st.mode; },
    get ready() { return seg.ready; },
    /** 'seg' | 'skeleton' | 'none': what the silhouette is currently made from. */
    get source() { return seg.kind; },
    get stats() {
      const s = seg.stats;
      return { segFps: s.fps, workerMs: +s.workerMs.toFixed(2), inferMs: +s.inferMs.toFixed(2), mainMs: +s.mainMs.toFixed(3), mainMax: +s.mainMax.toFixed(2),
        domMs: +st.domMs.toFixed(3), echoMs: +st.echoMs.toFixed(3), dropped: s.dropped, status: seg.status, delegate: seg.delegate, inWorker: seg.inWorker, kind: seg.kind, quality: st.quality };
    },

    setMode(m) {
      if (!MODES.includes(m)) throw new Error(`mirror.setMode: ${m}`);
      st.mode = m;
      echo.setVisible(m === 'echo');
      if (m === 'calibrate') { st.paletteName = 'calibrate'; st.cropInit = false; }
      if (m === 'replay') st.paletteName = 'results';
      if (m !== 'replay') st.replay = null;
      if (m === 'off' || m === 'echo') sty.clear();
      syncActive();
    },
    /** Palette by name (PALETTES key: 'calibrate','locked',0,1,2,'boss','overdrive','results') or {a:'#hex', b:'#hex'}; null = auto. */
    setPalette(p) { if (p == null) st.paletteOverride = null; else if (typeof p === 'object') st.paletteOverride = p; else { st.paletteOverride = null; st.paletteName = p; } },
    /** DOM canvas framing: 'full' (whole camera view, matches the guide) or 'auto' (follows the player, zoomed). */
    setFraming(f) { st.framing = f === 'auto' ? 'auto' : 'full'; st.cropInit = false; },
    setQuality(q) { st.quality = q; seg.setQuality(q); },
    setVideo(v) { seg.setVideo(v); },
    setHero(h) { hero = h; seg.setHero(h); },
    /** Feed every tracker frame (keypoints for the skeleton fallback). */
    setTrackerFrame(f) { seg.setTrackerFrame(f); },
    /** Keep the segmenter running while the photo booth is armed (ref-counted). */
    hold(on) { st.boothHold = Math.max(0, st.boothHold + (on ? 1 : -1)); syncActive(); },

    /** Per render frame. args: { beat (fractional beat index), overdrive, act }. */
    update(dt, { beat = null, overdrive = false, act = null } = {}) {
      st.time += dt;
      seg.update(dt);
      if (beat != null) { const f = beat - Math.floor(beat); st.pulse = Math.exp(-f * 5); } else st.pulse *= Math.exp(-dt * 4);
      const frame = seg.frame;
      if (frame && frame.kind === 'seg' && st.history[st.history.length - 1] !== frame) { st.history.push(frame); if (st.history.length > 5) st.history.shift(); }
      if (st.mode === 'echo' || st.mode === 'off') {
        if (!st.paletteOverride) st.paletteName = overdrive ? 'overdrive' : act != null && PALETTES[act] ? act : st.paletteName === 'calibrate' ? 'overdrive' : st.paletteName;
      }
      // DOM silhouette
      const t0 = performance.now();
      if (!st.pouring) {
        if (st.mode === 'calibrate') sty.render(frame, domUniforms(frame, { dt }));
        else if (st.mode === 'replay' && st.replay) {
          const R = st.replay;
          if (!R.ext) { R.t += dt * 1000 * R.rate; if (R.t > R.to) R.t = R.loop ? R.from + (R.t - R.to) : R.to; }
          R.ext = false;
          const rf = seg.recordedAt(R.t);
          if (rf) {
            const f = { image: rf.image, w: rf.image.width, h: rf.image.height, version: rf.t, kind: 'seg', bbox: rf.bbox };
            // unmirrored: it sits next to the hero seen from the FRONT, so both read the same way round
            sty.render(f, domUniforms(f, { dt, detail: 1, fill: 0.8, mirror: false, auto: true }));
          }
        }
      }
      st.domMs += (performance.now() - t0 - st.domMs) * 0.1;
      // 3D echo
      const t1 = performance.now();
      const pal = palette();
      const ename = st.paletteOverride ? `${pal.a}${pal.b}` : st.paletteName;
      const crop = st.echoFraming === 'auto' ? autoCrop(st.echoCrop, frame, 0.95, dt, !st.echoCropInit) : { x: 0, y: 0, w: 1, h: 1 };
      if (frame) st.echoCropInit = true;
      const ghost = ghostFrame(frame);
      echo.update(frame, { dt, camera, palette: getEchoPal(ename, pal), pulse: st.pulse, time: st.time, ghost: lowQ() ? null : ghost, ghostAmt: 0.9, crop });
      st.echoMs += (performance.now() - t1 - st.echoMs) * 0.1;
    },

    /**
     * Calibration lock: the live silhouette canvas flies into `screenRect` ({left, top, width, height}, CSS px, e.g.
     * heroScreenRect()) and melts into it. Resolves when done (the canvas is left hidden; call setMode('off')).
     */
    pourInto(screenRect, { duration = 1150, flash = true } = {}) {
      const c = sty.canvas;
      const r0 = c.getBoundingClientRect();
      const frame = seg.frame;
      st.pouring = true;
      const u = domUniforms(frame, { palette: PALETTES.locked, ghostAmt: 0 });
      // where the person is inside the canvas (CSS px)
      let px = r0.left, py = r0.top, pw = r0.width, ph = r0.height;
      const b = frame?.bbox, cr = u.crop;
      if (b && r0.width > 0) {
        const ox0 = 1 - (b.x1 - cr[0]) / cr[2], ox1 = 1 - (b.x0 - cr[0]) / cr[2];   // mirrored
        const oy0 = (b.y0 - cr[1]) / cr[3], oy1 = (b.y1 - cr[1]) / cr[3];
        px = r0.left + ox0 * r0.width; pw = (ox1 - ox0) * r0.width; py = r0.top + oy0 * r0.height; ph = (oy1 - oy0) * r0.height;
      }
      const T = screenRect || { left: innerWidth / 2 - 100, top: innerHeight * 0.25, width: 200, height: innerHeight * 0.5 };
      const s = ph > 1 ? T.height / ph : 1;
      const dx = T.left + T.width / 2 - (px + pw / 2) * 1, dy = T.top + T.height / 2 - (py + ph / 2);
      const prevTransform = c.style.transform, prevOrigin = c.style.transformOrigin, prevTransition = c.style.transition, prevOpacity = c.style.opacity;
      c.style.transition = 'none';
      c.style.transformOrigin = `${px + pw / 2 - r0.left}px ${py + ph / 2 - r0.top}px`;
      const ease = (x) => x * x * (3 - 2 * x);
      return new Promise((resolve) => {
        const t0 = performance.now();
        let flashed = false;
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / duration);
          const k1 = Math.min(1, k / 0.3), k2 = Math.max(0, (k - 0.3) / 0.7);
          const m = ease(k2) * ease(k2);
          const sc = (1 + 0.06 * Math.sin(k1 * Math.PI)) * (1 + (s - 1) * m);
          c.style.transform = `translate(${dx * m}px, ${dy * m}px) scale(${sc})`;
          c.style.opacity = String(k > 0.85 ? 1 - (k - 0.85) / 0.15 : 1);
          st.time += 1 / 60;
          sty.render(seg.frame || frame, { ...u, time: st.time, pulse: 1 - k1 * 0.5, intensity: 1 + 0.6 * k1, pour: Math.max(0, k2 - 0.05) * 0.85 });
          if (flash && !flashed && k > 0.82) { flashed = true; impactFlash(T); }
          if (k < 1) requestAnimationFrame(step);
          else {
            st.pouring = false;
            c.style.opacity = '0';
            setTimeout(() => { c.style.transform = prevTransform; c.style.transformOrigin = prevOrigin; c.style.transition = prevTransition; c.style.opacity = prevOpacity; sty.clear(); }, 60);
            resolve();
          }
        };
        requestAnimationFrame(step);
      });
    },

    /** Start/stop recording small silhouette frames for the results replay (keeps segmentation running). */
    record(on) { st.recording = !!on; if (on) seg.clearRecording(); syncActive(); },
    /** Time range of the recording (performance.now() ms) or null. */
    get recorded() { return seg.recordedRange(); },
    /** Play the recorded silhouette from `from` to `to` (performance.now() ms; default: the last 5 s) at `rate`. */
    playReplay({ from = null, to = null, rate = 0.35, loop = true } = {}) {
      const r = seg.recordedRange();
      if (!r) return false;
      const t1 = to ?? r.t1, t0 = from ?? Math.max(r.t0, t1 - 5000);
      st.recording = false;   // freeze the buffer while it plays (it would scroll away under a long results screen)
      api.setMode('replay');
      st.replay = { from: t0, to: t1, rate, loop, t: t0, ext: false };
      st.cropInit = false;
      return true;
    },
    /** Drive the replay from the outside (e.g. the 3D replay's song time -> clock.toPerf()). */
    setReplayTime(perfMs) { if (st.replay) { st.replay.t = perfMs; st.replay.ext = true; } },
    get replayProgress() { const R = st.replay; return R ? (R.t - R.from) / Math.max(1, R.to - R.from) : 0; },

    dispose() { seg.dispose(); sty.dispose(); echo.object3d.parent?.remove(echo.object3d); echo.dispose(); },
  };
  return api;
}

/** A soft light ring at the pour target (DOM, self-removing). */
function impactFlash(T) {
  const d = document.createElement('div');
  const size = Math.max(T.width, T.height) * 1.1;
  Object.assign(d.style, {
    position: 'fixed', left: `${T.left + T.width / 2 - size / 2}px`, top: `${T.top + T.height / 2 - size / 2}px`, width: `${size}px`, height: `${size}px`,
    borderRadius: '50%', pointerEvents: 'none', zIndex: 60, mixBlendMode: 'screen',
    background: 'radial-gradient(circle, rgba(255,246,214,0.95) 0%, rgba(255,190,90,0.55) 28%, rgba(120,240,255,0.25) 52%, rgba(0,0,0,0) 70%)',
    transform: 'scale(0.2)', opacity: '1', transition: 'transform 520ms cubic-bezier(.2,.8,.2,1), opacity 620ms ease-out',
  });
  document.body.appendChild(d);
  requestAnimationFrame(() => { d.style.transform = 'scale(1.4)'; d.style.opacity = '0'; });
  setTimeout(() => d.remove(), 700);
}

/**
 * The hero's on-screen box (CSS px) for pourInto(): projects the hero's skinned bounds (bones) through `camera`.
 * canvas: the renderer's canvas (for its CSS rect).
 */
export function heroScreenRect(hero, camera, canvas) {
  const b = hero?.bones;
  if (!b?.hips) return null;
  _box.makeEmpty();
  for (const k of ['head', 'headTop', 'hips', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftUpperArm', 'rightUpperArm', 'leftForeArm', 'rightForeArm']) {
    if (!b[k]) continue;
    b[k].getWorldPosition(_v); _box.expandByPoint(_v);
  }
  if (!b.headTop) _box.max.y += (hero.info?.height || 1.6) * 0.08;
  const r = canvas.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z).project(camera);
    const sx = r.left + (_v.x * 0.5 + 0.5) * r.width, sy = r.top + (0.5 - _v.y * 0.5) * r.height;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}
