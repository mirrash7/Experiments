// Highlight replay: records the last ~20 s of the hero's applied pose (hero-space humanoid pose, read straight from
// the hero's pose proxies - no allocation), the spirits on the field and the judgements; picks the best combo window
// and plays it back on the hero at 0.35x with the director's front cinematic camera, re-spawning the spirits on their
// recorded paths and re-firing their outcomes. Everything is re-rendered from captured motion, not a video.
import * as THREE from 'three';
import { pathPos } from './spirits.js';

const SECONDS = 20, HZ = 60, CAP = SECONDS * HZ + 60;

export class ReplayRecorder {
  constructor() {
    this.bones = null; this.stride = 0; this.data = null;
    this.times = new Float64Array(CAP);   // song time (s)
    this.beats = new Float64Array(CAP);   // clock beat
    this.head = 0; this.count = 0; this.lastT = -1e9;
    this.notes = [];                      // recorded spirit paths + outcomes
    this.enabled = true;
  }
  /** Bind to a hero (bone list + buffer). */
  setHero(hero) {
    this.hero = hero;
    this.bones = Object.keys(hero.getHumanoidPose().rotations);   // once, at bind time
    this.proxies = this.bones.map((b) => hero.proxies[b]);
    this.stride = 3 + this.bones.length * 4;
    this.data = new Float32Array(CAP * this.stride);
    this.clear();
  }
  clear() { this.head = 0; this.count = 0; this.lastT = -1e9; this.notes.length = 0; }

  /** Record the hero's current pose (call after the pose is applied, once per frame). */
  record(songT, beat) {
    if (!this.enabled || !this.data || songT - this.lastT < 1 / (HZ + 8)) return;
    this.lastT = songT;
    const i = this.head, o = i * this.stride, d = this.data;
    const hp = this.hero.proxies.hips.position;
    d[o] = hp.x; d[o + 1] = hp.y; d[o + 2] = hp.z;
    for (let b = 0, k = o + 3; b < this.proxies.length; b++, k += 4) {
      const q = this.proxies[b].quaternion;
      d[k] = q.x; d[k + 1] = q.y; d[k + 2] = q.z; d[k + 3] = q.w;
    }
    this.times[i] = songT; this.beats[i] = beat;
    this.head = (i + 1) % CAP; if (this.count < CAP) this.count++;
    // drop note records older than the buffer
    const oldest = this.times[(this.head - this.count + CAP) % CAP];
    while (this.notes.length && this.notes[0].endT < oldest - 1) this.notes.shift();
  }

  /** Keep a copy of a spirit's path (on spawn) so the replay can fly it again. */
  noteSpawn(n, clock) {
    if (!n.from) return;
    this.notes.push({
      id: n.id, type: n.type, side: n.side, react: !!n.react, boss: !!n.boss, beat: n.beat, spawnBeat: n.spawnBeat,
      from: n.from.clone(), to: n.to.clone(), dir: n.dir.clone(), speed: n.speed, arc: n.arc, swirl: n.swirl,
      kind: null, outBeat: Infinity, endT: clock.timeAtBeat(n.beat) + 4, weak: !!n.weak, move: n.move,
    });
  }
  noteOutcome(n, kind, beat, clock) {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const r = this.notes[i];
      if (r.id === n.id) { r.kind = kind; r.outBeat = beat; r.endT = clock.timeAtBeat(beat) + 1; return; }
    }
  }

  get range() {
    if (!this.count) return null;
    return { t0: this.times[(this.head - this.count + CAP) % CAP], t1: this.times[(this.head - 1 + CAP) % CAP] };
  }

  /** Best window (s) by points of the judgements inside it (score.events: {t, kind, pts}). */
  pickBest(events, windowS = 5) {
    const r = this.range;
    if (!r || r.t1 - r.t0 < 1) return null;
    const lo = r.t0 + 0.3, hi = r.t1;
    let best = null, bestPts = -1;
    const evs = events.filter((e) => e.t >= lo && e.t <= hi);
    for (const e of evs) {
      const a = Math.max(lo, Math.min(e.t - 1.2, hi - windowS));
      let pts = 0, hits = 0;
      for (const f of evs) if (f.t >= a && f.t <= a + windowS) { pts += f.pts + (f.kind === 'perfect' ? 50 : 0); if (f.kind !== 'miss') hits++; }
      if (hits && pts > bestPts) { bestPts = pts; best = { t0: a, t1: Math.min(hi, a + windowS), pts, hits }; }
    }
    return best ?? { t0: Math.max(lo, hi - windowS), t1: hi, pts: 0, hits: 0 };
  }

  /** Index of the newest frame with time <= t (binary search over the ring), or -1. */
  _find(t) {
    let lo = 0, hi = this.count - 1;
    const base = (this.head - this.count + CAP) % CAP;
    if (!this.count || t < this.times[base]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[(base + mid) % CAP] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;   // logical index
  }
}

export class ReplayPlayer {
  constructor({ rec, getVisuals, ui, audio }) {
    this.rec = rec; this.getVisuals = getVisuals; this.ui = ui; this.audio = audio;
    this.active = false; this.t = 0; this.speed = 0.35;
    this.pose = null; this._p = new THREE.Vector3(); this._qa = new THREE.Quaternion(); this._qb = new THREE.Quaternion();
    this.views = new Map(); this.onEnd = null;
  }
  get progress() { return this.active ? (this.t - this.win.t0) / Math.max(1e-3, this.win.t1 - this.win.t0) : 0; }

  start(win, { speed = 0.35, onEnd = null } = {}) {
    const rec = this.rec;
    if (!win || !rec.count) return false;
    this.stop();
    this.win = win; this.t = win.t0; this.speed = speed; this.onEnd = onEnd; this.active = true;
    if (!this.pose) {
      this.pose = { hips: new THREE.Vector3(), rotations: {} };
      for (const b of rec.bones) this.pose.rotations[b] = new THREE.Quaternion();
    }
    for (const n of rec.notes) { n._fired = false; n._pos ??= new THREE.Vector3(); }
    return true;
  }
  stop() {
    for (const v of this.views.values()) { try { v.release?.(); } catch { /* */ } }
    this.views.clear();
    this.active = false;
  }

  /** Advance by real dt; applies the interpolated pose to the hero, flies the recorded spirits. Returns playback beat. */
  update(dt, hero) {
    if (!this.active) return 0;
    const rec = this.rec, CAPn = CAP;
    this.t += dt * this.speed;
    if (this.t >= this.win.t1) { this.t = this.win.t1; }
    const li = rec._find(this.t);
    if (li < 0) return 0;
    const base = (rec.head - rec.count + CAPn) % CAPn;
    const ia = (base + li) % CAPn, ib = (base + Math.min(rec.count - 1, li + 1)) % CAPn;
    const ta = rec.times[ia], tb = rec.times[ib];
    const u = tb > ta ? Math.min(1, Math.max(0, (this.t - ta) / (tb - ta))) : 0;
    const d = rec.data, s = rec.stride, oa = ia * s, ob = ib * s;
    this.pose.hips.set(d[oa] + (d[ob] - d[oa]) * u, d[oa + 1] + (d[ob + 1] - d[oa + 1]) * u, d[oa + 2] + (d[ob + 2] - d[oa + 2]) * u);
    for (let b = 0, k = 3; b < rec.bones.length; b++, k += 4) {
      this._qa.set(d[oa + k], d[oa + k + 1], d[oa + k + 2], d[oa + k + 3]);
      this._qb.set(d[ob + k], d[ob + k + 1], d[ob + k + 2], d[ob + k + 3]);
      this.pose.rotations[rec.bones[b]].copy(this._qa).slerp(this._qb, u);
    }
    hero?.applyHumanoidPose(this.pose);
    const beat = rec.beats[ia] + (rec.beats[ib] - rec.beats[ia]) * u;
    this._spirits(beat);
    if (this.t >= this.win.t1) { const cb = this.onEnd; this.stop(); cb?.(); }
    return beat;
  }

  _spirits(beat) {
    const V = this.getVisuals();
    for (const n of this.rec.notes) {
      const visible = beat >= n.spawnBeat && !n._fired && beat <= n.outBeat + 0.01 && beat < n.beat + 3;
      let v = this.views.get(n);
      if (visible && !v && !n.weak) {
        try { v = V.spirits.create(n.type, { side: n.side, react: n.react, boss: n.boss, replay: true }); this.views.set(n, v); } catch { v = null; }
      }
      if (!v) continue;
      pathPos(n, Math.min(beat, n.outBeat), n._pos);
      v.object.position.copy(n._pos);
      v.setTelegraph?.(Math.min(1, Math.max(0, 1 - (n.beat - beat) / 2)));
      if (beat >= n.outBeat && !n._fired) {
        n._fired = true;
        const hazard = n.move === 'jump' || n.move === 'squat' || n.move === 'dodge';
        try {
          if (n.kind === 'miss') v.strikeHero?.(); else if (hazard) v.dodged?.(); else v.hit?.(n.kind, this._p.set(0, 0.2, 1).normalize());
        } catch { /* */ }
        if (n.kind && n.kind !== 'miss') {
          try { V.vfx?.judgement?.(n._pos, n.kind); } catch { /* */ }
          this.audio?.sfx?.(n.move === 'kick' ? 'kickHit' : 'punchHit', { pitch: 0.6, gain: 0.8 });
        }
        this.views.delete(n);      // VISUAL auto-releases after the outcome
      } else if (!visible && beat > n.outBeat) {
        try { v.release?.(); } catch { /* */ }
        this.views.delete(n);
      }
    }
  }
}
