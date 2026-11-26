// BREAKLIGHT UI: hand cursor (CV menu control), screens and HUD. Contract: docs/game/CONTRACTS.md (UI).
//
//   const ui = createUI(ctx);           // appends ui.root to document.body (or ctx.uiParent)
//   per frame: ui.update(dt)            // cursor + current screen + HUD (call after motion.update)
//
// Additions beyond the contract (all optional, additive):
//   - every screens.*() call returns a handle: { node, ...extras } (boot: setStatus(text, kind), setAvailable(map);
//     calibrate: progress, finish(), setSilhouetteCanvas(c, { mirrored }); tutorial: drill, reps, charge, skip();
//     results: rank, phase, showStats(), setPhotoCard(pc); clearSpace: finish())
//   - screens.boot({ onTracker, current, available, status }), screens.settings({ settings, onClose, onChange }),
//     screens.pause({ reason, onResume?, onQuit? }), screens.tutorial({ steps?, onDone(result), onSkip? })
//   - screens.title({ onPlay, onTutorial, onSettings, mode?, onMode?(mode), best?, tutorialLabel? }): Showcase / Challenge
//     toggle (writes settings.mode, emits bus 'settings:change')
//   - screens.calibrate({ onDone, recalibrate, silhouetteCanvas?, silhouetteMirrored = true, seated? }): live camera
//     silhouette slot for the CV team (fitted into the guide by the tracked keypoints)
//   - screens.clearSpace({ onDone({ skipped, auto }), seated?, autoContinue = true, holdS = 2.5 }): 2 m x 2 m safety check
//   - screens.results({ stats, onReplay, onAgain, onTitle, onSkipReplay?, photoCard? }): letterboxed replay first
//     (bus 'replay' { on } or { type: 'start'|'progress'|'end', progress, label, speed, hits }, or ctx.game.replay),
//     then the panels; stats.newBest / best / prevBest / mode / body.timingSdMs / body.moveCounts
//   - settings rows: mode ('showcase'|'challenge'), seated (bool); volume accepts { master, music, sfx }
//   - hud: lanes (top = banners / warnings, low = prompts next to the hero), priorities warning > prompt > info
//       hud.banner(text, sub?, { priority: 'info'|'warning', duration })
//       hud.prompt(text|null, { move, wait, sub, kicker, tone, success }) - wait: Act 0 "do the move to continue" style
//       hud.message(id, { lane: 'top'|'low', text, sub, priority, ttl, move, wait } | null)
//       hud.distance(state) is gated (persist 0.8 s, quiet during big moves, off for demo/autoplay trackers)
//       hud.judgement(pos, kind, { errMs }) clamps into a safe area off the hero; ms only with ?debug=1, else EARLY/LATE
//       hud.setMode('showcase'|'challenge'|null), hud.placeJudgement(x, y), hud.heroBounds()
//   - hud.pip.setSkeleton(kp2d, edges, { selfie }); without calls the PiP reads ctx.motion.lastFrame itself
//   - ui.measureDistance(frame?) → 'too-close'|'too-far'|'off-left'|'off-right'|null (feeds hud.distance)
//   - cursor.enable('auto') (default): on whenever a [data-ui-button] is visible; cursor.setMode('body'|'project')
//   - ui.replayOverlay = true: results() owns the replay letterbox and the mirror PiP (ctx.mirror.canvas, "YOU · 0.35×")
//   - ui.dispose()
//
// Round 2 additions (all additive; CORE may call them or just emit the bus events the UI already listens to):
//   - hud prompt plate sits BESIDE the hero (opposite the threat side: left punch / left kick / lean right -> plate on the
//     right), or above the head, clamped to the safe area, never on the hero's projected bounds. prompt opts.side
//     ('left'|'right') overrides the threat side derived from opts.move. hud.placePrompt(w, h, threat) is the placer.
//     hud.state.lowSide ('left'|'right'|'above') / hud.state.lowClean (true = no overlap with the hero) for QA.
//   - bus 'awaken' (UI listens): { phase: 'start' } shows the hand-cursor SKIP INTRO (right edge, dwell 1.6 s, calls
//     ctx.game.skipAwaken(), else emits bus 'awaken:skip'); while it is shown, CORE's mouse-only .bl-awaken-skip is
//     hidden by CSS (ui.root[data-awaken-ui]). { phase: 'wait', note } starts the wait clock; the skip button turns
//     into a hand target after 5 s of waiting. { phase: 'coach', move, hint } -> coaching chip under the prompt
//     (animated glyph + hint; if no 'coach' arrives by 5.5 s the UI shows a generic per-move hint itself).
//     { phase: 'loose', move, hint?, text? } -> "ALMOST! ANY PUNCH WORKS" (per-move text, or text). { phase: 'auto' }
//     -> "LET'S KEEP GOING!" for 1.6 s. { phase: 'resolved' } or the waiting note's .resolved or
//     hud.prompt(null, { success }) clear the chip; { phase: 'end' } removes chip + button.
//     Direct calls: hud.coach({ stage: 'coach'|'loose'|'auto', move, hint, text } | null), hud.awakenSkip(on, { hand })
//   - bus 'knockdown' { health, max?, count } (UI listens) / hud.knockdown(d): red vignette, "GET BACK UP!" in the top
//     lane (priority 2.5: above boss banners, below the distance warning), shake, staggered heart refill to d.health.
//   - settings.reduceFlashes (bool): the UI drops its own flashing (warning banner strobe, Overdrive edge pulse, glyph
//     glow strobe, knockdown shake) via .bl-ui.bl-reduce-flash; CORE / VISUAL / CV read the same flag for bloom & flashes.
//   - screens.flashNotice({ onDone({ reduceFlashes }), onReduce?(on), reduce? }): photosensitivity notice (first boot).
//     "OK, LET'S GO" (hand dwell 1.2 s / click / Enter) and a "REDUCE FLASHES" on/off toggle that writes
//     settings.reduceFlashes and emits bus 'settings:change' { key: 'reduceFlashes' }. Handle: { node, reduce, finish() }.
//   - screens.title(o) extras: o.onNewPlayer? (default ctx.game.newPlayer?.()) -> NEW PLAYER button (hand dwell 1.2 s,
//     no punch-select); o.kiosk? (default settings.dev.kiosk || ctx.game.kiosk || ?kiosk=1) -> "KIOSK" badge.
//   - screens.clearSpace(o): big diagram, 3 short bullets, auto-continue after holdS (default 4 s) framed well.
//   - results: setPhotoCard() never prints "null"; while the stats show, the CV Photo Booth overlay is laid out around the
//     panels (headline in the centre gap on a dark plate, countdown + hold ring beside the hero, privacy line above the
//     buttons) through html.bl-booth-results + CSS vars (--bl-booth-cx/-w/-toast-b/-count-x/-count-y) in game.css.
//   - settings rows: reduceFlashes (Off/On).
//   - body.measureDistance boxes only head / shoulders / hips / ankles (wide hooks or T-poses no longer flag off-frame).
import '../game.css';
import { createCursor } from './cursor.js';
import { createHUD } from './hud.js';
import { createScreenHost, bootScreen, titleScreen, settingsScreen, clearSpaceScreen, pauseScreen, countdownOverlay, resultsScreen, flashNoticeScreen } from './screens.js';
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
  shared.heroBounds = hud.heroBounds;

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
    flashNotice: (o = {}) => show('flashNotice', flashNoticeScreen(ctx, o)),
    calibrate: (o = {}) => show('calibrate', calibrateScreen(ctx, shared, o)),
    clearSpace: (o = {}) => show('clearSpace', clearSpaceScreen(ctx, o)),
    title: (o = {}) => show('title', titleScreen(ctx, o)),
    tutorial: (o = {}) => show('tutorial', tutorialScreen(ctx, o)),
    settings: (o = {}) => show('settings', settingsScreen(ctx, { settings: o.settings || ctx.settings || {}, ...o })),
    pause: (o = {}) => show('pause', pauseScreen(ctx, o)),
    countdown: (n) => countdownOverlay(host.overlay, n),
    results: (o = {}) => show('results', resultsScreen(ctx, o, shared)),
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
    // the results screen draws its own letterbox + "YOU · 0.35×" mirror picture-in-picture from the bus 'replay'
    // events, so CORE's fallback letterbox / mirror inset (core/space.js) stand down
    replayOverlay: true,
    measureDistance: (frame) => measureDistance(frame ?? freshFrame(ctx.motion), { upperBodyOnly: !!ctx.settings?.upperBodyOnly || !!ctx.settings?.seated }),
    dispose() { disposed = true; host.show(null, null); hud.dispose?.(); cursor.dispose(); root.remove(); },
  };
}
