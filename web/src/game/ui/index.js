// BREAKLIGHT UI: hand cursor (CV menu control), screens and HUD. Contract: docs/game/CONTRACTS.md (UI).
//
//   const ui = createUI(ctx);           // appends ui.root to document.body (or ctx.uiParent)
//   per frame: ui.update(dt)            // cursor + current screen + HUD (call after motion.update)
//
// Additions beyond the contract (all optional):
//   - every screens.*() call returns a handle: { node, ...extras } (boot: setStatus(text, kind), setAvailable(map);
//     calibrate: progress, finish(); tutorial: drill, reps, skip(); results: rank)
//   - screens.boot({ onTracker, current, available, status }), screens.settings({ settings, onClose, onChange }),
//     screens.pause({ reason, onResume?, onQuit? }), screens.tutorial({ steps?, onDone(result), onSkip? })
//   - hud.judgement(pos, kind, { errMs }) shows the timing error in ms; pos in px or normalized (≤ 1.5)
//   - hud.pip.setSkeleton(kp2d, edges, { selfie }); without calls the PiP reads ctx.motion.lastFrame itself
//   - ui.measureDistance(frame?) → 'too-close'|'too-far'|'off-left'|'off-right'|null (feeds hud.distance)
//   - cursor.enable('auto') (default): on whenever a [data-ui-button] is visible; cursor.setMode('body'|'project')
//   - ui.dispose()
import '../game.css';
import { createCursor } from './cursor.js';
import { createHUD } from './hud.js';
import { createScreenHost, bootScreen, titleScreen, settingsScreen, pauseScreen, countdownOverlay, resultsScreen } from './screens.js';
import { calibrateScreen } from './calibrate.js';
import { tutorialScreen } from './tutorial.js';
import { h, freshFrame, measureDistance } from './body.js';

const FONTS = 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=Dela+Gothic+One&display=swap';

function ensureFonts() {
  if (document.querySelector('link[data-bl-fonts]')) return;
  const pre = h('link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' });
  const l = h('link', { rel: 'stylesheet', href: FONTS, 'data-bl-fonts': '' });
  document.head.append(pre, l);
}

export function createUI(ctx) {
  ensureFonts();
  const root = h('div', { class: 'bl-ui' });
  (ctx.uiParent || document.body).append(root);

  const shared = { videoAspect: 16 / 9 };
  const host = createScreenHost(root);
  const hud = createHUD(ctx, root);
  const cursor = createCursor(ctx, root);   // last: above screens + HUD

  // PiP video also tells calibration the camera aspect
  const setVideo = hud.pip.setVideo;
  hud.pip.setVideo = (v) => {
    setVideo(v);
    const upd = () => { if (v?.videoWidth) shared.videoAspect = v.videoWidth / v.videoHeight; };
    upd(); v?.addEventListener?.('loadedmetadata', upd, { once: true });
  };

  const show = (name, scr) => { root.dataset.screen = name || ''; return host.show(name, scr); };

  const screens = {
    boot: (o = {}) => show('boot', bootScreen(ctx, o)),
    calibrate: (o = {}) => show('calibrate', calibrateScreen(ctx, shared, o)),
    title: (o = {}) => show('title', titleScreen(ctx, o)),
    tutorial: (o = {}) => show('tutorial', tutorialScreen(ctx, o)),
    settings: (o = {}) => show('settings', settingsScreen(ctx, { settings: o.settings || ctx.settings || {}, ...o })),
    pause: (o = {}) => show('pause', pauseScreen(ctx, o)),
    countdown: (n) => countdownOverlay(host.overlay, n),
    results: (o = {}) => show('results', resultsScreen(ctx, o)),
    hide: () => show(null, null),
    get current() { return host.name; },
  };

  let disposed = false;
  function update(dt = 1 / 60) {
    if (disposed) return;
    host.update(dt);
    hud.update(dt);
    cursor.update(dt);
  }

  return {
    root, cursor, screens, hud, update,
    measureDistance: (frame) => measureDistance(frame ?? freshFrame(ctx.motion), { upperBodyOnly: !!ctx.settings?.upperBodyOnly }),
    dispose() { disposed = true; host.show(null, null); cursor.dispose(); root.remove(); },
  };
}
