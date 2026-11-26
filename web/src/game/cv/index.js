// BREAKLIGHT CV: signature computer-vision features (see docs in each file).
//   createMirror      - "Mirror Moment": hologram silhouette (calibration pour, Overdrive sky echo, results replay)
//   createPhotoBooth  - "Breaklight Photo Booth": victory pose -> 3-2-1 -> shareable PNG card
// Everything runs locally in the browser (MediaPipe ImageSegmenter in a worker, GPU delegate); nothing is uploaded.
//
// Fix round 2 additions (all backward compatible):
//   mirror.setEchoPreset(name, { keepOut?, overrides? })  name: 'run' | 'boss' | 'title' | 'results'. Call it whenever the
//       game state changes (before or while echo mode is on). The echo is re-placed ~5x/s from the live camera so it
//       always fits inside the frame and never overlaps the Warden ('EclipseWarden'), the rift ('rift') or the hero
//       (found automatically); 'boss' stands it beside the Warden, or far behind it at 35% opacity when nothing beside
//       it is clear. keepOut: extra Object3D | THREE.Sphere | THREE.Box3 | Vector3 | {center, radius} (or an array).
//       Default preset at boot: 'run'. mirror.echo.setPlacement({ position, height }) still works (legacy world spot).
//   mirror.setEchoKeepOut(list | null), mirror.echoPlacement (last solve: { preset, rect, overlap, behind, keepOut[] }),
//   mirror.echoPresets (names), mirror.echo.measure(camera) (projected screen rect of the echo right now).
//   mirror.pourInto(screenRect, { duration = 1500, flash = true, from?, onArrive? }): borderless particle stream from the
//       on-screen silhouette (this.canvas if laid out, else the UI's '.bl-sil-live' canvas, else `from`) into the hero's
//       body (bones re-projected every frame), ending in a flash on the hero. Same call as before.
//   booth.busy (armed / counting / capturing / preview open), booth.setBlocked(on) (hide + pause the booth, e.g. while
//       a replay plays; resumes where it was), booth.blocked, booth.setReduceFlash(on).
//   window.__blcv = { mirror, booth } (console / automation handle).
export { createMirror, heroScreenRect } from './mirror.js';
export { createPhotoBooth, renderHero } from './photobooth.js';
export { createSegmenter, SEG_QUALITY } from './segmenter.js';
export { detectVictoryPose, pointsFromHero, pointsFromFrame, VICTORY_LABELS } from './victory.js';
export { PALETTES } from './neon.js';
export { ECHO_PRESETS } from './echo.js';
export { drawCard, normaliseStats, CARD_W, CARD_H } from './card.js';
