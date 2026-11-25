// Shared API vocabulary for the hero packages. Owner: WP0. Change only via a note to WP0.

/** Expression names hero.setExpression() accepts. The head api MUST accept all of them. */
export const EXPRESSIONS = ['happy', 'neutral', 'laugh', 'surprised', 'determined', 'effort', 'shout', 'wince'];
export const DEFAULT_EXPRESSION = 'happy';

/** Suggested mapping (WP3 owns the final face table): expression -> { eyes, mouth, brows } from spec 2.4. */
export const EXPRESSION_HINTS = Object.freeze({
  happy: { eyes: 'open', mouth: 'smile' },          // default idle: always half-grinning
  neutral: { eyes: 'open', mouth: 'neutral' },
  laugh: { eyes: 'happyClosed', mouth: 'laugh', blush: true },
  surprised: { eyes: 'surprised', mouth: 'surprised' },
  determined: { eyes: 'determined', mouth: 'determined' },
  effort: { eyes: 'determined', mouth: 'effort' },
  shout: { eyes: 'determined', mouth: 'shout' },
  wince: { eyes: 'wince', mouth: 'effort' },
});

/** Hand poses hero.setHandPose() accepts; side = 'left' | 'right' | 'both'. */
export const HAND_POSES = ['relaxed', 'fist'];

/**
 * hero.setAction(name) presets. `hold` (s): impulse actions revert to the default expression/hands
 * after hold; without hold the preset persists until the next setAction. Names match actions.js.
 */
export const ACTION_PRESETS = Object.freeze({
  idle: { expression: 'happy', hands: 'relaxed' },
  jump: { expression: 'laugh', hold: 0.8 },
  squat: { expression: 'effort' },
  punchLeft: { expression: 'determined', hand: ['fist', 'left'], hold: 0.6 },
  punchRight: { expression: 'determined', hand: ['fist', 'right'], hold: 0.6 },
  kickLeft: { expression: 'determined', hold: 0.7 },
  kickRight: { expression: 'determined', hold: 0.7 },
  handsUp: { expression: 'happy' },
  leftHandUp: { expression: 'happy' },
  rightHandUp: { expression: 'happy' },
  tPose: { expression: 'happy' },
  leanLeft: { expression: 'neutral' },
  leanRight: { expression: 'neutral' },
  stepLeft: { expression: 'happy' },
  stepRight: { expression: 'happy' },
  success: { expression: 'laugh', hold: 1.2 },
  miss: { expression: 'surprised', hold: 1.0 },
  combo: { expression: 'shout', hold: 1.0 },
});
