// BREAKLIGHT CV: the Overdrive "spectral echo": a giant translucent billboard of the player's neon silhouette in the
// sky behind the hero (worldScene), additive + HDR so the post chain's bloom picks up the rim. Fed by the segmenter's
// cutout (one small texture upload per new mask frame), with a delayed ghost outline, beat pulse and camera parallax.
import * as THREE from 'three';
import { NEON_UNIFORMS, NEON_FUNCS } from './neon.js';

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
${NEON_FUNCS}
void main() {
  vec4 c = neonShade(vUv);
  // fade the bottom into the cloud sea and the sides into the sky
  float fade = smoothstep(0.0, 0.18, 1.0 - vUv.y) * smoothstep(0.0, 0.08, vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.x);
  // premultiplied: emissive neon added on top, the sky behind the body dimmed a little for contrast
  float k = uOpacity * fade;
  outColor = vec4(c.rgb * k, c.a * k * uDim);
}`;

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

export function createEcho({ height = 36, position = new THREE.Vector3(0, 11, 74), parallax = 0.7 } = {}) {
  const tex = makeTex(), ghostTex = makeTex();
  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1); blank.needsUpdate = true;
  const uniforms = {
    uTex: { value: blank }, uGhost: { value: blank }, uGhostAmt: { value: 0.0 },
    uColA: { value: new THREE.Color('#ffd84a') }, uColB: { value: new THREE.Color('#ff6a2a') },
    uTime: { value: 0 }, uPulse: { value: 0 }, uIntensity: { value: 1.7 }, uMirror: { value: 1 },
    uDetail: { value: 0.85 }, uFill: { value: 0.8 }, uPour: { value: 0 }, uLod: { value: 1.5 },
    uDotGrid: { value: new THREE.Vector2(96, 54) }, uLines: { value: 70 }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
    uOpacity: { value: 0 }, uDim: { value: 0.55 },
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
  let texVer = -1, texSrc = null, texW = 0, texH = 0, ghostVer = -1, opacity = 0, target = 0;
  let warm = 2;   // render the first frames at zero opacity so the shader compiles at boot, not when Overdrive hits
  const crop = { x: 0, y: 0, w: 1, h: 1 }, aspect = { v: 16 / 9 };
  const _cp = new THREE.Vector3();

  function setImage(t, img, w, h, dims) {
    if (dims.w && (dims.w !== w || dims.h !== h)) t.dispose();   // immutable storage: re-allocate on resize
    dims.w = w; dims.h = h;
    t.image = img; t.needsUpdate = true;
  }
  const tDims = { w: 0, h: 0 }, gDims = { w: 0, h: 0 };

  return {
    object3d, mesh, material: mat, uniforms,
    get opacity() { return opacity; },
    setVisible(on) { target = on ? 1 : 0; },
    /** Re-run the zero-opacity warm-up (e.g. after a context loss / quality change). */
    warmup(frames = 2) { warm = frames; },
    /**
     * frame: segmenter frame; o: { dt, camera, palette{a,b}(THREE.Color pair), pulse, time, ghost frame|null, ghostAmt, crop{x,y,w,h} }
     */
    update(frame, o) {
      opacity += (target - opacity) * (1 - Math.exp(-o.dt * (target ? 2.4 : 3.5)));
      if (target === 0 && opacity < 0.004) opacity = 0;
      object3d.visible = opacity > 0 || warm > 0;
      if (warm > 0) warm--;
      if (!object3d.visible) return;
      uniforms.uOpacity.value = opacity;
      if (frame?.image && (frame.version !== texVer || frame.image !== texSrc)) {
        setImage(tex, frame.image, frame.w, frame.h, tDims);
        uniforms.uTex.value = tex; texVer = frame.version; texSrc = frame.image; texW = frame.w; texH = frame.h;
      }
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
      // size: keep the cropped region's aspect; beat pulse breathes the scale
      aspect.v = texW && texH ? (texW * crop.w) / (texH * crop.h) : 16 / 9;
      const s = height * (1 + 0.035 * o.pulse);
      mesh.scale.set(s * aspect.v, s, 1);
      uniforms.uDotGrid.value.set(Math.round(70 * aspect.v), 70);
      // parallax: follow the camera partly (reads as very far away) and face it (yaw only)
      const cam = o.camera;
      if (cam) {
        cam.getWorldPosition(_cp);
        object3d.position.set(base.x + _cp.x * parallax, base.y + (_cp.y - 2) * parallax * 0.5, base.z + _cp.z * parallax * 0.3);
        object3d.rotation.set(0, Math.atan2(_cp.x - object3d.position.x, _cp.z - object3d.position.z), 0);
      } else object3d.position.copy(base);
    },
    setPlacement({ position: p, height: h } = {}) { if (p) base.copy(p); if (h) height = h; },
    dispose() { tex.dispose(); ghostTex.dispose(); blank.dispose(); mat.dispose(); mesh.geometry.dispose(); },
  };
}
