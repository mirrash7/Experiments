// Stylised swing trails: a camera-facing ribbon following a point (fist / foot) for the duration of an attack.
// One BufferGeometry per trail, positions rewritten in place each frame (no per-frame allocation). Anime look:
// hard-edged ribbon, white core into an accent colour, tapering + fading with age.
import * as THREE from 'three';

const VERT = /* glsl */`
attribute float aAge;     // 0 newest .. 1 oldest
attribute float aSide;    // -1 / +1 across the ribbon
varying float vAge; varying float vSide;
void main() {
  vAge = aAge; vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */`
uniform vec3 uColor; uniform vec3 uCore; uniform float uOpacity;
varying float vAge; varying float vSide;
void main() {
  float across = 1.0 - abs(vSide);                    // 0 edge .. 1 centre
  float body = step(0.08 + vAge * 0.55, across);      // hard edge that thins with age
  if (body < 0.5) discard;
  float core = smoothstep(0.55, 0.8, across) * (1.0 - vAge);
  vec3 col = mix(uColor, uCore, core);
  float a = uOpacity * pow(1.0 - vAge, 1.3);
  gl_FragColor = vec4(col, a);
}`;

export class Trail {
  constructor({ points = 16, width = 0.09, color = 0xff8a3d, core = 0xfff3c4 } = {}) {
    this.n = points; this.width = width;
    this.pts = Array.from({ length: points }, () => new THREE.Vector3());
    this.age = new Float32Array(points).fill(1);
    this.count = 0; this.head = 0; this.life = 0.18; this.active = false; this.visible = false; this.paused = false;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(points * 2 * 3);
    const ageA = new Float32Array(points * 2), side = new Float32Array(points * 2);
    for (let i = 0; i < points; i++) { side[2 * i] = -1; side[2 * i + 1] = 1; }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAge', new THREE.BufferAttribute(ageA, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    const idx = [];
    for (let i = 0; i < points - 1; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.ageAttr = g.attributes.aAge;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(core) }, uOpacity: { value: 0.95 } },
    });
    this.mat.toneMapped = false;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 10;
    this.mesh.name = 'fx-trail';
    this._t = new THREE.Vector3(); this._s = new THREE.Vector3(); this._v = new THREE.Vector3();
  }
  setColor(color, core) { this.mat.uniforms.uColor.value.set(color); if (core !== undefined) this.mat.uniforms.uCore.value.set(core); }
  start() { this.active = true; this.count = 0; this.paused = false; }
  stop() { this.active = false; }
  /** p: world position of the tracked point this frame (or null), camPos: world camera position */
  update(dt, p, camPos) {
    const n = this.n;
    for (let i = 0; i < n; i++) this.age[i] = Math.min(1, this.age[i] + dt / this.life);
    if (this.active && p) {
      this.head = (this.head + 1) % n;
      this.pts[this.head].copy(p); this.age[this.head] = 0;
      this.count = Math.min(n, this.count + 1);
    }
    // visible while any point is young
    let alive = false;
    for (let i = 0; i < this.count; i++) if (this.age[(this.head - i + n) % n] < 1) { alive = true; break; }
    this.visible = alive && this.count > 1;
    this.mesh.visible = this.visible;
    if (!this.visible) return;
    const pos = this.pos, ageA = this.ageAttr.array;
    for (let k = 0; k < n; k++) {
      const i = Math.min(k, this.count - 1);                     // ribbon from newest (k = 0) to oldest
      const cur = this.pts[(this.head - i + n) % n];
      const a = this.age[(this.head - i + n) % n];
      const prev = this.pts[(this.head - Math.max(0, i - 1) + n) % n], next = this.pts[(this.head - Math.min(this.count - 1, i + 1) + n) % n];
      this._t.copy(prev).sub(next);
      this._v.copy(camPos).sub(cur);
      this._s.crossVectors(this._t, this._v);
      const l = this._s.length();
      const w = this.width * (1 - a) * (1 - 0.6 * (i / Math.max(1, this.count - 1)));
      if (l > 1e-8) this._s.multiplyScalar(w / l); else this._s.set(0, 0, 0);
      pos[6 * k] = cur.x - this._s.x; pos[6 * k + 1] = cur.y - this._s.y; pos[6 * k + 2] = cur.z - this._s.z;
      pos[6 * k + 3] = cur.x + this._s.x; pos[6 * k + 4] = cur.y + this._s.y; pos[6 * k + 5] = cur.z + this._s.z;
      ageA[2 * k] = ageA[2 * k + 1] = k < this.count ? a : 1;
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.ageAttr.needsUpdate = true;
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
