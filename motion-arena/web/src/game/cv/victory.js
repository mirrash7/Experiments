// BREAKLIGHT CV: victory-pose detection for the photo booth. Works on named 3D points (y up, metres) from either the
// tracker frame's joints or (default, tracker-agnostic) the hero's bones, which already mirror the player's pose.
// Poses: 'handsUp' (both hands straight up), 'vpose' (arms up and wide), 'flex' (double-biceps: elbows out at
// shoulder height, fists up). Also accepts motion.actions.state.handsUp as a hint.
import * as THREE from 'three';

export const VICTORY_LABELS = { handsUp: 'BOTH HANDS UP!', vpose: 'V FOR VICTORY!', flex: 'FLEX!' };

const HERO_MAP = { head: 'head', leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm', leftElbow: 'leftForeArm', rightElbow: 'rightForeArm', leftWrist: 'leftHand', rightWrist: 'rightHand' };

/** Named points from the hero's bones (world space; hero.bones uses the legacy rig names). `out` is reused. */
export function pointsFromHero(hero, out = {}) {
  const b = hero?.bones;
  if (!b?.hips) return null;
  for (const [k, bone] of Object.entries(HERO_MAP)) { if (!b[bone]) return null; (out[k] ||= new THREE.Vector3()); b[bone].getWorldPosition(out[k]); }
  return out;
}

/** Named points from a tracker frame's joints (three space). Requires the arm joints. */
export function pointsFromFrame(f) {
  const j = f?.joints;
  if (!j || !j.leftWrist || !j.rightWrist || !j.leftShoulder || !j.rightShoulder || !j.leftElbow || !j.rightElbow) return null;
  const head = j.head || j.nose || (j.neck ? j.neck.clone().setY(j.neck.y + 0.22) : null);
  return { head, leftShoulder: j.leftShoulder, rightShoulder: j.rightShoulder, leftElbow: j.leftElbow, rightElbow: j.rightElbow, leftWrist: j.leftWrist, rightWrist: j.rightWrist };
}

const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const d3 = (a, b) => a.distanceTo(b);

/** Classify a victory pose. Returns { pose, score 0..1 } (pose null when none). */
export function detectVictoryPose(P, { handsUpHint = false } = {}) {
  if (!P) return { pose: null, score: 0 };
  const sw = Math.max(0.2, d3(P.leftShoulder, P.rightShoulder));
  const shY = (P.leftShoulder.y + P.rightShoulder.y) / 2;
  const midX = (P.leftShoulder.x + P.rightShoulder.x) / 2, midZ = (P.leftShoulder.z + P.rightShoulder.z) / 2;
  const headY = P.head ? P.head.y : shY + 0.6 * sw;
  const side = (s) => {
    const S = P[s + 'Shoulder'], E = P[s + 'Elbow'], W = P[s + 'Wrist'];
    const straight = d3(S, W) / Math.max(1e-3, d3(S, E) + d3(E, W));   // 1 = fully extended
    return { S, E, W, straight, wUp: W.y - shY, eUp: E.y - shY, eOut: Math.hypot(E.x - midX, E.z - midZ), wOverE: W.y - E.y };
  };
  const L = side('left'), R = side('right');
  const spread = hd(P.leftWrist, P.rightWrist);
  const res = [];
  // both hands straight up (over the head, not too wide)
  {
    const up = Math.min(L.W.y, R.W.y) - headY;
    const s = clamp01((up + 0.05 * sw) / (0.35 * sw)) * clamp01((2.6 * sw - spread) / (0.8 * sw)) * clamp01((Math.min(L.straight, R.straight) - 0.7) / 0.15);
    res.push(['handsUp', handsUpHint ? Math.max(s, 0.75) : s]);
  }
  // V: arms up and wide, fairly straight
  {
    const up = Math.min(L.wUp, R.wUp);
    const s = clamp01((up - 0.35 * sw) / (0.4 * sw)) * clamp01((spread - 2.2 * sw) / (0.6 * sw)) * clamp01((Math.min(L.straight, R.straight) - 0.75) / 0.12);
    res.push(['vpose', s]);
  }
  // flex: elbows near shoulder height and out to the sides, forearms up (fists above elbows, near head height)
  {
    const elbowLevel = clamp01(1 - Math.max(Math.abs(L.eUp), Math.abs(R.eUp)) / (0.55 * sw));
    const elbowOut = clamp01((Math.min(L.eOut, R.eOut) - 0.75 * sw) / (0.35 * sw));
    const fistsUp = clamp01((Math.min(L.wOverE, R.wOverE) - 0.25 * sw) / (0.3 * sw));
    const bent = clamp01((0.85 - Math.max(L.straight, R.straight)) / 0.15);
    res.push(['flex', elbowLevel * elbowOut * fistsUp * bent]);
  }
  res.sort((a, b) => b[1] - a[1]);
  const [pose, score] = res[0];
  return score >= 0.5 ? { pose, score } : { pose: null, score };
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
