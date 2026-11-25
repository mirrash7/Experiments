// Material factories. Owner: WP1. Signatures are a WP0 contract (CONTRACTS.md section 6): keep them.
//
//   toon.js            toon ShaderMaterial (skinning, palette lookup, 2-tone ramp + deep, rim, arena shadow)
//   outline.js         screen-space constant-width inverted hull
//   hair.js            angel-ring band (hair variant)
//   faceShadow.js      SDF face-shadow threshold map + face variant snippet
//   characterLight.js  camera-locked key light
//   swatch.html/.js    palette / face-shadow / outline test page (/src/hero/materials/swatch.html)
//
// All materials made by one createSharedMaterials() share ONE set of uniform objects (palette texture,
// light, resolution, face map), so a single per-frame update drives every hero draw. The light also
// self-updates from the rendering camera in material.onBeforeRender, so materials work even if the
// host never calls update()/setCamera(). Skinning is automatic for SkinnedMesh (three's chunks).
//
// Detail atlas (WP2, R line / G shade / B highlight, sampled with the geometry `uv`): pass it to
// createSharedMaterials({ detailAtlas }) or, from a builder, call
//   setDetailAtlas(ctx.materials.body, texture)     // affects every material sharing that env
// Geometry without painted detail must map its uv to an empty (black) atlas region.

import { createToon, createMaterialEnv, getDefaultEnv } from './toon.js';
import { createOutline } from './outline.js';

/**
 * Toon material for character geometry.
 * @param {object} o
 * @param {boolean} [o.skinned=true]   hint only (skinning follows the mesh type)
 * @param {object}  [o.palette]        the palette module (ctx.palette); default = hero/palette.js
 * @param {THREE.Texture|null} [o.detailAtlas] shared 1024^2 painted detail atlas (R line, G shade, B highlight)
 * @param {'body'|'face'|'hair'} [o.variant='body']
 * @returns {THREE.ShaderMaterial}
 */
export function createToonMaterial({ skinned = true, palette = null, detailAtlas = null, variant = 'body' } = {}) {
  return createToon({ skinned, palette, detailAtlas, variant });
}

/**
 * Inverted-hull outline material (draw on a second SkinnedMesh sharing geometry + skeleton).
 * Reads attributes outlineNormal, outlineWidth, matId; colour = palette outline row.
 * @param {object} o
 * @param {boolean} [o.skinned=true]
 * @param {object}  [o.palette]
 * @returns {THREE.ShaderMaterial}
 */
export function createOutlineMaterial({ skinned = true, palette = null } = {}) {
  return createOutline({ skinned, palette });
}

/** Set (or clear with null) the detail atlas on a hero material and every material sharing its env. */
export function setDetailAtlas(material, texture) {
  (material?.userData?.env || getDefaultEnv()).setDetailAtlas(texture);
}

/**
 * Shared material set created once by the facade and handed to builders as ctx.materials.*.
 * Builders use these instances (one material per pass keeps the draw-call budget) and must NOT dispose
 * them; the facade does.
 */
export function createSharedMaterials({ palette = null, detailAtlas = null } = {}) {
  const env = createMaterialEnv({ palette: palette || undefined, detailAtlas });
  const shared = {
    body: createToon({ skinned: true, palette, variant: 'body', env }),
    face: createToon({ skinned: true, palette, variant: 'face', env }),
    hair: createToon({ skinned: true, palette, variant: 'hair', env }),
    outline: createOutline({ skinned: true, palette, env }),
  };
  return {
    ...shared,
    /** env internals for QA tooling: { light, uniforms, paletteTex, faceMap } */
    env,
    light: env.light,
    setDetailAtlas: env.setDetailAtlas,
    /** per-frame hook (facade step 5): key light from the pinned/known camera + head frame. */
    update(dt, ctx) {
      const cam = env.light.camera || ctx?.camera;
      if (cam) env.light.updateFromCamera(cam);
      const head = ctx?.rig?.bones?.head;
      if (head) env.light.updateHead(head);
    },
    /** Pin the camera-locked key light to this camera (hero.setCamera). */
    setCamera(camera) { env.light.setCamera(camera); },
    dispose() { Object.values(shared).forEach((m) => m.dispose()); env.dispose(); },
  };
}
