// BREAKLIGHT CV: "Mirror Moment". Real-time person segmentation of the player's camera feed rendered as a neon
// silhouette, used three ways:
//   calibrate: the live silhouette canvas (`.canvas`) inside the T-pose guide, which pours into the hero on lock
//              (`pourInto(screenRect)`: a borderless particle stream into the hero's body, pour.js);
//   echo:      a giant translucent hologram of the player in the sky during Overdrive (`.object3d`, worldScene), placed
//              per game state with `setEchoPreset('run'|'boss'|'title'|'results')` clear of the boss / rift / hero;
//   replay:    the recorded silhouette for the results side-by-side (`record(true)` during the run, then
//              `playReplay({from, to, rate})` / `setReplayTime(perfMs)`).
// Segmentation runs in a worker on its own cadence (segmenter.js); with no camera / no model it falls back to a skeleton
// silhouette from the tracker keypoints or the hero's bones. Nothing leaves the browser.
import * as THREE from 'three';
import { createSegmenter } from './segmenter.js';
import { createStylizer } from './stylizer.js';
import { createEcho, ECHO_PRESETS } from './echo.js';
import { runPour, sampleSource, boxSource } from './pour.js';
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
  const echo = createEcho({ preset: echoOpts.position && !echoOpts.preset ? null : echoOpts.preset || 'run', ...echoOpts });
  if (scene) scene.add(echo.object3d);
  // automatic echo keep-outs: the Warden (visual/boss.js 'EclipseWarden'), the rift portal (visual/stage.js 'rift') and
  // the hero (bones -> box, soft weight). Looked up by name in the world scene (cached; re-looked-up while missing).
  const named = { boss: null, rift: null, at: -1e9 };
  const heroBox = new THREE.Box3();
  function heroKeepOut() {
    const b = hero?.bones; if (!b?.hips) return null;
    heroBox.makeEmpty();
    for (const k of ['headTop', 'head', 'hips', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot']) if (b[k]) { b[k].getWorldPosition(_v); heroBox.expandByPoint(_v); }
    return heroBox.expandByScalar(0.15);
  }
  echo.setAutoKeepOut(() => {
    const now = performance.now();
    if (scene && (!named.boss || !named.rift) && now - named.at > 2000) {
      named.at = now;
      named.boss ||= scene.getObjectByName('EclipseWarden') || null;
      named.rift ||= scene.getObjectByName('rift') || null;
    }
    const out = [];
    if (named.boss) out.push({ obj: named.boss, weight: 1, tag: 'boss' });
    if (named.rift) out.push({ obj: named.rift, weight: 1, tag: 'rift' });
    if (hero) out.push({ obj: heroKeepOut, weight: 0.5, tag: 'hero' });
    return out;
  });

  // screen-space echo keep-outs (QA art r3 P1-2): the game HUD's rects, read from the DOM (getBoundingClientRect) as
  // fractions of the render canvas. Re-read by the echo every ~0.4 s (state changes show / hide HUD parts) and on resize.
  const HUD_PARTS = [
    ['.bl-vitals', 'vitals', true], ['.bl-score', 'score', true], ['.bl-combo', 'combo', false], ['.bl-pip', 'pip', false],
    ['.bl-awk-skip', 'skip', false], ['.bl-lane-top > *', 'banner', false],
  ];
  function hudKeepOut() {
    if (typeof document === 'undefined') return [];
    const out = [];
    const huds = [...document.querySelectorAll('.bl-hud')].filter((h) => !h.classList.contains('bl-hidden') && h.getClientRects().length);
    if (!huds.length) return out;
    const C = renderer?.domElement?.getBoundingClientRect?.() || { left: 0, top: 0, width: innerWidth, height: innerHeight };
    if (C.width < 2 || C.height < 2) return out;
    const pad = 0.006;
    const push = (r, tag) => {
      if (!r || r.width < 1 || r.height < 1) return;
      out.push({ tag, x0: (r.left - C.left) / C.width - pad, y0: (r.top - C.top) / C.height - pad, x1: (r.right - C.left) / C.width + pad, y1: (r.bottom - C.top) / C.height + pad });
    };
    const shown = (el) => { if (el.closest('.bl-hidden')) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
    for (const hud of huds) {
      let banner = false;
      for (const [sel, tag, deep] of HUD_PARTS) {
        for (const el of hud.querySelectorAll(sel)) {
          if (!shown(el)) continue;
          // union with the descendants: labels such as "OVERDRIVE x2" overflow their flex box
          let { left, top, right, bottom } = el.getBoundingClientRect();
          if (deep) for (const d of el.querySelectorAll('*')) { const r = d.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue; left = Math.min(left, r.left); top = Math.min(top, r.top); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom); }
          push({ left, top, right, bottom, width: right - left, height: bottom - top }, tag);
          if (tag === 'banner') banner = true;
        }
      }
      // the top banner lane is empty between banners: reserve its slot anyway (act banners drop in mid-Overdrive)
      const lane = hud.querySelector('.bl-lane-top');
      if (!banner && lane && shown(lane)) { const r = lane.getBoundingClientRect(); const top = (r.top - C.top) / C.height; out.push({ tag: 'banner', x0: 0.32, x1: 0.68, y0: top - pad, y1: top + 0.11 }); }
    }
    return out;
  }
  echo.setScreenKeepOut(hudKeepOut);
  const onResize = () => echo.refreshScreenKeepOut();
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  const st = {
    mode: 'off', quality, time: 0, pulse: 0, lastBeat: -1, paletteName: 'calibrate', paletteOverride: null,
    framing: 'full', echoFraming: 'auto', pouring: false, recording: false,
    replay: null,           // { from, to, rate, loop, t, ext }
    history: [],            // recent seg frames (ghost)
    crop: [0, 0, 1, 1], echoCrop: { x: 0, y: 0, w: 1, h: 1 }, cropInit: false, echoCropInit: false,
    domMs: 0, echoMs: 0,
  };
  const echoPal = {};
  // echo hologram: white-cyan outline (a) over a fresnel/gradient in the state colour (b) - the calibration look
  const ECHO_EDGE = '#c9fbff';
  const getEchoPal = (name, p, holo) => (echoPal[name + (holo ? ':h' : '')] ||= holo ? { a: new THREE.Color(ECHO_EDGE), b: new THREE.Color(name === 'overdrive' ? '#ffb43c' : p.a) } : { a: new THREE.Color(p.a), b: new THREE.Color(p.b) });
  const lowQ = () => st.quality === 'low';

  const liveMode = () => st.mode === 'calibrate' || st.mode === 'echo';
  function needSeg() { return liveMode() || st.recording || st.boothHold > 0; }
  function syncActive() { seg.setLive(liveMode() || st.boothHold > 0); seg.setActive(needSeg()); seg.record(st.recording); }
  st.boothHold = 0;

  /** Smoothed crop around the person's bbox (source uv) for a target aspect. */
  function autoCrop(cur, frame, targetAspect, dt, init, fastGrow = false) {
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
    // fastGrow (echo): open up quickly when the person grows (arms going up) so the hands are never cut by the quad edge
    const k = init ? 1 : 1 - Math.exp(-dt * (fastGrow && (h > cur.h + 0.005 || y < cur.y - 0.005) ? 14 : 3));
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
      if (m === 'echo') echo.refreshScreenKeepOut();
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
    /**
     * Echo placement per game state: 'run' (acts 1-3: left/right sky clear of the rift), 'boss' (beside the Warden, or far
     * behind it at low opacity if nothing beside it is clear), 'title', 'results'. o.keepOut: extra Object3D / Sphere /
     * Box3 / Vector3 / {center, radius} regions to avoid (the Warden, the rift and the hero are avoided automatically);
     * o.overrides: { h, top, depth, opacity, slots } tweaks. Re-solved from the live camera ~5x/s; always inside the frame.
     */
    setEchoPreset(name, o = {}) { echo.setPreset(name, o); return api.echoPlacement; },
    /** Screen-space echo keep-outs right now (the HUD rects read from the DOM, canvas fractions). */
    get echoScreenKeepOut() { return hudKeepOut(); },
    /** Replace the explicit echo keep-out list (null clears; automatic boss / rift / hero keep-outs stay). */
    setEchoKeepOut(list) { echo.setKeepOut(list); },
    /** Last echo placement solve: { mode, preset, slot, scale, rect {x0,y0,x1,y1} (screen fractions), overlap, behind, depth, keepOut[] }. */
    get echoPlacement() { return echo.placement; },
    /** Preset names for setEchoPreset(). */
    echoPresets: Object.keys(ECHO_PRESETS),
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
      const crop = st.echoFraming === 'auto' ? autoCrop(st.echoCrop, frame, 0.95, dt, !st.echoCropInit, true) : { x: 0, y: 0, w: 1, h: 1 };
      if (frame) st.echoCropInit = true;
      const ghost = ghostFrame(frame);
      echo.update(frame, { dt, camera, palette: getEchoPal(ename, pal, !st.paletteOverride), pulse: st.pulse, time: st.time, ghost: lowQ() ? null : ghost, ghostAmt: 0.9, crop });
      st.echoMs += (performance.now() - t1 - st.echoMs) * 0.1;
    },

    /**
     * Calibration lock: the silhouette dissolves into a borderless stream of light that arcs into the hero's on-screen
     * body and ends in a flash on the hero (pour.js). screenRect ({left, top, width, height}, CSS px, e.g.
     * heroScreenRect()) is the fallback target when the hero's bones aren't available. o.from: the element (canvas) or
     * CSS rect that currently shows the silhouette; default: this.canvas if it is laid out, else the UI's calibration
     * canvas ('.bl-sil-live'), else a centred box. o.onArrive(): called at the flash. Resolves when done (the canvas is
     * left cleared; call setMode('off')).
     */
    pourInto(screenRect, { duration = 1500, flash = true, from = null, onArrive = null, timeScale = 1 } = {}) {
      const c = sty.canvas;
      st.pouring = true;
      // 1) one last silhouette draw (no ghost) so the particles inherit its exact current shape
      const frame = seg.frame;
      if (frame && st.mode === 'calibrate') sty.render(frame, domUniforms(frame, { ghostAmt: 0 }));
      // 2) where is the silhouette on screen?
      let srcEl = null, srcRect = null;
      const laidOut = (el) => el && el.isConnected && (() => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? r : null; })();
      if (from && typeof from.getBoundingClientRect === 'function') { srcEl = from; srcRect = laidOut(from); }
      else if (from && from.width) { srcEl = c; srcRect = from; }
      if (!srcRect && laidOut(c)) { srcEl = c; srcRect = laidOut(c); }
      if (!srcRect) { const ui = typeof document !== 'undefined' && document.querySelector('.bl-sil-live'); const r = laidOut(ui); if (r) { srcEl = ui; srcRect = r; } }
      let sources = srcEl && srcRect ? sampleSource(srcEl, srcRect) : [];
      if (sources.length < 40) {
        // nothing visible to sample (canvas not in the DOM): the current silhouette in a centred guide-sized box
        const h = innerHeight * 0.78, w = h * (c.width / c.height);
        const R = { left: innerWidth / 2 - w / 2, top: innerHeight * 0.1, width: w, height: h };
        sources = sampleSource(c, R);
        if (sources.length < 40) sources = boxSource({ left: innerWidth / 2 - h * 0.18, top: innerHeight * 0.1, width: h * 0.36, height: h });
      }
      // 3) hide the source silhouette (the particles replace it 1:1 on the first frame)
      const prevOpacity = c.style.opacity, prevTransition = c.style.transition;
      if (srcEl === c) { c.style.transition = 'opacity 120ms linear'; c.style.opacity = '0'; }
      const canvas = renderer?.domElement || null;
      return runPour({ sources, hero, camera, canvas, rect: screenRect, duration, flash, onArrive, timeScale }).then((r) => {
        st.pouring = false;
        sty.clear();
        setTimeout(() => { c.style.opacity = prevOpacity; c.style.transition = prevTransition; }, 60);
        return r;
      }, (e) => { st.pouring = false; c.style.opacity = prevOpacity; c.style.transition = prevTransition; throw e; });
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

    dispose() { if (typeof window !== 'undefined') window.removeEventListener('resize', onResize); seg.dispose(); sty.dispose(); echo.object3d.parent?.remove(echo.object3d); echo.dispose(); if (globalThis.__blcv?.mirror === api) globalThis.__blcv.mirror = null; },
  };
  (globalThis.__blcv ||= {}).mirror = api;   // console / automation handle (window.__blcv.mirror)
  return api;
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
