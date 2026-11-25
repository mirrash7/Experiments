// Combat juice for the motion game: hit-stop, trauma camera shake, punch/kick swing trails, hit sparks + impact
// flash + shock ring, landing dust. Driven by the motion pipeline's events (web/src/motion: 'impact', 'land',
// 'action') and its final hero pose (state.heroFK), so it fires on the frame a fist/foot reaches full extension.
//
//   import { createFx } from './fx/index.js';
//   const fx = createFx({ scene, camera, hero, motion });     // once per hero/pipeline (fx.setMotion(m) to swap)
//   // per frame, AFTER motion.update() and the camera follow, BEFORE rendering:
//   const timeScale = fx.update(dt);                          // < 1 during a hit-stop
//   hero.update(dt * timeScale);                              // e.g. spring bones / expressions slow down too
//
// Everything is pooled (one draw for all sprites, one per trail), no per-frame allocation; ~0.05-0.15 ms/frame.
// Toggles: fx.enabled, fx.options.{hitStop, shake, trails, sparks, dust, flash} (live), fx.options.shakeScale.
import * as THREE from 'three';
import { Trail } from './trails.js';
import { SpritePool, SHAPE } from './sprites.js';

export const FX_DEFAULTS = {
  hitStop: true, hitStopMs: { punch: 60, kick: 80 }, hitStopScale: 0.05,
  shake: true, shakeScale: 1, shakeTrauma: { punch: 0.32, kick: 0.5, land: 0.38 }, shakeMaxPos: 0.03, shakeMaxRot: 0.012,
  trails: true, sparks: true, flash: true, dust: true,
  colors: { punch: 0xff8a3d, punchCore: 0xfff3c4, kick: 0x52c8ff, kickCore: 0xeaffff, dust: 0xd9ccb6 },
};

export function createFx(opts) { return new CombatFx(opts); }

const LIMB = { punchLeft: 'leftHand', punchRight: 'rightHand', kickLeft: 'leftFoot', kickRight: 'rightFoot' };
const ACCENT_OF = { leftHand: 'punchLeft', rightHand: 'punchRight', leftFoot: 'kickLeft', rightFoot: 'kickRight' };
const LIMBS = Object.keys(ACCENT_OF);

export class CombatFx {
  constructor({ scene, camera, hero = null, motion = null, options = {} } = {}) {
    this.scene = scene; this.camera = camera; this.hero = hero;
    this.options = { ...FX_DEFAULTS, ...options, colors: { ...FX_DEFAULTS.colors, ...(options.colors ?? {}) } };
    this.enabled = true;
    this.group = new THREE.Group(); this.group.name = 'CombatFx';
    scene.add(this.group);
    const C = this.options.colors;
    // world-scale: the hero's root scale (VRM hero in the game is scaled; the lab is 1)
    this.trails = {};
    for (const limb of ['leftHand', 'rightHand', 'leftFoot', 'rightFoot']) {
      const kick = limb.endsWith('Foot');
      const t = new Trail({ points: 16, width: kick ? 0.11 : 0.08, color: kick ? C.kick : C.punch, core: kick ? C.kickCore : C.punchCore });
      this.trails[limb] = t; this.group.add(t.mesh);
    }
    this.sprites = new SpritePool(160);
    this.group.add(this.sprites.mesh);
    this.trauma = 0; this._t = 0; this.stopLeft = 0;
    this._shakePos = new THREE.Vector3(); this._shakeQ = new THREE.Quaternion();
    this._camPosAfter = new THREE.Vector3(); this._camQAfter = new THREE.Quaternion(); this._shaken = false;
    this._m = new THREE.Matrix4(); this._p = new THREE.Vector3(); this._d = new THREE.Vector3(); this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(); this._camPos = new THREE.Vector3(); this._tmp = new THREE.Vector3(); this._tmp2 = new THREE.Vector3();
    this.stats = { ms: 0, msAvg: 0, sprites: 0, impacts: 0, lands: 0 };
    this._offs = [];
    if (motion) this.setMotion(motion);
  }

  /** Attach to a (new) motion pipeline: subscribes to its events. */
  setMotion(motion) {
    for (const off of this._offs) off(); this._offs = [];
    this.motion = motion;
    if (!motion?.events) return;
    this._offs.push(motion.events.on('impact', (e) => this.impact(e)));
    this._offs.push(motion.events.on('land', (e) => this.land(e)));
    this._offs.push(motion.events.on('action', (e) => {
      const limb = LIMB[e.name];
      if (limb && e.accent && this.enabled && this.options.trails) this.trails[limb].start();
    }));
  }
  setHero(hero) { this.hero = hero; }

  // hero space -> world
  _heroMatrix() {
    const r = this.hero?.root;
    if (r) { r.updateWorldMatrix(true, false); return r.matrixWorld; }
    return this._m.identity();
  }
  _scale() { const r = this.hero?.root; return r ? r.getWorldScale(this._tmp2).y : 1; }

  /** Punch / kick impact: hit-stop, shake, flash + ring + sparks. e = {kind, side, pos, dir, strength, space} */
  impact(e) {
    if (!this.enabled) return;
    const O = this.options, kick = e.kind === 'kick', k = e.strength ?? 1, s = this._scale();
    this.stats.impacts++;
    const M = this._heroMatrix();
    const p = this._p.copy(e.pos); if (e.space !== 'world') p.applyMatrix4(M);
    const d = this._d.copy(e.dir ?? _fwd); if (e.space !== 'world') d.transformDirection(M);
    if (O.hitStop) {
      const ms = (kick ? O.hitStopMs.kick : O.hitStopMs.punch) * Math.min(1.2, 0.8 + 0.2 * k);
      this.stopLeft = Math.max(this.stopLeft, ms / 1000);
      this.motion?.hitStop?.(ms, O.hitStopScale);
    }
    if (O.shake) this.trauma = Math.min(1, this.trauma + (kick ? O.shakeTrauma.kick : O.shakeTrauma.punch) * k);
    const col = kick ? O.colors.kick : O.colors.punch;
    if (O.flash) {
      this.sprites.spawn(SHAPE.star, p.x, p.y, p.z, 0, 0, 0, { life: 0.11, size: 0.2 * s * (kick ? 1.3 : 1), size1: 0.3 * s * (kick ? 1.3 : 1), color: col, rot: Math.random() * 3 });
      this.sprites.spawn(SHAPE.ring, p.x, p.y, p.z, 0, 0, 0, { life: 0.16, size: 0.06 * s, size1: (kick ? 0.3 : 0.2) * s, color: kick ? O.colors.kickCore : O.colors.punchCore });
    }
    if (O.sparks) {
      const n = kick ? 12 : 9;
      for (let i = 0; i < n; i++) {
        // cone around the strike direction + a few flying back / sideways
        const v = this._tmp.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        v.addScaledVector(d, i < n * 0.7 ? 1.4 : -0.3).normalize();
        const sp = (3 + Math.random() * 4) * s * (kick ? 1.15 : 1);
        this.sprites.spawn(SHAPE.streak, p.x, p.y, p.z, v.x * sp, v.y * sp, v.z * sp,
          { life: 0.14 + Math.random() * 0.12, size: (0.035 + Math.random() * 0.02) * s, stretch: 2.6, color: col, drag: 9 });
      }
    }
  }

  /** Jump landing: dust puffs around both feet + a small shake. e = {feet: [Vector3, Vector3], strength, space} */
  land(e) {
    if (!this.enabled) return;
    const O = this.options, s = this._scale(), k = e.strength ?? 1;
    this.stats.lands++;
    if (O.shake) this.trauma = Math.min(1, this.trauma + O.shakeTrauma.land * k);
    if (!O.dust) return;
    const M = this._heroMatrix();
    const floorY = 0.02 * s + (this.hero?.root ? this.hero.root.getWorldPosition(this._tmp2).y : 0);
    for (const f of e.feet ?? []) {
      const p = this._p.copy(f); if (e.space !== 'world') p.applyMatrix4(M);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.random() * 0.6, sp = (0.7 + Math.random() * 0.6) * s * k;
        this.sprites.spawn(SHAPE.puff, p.x + Math.cos(a) * 0.05 * s, floorY + 0.03 * s, p.z + Math.sin(a) * 0.05 * s,
          Math.cos(a) * sp, (0.15 + Math.random() * 0.25) * s, Math.sin(a) * sp,
          { life: 0.45 + Math.random() * 0.2, size: 0.05 * s, size1: (0.1 + Math.random() * 0.05) * s, color: O.colors.dust, drag: 5, gravity: 0.3 * s, rot: Math.random() * 6 });
      }
    }
  }

  /** Advance everything; returns the time scale for the rest of the frame (< 1 during a hit-stop). */
  update(dt) {
    const t0 = performance.now();
    dt = Math.min(dt || 0, 0.1);
    this._t += dt;
    const O = this.options;
    let timeScale = 1;
    if (this.stopLeft > 0) { this.stopLeft -= dt; timeScale = O.hitStopScale; }
    const cam = this.camera;
    // undo last frame's shake if nobody moved the camera since (the game's follow / orbit rewrites it anyway)
    if (this._shaken) {
      if (cam.position.equals(this._camPosAfter)) cam.position.sub(this._shakePos);
      if (cam.quaternion.equals(this._camQAfter)) cam.quaternion.multiply(this._q.copy(this._shakeQ).invert());
      this._shaken = false;
    }
    cam.getWorldPosition(this._camPos);
    // trails follow the fist (knuckles) / foot (toes) of the final pose
    const fk = this.motion?.state?.heroFK;
    const M = this._heroMatrix();
    const accents = this.motion?.accents?.active;
    for (let li = 0; li < LIMBS.length; li++) {
      const limb = LIMBS[li], tr = this.trails[limb];
      if (tr.active) {
        const name = ACCENT_OF[limb];
        let a = null;
        if (accents) for (let j = 0; j < accents.length; j++) if (accents[j].name === name) { a = accents[j]; break; }
        if (!a || this.motion._t - a.t0 > (limb.endsWith('Hand') ? 0.2 : 0.3)) tr.stop();
        // kicks: no ribbon during the chamber (knee raise), only the snap out and back
        tr.paused = !!a && limb.endsWith('Foot') && this.motion._t - a.t0 < 0.09;
      }
      let p = null;
      if (fk && (tr.active || tr.visible) && !tr.paused && this.enabled && O.trails) {
        const end = fk.pos[limb], from = fk.pos[limb.endsWith('Hand') ? limb.replace('Hand', 'LowerArm') : limb.replace('Foot', 'LowerLeg')];
        if (end && from) {
          p = this._tmp.copy(end).sub(from).normalize().multiplyScalar(limb.endsWith('Hand') ? 0.06 : 0.1).add(end).applyMatrix4(M);
        }
      }
      if (!this.enabled || !O.trails) { tr.stop(); tr.mesh.visible = false; continue; }
      tr.width = (limb.endsWith('Foot') ? 0.085 : 0.07) * this._scale();
      tr.update(dt * (timeScale < 1 ? 0.25 : 1), p, this._camPos);
    }
    this.sprites.update(dt * (timeScale < 1 ? 0.3 : 1));
    this.stats.sprites = this.sprites.active;
    // trauma shake (Eiserloh): offset = max * trauma^2 * smooth noise; decays linearly
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.enabled && O.shake && this.trauma > 0.001) {
      const sh = this.trauma * this.trauma * O.shakeScale, s = this._scale(), t = this._t;
      this._shakePos.set(noise(t, 47, 0.3), noise(t, 53, 1.9), noise(t, 41, 4.1) * 0.5).multiplyScalar(O.shakeMaxPos * s * sh);
      this._e.set(noise(t, 37, 2.2) * O.shakeMaxRot * sh, noise(t, 43, 5.3) * O.shakeMaxRot * sh, noise(t, 31, 0.7) * O.shakeMaxRot * 1.5 * sh);
      this._shakeQ.setFromEuler(this._e);
      cam.position.add(this._shakePos);
      cam.quaternion.multiply(this._shakeQ);
      this._camPosAfter.copy(cam.position); this._camQAfter.copy(cam.quaternion);
      this._shaken = true;
    }
    this.stats.ms = performance.now() - t0;
    this.stats.msAvg += (this.stats.ms - this.stats.msAvg) * 0.02;
    return timeScale;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) { this.sprites.clear(); for (const t of Object.values(this.trails)) { t.stop(); t.mesh.visible = false; } this.trauma = 0; this.stopLeft = 0; }
  }
  dispose() {
    for (const off of this._offs) off();
    for (const t of Object.values(this.trails)) t.dispose();
    this.sprites.dispose();
    this.group.removeFromParent();
  }
}
const _fwd = new THREE.Vector3(0, 0, 1);
const noise = (t, f, ph) => Math.sin(t * f + ph) * 0.6 + Math.sin(t * f * 2.31 + ph * 1.7) * 0.4;
