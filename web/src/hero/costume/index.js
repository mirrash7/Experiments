// Costume package entry (WP4). Builds shirt (SDF shell + collar + buttons), shorts (SDF shell + rolled
// cuffs), sash band + wrapped knot + tails (rest drape; WP5 drives them in place), fur cuffs and sandals; merges everything into ONE skinned mesh
// (+ its outline hull) on a costume toon material that carries the costume detail atlas.
// Owner: WP4. Spec 2.6, 2.12 (attachment points), 2.13.
//
// api (for WP5 / QA):
//   api.sash.knot            Object3D child of the hips bone at the knot (x = band tangent, y = up, z = outward). Updated every
//                            frame: follows hips 55% / knot-side HipHelper 45% and slides toward the hip side with hip flexion
//                            (same as the knot geometry), so tail roots clear the raised thigh.
//   api.sash.longTail / shortTail  { restPoints (root-space rest Vector3[]), restPointsHips (hips-local), w0, w1, thickness, length, cutDeg }
//   api.sash.ribbon          { layout (costume/ribbon.js), geometry, vertexStart, vertexCount, claim(bool), upload(names) }: the
//                            merged tail vertices. WP5 claims them (skin -> 100% hips) and rewrites them every frame, so the
//                            dynamic tails share the costume draw, outline hull and shadow draw (QA r2 P2-4: tails cast a
//                            ground shadow, shadow pass still 4 draws, main pass -2 draws). claim(false) restores the drape.
//   api.hideStaticTails(bool)  drops the tail range from the index (debug / A-B; WP5 no longer uses it)
//   api.colliders            bone-local collider definitions (hips ellipsoid, thigh/shin capsules, fur tori)
//   api.setFurSquash(side, amount)  extra squash (0..0.2) on top of the knee-angle squash (WP5 velocity squash)
//   api.clothBones           helper bones this mesh is skinned to (shirtHemL/R/Back, sleeveCuffL/R)
//   api.stats                { tris, vertices, buildMs, timings: { step: ms }, parts: { name: tris }, strapClearance }
//
// Builders: buildCostume(ctx) (sync, contract) and buildCostumeAsync(ctx, { yieldFn }) (same result, yields to the
// event loop between garments so no single block is long: QA r1 P0-2). Both run the same step generator.
//
// REQUEST(WP0): none blocking. Optional: a costume detail-atlas slot in createSharedMaterials so the costume
//   can share the body material instance (today: one ShaderMaterial instance sharing every env uniform except uDetail).

import * as THREE from 'three';
import { computeOutlineNormals, mergeCharacterGeometries, createSkinnedPair } from '../geo/attributes.js';
import { smin, smoothstep, sdTorusY, makeSplatSdf, castInward, PROF, profReset, lap } from './sdf.js';
import { buildShirt, shirtShape, makeShirtSdf, paintShirt, BLANK_UV } from './shirt.js';
import { buildShorts, shortsShape, makeShortsSdf, paintShorts } from './shorts.js';
import { buildSash, buildFurCuff, buildSandal, makeFootSurface, colliderDefs, KNOT_HELPER } from './accessories.js';

/** Max slide (rad) of the knot around the band toward the hip side at full knot-side hip flexion. */
const KNOT_SLIDE = 0.85;

const ATLAS_SIZE = 1024;
/** Minimum cloth clearance over the real body surface (metres); design fit (dims.SHIRT.fit) is larger. */
const CLEAR = { shirt: 0.013, shorts: 0.010 };

function bodySource(ctx) {
  const ms = (ctx.parts.body?.meshes || []).filter((m) => m.isSkinnedMesh && !/outline/i.test(m.name) && m.geometry?.attributes?.skinIndex);
  if (!ms.length) return null;
  if (ms.length === 1) return ms[0].geometry;
  const pos = [], nor = [], si = [], sw = [];
  for (const m of ms) {
    const g = m.geometry, p = g.attributes.position, a = g.attributes.skinIndex, b = g.attributes.skinWeight, nr = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (nr) nor.push(nr.getX(i), nr.getY(i), nr.getZ(i)); else nor.push(0, 1, 0);
      for (let c = 0; c < 4; c++) { si.push(a.getComponent(i, c)); sw.push(b.getComponent(i, c)); }
    }
  }
  return { attributes: {
    position: new THREE.Float32BufferAttribute(pos, 3),
    normal: new THREE.Float32BufferAttribute(nor, 3),
    skinIndex: new THREE.Uint16BufferAttribute(si, 4),
    skinWeight: new THREE.Float32BufferAttribute(sw, 4),
  } };
}

/** Costume toon material: same shader/env as ctx.materials.body, own detail atlas. */
function makeCostumeMaterial(ctx, atlas) {
  const base = ctx.materials.body;
  if (base && base.isShaderMaterial && base.uniforms && base.uniforms.uDetail) {
    const mat = new THREE.ShaderMaterial({
      name: 'heroToon_costume',
      uniforms: { ...base.uniforms, uDetail: { value: atlas } },
      defines: { ...base.defines },
      vertexShader: base.vertexShader, fragmentShader: base.fragmentShader,
      lights: base.lights, fog: base.fog, toneMapped: false, side: base.side,
    });
    mat.extensions = { ...base.extensions };
    mat.userData = { ...base.userData, costume: true };
    mat.onBeforeRender = base.onBeforeRender;
    return mat;
  }
  return ctx.materials.createToonMaterial({ skinned: true, palette: ctx.palette, detailAtlas: atlas, variant: 'body' });
}

/** Sync builder (facade contract). */
export function buildCostume(ctx) {
  const it = costumeSteps(ctx);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * Async builder: same result as buildCostume, but yields between garments (shorts / shirt / sash / fur+sandals /
 * atlas+merge) so the first frame is never blocked by the whole costume. yieldFn defaults to one animation frame
 * (setTimeout(0) when rAF is unavailable or the page is hidden). The facade passes its own `yieldToBrowser`.
 */
export async function buildCostumeAsync(ctx, { yieldFn = null, yieldToBrowser = null } = {}) {
  const y = yieldFn || yieldToBrowser || (() => new Promise((res) => {
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) requestAnimationFrame(() => res());
    else setTimeout(res, 0);
  }));
  const tWall = performance.now();
  const it = costumeSteps(ctx);
  let r = it.next();
  while (!r.done) {
    await y();
    r = it.next();
  }
  r.value.api.stats.wallMs = Math.round(performance.now() - tWall);   // incl. yields
  return r.value;
}

function* costumeSteps(ctx) {
  let tStep = performance.now(), busy = 0, maxBlock = 0;
  const blocks = [];
  const step = () => { const t = performance.now(), d = t - tStep; tStep = t; busy += d; maxBlock = Math.max(maxBlock, d); blocks.push(d); return d; };
  profReset();
  const { rig, dims } = ctx;
  const bodyGeo = bodySource(ctx);

  // ---- shapes (shared between garments so they nest: skin < shorts < shirt < sash)
  // Design SDFs are shrink-wrapped onto the real body (WP2) wherever it is bigger than the design, so the
  // cloth keeps its clearance whatever the body proportions turn out to be.
  const ss = shortsShape(dims);
  const shortsInfo = makeShortsSdf(dims, ss);
  const sh = shirtShape(dims);
  const wrap = (design, bodySdf, clearance, k) => (bodySdf ? (x, y, z) => {
    const d = design(x, y, z);
    if (d > 0.035 || d < -0.035) return d;
    return smin(d, bodySdf(x, y, z) - clearance, k);
  } : design);
  // smooth splatted body fields (QA r1 P0-4: the old nearest-vertex field put lumps into the cloth and its normals)
  const hasBody = bodyGeo && bodyGeo.attributes.normal;
  const bodyLower = hasBody ? makeSplatSdf(bodyGeo, { bmin: [-0.3, ss.hemY - 0.05, -0.2], bmax: [0.3, 1.07, 0.2], cell: 0.015, R: 0.027, far: 0.04 }) : null;
  const bodyUpper = hasBody ? makeSplatSdf(bodyGeo, { bmin: [-(sh.xEnd + 0.08), 0.84, -0.2], bmax: [sh.xEnd + 0.08, 1.50, 0.22], cell: 0.015, R: 0.027, far: 0.04,
    filter: (x, y) => y < 1.47 || Math.abs(x) > 0.1 }) : null;
  lap('setup');
  shortsInfo.sdf = wrap(shortsInfo.sdf, bodyLower, CLEAR.shorts, 0.012);
  const shirtSdf = wrap(makeShirtSdf(dims, sh, shortsInfo.sdf), bodyUpper, CLEAR.shirt, 0.005);

  const shorts = buildShorts(ctx, { bodyGeo, shape: ss, sdfInfo: shortsInfo });
  yield step(); tStep = performance.now();
  const shirt = buildShirt(ctx, { shortsSdf: shortsInfo.sdf, bodyGeo, sdf: shirtSdf });
  yield step(); tStep = performance.now();

  // ---- sash fitted on the real garment surfaces
  const shirtExists = (th, y) => y > sh.hemY(th) + 0.002;
  const surfR = (th, y) => {
    const dx = Math.sin(th), dz = Math.cos(th), r0 = 0.40;
    let r = r0 - Math.max(0, castInward(shortsInfo.sdf, dx, y, dz, r0));
    if (shirtExists(th, y) && (dz < 0.2 || Math.abs(dx * r) > sh.halfGap(y) - 0.01)) r = Math.max(r, r0 - Math.max(0, castInward(shirtSdf, dx, y, dz, r0)));
    return r;
  };
  const furY = ss.hemY + 0.004;
  const legHemR = (sd) => (a) => {
    const y = furY, ux = sd * Math.sin(a), uz = Math.cos(a);
    const rx = Math.sin(a) >= 0 ? shortsInfo.rOut(y) : shortsInfo.rIn(y), rz = shortsInfo.rZ(y);
    const r = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uz * uz) / (rz * rz));
    let nx = ux / (rx * rx), nz = uz / (rz * rz); const l = Math.hypot(nx, nz); nx /= l; nz /= l;
    return { cx: sd * ss.legX + ux * r, cz: uz * r, r, nx, nz };
  };
  const collide = (x, y, z) => {
    let d = shortsInfo.sdf(x, y, z);
    for (const sd of [1, -1]) d = Math.min(d, sdTorusY(x, y, z, sd * ss.legX + sd * 0.012, furY, 0, 0.088, 0.034));
    if (y > sh.hemY(Math.atan2(x, z))) d = smin(d, shirtSdf(x, y, z), 0.01);
    return d;
  };
  lap('pre-sash');
  const sash = buildSash(ctx, { surfR, collide });
  lap('sash');
  yield step(); tStep = performance.now();

  const furs = [1, -1].map((sd) => buildFurCuff(ctx, { sd, legX: ss.legX, y: furY, rimAt: legHemR(sd), skinAt: thighSkinAt(bodyGeo, sd * ss.legX, furY, dims) }));
  // sandals: straps snap to the real skinned foot surface (QA r3 P2-6), i.e. the body mesh triangles in rest pose
  // (parts.body.meshes[0]), not an approximate SDF; skin weights are copied from the foot point under each strap ring
  let footPts = null;
  const footMesh = (ctx.parts.body?.meshes || []).find((m) => m.isSkinnedMesh && !/outline/i.test(m.name) && m.geometry?.attributes?.skinIndex);
  const footGeo = footMesh?.geometry?.attributes?.normal ? footMesh.geometry : null;
  if (footGeo) {
    const fp = footGeo.attributes.position;
    footPts = [];
    for (let i = 0; i < fp.count; i++) if (fp.getY(i) < 0.13) footPts.push([fp.getX(i), fp.getY(i), fp.getZ(i)]);
  }
  lap('fur');
  const strapClearance = {};
  const sandals = [1, -1].flatMap((sd) => {
    const foot = footGeo ? makeFootSurface(footGeo, sd) : null;
    const g2 = buildSandal(ctx, sd, { foot, footPts });
    strapClearance[sd > 0 ? 'left' : 'right'] = g2.strapClearance;
    return g2;
  });
  lap('sandals');

  yield step(); tStep = performance.now();

  // ---- painted detail atlas
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS_SIZE;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  g.globalCompositeOperation = 'lighter';
  g.filter = 'blur(0.6px)';
  paintShirt(g, ATLAS_SIZE, dims, sh, shirtSdf);
  paintShorts(g, ATLAS_SIZE, dims, ss);
  g.filter = 'none';
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000'; g.fillRect(Math.floor(BLANK_UV[0] * ATLAS_SIZE) - 8, 0, ATLAS_SIZE, 16); // keep the blank texel clean
  lap('atlas');
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.name = 'heroCostumeDetail';
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.anisotropy = 4;
  atlas.needsUpdate = true;

  // ---- merge (order: everything static, then fur (CPU squash range), then tails (hideable draw range))
  const parts = [
    ['shirt', shirt.geometry], ['collar', shirt.collar], ['buttons', shirt.buttons], ['shorts', shorts.geometry],
    ...shorts.rolls.map((r, i) => [`roll${i}`, r]), ...sash.geometries.map((s, i) => [`sash${i}`, s]),
    ...sash.knotGeometries.map((s, i) => [`knot${i}`, s]),
    ...sandals.map((s, i) => [`sandal${i}`, s]),
    ['furL', furs[0].geometry], ['furR', furs[1].geometry],
    ...sash.tailGeometries.map((s, i) => [`tail${i}`, s]),
  ].filter(([, geo]) => geo);
  const stats = { parts: {} };
  const vOff = {}, iOff = {};
  let vAcc = 0, iAcc = 0;
  for (const [name, geo] of parts) {
    vOff[name] = vAcc; iOff[name] = iAcc;
    vAcc += geo.attributes.position.count; iAcc += geo.index.count;
    stats.parts[name] = geo.index.count / 3;
  }
  const furMeta = furs.map((f, k) => ({ meta: f.meta, src: f.geometry.userData.srcVertex, off: vOff[k ? 'furR' : 'furL'], count: f.geometry.attributes.position.count, bone: f.boneName }));
  const tailIndexStart = iOff.tail0 ?? iAcc;
  const geo = mergeCharacterGeometries(parts.map(([, g2]) => g2));
  const fullIndex = geo.index;
  const staticIndex = new THREE.BufferAttribute(fullIndex.array.slice(0, tailIndexStart), 1);
  let tailsHidden = false;
  computeOutlineNormals(geo);
  geo.computeBoundingSphere();
  const material = makeCostumeMaterial(ctx, atlas);
  const meshes = createSkinnedPair(geo, material, ctx.materials.outline, rig, { name: 'costume' });

  // ---- fur squash (CPU, rest-space positions; only when the knee angle changes)
  const posAttr = geo.attributes.position;
  const restFur = furMeta.map((f) => posAttr.array.slice(f.off * 3, (f.off + f.count) * 3));
  const furExtra = { left: 0, right: 0 }, furLast = [-1, -1];
  const furRange = [furMeta[0].off, furMeta[1].off + furMeta[1].count];
  function updateFur() {
    let dirty = false;
    furMeta.forEach((f, k) => {
      const shin = rig.all[k ? 'rightShin' : 'leftShin'];
      const ang = 2 * Math.acos(Math.min(1, Math.abs(shin.quaternion.w)));
      const amt = dims.FUR.backSquash * smoothstep(1.05, 2.1, ang) + furExtra[k ? 'right' : 'left'];
      if (Math.abs(amt - furLast[k]) < 0.002) return;
      furLast[k] = amt; dirty = true;
      const rest = restFur[k], arr = posAttr.array;
      for (let v = 0; v < f.count; v++) {
        const s = f.src[v], cx = f.meta[s * 4], cy = f.meta[s * 4 + 1], cz = f.meta[s * 4 + 2], back = f.meta[s * 4 + 3];
        const q = 1 - amt * back * 2.2;
        const o = (f.off + v) * 3, r = v * 3;
        arr[o] = cx + (rest[r] - cx) * q;
        arr[o + 1] = cy + (rest[r + 1] - cy) * (1 - amt * back * 0.6) + amt * back * 0.012;
        arr[o + 2] = cz + (rest[r + 2] - cz) * q;
      }
    });
    return dirty;
  }

  // ---- WP5 attachment points
  const hips = rig.all.hips;
  const hipsRest = rig.restWorld.hips;
  const knot = new THREE.Object3D();
  knot.name = 'sashKnot';
  knot.position.set(sash.knot.position[0] - hipsRest.x, sash.knot.position[1] - hipsRest.y, sash.knot.position[2] - hipsRest.z);
  knot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...sash.knot.tangent), new THREE.Vector3(...sash.knot.up), new THREE.Vector3(...sash.knot.out)));
  hips.add(knot);
  // the knot frame follows hips (1 - KNOT_HELPER) + knot-side HipHelper KNOT_HELPER, exactly like the knot geometry
  const knotRest = new THREE.Vector3(...sash.knot.position), knotRestQ = knot.quaternion.clone();
  const kName = sash.knot.position[0] >= 0 ? 'leftHipHelper' : 'rightHipHelper';
  const kHelper = rig.all[kName] || rig.helpers[kName];
  const kIdx = [rig.boneIndex.hips, rig.boneIndex[kName]];
  const _ka = new THREE.Vector3(), _kb = new THREE.Vector3(), _kq = new THREE.Quaternion(), _qI = new THREE.Quaternion();
  // Knot slide: as the knot-side hip flexes the knot (+ tail roots) slides around the band toward the hip side, out of
  // the raised thigh's way (CPU, rest-space rotation about the hips' vertical axis; only when the angle changes).
  const kThigh = rig.all[kName === 'leftHipHelper' ? 'leftThigh' : 'rightThigh'], kSign = kName === 'leftHipHelper' ? 1 : -1;
  const lastKnot = `knot${sash.knotGeometries.length - 1}`;
  const slideRanges = [['knot0', lastKnot], ['tail0', 'tail0']].filter(([a0]) => vOff[a0] !== undefined)
    .map(([a0, a1]) => [vOff[a0], vOff[a1] + parts.find(([nm]) => nm === a1)[1].attributes.position.count]);
  const restSlide = slideRanges.map(([v0, v1]) => posAttr.array.slice(v0 * 3, v1 * 3));
  let slideLast = 0, slideAng = 0;
  const _td = new THREE.Vector3(), _yq = new THREE.Quaternion(), _yAxis = new THREE.Vector3(0, 1, 0), _kr = new THREE.Vector3();
  function updateSlide() {
    _td.set(0, -1, 0).applyQuaternion(kThigh.quaternion);           // forward hip flexion only (not abduction)
    const flex = Math.atan2(Math.max(_td.z, 0), Math.max(-_td.y, 1e-4));
    slideAng = kSign * KNOT_SLIDE * smoothstep(0.35, 1.6, flex);
    if (Math.abs(slideAng - slideLast) < 0.004) return false;
    slideLast = slideAng;
    const c = Math.cos(slideAng), sn = Math.sin(slideAng), arr = posAttr.array;
    slideRanges.forEach(([v0, v1], k) => {
      if (ribbonClaimed && v0 === tailV0) return;                   // the dynamic ribbon owns those vertices
      const rest = restSlide[k];
      for (let v = 0; v < v1 - v0; v++) {
        const x = rest[3 * v], z = rest[3 * v + 2], o = (v0 + v) * 3;
        arr[o] = x * c + z * sn; arr[o + 2] = z * c - x * sn;
      }
    });
    return true;
  }
  // ---- dynamic ribbon slot (QA r2 P2-4): WP5 rewrites the static tail vertices in place every frame, so the tails share
  // the costume draw, its outline hull and its single shadow draw (shadow pass stays at 4 draws)
  const tailV0 = vOff.tail0 ?? -1, tailVN = tailV0 >= 0 ? parts.find(([nm]) => nm === 'tail0')[1].attributes.position.count : 0;
  const A = geo.attributes;
  const tailRest = tailV0 >= 0 ? ['position', 'normal', 'outlineNormal', 'skinIndex', 'skinWeight'].map((nm) => {
    const it = A[nm].itemSize; return [nm, A[nm].array.slice(tailV0 * it, (tailV0 + tailVN) * it)];
  }) : [];
  let ribbonClaimed = false;
  function uploadTail(names) {
    for (const nm of names) { const at = A[nm]; at.addUpdateRange(tailV0 * at.itemSize, tailVN * at.itemSize); at.needsUpdate = true; }
  }
  /** Hand the tail vertices to the dynamic ribbon (skin -> 100% hips, hips-rest space) or give them back (static drape). */
  function claimRibbon(on) {
    if (tailV0 < 0 || on === ribbonClaimed) return;
    ribbonClaimed = on;
    for (const [nm, rest] of tailRest) A[nm].array.set(rest, tailV0 * A[nm].itemSize);
    if (on) {
      const si = A.skinIndex.array, sw = A.skinWeight.array, hb = rig.boneIndex.hips;
      for (let v = tailV0; v < tailV0 + tailVN; v++) { si[v * 4] = hb; sw[v * 4] = 1; for (let c = 1; c < 4; c++) { si[v * 4 + c] = 0; sw[v * 4 + c] = 0; } }
    } else slideLast = NaN;                                         // re-apply the slide to the restored rest drape
    uploadTail(['position', 'normal', 'outlineNormal', 'skinIndex', 'skinWeight']);
  }
  function updateKnot() {
    const inv = rig.skeleton.boneInverses;
    _yq.setFromAxisAngle(_yAxis, slideAng);
    _kr.copy(knotRest).applyQuaternion(_yq);
    _ka.copy(_kr).applyMatrix4(inv[kIdx[0]]).applyMatrix4(hips.matrixWorld);
    _kb.copy(_kr).applyMatrix4(inv[kIdx[1]]).applyMatrix4(kHelper.matrixWorld);
    _ka.lerp(_kb, KNOT_HELPER);
    knot.position.copy(hips.worldToLocal(_ka));
    _kq.copy(_qI).slerp(kHelper.quaternion, KNOT_HELPER);
    knot.quaternion.copy(_kq).multiply(_yq).multiply(knotRestQ);
    knot.updateMatrixWorld();
  }
  const tailInfo = (t) => ({
    ...t,
    restPoints: t.restPoints.map((p) => new THREE.Vector3(...p)),
    restPointsHips: t.restPoints.map((p) => new THREE.Vector3(p[0] - hipsRest.x, p[1] - hipsRest.y, p[2] - hipsRest.z)),
    particles: dims.SASH.longTail.particles,
  });
  const api = {
    sash: {
      knot, longTail: tailInfo(sash.longTail), shortTail: { ...tailInfo(sash.shortTail), particles: dims.SASH.shortTail.particles }, bone: 'hips',
      // dynamic ribbon slot: layout (costume/ribbon.js) + the costume geometry range it lives in
      ribbon: tailV0 >= 0 ? { layout: sash.ribbonLayout, geometry: geo, vertexStart: tailV0, vertexCount: tailVN, claim: claimRibbon, upload: uploadTail } : null,
    },
    colliders: colliderDefs(dims, ss),
    clothBones: ['shirtHemL', 'shirtHemR', 'shirtHemBack', 'sleeveCuffL', 'sleeveCuffR'],
    furCuffs: furMeta.map((f, k) => ({ side: k ? 'right' : 'left', bone: f.bone, restCentreY: furY })),
    // hidden static tails are dropped from the index (not just the draw range) so they cost nothing anywhere
    hideStaticTails(hide = true) {
      if (hide === tailsHidden) return;
      tailsHidden = hide;
      geo.setIndex(hide ? staticIndex : fullIndex);
      geo.setDrawRange(0, Infinity);
    },
    setFurSquash(side, amount) { for (const s of side === 'both' ? ['left', 'right'] : [side]) furExtra[s] = THREE.MathUtils.clamp(amount, -0.1, 0.2); },
    detailAtlas: atlas,
    stats,
    debug: { ctx, shirt: shirt.debug, shirtSdf, shortsSdf: shortsInfo.sdf, shirtShape: sh, shortsShape: ss },
  };
  lap('merge');
  stats.timings = { ...PROF.laps };
  Object.defineProperty(stats, 'tris', { get: () => geo.index.count / 3, enumerable: true });   // live (tails dropped when hidden)
  stats.trisWithStaticTails = fullIndex.count / 3;
  stats.vertices = posAttr.count;
  stats.strapClearance = strapClearance;   // rest-pose min/max inner-face clearance of the sandal straps over the foot skin (m)
  step();
  stats.buildMs = Math.round(busy);            // CPU time of the build (excludes async yields)
  stats.totalMs = stats.buildMs;               // alias for the facade's end-to-end budget check
  stats.maxBlockMs = Math.round(maxBlock);     // longest main-thread block between yields (async build)
  stats.blocks = blocks.map((b) => Math.round(b * 10) / 10);

  return {
    meshes,
    api,
    update() {
      const df = updateFur(), ds = updateSlide();
      if (df || ds) {
        if (df) posAttr.addUpdateRange(furRange[0] * 3, (furRange[1] - furRange[0]) * 3);
        if (ds) for (const [v0, v1] of slideRanges) posAttr.addUpdateRange(v0 * 3, (v1 - v0) * 3);
        posAttr.needsUpdate = true;
      }
      updateKnot();
    },
    dispose() {
      hips.remove(knot);
      geo.dispose(); atlas.dispose();
      if (material !== ctx.materials.body) material.dispose();
    },
  };
}

/**
 * Thigh skin radius around the leg axis at height y, per angle (0 = front), from the body vertices in a thin
 * slab (36 bins, max radius, circularly smoothed). Falls back to dims.SHORTS.thighRAtHem.
 */
function thighSkinAt(bodyGeo, cx, y, dims) {
  const fallback = () => dims.SHORTS.thighRAtHem;
  if (!bodyGeo) return fallback;
  const p = bodyGeo.attributes.position, NB = 36, bins = new Float32Array(NB);
  const sd = Math.sign(cx);
  for (let i = 0; i < p.count; i++) {
    const py = p.getY(i);
    if (Math.abs(py - y) > 0.02) continue;
    const dx = p.getX(i) - cx, dz = p.getZ(i), r = Math.hypot(dx, dz);
    if (r > 0.12 || Math.sign(p.getX(i)) !== sd) continue;
    const a = Math.atan2(sd * dx, dz), b = ((Math.round((a / (Math.PI * 2)) * NB) % NB) + NB) % NB;
    bins[b] = Math.max(bins[b], r);
  }
  let filled = 0;
  for (let b = 0; b < NB; b++) if (bins[b] > 0) filled++;
  if (filled < NB * 0.6) return fallback;
  const sm = new Float32Array(NB);
  for (let b = 0; b < NB; b++) {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) { const v = bins[(b + k + NB) % NB]; if (v > 0) { s = Math.max(s, v); n++; } }
    sm[b] = n ? s : dims.SHORTS.thighRAtHem;
  }
  return (a) => { const f = ((a / (Math.PI * 2)) * NB % NB + NB) % NB, i = Math.floor(f), t = f - i; return sm[i] * (1 - t) + sm[(i + 1) % NB] * t; };
}
