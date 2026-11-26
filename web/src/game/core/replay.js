// Highlight replay: records the last ~20 s of the hero's applied pose (hero-space humanoid pose, read straight from
// the hero's pose proxies - no allocation), the spirits on the field and the judgements, and plays a clip back on the
// hero at 0.35x with the director's front cinematic camera, re-spawning the spirits on their recorded paths and
// re-firing their outcomes. Everything is re-rendered from captured motion, not a video.
//
// Best moment of the WHOLE run: the recorder re-scores the ring about once a second and, whenever a window (that has
// fully played out) beats the best so far, copies its frames into a saved clip (rolling best-window buffer). A pinned
// clip (the boss kill) is always kept and wins at the results screen.
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
  clear() {
    this.head = 0; this.count = 0; this.lastT = -1e9; this.notes.length = 0;
    this.best = null; this.pinned = null; this._pinReq = null; this._scanT = 0;
  }

  /**
   * Rolling best: call ~1/s with the score events. Scores windows that ended at least `settle` s ago; a better one is
   * snapshotted into this.best.
   */
  scan(events, songT, { windowS = 2.6, settle = 1.0 } = {}) {
    if (this._pinReq && songT >= this._pinReq.t1 + 0.1) {
      const c = this.snapshot(this._pinReq.t0, this._pinReq.t1);
      if (c) { c.pinned = true; c.label = this._pinReq.label; c.pinT = this._pinReq.t; c.pts = Infinity; this.pinned = c; }
      this._pinReq = null;
    }
    if (songT - this._scanT < 1) return;
    this._scanT = songT;
    const r = this.range;
    if (!r || r.t1 - r.t0 < windowS + settle) return;
    const lo = r.t0 + 0.3, hi = Math.min(r.t1, songT) - settle;
    const w = this.bestWindow(events, lo, hi, windowS);
    if (w && w.hits >= 2 && (!this.best || w.pts > this.best.pts)) {
      const c = this.snapshot(w.t0, w.t1);
      if (c) { Object.assign(c, { pts: w.pts, hits: w.hits, label: 'BEST MOMENT' }); this.best = c; }
    }
  }
  /** Always keep [t - before, t + after] (e.g. the boss-kill blast); snapshotted once the frames exist. */
  pin(t, { before = 1.6, after = 1.6, label = 'FINISHER' } = {}) { this._pinReq = { t0: t - before, t1: t + after, t, label }; }
  /** Pin request still waiting for frames (the run ended early): snapshot what exists. */
  flushPin() {
    if (!this._pinReq) return;
    const r = this.range;
    if (r) { const c = this.snapshot(this._pinReq.t0, Math.min(this._pinReq.t1, r.t1)); if (c) { c.pinned = true; c.label = this._pinReq.label; c.pinT = this._pinReq.t; this.pinned = c; } }
    this._pinReq = null;
  }

  /** Best window in [lo, hi] by points of the judgements inside it (score.events: {t, kind, pts}). */
  bestWindow(events, lo, hi, windowS) {
    let best = null, bestPts = -1;
    const evs = events.filter((e) => e.t >= lo && e.t <= hi + windowS);
    for (const e of evs) {
      const a = Math.max(lo, Math.min(e.t - windowS * 0.4, hi - windowS));
      if (a + windowS > hi + 1e-6 || a < lo - 1e-6) continue;
      let pts = 0, hits = 0;
      for (const f of evs) if (f.t >= a && f.t <= a + windowS) { pts += f.pts + (f.kind === 'perfect' ? 50 : 0) + (f.kind !== 'miss' ? 40 : -150); if (f.kind !== 'miss') hits++; }
      if (hits && pts > bestPts) { bestPts = pts; best = { t0: a, t1: a + windowS, pts, hits }; }
    }
    return best;
  }

  /** Copy frames [t0, t1] (+ the notes visible in it) out of the ring into a standalone clip. */
  snapshot(t0, t1) {
    if (!this.count || !this.data) return null;
    const i0 = Math.max(0, this._find(t0)), i1 = this._find(t1);
    if (i1 < 0 || i1 - i0 < 10) return null;
    const n = i1 - i0 + 1, s = this.stride;
    const clip = { times: new Float64Array(n), beats: new Float64Array(n), data: new Float32Array(n * s), count: n, stride: s, bones: this.bones };
    const base = (this.head - this.count + CAP) % CAP;
    for (let k = 0; k < n; k++) {
      const i = (base + i0 + k) % CAP;
      clip.times[k] = this.times[i]; clip.beats[k] = this.beats[i];
      clip.data.set(this.data.subarray(i * s, i * s + s), k * s);
    }
    clip.t0 = clip.times[0]; clip.t1 = clip.times[n - 1];
    const b0 = clip.beats[0], b1 = clip.beats[n - 1];
    clip.notes = this.notes.filter((r) => r.spawnBeat <= b1 && Math.min(r.outBeat, r.beat + 3) >= b0 - 0.5).map((r) => ({ ...r, from: r.from.clone(), to: r.to.clone(), dir: r.dir.clone() }));
    return clip;
  }
  /** The clip for the results screen: the pinned finisher, else the best window, else the ring's newest seconds. */
  pick(events, windowS = 2.6) {
    this.flushPin();
    if (this.pinned) return this.pinned;
    const r = this.range;
    if (r) {
      const w = this.bestWindow(events, r.t0 + 0.3, r.t1, windowS);
      if (w && (!this.best || w.pts > this.best.pts)) { const c = this.snapshot(w.t0, w.t1); if (c) return Object.assign(c, { pts: w.pts, hits: w.hits, label: 'BEST MOMENT' }); }
    }
    if (this.best) return this.best;
    if (!r || r.t1 - r.t0 < 1) return null;
    const c = this.snapshot(Math.max(r.t0, r.t1 - windowS), r.t1);
    return c ? Object.assign(c, { pts: 0, hits: 0, label: 'REPLAY' }) : null;
  }

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

  /** Legacy: best window (s) inside the ring only. */
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

/** Index of the newest frame with time <= t in a clip (binary search), or -1. */
function clipFind(c, t) {
  if (!c.count || t < c.times[0]) return -1;
  let lo = 0, hi = c.count - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c.times[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

export class ReplayPlayer {
  constructor({ rec, getVisuals, ui, audio }) {
    this.rec = rec; this.getVisuals = getVisuals; this.ui = ui; this.audio = audio;
    this.active = false; this.t = 0; this.speed = 0.35;
    this.pose = null; this._p = new THREE.Vector3(); this._qa = new THREE.Quaternion(); this._qb = new THREE.Quaternion();
    this.views = new Map(); this.onEnd = null; this.onProgress = null;
  }
  get progress() { return this.active ? (this.t - this.win.t0) / Math.max(1e-3, this.win.t1 - this.win.t0) : 0; }
  /** Real-time length (s) of a clip at a speed. */
  static duration(clip, speed = 0.35) { return clip ? (clip.t1 - clip.t0) / speed : 0; }

  /** Play a clip (from rec.pick / rec.snapshot). */
  start(clip, { speed = 0.35, onEnd = null, onProgress = null } = {}) {
    if (!clip || !clip.count) return false;
    this.stop();
    this.win = clip; this.t = clip.t0; this.speed = speed; this.onEnd = onEnd; this.onProgress = onProgress; this.active = true;
    if (!this.pose) {
      this.pose = { hips: new THREE.Vector3(), rotations: {} };
      for (const b of clip.bones) this.pose.rotations[b] = new THREE.Quaternion();
    }
    for (const n of clip.notes) { n._fired = false; n._pos ??= new THREE.Vector3(); }
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
    const c = this.win;
    this.t = Math.min(c.t1, this.t + dt * this.speed);
    const ia = clipFind(c, this.t);
    if (ia < 0) return 0;
    const ib = Math.min(c.count - 1, ia + 1);
    const ta = c.times[ia], tb = c.times[ib];
    const u = tb > ta ? Math.min(1, Math.max(0, (this.t - ta) / (tb - ta))) : 0;
    const d = c.data, s = c.stride, oa = ia * s, ob = ib * s;
    this.pose.hips.set(d[oa] + (d[ob] - d[oa]) * u, d[oa + 1] + (d[ob + 1] - d[oa + 1]) * u, d[oa + 2] + (d[ob + 2] - d[oa + 2]) * u);
    for (let b = 0, k = 3; b < c.bones.length; b++, k += 4) {
      this._qa.set(d[oa + k], d[oa + k + 1], d[oa + k + 2], d[oa + k + 3]);
      this._qb.set(d[ob + k], d[ob + k + 1], d[ob + k + 2], d[ob + k + 3]);
      this.pose.rotations[c.bones[b]].copy(this._qa).slerp(this._qb, u);
    }
    hero?.applyHumanoidPose(this.pose);
    const beat = c.beats[ia] + (c.beats[ib] - c.beats[ia]) * u;
    this._spirits(beat);
    try { this.onProgress?.(this.progress); } catch { /* */ }
    if (this.t >= c.t1) { const cb = this.onEnd; this.stop(); cb?.(); }
    return beat;
  }

  _spirits(beat) {
    const V = this.getVisuals();
    for (const n of this.win.notes) {
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
