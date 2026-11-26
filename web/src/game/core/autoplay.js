// Autoplay bot (?autoplay=1): a synthetic tracker that reads the chart and performs each required move on time, so
// QA can watch / measure a full run without a webcam. It reuses SyntheticSource's animated player (guard, jab/cross,
// front kicks, squats, jumps, T-pose) by sampling its moves at chosen local times, and adds lean dodges, a guard, a
// hands-up charge and the two-hand blast push. Emits frames at 30 Hz with a simulated capture latency like a real
// tracker, so everything downstream (motion pipeline, detector, judge) runs exactly as with a player.
//
// Timing: for each note the bot plans the motion start so the DETECTOR fires on the musical hit
// (start = noteTime + LEAD_MS[move] - detectDelay[kind]). detectDelay (motion start -> detector capture time) is
// learned online from the detector's own events, so the bot stays on time whatever the detector thresholds are.
// ?botSkill=0..1 (default 1) skips notes / adds timing error, ?botJitter=ms (default 22) gaussian timing noise.
//
// Modes (getMode()): 'play' reads the chart; 'tpose' strikes the calibration T-pose; 'idle' guard stance;
// 'drill:<id>' performs a tutorial drill on a loop (punch / kick / jump / duck / dodge / guard / blast), so the
// no-camera demo player can show calibration and the tutorial. Awakening spirits that wait at their hit point
// (isWaiting(n)) are answered with a human-like ~0.5 s reaction, and retried if a skipped / failed attempt leaves
// the spirit waiting.
import * as THREE from 'three';
import { SyntheticSource } from '../../sources/syntheticSource.js';
import { LEAD_MS } from './settings.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ARM = [0.28, 0.27];
function limb(a, c, [l1, l2], pole) {
  const d = c.clone().sub(a); let L = d.length();
  const max = (l1 + l2) * 0.999;
  if (L > max) { d.multiplyScalar(max / L); c.copy(a).add(d); L = max; }
  d.normalize();
  const n = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + L * L - l2 * l2) / (2 * l1 * L)));
  return a.clone().addScaledVector(d, l1 * cosA).addScaledVector(n, l1 * Math.sqrt(1 - cosA * cosA));
}
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const UPPER = ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHand', 'rightHand', 'neck', 'nose', 'leftEar', 'rightEar'];

/** Motion length (s) per bot action kind. */
const DUR = { punch: 0.45, kick: 1.0, jump: 1.0, squat: 0, lean: 0, guard: 0, charge: 0, tpose: 0, rest: 0 };

export class AutoplaySource extends SyntheticSource {
  /**
   * @param {object} o
   * @param {object} o.clock      game clock (timeAtBeat, toPerf)
   * @param {function} o.getNotes () => iterable of upcoming notes (pending + live)
   * @param {function} o.getMode  () => 'idle' | 'tpose' | 'play'
   */
  constructor({ clock, getNotes, getMode, skill = 1, jitterMs = 22, rate = 30, latencyMs = 45, noteTime = null, isWaiting = null, model = null } = {}) {
    super({ rate, latencyMs, noise: 0.002 });
    this.model = model || 'Autoplay bot (reads the chart)';
    Object.assign(this, { clock, getNotes, getMode, skill, jitterMs });
    this.noteTime = noteTime ?? ((n) => this.clock.timeAtBeat(n.beat));   // song seconds of a note's hit
    this.isWaiting = isWaiting ?? (() => false);
    this.waitTry = new Map();             // note id -> perf ms of the last attempt at a waiting spirit
    this._drill = { id: null, next: 0, i: 0 };
    this.plan = [];                       // {kind, side, t0 (perf ms), hold (s), noteId}
    this.planned = new Set();
    // motion start -> detector capture time (ms), learned online
    this.delay = { punch: 75, kick: 150, jump: 300, squat: 210, lean: 120, guard: 0 };
    this.stats = { planned: 0, skipped: 0, learned: {} };
    this._rand = Math.random;
  }

  /** Learn detection delays from the detector's events (player-side names, info.tCapture). */
  listen(actions) {
    this._off?.();
    this._off = actions.on((name, info) => {
      const kind = name.startsWith('punch') ? 'punch' : name.startsWith('kick') ? 'kick' : name === 'jump' ? 'jump' : name === 'squat' ? 'squat'
        : name.startsWith('lean') ? 'lean' : null;
      if (!kind || info.tCapture == null) return;
      const side = /Left$/.test(name) ? 'left' : /Right$/.test(name) ? 'right' : null;
      let best = null;
      for (const p of this.plan) {
        if (p.kind !== kind || (side && p.side && kind !== 'lean' && p.side !== side) || p.learned) continue;
        const d = info.tCapture - p.t0;
        if (d > -30 && d < 700 && (!best || p.t0 > best.t0)) best = p;
      }
      if (!best) return;
      best.learned = true;
      const d = info.tCapture - best.t0;
      this.delay[kind] += (d - this.delay[kind]) * 0.35;
      this.stats.learned[kind] = Math.round(this.delay[kind]);
    });
  }

  _gauss() { let s = 0; for (let i = 0; i < 6; i++) s += this._rand(); return (s - 3) * Math.SQRT2; }

  /** Plan motions for notes that are close (called every emitted frame). */
  _planAhead(nowPerf) {
    const notes = this.getNotes?.();
    if (!notes) return;
    for (const n of notes) {
      if (n.resolved || !n.id) continue;
      if (this.isWaiting(n)) {                          // a spirit frozen at its hit point: react, retry after 2.2 s
        const last = this.waitTry.get(n.id) ?? 0;
        if (nowPerf - last < 2200 || (this.planned.has(n.id) && nowPerf - last < 2200)) continue;
        if (this.plan.some((p) => p.noteId === n.id && p.t0 + p.dur * 1000 > nowPerf)) continue;
        this.waitTry.set(n.id, nowPerf);
        this.planned.add(n.id);
        this._planMove(n, nowPerf + 450 + this._rand() * 150 + (LEAD_MS[n.move] ?? 0) + (this.delay[n.move === 'dodge' ? 'lean' : n.move] ?? 0), nowPerf, 0, true);
        continue;
      }
      if (this.planned.has(n.id)) continue;
      const tNote = this.clock.toPerf(this.noteTime(n));
      if (n.react) {
        if (!n.cuePerf) continue;                       // waits for the cue to appear, then reacts
        this.planned.add(n.id);
        this._push({ kind: 'punch', side: n.side, t0: n.cuePerf + 210 + this._rand() * 60, noteId: n.id });
        continue;
      }
      if (tNote - nowPerf > 2500) continue;
      this.planned.add(n.id);
      this.stats.planned++;
      if (this.skill < 1 && this._rand() > this.skill) { this.stats.skipped++; continue; }
      const jit = this._gauss() * this.jitterMs * (this.skill < 1 ? 2 - this.skill : 1);
      this._planMove(n, tNote, nowPerf, jit, false);
    }
  }
  /** Plan the motion for note `n` so its detection lands on `tNote` (perf ms). */
  _planMove(n, tNote, nowPerf, jit, waiting) {
    const lead = LEAD_MS[n.move] ?? 0;
    switch (n.move) {
      case 'punch': this._push({ kind: 'punch', side: n.side, t0: tNote + lead - this.delay.punch + jit, noteId: n.id }); break;
      case 'kick': this._push({ kind: 'kick', side: n.side, t0: tNote + lead - this.delay.kick + jit, noteId: n.id }); break;
      case 'jump': this._push({ kind: 'jump', t0: tNote + lead - this.delay.jump + jit, noteId: n.id }); break;
      case 'squat': this._push({ kind: 'squat', t0: tNote - this.delay.squat - 90 + jit, hold: 0.5, noteId: n.id }); break;
      case 'dodge': this._push({ kind: 'lean', side: n.side === 'left' ? 'right' : 'left', t0: tNote - this.delay.lean - 90 + jit, hold: 0.5, noteId: n.id }); break;
      case 'guard': {
        const bd = this.clock.beatDur * 1000;
        const g0 = tNote - 120 - this.delay.guard + jit;
        // relax the arms first (the idle stance is a boxing guard), then raise the guard on the cue
        this._push({ kind: 'rest', t0: g0 - 650, hold: 0.45, noteId: n.id });
        this._push({ kind: 'guard', t0: g0, hold: waiting ? 0.9 : 0.6, noteId: n.id });
        const p0 = waiting ? g0 + 1100 : tNote + bd * 0.75;
        for (let i = 0; i < 3; i++) this._push({ kind: 'punch', side: i % 2 ? 'right' : 'left', t0: p0 + bd * i * 0.6 - this.delay.punch, noteId: n.id });
        break;
      }
      case 'blast': this._push({ kind: 'charge', t0: Math.max(nowPerf, tNote - 200), hold: 1.35, noteId: n.id }); break;
      default: break;
    }
  }

  /** Tutorial drill loop: one rep of the drill's move every ~2 s. */
  _planDrill(id, nowPerf) {
    const D = this._drill;
    if (D.id !== id) { D.id = id; D.next = nowPerf + 900; D.i = 0; }
    if (nowPerf < D.next) return;
    const side = D.i++ % 2 ? 'right' : 'left';
    const kinds = { punch: ['punch', 0, 1.1], kick: ['kick', 0, 1.9], jump: ['jump', 0, 2.0], duck: ['squat', 0.6, 2.0], dodge: ['lean', 0.6, 2.0], guard: ['guard', 1.1, 2.4], blast: ['charge', 1.35, 3.6] };
    const k = kinds[id];
    if (!k) { D.next = nowPerf + 1000; return; }
    this._push({ kind: k[0], side, t0: nowPerf, hold: k[1] || undefined, noteId: 0 });
    D.next = nowPerf + k[2] * 1000;
  }
  _push(p) {
    p.dur = p.kind === 'charge' ? p.hold + 0.45 : (DUR[p.kind] || 0) + (p.hold ? p.hold + 0.5 : 0);
    this.plan.push(p);
    this.plan.sort((a, b) => a.t0 - b.t0);
  }

  /** Active planned motion at capture time tc (latest started still running), or null. */
  _active(tc) {
    let a = null, imp = null;
    for (const p of this.plan) {
      if (p.t0 <= tc && tc < p.t0 + p.dur * 1000) { a = p; if (p.kind === 'punch' || p.kind === 'kick' || p.kind === 'jump') imp = p; }
    }
    // a held move planned right after a strike must not cut the strike before it lands (and is detected)
    if (a && imp && a !== imp && tc - imp.t0 < (imp.kind === 'punch' ? 220 : 420)) return imp;
    return a;
  }

  _emit() {
    const now = performance.now();
    const tc = now - this.latencyMs;
    this._planAhead(now);
    while (this.plan.length && this.plan[0].t0 + this.plan[0].dur * 1000 < tc - 3000) this.plan.shift();
    let mode = this.getMode?.() ?? 'play';
    if (typeof mode === 'string' && mode.startsWith('drill:')) { this._planDrill(mode.slice(6), now); mode = 'play'; }
    else this._drill.id = null;
    const tSec = tc / 1000;
    const base = 400 + (tSec % 4);       // keep breathing / sway continuous: SyntheticSource uses t for both
    let out;
    const a = mode === 'tpose' ? { kind: 'tpose', t0: 0 } : this._active(tc);
    if (!a || mode === 'idle') { this.phase = 0; out = this.pose(base); }
    else {
      const tau = (tc - a.t0) / 1000;    // seconds into the motion
      switch (a.kind) {
        case 'punch': this.phase = 1; out = this.pose(400 + (a.side === 'left' ? 0 : 0.5) + Math.min(0.49, tau)); break;
        case 'kick': this.phase = 2; out = this.pose(400 + (a.side === 'left' ? 0 : 2) + Math.min(1.99, tau)); break;
        case 'jump': this.phase = 4; out = this.pose(400 + Math.min(1.3, tau)); break;
        case 'squat': {
          const h = a.hold, u = tau < 0.45 ? tau / 0.45 : tau < 0.45 + h ? 1 : Math.min(2, 1 + (tau - 0.45 - h) / 0.45);
          this.phase = 3; out = this.pose(400 + u); break;
        }
        case 'tpose': this.phase = 5; out = this.pose(400); break;
        case 'lean': { this.phase = 0; out = this.pose(base); this._lean(out, a, tau); break; }
        case 'guard': { this.phase = 0; out = this.pose(base); this._guard(out, a, tau); break; }
        case 'rest': { this.phase = 0; out = this.pose(base); this._rest(out, a, tau); break; }
        case 'charge': { this.phase = 0; out = this.pose(base); this._charge(out, a, tau); break; }
        default: this.phase = 0; out = this.pose(base);
      }
    }
    this.phase = null;
    this._send(out, now);
  }

  // ---- extra moves (post-edits of the synthetic guard pose; player frame: facing +z, player's left = +x)
  _lean(out, a, tau) {
    const h = a.hold, k = tau < 0.2 ? sm(0, 0.2, tau) : tau < 0.2 + h ? 1 : 1 - sm(0.2 + h, 0.45 + h, tau);
    const th = (a.side === 'left' ? -0.42 : 0.42) * k;          // leanLeft: shoulders toward +x
    const J = out.joints, c = J.leftHip.clone().add(J.rightHip).multiplyScalar(0.5);
    const cs = Math.cos(th), sn = Math.sin(th);
    const rot = (p) => { const x = p.x - c.x, y = p.y - c.y; p.x = c.x + x * cs - y * sn; p.y = c.y + x * sn + y * cs; };
    for (const n of UPPER) if (J[n]) rot(J[n]);
    for (const n of Object.keys(out.extra)) rot(out.extra[n]);
  }
  _setWrist(out, side, w, pole) {
    const J = out.joints, S = J[side + 'Shoulder'];
    const old = J[side + 'Wrist'].clone();
    J[side + 'Elbow'] = limb(S, w, ARM, pole);
    J[side + 'Wrist'] = w;
    J[side + 'Hand'] = w.clone().add(w.clone().sub(J[side + 'Elbow']).normalize().multiplyScalar(0.09));
    const d = w.clone().sub(old);
    for (const k of [side + 'Index', side + 'Pinky']) if (out.extra[k]) out.extra[k].add(d);
  }
  _guard(out, a, tau) {
    const J = out.joints, k = sm(0, 0.15, tau);
    for (const s of ['left', 'right']) {
      const sg = s === 'left' ? 1 : -1, S = J[s + 'Shoulder'];
      const w = J[s + 'Wrist'].clone().lerp(V(S.x - sg * 0.06, J.nose.y - 0.08, S.z + 0.24), k);
      this._setWrist(out, s, w, V(sg * 0.4, -1, -0.25));
    }
  }
  _rest(out, a, tau) {
    // arms relaxed down by the hips (no guard)
    const J = out.joints, k = sm(0, 0.15, tau);
    for (const s of ['left', 'right']) {
      const sg = s === 'left' ? 1 : -1, S = J[s + 'Shoulder'], H = J[s + 'Hip'];
      const w = J[s + 'Wrist'].clone().lerp(V(S.x + sg * 0.08, H.y + 0.02, S.z + 0.08), k);
      this._setWrist(out, s, w, V(sg * 0.2, -0.3, -1));
    }
  }
  _charge(out, a, tau) {
    // hands up overhead for `hold` s (charge), then a fast two-hand push forward at chest height (0.2 s), hold it out
    const J = out.joints, h = a.hold;
    const up = sm(0, 0.18, tau), push = sm(h, h + 0.2, tau);
    for (const s of ['left', 'right']) {
      const sg = s === 'left' ? 1 : -1, S = J[s + 'Shoulder'];
      const guard = J[s + 'Wrist'].clone();
      const over = V(S.x + sg * 0.05, J.nose.y + 0.32, S.z + 0.04);
      const fwd = V(sg * 0.1, S.y - 0.08, S.z + 0.6);
      const w = guard.lerp(over, up).lerp(fwd, push);
      this._setWrist(out, s, w, push > 0.5 ? V(sg * 0.6, -1, -0.2) : V(sg, 0, -0.2));
    }
    if (push > 0) out.hand = { left: 'open', right: 'open' };
  }

  _send({ joints, extra, hand }, now) {
    for (const k of Object.keys(joints)) joints[k].z -= 2.5;
    for (const k of Object.keys(extra)) extra[k].z -= 2.5;
    if (this.noise > 0) {
      const g = () => this._gauss() * this.noise;
      for (const v of Object.values(joints)) v.set(v.x + g(), v.y + g(), v.z + g());
    }
    const conf = {}, names = Object.keys(joints), kp2d = [];
    for (const k of names) { conf[k] = 1; const p = joints[k]; kp2d.push({ x: 0.5 - p.x / 2.4, y: 0.95 - p.y / 2.2, c: 1 }); }
    const idx = (n) => names.indexOf(n);
    this._edges ??= [['leftShoulder', 'rightShoulder'], ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['rightShoulder', 'rightElbow'],
      ['rightElbow', 'rightWrist'], ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'], ['leftHip', 'rightHip'], ['leftHip', 'leftKnee'],
      ['leftKnee', 'leftAnkle'], ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'], ['neck', 'nose']].map(([a, b]) => [idx(a), idx(b)]);
    this.onPose({ source: 'synthetic', tCapture: now - this.latencyMs, tArrive: now, joints, conf, extra, kp2d, edges: this._edges,
      handState: hand, timing: { inference: 0 }, absolute: true, autoplay: true });
  }
  stop() { super.stop(); }
}
