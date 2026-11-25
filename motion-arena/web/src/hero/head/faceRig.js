// Face rig: expression table, clean atlas-cell swaps, auto-blink, gaze, mouth-open. Owner: WP3.
//
// The face is three decal layers (eyes, features = mouth/nose/blush, brows) whose shaders read atlas
// cell rects from uniforms. This module owns the state machine and only writes uniforms (no canvas
// redraw, no geometry change per frame), so update() costs a few microseconds.
//
// Expression -> { eyes, mouth, brows, browY (m), blush (0..1) }. QA r2 P2-1: changing expression is a HARD
// atlas-cell swap on every layer (never two cells blended, so no double mouth / eyes). An eye-state change is
// masked by a ~2-frame mid-blink ('half' lid) in-between, like a limited-animation cut. browY and blush still ease
// (they move / tint one shape, no ghosting). Blinks are hard swaps too
// (open -> half -> closed -> half -> open over dims.FACE.blinkDuration), as the spec asks.
// The shaders keep their A/B + mix uniforms (contract with head.js); the rig always writes A = B, mix = 1.

import * as THREE from 'three';
import { EXPRESSIONS, DEFAULT_EXPRESSION } from '../contracts.js';

/** Eye in-between ('half' lid) shown when the eye state changes: 2 frames at 60 fps (1 at 30 fps), at least one rendered frame. */
const EYE_SWAP_T = 0.03;

/** Final face table (spec 2.4; contracts.EXPRESSION_HINTS refined). */
export const FACE_TABLE = Object.freeze({
  happy: { eyes: 'open', mouth: 'grin', brows: 'relaxed', browY: 0.001, blush: 0.55 },
  neutral: { eyes: 'open', mouth: 'neutral', brows: 'relaxed', browY: 0.0, blush: 0 },
  laugh: { eyes: 'happyClosed', mouth: 'laugh', brows: 'raised', browY: 0.003, blush: 1 },
  surprised: { eyes: 'surprised', mouth: 'surprised', brows: 'raised', browY: 0.012, blush: 0 },
  determined: { eyes: 'determined', mouth: 'determined', brows: 'angry', browY: -0.002, blush: 0 },
  effort: { eyes: 'determined', mouth: 'effort', brows: 'effort', browY: -0.002, blush: 0 },
  shout: { eyes: 'determined', mouth: 'shout', brows: 'angry', browY: 0.0, blush: 0 },
  wince: { eyes: 'wince', mouth: 'determined', brows: 'worried', browY: 0.001, blush: 0 },
});
/** Eye states that never blink (already closed). */
const NO_BLINK = new Set(['happyClosed', 'closed', 'wince']);
/** Bigger-mouth variant used when setMouthOpen() pushes an already-open mouth. */
const OPEN_MORE = { grin: 'laugh', laugh: 'laugh', surprised: 'shout', effort: 'shout', shout: 'shout' };

/** One swapped layer: always shows exactly one cell (a === b, mix 1). */
class Swap {
  constructor(cell) { this.a = cell; this.b = cell; }
  set(cell) { this.a = this.b = cell; }
  get mix() { return 1; }
}

/**
 * @param {object} o
 * @param {object} o.atlas    createFaceAtlas() result (cells)
 * @param {object} o.uniforms { eye, feat, brow } uniform objects of the three decal materials
 * @param {object} o.dims
 * @param {string} [o.expression]
 * @param {THREE.Bone} o.headBone
 * @param {THREE.Vector3} o.eyeCentre  head-local midpoint between the eyes
 * @param {{ value: THREE.Vector3 }} [o.headLight]  WP1 face uniform uHeadLight (key dir, head space): picks the nose-wedge side
 */
export function createFaceRig({ atlas, uniforms, dims, expression, headBone, eyeCentre, headLight = null, view = null, margins = null, eyeAnchors = null, mouthAnchor = null, mouthView = null, browFade = null }) {
  const { FACE } = dims;
  const cells = atlas.cells;
  const U = uniforms;
  const quadEye = atlas.quads.eye, quadBrow = atlas.quads.brow;

  let expr = FACE_TABLE[expression] ? expression : DEFAULT_EXPRESSION;
  let override = null; // QA: setFace({ eyes, mouth, brows })
  const look = () => ({ ...FACE_TABLE[expr], ...(override || {}) });

  const eyes = new Swap(look().eyes), mouth = new Swap(look().mouth), brows = new Swap(look().brows);
  let eyeBase = look().eyes, eyeSwapT = 0;
  let browY = look().browY, blush = look().blush;
  let blinkIn = 0, mouthIn = 0;
  const rand = mulberry(0x5eed);
  const nextBlink = () => FACE.autoBlinkInterval[0] + rand() * (FACE.autoBlinkInterval[1] - FACE.autoBlinkInterval[0]);
  let autoT = nextBlink(), blinkPhase = -1, autoBlink = true;
  const gaze = new THREE.Vector2(), gazeTarget = new THREE.Vector2();
  let manualGaze = false, autoGaze = true;
  // gaze range in metres on the face -> quad uv
  const GAZE_X = 0.0075, GAZE_Y = 0.0042;
  const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _r = new THREE.Vector3();

  function eyeCellFor(state) { return cells.eye[state] || cells.eye.open; }
  function mouthTarget() {
    const base = look().mouth;
    if (mouthIn < 0.08) return base;
    if (OPEN_MORE[base]) return mouthIn > 0.6 ? OPEN_MORE[base] : base;
    return mouthIn < 0.38 ? 'talk1' : mouthIn < 0.72 ? 'talk2' : 'talk3';
  }

  function blinkCell(base, phase /* 0..1 */) {
    // open -> half -> closed -> half -> open
    const k = Math.abs(phase * 2 - 1); // 1 -> 0 -> 1
    if (k > 0.7) return base;
    if (k > 0.3) return 'half';
    return 'closed';
  }

  function applyUniforms() {
    const e = U.eye, f = U.feat, b = U.brow;
    // eyes
    e.uCellA.value.fromArray(eyeCellFor(eyes.a)); e.uCellB.value.fromArray(eyeCellFor(eyes.b)); e.uMix.value = eyes.mix;
    const sur = eyes.b === 'surprised';
    e.uIris.value.fromArray(sur ? cells.irisSurprised : cells.iris);
    e.uHi.value.fromArray(sur ? cells.highlightSurprised : cells.highlight);
    e.uGaze.value.set((gaze.x * GAZE_X) / quadEye[0], (gaze.y * GAZE_Y) / quadEye[1]);
    // mouth
    f.uMouthA.value.fromArray(cells.mouth[mouth.a]); f.uMouthB.value.fromArray(cells.mouth[mouth.b]); f.uMouthMix.value = mouth.mix;
    f.uBlushAlpha.value = blush;
    // brows
    b.uCellA.value.fromArray(cells.brow[brows.a]); b.uCellB.value.fromArray(cells.brow[brows.b]); b.uMix.value = brows.mix;
    b.uOffset.value.set(0, browY / quadBrow[1]);
  }

  function setTargets() {
    const L = look();
    eyes.set(L.eyes); brows.set(L.brows); mouth.set(mouthTarget());
    eyeBase = L.eyes; eyeSwapT = 0;
  }

  function update(dt, ctx) {
    const L = look();
    // ---- eye-state change: hard swap behind a ~2-frame mid-blink (no cross-dissolve, QA r2 P2-1)
    if (L.eyes !== eyeBase) {
      if (!(NO_BLINK.has(L.eyes) && NO_BLINK.has(eyeBase))) eyeSwapT = EYE_SWAP_T;
      eyeBase = L.eyes;
    }
    let eyeState = L.eyes;
    if (eyeSwapT > 0) { eyeState = 'half'; eyeSwapT -= dt; }
    // ---- blink (auto + manual), as hard atlas swaps
    const canBlink = !NO_BLINK.has(L.eyes);
    if (blinkPhase >= 0) {
      blinkPhase += dt / FACE.blinkDuration;
      if (blinkPhase >= 1) { blinkPhase = -1; autoT = nextBlink(); }
    } else if (autoBlink && canBlink && (autoT -= dt) <= 0) blinkPhase = 0;
    if (canBlink && blinkPhase >= 0) eyeState = blinkCell(L.eyes, blinkPhase);
    if (canBlink && blinkIn > 0.25) eyeState = blinkIn > 0.75 ? 'closed' : 'half';
    eyes.set(eyeState);
    brows.set(L.brows);
    mouth.set(mouthTarget());
    const a = 1 - Math.exp(-dt * 16);
    browY += (L.browY - browY) * a;
    blush += (L.blush - blush) * (1 - Math.exp(-dt * 8));

    // ---- gaze: manual, else follow the camera (P1), smoothed
    if (!manualGaze && autoGaze && ctx?.camera && headBone) {
      _m.copy(headBone.matrixWorld).invert();
      _v.setFromMatrixPosition(ctx.camera.matrixWorld).applyMatrix4(_m).sub(eyeCentre);
      if (_v.z > 0.05) gazeTarget.set(clamp(Math.atan2(_v.x, _v.z) / 0.55), clamp(Math.atan2(_v.y, _v.z) / 0.45));
      else gazeTarget.set(0, 0);
    } else if (!manualGaze) gazeTarget.set(0, 0);
    gaze.lerp(gazeTarget, 1 - Math.exp(-dt * 12));

    // ---- painted nose wedge sits on the shaded side: key light is camera-locked, left of camera (WP1)
    if (headLight && headLight.value.lengthSq() > 0) {
      U.feat.uNoseFlip.value = headLight.value.x > 0.02 ? 1 : 0; // WP1 key dir in head space
    } else if (ctx?.camera && headBone) {
      _m.copy(headBone.matrixWorld).invert();
      _v.setFromMatrixPosition(ctx.camera.matrixWorld).applyMatrix4(_m).sub(eyeCentre);
      _r.setFromMatrixColumn(ctx.camera.matrixWorld, 0).transformDirection(_m);
      const kl = dims.SHADING.keyLight.leftOfCameraDeg * (Math.PI / 180);
      const lx = _v.x / (_v.length() || 1) - _r.x * Math.tan(kl);
      U.feat.uNoseFlip.value = lx > 0 ? 1 : 0; // light from +X -> wedge on -X (mirrored cell)
    }
    updateView(ctx);
    applyUniforms();
  }

  // ---- per-view anime cheat for eyes + brows (QA r1 P0-8 / P1-1). For each eye, f = horizontal cosine between
  // the eye's surface normal and the direction to the camera. The painted eye then covers 1/k more surface
  // (k = f^VIEW.pow, >= kMin) so its projected width falls off as f^(1-pow) instead of f (70 deg: 65 % instead of
  // 34 %), and slides toward the camera side by (1-f)*VIEW.shift of the patch so in profile it sits on the visible
  // side plane. Stays exactly 1 / 0 for a frontal view.
  const VIEW = { pow: 0.6, kMin: 0.55, shift: 0.14, mouthShift: 0.2 };
  // QA r3 P2-4: far-side brow fade by head-relative camera yaw (degrees). The brow layer is pulled toward the
  // camera so it reads over the bangs; past ~60 deg that pull let the far brow float over the hair edge beyond the
  // cheek / temple silhouette. The far eye is clipped by depth there; the far brow now fades out 60 -> 72 deg.
  const BROW_FAR_FADE = [60, 72];
  const _c = new THREE.Vector3(), _d = new THREE.Vector3();
  function updateView(ctx) {
    if (!view || !eyeAnchors || !ctx?.camera || !headBone) return;
    const cam = ctx.camera;
    _m.copy(headBone.matrixWorld).invert();
    const ortho = !!cam.isOrthographicCamera;
    if (ortho) _c.set(0, 0, 1).transformDirection(cam.matrixWorld).transformDirection(_m);
    else _c.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_m);
    const M = Math.min(margins?.eye ?? 2, margins?.brow ?? 2);
    const one = (a) => {
      if (ortho) _d.copy(_c); else _d.copy(_c).sub(a.centre);
      const len = Math.hypot(_d.x, _d.z) || 1;
      const f = Math.max(0, Math.min(1, (_d.x * a.normal.x + _d.z * a.normal.z) / len));
      const k = Math.max(VIEW.kMin, Math.pow(Math.max(f, 1e-3), VIEW.pow));
      const lim = Math.max(0, 0.5 - 1 / (2 * M * k));
      const side = Math.sign(a.normal.z * _d.x - a.normal.x * _d.z);
      return [k, Math.max(-lim, Math.min(lim, side * (1 - f) * VIEW.shift))];
    };
    const [kl, sl] = one(eyeAnchors.left), [kr, sr] = one(eyeAnchors.right);
    view.set(kl, sl, kr, sr);
    if (browFade) {
      if (ortho) _d.copy(_c); else _d.copy(_c).sub(eyeCentre);
      const yaw = Math.atan2(Math.abs(_d.x), _d.z) * (180 / Math.PI);
      const t = Math.min(1, Math.max(0, (yaw - BROW_FAR_FADE[0]) / (BROW_FAR_FADE[1] - BROW_FAR_FADE[0])));
      const far = 1 - t * t * (3 - 2 * t);
      // camera on the -X side -> the LEFT (+X) brow is the far one
      browFade.set(_d.x < 0 ? far : 1, _d.x < 0 ? 1 : far);
    }
    if (mouthAnchor && mouthView) {
      const a = mouthAnchor;
      if (ortho) _d.copy(_c); else _d.copy(_c).sub(a.centre);
      const len = Math.hypot(_d.x, _d.z) || 1;
      const f = Math.max(0, Math.min(1, (_d.x * a.normal.x + _d.z * a.normal.z) / len));
      const lim = 0.5 - 0.5 / mouthView.y;
      const side = Math.sign(a.normal.z * _d.x - a.normal.x * _d.z);
      mouthView.x = Math.max(-lim, Math.min(lim, side * (1 - f) * VIEW.mouthShift));
    }
  }

  setTargets();
  applyUniforms();

  const api = {
    expressions: EXPRESSIONS.slice(),
    setExpression(name) { if (FACE_TABLE[name]) { expr = name; override = null; } return expr; },
    getExpression: () => expr,
    /** amount 0..1 (0.25..0.75 = half lid, > 0.75 closed). */
    blink(amount = 1) { blinkIn = clamp01(+amount || 0); },
    /** Fire one full blink now (0.16 s). */
    blinkOnce() { blinkPhase = 0; },
    setMouthOpen(amount = 0) { mouthIn = clamp01(+amount || 0); },
    /** x, y in [-1, 1]: +x = character's left, +y = up. Pass null to return to auto gaze. */
    setGaze(x = 0, y = 0) {
      if (x === null) { manualGaze = false; return; }
      manualGaze = true;
      gazeTarget.set(clamp(+x || 0), clamp(+y || 0));
    },
    setAutoGaze(on = true) { autoGaze = !!on; if (on) manualGaze = false; },
    setAutoBlink(on = true) { autoBlink = !!on; },
    /** QA: force atlas states, e.g. setFace({ eyes: 'half', mouth: 'shout', brows: 'worried' }); null clears. */
    setFace(o) { override = o ? { ...o } : null; },
    states: { eyes: Object.keys(cells.eye), mouths: Object.keys(cells.mouth), brows: Object.keys(cells.brow) },
    table: FACE_TABLE,
  };
  return { api, update };
}

function clamp(v) { return Math.max(-1, Math.min(1, v)); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
