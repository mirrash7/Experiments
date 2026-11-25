// Geometry attribute conventions + helpers shared by every package. Owner: WP0. See hero/CONTRACTS.md.
//
// Every character geometry (body, head, hair, costume) carries:
//   position (vec3)  normal (vec3)  uv (vec2)
//   outlineNormal (vec3)  smoothed normal for the inverted hull (computeOutlineNormals)
//   matId (float)         palette column, one of palette.MAT.*
//   shadeBias (float)     [-0.5, 0.5] crease/AO painting (-0.3 creases, +0.15 forehead/nose bridge)
//   outlineWidth (float)  hull width multiplier (dims.OUTLINE.width: 1 default, 0 = no hull)
//   skinIndex (uvec4 as Uint16)  skinWeight (vec4)  indices into rig.skeleton.bones (rig.boneIndex[name])
// Hair adds: tangent (vec3, root->tip clump direction), clumpJitter (float, per clump [0,1)).
// Positions are ROOT-SPACE REST coordinates (T-pose, metres, +Z forward, feet y=0).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const ATTR = Object.freeze({
  outlineNormal: { name: 'outlineNormal', itemSize: 3 },
  matId: { name: 'matId', itemSize: 1 },
  shadeBias: { name: 'shadeBias', itemSize: 1 },
  outlineWidth: { name: 'outlineWidth', itemSize: 1 },
  tangent: { name: 'tangent', itemSize: 3 },       // hair only
  clumpJitter: { name: 'clumpJitter', itemSize: 1 }, // hair only
});
/** Attribute set every character geometry must have before it is handed to a material. */
export const REQUIRED_ATTRIBUTES = ['position', 'normal', 'uv', 'outlineNormal', 'matId', 'shadeBias', 'outlineWidth', 'skinIndex', 'skinWeight'];

/** Set (or overwrite) a float attribute filled with a constant value. */
export function fillAttribute(geo, name, value, itemSize = 1) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * itemSize);
  const vals = Array.isArray(value) ? value : [value];
  for (let i = 0; i < n; i++) for (let k = 0; k < itemSize; k++) arr[i * itemSize + k] = vals[k % vals.length];
  geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  return geo.attributes[name];
}

/**
 * Average the normals of all vertices sharing a position (within tolerance) into `outlineNormal`.
 * Fixes split hulls on hard edges / UV seams. Works on indexed and non-indexed geometry.
 */
export function computeOutlineNormals(geo, tolerance = 1e-4) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position, nor = geo.attributes.normal, n = pos.count;
  const inv = 1 / tolerance, key = new Array(n), acc = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * inv)},${Math.round(pos.getY(i) * inv)},${Math.round(pos.getZ(i) * inv)}`;
    key[i] = k;
    let a = acc.get(k);
    if (!a) acc.set(k, (a = [0, 0, 0]));
    a[0] += nor.getX(i); a[1] += nor.getY(i); a[2] += nor.getZ(i);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = acc.get(key[i]);
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l;
  }
  geo.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
  return geo.attributes.outlineNormal;
}

/**
 * Add any missing character attributes with defaults. Existing attributes are kept unless `force`.
 * opts: { matId (required unless present), shadeBias = 0, outlineWidth = 1, force = false }
 */
export function ensureCharacterAttributes(geo, opts = {}) {
  const { matId, shadeBias = 0, outlineWidth = 1, force = false } = opts;
  const has = (n) => !force && geo.attributes[n];
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) fillAttribute(geo, 'uv', [0, 0], 2);
  if (!has('matId')) {
    if (matId === undefined) throw new Error('ensureCharacterAttributes: matId required');
    fillAttribute(geo, 'matId', matId);
  }
  if (!has('shadeBias')) fillAttribute(geo, 'shadeBias', shadeBias);
  if (!has('outlineWidth')) fillAttribute(geo, 'outlineWidth', outlineWidth);
  if (!geo.attributes.outlineNormal || force) computeOutlineNormals(geo);
  return geo;
}

/** Allocate empty skinIndex (Uint16 x4) / skinWeight (Float32 x4). */
export function allocSkin(geo) {
  const n = geo.attributes.position.count;
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
  return geo;
}

/** 100% weight on one bone (rigid parts: skull, sandals, knot, fur cuffs...). bone = name or index. */
export function skinRigid(geo, rig, bone) {
  allocSkin(geo);
  const idx = typeof bone === 'number' ? bone : rig.boneIndex[bone];
  if (idx === undefined) throw new Error(`skinRigid: unknown bone ${bone}`);
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  for (let i = 0; i < si.count; i++) { si.setXYZW(i, idx, 0, 0, 0); sw.setXYZW(i, 1, 0, 0, 0); }
  return geo;
}

const _ab = new THREE.Vector3(), _ap = new THREE.Vector3(), _p = new THREE.Vector3();
function segDist(p, a, b) {
  _ab.subVectors(b, a); _ap.subVectors(p, a);
  const t = THREE.MathUtils.clamp(_ap.dot(_ab) / Math.max(_ab.lengthSq(), 1e-12), 0, 1);
  return _ap.addScaledVector(_ab, -t).length();
}

/**
 * Skin weights from distance to bone segments (inverse-distance falloff), max 4 influences, normalized.
 * Near a joint a vertex is equidistant to both segments, so it blends smoothly.
 * opts:
 *   segments  [{ bone: name, a: Vector3, b: Vector3, r?: number }]   default rig.segments
 *   bones     string[]   restrict to segments whose bone is in this list (e.g. one leg only)
 *   power     falloff exponent (default 6; higher = sharper joints)
 *   maxInfluences (default 4)
 *   filter    (vertexPos: Vector3, seg) => boolean   optional per-vertex candidate filter
 *   useRadius subtract seg.r from the distance before weighting (default true; keeps thick torso from stealing)
 */
export function skinToSegments(geo, rig, opts = {}) {
  let segs = opts.segments || rig.segments;
  if (opts.bones) segs = segs.filter((s) => opts.bones.includes(s.bone));
  const power = opts.power ?? 6, maxInf = opts.maxInfluences ?? 4, useR = opts.useRadius ?? true;
  const idx = segs.map((s) => {
    const i = rig.boneIndex[s.bone];
    if (i === undefined) throw new Error(`skinToSegments: ${s.bone} is not a skeleton bone`);
    return i;
  });
  allocSkin(geo);
  const pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const cand = [];
  for (let v = 0; v < pos.count; v++) {
    _p.fromBufferAttribute(pos, v);
    cand.length = 0;
    for (let s = 0; s < segs.length; s++) {
      if (opts.filter && !opts.filter(_p, segs[s])) continue;
      let d = segDist(_p, segs[s].a, segs[s].b);
      if (useR && segs[s].r) d = d - segs[s].r * 0.5;
      cand.push([idx[s], Math.pow(Math.max(d, 1e-3), -power)]);
    }
    // merge duplicate bones, keep strongest maxInf
    const m = new Map();
    for (const [b, w] of cand) m.set(b, (m.get(b) || 0) + w);
    const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, maxInf);
    const sum = top.reduce((a, t) => a + t[1], 0) || 1;
    const I = [0, 0, 0, 0], Wt = [0, 0, 0, 0];
    top.forEach(([b, w], k) => { I[k] = b; Wt[k] = w / sum; });
    if (!top.length) Wt[0] = 1; // falls back to bone 0 (hips)
    si.setXYZW(v, I[0], I[1], I[2], I[3]);
    sw.setXYZW(v, Wt[0], Wt[1], Wt[2], Wt[3]);
  }
  return geo;
}

/** Copy skinIndex/skinWeight from the nearest vertex of `source` (e.g. buttons onto the shirt). O(n*m). */
export function copySkinFromNearest(target, source) {
  allocSkin(target);
  const tp = target.attributes.position, sp = source.attributes.position;
  const ssi = source.attributes.skinIndex, ssw = source.attributes.skinWeight;
  const tsi = target.attributes.skinIndex, tsw = target.attributes.skinWeight;
  const q = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < tp.count; i++) {
    q.fromBufferAttribute(tp, i);
    let best = 0, bd = Infinity;
    for (let j = 0; j < sp.count; j++) { const d = s.fromBufferAttribute(sp, j).distanceToSquared(q); if (d < bd) { bd = d; best = j; } }
    tsi.setXYZW(i, ssi.getX(best), ssi.getY(best), ssi.getZ(best), ssi.getW(best));
    tsw.setXYZW(i, ssw.getX(best), ssw.getY(best), ssw.getZ(best), ssw.getW(best));
  }
  return target;
}

/** Merge geometries that share the same attribute set (all indexed or all non-indexed). Disposes inputs if asked. */
export function mergeCharacterGeometries(geos, { disposeInputs = true } = {}) {
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('mergeCharacterGeometries: attribute sets differ (run ensureCharacterAttributes + skin on each first)');
  if (disposeInputs) geos.forEach((g) => g.dispose());
  return merged;
}

/** Throw if a geometry misses a required attribute (call in dev before creating meshes). */
export function validateCharacterGeometry(geo, label = 'geometry') {
  const missing = REQUIRED_ATTRIBUTES.filter((n) => !geo.attributes[n]);
  if (missing.length) throw new Error(`${label}: missing attributes ${missing.join(', ')}`);
  return true;
}

/**
 * Create a SkinnedMesh + its outline hull SkinnedMesh (same geometry, same skeleton), both bound via rig.bind.
 * Returns [mesh, outline] (outline omitted when outlineMaterial is null).
 */
export function createSkinnedPair(geo, material, outlineMaterial, rig, { name = 'part', castShadow = true } = {}) {
  validateCharacterGeometry(geo, name);
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.name = name; mesh.castShadow = castShadow; mesh.receiveShadow = false;
  rig.bind(mesh);
  const out = [mesh];
  if (outlineMaterial) {
    const hull = new THREE.SkinnedMesh(geo, outlineMaterial);
    hull.name = `${name}_outline`; hull.castShadow = false; hull.receiveShadow = false;
    hull.raycast = () => {};
    rig.bind(hull);
    out.push(hull);
  }
  return out;
}
