// Preview QA overrides that don't touch the material package: wireframe, skin-weight heatmap, outline
// visibility, character draw-call/triangle counts, key-light angle hook. Owner: WP6.
//
// Overrides swap `mesh.material` on the hero's meshes and restore the originals; the shared WP1
// materials are never mutated.
import * as THREE from 'three';

/** Outline hulls are the `<name>_outline` SkinnedMeshes from createSkinnedPair (or BackSide hull materials). */
export function isOutlineMesh(m) {
  if (/_outline$/i.test(m.name || '')) return true;
  const mat = Array.isArray(m.material) ? m.material[0] : m.material;
  return !!mat && (mat.userData?.isOutline || /outline/i.test(mat.name || ''));
}

export function heroMeshes(hero) {
  const out = [];
  hero.root.traverse((o) => { if (o.isMesh && !o.userData.qaHelper) out.push(o); });
  return out;
}

function makeWire() {
  return new THREE.MeshBasicMaterial({ color: '#1b2a4a', wireframe: true, toneMapped: false });
}

/**
 * Skin-weight heatmap. uBone >= 0: weight of that skeleton index (blue 0 -> red 1).
 * uBone < 0: colour = dominant influence (hashed), shows weight-region borders and seams.
 */
function makeHeat() {
  const uBone = { value: -1 };
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  mat.name = 'qaWeightHeat';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBone = uBone;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uBone;\nvarying vec3 vHeat;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_SKINNING
          if (uBone >= 0.0) {
            vec4 hit = step(abs(skinIndex - vec4(uBone)), vec4(0.5));
            float w = clamp(dot(hit, skinWeight), 0.0, 1.0);
            vHeat = w < 0.001 ? vec3(0.10, 0.12, 0.22)
              : clamp(vec3(1.5 - abs(4.0 * w - 3.0), 1.5 - abs(4.0 * w - 2.0), 1.5 - abs(4.0 * w - 1.0)), 0.0, 1.0);
          } else {
            float bi = skinIndex.x; float bw = skinWeight.x;
            if (skinWeight.y > bw) { bi = skinIndex.y; bw = skinWeight.y; }
            if (skinWeight.z > bw) { bi = skinIndex.z; bw = skinWeight.z; }
            if (skinWeight.w > bw) { bi = skinIndex.w; bw = skinWeight.w; }
            vHeat = 0.35 + 0.65 * fract(sin(vec3(bi * 12.9898, bi * 78.233, bi * 37.719)) * 43758.5453);
            vHeat *= 0.55 + 0.45 * bw; // darker where the dominant weight is weak (blend zones)
          }
        #else
          vHeat = vec3(0.6);
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeat;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( vHeat, opacity );');
  };
  mat.customProgramCacheKey = () => 'qaWeightHeat';
  return { mat, uBone };
}

export function createDebugViews(hero) {
  const originals = new Map(); // mesh -> material
  const wire = makeWire();
  const heat = makeHeat();
  let mode = 'normal'; // 'normal' | 'wire' | 'heat'
  let outlines = true;

  function restore() {
    for (const [m, mat] of originals) m.material = mat;
    originals.clear();
  }
  function applyVisibility() {
    for (const m of heroMeshes(hero)) if (isOutlineMesh(m)) m.visible = outlines && mode === 'normal';
  }
  function setMode(next) {
    restore();
    mode = next;
    if (mode !== 'normal') {
      const mat = mode === 'wire' ? wire : heat.mat;
      for (const m of heroMeshes(hero)) {
        if (isOutlineMesh(m)) continue;
        originals.set(m, m.material);
        m.material = mat;
      }
    }
    applyVisibility();
  }

  return {
    get mode() { return mode; },
    setWireframe(on) { setMode(on ? 'wire' : mode === 'wire' ? 'normal' : mode); },
    /** @param {string|number|null} bone  bone name / skeleton index; '*' or -1 = dominant-bone view; null = off */
    setHeatmap(bone) {
      if (bone === null || bone === false) { if (mode === 'heat') setMode('normal'); return; }
      const idx = typeof bone === 'number' ? bone : bone === '*' ? -1 : (hero.rig?.boneIndex?.[bone] ?? -1);
      heat.uBone.value = idx;
      if (mode !== 'heat') setMode('heat');
    },
    setOutlines(on) { outlines = !!on; applyVisibility(); },
    /** Re-apply after the hero rebuilt meshes. */
    refresh() { const m = mode; restore(); setMode(m); },
    /** Character-only counts (main pass). Shadow-pass casters are reported separately. */
    stats() {
      let draws = 0, tris = 0, shadowDraws = 0, outlineDraws = 0;
      for (const m of heroMeshes(hero)) {
        if (!m.visible || !isVisibleChain(m)) continue;
        const g = m.geometry;
        const n = g.index ? g.index.count : g.attributes.position?.count || 0;
        const groups = Array.isArray(m.material) ? Math.max(1, g.groups.length) : 1;
        draws += groups;
        if (isOutlineMesh(m)) outlineDraws += groups; else tris += Math.round(n / 3);
        if (m.castShadow) shadowDraws += groups;
      }
      return { draws, outlineDraws, shadowDraws, tris };
    },
    dispose() { restore(); wire.dispose(); heat.mat.dispose(); },
  };
}

function isVisibleChain(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }

// ------------------------------------------------------------------------------------------------
// Key-light angle (camera-locked character key, spec 2.8: default 35 deg to the camera's left, 40 deg up).
//
// REQUEST(WP6 -> WP0/WP1): please expose `hero.setKeyLight({ yaw, pitch })` on the facade (degrees,
// relative to the camera; yaw > 0 = camera's left), routed to materials/characterLight.js. The preview's
// light-angle slider already calls it. Until then this hook also tries `shared.setKeyLight` via any
// character material's `userData.setKeyLight(yaw, pitch)` or a `uKeyLightOffset` (vec2, radians) uniform.
// ------------------------------------------------------------------------------------------------
export const KEY_LIGHT_DEFAULT = { yaw: 35, pitch: 40 };

/** @returns {'facade'|'material'|'uniform'|null} which path accepted the value (null = not exposed yet) */
export function setKeyLightAngle(hero, yaw, pitch = KEY_LIGHT_DEFAULT.pitch) {
  if (typeof hero.setKeyLight === 'function') { hero.setKeyLight({ yaw, pitch }); return 'facade'; }
  let via = null;
  const seen = new Set();
  for (const m of heroMeshes(hero)) {
    for (const mat of [].concat(m.material)) {
      if (!mat || seen.has(mat)) continue;
      seen.add(mat);
      if (typeof mat.userData?.setKeyLight === 'function') { mat.userData.setKeyLight(yaw, pitch); via = 'material'; continue; }
      const u = mat.userData?.uniforms?.uKeyLightOffset || mat.uniforms?.uKeyLightOffset;
      if (u?.value?.set) { u.value.set(THREE.MathUtils.degToRad(yaw), THREE.MathUtils.degToRad(pitch)); via = via || 'uniform'; }
    }
  }
  return via;
}
