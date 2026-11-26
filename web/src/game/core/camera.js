// Camera director: gameplay 3/4 rear (behind the hero at -Z looking +Z, no mirroring, so screen left = player left),
// title orbit, front framings for calibrate / results, cinematic cuts (blast, boss intro, replay) and a subtle
// punch-in on Perfects. The director owns the camera transform; FX shake is added on top afterwards (fx.update).
import * as THREE from 'three';

// Framings in units of a 1.6 m hero (scaled by the loaded hero's height). pos / look are world positions.
export const SHOTS = {
  gameplay: { pos: [-0.78, 2.05, -3.3], look: [0.22, 1.12, 5.0], fov: 50 },
  boss: { pos: [-0.7, 1.75, -3.9], look: [0.1, 2.6, 12.0], fov: 54 },
  calibrate: { pos: [0, 1.3, 4.3], look: [0, 0.95, 0], fov: 36 },
  results: { pos: [0.75, 1.3, 3.5], look: [0.15, 1.0, 0], fov: 34 },
  tutorial: { pos: [-0.9, 1.85, -3.0], look: [0.1, 1.0, 3.5], fov: 48 },
  blast: { pos: [4.2, 1.7, 1.2], look: [0, 1.6, 6], fov: 44 },   // side 3/4, off the beam axis
  bossIntro: { pos: [0.55, 0.55, -2.3], look: [0, 4.5, 22], fov: 46 },
  replay: { pos: [0.6, 1.25, 3.0], look: [0, 1.0, 0.2], fov: 36 },
};

export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'title';
    this.shot = null; this.shotLeft = 0; this.shotT = 0;
    this.heroH = 1.6;
    this.pos = new THREE.Vector3(0, 1.6, 4); this.look = new THREE.Vector3(0, 1, 0);
    this.goalPos = new THREE.Vector3(); this.goalLook = new THREE.Vector3();
    this.fov = 40; this.goalFov = 40;
    this.kick = 0;                  // punch-in amount 0..1
    this.t = 0;
    this.follow = new THREE.Vector3();
    this._hips = new THREE.Vector3();
    this._snap = true;
    this.blend = 3.2;               // 1/s
  }
  setHeroHeight(h) { this.heroH = h || 1.6; }

  /** Base mode: 'title' | 'gameplay' | 'boss' | 'calibrate' | 'results' | 'tutorial' | 'replay'. */
  setMode(mode, { cut = false } = {}) {
    if (mode !== this.mode && this._crosses(mode)) cut = true;
    this.mode = mode;
    if (cut) this._snap = true;
  }
  /** Cinematic shot for `dur` seconds, then back to the base mode. */
  cut(shot, dur = 1.6) {
    this.shot = shot; this.shotLeft = dur; this.shotT = 0;
    this._snap = true;
  }
  endShot({ cut = true } = {}) { if (this.shot) { this.shot = null; if (cut || this._crosses(this.mode)) this._snap = true; } }
  punchIn(strength = 1) { this.kick = Math.min(1, this.kick + 0.6 * strength); }

  // blending from one side of the hero to the other would fly through it: cut instead
  _crosses(mode) {
    const S = SHOTS[mode]; if (!S) return false;
    return Math.sign(S.pos[2]) !== Math.sign(this.pos.z) && Math.abs(this.pos.z) > 0.5;
  }

  _goal(name, t) {
    const k = this.heroH / 1.6;
    if (name === 'title') {
      const a = 0.35 + t * 0.12, r = 4.3 * k;
      this.goalPos.set(Math.sin(a) * r, 1.55 * k, Math.cos(a) * r);
      this.goalLook.set(0, 0.95 * k, 0);
      this.goalFov = 36;
      return;
    }
    const S = SHOTS[name] ?? SHOTS.gameplay;
    this.goalPos.set(S.pos[0] * k, S.pos[1] * k, S.pos[2] * k);
    this.goalLook.set(S.look[0] * k, S.look[1] * k, S.look[2] * (Math.abs(S.look[2]) > 4 ? 1 : k));
    this.goalFov = S.fov;
    if (name === 'replay' || name === 'results') {         // slow drift around the front
      const a = Math.sin(t * 0.18) * 0.32;
      const x = this.goalPos.x, z = this.goalPos.z;
      this.goalPos.x = x * Math.cos(a) + z * Math.sin(a); this.goalPos.z = -x * Math.sin(a) + z * Math.cos(a);
    }
    if (name === 'bossIntro') this.goalPos.z += Math.min(1, this.shotT / 3) * 0.6;     // slow push-in
    if (name === 'blast') this.goalPos.z -= Math.min(1, this.shotT / 1.5) * 0.4;
  }

  update(dt, hero) {
    this.t += dt;
    if (this.shot) {
      this.shotT += dt;
      if ((this.shotLeft -= dt) <= 0) this.endShot();
    }
    this._goal(this.shot ?? this.mode, this.shot ? this.shotT : this.t);
    // gameplay: soft follow of the hero's lateral position (step dodges)
    if (hero?.bones?.hips && !this.shot && (this.mode === 'gameplay' || this.mode === 'boss' || this.mode === 'tutorial')) {
      hero.bones.hips.getWorldPosition(this._hips);
      this.follow.x += (this._hips.x * 0.45 - this.follow.x) * (1 - Math.exp(-dt * 2.5));
      this.goalPos.x += this.follow.x; this.goalLook.x += this.follow.x * 0.6;
    }
    if (this._snap) {
      this.pos.copy(this.goalPos); this.look.copy(this.goalLook); this.fov = this.goalFov; this._snap = false;
    } else {
      const a = 1 - Math.exp(-dt * this.blend);
      this.pos.lerp(this.goalPos, a); this.look.lerp(this.goalLook, a); this.fov += (this.goalFov - this.fov) * a;
    }
    // punch-in: fast in, eased out (subtle: ~1.6 deg FOV + 4 % dolly)
    this.kick = Math.max(0, this.kick - dt * 2.2);
    const kk = this.kick * this.kick * (3 - 2 * this.kick);
    const cam = this.camera;
    cam.position.copy(this.pos).lerp(this.look, 0.04 * kk);
    cam.lookAt(this.look);
    const fov = this.fov - 1.6 * kk;
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
}
