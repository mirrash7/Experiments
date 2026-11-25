// Draw-call reduction for unoptimised VRoid exports: VRoid 0.x hair comes as one glTF primitive per hair strand
// group (Sakurada: 83 hair primitives over 2 materials), and every MToon primitive is drawn twice with outlines.
// Merge sibling SkinnedMeshes that share material(s), skeleton, bind matrix, render order and attribute layout into
// one mesh. Meshes with morph targets are left alone (expressions bind to them).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const sig = (g) => Object.keys(g.attributes).sort().map((k) => `${k}:${g.attributes[k].itemSize}:${g.attributes[k].normalized}`).join(',') + `|i:${!!g.index}`;

export function mergeVRMPrimitives(root) {
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.parent) return;
    const g = o.geometry;
    if (Object.keys(g.morphAttributes).length) return;
    const mats = [].concat(o.material);
    const key = [o.parent.uuid, mats.map((m) => (m.isOutline ? 'outline' : m.uuid)).join('+') /* outline clones are per-primitive copies */, o.skeleton.uuid, o.bindMatrix.elements.map((v) => v.toFixed(5)).join(','), o.renderOrder, sig(g)].join('#');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });
  let before = 0, after = 0;
  for (const meshes of groups.values()) {
    before += meshes.length; after += 1;
    if (meshes.length < 2) continue;
    const first = meshes[0];
    const geos = meshes.map((m) => { const g = m.geometry.clone(); g.clearGroups(); return g; });
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) { after += meshes.length - 1; continue; }
    if (Array.isArray(first.material)) {
      const n = merged.index ? merged.index.count : merged.attributes.position.count;
      first.material.forEach((_, i) => merged.addGroup(0, n, i));
    }
    const mesh = new THREE.SkinnedMesh(merged, first.material);
    mesh.name = first.name + '_merged';
    mesh.renderOrder = first.renderOrder;
    mesh.frustumCulled = first.frustumCulled;
    mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow;
    mesh.position.copy(first.position); mesh.quaternion.copy(first.quaternion); mesh.scale.copy(first.scale);
    mesh.bind(first.skeleton, first.bindMatrix);
    first.parent.add(mesh);
    for (const m of meshes) { m.removeFromParent(); m.geometry.dispose(); }
  }
  return { before, after };
}
