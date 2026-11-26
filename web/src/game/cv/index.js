// BREAKLIGHT CV: signature computer-vision features (see docs in each file).
//   createMirror      - "Mirror Moment": neon silhouette (calibration pour, Overdrive sky echo, results replay)
//   createPhotoBooth  - "Breaklight Photo Booth": victory pose -> 3-2-1 -> shareable PNG card
// Everything runs locally in the browser (MediaPipe ImageSegmenter in a worker, GPU delegate); nothing is uploaded.
export { createMirror, heroScreenRect } from './mirror.js';
export { createPhotoBooth, renderHero } from './photobooth.js';
export { createSegmenter, SEG_QUALITY } from './segmenter.js';
export { detectVictoryPose, pointsFromHero, pointsFromFrame, VICTORY_LABELS } from './victory.js';
export { PALETTES } from './neon.js';
export { drawCard, normaliseStats, CARD_W, CARD_H } from './card.js';
