// MToon parameter pass (docs/research/anime-rendering.md 5.1, QA v3 round 1 P0-1 / P1-1..P1-4 / P2-4).
//
// Rule: the AUTHORED look is the baseline and every change is a nudge. Each material keeps its authored shade
// colour, shade texture, shading shift and GI equalization; toony is only raised toward a crisp-but-soft edge.
//   hair   authored shade colour + texture, tamed 30 % toward a darker, desaturated version of the hair's own mean
//          colour (never derived from the tint alone); off-hue under-layers (VRoid HairBack / Hair_02 violet) are
//          desaturated toward the main hair hue; matcap off (a lit-side angel-ring band replaces it, mtoonPatch.js);
//          authored emissive highlight kept but only shows on the lit side
//   cloth  matcap 0, very dark rim, lit side only (no pale halo inside the outline on dark fabric)
//   skin   a warm, lit-side rim (power ~3.5) gives arms and cheeks a soft highlight instead of the flat look
//   face   SDF face shadow (vrm/faceShadow.js) when the face mesh and eye bones allow measuring a layout
//   outlines thinner, coloured from the authored outline colour (VRoid: maroon #8d465a), hair: hue-tinted dark
// Outlines are generated for MToon primitives that were authored without one (VRoid 0.x hair), and disabled on
// small / interior primitives (eyes, mouth, brows, lashes) to save draw calls.
import * as THREE from 'three';
import { patchMToon, createSharedUniforms } from './mtoonPatch.js';
import { measureVRMFace, createVRMFaceShadowMap } from './faceShadow.js';

const NO_OUTLINE = /eye|iris|highlight|mouth|brow|lash|eyeline|tooth|teeth|tongue|glass|trans|emit|logo/i;
const SKIN = /skin|face_00|body_00/i;
const HAIR = /hair/i;
const MINOR = /accessory|shoes|metal|plastic|backpack|gear/i; // outlines dropped on the Low tier

const _hsl = { h: 0, s: 0, l: 0 }, _hsl2 = { h: 0, s: 0, l: 0 };

/** Outline widths (fraction of half the screen height; ~2 px body line at 900 px). */
export const OUTLINE_WIDTH = { body: 0.0045, hair: 0.0048, face: 0.0035 };
/** Angel-ring strength per quality tier. */
const HAIR_SPEC = { low: 0, medium: 0.45, high: 0.6 }; // r2 P2-3: thinner band, so a stronger peak

function kindOf(name) {
  if (NO_OUTLINE.test(name)) return 'detail';
  if (HAIR.test(name)) return 'hair';
  if (/face/i.test(name) && SKIN.test(name)) return 'face';
  if (SKIN.test(name)) return 'skin';
  return 'cloth';
}

/** Add a BackSide outline material + geometry groups, mirroring MToonMaterialLoaderPlugin._generateOutline. */
function generateOutline(mesh) {
  const surface = mesh.material;
  if (!surface?.isMToonMaterial || Array.isArray(surface)) return null;
  const outline = surface.clone();
  outline.name = surface.name + ' (Outline)';
  outline.isOutline = true;
  outline.side = THREE.BackSide;
  mesh.material = [surface, outline];
  const g = mesh.geometry;
  const n = g.index ? g.index.count : g.attributes.position.count;
  g.clearGroups();
  g.addGroup(0, n, 0);
  g.addGroup(0, n, 1);
  return outline;
}

/** Alpha-weighted mean sRGB colour of a texture (16x16 downsample), as a linear THREE.Color; white if unreadable. */
function textureMean(tex) {
  const out = new THREE.Color(1, 1, 1);
  const img = tex?.image;
  if (!img || !(img.width > 0)) return out;
  try {
    const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(16, 16) : Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gg = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; r += d[i] * a; gg += d[i + 1] * a; b += d[i + 2] * a; w += a; }
    if (w > 0.5) out.setRGB(r / w / 255, gg / w / 255, b / w / 255, THREE.SRGBColorSpace);
  } catch { /* tainted / unsupported: keep white */ }
  return out;
}

const toSRGB = (c) => c.clone().convertLinearToSRGB();
const fromSRGB = (c) => c.clone().convertSRGBToLinear();
const hueLerp = (a, b, t) => { let d = b - a; if (d > 0.5) d -= 1; if (d < -0.5) d += 1; return (a + d * t + 1) % 1; };
const hueDist = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

/**
 * @param {import('@pixiv/three-vrm').VRM} vrm
 * @param {{quality?: 'low'|'medium'|'high', root?: THREE.Object3D, headProxy?: THREE.Object3D, restWorld?: object}} [o]
 */
export function tuneMToon(vrm, { quality = 'high', root = null, headProxy = null, restWorld = null } = {}) {
  const surfaces = new Map(); // surface material -> { kind, outlines: [], tris }
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const surface = mats.find((m) => m?.isMToonMaterial && !m.isOutline);
    if (!surface) return;
    const kind = kindOf(surface.name);
    if (!surfaces.has(surface)) surfaces.set(surface, { kind, outlines: [], tris: 0 });
    const e = surfaces.get(surface);
    e.tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    let outline = mats.find((m) => m?.isMToonMaterial && m.isOutline);
    if (!outline && kind !== 'detail' && mats.length === 1) outline = generateOutline(o);
    if (outline) e.outlines.push(outline);
  });

  const shared = createSharedUniforms();
  const summary = { surfaces: 0, outlines: 0, generatedOutlines: 0, pbr: 0, faceSDF: false };
  const all = [];

  // ---- main hair colour (largest hair primitive set, not a "back" layer): reference for taming the others
  const hairs = [...surfaces].filter(([, e]) => e.kind === 'hair');
  const mainHair = hairs.filter(([m]) => !/back/i.test(m.name)).sort((a, b) => b[1].tris - a[1].tris)[0]?.[0] ?? hairs[0]?.[0];
  const meanOf = (m) => textureMean(m.map).multiply(m.color);
  const mainHairMean = mainHair ? toSRGB(meanOf(mainHair)) : null;
  const mainHSL = mainHairMean ? mainHairMean.getHSL({ h: 0, s: 0, l: 0 }) : null;

  // ---- face SDF layout (needs eye bones + a face skin material)
  const faceEntry = [...surfaces].find(([, e]) => e.kind === 'face');
  let face = null;
  if (faceEntry && root && headProxy && restWorld) {
    face = measureVRMFace(vrm, faceEntry[0], { root, headProxy, restWorld });
    if (face) {
      shared.uFaceMap.value = createVRMFaceShadowMap(face.L, 256);
      // wrap 0.25 (was 0.2): with the key ~40 deg off the camera, ~20-25 % of the face sits in the SDF shade at Front
      shared.uFaceFrame.value.set(face.W, face.H, face.chinY, 0.25);
      shared.uFaceX0.value = face.x0;
      summary.faceSDF = true;
      summary.faceLayout = { W: +face.W.toFixed(3), H: +face.H.toFixed(3), chinY: +face.chinY.toFixed(3), eyeV: +face.L.eye.v.toFixed(2), noseV: +face.L.noseV.toFixed(2) };
    }
  }

  const tmp = new THREE.Color();
  for (const [m, { kind, outlines }] of surfaces) {
    summary.surfaces++;
    const authored = {
      toony: m.shadingToonyFactor, shift: m.shadingShiftFactor, shade: m.shadeColorFactor.clone(), color: m.color.clone(),
      rim: m.parametricRimColorFactor.clone(), outline: outlines[0]?.outlineColorFactor.clone() ?? new THREE.Color(0, 0, 0),
      emissive: m.emissive?.clone(),
    };
    m.userData.authored = authored;
    if (kind === 'detail') { // eyes, brows, mouth, lashes: authored look untouched
      all.push({ name: m.name, kind, material: m, outlines });
      for (const ol of outlines) { ol.visible = false; ol.userData.outlineKind = kind; }
      continue;
    }

    // ---- shading terminator: authored toony raised toward a crisp-but-soft edge; authored shift kept
    let toony = THREE.MathUtils.clamp(Math.max(authored.toony, 0.6), 0, 0.75);
    let shift = THREE.MathUtils.clamp(authored.shift, -0.3, 0.1);
    if (kind === 'skin') toony = THREE.MathUtils.clamp(Math.max(authored.toony, 0.55), 0, 0.7);
    if (kind === 'face') {
      if (face) { toony = 0.92; shift = 0.0; } // the SDF field is calibrated with its terminator at 0; crisp anime edge
      else { toony = THREE.MathUtils.clamp(Math.max(authored.toony, 0.5), 0, 0.7); shift = Math.max(authored.shift, 0.02); }
    }

    // ---- colours (sRGB HSL maths)
    let lit = authored.color.clone(), shade = authored.shade.clone();
    if (kind === 'hair' && mainHSL) {
      const mean = toSRGB(meanOf(m));
      mean.getHSL(_hsl);
      const offHue = m !== mainHair && hueDist(_hsl.h, mainHSL.h) > 0.06 && _hsl.s > 0.2;
      if (offHue) {
        // P1-1 / r2 P2-2: under-layer tint (VRoid violet) -> a darker, slightly cooler version of the MAIN hair tone
        // (was a dark plum at 0.55x the main lightness that read as a separate cap under the pink top)
        toSRGB(lit).getHSL(_hsl2);
        tmp.setHSL(hueLerp(_hsl2.h, mainHSL.h, 0.7), Math.min(Math.max(_hsl2.s * 0.5, mainHSL.s * 0.6), 0.3), Math.max(_hsl2.l, mainHSL.l * 0.8));
        lit = fromSRGB(tmp);
      }
      // P0-1 / r2 P2-1: main hair keeps its authored shade HUE (the lavender tip shade), tamed 18 % toward a darker,
      // less saturated version of itself; under-layers go 60 % toward a darkened main-hair tone
      let shadeS;
      if (offHue) {
        tmp.setHSL(mainHSL.h, Math.min(mainHSL.s, 0.6) * 0.55, mainHSL.l * 0.6);
        shadeS = toSRGB(shade).lerp(tmp, 0.7);
      } else {
        toSRGB(shade).getHSL(_hsl2);
        tmp.setHSL(_hsl2.h, _hsl2.s * 0.75, _hsl2.l * 0.82);
        shadeS = toSRGB(shade).lerp(tmp, 0.18);
      }
      // cap shade saturation at the lit saturation
      shadeS.getHSL(_hsl2); toSRGB(lit).getHSL(_hsl);
      if (_hsl2.s > _hsl.s) shadeS.setHSL(_hsl2.h, _hsl.s, _hsl2.l);
      shade = fromSRGB(shadeS);
    } else if (kind === 'skin' || kind === 'face') {
      // VRoid's authored skin shade is a near-white pink: keep its hue, deepen it a little so the face shadow and
      // the body terminator read (a nudge, not the old peach -> coral replacement)
      // (linear scale toward a touch of grey: same hue, no extra chroma)
      const l = (shade.r + shade.g + shade.b) / 3;
      shade = shade.clone().lerp(tmp.setRGB(l, l, l), 0.15).multiplyScalar(0.84);
      if (kind === 'face' && face) {
        // face pass: the hemisphere fill adds the LIT albedo to the shade side too, so the authored near-white shade
        // left the SDF shape invisible (~0.9 of lit). Deeper and a touch richer, same rose hue -> ~0.78 of lit on screen
        toSRGB(shade).getHSL(_hsl2);
        shade = fromSRGB(tmp.setHSL(_hsl2.h, Math.min(1, _hsl2.s * 1.15), _hsl2.l)).multiplyScalar(0.7);
      }
    }

    for (const target of [m, ...outlines]) {
      target.shadingToonyFactor = toony;
      target.shadingShiftFactor = shift;
      target.color.copy(lit);
      target.shadeColorFactor.copy(shade);
      if (m.matcapTexture) target.matcapFactor.setScalar(0); // VRoid "sphere add" paints a hard white edge
      // rim: zero lift, high fresnel power, lit side only (mtoonPatch), mixed with the light
      const authoredRim = authored.rim.r + authored.rim.g + authored.rim.b > 0.02;
      if (!authoredRim) {
        if (kind === 'cloth') target.parametricRimColorFactor.set('#2a2622').convertSRGBToLinear();
        else if (kind === 'skin') target.parametricRimColorFactor.set('#ffd9c4').convertSRGBToLinear().multiplyScalar(0.28);
        else if (kind === 'face') target.parametricRimColorFactor.set('#ffd9c4').convertSRGBToLinear().multiplyScalar(0.16);
        else if (kind === 'hair') target.parametricRimColorFactor.setScalar(0.1);
      }
      target.parametricRimFresnelPowerFactor = kind === 'skin' ? 3.5 : kind === 'face' ? 4.0 : 5.5;
      target.parametricRimLiftFactor = 0;
      target.rimLightingMixFactor = 1.0;
    }

    // ---- shader patches (surface only)
    const own = patchMToon(m, shared, {
      face: kind === 'face' && !!face,
      hair: kind === 'hair',
      rimLit: 1,
      backRim: { cloth: 1.0, skin: 0.75, face: 0.55, hair: 0.9 }[kind] ?? 0,
      emisLit: kind === 'hair' ? 1 : 0,
      hairSpec: HAIR_SPEC[quality] ?? HAIR_SPEC.high,
      hairShift: 0.0,
      hairLum: kind === 'hair' ? (() => { const c = meanOf(m); return (c.r + c.g + c.b) / 3; })() : 0.5,
    });

    // ---- outlines: thinner, authored colour (or a dark tint of the material's own colour)
    const texMean = toSRGB(textureMean(m.map).multiply(lit));
    texMean.getHSL(_hsl);
    const darkOwn = new THREE.Color().setHSL(_hsl.h, Math.min(_hsl.s, 0.6) * 0.75, Math.min(0.16, _hsl.l * 0.3));
    const authoredOutline = toSRGB(authored.outline);
    const hasAuthored = authored.outline.r + authored.outline.g + authored.outline.b > 0.03;
    let olColor;
    if (kind === 'hair') olColor = new THREE.Color().setHSL(_hsl.h, Math.min(_hsl.s, 0.55) * 0.75, 0.24);
    else if (kind === 'skin' || kind === 'face') olColor = hasAuthored ? authoredOutline : darkOwn.clone().offsetHSL(0, 0, 0.08);
    else olColor = hasAuthored ? authoredOutline.clone().lerp(darkOwn, 0.5) : darkOwn;
    for (const ol of outlines) {
      summary.outlines++;
      if (!ol.outlineWidthFactor) summary.generatedOutlines++;
      ol.outlineWidthMode = 'screenCoordinates';
      ol.outlineWidthFactor = OUTLINE_WIDTH[kind === 'hair' ? 'hair' : kind === 'face' ? 'face' : 'body'];
      ol.outlineColorFactor.copy(fromSRGB(olColor));
      // dark albedo would crush a lighting-mixed line to black (the "cold near-black" outline): half mix on cloth/hair
      ol.outlineLightingMixFactor = kind === 'cloth' || kind === 'hair' ? 0.5 : 1.0;
      ol.userData.outlineKind = kind;
      ol.userData.minor = MINOR.test(m.name);
      ol.visible = true;
    }
    all.push({ name: m.name, kind, material: m, outlines, uniforms: own });
  }
  vrm.scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m && !m.isMToonMaterial) summary.pbr++; });

  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
  const api = {
    summary, entries: all, shared, face,
    /** Low: body/hair outlines only, no hair ring. Medium/High: every major primitive. */
    setQuality(q) {
      for (const e of all) {
        for (const ol of e.outlines) ol.userData.qualityOn = !(q === 'low' && ol.userData.minor);
        if (e.kind === 'hair' && e.uniforms) e.uniforms.uHairSpec.value = HAIR_SPEC[q] ?? HAIR_SPEC.high;
      }
      api.applyVisibility();
    },
    outlinesEnabled: true,
    setOutlines(on) { api.outlinesEnabled = !!on; api.applyVisibility(); },
    applyVisibility() {
      for (const e of all) for (const ol of e.outlines) ol.visible = api.outlinesEnabled && e.kind !== 'detail' && ol.userData.qualityOn !== false && !api.wireframe;
    },
    wireframe: false,
    setWireframe(on) {
      api.wireframe = !!on;
      vrm.scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m && !m.isOutline) m.wireframe = api.wireframe; });
      api.applyVisibility();
    },
    /** Global outline width multiplier (e.g. for very small/large viewports). */
    setOutlineScale(s) {
      for (const e of all) for (const ol of e.outlines) ol.outlineWidthFactor = OUTLINE_WIDTH[e.kind === 'hair' ? 'hair' : e.kind === 'face' ? 'face' : 'body'] * s;
    },
    /**
     * Per-frame light/camera uniforms. Call right before rendering (camera matrices current).
     * @param {THREE.Camera} camera
     * @param {{key: THREE.DirectionalLight, rim?: {direction: THREE.Vector3, color: THREE.Color, intensity: number}}} lights
     */
    updateFrame(camera, lights) {
      const view = camera.matrixWorldInverse;
      const key = lights.key;
      _w.copy(key.position).sub(key.target.position).normalize(); // world, toward the key
      shared.uKeyDirView.value.copy(_w).transformDirection(view);
      if (lights.rim) {
        shared.uBackDirView.value.copy(lights.rim.direction).transformDirection(view);
        shared.uBackRimColor.value.copy(lights.rim.color).multiplyScalar(lights.rim.intensity);
      } else shared.uBackRimColor.value.setRGB(0, 0, 0);
      if (headProxy) {
        headProxy.updateWorldMatrix(true, false);
        _m.copy(headProxy.matrixWorld).invert();
        shared.uHeadInv.value.copy(_m);
        shared.uHeadLight.value.copy(_w).transformDirection(_m);
        headProxy.getWorldQuaternion(_q);
        shared.uHeadUpView.value.set(0, 1, 0).applyQuaternion(_q).transformDirection(view);
      }
      void _v;
    },
  };
  api.setQuality(quality);
  return api;
}
