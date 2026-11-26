// BREAKLIGHT CV: the Overdrive "spectral echo": a giant translucent billboard of the player's silhouette in the sky
// (worldScene), drawn in the calibration-hologram look (neon outline + gradient + scanlines, neon.js HOLO_FUNCS), additive
// + HDR so the post chain's bloom picks up the outline. Fed by the segmenter's cutout (one small texture upload per new
// mask frame), with a delayed ghost outline, a subtle beat pulse and a rising reveal when it turns on.
//
// Placement (QA art r2 P0-1): by default the echo is placed by a PRESET ('run' | 'boss' | 'title' | 'results'). A preset
// is a list of candidate screen slots (left / right sky, scaled to the frame height); a few times a second the solver
// projects the keep-out regions (boss bounds, the rift, the hero, any extra Object3D / Sphere / Box3 / {center, radius})
// through the CURRENT camera and picks the slot with the least overlap that fits entirely inside the frame, shrinking it
// if needed, or (boss preset) falls back to standing far BEHIND the boss at low opacity, where depth testing hides it
// behind the Warden. The chosen slot becomes a world anchor at the slot's depth; between solves it stays put in the world
// (natural parallax) and eases toward the next solution. `setPlacement({ position, height })` still works (legacy world
// placement with camera parallax) and switches the echo out of preset mode until the next setPreset().
import * as THREE from 'three';
import { NEON_UNIFORMS, HOLO_FUNCS } from './neon.js';

const VS = `
out vec2 vUv;
void main() { vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS = `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uOpacity;
uniform float uDim;
${NEON_UNIFORMS}
${HOLO_FUNCS}
void main() {
  vec4 c = holoShade(vUv);
  // fade the bottom into the cloud sea and the sides into the sky
  float fade = smoothstep(0.0, 0.2, 1.0 - vUv.y) * smoothstep(0.0, 0.06, vUv.x) * smoothstep(0.0, 0.06, 1.0 - vUv.x);
  float k = uOpacity * fade;
  outColor = vec4(c.rgb * k, c.a * k * uDim);
}`;

/**
 * Screen slots per preset. x: slot centre (0..1 from the left); top: top edge (0..1 from the top); h: height as a
 * fraction of the frame height; depth: metres from the camera. Earlier slots are preferred on ties. `behind`: fallback
 * placed past the furthest keep-out (boss preset), drawn at `behindOpacity`.
 */
export const ECHO_PRESETS = {
  run: { slots: [{ x: 0.21 }, { x: 0.79 }, { x: 0.27 }, { x: 0.73 }], top: 0.07, h: 0.6, depth: 92, opacity: 0.85 },
  boss: { slots: [{ x: 0.17 }, { x: 0.83 }, { x: 0.12 }, { x: 0.88 }], top: 0.1, h: 0.6, depth: 70, opacity: 0.75, behind: true, behindOpacity: 0.35 },
  title: { slots: [{ x: 0.78 }, { x: 0.22 }, { x: 0.5 }], top: 0.06, h: 0.62, depth: 90, opacity: 0.7 },
  results: { slots: [{ x: 0.5 }, { x: 0.8 }, { x: 0.2 }], top: 0.05, h: 0.5, depth: 90, opacity: 0.55 },
};
const SCALES = [1, 0.86, 0.72, 0.6];
const MARGIN = 0.035;          // frame margin (fraction)
const BODY_W = 0.62;           // the body occupies ~this much of the quad's width (overlap tests use the body box)
const FLOOR_Y = -2;            // world y below which keep-out geometry is ignored (hidden by the platform edge)

function makeTex() {
  const t = new THREE.Texture();
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

const _box = new THREE.Box3(), _v = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const _q = new THREE.Quaternion(), _cp = new THREE.Vector3(), _sph = new THREE.Sphere();

function isShown(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }

/** Screen rect (fractions, y down) of a world Box3 through camera, or null when entirely behind the camera. */
function projectBox(box, camera, out) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, front = 0;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    _v.applyMatrix4(camera.matrixWorldInverse);
    if (_v.z > -0.05) { _v.z = -0.05; } else front++;   // clamp corners behind the camera onto the near side
    _v.applyMatrix4(camera.projectionMatrix);
    const sx = _v.x * 0.5 + 0.5, sy = 0.5 - _v.y * 0.5;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  if (!front) return null;
  out.x0 = Math.max(-1, x0); out.y0 = Math.max(-1, y0); out.x1 = Math.min(2, x1); out.y1 = Math.min(2, y1);
  out.depth = 0;
  box.getCenter(_v); out.depth = -_v.applyMatrix4(camera.matrixWorldInverse).z;
  box.getBoundingSphere(_sph); out.far = out.depth + _sph.radius;
  return out;
}
/**
 * Tight screen rect of an Object3D: projects a sample of each visible (non-skinned) mesh's vertices (a big AABB projected
 * from close range is far too conservative: the Warden's arms reach toward the camera). Falls back to the box for
 * skinned / instanced meshes. Returns { x0, y0, x1, y1, depth, far } or null.
 */
function projectObject(obj, camera, out) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, far = 0, n = 0, minD = 0;
  const vm = camera.matrixWorldInverse, pm = camera.projectionMatrix;
  const take = (wx, wy, wz) => {
    if (wy < FLOOR_Y) return;   // below the platform / cloud sea: never visible from the game cameras
    _v.set(wx, wy, wz).applyMatrix4(vm);
    const dz = -_v.z; if (dz > far) far = dz;
    if (dz < minD) return;   // limbs reaching far toward the camera (boss slams) don't redefine the body's footprint
    if (_v.z > -0.05) _v.z = -0.05;
    _v.applyMatrix4(pm);
    const sx = _v.x * 0.5 + 0.5, sy = 0.5 - _v.y * 0.5;
    if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy; n++;
  };
  // solid meshes only: additive quads (halos, rim hulls, ground telegraph rings) are billboards / FX, not the body.
  // Meshes far in front of the object's median depth (e.g. a telegraph ring at the hero's feet) are skipped too.
  let meshes = [];
  const all = [];
  obj.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    o.getWorldPosition(_u); _u.applyMatrix4(vm);
    const e = { o, d: -_u.z };
    all.push(e);
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && (m.blending === THREE.AdditiveBlending || (m.transparent && m.depthWrite === false && m.blending !== THREE.NormalBlending))) return;
    meshes.push(e);
  });
  if (!meshes.length) meshes = all;   // a lone FX mesh (the rift portal) is its own footprint
  if (!meshes.length) return null;
  const ds = meshes.map((x) => x.d).sort((p, q) => p - q), med = ds[ds.length >> 1];
  minD = med * 0.6;
  for (const { o, d } of meshes) {
    if (d < med * 0.45) continue;
    const pos = o.geometry.attributes.position;
    if (o.isSkinnedMesh || o.isInstancedMesh) {
      _box.setFromObject(o);
      for (let i = 0; i < 8; i++) take(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z);
      continue;
    }
    const st = Math.max(1, Math.floor(pos.count / 300));
    for (let i = 0; i < pos.count; i += st) { _u.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); take(_u.x, _u.y, _u.z); }
  }
  if (!n) return null;
  out.x0 = Math.max(-1, x0); out.y0 = Math.max(-1, y0); out.x1 = Math.min(2, x1); out.y1 = Math.min(2, y1); out.far = far; out.depth = med;
  return out;
}
const area = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
function overlap(a, b) { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); }

/** World Box3 for a keep-out entry, or null (hidden / unknown). */
function keepOutBox(k, out) {
  if (!k) return null;
  if (k.isObject3D) {
    if (!isShown(k)) return null;
    out.setFromObject(k);
    return out.isEmpty() ? null : out;
  }
  if (k.isBox3) return k.isEmpty() ? null : out.copy(k);
  if (k.isSphere) return out.setFromCenterAndSize(k.center, _v.setScalar(k.radius * 2));
  if (k.isVector3) return out.setFromCenterAndSize(k, _v.setScalar(4));
  if (k.center) return out.setFromCenterAndSize(k.center, _v.setScalar((k.radius ?? 2) * 2));
  if (typeof k === 'function') return keepOutBox(k(), out);
  return null;
}

export function createEcho({ height = 36, position = new THREE.Vector3(0, 11, 74), parallax = 0.7, preset = 'run' } = {}) {
  const tex = makeTex(), ghostTex = makeTex();
  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1); blank.needsUpdate = true;
  const uniforms = {
    uTex: { value: blank }, uGhost: { value: blank }, uGhostAmt: { value: 0.0 },
    uColA: { value: new THREE.Color('#ffd84a') }, uColB: { value: new THREE.Color('#ff6a2a') },
    uTime: { value: 0 }, uPulse: { value: 0 }, uIntensity: { value: 1.35 }, uMirror: { value: 1 },
    uDetail: { value: 0.8 }, uFill: { value: 0.8 }, uPour: { value: 0 }, uLod: { value: 1.5 },
    uDotGrid: { value: new THREE.Vector2(96, 54) }, uLines: { value: 85 }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
    uReveal: { value: 1 }, uSkel: { value: 0 },
    uOpacity: { value: 0 }, uDim: { value: 0.4 },
  };
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms,
    transparent: true, depthWrite: false, depthTest: true, toneMapped: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;
  mesh.name = 'cv-echo';
  const object3d = new THREE.Group();
  object3d.name = 'BreaklightMirrorEcho';
  object3d.add(mesh);
  object3d.visible = false;

  const base = position.clone();
  let texVer = -1, texSrc = null, texW = 0, texH = 0, ghostVer = -1, opacity = 0, target = 0, reveal = 1;
  let warm = 2;   // render the first frames at zero opacity so the shader compiles at boot, not when Overdrive hits
  const crop = { x: 0, y: 0, w: 1, h: 1 }, aspect = { v: 16 / 9 };

  // ---- placement state
  const P = {
    mode: preset ? 'preset' : 'world', preset: preset || 'run', overrides: {}, keepOut: null, autoKeepOut: null,
    solveIn: 0, snap: true, anchor: new THREE.Vector3(), anchorH: height, goal: new THREE.Vector3(), goalH: height,
    opacityK: 1, goalOpacityK: 1, last: null,
  };

  function setImage(t, img, w, h, dims) {
    if (dims.w && (dims.w !== w || dims.h !== h)) t.dispose();   // immutable storage: re-allocate on resize
    dims.w = w; dims.h = h;
    t.image = img; t.needsUpdate = true;
  }
  const tDims = { w: 0, h: 0 }, gDims = { w: 0, h: 0 };

  /** Collect projected keep-out rects through the camera. */
  function keepOutRects(camera) {
    const list = [];
    const add = (k, weight, tag) => {
      let r = null;
      if (k?.isObject3D) { if (!isShown(k)) return; k.updateMatrixWorld(); r = projectObject(k, camera, {}); }
      else { const b = keepOutBox(k, _box); if (b) r = projectBox(b, camera, {}); }
      if (r && r.x1 > r.x0) { r.weight = weight; r.tag = tag; list.push(r); }
    };
    for (const k of P.keepOut || []) add(k, 1, 'keepOut');
    const auto = P.autoKeepOut?.() || [];
    for (const a of auto) add(a.obj, a.weight ?? 1, a.tag);
    return list;
  }

  /** Pick a screen slot for the current preset + camera; returns the solution (also stored in P.last). */
  function solve(camera, quadAspect) {
    const cfg = { ...ECHO_PRESETS[P.preset] || ECHO_PRESETS.run, ...P.overrides };
    camera.updateMatrixWorld();
    const camAspect = camera.aspect || 16 / 9;
    const rects = keepOutRects(camera);
    let best = null, cur = null;
    const slots = cfg.slots || [{ x: 0.2 }];
    for (let si = 0; si < SCALES.length; si++) {
      const h = Math.min(cfg.h * SCALES[si], 1 - cfg.top - MARGIN);
      const w = (h * quadAspect) / camAspect;
      for (let i = 0; i < slots.length; i++) {
        const top = slots[i].top ?? cfg.top;
        const cx = Math.min(1 - MARGIN - w / 2, Math.max(MARGIN + w / 2, slots[i].x));
        const quad = { x0: cx - w / 2, x1: cx + w / 2, y0: top, y1: top + h };
        const body = { x0: cx - (w * BODY_W) / 2, x1: cx + (w * BODY_W) / 2, y0: top + h * 0.06, y1: top + h * 0.92 };
        let ov = 0;
        for (const r of rects) ov += (overlap(body, r) / area(body)) * r.weight;
        const score = ov * 10 + i * 0.04 + si * 0.25;
        const c = { score, overlap: ov, slot: i, scale: SCALES[si], rect: quad, body, h, cx, top, behind: false, key: `${i}:${si}` };
        if (!best || score < best.score) best = c;
        if (P.curKey === c.key) cur = c;
      }
    }
    // boss: nothing beside it is clear -> stand far behind the furthest keep-out, low opacity (depth-tested behind it)
    if (cfg.behind) {
      const far = rects.reduce((m, r) => Math.max(m, r.tag === 'hero' ? 0 : r.far || 0), 0);
      const h = Math.min(0.9, 1 - 0.02 - MARGIN), w = (h * quadAspect) / camAspect;
      const bh = { score: 0.12 * 10 + 0.5, overlap: 0, slot: -1, scale: 1, rect: { x0: 0.5 - w / 2, x1: 0.5 + w / 2, y0: 0.02, y1: 0.02 + h }, h, cx: 0.5, top: 0.02, behind: true, depth: Math.max(cfg.depth, far + 12), key: 'behind' };
      if (bh.score < best.score) best = bh;
      if (P.curKey === 'behind') cur = bh;
    }
    // hysteresis: keep the current slot unless another one has been clearly better for ~0.8 s (arms swinging past or a
    // telegraph must not make the echo jump around); snaps (preset change / turning on) switch immediately
    if (!P.snap && cur && best.key !== cur.key && best.score < cur.score - 0.3) {
      P.pend = P.pend?.key === best.key ? { key: best.key, n: P.pend.n + 1 } : { key: best.key, n: 1 };
      if (P.pend.n < 4) best = cur;
    } else if (!P.snap && cur) { best = cur; P.pend = null; }
    P.curKey = best.key;
    best.depth ??= cfg.depth;
    best.opacity = best.behind ? cfg.behindOpacity ?? 0.35 : cfg.opacity ?? 0.8;
    best.keepOut = rects.map((r) => ({ tag: r.tag, x0: +r.x0.toFixed(3), y0: +r.y0.toFixed(3), x1: +r.x1.toFixed(3), y1: +r.y1.toFixed(3) }));
    best.preset = P.preset;
    // screen slot -> world anchor at `depth` along the camera's axes
    const fovY = THREE.MathUtils.degToRad(camera.fov || 50);
    const tanH = Math.tan(fovY / 2);
    const d = best.depth;
    const ndcX = best.cx * 2 - 1, ndcY = 1 - (best.top + best.h / 2) * 2;
    camera.getWorldPosition(_cp);
    camera.getWorldDirection(_f);
    _r.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _u.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    P.goal.copy(_cp).addScaledVector(_f, d).addScaledVector(_r, ndcX * d * tanH * camAspect).addScaledVector(_u, ndcY * d * tanH);
    P.goalH = best.h * 2 * d * tanH;
    P.goalOpacityK = best.opacity;
    P.last = best;
    return best;
  }

  /** Where the echo is on screen right now (fractions), from its actual transform. */
  function measure(camera) {
    if (!camera) return null;
    object3d.updateMatrixWorld(true);
    _box.makeEmpty();
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) _box.expandByPoint(_v.set(x, y, 0).applyMatrix4(mesh.matrixWorld));
    return projectBox(_box, camera, {});
  }

  const api = {
    object3d, mesh, material: mat, uniforms,
    get opacity() { return opacity; },
    setVisible(on) { if (on && target === 0) { reveal = 0; P.snap = true; P.solveIn = 0; } target = on ? 1 : 0; },
    /** Re-run the zero-opacity warm-up (e.g. after a context loss / quality change). */
    warmup(frames = 2) { warm = frames; },
    /**
     * Placement preset: 'run' | 'boss' | 'title' | 'results'. o.keepOut: extra Object3D / Sphere / Box3 / Vector3 /
     * {center, radius} list (replaces the previous explicit list; the automatic boss / rift / hero keep-outs still apply);
     * o.overrides: per-preset tweaks ({ h, top, depth, opacity, slots }). Snaps on the next frame.
     */
    setPreset(name, { keepOut, overrides = {} } = {}) {
      if (!ECHO_PRESETS[name]) throw new Error(`echo.setPreset: ${name}`);
      P.mode = 'preset'; P.preset = name; P.overrides = overrides || {};
      if (keepOut !== undefined) P.keepOut = keepOut ? [].concat(keepOut) : null;
      P.solveIn = 0; P.snap = true;
    },
    /** Explicit keep-out list (Object3D / Sphere / Box3 / Vector3 / {center, radius}); null clears. */
    setKeepOut(list) { P.keepOut = list ? [].concat(list) : null; P.solveIn = 0; },
    /** fn() -> [{ obj, weight, tag }]: automatic keep-outs re-read on every solve (mirror.js wires boss / rift / hero). */
    setAutoKeepOut(fn) { P.autoKeepOut = fn; },
    /** Legacy world placement (with camera parallax). Leaves preset mode until the next setPreset(). */
    setPlacement({ position: p, height: h } = {}) { if (p) base.copy(p); if (h) height = h; P.mode = 'world'; },
    /** { mode, preset, rect (screen fractions of the chosen slot), overlap, behind, depth, keepOut[] } of the last solve. */
    get placement() { const L = P.last; return { mode: P.mode, preset: P.preset, ...(L && P.mode === 'preset' ? { slot: L.slot, scale: L.scale, rect: L.rect, overlap: +L.overlap.toFixed(4), behind: L.behind, depth: L.depth, opacity: L.opacity, keepOut: L.keepOut } : {}) }; },
    /** Projected screen rect (fractions) of the echo quad through `camera` right now. */
    measure,
    /** Force a re-solve now (e.g. right after a camera cut). */
    resolve(snap = true) { P.solveIn = 0; P.snap = snap; },
    /**
     * frame: segmenter frame; o: { dt, camera, palette{a,b}(THREE.Color pair), pulse, time, ghost frame|null, ghostAmt, crop{x,y,w,h} }
     */
    update(frame, o) {
      opacity += (target - opacity) * (1 - Math.exp(-o.dt * (target ? 2.4 : 3.5)));
      if (target === 0 && opacity < 0.004) opacity = 0;
      object3d.visible = opacity > 0 || warm > 0;
      if (warm > 0) warm--;
      if (!object3d.visible) return;
      if (target) reveal = Math.min(1, reveal + o.dt / 0.7);
      uniforms.uReveal.value = reveal;
      if (frame?.image && (frame.version !== texVer || frame.image !== texSrc)) {
        setImage(tex, frame.image, frame.w, frame.h, tDims);
        uniforms.uTex.value = tex; texVer = frame.version; texSrc = frame.image; texW = frame.w; texH = frame.h;
      }
      uniforms.uSkel.value = frame?.kind === 'skeleton' ? 1 : 0;
      const g = o.ghost;
      if (g?.image && o.ghostAmt > 0 && g.version !== ghostVer && g.kind === 'seg') {
        setImage(ghostTex, g.image, g.w, g.h, gDims); uniforms.uGhost.value = ghostTex; ghostVer = g.version;
      }
      uniforms.uGhostAmt.value = g && g.kind === 'seg' && ghostVer >= 0 ? o.ghostAmt : 0;
      if (o.palette) { uniforms.uColA.value.lerp(o.palette.a, 1 - Math.exp(-o.dt * 4)); uniforms.uColB.value.lerp(o.palette.b, 1 - Math.exp(-o.dt * 4)); }
      uniforms.uTime.value = o.time; uniforms.uPulse.value = o.pulse;
      if (o.crop) { crop.x = o.crop.x; crop.y = o.crop.y; crop.w = o.crop.w; crop.h = o.crop.h; }
      uniforms.uCrop.value.set(crop.x, crop.y, crop.w, crop.h);
      uniforms.uLod.value = Math.max(0.5, Math.log2(Math.max(1, texW * crop.w) / 110));
      aspect.v = texW && texH ? (texW * crop.w) / (texH * crop.h) : 16 / 9;
      const cam = o.camera;
      if (P.mode === 'preset' && cam) {
        P.solveIn -= o.dt;
        if (P.solveIn <= 0) { solve(cam, aspect.v); P.solveIn = 0.2; }
        const k = P.snap ? 1 : 1 - Math.exp(-o.dt * 2.5);
        if (!P.snap && P.anchor.distanceTo(P.goal) > P.anchorH * 1.5) P.snap = true;   // camera cut: jump, don't slide
        const kk = P.snap ? 1 : k;
        P.anchor.lerp(P.goal, kk); P.anchorH += (P.goalH - P.anchorH) * kk; P.opacityK += (P.goalOpacityK - P.opacityK) * kk;
        P.snap = false;
        object3d.position.copy(P.anchor);
        cam.getWorldQuaternion(_q); object3d.quaternion.copy(_q);   // face the camera exactly (fit is computed for this)
        const s = P.anchorH * (1 + 0.012 * o.pulse);
        mesh.scale.set(s * aspect.v, s, 1);
        uniforms.uOpacity.value = opacity * P.opacityK;
      } else {
        // legacy world placement: follow the camera partly (reads as very far away) and face it (yaw only)
        const s = height * (1 + 0.012 * o.pulse);
        mesh.scale.set(s * aspect.v, s, 1);
        uniforms.uOpacity.value = opacity;
        if (cam) {
          cam.getWorldPosition(_cp);
          object3d.position.set(base.x + _cp.x * parallax, base.y + (_cp.y - 2) * parallax * 0.5, base.z + _cp.z * parallax * 0.3);
          object3d.quaternion.identity();
          object3d.rotation.set(0, Math.atan2(_cp.x - object3d.position.x, _cp.z - object3d.position.z), 0);
        } else object3d.position.copy(base);
      }
    },
    dispose() { tex.dispose(); ghostTex.dispose(); blank.dispose(); mat.dispose(); mesh.geometry.dispose(); },
  };
  return api;
}
