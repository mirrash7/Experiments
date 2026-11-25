// Live quality metrics for the motion pipeline (all rolling windows):
//   latency.track     ms from camera capture to the pose arriving in the browser (encode + WS + inference)
//   latency.lead      ms of that latency hidden by prediction (target time - newest sample time at render)
//   latency.e2e       ms between the player's motion and the avatar's motion, measured by cross-correlating the
//                     tracked wrist/ankle trajectory (by capture time) with the avatar's (by render time); this
//                     is capture -> avatar pose, excluding display scan-out
//   jitter            RMS angular speed (rad/s) and RMS angular acceleration (rad/s^2) of head, hands, hips,
//                     every stream resampled onto one 30 Hz grid: raw = solver output (tracker samples);
//                     out = the filter stage (prediction + tracking spring, same bones, before authored layers);
//                     final = the displayed pose (incl. accents, IK, hand poses: authored motion, not noise).
//                     jitter.ok = out <= raw (QA P1-6 regression check)
//   footSkate         mean horizontal ankle speed (m/s) while a foot is in contact: before IK (tracked FK) vs
//                     after the foot lock
//   fkError           JS MHR FK vs InstantHMR joints_3d on the joint-readout keypoints (mm)
import * as THREE from 'three';
import { Window, quatDiff } from './math.js';

const JIT_BONES = ['hips', 'head', 'leftHand', 'rightHand'];
const GRID = 1000 / 30;     // ms: every stream is resampled onto the same 30 Hz grid before differencing

/**
 * RMS angular speed / acceleration of the jitter bones, rate-independent: each stream (raw tracker samples at
 * 12-30 Hz, avatar frames at 60+ Hz) is slerp-resampled onto a common 30 Hz grid first. Without this a
 * sample-and-hold output at 60 Hz reads sqrt(2) faster than the identical raw signal and the comparison
 * out <= raw is meaningless.
 */
class AngJitter {
  constructor() { this.prev = {}; this.grid = {}; this.vel = {}; this.speed = new Window(400); this.acc = new Window(400); this.tg = null; this.tp = null; }
  push(rot, t, frame) {   // frame: world rotations map
    if (this.tp !== null && (t - this.tp > 250 || t <= this.tp)) { if (t > this.tp) this.clear(); else return; }
    if (this.tp !== null) {
      if (this.tg === null) this.tg = Math.ceil(this.tp / GRID) * GRID;
      while (this.tg <= t) {
        const u = (this.tg - this.tp) / (t - this.tp);
        let s = 0, a = 0, n = 0, na = 0;
        for (const b of JIT_BONES) {
          if (!frame[b] || !this.prev[b]) continue;
          const q = (this._q ??= new THREE.Quaternion()).copy(this.prev[b]).slerp(frame[b], u);
          const g = this.grid[b];
          if (g) {
            const w = quatDiff(q, g, new THREE.Vector3()).divideScalar(GRID / 1000);
            if (this.vel[b]) { a += w.distanceTo(this.vel[b]) / (GRID / 1000); na++; }
            s += w.length(); n++;
            this.vel[b] = w;
            g.copy(q);
          } else this.grid[b] = q.clone();
        }
        if (n) this.speed.push(s / n);
        if (na) this.acc.push(a / na);
        this.tg += GRID;
      }
    }
    for (const b of JIT_BONES) if (frame[b]) (this.prev[b] ??= new THREE.Quaternion()).copy(frame[b]);
    this.tp = t;
  }
  clear() { this.prev = {}; this.grid = {}; this.vel = {}; this.speed.clear(); this.acc.clear(); this.tg = null; this.tp = null; }
}

export class Metrics {
  constructor() {
    this.track = new Window(120); this.lead = new Window(240);
    this.solveMs = new Window(120); this.updateMs = new Window(240);
    this.rawJitter = new AngJitter(); this.outJitter = new AngJitter(); this.finalJitter = new AngJitter();
    this.skateRaw = new Window(600); this.skateOut = new Window(600);
    this.fkErr = new Window(120); this.fkMax = new Window(120);
    this.inSig = []; this.outSig = [];     // [{t, v: [x..]}]
    this.e2e = 0; this._lastE2E = 0;
    this.contactFrac = new Window(600); this.ikErr = new Window(600);
  }
  reset() {
    for (const k of ['track', 'lead', 'solveMs', 'updateMs', 'skateRaw', 'skateOut', 'fkErr', 'fkMax', 'contactFrac', 'ikErr']) this[k].clear();
    this.rawJitter.clear(); this.outJitter.clear(); this.finalJitter.clear(); this.inSig = []; this.outSig = []; this.e2e = 0;
  }
  pushInput(t, v) { this.inSig.push({ t, v }); if (this.inSig.length > 200) this.inSig.shift(); }
  pushOutput(t, v) {
    this.outSig.push({ t, v }); if (this.outSig.length > 600) this.outSig.shift();
    if (t - this._lastE2E > 500) { this._lastE2E = t; this.e2e = this._xcorr(); }
  }
  /** lag (ms) maximizing the correlation between output(t) and input(t - lag) over the last ~4 s */
  _xcorr() {
    const I = this.inSig, O = this.outSig.filter((o) => o.t > (this.outSig.at(-1)?.t ?? 0) - 4000);
    if (I.length < 20 || O.length < 60) return this.e2e;
    const interp = (t, k) => {
      if (t <= I[0].t || t >= I.at(-1).t) return null;
      let lo = 0, hi = I.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (I[m].t <= t) lo = m; else hi = m; }
      const u = (t - I[lo].t) / (I[hi].t - I[lo].t);
      return I[lo].v[k] + (I[hi].v[k] - I[lo].v[k]) * u;
    };
    const dims = O[0].v.length;
    let best = -Infinity, bestLag = this.e2e;
    for (let lag = -40; lag <= 300; lag += 4) {
      let score = 0, used = 0;
      for (let k = 0; k < dims; k++) {
        const a = [], b = [];
        for (const o of O) { const x = interp(o.t - lag, k); if (x !== null) { a.push(o.v[k]); b.push(x); } }
        if (a.length < 40) continue;
        const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
        let sab = 0, saa = 0, sbb = 0;
        for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
        if (saa < 1e-6 || sbb < 1e-6) continue;
        score += sab / Math.sqrt(saa * sbb); used++;
      }
      if (used && score / used > best) { best = score / used; bestLag = lag; }
    }
    this.e2eCorr = best;
    return bestLag;
  }
  snapshot() {
    const f = (x, d = 1) => +x.toFixed(d);
    return {
      latency: { track: f(this.track.mean), lead: f(this.lead.mean), e2e: f(this.e2e), e2eCorr: f(this.e2eCorr ?? 0, 3) },
      jitter: {
        rawSpeed: f(this.rawJitter.speed.rms, 3), outSpeed: f(this.outJitter.speed.rms, 3),
        rawAcc: f(this.rawJitter.acc.rms, 1), outAcc: f(this.outJitter.acc.rms, 1),
        finalSpeed: f(this.finalJitter.speed.rms, 3), finalAcc: f(this.finalJitter.acc.rms, 1),
        // regression check (QA P1-6): the filter stage (prediction + spring) must not add jitter
        ok: this.outJitter.speed.rms <= this.rawJitter.speed.rms + 0.05,   // + 3 deg/s: below visibility (still poses)
      },
      footSkate: { raw: f(this.skateRaw.mean, 4), out: f(this.skateOut.mean, 4), contact: f(this.contactFrac.mean, 2), lockMiss: f(this.ikErr.mean, 4), lockMissMax: f(this.ikErr.a.length ? Math.max(...this.ikErr.a) : 0, 4) },
      fkError: { mean: f(this.fkErr.mean, 3), max: f(this.fkMax.a.length ? Math.max(...this.fkMax.a) : 0, 3) },
      cost: { solveMs: f(this.solveMs.mean, 3), updateMs: f(this.updateMs.mean, 3) },
    };
  }
}
