// QA pose presets for the preview (spec 4.G and WP6a). Owner: WP6.
//
// Limbs are specified as target directions in hero-root space (+Y up, +Z forward, +X = hero's left) and
// solved as the minimal swing from the T-pose rest direction, the same way the retargeter drives the rig.
// Torso/head use small Euler offsets. After posing, the feet are planted (lowest ankle/toe on y = 0).
import * as THREE from 'three';

const ORDER = ['hips', 'spine', 'chest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftForeArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightForeArm', 'rightHand',
  'leftThigh', 'leftShin', 'leftFoot', 'rightThigh', 'rightShin', 'rightFoot'];
const CHILD = {
  leftUpperArm: 'leftForeArm', leftForeArm: 'leftHand', leftHand: 'leftHandTip',
  rightUpperArm: 'rightForeArm', rightForeArm: 'rightHand', rightHand: 'rightHandTip',
  leftThigh: 'leftShin', leftShin: 'leftFoot', leftFoot: 'leftToe',
  rightThigh: 'rightShin', rightShin: 'rightFoot', rightFoot: 'rightToe',
};
const PARENT = { hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck' };
for (const s of ['left', 'right']) {
  Object.assign(PARENT, {
    [`${s}Shoulder`]: 'chest', [`${s}UpperArm`]: `${s}Shoulder`, [`${s}ForeArm`]: `${s}UpperArm`, [`${s}Hand`]: `${s}ForeArm`,
    [`${s}Thigh`]: 'hips', [`${s}Shin`]: `${s}Thigh`, [`${s}Foot`]: `${s}Shin`,
  });
}
const D = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
/** mirror a left-side direction to the right side */
const M = (v) => new THREE.Vector3(-v.x, v.y, v.z);
const deg = THREE.MathUtils.degToRad;

const ARMS_DOWN_L = D(0.22, -1, 0.04), ARMS_DOWN_F = D(0.12, -1, 0.12);
const GUARD_UA = D(0.25, -0.75, 0.5), GUARD_FA = D(-0.1, 0.8, 0.55);

/**
 * Each preset: { euler: { bone: [x, y, z] (deg) }, dir: { bone: Vector3 }, lift?: metres, fist?: side,
 *               expression?: name }. Bones without a dir follow their parent (identity local).
 */
export const POSES = {
  t: { label: 'T-pose' },
  armsDown: {
    label: 'Arms down',
    dir: { leftUpperArm: ARMS_DOWN_L, leftForeArm: ARMS_DOWN_F, rightUpperArm: M(ARMS_DOWN_L), rightForeArm: M(ARMS_DOWN_F) },
  },
  armsOverhead: {
    label: 'Arms overhead',
    // 160 deg abduction from arms-down = 70 deg above horizontal, elbows slightly bent
    dir: { leftUpperArm: D(0.34, 0.94, 0.02), leftForeArm: D(0.12, 1, 0.08), rightUpperArm: M(D(0.34, 0.94, 0.02)), rightForeArm: M(D(0.12, 1, 0.08)) },
  },
  goalPost: {
    label: 'Goal post',
    dir: { leftUpperArm: D(1, 0, 0), leftForeArm: D(0, 1, 0), rightUpperArm: D(-1, 0, 0), rightForeArm: D(0, 1, 0) },
  },
  squat: {
    label: 'Squat',
    euler: { spine: [24, 0, 0], chest: [10, 0, 0], head: [-22, 0, 0] },
    // thighs 110 deg flexion (slightly abducted), knees 130 deg, feet flat
    dir: {
      leftThigh: D(0.28, 0.34, 0.94), leftShin: D(0.05, -0.94, -0.34), leftFoot: D(0.08, -0.31, 0.95),
      rightThigh: M(D(0.28, 0.34, 0.94)), rightShin: M(D(0.05, -0.94, -0.34)), rightFoot: M(D(0.08, -0.31, 0.95)),
      leftUpperArm: D(0.15, 0.05, 1), leftForeArm: D(0.05, 0.1, 1), rightUpperArm: D(-0.15, 0.05, 1), rightForeArm: D(-0.05, 0.1, 1),
    },
    expression: 'effort',
  },
  punchL: {
    label: 'Punch L',
    euler: { spine: [0, -10, 0], chest: [0, -22, 0], head: [0, 20, 0] },
    dir: { leftUpperArm: D(0.05, 0.03, 1), leftForeArm: D(0, 0.03, 1), rightUpperArm: M(GUARD_UA), rightForeArm: M(GUARD_FA) },
    fist: 'both', expression: 'determined',
  },
  punchR: {
    label: 'Punch R',
    euler: { spine: [0, 10, 0], chest: [0, 22, 0], head: [0, -20, 0] },
    dir: { rightUpperArm: D(-0.05, 0.03, 1), rightForeArm: D(0, 0.03, 1), leftUpperArm: GUARD_UA, leftForeArm: GUARD_FA },
    fist: 'both', expression: 'determined',
  },
  frontKick: {
    label: 'Front kick',
    euler: { spine: [-10, 0, 0], chest: [-4, 0, 0] },
    // thigh 90 deg, knee straight
    dir: {
      leftThigh: D(0.03, 0, 1), leftShin: D(0.03, 0.02, 1), leftFoot: D(0, 0.6, 0.8),
      leftUpperArm: GUARD_UA, leftForeArm: GUARD_FA, rightUpperArm: M(GUARD_UA), rightForeArm: M(GUARD_FA),
    },
    fist: 'both', expression: 'shout',
  },
  sideKick: {
    label: 'Side kick',
    euler: { spine: [0, 0, 18], chest: [0, 0, 10], head: [0, 0, -18] },
    dir: {
      leftThigh: D(0.94, -0.33, 0.06), leftShin: D(0.98, -0.18, 0.04), leftFoot: D(0.5, -0.2, 0.84),
      leftUpperArm: GUARD_UA, leftForeArm: GUARD_FA, rightUpperArm: M(GUARD_UA), rightForeArm: M(GUARD_FA),
    },
    fist: 'both', expression: 'determined',
  },
  highKnee: {
    label: 'High knee',
    // thigh 100 deg flexion, shin hangs, opposite arm swings forward
    dir: {
      leftThigh: D(0.02, 0.17, 0.98), leftShin: D(0, -0.98, 0.17), leftFoot: D(0, -0.6, 0.8),
      rightUpperArm: D(-0.18, -0.55, 0.8), rightForeArm: D(-0.05, 0.6, 0.8),
      leftUpperArm: D(0.2, -0.85, -0.45), leftForeArm: D(0.1, -0.5, 0.85),
    },
    expression: 'effort',
  },
  starJump: {
    label: 'Star jump',
    // arms 45 deg above horizontal, thighs 45 deg abduction
    dir: {
      leftUpperArm: D(0.7, 0.7, 0), leftForeArm: D(0.65, 0.76, 0), rightUpperArm: D(-0.7, 0.7, 0), rightForeArm: D(-0.65, 0.76, 0),
      leftThigh: D(0.71, -0.71, 0), leftShin: D(0.6, -0.8, 0), leftFoot: D(0.5, -0.5, 0.7),
      rightThigh: D(-0.71, -0.71, 0), rightShin: D(-0.6, -0.8, 0), rightFoot: D(-0.5, -0.5, 0.7),
    },
    lift: 0.12, expression: 'laugh',
  },
  handsOnHead: {
    label: 'Hands on head',
    dir: {
      leftUpperArm: D(0.8, 0.56, 0.15), leftForeArm: D(-0.86, 0.5, -0.05), leftHand: D(-0.75, 0.62, 0),
      rightUpperArm: M(D(0.8, 0.56, 0.15)), rightForeArm: M(D(-0.86, 0.5, -0.05)), rightHand: M(D(-0.75, 0.62, 0)),
    },
  },
  headTurn: {
    label: 'Head turn 70',
    // spec 4.G: head turn 70 deg (character's left) relative to the chest, arms down; split neck 28 / head 42
    // like the retargeter (see NECK_SHARE)
    euler: { head: [0, 70, 0] },
    dir: { leftUpperArm: ARMS_DOWN_L, leftForeArm: ARMS_DOWN_F, rightUpperArm: M(ARMS_DOWN_L), rightForeArm: M(ARMS_DOWN_F) },
  },
  headTilt: {
    label: 'Head tilt 30',
    euler: { head: [0, 0, 30] },
    dir: { leftUpperArm: ARMS_DOWN_L, leftForeArm: ARMS_DOWN_F, rightUpperArm: M(ARMS_DOWN_L), rightForeArm: M(ARMS_DOWN_F) },
  },
  twist: {
    label: 'Twist + lean',
    // torso twist 40 deg + side lean 25 deg
    euler: { spine: [0, 16, 12], chest: [0, 24, 13], head: [0, -22, -10] },
    dir: { leftUpperArm: ARMS_DOWN_L, leftForeArm: ARMS_DOWN_F, rightUpperArm: M(ARMS_DOWN_L), rightForeArm: M(ARMS_DOWN_F) },
  },
};
export const POSE_NAMES = Object.keys(POSES);

const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qn = new THREE.Quaternion(), _e = new THREE.Euler();
/** Share of the head rotation the neck bone carries (retarget.js: T.neck = slerp(chest, head, 0.4)). */
const NECK_SHARE = 0.4;
const _rest = new THREE.Vector3();

/** Rest direction (root space) of a limb bone = normalized offset to its child (rest rotations are identity). */
function restDir(hero, bone) {
  const rw = hero.rig?.restWorld;
  const a = rw?.[bone], b = rw?.[CHILD[bone]];
  if (a && b) return _rest.copy(b).sub(a).normalize();
  // fallback: child bone's local position (identity rest => same as root space)
  const c = hero.bones[CHILD[bone]];
  return _rest.copy(c.position).normalize();
}

/**
 * Apply a preset. Writes hero.bones (and hero.root.position.y for planting) like the retargeter would.
 * @returns {string|null} the applied name, or null if unknown
 */
export function applyPose(hero, name) {
  const P = POSES[name];
  if (!P) return null;
  const B = hero.bones;
  for (const b of Object.values(B)) b.quaternion.identity();
  hero.root.position.y = 0;

  // root-relative world quaternion per bone, accumulated top-down
  const rel = {};
  for (const n of ORDER) {
    const bone = B[n];
    if (!bone) continue;
    const pn = PARENT[n];
    const qParent = pn ? rel[pn] : new THREE.Quaternion();
    const eu = P.euler?.[n];
    const dir = P.dir?.[n];
    const headEu = P.euler?.head;
    if (dir) {
      _q.setFromUnitVectors(restDir(hero, n), dir); // desired root-space orientation (minimal swing from rest)
      bone.quaternion.copy(_qp.copy(qParent).invert().multiply(_q));
    } else if ((n === 'neck' || n === 'head') && headEu && !P.euler?.neck) {
      // head rotation split like retarget.js (neck = slerp(chest, head, 0.4)): the neck bone takes 40 % and
      // the head the rest, so presets deform the neck exactly like the game does (QA r1 P0-11)
      _q.setFromEuler(_e.set(deg(headEu[0]), deg(headEu[1]), deg(headEu[2]), 'YXZ')); // head relative to chest
      _qn.identity().slerp(_q, NECK_SHARE);
      if (n === 'neck') bone.quaternion.copy(_qn);
      else bone.quaternion.copy(_qn.invert().multiply(_q));
    } else if (eu) {
      bone.quaternion.setFromEuler(_e.set(deg(eu[0]), deg(eu[1]), deg(eu[2]), 'YXZ'));
    }
    rel[n] = qParent.clone().multiply(bone.quaternion);
  }
  plantFeet(hero, P.lift || 0);

  if (hero.setHandPose) {
    hero.setHandPose('relaxed', 'both');
    if (P.fist) hero.setHandPose('fist', P.fist);
  }
  if (hero.setExpression) hero.setExpression(P.expression || 'happy');
  return name;
}

const _v = new THREE.Vector3(), _inv = new THREE.Matrix4();
/** Shift hero.root along Y so the lowest ankle (sole = ankle - 0.07) / toe marker touches y = 0. */
export function plantFeet(hero, lift = 0) {
  const B = hero.bones;
  const root = hero.root;
  root.updateMatrixWorld(true);
  // measure in the root's parent space so a rotated/positioned root still works
  _inv.copy(root.parent ? root.parent.matrixWorld : new THREE.Matrix4()).invert();
  let minY = Infinity;
  const ankle = hero.info?.footHeight ?? 0.07;
  for (const side of ['left', 'right']) {
    const a = B[`${side}Foot`].getWorldPosition(_v).applyMatrix4(_inv).y - ankle;
    const t = B[`${side}Toe`] ? B[`${side}Toe`].getWorldPosition(_v).applyMatrix4(_inv).y - 0.015 : Infinity;
    minY = Math.min(minY, a, t);
  }
  root.position.y += -minY + lift;
  root.updateMatrixWorld(true);
}
