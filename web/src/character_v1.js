// v1 (legacy, kept for comparison only; not imported by the game). Procedurally built, rigidly rigged, toon-shaded anime hero.
//
//   import { createCharacter } from './character.js';
//   const hero = createCharacter();
//   scene.add(hero.root);
//   // each frame: drive hero.bones.* rotations, then hero.update(dt, time)
//
// Rest pose: T-pose, facing +Z, Y up, feet at y = 0, height ~1.75.
// Character's LEFT arm points along +X, RIGHT arm along -X. All joints have
// identity rotation and unit scale at rest; each joint origin sits exactly on
// its anatomical pivot.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Proportions (metres). World-space rest positions are derived from these.
// ---------------------------------------------------------------------------
const DIM = {
  hipsY: 0.95,
  spineUp: 0.10, // hips -> spine
  chestUp: 0.20, // spine -> chest
  neckUp: 0.20, // chest -> neck
  headUp: 0.07, // neck -> head pivot (base of skull / top of neck)
  headTop: 0.23, // head pivot -> top of skull
  clavicle: [0.05, 0.16], // chest -> shoulder (x, y)
  shoulderToArm: 0.14, // shoulder -> upper-arm joint (x)
  upperArm: 0.27,
  foreArm: 0.24,
  hand: 0.17, // wrist -> fingertip
  hipOffset: [0.09, -0.05], // hips -> thigh joint (x, y)
  thigh: 0.42,
  shin: 0.40,
  ankleToSole: 0.08,
  toe: 0.17,
};

const COLORS = {
  skin: 0xf3c9a4,
  skinLine: 0xc98d6c,
  hair: 0x1c1c26,
  shirt: 0xd62b2e,
  shirtDark: 0xa41c22,
  gold: 0xf2c230,
  sash: 0xf7cc2f,
  denim: 0x3c6fb8,
  fur: 0xf7f6f0,
  sole: 0x6b4426,
  strap: 0x8e5a2e,
  outline: 0x16100f,
  mouth: 0x5a1218,
  tongue: 0xe0646a,
  white: 0xffffff,
  pupil: 0x101014,
  lash: 0x121212,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Smooth a list of [r, y] control points (ascending y) into Vector2s. */
function smoothProfile(pts, n = 32) {
  const curve = new THREE.SplineCurve(pts.map(([r, y]) => new THREE.Vector2(r, y)));
  return curve.getPoints(n);
}

/** Interpolated radius of a profile (Vector2 x=r, y=y, ascending y) at height y. */
function radiusAt(profile, y) {
  if (y <= profile[0].y) return profile[0].x;
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / Math.max(1e-6, b.y - a.y);
      return lerp(a.x, b.x, t);
    }
  }
  return profile[profile.length - 1].x;
}

/** Lathe around Y, baked elliptical scale. */
function latheGeo(profile, segs = 24, sx = 1, sz = 1) {
  const g = new THREE.LatheGeometry(profile, segs);
  if (sx !== 1 || sz !== 1) g.scale(sx, 1, sz);
  return g;
}

/**
 * Lathe-like open shell (for an open-front shirt). The front opening (+Z) has
 * a half-angle openFn(t) where t = 0 at the bottom of the profile, 1 at top.
 */
function shellGeo(profile, openFn, sx, sz, segU = 36) {
  const nV = profile.length;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j < nV; j++) {
    const t = j / (nV - 1);
    const a = openFn(t);
    const r = profile[j].x;
    const y = profile[j].y;
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const phi = a + u * (Math.PI * 2 - 2 * a);
      pos.push(sx * r * Math.sin(phi), y, sz * r * Math.cos(phi));
      uv.push(u, t);
    }
  }
  for (let j = 0; j < nV - 1; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + segU + 1;
      const c = b + 1;
      const d = a + 1;
      idx.push(a, d, b, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Point on the opening edge of a shell. side = +1 (character left, +X) or -1. */
function shellEdgePoint(profile, openFn, sx, sz, y, side, inset = 0.1, lift = 0.004) {
  const y0 = profile[0].y;
  const y1 = profile[profile.length - 1].y;
  const t = clamp((y - y0) / (y1 - y0), 0, 1);
  const a = openFn(t) + inset;
  const r = radiusAt(profile, y) + lift;
  return new THREE.Vector3(side * sx * r * Math.sin(a), y, sz * r * Math.cos(a));
}

/** Dynamic grid ribbon used for the mouth layers. */
function makeRibbonGeo(nu, nv) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', attr);
  const idx = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j;
      const b = (i + 1) * (nv + 1) + j;
      const c = a + 1;
      const d = b + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  g.setIndex(idx);
  g.userData.nu = nu;
  g.userData.nv = nv;
  return g;
}

function fillRibbon(geo, x0, x1, topFn, botFn, zOff, R) {
  const { nu, nv } = geo.userData;
  const p = geo.attributes.position.array;
  let k = 0;
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    const x = lerp(x0, x1, u);
    const yt = topFn(u);
    const yb = botFn(u);
    const z = zOff - (x * x) / (2 * R);
    for (let j = 0; j <= nv; j++) {
      const y = lerp(yt, yb, j / nv);
      p[k++] = x;
      p[k++] = y;
      p[k++] = z;
    }
  }
  geo.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
function makeGradientMap() {
  const data = new Uint8Array([100, 180, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Inverted-hull outline material: black, BackSide, vertices pushed out along
 * the view-space normal (so the shell is a uniformly "scaled" clone regardless
 * of the mesh's non-uniform scale). Thickness grows slightly with distance so
 * it stays readable from a game camera.
 */
function makeOutlineMaterial(thickness, color) {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.userData.thickness = thickness;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: mat.userData.thickness };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uOutline;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec3 oN = normalize( normalMatrix * normal );
          float oT = uOutline * clamp( -mvPosition.z / 2.5, 1.0, 3.0 );
          mvPosition.xyz += oN * oT;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'toon-hull-outline';
  return mat;
}

// ---------------------------------------------------------------------------
// createCharacter
// ---------------------------------------------------------------------------
/**
 * @param {object} [options]
 * @param {boolean} [options.outline=true]   inverted-hull outlines
 * @param {number}  [options.outlineScale=1] multiply outline thickness
 * @param {boolean} [options.castShadow=true]
 * @param {boolean} [options.receiveShadow=true]
 * @param {string}  [options.expression='happy']
 */
export function createCharacter(options = {}) {
  const opt = {
    outline: true,
    outlineScale: 1,
    castShadow: true,
    receiveShadow: true,
    expression: 'happy',
    ...options,
  };

  const gradientMap = makeGradientMap();
  const toonCache = new Map();
  const basicCache = new Map();
  const outlineCache = new Map();

  const toon = (color, side = THREE.FrontSide) => {
    const key = `${color}-${side}`;
    if (!toonCache.has(key)) {
      toonCache.set(key, new THREE.MeshToonMaterial({ color, gradientMap, side }));
    }
    return toonCache.get(key);
  };
  const basic = (color, side = THREE.FrontSide) => {
    const key = `${color}-${side}`;
    if (!basicCache.has(key)) basicCache.set(key, new THREE.MeshBasicMaterial({ color, side }));
    return basicCache.get(key);
  };
  const outlineMat = (t) => {
    const th = +(t * opt.outlineScale).toFixed(5);
    if (!outlineCache.has(th)) outlineCache.set(th, makeOutlineMaterial(th, COLORS.outline));
    return outlineCache.get(th);
  };
  const noRaycast = () => {};

  /** Add a mesh to a joint (+ optional inverted-hull outline as its child). */
  function part(parent, geo, mat, o = {}) {
    const m = new THREE.Mesh(geo, mat);
    if (o.pos) m.position.set(...o.pos);
    if (o.rot) m.rotation.set(...o.rot);
    if (o.scale) m.scale.set(...o.scale);
    if (o.quat) m.quaternion.copy(o.quat);
    m.castShadow = o.shadow !== false && opt.castShadow;
    m.receiveShadow = o.receive !== false && opt.receiveShadow;
    if (o.name) m.name = o.name;
    parent.add(m);
    const t = o.outline === undefined ? 0.006 : o.outline;
    if (opt.outline && t > 0) {
      const hull = new THREE.Mesh(geo, outlineMat(t));
      hull.castShadow = false;
      hull.receiveShadow = false;
      hull.raycast = noRaycast;
      hull.name = 'outline';
      m.add(hull);
      m.userData.outline = hull;
    }
    return m;
  }

  const joint = (name, parent, x, y, z) => {
    const j = new THREE.Group();
    j.name = name;
    j.position.set(x, y, z);
    parent.add(j);
    return j;
  };

  // Shared primitive geometries
  const unitSphere = new THREE.SphereGeometry(1, 20, 14);
  const lowSphere = new THREE.SphereGeometry(1, 12, 8);

  // -------------------------------------------------------------------------
  // Skeleton
  // -------------------------------------------------------------------------
  const root = new THREE.Group();
  root.name = 'HeroCharacter';

  const bones = {};
  bones.hips = joint('hips', root, 0, DIM.hipsY, 0);
  bones.spine = joint('spine', bones.hips, 0, DIM.spineUp, 0);
  bones.chest = joint('chest', bones.spine, 0, DIM.chestUp, 0);
  bones.neck = joint('neck', bones.chest, 0, DIM.neckUp, 0);
  bones.head = joint('head', bones.neck, 0, DIM.headUp, 0);
  bones.headTop = joint('headTop', bones.head, 0, DIM.headTop, 0);

  for (const [side, s] of [['left', 1], ['right', -1]]) {
    const sh = joint(`${side}Shoulder`, bones.chest, s * DIM.clavicle[0], DIM.clavicle[1], 0);
    const ua = joint(`${side}UpperArm`, sh, s * DIM.shoulderToArm, 0, 0);
    const fa = joint(`${side}ForeArm`, ua, s * DIM.upperArm, 0, 0);
    const hd = joint(`${side}Hand`, fa, s * DIM.foreArm, 0, 0);
    const tip = joint(`${side}HandTip`, hd, s * DIM.hand, 0, 0);
    bones[`${side}Shoulder`] = sh;
    bones[`${side}UpperArm`] = ua;
    bones[`${side}ForeArm`] = fa;
    bones[`${side}Hand`] = hd;
    bones[`${side}HandTip`] = tip;

    const th = joint(`${side}Thigh`, bones.hips, s * DIM.hipOffset[0], DIM.hipOffset[1], 0);
    const sn = joint(`${side}Shin`, th, 0, -DIM.thigh, 0);
    const ft = joint(`${side}Foot`, sn, 0, -DIM.shin, 0);
    const toe = joint(`${side}Toe`, ft, 0, -DIM.ankleToSole + 0.015, DIM.toe);
    bones[`${side}Thigh`] = th;
    bones[`${side}Shin`] = sn;
    bones[`${side}Foot`] = ft;
    bones[`${side}Toe`] = toe;
  }

  // -------------------------------------------------------------------------
  // Torso
  // -------------------------------------------------------------------------
  const skin = toon(COLORS.skin);
  const TORSO_SX = 1.05;
  const TORSO_SZ = 0.68;

  // Chest (chest-local; world y = 1.25 + y)
  const chestProfile = smoothProfile([
    [0.0, -0.075],
    [0.118, -0.065],
    [0.126, 0.0],
    [0.14, 0.07],
    [0.148, 0.12],
    [0.15, 0.16],
    [0.132, 0.196],
    [0.085, 0.216],
    [0.045, 0.226],
    [0.0, 0.23],
  ]);
  part(bones.chest, latheGeo(chestProfile, 28, TORSO_SX, TORSO_SZ), skin, { name: 'chest' });

  // Abdomen (spine-local; world y = 1.05 + y)
  const absProfile = smoothProfile([
    [0.0, -0.15],
    [0.1, -0.14],
    [0.112, -0.06],
    [0.11, 0.04],
    [0.116, 0.13],
    [0.124, 0.2],
    [0.1, 0.245],
    [0.0, 0.255],
  ]);
  part(bones.spine, latheGeo(absProfile, 28, TORSO_SX, TORSO_SZ), skin, { name: 'abdomen' });

  // Surface helpers for drawing muscle lines on the torso.
  const torsoPoint = (profile, x, y, lift = 0.0015) => {
    const r = radiusAt(profile, y) + lift;
    const xx = x / TORSO_SX;
    const z = TORSO_SZ * Math.sqrt(Math.max(r * r - xx * xx, 0));
    return new THREE.Vector3(x, y, z);
  };
  const lineMat = basic(COLORS.skinLine);
  const addLine = (parent, profile, pts2d, radius = 0.0028) => {
    const pts = pts2d.map(([x, y]) => torsoPoint(profile, x, y));
    const curve = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(curve, 16, radius, 5, false);
    part(parent, g, lineMat, { outline: 0, shadow: false, receive: false });
  };
  // Pec lines (chest local)
  for (const s of [1, -1]) {
    addLine(bones.chest, chestProfile, [
      [s * 0.012, 0.09],
      [s * 0.04, 0.066],
      [s * 0.075, 0.064],
      [s * 0.098, 0.078],
    ]);
  }
  addLine(bones.chest, chestProfile, [
    [0, 0.135],
    [0, 0.1],
    [0, 0.07],
  ], 0.0022);
  // Abs (spine local)
  addLine(bones.spine, absProfile, [
    [0, 0.17],
    [0, 0.1],
    [0, 0.03],
  ], 0.0024);
  for (const y of [0.135, 0.075]) {
    for (const s of [1, -1]) {
      addLine(bones.spine, absProfile, [
        [s * 0.012, y + 0.003],
        [s * 0.03, y],
        [s * 0.046, y + 0.004],
      ], 0.0022);
    }
  }
  for (const s of [1, -1]) {
    // oblique / v-line hint
    addLine(bones.spine, absProfile, [
      [s * 0.075, 0.1],
      [s * 0.07, 0.04],
      [s * 0.05, -0.02],
    ], 0.0022);
  }
  // navel
  part(bones.spine, lowSphere, lineMat, {
    pos: torsoPoint(absProfile, 0, 0.0, -0.002).toArray(),
    scale: [0.006, 0.008, 0.004],
    outline: 0,
    shadow: false,
  });

  // Neck
  {
    const g = new THREE.CylinderGeometry(0.042, 0.047, 0.13, 16, 1, true);
    g.translate(0, 0.045, 0);
    part(bones.neck, g, skin, { name: 'neck', outline: 0.005 });
  }

  // -------------------------------------------------------------------------
  // Shirt (open red short shirt)
  // -------------------------------------------------------------------------
  const shirtMat = toon(COLORS.shirt, THREE.DoubleSide);
  const shirtChestProfile = chestProfile
    .filter((p) => p.y > -0.035 && p.y < 0.222)
    .map((p) => new THREE.Vector2(p.x + 0.013, p.y));
  shirtChestProfile.unshift(new THREE.Vector2(radiusAt(chestProfile, -0.04) + 0.014, -0.04));
  const shirtChestOpen = (t) => lerp(0.86, 0.62, Math.pow(t, 0.7));
  part(bones.chest, shellGeo(shirtChestProfile, shirtChestOpen, TORSO_SX, TORSO_SZ), shirtMat, {
    name: 'shirtChest',
    outline: 0.005,
  });

  const shirtAbsProfile = absProfile
    .filter((p) => p.y > -0.055 && p.y < 0.235)
    .map((p) => new THREE.Vector2(p.x + 0.015 + 0.02 * clamp((0.0 - p.y) / 0.06, 0, 1), p.y));
  shirtAbsProfile.unshift(new THREE.Vector2(radiusAt(absProfile, -0.06) + 0.04, -0.07));
  const shirtAbsOpen = (t) => lerp(1.25, 0.86, Math.pow(t, 0.8));
  part(bones.spine, shellGeo(shirtAbsProfile, shirtAbsOpen, TORSO_SX, TORSO_SZ), shirtMat, {
    name: 'shirtAbs',
    outline: 0.005,
  });

  // Collar band
  {
    const collarProfile = smoothProfile([
      [0.07, 0.19],
      [0.078, 0.215],
      [0.09, 0.245],
    ], 8);
    part(bones.chest, shellGeo(collarProfile, () => 0.95, 1.0, 0.95, 24), toon(COLORS.shirtDark, THREE.DoubleSide), {
      name: 'collar',
      outline: 0.004,
    });
  }

  // Gold buttons along both open edges
  {
    const btnMat = toon(COLORS.gold);
    for (const s of [1, -1]) {
      for (const y of [0.12, 0.03]) {
        const p = shellEdgePoint(shirtChestProfile, shirtChestOpen, TORSO_SX, TORSO_SZ, y, s, 0.1, 0.004);
        part(bones.chest, lowSphere, btnMat, { pos: p.toArray(), scale: [0.0095, 0.0095, 0.006], outline: 0.0025 });
      }
      for (const y of [0.13, 0.04]) {
        const p = shellEdgePoint(shirtAbsProfile, shirtAbsOpen, TORSO_SX, TORSO_SZ, y, s, 0.1, 0.004);
        part(bones.spine, lowSphere, btnMat, { pos: p.toArray(), scale: [0.0095, 0.0095, 0.006], outline: 0.0025 });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Arms
  // -------------------------------------------------------------------------
  const sleeveMat = toon(COLORS.shirt, THREE.DoubleSide);
  const upperArmProfile = smoothProfile([
    [0.0, -0.03],
    [0.05, -0.02],
    [0.048, 0.06],
    [0.044, 0.17],
    [0.04, 0.26],
    [0.0, 0.28],
  ], 16);
  const foreArmProfile = smoothProfile([
    [0.0, -0.02],
    [0.04, -0.01],
    [0.044, 0.06],
    [0.038, 0.16],
    [0.031, 0.235],
    [0.0, 0.25],
  ], 16);
  const sleeveProfile = smoothProfile([
    [0.074, -0.03],
    [0.08, 0.05],
    [0.092, 0.15],
    [0.118, 0.24],
    [0.138, 0.3],
  ], 16);

  for (const [side, s] of [['left', 1], ['right', -1]]) {
    const ua = bones[`${side}UpperArm`];
    const fa = bones[`${side}ForeArm`];
    const hd = bones[`${side}Hand`];
    const toAxis = (g) => g.rotateZ(-s * Math.PI / 2); // +Y -> s*X

    // Shoulder cap (shirt) + upper arm skin
    part(ua, unitSphere, toon(COLORS.shirt), { pos: [s * 0.0, 0.008, 0], scale: [0.085, 0.08, 0.075], outline: 0.005 });
    part(ua, toAxis(latheGeo(upperArmProfile, 16)), skin, { name: `${side}UpperArmSkin`, outline: 0.005 });

    // Bell sleeve (elbow length) + darker hem trim
    part(ua, toAxis(latheGeo(sleeveProfile, 28)), sleeveMat, { name: `${side}Sleeve`, outline: 0.005 });
    {
      const trim = new THREE.TorusGeometry(0.137, 0.008, 6, 32);
      trim.rotateX(Math.PI / 2);
      trim.translate(0, 0.298, 0);
      part(ua, toAxis(trim), toon(COLORS.shirtDark), { outline: 0.003 });
    }

    // Forearm skin + elbow ball
    part(fa, unitSphere, skin, { scale: [0.042, 0.042, 0.042], outline: 0.004 });
    part(fa, toAxis(latheGeo(foreArmProfile, 16)), skin, { name: `${side}ForeArmSkin`, outline: 0.005 });

    // Mitten hand (palm down, thumb forward +Z)
    part(hd, unitSphere, skin, { pos: [s * 0.045, 0, 0], scale: [0.055, 0.024, 0.043], outline: 0.004 });
    {
      const fingers = new THREE.CapsuleGeometry(0.02, 0.065, 6, 12);
      fingers.rotateZ(Math.PI / 2);
      part(hd, fingers, skin, {
        pos: [s * 0.117, -0.002, 0],
        scale: [1, 0.95, 2.0],
        outline: 0.004,
      });
      const thumb = new THREE.CapsuleGeometry(0.0125, 0.04, 4, 10);
      thumb.translate(0, 0.02, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(s * 0.55, -0.12, 0.83).normalize(),
      );
      part(hd, thumb, skin, { pos: [s * 0.035, -0.004, 0.03], quat: q, outline: 0.004 });
    }
  }

  // -------------------------------------------------------------------------
  // Hips: shorts, sash
  // -------------------------------------------------------------------------
  const denim = toon(COLORS.denim);
  const PELVIS_SX = 1.05;
  const PELVIS_SZ = 0.76;
  const pelvisProfile = smoothProfile([
    [0.0, -0.165],
    [0.09, -0.155],
    [0.145, -0.12],
    [0.158, -0.06],
    [0.156, 0.0],
    [0.15, 0.05],
    [0.138, 0.075],
    [0.0, 0.08],
  ]);
  part(bones.hips, latheGeo(pelvisProfile, 28, PELVIS_SX, PELVIS_SZ), denim, { name: 'shortsPelvis' });

  // Sash band
  const sashMat = toon(COLORS.sash, THREE.DoubleSide);
  const sashY = 0.03;
  {
    const r = radiusAt(pelvisProfile, sashY) + 0.006;
    const g = new THREE.TorusGeometry(r, 0.026, 10, 40);
    g.rotateX(Math.PI / 2);
    g.scale(PELVIS_SX, 1.35, PELVIS_SZ);
    g.translate(0, sashY, 0);
    part(bones.hips, g, toon(COLORS.sash), { name: 'sash', outline: 0.005 });
  }

  // Knot on the character's left hip (+X), slightly toward the front
  const knotYaw = THREE.MathUtils.degToRad(58);
  const knot = new THREE.Group();
  {
    const r = radiusAt(pelvisProfile, sashY) + 0.03;
    knot.position.set(PELVIS_SX * r * Math.sin(knotYaw), sashY - 0.005, PELVIS_SZ * r * Math.cos(knotYaw) + 0.012);
    knot.rotation.y = knotYaw;
    bones.hips.add(knot);
    part(knot, unitSphere, toon(COLORS.sash), { scale: [0.028, 0.03, 0.02], outline: 0.004 });
    for (const s of [1, -1]) {
      part(knot, unitSphere, toon(COLORS.sash), {
        pos: [s * 0.03, 0.008, -0.004],
        rot: [0, 0, s * 0.45],
        scale: [0.034, 0.02, 0.012],
        outline: 0.004,
      });
    }
  }

  // Hanging tails (spring chains)
  const tails = [];
  function buildTail(offset, segLens, width, restBias) {
    const chain = [];
    let parent = knot;
    let pos = offset;
    const total = segLens.reduce((a, b) => a + b, 0);
    let acc = 0;
    segLens.forEach((len, i) => {
      const pivot = new THREE.Group();
      pivot.position.copy(pos);
      parent.add(pivot);
      const g = new THREE.BoxGeometry(width, len, 0.012, 1, 3, 1);
      g.translate(0, -len / 2, 0);
      // taper along the full tail length, plus a little end flare
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const y = p.getY(k);
        const along = (acc - y) / total;
        const w = lerp(1.0, 0.72, along) + (i === segLens.length - 1 && y < -len * 0.85 ? 0.12 : 0);
        p.setX(k, p.getX(k) * w);
      }
      g.computeVertexNormals();
      part(pivot, g, sashMat, { outline: 0.004 });
      chain.push({ pivot, dir: new THREE.Vector3(0, -1, 0), vel: new THREE.Vector3() });
      parent = pivot;
      pos = new THREE.Vector3(0, -len, 0);
      acc += len;
    });
    tails.push({ chain, restBias });
  }
  buildTail(new THREE.Vector3(-0.004, -0.02, 0.008), [0.12, 0.12, 0.12], 0.058, new THREE.Vector3(0.1, 0, 0.12));
  buildTail(new THREE.Vector3(0.018, -0.02, 0.0), [0.085, 0.085], 0.045, new THREE.Vector3(0.28, 0, 0.1));

  // -------------------------------------------------------------------------
  // Legs
  // -------------------------------------------------------------------------
  const shortsLegProfile = smoothProfile([
    [0.114, -0.385],
    [0.106, -0.3],
    [0.104, -0.15],
    [0.106, -0.02],
    [0.098, 0.07],
  ], 16);
  const thighSkinProfile = smoothProfile([
    [0.0, -0.44],
    [0.05, -0.43],
    [0.065, -0.3],
    [0.075, -0.1],
    [0.0, 0.0],
  ], 12);
  const shinProfile = smoothProfile([
    [0.0, -0.405],
    [0.031, -0.4],
    [0.036, -0.35],
    [0.043, -0.25],
    [0.054, -0.13],
    [0.05, -0.04],
    [0.046, 0.0],
    [0.0, 0.02],
  ], 18);
  const furMat = toon(COLORS.fur);
  const rngFur = mulberry32(1337);
  function furCuffGeo() {
    const geos = [];
    const rows = [
      { y: -0.372, r: 0.114, n: 17, size: 0.031 },
      { y: -0.402, r: 0.11, n: 17, size: 0.027 },
    ];
    rows.forEach((row, ri) => {
      for (let i = 0; i < row.n; i++) {
        const a = ((i + (ri ? 0.5 : 0)) / row.n) * Math.PI * 2 + (rngFur() - 0.5) * 0.15;
        const sz = row.size * (0.85 + rngFur() * 0.3);
        const g = new THREE.SphereGeometry(sz, 9, 7);
        g.translate(
          Math.sin(a) * (row.r + (rngFur() - 0.5) * 0.006),
          row.y + (rngFur() - 0.5) * 0.008,
          Math.cos(a) * (row.r + (rngFur() - 0.5) * 0.006),
        );
        geos.push(g);
      }
    });
    const merged = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    return merged;
  }

  const shortsLegMat = toon(COLORS.denim, THREE.DoubleSide);
  const soleMat = toon(COLORS.sole);
  const strapMat = toon(COLORS.strap);
  for (const [side, s] of [['left', 1], ['right', -1]]) {
    const th = bones[`${side}Thigh`];
    const sn = bones[`${side}Shin`];
    const ft = bones[`${side}Foot`];

    part(th, latheGeo(thighSkinProfile, 14), skin, { outline: 0 });
    part(th, latheGeo(shortsLegProfile, 26), shortsLegMat, { name: `${side}ShortsLeg`, outline: 0.005 });
    part(th, furCuffGeo(), furMat, { name: `${side}FurCuff`, outline: 0.004 });

    // Knee + shin
    part(sn, unitSphere, skin, { scale: [0.05, 0.05, 0.05], outline: 0.004 });
    part(sn, latheGeo(shinProfile, 18), skin, { name: `${side}ShinSkin`, outline: 0.005 });

    // Foot + sandal
    part(ft, unitSphere, skin, { pos: [0, -0.012, 0], scale: [0.036, 0.034, 0.036], outline: 0 });
    {
      const footG = new THREE.CapsuleGeometry(0.038, 0.13, 6, 14);
      footG.rotateX(Math.PI / 2);
      part(ft, footG, skin, { pos: [s * 0.004, -0.04, 0.052], scale: [1.15, 0.72, 1.0], outline: 0.004 });
      // toes hint
      for (let i = 0; i < 3; i++) {
        part(ft, lowSphere, skin, {
          pos: [s * (0.022 - i * 0.02), -0.05, 0.145 - i * 0.004],
          scale: [0.012, 0.011, 0.014],
          outline: 0.0025,
        });
      }
      const soleG = new THREE.CapsuleGeometry(0.05, 0.15, 6, 16);
      soleG.rotateX(Math.PI / 2);
      part(ft, soleG, soleMat, { pos: [s * 0.004, -0.068, 0.05], scale: [1.0, 0.25, 1.0], outline: 0.004 });
      for (const [z, rr] of [[0.095, 0.05], [0.02, 0.047]]) {
        const st = new THREE.TorusGeometry(rr, 0.008, 6, 16, Math.PI);
        part(ft, st, strapMat, { pos: [s * 0.004, -0.062, z], scale: [1.0, 0.75, 1.3], outline: 0.003 });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Head
  // -------------------------------------------------------------------------
  const headProfile = smoothProfile([
    [0.0, -0.006],
    [0.036, 0.0],
    [0.07, 0.018],
    [0.098, 0.048],
    [0.114, 0.08],
    [0.121, 0.11],
    [0.12, 0.14],
    [0.11, 0.175],
    [0.087, 0.204],
    [0.052, 0.223],
    [0.0, 0.23],
  ], 40);
  part(bones.head, latheGeo(headProfile, 32), skin, { name: 'headSkull', outline: 0.006, receive: false });

  // Ears
  for (const s of [1, -1]) {
    part(bones.head, unitSphere, skin, {
      pos: [s * 0.118, 0.094, -0.008],
      scale: [0.022, 0.034, 0.027],
      outline: 0.004,
    });
  }

  /** Place obj on the face surface at (x, y) (head local), facing outward. */
  function facePlace(obj, x, y, lift = 0) {
    const r = radiusAt(headProfile, y);
    const dy = 0.004;
    const slope = (radiusAt(headProfile, y + dy) - radiusAt(headProfile, y - dy)) / (2 * dy);
    const z = Math.sqrt(Math.max(r * r - x * x, 1e-6));
    const n = new THREE.Vector3(x / r, -slope, z / r).normalize();
    obj.position.set(x, y, z).addScaledVector(n, lift);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    return r;
  }

  const face = new THREE.Group();
  face.name = 'face';
  bones.head.add(face);

  // Nose (tiny)
  {
    const n = new THREE.Group();
    facePlace(n, 0, 0.062, 0.0);
    face.add(n);
    part(n, lowSphere, skin, { scale: [0.008, 0.007, 0.008], outline: 0, shadow: false });
  }

  // Eyes
  const EYE = { x: 0.046, y: 0.09, hw: 0.027, hh: 0.037 };
  const eyes = [];
  const whiteMat = basic(COLORS.white);
  const pupilMat = basic(COLORS.pupil);
  const lashMat = basic(COLORS.lash);
  for (const s of [1, -1]) {
    const g = new THREE.Group();
    facePlace(g, s * EYE.x, EYE.y, -0.001);
    face.add(g);
    const inner = new THREE.Group(); // scaled by expression
    g.add(inner);
    const sclera = part(inner, unitSphere, whiteMat, { scale: [EYE.hw, EYE.hh, 0.0095], outline: 0.0028, shadow: false, receive: false });
    const pupil = new THREE.Group();
    inner.add(pupil);
    pupil.position.set(-s * 0.002, -0.004, 0.0);
    part(pupil, unitSphere, pupilMat, { pos: [0, 0, 0.004], scale: [0.0165, 0.025, 0.0068], outline: 0, shadow: false, receive: false });
    part(pupil, lowSphere, whiteMat, { pos: [0.0065, 0.010, 0.0095], scale: [0.0058, 0.0068, 0.0025], outline: 0, shadow: false, receive: false });
    part(pupil, lowSphere, whiteMat, { pos: [-0.006, -0.011, 0.0092], scale: [0.0028, 0.0028, 0.0022], outline: 0, shadow: false, receive: false });

    // little outer lash flick
    part(inner, lowSphere, lashMat, {
      pos: [s * EYE.hw * 1.12, 0.006, 0.004],
      rot: [0, 0, s * -0.6],
      scale: [0.0075, 0.0032, 0.003],
      outline: 0,
      shadow: false,
    });

    // Upper lash line + eyelid: dynamic ribbons. The lash arc flattens and then
    // flips into a "‿" curve as the lid closes; the lid fills the area above it.
    const lashGeo = makeRibbonGeo(20, 1);
    const lash = new THREE.Mesh(lashGeo, lashMat);
    lash.frustumCulled = false;
    inner.add(lash);
    const lidRibGeo = makeRibbonGeo(20, 3);
    {
      const cnt = lidRibGeo.attributes.position.count;
      const nrm = new Float32Array(cnt * 3);
      for (let i = 0; i < cnt; i++) nrm[i * 3 + 2] = 1;
      lidRibGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    }
    const lid = new THREE.Mesh(lidRibGeo, toon(COLORS.skin, THREE.DoubleSide));
    lid.frustumCulled = false;
    inner.add(lid);

    // Brow
    const brow = new THREE.Group();
    facePlace(brow, s * 0.047, 0.149, 0.003);
    face.add(brow);
    const browRot = new THREE.Group();
    brow.add(browRot);
    const bg = new THREE.CapsuleGeometry(0.0058, 0.03, 4, 8);
    bg.rotateZ(Math.PI / 2);
    part(browRot, bg, lashMat, { scale: [1, 1, 0.45], rot: [0, 0, s * 0.06], outline: 0, shadow: false, receive: false });

    eyes.push({ s, group: g, inner, sclera, pupil, lid, lash, brow, browRot, browBaseY: brow.position.y });
  }

  // Mouth (dynamic ribbons on a cylindrical patch matching the face)
  const mouth = new THREE.Group();
  const MOUTH_Y = 0.036;
  const mouthR = facePlace(mouth, 0, MOUTH_Y, 0.0012);
  face.add(mouth);
  const mouthLayers = {};
  {
    const mk = (name, color, nu, nv) => {
      const g = makeRibbonGeo(nu, nv);
      const m = new THREE.Mesh(g, basic(color, THREE.DoubleSide));
      m.frustumCulled = false;
      m.name = `mouth_${name}`;
      mouth.add(m);
      mouthLayers[name] = m;
    };
    mk('outline', COLORS.lash, 24, 2);
    mk('inner', COLORS.mouth, 24, 2);
    mk('tongue', COLORS.tongue, 16, 2);
    mk('teeth', COLORS.white, 24, 1);
  }

  // -------------------------------------------------------------------------
  // Hair
  // -------------------------------------------------------------------------
  const HAIR_C = new THREE.Vector3(0, 0.116, -0.006);
  const HAIR_R = 0.129;
  const hairPivot = new THREE.Group();
  hairPivot.name = 'hair';
  hairPivot.position.copy(HAIR_C);
  bones.head.add(hairPivot);
  {
    const geos = [];
    // top cap
    const cap = new THREE.SphereGeometry(HAIR_R, 32, 16, 0, Math.PI * 2, 0, 1.18);
    geos.push(cap);
    // back cap (down to the nape)
    const back = new THREE.SphereGeometry(HAIR_R * 0.99, 28, 18, Math.PI + 0.08, Math.PI - 0.16, 0.6, 1.72);
    geos.push(back);

    const rng = mulberry32(42);
    const sph = (yawDeg, elevDeg) => {
      const y = THREE.MathUtils.degToRad(yawDeg);
      const e = THREE.MathUtils.degToRad(elevDeg);
      return new THREE.Vector3(Math.sin(y) * Math.cos(e), Math.sin(e), Math.cos(y) * Math.cos(e));
    };
    // [baseYaw, baseElev, dirYaw, dirElev, length, radius, flatten]
    const spikes = [
      // crown / top
      [0, 86, 175, 62, 0.15, 0.048, 0.75],
      [35, 68, 50, 55, 0.13, 0.042, 0.7],
      [-35, 68, -50, 55, 0.13, 0.042, 0.7],
      [10, 66, 15, 70, 0.11, 0.04, 0.6],
      [-15, 75, -20, 78, 0.12, 0.04, 0.7],
      [80, 62, 95, 45, 0.13, 0.045, 0.7],
      [-80, 62, -95, 45, 0.13, 0.045, 0.7],
      [130, 58, 140, 42, 0.14, 0.048, 0.75],
      [-130, 58, -140, 42, 0.14, 0.048, 0.75],
      [180, 62, 180, 40, 0.15, 0.05, 0.75],
      // back
      [155, 35, 155, 8, 0.14, 0.048, 0.75],
      [-155, 35, -155, 8, 0.14, 0.048, 0.75],
      [180, 22, 180, -10, 0.13, 0.048, 0.75],
      [120, 22, 120, -15, 0.12, 0.042, 0.75],
      [-120, 22, -120, -15, 0.12, 0.042, 0.75],
      [150, 0, 155, -42, 0.11, 0.04, 0.75],
      [-150, 0, -155, -42, 0.11, 0.04, 0.75],
      [180, -8, 180, -55, 0.1, 0.04, 0.75],
      // sides
      [95, 32, 100, 12, 0.11, 0.04, 0.7],
      [-95, 32, -100, 12, 0.11, 0.04, 0.7],
      [105, 10, 110, -22, 0.1, 0.036, 0.7],
      [-105, 10, -110, -22, 0.1, 0.036, 0.7],
      // sideburns in front of the ears
      [70, 25, 60, -78, 0.085, 0.024, 0.55],
      [-70, 25, -60, -78, 0.085, 0.024, 0.55],
      // front flick up
      [-8, 64, -5, 45, 0.075, 0.03, 0.6],
    ];
    // bangs: [baseYaw, baseElev, outward, length, radius, flatten, sideSweep]
    // direction = tangent pointing down the forehead, tilted slightly outward
    const bangs = [
      [0, 46, 0.12, 0.08, 0.034, 0.4, 0],
      [20, 47, 0.12, 0.078, 0.033, 0.4, 0.25],
      [-20, 47, 0.12, 0.078, 0.033, 0.4, -0.25],
      [40, 44, 0.14, 0.075, 0.032, 0.42, 0.45],
      [-40, 44, 0.14, 0.075, 0.032, 0.42, -0.45],
      [58, 38, 0.16, 0.07, 0.03, 0.45, 0.5],
      [-58, 38, 0.16, 0.07, 0.03, 0.45, -0.5],
      [10, 52, 0.1, 0.07, 0.03, 0.4, -0.2],
      [-10, 52, 0.1, 0.07, 0.03, 0.4, 0.2],
    ];
    const Y = new THREE.Vector3();
    const Z = new THREE.Vector3();
    const X = new THREE.Vector3();
    const M = new THREE.Matrix4();
    for (const [by, be, dy, de, len, rad, flat] of spikes) {
      const jy = (rng() - 0.5) * 6;
      const je = (rng() - 0.5) * 6;
      const n = sph(by + jy, be + je);
      const d = sph(dy + jy * 1.5, de + je * 1.5).normalize();
      const L = len * (0.92 + rng() * 0.16);
      const g = new THREE.ConeGeometry(rad * 1.25, L, 8, 1, true);
      g.translate(0, L / 2, 0);
      g.scale(1, 1, flat);
      Y.copy(d);
      Z.copy(n).addScaledVector(Y, -n.dot(Y));
      if (Z.lengthSq() < 1e-5) Z.set(0, 0, 1).addScaledVector(Y, -Y.z);
      Z.normalize();
      X.crossVectors(Y, Z).normalize();
      M.makeBasis(X, Y, Z);
      M.setPosition(n.clone().multiplyScalar(HAIR_R * 0.9));
      g.applyMatrix4(M);
      geos.push(g);
    }
    for (const [by, be, outward, len, rad, flat, sweep] of bangs) {
      const jy = (rng() - 0.5) * 4;
      const n = sph(by + jy, be + (rng() - 0.5) * 4);
      const down = new THREE.Vector3(0, -1, 0).addScaledVector(n, n.y).normalize();
      const side = new THREE.Vector3().crossVectors(n, down).normalize();
      const d = down.clone().addScaledVector(n, outward).addScaledVector(side, -sweep * 0.5).normalize();
      const L = len * (0.92 + rng() * 0.16);
      const g = new THREE.ConeGeometry(rad, L, 8, 1, true);
      g.translate(0, L / 2, 0);
      g.scale(1, 1, flat);
      Y.copy(d);
      Z.copy(n).addScaledVector(Y, -n.dot(Y)).normalize();
      X.crossVectors(Y, Z).normalize();
      M.makeBasis(X, Y, Z);
      M.setPosition(n.clone().multiplyScalar(HAIR_R * 0.97));
      g.applyMatrix4(M);
      geos.push(g);
    }
    const merged = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    part(hairPivot, merged, toon(COLORS.hair, THREE.DoubleSide), { name: 'hairMesh', outline: 0.0055 });
  }

  // -------------------------------------------------------------------------
  // Shadows flags for everything (outline hulls excluded)
  // -------------------------------------------------------------------------
  root.traverse((o) => {
    if (o.isMesh && o.name === 'outline') o.castShadow = false;
  });

  // -------------------------------------------------------------------------
  // Expression / face state
  // -------------------------------------------------------------------------
  const EXPRESSIONS = {
    neutral: { browY: 0, browRot: 0, lid: 0.04, eye: 1, pupil: 1, w: 0.042, h: 0, s: 0.35, round: 0 },
    happy: { browY: 0.004, browRot: -0.12, lid: 0.06, eye: 1, pupil: 1, w: 0.074, h: 0.02, s: 1.0, round: 0 },
    surprised: { browY: 0.013, browRot: -0.06, lid: 0, eye: 1.12, pupil: 0.72, w: 0.03, h: 0.026, s: 0, round: 1 },
    determined: { browY: -0.006, browRot: 0.4, lid: 0.3, eye: 1, pupil: 0.95, w: 0.058, h: 0.009, s: 0.55, round: 0 },
  };
  let exprName = EXPRESSIONS[opt.expression] ? opt.expression : 'happy';
  const exprCur = { ...EXPRESSIONS[exprName] };
  let blinkInput = 0;
  let mouthInput = 0;
  let autoBlinkTimer = 2 + Math.random() * 3;
  let autoBlinkPhase = -1;
  const BLINK_DUR = 0.16;

  // eyelid / lash ribbons (eye-local coordinates)
  const ribbonZ = (x, y) =>
    0.0135 * Math.sqrt(Math.max(0, 1 - (x / (EYE.hw * 1.2)) ** 2 - (y / (EYE.hh * 1.2)) ** 2)) + 0.003;
  function fillEyeRibbon(geo, xw, topFn, botFn, zAdd) {
    const { nu, nv } = geo.userData;
    const p = geo.attributes.position.array;
    let k = 0;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      const x = (2 * u - 1) * xw;
      const yt = topFn(u);
      const yb = botFn(u);
      for (let j = 0; j <= nv; j++) {
        const y = lerp(yt, yb, j / nv);
        p[k++] = x;
        p[k++] = y;
        p[k++] = ribbonZ(x, y) + zAdd;
      }
    }
    geo.attributes.position.needsUpdate = true;
  }
  function updateEyelid(eye, cov) {
    const sArc = 1 - 1.9 * cov; // 1 = open arch, -1 = closed "‿"
    const ef = (u) => Math.sqrt(Math.max(0, 1 - (2 * u - 1) * (2 * u - 1)));
    const arcY = (u) => sArc * EYE.hh * 1.04 * ef(u) - 0.0015 * (1 - cov);
    const outer = (u) => (eye.s > 0 ? u : 1 - u);
    const thick = (u) => (0.0026 + 0.0026 * outer(u)) * (0.4 + 0.6 * Math.pow(ef(u), 0.3));
    const xw = EYE.hw * 1.1;
    fillEyeRibbon(eye.lash.geometry, xw, (u) => arcY(u) + thick(u), (u) => arcY(u) - thick(u) * 0.45, 0.0012);
    eye.lid.visible = cov > 0.01;
    const closed = cov > 0.85;
    if (eye.sclera.userData.outline) eye.sclera.userData.outline.visible = !closed;
    eye.sclera.visible = !closed || cov < 0.97;
    eye.pupil.visible = cov < 0.97;
    if (eye.lid.visible) {
      fillEyeRibbon(eye.lid.geometry, xw, (u) => EYE.hh * 1.2 * ef(u) + 0.0025, (u) => arcY(u) - 0.001, 0.0006);
    }
  }

  function applyFace(blinkCov) {
    const e = exprCur;
    // eyes
    for (const eye of eyes) {
      eye.inner.scale.set(e.eye, e.eye, 1);
      eye.pupil.scale.set(e.pupil, e.pupil, 1);
      const cov = clamp(Math.max(blinkCov, e.lid), 0, 1);
      updateEyelid(eye, cov);
      eye.brow.position.y = eye.browBaseY + e.browY;
      eye.browRot.rotation.z = eye.s * e.browRot;
    }
    // mouth
    const m = mouthInput;
    const h = Math.max(e.h, m * 0.034);
    const w = lerp(e.w, Math.max(e.w * 0.9, 0.048), m * 0.6);
    const round = lerp(e.round, Math.max(e.round, 0.25), m);
    const smile = e.s;
    const cfn = (u) => (2 * u - 1) * (2 * u - 1);
    const efn = (u) => Math.sqrt(Math.max(0, 1 - (2 * u - 1) * (2 * u - 1)));
    const top = (u) => smile * 0.011 * cfn(u) + round * 0.5 * h * efn(u) - smile * 0.002;
    const bot = (u) => smile * 0.011 * cfn(u) - (1 - 0.5 * round) * h * efn(u) - smile * 0.002;
    const ol = 0.0022;
    const wo = w + 0.006;
    fillRibbon(mouthLayers.outline.geometry, -wo / 2, wo / 2, (u) => top(u) + ol, (u) => bot(u) - ol, 0, mouthR);
    const open = h > 0.0025;
    mouthLayers.inner.visible = open;
    mouthLayers.teeth.visible = open && round < 0.6;
    mouthLayers.tongue.visible = h > 0.008;
    if (open) {
      fillRibbon(mouthLayers.inner.geometry, -w / 2, w / 2, top, bot, 0.0005, mouthR);
      const teethH = 0.0085 * (1 - round);
      fillRibbon(
        mouthLayers.teeth.geometry,
        -w / 2 * 0.94,
        w / 2 * 0.94,
        (u) => top(u) - 0.0004,
        (u) => Math.max(bot(u), top(u) - teethH * Math.pow(efn(u), 0.35)),
        0.001,
        mouthR,
      );
      const tu = (u) => 0.22 + 0.56 * u;
      fillRibbon(
        mouthLayers.tongue.geometry,
        -w * 0.28,
        w * 0.28,
        (u) => {
          const k = tu(u);
          return bot(k) + (top(k) - bot(k)) * 0.42 * Math.pow(efn(u), 0.5);
        },
        (u) => bot(tu(u)) + 0.0004,
        0.0008,
        mouthR,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Secondary motion state
  // -------------------------------------------------------------------------
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const hipsPrev = new THREE.Vector3();
  const hipsVel = new THREE.Vector3();
  const headPrev = new THREE.Vector3();
  const headVel = new THREE.Vector3();
  let hasPrev = false;
  let internalTime = 0;
  const hairSpring = { y: 0, vy: 0, rx: 0, vrx: 0, rz: 0, vrz: 0 };

  function springStep(state, key, vkey, target, k, d, dt) {
    const a = (target - state[key]) * k - state[vkey] * d;
    state[vkey] += a * dt;
    state[key] += state[vkey] * dt;
  }

  // initialise tails to their rest direction
  function restDirWorld(bias, hipsQ, out) {
    out.copy(DOWN);
    tmpV2.copy(bias).applyQuaternion(hipsQ);
    out.add(tmpV2).normalize();
    return out;
  }

  function update(dt = 1 / 60, time) {
    dt = clamp(dt || 0, 0, 0.05);
    internalTime += dt;
    const t = time === undefined ? internalTime : time;

    root.updateWorldMatrix(true, true);

    // velocities
    bones.hips.getWorldPosition(tmpV);
    bones.head.getWorldPosition(tmpV2);
    if (!hasPrev || dt <= 0) {
      hipsVel.set(0, 0, 0);
      headVel.set(0, 0, 0);
    } else {
      hipsVel.copy(tmpV).sub(hipsPrev).divideScalar(dt);
      headVel.copy(tmpV2).sub(headPrev).divideScalar(dt);
      if (hipsVel.length() > 8) hipsVel.setLength(8);
      if (headVel.length() > 8) headVel.setLength(8);
    }
    hipsPrev.copy(tmpV);
    headPrev.copy(tmpV2);

    // sash tails: world-space direction springs
    const hipsQ = bones.hips.getWorldQuaternion(new THREE.Quaternion());
    const hipsX = new THREE.Vector3(1, 0, 0).applyQuaternion(hipsQ);
    const hipsZ = new THREE.Vector3(0, 0, 1).applyQuaternion(hipsQ);
    for (const tail of tails) {
      const target = restDirWorld(tail.restBias, hipsQ, new THREE.Vector3());
      target.addScaledVector(hipsVel, -0.22);
      target.addScaledVector(hipsX, Math.sin(t * 1.9) * 0.035);
      target.addScaledVector(hipsZ, Math.sin(t * 1.37 + 1.0) * 0.03);
      target.normalize();
      let prevDir = null;
      tail.chain.forEach((seg, i) => {
        const tgt = prevDir ? tmpV.copy(prevDir).lerp(target, 0.35).normalize() : target;
        if (!hasPrev) {
          seg.dir.copy(tgt);
          seg.vel.set(0, 0, 0);
        } else if (dt > 0) {
          const k = 90 - i * 22;
          const d = 9 - i * 1.6;
          tmpV2.copy(tgt).sub(seg.dir).multiplyScalar(k).addScaledVector(seg.vel, -d);
          seg.vel.addScaledVector(tmpV2, dt);
          seg.dir.addScaledVector(seg.vel, dt).normalize();
        }
        // never let it flip upward
        if (seg.dir.y > -0.15) {
          seg.dir.y = -0.15;
          seg.dir.normalize();
        }
        seg.pivot.parent.getWorldQuaternion(tmpQ);
        tmpQ.invert();
        tmpV2.copy(seg.dir).applyQuaternion(tmpQ);
        seg.pivot.quaternion.setFromUnitVectors(DOWN, tmpV2);
        seg.pivot.updateMatrixWorld(true);
        prevDir = seg.dir;
      });
    }

    // hair bounce
    if (dt > 0) {
      bones.head.getWorldQuaternion(tmpQ2);
      const inv = tmpQ2.clone().invert();
      const lv = tmpV.copy(headVel).applyQuaternion(inv);
      springStep(hairSpring, 'y', 'vy', clamp(-lv.y * 0.006, -0.008, 0.008), 220, 12, dt);
      springStep(hairSpring, 'rx', 'vrx', clamp(lv.z * 0.06 + Math.sin(t * 2.1) * 0.006, -0.12, 0.12), 160, 10, dt);
      springStep(hairSpring, 'rz', 'vrz', clamp(lv.x * 0.06, -0.12, 0.12), 160, 10, dt);
      hairPivot.position.set(HAIR_C.x, HAIR_C.y + hairSpring.y, HAIR_C.z);
      hairPivot.rotation.set(-hairSpring.rx, 0, hairSpring.rz);
    }

    // auto blink
    let autoCov = 0;
    if (autoBlinkPhase >= 0) {
      autoBlinkPhase += dt;
      if (autoBlinkPhase >= BLINK_DUR) {
        autoBlinkPhase = -1;
        autoBlinkTimer = 2 + Math.random() * 3;
      } else {
        autoCov = Math.sin((autoBlinkPhase / BLINK_DUR) * Math.PI);
      }
    } else {
      autoBlinkTimer -= dt;
      if (autoBlinkTimer <= 0) autoBlinkPhase = 0;
    }

    // expression smoothing
    const target = EXPRESSIONS[exprName];
    const a = 1 - Math.exp(-dt * 14);
    for (const k of Object.keys(exprCur)) exprCur[k] = lerp(exprCur[k], target[k], a);

    applyFace(Math.max(blinkInput, autoCov));
    hasPrev = true;
  }

  function setExpression(name) {
    if (EXPRESSIONS[name]) exprName = name;
    return exprName;
  }
  function blink(amount = 1) {
    blinkInput = clamp(+amount || 0, 0, 1);
    applyFace(blinkInput);
  }
  function setMouthOpen(amount = 0) {
    mouthInput = clamp(+amount || 0, 0, 1);
  }

  function dispose() {
    const geos = new Set();
    const mats = new Set();
    root.traverse((o) => {
      if (o.isMesh) {
        geos.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
      }
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    unitSphere.dispose();
    lowSphere.dispose();
    gradientMap.dispose();
    if (root.parent) root.parent.remove(root);
  }

  applyFace(0);
  root.updateMatrixWorld(true);

  const info = {
    height: DIM.hipsY + DIM.spineUp + DIM.chestUp + DIM.neckUp + DIM.headUp + DIM.headTop,
    upperArm: DIM.upperArm,
    foreArm: DIM.foreArm,
    hand: DIM.hand,
    thigh: DIM.thigh,
    shin: DIM.shin,
    footHeight: DIM.ankleToSole,
    shoulderWidth: 2 * (DIM.clavicle[0] + DIM.shoulderToArm),
    hipWidth: 2 * DIM.hipOffset[0],
    expressions: Object.keys(EXPRESSIONS),
  };

  return {
    root,
    bones,
    setExpression,
    blink,
    setMouthOpen,
    update,
    dispose,
    info,
  };
}

export default createCharacter;
