// SDF face shadow for VRM faces (anime-rendering.md 2 "SDF face shadow"; port of the procedural hero's
// web/src/hero/materials/faceShadow.js onto MToon).
//
// The front of the face ignores N.L. A threshold map T(u, v) says, per texel, at which horizontal light angle that
// texel enters shade (sphere terminator base, cheek bow toward the nose, eye-socket plateau, nose wedge, monotonic
// rows so the shade is ONE connected shape at every angle). The procedural hero's GLSL field (FACE_FUNC_GLSL) is
// reused unchanged; only the map is rebuilt from a layout MEASURED on the VRM's face mesh:
//
//   head frame = the head bone's rest frame in hero space (+X character's left, +Y up, +Z forward), origin at the
//                head joint. The vertex shader gets it from the skinned world position and the head proxy's
//                current world matrix (the face is rigid on the head), so no bind-pose bookkeeping is needed.
//   u = (x - x0) / W + 0.5,  v = (y - chinY) / H      (u = 0 is the character's RIGHT cheek edge)
//
// Layout: x0/eye height/eye spacing from the eye bones; chin = lowest forward-facing centre-line vertex; nose = the
// most forward centre-line vertex; W = face width at eye height; H = chin .. top of the face mesh (under the bangs).
import * as THREE from 'three';
import { FACE_PARS_GLSL, FACE_FUNC_GLSL } from '../hero/materials/faceShadow.js';

export { FACE_PARS_GLSL, FACE_FUNC_GLSL };

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const HALF_PI = Math.PI / 2;
const sphereT = (a) => 1 - Math.asin(Math.min(1, Math.max(0, 1 - a))) / HALF_PI;
const eyeT = (L) => sphereT((0.5 - L.eye.du) / 0.5);

function farRaw(a, v, L) {
  const base = sphereT(a);
  let t = base;
  const cheek = smooth(L.mouthV - 0.16, L.mouthV + 0.02, v) * (1 - smooth(L.noseV - 0.04, L.eye.v - 0.06, v));
  t -= 0.10 * cheek * Math.sin(Math.PI * Math.min(1, a));
  t += 0.04 * (1 - smooth(0.02, 0.12, v)) * a * a;
  const fh = smooth(L.browV - 0.06, L.browV + 0.04, v);
  t = t * (1 - fh) + base * fh;
  const wedgeTop = L.noseV + 0.06, wedgeBot = L.noseV - 0.10;
  if (v < wedgeTop && v > wedgeBot) {
    const k = (wedgeTop - v) / (wedgeTop - wedgeBot);
    const halfW = 0.02 + 0.06 * Math.sin(Math.PI * Math.min(1, k * 1.15));
    const da = (1 - a) * 0.5;
    const w = smooth(halfW + 0.02, halfW - 0.01, da) * smooth(0, 0.18, k) * smooth(1, 0.75, k);
    t = Math.min(t, t * (1 - w) + eyeT(L) * w);
  }
  return Math.min(1, Math.max(0, t));
}
function eyePlateau(t, a, v, L) {
  const eu = 0.5 - L.eye.du, te = eyeT(L), u = a * 0.5;
  const d = Math.hypot((u - eu) / L.eye.ru, (v - L.eye.v) / L.eye.rv);
  return t + (te - t) * smooth(1.4, 1.0, d);
}
function farRow(n, v, L, out) {
  for (let i = 0; i < n; i++) out[i] = farRaw((i + 0.5) / n, v, L);
  for (let i = n - 2; i >= 0; i--) if (out[i] > out[i + 1]) out[i] = out[i + 1];
  for (let i = 0; i < n; i++) out[i] = eyePlateau(out[i], (i + 0.5) / n, v, L);
  for (let i = 1; i < n; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  return out;
}
function buildT(size, L) {
  const half = size / 2, row = new Float32Array(half), T = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    farRow(half, (y + 0.5) / size, L, row);
    for (let x = 0; x < half; x++) { T[y * size + x] = row[x]; T[y * size + (size - 1 - x)] = 2 - row[x]; }
  }
  return T;
}

/**
 * Measure the face layout on the VRM (call in the rest pose).
 * @returns {null | {x0, W, H, chinY, L, headInvRest: THREE.Matrix4}}
 */
export function measureVRMFace(vrm, faceMaterial, { root, headProxy, restWorld }) {
  const le = restWorld.leftEye, re = restWorld.rightEye, head = restWorld.head;
  if (!le || !re || !head) return null;
  root.updateMatrixWorld(true);
  headProxy.updateWorldMatrix(true, false);
  const toHead = headProxy.matrixWorld.clone().invert();
  const x0 = (le.x + re.x) / 2 - head.x, eyeY = (le.y + re.y) / 2 - head.y, spacing = Math.abs(le.x - re.x);
  const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3(), rot = new THREE.Matrix3();
  let chinY = Infinity, noseZ = -Infinity, noseY = eyeY - spacing * 0.9, topY = -Infinity, halfW = 0, count = 0;
  vrm.scene.traverse((o) => {
    if (!o.isMesh || ![].concat(o.material).includes(faceMaterial)) return;
    const pos = o.geometry.attributes.position, nrm = o.geometry.attributes.normal;
    nm.getNormalMatrix(o.matrixWorld); rot.setFromMatrix4(toHead);
    for (let i = 0; i < pos.count; i++) {
      o.getVertexPosition(i, v);
      v.applyMatrix4(o.matrixWorld).applyMatrix4(toHead);
      n.fromBufferAttribute(nrm, i).applyMatrix3(nm).applyMatrix3(rot).normalize();
      count++;
      topY = Math.max(topY, v.y);
      const cx = Math.abs(v.x - x0);
      if (cx < spacing * 0.15 && n.z > 0.3) {
        chinY = Math.min(chinY, v.y);
        if (v.z > noseZ && v.y < eyeY) { noseZ = v.z; noseY = v.y; }
      }
      if (Math.abs(v.y - eyeY) < spacing * 0.3 && n.z > 0.1) halfW = Math.max(halfW, cx); // front of the cheeks, not the ears
    }
  });
  if (!count || !isFinite(chinY) || halfW < spacing * 0.5) return null;
  const W = halfW * 2, H = Math.max(topY - chinY, (eyeY - chinY) * 1.8);
  const ev = (eyeY - chinY) / H, nv = (noseY - chinY) / H;
  const L = {
    eye: { du: (spacing / 2) / W, v: ev, ru: (spacing * 0.42 / W) * 0.5 * 1.45, rv: (spacing * 0.36 / H) * 0.5 * 1.55 },
    noseV: nv, mouthV: nv * 0.55, browV: ev + (ev - nv) * 0.6,
  };
  return { x0, W, H, chinY, L, vertices: count };
}

/** Threshold map (single-channel half float, linear filtered), map = T / 2. */
export function createVRMFaceShadowMap(L, size = 256) {
  const T = buildT(size, L);
  const data = new Uint16Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(T[i] * 0.5);
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.name = 'vrmFaceShadowMap';
  tex.needsUpdate = true;
  return tex;
}
