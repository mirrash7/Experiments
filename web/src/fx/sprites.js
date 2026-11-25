// Pooled camera-facing sprite particles for combat VFX, one draw call: hit sparks (streaks stretched along their
// velocity), impact flash (hard-edged star), shock ring, landing dust puffs (two-tone toon blobs that erode).
// All shapes are procedural in the fragment shader (no textures); CPU simulation writes into preallocated
// instanced attributes, so spawning and updating allocate nothing.
import * as THREE from 'three';

export const SHAPE = { streak: 0, star: 1, puff: 2, ring: 3 };

const VERT = /* glsl */`
attribute vec3 iPos; attribute vec3 iDir; attribute vec4 iColor; attribute vec4 iParam;  // size, stretch, rot, shape
attribute float iLife;    // 0 born .. 1 dead
varying vec2 vUv; varying vec4 vColor; varying float vShape; varying float vLife;
void main() {
  vUv = position.xy * 2.0; vColor = iColor; vShape = iParam.w; vLife = iLife;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 c = position.xy * 2.0;          // -1..1
  float size = iParam.x;
  vec2 off;
  if (iParam.w < 0.5) {               // streak: long axis along the projected velocity
    vec3 d = (modelViewMatrix * vec4(iDir, 0.0)).xyz;
    vec2 ax = length(d.xy) > 1e-5 ? normalize(d.xy) : vec2(1.0, 0.0);
    vec2 ay = vec2(-ax.y, ax.x);
    off = ax * c.x * size * iParam.y + ay * c.y * size * 0.18;
  } else {
    float r = iParam.z; vec2 cs = vec2(cos(r), sin(r));
    off = vec2(c.x * cs.x - c.y * cs.y, c.x * cs.y + c.y * cs.x) * size;
  }
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
varying vec2 vUv; varying vec4 vColor; varying float vShape; varying float vLife;
uniform vec3 uCore;
void main() {
  vec2 p = vUv; float r = length(p); float a = 0.0; vec3 col = vColor.rgb;
  if (vShape < 0.5) {                 // streak: sharp diamond, white-hot core
    float d = abs(p.x) + abs(p.y) * 1.0;
    a = step(d, 1.0);
    col = mix(col, uCore, step(d, 0.45));
  } else if (vShape < 1.5) {          // star burst: 8 spikes
    float th = atan(p.y, p.x);
    float spike = 0.28 + 0.72 * pow(abs(cos(th * 4.0)), 10.0);
    a = step(r, spike * (1.0 - vLife * 0.3));
    col = mix(col, uCore, step(r, spike * 0.55));
  } else if (vShape < 2.5) {          // dust puff: two-tone blob that erodes from the edge as it dies
    float n = sin(atan(p.y, p.x) * 5.0 + vColor.a * 20.0) * 0.08;
    float edge = 1.0 - vLife * 0.65 + n;
    a = step(r, edge);
    col = mix(col * 0.82, col, step(0.2, p.y + 0.35 - r * 0.2));   // darker underside
  } else {                            // ring
    float w = 0.16 * (1.0 - vLife);
    a = step(1.0 - w - 0.04, r) * step(r, 1.0);
  }
  if (a < 0.5) discard;
  float fade = vShape > 1.5 && vShape < 2.5 ? 1.0 - smoothstep(0.7, 1.0, vLife) : 1.0 - smoothstep(0.6, 1.0, vLife);
  gl_FragColor = vec4(col, fade * (vShape > 2.5 ? 0.9 : 1.0));
}`;

export class SpritePool {
  constructor(max = 128) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    g.index = quad.index; g.attributes.position = quad.attributes.position;
    const mk = (n) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(3); this.aDir = mk(3); this.aColor = mk(4); this.aParam = mk(4); this.aLife = mk(1);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iDir', this.aDir); g.setAttribute('iColor', this.aColor);
    g.setAttribute('iParam', this.aParam); g.setAttribute('iLife', this.aLife);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      uniforms: { uCore: { value: new THREE.Color(0xffffff) } } });
    this.mat.toneMapped = false;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 11; this.mesh.name = 'fx-sprites';
    // simulation state (struct of arrays)
    this.alive = new Uint8Array(max); this.t = new Float32Array(max); this.life = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.size0 = new Float32Array(max); this.size1 = new Float32Array(max); this.spin = new Float32Array(max);
    this.top = 0; this.active = 0;
    this._attrs = [this.aPos, this.aDir, this.aParam, this.aLife, this.aColor];
  }
  /** Spawn one sprite; returns false when the pool is full. */
  spawn(shape, x, y, z, vx, vy, vz, { life = 0.3, size = 0.1, size1 = null, stretch = 1, color = 0xffffff, drag = 4, gravity = 0, rot = 0, spin = 0 } = {}) {
    let i = -1;
    for (let k = 0; k < this.max; k++) if (!this.alive[k]) { i = k; break; }
    if (i < 0) return false;
    this.alive[i] = 1; this.t[i] = 0; this.life[i] = life;
    this.vel[3 * i] = vx; this.vel[3 * i + 1] = vy; this.vel[3 * i + 2] = vz;
    this.drag[i] = drag; this.grav[i] = gravity; this.size0[i] = size; this.size1[i] = size1 ?? size; this.spin[i] = spin;
    const X = this.aPos.array; X[3 * i] = x; X[3 * i + 1] = y; X[3 * i + 2] = z;
    _c.set(color);
    const A = this.aColor.array; A[4 * i] = _c.r; A[4 * i + 1] = _c.g; A[4 * i + 2] = _c.b; A[4 * i + 3] = Math.random();
    const P = this.aParam.array; P[4 * i] = size; P[4 * i + 1] = stretch; P[4 * i + 2] = rot; P[4 * i + 3] = shape;
    this.aLife.array[i] = 0;
    this.top = Math.max(this.top, i + 1);
    return true;
  }
  update(dt) {
    const pos = this.aPos.array, dir = this.aDir.array, P = this.aParam.array, L = this.aLife.array, v = this.vel;
    let top = 0, act = 0;
    for (let i = 0; i < this.top; i++) {
      if (!this.alive[i]) { L[i] = 1; continue; }
      this.t[i] += dt;
      const u = this.t[i] / this.life[i];
      if (u >= 1) { this.alive[i] = 0; L[i] = 1; P[4 * i] = 0; continue; }
      const k = Math.exp(-this.drag[i] * dt);
      v[3 * i] *= k; v[3 * i + 1] = v[3 * i + 1] * k - this.grav[i] * dt; v[3 * i + 2] *= k;
      pos[3 * i] += v[3 * i] * dt; pos[3 * i + 1] += v[3 * i + 1] * dt; pos[3 * i + 2] += v[3 * i + 2] * dt;
      dir[3 * i] = v[3 * i]; dir[3 * i + 1] = v[3 * i + 1]; dir[3 * i + 2] = v[3 * i + 2];
      P[4 * i] = this.size0[i] + (this.size1[i] - this.size0[i]) * (1 - (1 - u) * (1 - u));   // ease-out growth
      P[4 * i + 2] += this.spin[i] * dt;
      L[i] = u;
      top = i + 1; act++;
    }
    this.top = top; this.active = act;
    const g = this.mesh.geometry;
    g.instanceCount = top;
    this.mesh.visible = top > 0;
    if (top > 0) for (const a of this._attrs) a.needsUpdate = true;
  }
  clear() { this.alive.fill(0); this.top = 0; this.mesh.geometry.instanceCount = 0; this.mesh.visible = false; }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
const _c = new THREE.Color();
