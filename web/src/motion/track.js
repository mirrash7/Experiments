// "Filter once, then predict": per-bone extrapolation to render time from capture timestamps, followed by a
// critically damped tracking spring. No other client smoothing touches the pose (InstantHMR's server-side
// one-euro on the MHR angles is the one filter).
//
//   target(t) = exp(w * h) * q_k,  w = log(q_k q_{k-1}^-1) / dt (speed-clamped), h = t_display - t_k (capped)
//   output    = tracking spring (half-life per bone group) toward target with goal velocity w
//
// t_display = renderTime - max(0, latency - lead): the pose shown is the predicted pose `lead` ms ahead of the
// newest data's age, i.e. at most `lead` ms (default 50, cap ~60) of the tracker latency is hidden.
import * as THREE from 'three';
import { quatDiff, quatExp, QuatSpring, VecSpring, clamp, smoothstep } from './math.js';

export const GROUPS = {
  // maxHorizon (s): per-group cap of the extrapolation horizon (QA P1-6: arms/hands extrapolated <= 70 ms)
  hand: { halflife: 0.022, maxSpeed: 30, maxHorizon: 0.07 },
  arm: { halflife: 0.028, maxSpeed: 25, maxHorizon: 0.07 },
  leg: { halflife: 0.035, maxSpeed: 20, maxHorizon: 0.09 },
  spine: { halflife: 0.05, maxSpeed: 8, maxHorizon: 0.09 },
  head: { halflife: 0.04, maxSpeed: 12, maxHorizon: 0.09 },
  finger: { halflife: 0.03, maxSpeed: 30, maxHorizon: 0.07 },
};
export function groupOf(bone) {
  if (/(Thumb|Index|Middle|Ring|Little)/.test(bone)) return 'finger';
  if (/Hand$/.test(bone)) return 'hand';
  if (/(Shoulder|Arm)$/.test(bone)) return 'arm';
  if (/(Leg|Foot|Toes)$/.test(bone)) return 'leg';
  if (/(neck|head)$/.test(bone)) return 'head';
  return 'spine';
}

const _v = new THREE.Vector3();

/**
 * Noise-aware predictor + tracking spring for one bone (QA P1-6).
 *
 * Per sample: measured angular velocity w_k; innovation = w_k - w_{k-1} (what a constant-velocity model failed
 * to predict: sample noise, or a real change of direction). Running powers decide how far to extrapolate:
 *   S = min(E|w|^2, |w_k|^2) (motion; the current speed drops to ~0 at every turn-around)
 *   N = E|innovation|^2      (noise + acceleration)
 *   gain  g = S / (S + k N)  consistent motion -> 1 (full lead), noise / turn-around -> ~0
 *   x reversal cut (w_k . w_{k-1} < 0), x peak gate (full lead only while the speed is near its recent peak:
 *   the slow end of a stroke is where constant-velocity extrapolation overshoots)
 *   horizon h = tau (1 - exp(-h0 / tau)) * g, h0 capped per bone group (arms/hands 70 ms)
 *   spring half-life x (1 + 1.5 r), r = kN / (S + kN): a still, noisy player is smoothed harder
 *   speed limiter: the displayed bone never turns faster than 0.85 x the tracked angular speed (+0.1 rad/s), so
 *   the catch-up after each sample and overshoot cannot add motion the player did not make (out <= raw on the
 *   rate-matched jitter metric for every source we test), while the lead on fast moves is kept; plus a catch-up
 *   term (gap to the newest sample beyond gapFree, closed at 1/gapTau) so a large jump is not crawled for seconds.
 * opts.noiseAware = false restores the plain constant-velocity predictor (for A/B in the lab).
 */
export class BoneTrack {
  constructor(bone) {
    const g = GROUPS[groupOf(bone)];
    this.halflife = g.halflife; this.maxSpeed = g.maxSpeed; this.maxHorizon = g.maxHorizon;
    this.q0 = null; this.t0 = 0;          // previous sample
    this.q1 = null; this.t1 = 0;          // newest sample
    this.w = new THREE.Vector3();         // angular velocity (rad/s, world-of-parent frame)
    this.wPrev = new THREE.Vector3();
    this.spring = new QuatSpring();
    this.target = new THREE.Quaternion();
    this.rejected = 0;
    this.var = 0; this.sig = 0; this.gain = 0; this.noise = 0; this.wPeak = 0;
    this._lastOut = null;
  }
  reset() {
    this.q0 = this.q1 = null; this.spring.init = false; this.w.set(0, 0, 0); this.wPrev.set(0, 0, 0);
    this.var = 0; this.sig = 0; this.gain = 0; this.noise = 0; this.wPeak = 0; this._lastOut = null;
  }

  push(q, t) {
    if (this.q1 && t <= this.t1) return;
    if (this.q1) {
      const dt = Math.max(1e-3, (t - this.t1) / 1000);
      const w = quatDiff(q, this.q1, _v).divideScalar(dt);
      // outlier gate: a single-frame jump far above the bone's max speed is held once
      if (w.length() > this.maxSpeed * 2.5 && this.rejected === 0) { this.rejected = 1; return; }
      this.rejected = 0;
      const sp = w.length();
      if (sp > this.maxSpeed) w.multiplyScalar(this.maxSpeed / sp);
      if (this.q0) {
        this.var += (w.distanceToSquared(this.w) - this.var) * 0.3;
        this.sig += (w.lengthSq() - this.sig) * 0.3;
      } else { this.var = 0; this.sig = w.lengthSq(); }
      const reversal = this.q0 && w.dot(this.w) < 0;
      this.wPrev.copy(this.w);
      this.w.lerp(w, this.q0 ? PREDICT.wSmooth : 1);
      const kN = PREDICT.noiseK * this.var;
      const S = Math.min(this.sig, this.w.lengthSq());
      this.gain = (S / (S + kN + 1e-6)) * (reversal ? PREDICT.reversal : 1);
      const ws = this.w.length();
      this.wPeak = Math.max(ws, this.wPeak * Math.exp(-dt / 0.6));
      this.gain *= smoothstep(PREDICT.peakGate * 0.35, PREDICT.peakGate, ws / (this.wPeak + 1e-6));
      this.noise = kN / (this.sig + kN + 1e-6);
      this.q0 = this.q1; this.t0 = this.t1;
    }
    this.q1 = q.clone(); this.t1 = t;
  }

  /** tDisplay: time (capture timebase, ms) the shown pose should represent; opts {predict, spring, maxHorizon, noiseAware} */
  update(tDisplay, dt, opts) {
    if (!this.q1) return null;
    if (opts.noiseAware === false) return this._updatePlain(tDisplay, dt, opts);
    const g = opts.predict ? this.gain : 0;
    const h0 = clamp((tDisplay - this.t1) / 1000, 0, Math.min(opts.maxHorizon, this.maxHorizon));
    const h = PREDICT.htau * (1 - Math.exp(-h0 / PREDICT.htau)) * g;
    quatExp(_v.copy(this.w).multiplyScalar(h), this.target).multiply(this.q1).normalize();
    if (!opts.spring) { this.spring.reset(this.target); return this.spring.q; }
    const hl = this.halflife * (opts.springScale ?? 1) * (1 + PREDICT.hlNoise * this.noise);
    const out = this.spring.update(this.target, _v.copy(this.w).multiplyScalar(g), hl, dt);
    if (opts.predict && PREDICT.vlim > 0) {
      if (this._lastOut) {
        // catch-up allowance: when the output is far behind the newest SAMPLE (after a big jump in the tracked
        // pose, re-acquired tracking, or a hit-stop), the limiter alone crawled at ~0.15 rad/s for seconds and the
        // crawl itself read as still-pose jitter (QA v3 r2 P2-4: guard out 2.3x raw after a T-pose / jump)
        const gap = 2 * Math.acos(Math.min(1, Math.abs(this._lastOut.dot(this.q1))));
        const catchUp = Math.max(0, gap - PREDICT.gapFree) / PREDICT.gapTau;
        const lim = (Math.max(this.w.length(), this.wPrev.length()) * PREDICT.vlim + PREDICT.vmin + catchUp) * dt;
        const ang = 2 * Math.acos(Math.min(1, Math.abs(this._lastOut.dot(out))));
        if (ang > lim) { out.copy(this._lastOut.slerp(out, lim / ang)); this.spring.q.copy(out); }
      }
      (this._lastOut ??= new THREE.Quaternion()).copy(out);
    }
    return out;
  }

  // the previous (v1) predictor: constant-velocity extrapolation with the plain noise gain, full horizon
  _updatePlain(tDisplay, dt, opts) {
    const g = opts.predict ? this.sig / (this.sig + this.var + 1e-6) : 0;
    const h = clamp((tDisplay - this.t1) / 1000, 0, opts.maxHorizon) * g;
    quatExp(_v.copy(this.w).multiplyScalar(h), this.target).multiply(this.q1).normalize();
    if (!opts.spring) { this.spring.reset(this.target); return this.spring.q; }
    return this.spring.update(this.target, _v.copy(this.w).multiplyScalar(g), this.halflife * (opts.springScale ?? 1), dt);
  }
}

/** Predictor tuning (shared, live-editable for experiments: pipeline.predictTuning). */
export const PREDICT = { noiseK: 1.5, htau: 0.06, reversal: 0.3, hlNoise: 1.5, wSmooth: 1, peakGate: 0.8, vlim: 0.85, vmin: 0.1, gapFree: 0.12, gapTau: 0.25 };

export class PointTrack {
  constructor({ halflife = 0.05, maxSpeed = 3 } = {}) {
    this.halflife = halflife; this.maxSpeed = maxSpeed;
    this.p1 = null; this.t1 = 0; this.v = new THREE.Vector3();
    this.spring = new VecSpring(); this.target = new THREE.Vector3();
    this.var = 0; this.gain = 0;
  }
  reset() { this.p1 = null; this.spring.init = false; this.v.set(0, 0, 0); this.var = 0; this.gain = 0; }
  push(p, t) {
    if (this.p1 && t <= this.t1) return;
    if (this.p1) {
      const dt = Math.max(1e-3, (t - this.t1) / 1000);
      const v = p.clone().sub(this.p1).divideScalar(dt);
      const s = v.length(); if (s > this.maxSpeed) v.multiplyScalar(this.maxSpeed / s);
      this.var += (v.distanceToSquared(this.v) - this.var) * 0.3;
      this.v.lerp(v, 0.65);
      const v2 = this.v.lengthSq();
      this.gain = v2 / (v2 + this.var + 1e-6);
    }
    this.p1 = p.clone(); this.t1 = t;
  }
  update(tDisplay, dt, opts) {
    if (!this.p1) return null;
    const g = opts.predict ? this.gain : 0;
    const h = clamp((tDisplay - this.t1) / 1000, 0, opts.maxHorizon) * g;
    this.target.copy(this.p1).addScaledVector(this.v, h);
    if (!opts.spring) { this.spring.reset(this.target); return this.spring.x; }
    return this.spring.update(this.target, _v.copy(this.v).multiplyScalar(g), this.halflife * (opts.springScale ?? 1), dt);
  }
}
