// Spring-bone tuning (anime-rendering.md 5.3 step 2): adds a collider group sized from the humanoid (head sphere,
// chest capsule, upper-arm capsules) to every spring joint so hair and ties don't clip the body during fast mocap
// moves, and raises very low drag so tracking noise doesn't make hair buzz. Authored colliders are kept.
import * as THREE from 'three';
import { VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere, VRMSpringBoneColliderShapeCapsule } from '@pixiv/three-vrm';

const _w = new THREE.Vector3();

/**
 * @param {import('@pixiv/three-vrm').VRM} vrm
 * @param {{ restWorld: Record<string, THREE.Vector3>, info: object, root: THREE.Object3D }} ctx  hero-space rest joints
 */
export function tuneSpringBones(vrm, { restWorld: R, info, root }) {
  const mgr = vrm.springBoneManager;
  if (!mgr || !mgr.joints.size) return { summary: { joints: 0, added: 0 }, dispose() {} };
  const s = info.height / 1.6; // proportions relative to a 1.6 m VRoid teen
  const raw = (n) => vrm.humanoid.getRawBoneNode(n);
  root.updateMatrixWorld(true);
  const heroToWorld = root.matrixWorld;

  const created = [];
  // hero-space point -> bone-local offset (handles 0.x/1.0 raw bone axes alike)
  const local = (bone, p) => bone.worldToLocal(_w.copy(p).applyMatrix4(heroToWorld).clone());
  function sphere(boneName, center, radius) {
    const bone = raw(boneName); if (!bone) return;
    const c = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({ offset: local(bone, center), radius }));
    c.name = 'arenaCollider_' + boneName; bone.add(c); created.push(c);
  }
  function capsule(boneName, a, b, radius) {
    const bone = raw(boneName); if (!bone) return;
    const c = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeCapsule({ offset: local(bone, a), tail: local(bone, b), radius }));
    c.name = 'arenaCollider_' + boneName; bone.add(c); created.push(c);
  }

  // head: skull sphere (conservative so hair roots aren't pushed out)
  const head = R.head, hh = Math.max(0.12, info.height - head.y);
  sphere('head', head.clone().add(new THREE.Vector3(0, hh * 0.38, 0.012 * s)), hh * 0.3);
  // chest: horizontal capsule across the ribcage, slightly forward (ties, front hair)
  const chestBone = R.upperChest ? 'upperChest' : 'chest';
  const cy = (R[chestBone] ?? R.spine).y + 0.03 * s;
  capsule(chestBone, new THREE.Vector3(0.075 * s, cy, 0.012 * s), new THREE.Vector3(-0.075 * s, cy, 0.012 * s), 0.088 * s);
  // shoulders + upper arms
  for (const side of ['left', 'right']) {
    const ua = R[side + 'UpperArm'], la = R[side + 'LowerArm'];
    if (ua && la) capsule(side + 'UpperArm', ua, ua.clone().lerp(la, 0.92), 0.045 * s);
  }

  const group = { name: 'arenaTuning', colliders: created };
  let drag = 0;
  mgr.joints.forEach((j) => {
    if (!j.colliderGroups.includes(group)) j.colliderGroups = [...j.colliderGroups, group];
    if (j.settings.dragForce < 0.35) { j.settings.dragForce = 0.35; drag++; }
  });
  mgr._isSortedJointsDirty = true; // collider dependencies changed
  mgr.setInitState();

  return {
    summary: { joints: mgr.joints.size, added: created.length, authoredGroups: mgr.colliderGroups.length - 1, dragRaised: drag },
    colliders: created,
    dispose() { for (const c of created) c.removeFromParent(); },
  };
}
