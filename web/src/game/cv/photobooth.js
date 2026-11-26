// BREAKLIGHT CV: "Breaklight Photo Booth". After a run: arm() -> the player strikes a victory pose (both hands up / V /
// flex, held 1 s) -> 3-2-1 countdown -> flash -> capture: a fresh full-res segmentation cutout of the player, the hero
// rendered from the front in the same pose (it is mirroring the player live), and the score/rank/body stats, composed
// into a 1080x1350 card (`.card`) -> onCapture(cb(blob, dataURL)) + an optional preview with SAVE PNG.
// Privacy: everything happens in this tab; nothing is uploaded. The overlay says so.
import * as THREE from 'three';
import { createSegmenter } from './segmenter.js';
import { detectVictoryPose, pointsFromHero, pointsFromFrame, VICTORY_LABELS } from './victory.js';
import { drawCard, normaliseStats, CARD_W, CARD_H } from './card.js';
import { PALETTES } from './neon.js';

const CSS = `
.blcv-booth { position: fixed; inset: 0; pointer-events: none; z-index: 80; font-family: Inter, system-ui, sans-serif; color: #fff; }
.blcv-booth[hidden] { display: none; }
.blcv-prompt { position: absolute; left: 50%; top: 9%; transform: translateX(-50%); text-align: center; transition: opacity .25s; }
.blcv-prompt b { display: block; white-space: nowrap; font-family: Bangers, Impact, sans-serif; font-weight: 400; font-size: clamp(28px, 4.4vw, 78px); letter-spacing: .04em;
  color: #ffd36b; text-shadow: 0 0 24px rgba(255,160,60,.85), 0 4px 0 #2a0a48; transform: skewX(-8deg); }
.blcv-prompt span { display: inline-block; margin-top: 6px; font-weight: 800; font-size: clamp(13px, 1.25vw, 20px); letter-spacing: .18em; color: #c9f7ff;
  background: rgba(14,6,32,.55); padding: 6px 14px; border-radius: 999px; }
.blcv-hold { position: absolute; left: 50%; top: 50%; width: min(26vh, 240px); height: min(26vh, 240px); transform: translate(-50%, -50%); opacity: 0; transition: opacity .2s; }
.blcv-hold svg { width: 100%; height: 100%; transform: rotate(-90deg); filter: drop-shadow(0 0 12px #ffd36b); }
.blcv-hold i { position: absolute; inset: 0; display: grid; place-items: center; font-style: normal; font-family: Bangers, Impact, sans-serif; font-size: min(4.6vh, 42px);
  color: #fff; text-shadow: 0 0 16px #ff52d9; letter-spacing: .04em; text-align: center; }
.blcv-count { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%) scale(1); font-family: Bangers, Impact, sans-serif; font-size: min(42vh, 380px);
  line-height: 1; color: #fff; text-shadow: 0 0 40px #ffb347, 0 0 90px #ff52d9, 0 8px 0 #2a0a48; opacity: 0; }
.blcv-count.pop { animation: blcv-pop .8s cubic-bezier(.2,.9,.2,1) both; }
@keyframes blcv-pop { 0% { opacity: 0; transform: translate(-50%,-50%) scale(1.8); } 25% { opacity: 1; transform: translate(-50%,-50%) scale(1); } 80% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%,-50%) scale(.85); } }
.blcv-flash { position: absolute; inset: 0; background: #fff; opacity: 0; }
.blcv-flash.go { animation: blcv-flash .7s ease-out both; }
@keyframes blcv-flash { 0% { opacity: 1; } 100% { opacity: 0; } }
.blcv-privacy { position: absolute; left: 50%; bottom: 3.2%; transform: translateX(-50%); font-size: clamp(11px, 1vw, 15px); font-weight: 600; letter-spacing: .06em;
  color: rgba(255,255,255,.88); background: rgba(14,6,32,.6); padding: 7px 14px; border-radius: 999px; white-space: nowrap; }
.blcv-preview { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(8,3,20,.72); pointer-events: auto; opacity: 0; transition: opacity .35s; }
.blcv-preview.show { opacity: 1; }
.blcv-preview .blcv-panel { display: flex; gap: 3vw; align-items: center; }
.blcv-preview img { height: min(78vh, 900px); aspect-ratio: 4 / 5; border-radius: 18px; box-shadow: 0 0 0 3px rgba(255,211,107,.6), 0 0 60px rgba(255,120,200,.45); transform: rotate(-1.5deg); }
.blcv-preview .blcv-side { display: flex; flex-direction: column; gap: 18px; max-width: 320px; }
.blcv-preview .blcv-side p { margin: 0; font-size: 15px; line-height: 1.45; color: rgba(255,255,255,.85); }
.blcv-btn { font: 400 clamp(22px, 2.2vw, 34px) Bangers, Impact, sans-serif; letter-spacing: .06em; color: #1a0538; background: linear-gradient(#fff2b0, #ffb347);
  border: 0; border-radius: 14px; padding: 16px 26px; cursor: pointer; box-shadow: 0 0 26px rgba(255,180,70,.6); }
.blcv-btn.alt { background: rgba(255,255,255,.12); color: #fff; box-shadow: none; border: 1px solid rgba(255,255,255,.3); }
`;

const COUNT_LABELS = ['3', '2', '1'];

/**
 * @param {object} o
 * @param {HTMLVideoElement} o.video
 * @param {THREE.WebGLRenderer} o.renderer
 * @param {THREE.Scene} o.heroScene     the scene that holds the hero + its lights
 * @param {THREE.Camera} o.camera       the game camera (only used for its layers / near-far)
 * @param {() => object} o.getStats     score.results()-like object
 * @param {object} [o.hero]             loadVRMHero() result (pose detection + framing)
 * @param {object} [o.mirror]           createMirror() result: its segmenter is reused (no second model)
 * @param {object} [o.motion]           motion pipeline (actions.state.handsUp as a hint)
 * @param {() => object} [o.getFrame]   latest tracker frame (joints) - optional, the hero is used otherwise
 */
export function createPhotoBooth({ video = null, renderer, heroScene, camera = null, getStats = () => ({}), hero = null, mirror = null, motion = null,
  getFrame = null, holdMs = 1000, countMs = 750, mirrorImage = true, overlayParent = null, showPreview = true, onCountdown = null, onFlash = null } = {}) {
  injectCSS();
  const seg = mirror?.segmenter || createSegmenter({ video, quality: 'medium', hero });
  const ownSeg = !mirror?.segmenter;
  const card = document.createElement('canvas'); card.width = CARD_W; card.height = CARD_H;
  const cctx = card.getContext('2d');
  const listeners = new Set();
  const st = { state: 'idle', held: 0, pose: null, poseLabel: '', count: 0, countT: 0, raf: 0, last: 0, resolve: null, blob: null, dataURL: null, url: null, timeoutAt: 0 };
  const pts = {};

  // ------------------------------------------------------------------------------------------- overlay DOM
  const overlay = document.createElement('div');
  overlay.className = 'blcv-booth'; overlay.hidden = true;
  overlay.innerHTML = `
    <div class="blcv-prompt"><b>STRIKE YOUR VICTORY POSE</b><span>BOTH HANDS UP · V · FLEX</span></div>
    <div class="blcv-hold"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="7"/>
      <circle class="blcv-ring" cx="50" cy="50" r="44" fill="none" stroke="#ffd36b" stroke-width="7" stroke-linecap="round" stroke-dasharray="276.5" stroke-dashoffset="276.5"/></svg><i></i></div>
    <div class="blcv-count"></div>
    <div class="blcv-flash"></div>
    <div class="blcv-privacy">Photo booth runs entirely on this device. Nothing is uploaded or stored.</div>`;
  const $ = (s) => overlay.querySelector(s);
  const el = { prompt: $('.blcv-prompt'), hold: $('.blcv-hold'), ring: $('.blcv-ring'), holdLabel: $('.blcv-hold i'), count: $('.blcv-count'), flash: $('.blcv-flash'), privacy: $('.blcv-privacy') };
  let preview = null;
  (overlayParent || document.body).appendChild(overlay);

  function emit(blob, dataURL) { for (const cb of listeners) { try { cb(blob, dataURL); } catch (e) { console.warn('[cv] onCapture listener threw', e); } } }

  // ------------------------------------------------------------------------------------------- loop
  function tick() {
    st.raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.1, (now - st.last) / 1000); st.last = now;
    if (st.state === 'armed') {
      const P = (getFrame && pointsFromFrame(getFrame())) || pointsFromHero(hero, pts);
      const v = detectVictoryPose(P, { handsUpHint: !!motion?.actions?.state?.handsUp });
      if (v.pose) { st.held += dt * 1000; st.pose = v.pose; } else st.held = Math.max(0, st.held - dt * 2500);
      const k = Math.min(1, st.held / holdMs);
      el.hold.style.opacity = k > 0.02 ? '1' : '0';
      el.ring.style.strokeDashoffset = String(276.5 * (1 - k));
      el.holdLabel.textContent = st.pose && k > 0.02 ? VICTORY_LABELS[st.pose] : '';
      if (k >= 1) startCountdown();
      if (st.timeoutAt && now > st.timeoutAt) startCountdown();   // nobody posed: take it anyway
    } else if (st.state === 'countdown') {
      st.countT += dt * 1000;
      if (st.countT >= countMs) {
        st.countT -= countMs; st.count++;
        if (st.count < COUNT_LABELS.length) showCount();
        else capture();
      }
    }
  }
  function showCount() {
    el.count.textContent = COUNT_LABELS[st.count];
    el.count.classList.remove('pop'); void el.count.offsetWidth; el.count.classList.add('pop');
    try { onCountdown?.(3 - st.count); } catch { /* */ }
  }
  function startCountdown() {
    st.state = 'countdown'; st.count = 0; st.countT = 0;
    st.poseLabel = st.pose ? VICTORY_LABELS[st.pose] : 'VICTORY';
    el.prompt.style.opacity = '0'; el.hold.style.opacity = '0';
    showCount();
  }

  async function capture() {
    st.state = 'capturing';
    el.flash.classList.remove('go'); void el.flash.offsetWidth; el.flash.classList.add('go');
    try { onFlash?.(); } catch { /* */ }
    el.count.textContent = '';
    // 1) hero render (synchronous, same frame as the flash) 2) player cutout (worker, ~1 frame)
    let heroImg = null;
    try { heroImg = renderHero(renderer, heroScene, hero, { mirror: mirrorImage }); } catch (e) { console.warn('[cv] hero render failed', e); }
    let player = await seg.captureHiRes();
    if (player && !player.bbox) { player.image.close?.(); player = null; }   // nobody in the mask: fall back below
    if (!player) { const f = seg.frame && seg.frame.kind === 'seg' && seg.frame.bbox && seg.videoLive() ? seg.frame : seg.skeletonNow(); if (f?.bbox) player = { image: f.image, w: f.w, h: f.h, bbox: f.bbox, kind: f.kind }; }
    let stats = {};
    try { stats = normaliseStats(getStats() || {}); } catch { stats = normaliseStats({}); }
    drawCard(cctx, { player, hero: heroImg, stats, poseLabel: st.poseLabel, palette: PALETTES.overdrive, mirror: mirrorImage, seed: Math.floor(performance.now()) });
    if (player?.owned) player.image.close?.();
    const blob = await new Promise((r) => card.toBlob(r, 'image/png'));
    const dataURL = card.toDataURL('image/png');
    if (st.url) URL.revokeObjectURL(st.url);
    st.blob = blob; st.dataURL = dataURL; st.url = blob ? URL.createObjectURL(blob) : null;
    st.state = 'done';
    cancelAnimationFrame(st.raf); st.raf = 0;
    if (mirror) mirror.hold(false); else if (ownSeg) seg.setActive(false);
    el.privacy.textContent = 'Saved only if you press SAVE. The picture never leaves this device.';
    if (showPreview) openPreview(dataURL);
    emit(blob, dataURL);
    st.resolve?.({ blob, dataURL }); st.resolve = null;
  }

  function openPreview(dataURL) {
    closePreview();
    preview = document.createElement('div');
    preview.className = 'blcv-preview';
    preview.innerHTML = `<div class="blcv-panel"><img alt="Your BREAKLIGHT photo card"/><div class="blcv-side">
      <button class="blcv-btn" type="button" data-ui-button="cv-save">SAVE PNG</button>
      <button class="blcv-btn alt" type="button" data-ui-button="cv-close" data-ui-nopunch>CLOSE</button>
      <p>Your card was made right here in the browser from your camera and the hero. Nothing was uploaded; it is gone when you close the tab unless you save it.</p></div></div>`;
    preview.querySelector('img').src = dataURL;
    preview.querySelector('[data-ui-button="cv-save"]').addEventListener('click', () => api.download());
    preview.querySelector('[data-ui-button="cv-close"]').addEventListener('click', () => api.disarm());
    overlay.appendChild(preview);
    requestAnimationFrame(() => preview?.classList.add('show'));
  }
  function closePreview() { preview?.remove(); preview = null; }

  // ------------------------------------------------------------------------------------------- API
  const api = {
    card, overlay,
    get state() { return st.state; },
    get pose() { return st.pose; },
    get blob() { return st.blob; },
    get dataURL() { return st.dataURL; },
    /** Start watching for a victory pose. Resolves with { blob, dataURL } after the capture. timeoutMs: shoot anyway. */
    arm({ timeoutMs = 0 } = {}) {
      if (st.state === 'armed' || st.state === 'countdown') return st.promise;
      closePreview();
      st.state = 'armed'; st.held = 0; st.pose = null; st.timeoutAt = timeoutMs ? performance.now() + timeoutMs : 0;
      overlay.hidden = false; el.prompt.style.opacity = '1'; el.hold.style.opacity = '0'; el.count.textContent = '';
      el.privacy.textContent = 'Photo booth runs entirely on this device. Nothing is uploaded or stored.';
      if (mirror) mirror.hold(true); else seg.setActive(true);
      st.last = performance.now();
      if (!st.raf) st.raf = requestAnimationFrame(tick);
      st.promise = new Promise((r) => { st.resolve = r; });
      return st.promise;
    },
    /** Skip detection and start the 3-2-1 now (fake victory / keyboard / a UI button). */
    trigger(pose = 'vpose') { if (st.state !== 'armed') api.arm(); st.pose = pose; startCountdown(); return st.promise; },
    /** Hide everything and stop watching. */
    disarm() {
      if (st.state === 'armed' || st.state === 'countdown') { if (mirror) mirror.hold(false); else if (ownSeg) seg.setActive(false); }
      cancelAnimationFrame(st.raf); st.raf = 0;
      st.state = st.blob ? 'done' : 'idle';
      overlay.hidden = true; closePreview();
    },
    /** cb(blob, dataURL) after each capture. Returns an unsubscribe function. */
    onCapture(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    /** Save the last card as a PNG (a local download of a blob: URL made in this tab). */
    download(filename = `breaklight-${new Date().toISOString().slice(0, 10)}.png`) {
      if (!st.url) return false;
      const a = document.createElement('a'); a.href = st.url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      return true;
    },
    dispose() { api.disarm(); overlay.remove(); if (st.url) URL.revokeObjectURL(st.url); if (ownSeg) seg.dispose(); listeners.clear(); },
  };
  return api;
}

// ------------------------------------------------------------------------------------------- hero render
const _box = new THREE.Box3(), _v = new THREE.Vector3(), _c = new THREE.Vector3(), _col = new THREE.Color();
let rtCache = null;

/**
 * Render the hero alone, from the front, into a transparent canvas (sRGB). Uses an offscreen float render target so the
 * game's canvas is untouched. Returns { canvas, bbox: {x, y, w, h} } (px).
 */
export function renderHero(renderer, heroScene, hero, { width = 760, height = 1000, mirror = true } = {}) {
  const b = hero?.bones;
  if (!renderer || !heroScene || !b?.hips) return null;
  _box.makeEmpty();
  for (const k of ['head', 'headTop', 'hips', 'leftHand', 'rightHand', 'leftHandTip', 'rightHandTip', 'leftFoot', 'rightFoot', 'leftForeArm', 'rightForeArm', 'leftUpperArm', 'rightUpperArm', 'leftShin', 'rightShin', 'leftToe', 'rightToe']) {
    if (b[k]) { b[k].getWorldPosition(_v); _box.expandByPoint(_v); }
  }
  const H = hero.info?.height || 1.6;
  _box.max.y += H * 0.04; _box.min.y = Math.min(_box.min.y, 0) - 0.02; _box.expandByVector(_v.set(0.12, 0, 0.12));
  _box.getCenter(_c);
  const size = _box.getSize(_v.set(0, 0, 0));
  const cam = new THREE.PerspectiveCamera(24, width / height, 0.05, 100);
  const fov = THREE.MathUtils.degToRad(cam.fov);
  const dist = Math.max((size.y * 1.08) / (2 * Math.tan(fov / 2)), (size.x * 1.08) / (2 * Math.tan(fov / 2) * cam.aspect)) + size.z;
  cam.position.set(_c.x, _c.y + size.y * 0.05, _c.z + dist);   // hero faces +Z: the camera stands in front of it
  cam.lookAt(_c);
  cam.updateMatrixWorld();

  let type = THREE.FloatType;
  if (!rtCache || rtCache.width !== width || rtCache.height !== height) {
    rtCache?.dispose();
    rtCache = new THREE.WebGLRenderTarget(width, height, { type, samples: 4, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: true });
  }
  const rt = rtCache;
  const prevRT = renderer.getRenderTarget(), prevAlpha = renderer.getClearAlpha(); renderer.getClearColor(_col);
  const prevBg = heroScene.background, prevAuto = renderer.autoClear, prevXR = renderer.xr?.enabled;
  heroScene.background = null;
  // only the hero (+ lights): hide shadow catchers, FX trails/sparks and anything else living in heroScene
  const hidden = [];
  heroScene.traverse((o) => {
    if (o === hero.root) return;
    if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.visible && !isInside(o, hero.root)) { o.visible = false; hidden.push(o); }
  });
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0); renderer.autoClear = true;
  renderer.clear(true, true, true);
  renderer.render(heroScene, cam);
  const buf = new Float32Array(width * height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
  for (const o of hidden) o.visible = true;
  renderer.setRenderTarget(prevRT); renderer.setClearColor(_col, prevAlpha); renderer.autoClear = prevAuto; heroScene.background = prevBg;
  if (renderer.xr) renderer.xr.enabled = prevXR;

  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height), d = img.data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  const enc = (c) => { c = c <= 0 ? 0 : c >= 1 ? 1 : c; return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };
  for (let y = 0; y < height; y++) {
    const sy = height - 1 - y;   // GL rows are bottom-up
    for (let x = 0; x < width; x++) {
      const si = (sy * width + x) * 4, dx = mirror ? width - 1 - x : x, di = (y * width + dx) * 4;
      const a = Math.min(1, Math.max(0, buf[si + 3]));
      if (a < 0.003) { d[di + 3] = 0; continue; }
      const ia = a < 0.999 ? 1 / a : 1;   // MSAA edges resolve against the transparent clear: un-premultiply
      d[di] = enc(buf[si] * ia); d[di + 1] = enc(buf[si + 1] * ia); d[di + 2] = enc(buf[si + 2] * ia); d[di + 3] = a * 255;
      if (a > 0.5) { if (dx < x0) x0 = dx; if (dx > x1) x1 = dx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, bbox: x1 > x0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

function isInside(o, root) { for (let p = o; p; p = p.parent) if (p === root) return true; return false; }

let cssDone = false;
function injectCSS() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const s = document.createElement('style'); s.id = 'blcv-booth-css'; s.textContent = CSS; document.head.appendChild(s);
}
