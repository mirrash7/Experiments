// BREAKLIGHT CV: the Overdrive "spectral echo": a giant translucent billboard of the player's silhouette in the sky
// (worldScene), drawn in the calibration-hologram look (neon outline + gradient + scanlines, neon.js HOLO_FUNCS), additive
// + HDR so the post chain's bloom picks up the outline. Fed by the segmenter's cutout (one small texture upload per new
// mask frame), with a delayed ghost outline, a subtle beat pulse and a rising reveal when it turns on.
//
// Placement (QA art r2 P0-1, r3 P1-2): by default the echo is placed by a PRESET ('run' | 'boss' | 'title' | 'results'). A preset
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
  // fade the bottom into the cloud sea and the sides / top into the sky (no hard quad edge when the hands reach the crop)
  float fade = smoothstep(0.0, 0.2, 1.0 - vUv.y) * smoothstep(0.0, 0.035, vUv.y) * smoothstep(0.0, 0.06, vUv.x) * smoothstep(0.0, 0.06, 1.0 - vUv.x);
  float k = uOpacity * fade;
  outColor = vec4(c.rgb * k, c.a * k * uDim);
}`;

/**
 * Screen slots per preset (QA art r3 P1-2: the echo is placed and sized by its FIGURE, not its quad). x: figure centre
 * (0..1 from the left); feet: the figure's feet line (0..1 from the top); fh: the STANDING figure height as a fraction of
 * the frame height at scale 1 (raised arms make the figure taller than this: see ARMS_UP); depth: metres from the camera.
 * Per-slot `feet` overrides the preset's. Earlier slots are preferred on ties. `behind`: fallback placed past the furthest
 * keep-out (boss preset), drawn at `behindOpacity`. Legacy overrides { top, h } (quad top / height) are still accepted.
 */
export const ECHO_PRESETS = {
  run: { slots: [{ x: 0.21 }, { x: 0.79 }, { x: 0.27 }, { x: 0.73 }, { x: 0.33 }, { x: 0.67 }], feet: 0.66, fh: 0.42, depth: 92, opacity: 0.85 },
  boss: { slots: [{ x: 0.17 }, { x: 0.83 }, { x: 0.12 }, { x: 0.88 }], feet: 0.64, fh: 0.44, depth: 70, opacity: 0.75, behind: true, behindOpacity: 0.35 },
  title: { slots: [{ x: 0.78 }, { x: 0.22 }, { x: 0.5 }], feet: 0.62, fh: 0.46, depth: 90, opacity: 0.7 },
  results: { slots: [{ x: 0.5 }, { x: 0.8 }, { x: 0.2 }], feet: 0.5, fh: 0.38, depth: 90, opacity: 0.55 },
};
const SCALES = [1, 0.88, 0.76, 0.64, 0.54];
const MARGIN = 0.035;          // safe-frame margin (fraction of the frame) on every side
const HUD_GAP = 0.018;         // extra clearance below / beside a HUD rect (fraction of the frame height)
const ARMS_UP = 1.3;           // headroom reserved above the standing figure for raised arms (x standing height)
const FIG_PAD = 0.025;         // the neon outline + glow extend this far past the mask bbox (fraction of the quad)
const FLOOR_Y = -2;            // world y below which keep-out geometry is ignored (hidden by the platform edge)

/**
 * Lowest y (fraction from the top) the figure's top may reach for a figure spanning [x0, x1] with its feet at `feet`:
 * the safe-frame top, pushed down below every screen keep-out (HUD rect) that overlaps that column above the feet.
 */
export function topLimit(rects, x0, x1, feet) {
  let lim = MARGIN;
  for (const r of rects || []) {
    if (r.x1 <= x0 - HUD_GAP * 0.5 || r.x0 >= x1 + HUD_GAP * 0.5) continue;   // not in this column
    if (r.y0 >= feet) continue;                                               // entirely below the feet
    lim = Math.max(lim, r.y1 + HUD_GAP);
  }
  return lim;
}

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
    opacityK: 1, goalOpacityK: 1, last: null, screenKeepOut: null, scr: [], scrAt: -1e9, fig: null,
  };
  // pose extent inside the quad (fractions, mirrored) + standing reference (see trackFigure)
  const F = { x0: 0.3, x1: 0.7, y0: 0.12, y1: 0.88, ref: 0.5, ratio: 1, init: false };

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

  /** Preset config with legacy { top, h } (quad) overrides mapped onto the figure fields. */
  function presetCfg() {
    const cfg = { ...(ECHO_PRESETS[P.preset] || ECHO_PRESETS.run), ...P.overrides };
    if (P.overrides.h != null && P.overrides.fh == null) cfg.fh = P.overrides.h * 0.76;
    if (P.overrides.top != null && P.overrides.feet == null) cfg.feet = (P.overrides.top ?? 0.07) + (P.overrides.h ?? 0.6) * 0.88;
    return cfg;
  }
  /** Screen keep-outs (HUD rects, fractions) from the provider, cached for ~0.4 s (re-read on resize / preset change). */
  function screenRects(force = false) {
    const now = performance.now();
    if (force || now - P.scrAt > 400) {
      P.scrAt = now;
      try { P.scr = (P.screenKeepOut?.() || []).filter((r) => r && r.x1 > r.x0 && r.y1 > r.y0); } catch { P.scr = []; }
    }
    return P.scr;
  }
  /** Figure box (screen fractions) for a feet point + standing height, with the current pose's extent and aspect. */
  function figureBox(cx, feet, hStand, camAspect, quadAspect, out = {}) {
    const fy = Math.max(0.05, F.y1 - F.y0), fx = Math.max(0.05, F.x1 - F.x0);
    const hf = hStand * F.ratio;
    const w = (hf / fy) * fx * quadAspect / camAspect;
    out.x0 = cx - w / 2; out.x1 = cx + w / 2; out.y0 = feet - hf; out.y1 = feet; out.w = w; out.h = hf;
    return out;
  }

  /** Pick a screen slot for the current preset + camera; returns the solution (also stored in P.last). */
  function solve(camera, quadAspect) {
    const cfg = presetCfg();
    camera.updateMatrixWorld();
    const camAspect = camera.aspect || 16 / 9;
    const rects = keepOutRects(camera);
    const scr = screenRects();
    let best = null, cur = null;
    const cands = P.debug ? [] : null;
    const slots = cfg.slots || [{ x: 0.2 }];
    for (let si = 0; si < SCALES.length; si++) {
      const hs = cfg.fh * SCALES[si];
      for (let i = 0; i < slots.length; i++) {
        const feet = Math.min(1 - MARGIN, slots[i].feet ?? cfg.feet);
        const fw = figureBox(0, feet, hs, camAspect, quadAspect).w, half = fw * 0.55;   // +10% for arm swings
        const need = hs * Math.max(ARMS_UP, F.ratio);
        // candidate centres: the slot's own x, plus nudged just clear of each HUD rect that sits in its column (the combo
        // column, the vitals) so a slightly shifted figure can keep its size instead of shrinking
        const xs = [slots[i].x];
        for (const r of scr) {
          if (r.y0 >= feet || r.y1 <= feet - need) continue;
          if (r.x1 > slots[i].x - half && r.x0 < slots[i].x + half) xs.push(r.x1 + HUD_GAP + half, r.x0 - HUD_GAP - half);
        }
        for (const x of xs) {
          const cx = Math.min(1 - MARGIN - half, Math.max(MARGIN + half, x));
          if (Math.abs(cx - slots[i].x) > 0.12) continue;   // too far from the slot: another slot covers that spot
          const body = figureBox(cx, feet, hs, camAspect, quadAspect);
          // headroom: the tallest pose (arms up) must fit between the feet and the HUD / frame top in this column
          const lim = topLimit(scr, cx - half, cx + half, feet);
          const room = feet - lim;
          const head = Math.max(0, need - room) / need;
          let ov = 0;
          for (const r of rects) ov += (overlap(body, r) / area(body)) * r.weight;
          for (const r of scr) ov += (overlap(body, r) / area(body)) * 2;
          const score = ov * 10 + head * 8 + i * 0.04 + si * 0.25 + Math.abs(cx - slots[i].x) * 1.5;
          const c = { score, overlap: ov, head, room: +room.toFixed(3), slot: i, scale: SCALES[si], body, hs, cx, feet, behind: false, key: `${i}:${si}` };
          if (!best || score < best.score) best = c;
          if (P.curKey === c.key && (!cur || score < cur.score)) cur = c;
          cands?.push({ key: c.key, cx: +cx.toFixed(3), score: +score.toFixed(3), ov: +ov.toFixed(3), head: +head.toFixed(3) });
        }
      }
    }
    // boss: nothing beside it is clear -> stand far behind the furthest keep-out, low opacity (depth-tested behind it)
    if (cfg.behind) {
      const far = rects.reduce((m, r) => Math.max(m, r.tag === 'hero' ? 0 : r.far || 0), 0);
      const feet = 1 - MARGIN - 0.1, hs = 0.62;
      const body = figureBox(0.5, feet, hs, camAspect, quadAspect);
      const bh = { score: 0.12 * 10 + 0.5, overlap: 0, head: 0, room: 0, slot: -1, scale: 1, body, hs, cx: 0.5, feet, behind: true, depth: Math.max(cfg.depth, far + 12), key: 'behind' };
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
    if (cands) P.cands = cands.sort((a, b) => a.score - b.score).slice(0, 12);
    best.depth ??= cfg.depth;
    best.opacity = best.behind ? cfg.behindOpacity ?? 0.35 : cfg.opacity ?? 0.8;
    const fx = (r) => ({ x0: +r.x0.toFixed(3), y0: +r.y0.toFixed(3), x1: +r.x1.toFixed(3), y1: +r.y1.toFixed(3) });
    best.keepOut = rects.map((r) => ({ tag: r.tag, ...fx(r) })).concat(scr.map((r) => ({ tag: r.tag || 'hud', screen: true, ...fx(r) })));
    best.rect = fx(best.body);
    best.preset = P.preset;
    // feet point (screen) -> world anchor at `depth` along the camera's axes; standing height -> world units
    const fovY = THREE.MathUtils.degToRad(camera.fov || 50);
    const tanH = Math.tan(fovY / 2);
    const d = best.depth;
    const ndcX = best.cx * 2 - 1, ndcY = 1 - best.feet * 2;
    camera.getWorldPosition(_cp);
    camera.getWorldDirection(_f);
    _r.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _u.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    P.goal.copy(_cp).addScaledVector(_f, d).addScaledVector(_r, ndcX * d * tanH * camAspect).addScaledVector(_u, ndcY * d * tanH);
    P.goalH = best.hs * 2 * d * tanH;
    P.goalOpacityK = best.opacity;
    P.last = best;
    return best;
  }

  /**
   * Per frame (preset mode): place the quad so the figure's feet sit on the anchor, scale it by the pose extent (raised
   * arms make it taller), then clamp it to the safe frame and below the HUD with the CURRENT camera, so no single frame
   * (arms snapping up between two solves, a camera move) puts the hands over the HUD or the frame edge.
   */
  function fitFrame(cam, pulse) {
    const camAspect = cam.aspect || 16 / 9, qa = aspect.v;
    const fovY = THREE.MathUtils.degToRad(cam.fov || 50), tanH = Math.tan(fovY / 2);
    cam.updateMatrixWorld();
    _v.copy(P.anchor).applyMatrix4(cam.matrixWorldInverse);
    const dz = Math.max(1, -_v.z);
    _v.applyMatrix4(cam.projectionMatrix);
    let sx = _v.x * 0.5 + 0.5;
    const feet = 0.5 - _v.y * 0.5;
    const kS = 1 / (2 * dz * tanH);                    // screen fraction (of the frame height) per world metre at the anchor
    const fy = Math.max(0.05, F.y1 - F.y0), fx = Math.max(0.05, F.x1 - F.x0);
    let hf = P.anchorH * F.ratio * (1 + 0.012 * pulse) * kS;
    // horizontal safe frame: shift (screen-space) so the whole figure stays inside the side margins
    let w = (hf / fy) * fx * qa / camAspect;
    let shift = 0;
    if (sx - w / 2 < MARGIN) shift = MARGIN - (sx - w / 2);
    else if (sx + w / 2 > 1 - MARGIN) shift = 1 - MARGIN - (sx + w / 2);
    sx += shift;
    // vertical: the top may not rise above the safe frame / the HUD rects in this column
    const lim = topLimit(screenRects(), sx - w / 2, sx + w / 2, feet);
    const room = Math.max(0.02, feet - lim);
    const clamped = hf > room;
    if (clamped) { hf = room; w = (hf / fy) * fx * qa / camAspect; }
    // HUD rects BESIDE the figure (the combo column): slide sideways off them (arms swinging out between solves)
    const top = feet - hf;
    for (const r of screenRects()) {
      if (r.y1 <= top || r.y0 >= feet) continue;
      const x0 = sx - w / 2, x1 = sx + w / 2;
      if (r.x1 <= x0 || r.x0 >= x1) continue;
      const toR = r.x1 + HUD_GAP * 0.5 - x0, toL = r.x0 - HUD_GAP * 0.5 - x1;   // > 0 / < 0
      const okR = x1 + toR <= 1 - MARGIN, okL = x0 + toL >= MARGIN;
      const d = okR && (!okL || toR < -toL) ? toR : okL ? toL : 0;
      sx += d; shift += d;
    }
    if (shift) {   // slid into another column: re-check the headroom there
      const lim2 = topLimit(screenRects(), sx - w / 2, sx + w / 2, feet);
      if (feet - lim2 < hf) { hf = Math.max(0.02, feet - lim2); w = (hf / fy) * fx * qa / camAspect; }
    }
    const Hf = hf / kS, Hq = Hf / fy, Wq = Hq * qa;
    const fxc = (F.x0 + F.x1) / 2;
    // quad offset from the feet anchor (object3d faces the camera, so local x / y are screen right / up)
    mesh.position.set(-(fxc - 0.5) * Wq + shift * 2 * dz * tanH * camAspect, (F.y1 - 0.5) * Hq, 0);
    mesh.scale.set(Wq, Hq, 1);
    P.fig = { x0: +(sx - w / 2).toFixed(3), y0: +(feet - hf).toFixed(3), x1: +(sx + w / 2).toFixed(3), y1: +feet.toFixed(3), limit: +lim.toFixed(3), ratio: +F.ratio.toFixed(3), clamped };
  }

  /** Track the pose extent inside the quad (source bbox through the crop; mirrored like the shader). */
  function trackFigure(frame, dt) {
    const b = frame?.bbox;
    if (!b || !(b.y1 > b.y0) || !crop.w || !crop.h) return;
    const m = uniforms.uMirror.value > 0.5;
    let x0 = (b.x0 - crop.x) / crop.w, x1 = (b.x1 - crop.x) / crop.w;
    if (m) { const t = 1 - x1; x1 = 1 - x0; x0 = t; }
    const y0 = Math.max(0, (b.y0 - crop.y) / crop.h - FIG_PAD), y1 = Math.min(1, (b.y1 - crop.y) / crop.h + FIG_PAD * 0.4);
    x0 = Math.max(0, x0 - FIG_PAD); x1 = Math.min(1, x1 + FIG_PAD);
    const ext = (y1 - y0) * crop.h;                    // visible figure height in source uv
    const k = F.init ? 1 - Math.exp(-dt * 10) : 1;
    // growing upward (arms going up) is taken immediately; everything else is smoothed (mask edge noise)
    F.y0 = y0 < F.y0 || !F.init ? y0 : F.y0 + (y0 - F.y0) * k;
    F.y1 += (y1 - F.y1) * k; F.x0 += (x0 - F.x0) * k; F.x1 += (x1 - F.x1) * k;
    // standing reference: follows a smaller extent quickly, a larger one only slowly (moving closer to the camera),
    // so a raised-arms pose reads as TALLER than standing instead of re-normalising the figure
    if (!F.init) F.ref = ext;
    else F.ref += (ext - F.ref) * (1 - Math.exp(-dt * (ext < F.ref ? 2 : 0.12)));
    const r = Math.min(1.6, Math.max(0.75, ext / Math.max(1e-3, F.ref)));
    F.ratio = r > F.ratio || !F.init ? r : F.ratio + (r - F.ratio) * k;
    F.init = true;
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
      P.solveIn = 0; P.snap = true; P.scrAt = -1e9;
    },
    /** Explicit keep-out list (Object3D / Sphere / Box3 / Vector3 / {center, radius}); null clears. */
    setKeepOut(list) { P.keepOut = list ? [].concat(list) : null; P.solveIn = 0; },
    /**
     * fn() -> [{ x0, y0, x1, y1, tag }] screen-space keep-outs (fractions of the render canvas, y down), e.g. the HUD
     * rects read from the DOM (mirror.js). Re-read every ~0.4 s and on refreshScreenKeepOut(). The figure is placed
     * outside them and its top (raised arms included) is clamped below any of them in its column, every frame.
     */
    setScreenKeepOut(fn) { P.screenKeepOut = fn; P.scrAt = -1e9; P.solveIn = 0; },
    /** Debug: debugSolve(true) records the best solver candidates of each solve in .candidates. */
    debugSolve(on = true) { P.debug = on; },
    get candidates() { return P.cands || null; },
    /** Re-read the screen keep-outs now and re-solve (resize / game state change). */
    refreshScreenKeepOut() { screenRects(true); P.solveIn = 0; },
    /** fn() -> [{ obj, weight, tag }]: automatic keep-outs re-read on every solve (mirror.js wires boss / rift / hero). */
    setAutoKeepOut(fn) { P.autoKeepOut = fn; },
    /** Legacy world placement (with camera parallax). Leaves preset mode until the next setPreset(). */
    setPlacement({ position: p, height: h } = {}) { if (p) base.copy(p); if (h) height = h; P.mode = 'world'; },
    /**
     * { mode, preset, rect (solved standing-figure box, screen fractions), figure (the figure's box THIS frame, after the
     * pose-extent scale and the HUD / safe-frame clamp: { x0, y0, x1, y1, limit, ratio, clamped }), overlap, headroom
     * (1 = room for raised arms), behind, depth, keepOut[] (3D + screen) } of the last solve.
     */
    get placement() { const L = P.last; return { mode: P.mode, preset: P.preset, ...(L && P.mode === 'preset' ? { slot: L.slot, scale: L.scale, rect: L.rect, figure: P.fig, overlap: +L.overlap.toFixed(4), headroom: +(1 - L.head).toFixed(3), behind: L.behind, depth: L.depth, opacity: L.opacity, keepOut: L.keepOut } : {}) }; },
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
        trackFigure(frame, o.dt);
        P.solveIn -= o.dt;
        if (P.solveIn <= 0) { solve(cam, aspect.v); P.solveIn = 0.2; }
        const k = P.snap ? 1 : 1 - Math.exp(-o.dt * 2.5);
        if (!P.snap && P.anchor.distanceTo(P.goal) > P.anchorH * 1.5) P.snap = true;   // camera cut: jump, don't slide
        const kk = P.snap ? 1 : k;
        P.anchor.lerp(P.goal, kk); P.anchorH += (P.goalH - P.anchorH) * kk; P.opacityK += (P.goalOpacityK - P.opacityK) * kk;
        P.snap = false;
        // camera cut that the distance test missed (same anchor, new view): if the feet left the safe frame or went
        // behind the camera, re-solve and jump now rather than drawing one frame off-screen / over the HUD
        _v.copy(P.anchor).applyMatrix4(cam.matrixWorldInverse);
        const behindCam = _v.z > -1;
        _v.applyMatrix4(cam.projectionMatrix);
        if (behindCam || Math.abs(_v.x) > 1.02 || _v.y > 0.95 || _v.y < -1.02) {
          solve(cam, aspect.v); P.solveIn = 0.2;
          P.anchor.copy(P.goal); P.anchorH = P.goalH; P.opacityK = P.goalOpacityK;
        }
        object3d.position.copy(P.anchor);
        cam.getWorldQuaternion(_q); object3d.quaternion.copy(_q);   // face the camera exactly (fit is computed for this)
        fitFrame(cam, o.pulse);
        // in a clear slot the hologram is projected OVER the scenery (floating islands / tree tops must not cut it up);
        // the boss 'behind' fallback keeps depth testing so the Warden hides it
        mat.depthTest = !!P.last?.behind;
        uniforms.uOpacity.value = opacity * P.opacityK;
      } else {
        // legacy world placement: follow the camera partly (reads as very far away) and face it (yaw only)
        const s = height * (1 + 0.012 * o.pulse);
        mesh.position.set(0, 0, 0);
        mesh.scale.set(s * aspect.v, s, 1);
        mat.depthTest = true;
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
