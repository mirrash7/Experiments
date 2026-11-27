// Charge-blast detector: hands up held ~1 s (an aura builds) -> both hands pushed forward fast, extended in front of
// the chest = Breaklight blast. Reads the detector's `handsUp` state and the final hero pose (motion.state.heroFK,
// hero space: faces +Z, left = +X), so it works the same for every tracker.
//
// Hands-up also accepts the overhead pose when the wrists leave the TOP of the camera frame (laptop webcams at 2 m
// often crop raised hands; the detector's `handsUp` then drops): both elbows above the shoulders and each wrist
// either above the nose, low-confidence / missing, or at the top edge of the image (handsUpAlt).
import * as THREE from 'three';

export const CHARGE = {
  holdS: 0.95,          // hands-up time to fully charge
  graceS: 1.6,          // a full charge stays armed this long after the hands come down
  pushSpeed: 1.25,      // m/s (scaled by hero height / 1.6) forward hand speed, both hands
  reach: 0.22,          // hands at least this far in front of the chest (m, scaled)
  apart: 0.75,          // hands closer than this (m, scaled): a two-hand push, not a spread
};

/** Overhead-hands fallback from the raw tracker frame (joints y-up, conf 0..1, kp2d normalized, y down). */
export function handsUpAlt(frame) {
  const J = frame?.joints, C = frame?.conf ?? {};
  if (!J || !J.leftShoulder || !J.rightShoulder || !J.leftElbow || !J.rightElbow) return false;
  const ok = (k) => (C[k] ?? 1) > 0.35;
  if (!ok('leftElbow') || !ok('rightElbow') || !ok('leftShoulder') || !ok('rightShoulder')) return false;
  const torso = J.leftHip && J.rightHip ? Math.abs((J.leftShoulder.y + J.rightShoulder.y) / 2 - (J.leftHip.y + J.rightHip.y) / 2) : 0.5;
  const m = Math.max(0.04, torso * 0.12);
  const elbowsUp = J.leftElbow.y > J.leftShoulder.y + m && J.rightElbow.y > J.rightShoulder.y + m;
  if (!elbowsUp) return false;
  const kp = frame.kp2d, names = frame.kpNames;
  const wristUp = (side) => {
    const W = J[side + 'Wrist'];
    if (!W || !ok(side + 'Wrist')) return true;                       // lost: most likely above the frame
    if (J.nose && W.y > J.nose.y) return true;
    if (kp && names) { const i = names.indexOf(side + 'Wrist'); if (i >= 0 && kp[i] && kp[i].y < 0.04) return true; }
    return false;
  };
  return wristUp('left') && wristUp('right');
}

export class ChargeDetector {
  constructor({ onLevel, onCharged, onBlast, onCancel } = {}) {
    Object.assign(this, { onLevel, onCharged, onBlast, onCancel });
    this.level = 0; this.charged = false; this.armedLeft = 0; this.enabled = true;
    this._prevL = new THREE.Vector3(); this._prevR = new THREE.Vector3(); this._have = false;
    this._vL = 0; this._vR = 0;
    this.origin = new THREE.Vector3(); this.dir = new THREE.Vector3(0, 0, 1);
    this.lastBlastAt = -1e9;
  }
  reset() {
    if (this.level > 0 || this.charged) this.onCancel?.();
    this.level = 0; this.charged = false; this.armedLeft = 0; this._have = false;
  }
  /** True while a charge is building or armed (the game ignores punches then: the push would read as a jab). */
  get busy() { return this.level > 0.5 || this.charged; }

  update(dt, motion, heroHeight = 1.6) {
    if (!this.enabled || !motion || dt <= 0) return;
    const st = motion.actions?.state ?? {};
    const fk = motion.state?.heroFK;
    const k = heroHeight / 1.6;
    // build / decay the charge (not from a jump: arms swing overhead on a take-off)
    const lastJump = motion.actions?.lastFire?.jump ?? -1e9;
    const jumping = st.jump || performance.now() - lastJump < 900;
    if (jumping && !this.charged && this.level > 0) { this.level = 0; this.onCancel?.(); }
    const up = st.handsUp || (this.altHandsUp !== false && handsUpAlt(motion.lastFrame));
    this.handsUp = up;
    if (up && !jumping) {
      this.level = Math.min(1, this.level + dt / CHARGE.holdS);
      if (this.level >= 1 && !this.charged) { this.charged = true; this.onCharged?.(); }
      if (this.charged) this.armedLeft = CHARGE.graceS;
    } else if (this.charged) {
      this.armedLeft -= dt;
      if (this.armedLeft <= 0) { this.charged = false; this.level = 0; this.onCancel?.(); }
    } else if (this.level > 0) {
      this.level = Math.max(0, this.level - dt * 2.5);
      if (this.level === 0) this.onCancel?.();
    }
    this.onLevel?.(this.level, this.charged);
    if (!fk?.pos?.leftHand || !fk.pos.rightHand) { this._have = false; return; }
    const L = fk.pos.leftHand, R = fk.pos.rightHand;
    const chest = fk.pos.chest ?? fk.pos.spine ?? fk.pos.hips;
    if (this._have) {
      const a = 1 - Math.exp(-dt / 0.035);    // ~35 ms smoothing of the forward speed
      this._vL += ((L.z - this._prevL.z) / dt - this._vL) * a;
      this._vR += ((R.z - this._prevR.z) / dt - this._vR) * a;
    }
    this._prevL.copy(L); this._prevR.copy(R); this._have = true;
    if (!this.charged || up) return;
    const head = fk.pos.head, hips = fk.pos.hips;
    const inFront = L.z - chest.z > CHARGE.reach * k && R.z - chest.z > CHARGE.reach * k;
    const height = (y) => y > hips.y && y < (head ? head.y + 0.15 * k : hips.y + 0.9 * k);
    const together = Math.hypot(L.x - R.x, L.y - R.y) < CHARGE.apart * k;
    const fast = this._vL > CHARGE.pushSpeed * k && this._vR > CHARGE.pushSpeed * k;
    if (inFront && fast && together && height(L.y) && height(R.y)) {
      this.origin.copy(L).add(R).multiplyScalar(0.5);
      this.dir.set(0, 0, 1);
      this.charged = false; this.level = 0; this.armedLeft = 0;
      this.lastBlastAt = performance.now();
      this.onBlast?.(this.origin, this.dir);
    }
  }
}
