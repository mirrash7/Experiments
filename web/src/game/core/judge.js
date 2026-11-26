// Judge: maps motion events / held states to the moves the notes require and grades the timing.
//
// Timing is measured at CAPTURE time: an action carries info.tCapture (performance.now() timebase of the camera frame
// that triggered it), converted to song time with clock.fromPerf(); so tracker + network + detection latency never
// counts against the player. err = moveTime - noteTime - LEAD_MS[move] - settings.judgeOffsetMs.
//
// Impulse moves (punch / kick / jump) are matched when they fire. Held moves (squat, guard, dodge = lean or step away)
// are judged from a ring buffer of per-frame detector states stamped with the frame capture times: being in the state
// at the hit moment counts, graded by WHEN it was entered: Perfect only for an entry within HELD_EARLY_MS before ..
// +perfect after the hit (camping in the pose from far earlier is a Great), entering late or leaving early is graded
// by how late / early. The reported error is always the real entry (or release) error.
//
// Wrong strikes (the other hand / leg) never resolve a note early: with settings.wrongMovePenalty they only flag the
// note, so a window that closes without the right move shows WRONG instead of MISS. A punch never counts against a
// kick note (or vice versa): only the same limb class on the wrong side.
//
// beatOffset: the Act 0 "Awakening" runs the spirit field on a virtual beat that lags the music clock while a spirit
// waits for the player; notes are in that virtual timeline and judged at clock beat = note.beat + beatOffset.
import { LEAD_MS, windowsFor } from './settings.js';

const STATE_NAMES = ['squat', 'guard', 'leanLeft', 'leanRight', 'stepLeft', 'stepRight', 'handsUp', 'tPose'];
const BIT = Object.fromEntries(STATE_NAMES.map((n, i) => [n, 1 << i]));
const RING = 512;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Held moves: entries up to this long before the hit still score Perfect (earlier = Great: camping is not rewarded). */
export const HELD_EARLY_MS = 250;

export class Judge {
  constructor({ clock, settings }) {
    this.clock = clock;
    this.settings = settings;
    this.tracker = 'demo';
    this.win = windowsFor(settings, 'demo');
    this.t = new Float64Array(RING);
    this.bits = new Uint16Array(RING);
    this.n = 0; this.head = 0;
    this.lastSampleT = -1;
    this.log = [];                 // debug: last judgements {kind, errMs, type, side}
    this.errHist = [];             // signed errors of hits (for the debug overlay / calibration)
    this.beatOffset = 0;           // clock beat = note beat + beatOffset (Awakening wait mode)
  }
  /** Clock time (s) of a note's hit. */
  noteTime(note) { return this.clock.timeAtBeat(note.beat + this.beatOffset); }
  setTracker(kind) { this.tracker = kind; this.win = windowsFor(this.settings, kind); }

  classify(absMs) {
    const w = this.win;
    return absMs <= w.perfect ? 'perfect' : absMs <= w.great ? 'great' : absMs <= w.good ? 'good' : 'miss';
  }

  /** Signed error (ms) of a move captured at perf time `tCaptureMs` against `note`. */
  errorFor(note, tCaptureMs, move = note.move) {
    const songT = this.clock.fromPerf(tCaptureMs);
    const noteT = this.noteTime(note);
    return (songT - noteT) * 1000 - (LEAD_MS[move] ?? 0) - (this.settings.judgeOffsetMs || 0);
  }

  /** Action name the note requires (impulse moves only), e.g. punchLeft. */
  static actionFor(note) {
    if (note.move === 'punch') return 'punch' + cap(note.side);
    if (note.move === 'kick') return 'kick' + cap(note.side);
    if (note.move === 'jump') return 'jump';
    return null;
  }

  /**
   * An impulse action fired. Returns {note, kind, errMs} for the best matching unresolved note, a wrong-move miss
   * {note, kind:'miss', wrong:true}, or null (stray move, ignored).
   */
  matchAction(name, info, notes) {
    const tc = info.tCapture ?? info.t;
    if (tc == null) return null;
    const good = this.win.good;
    let best = null, bestErr = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.resolved || !n.live || n.react || n.blocked) continue;
      if (Judge.actionFor(n) !== name) continue;
      const e = this.errorFor(n, tc);
      if (Math.abs(e) <= good && (!best || Math.abs(e) < Math.abs(bestErr))) { best = n; bestErr = e; }
    }
    if (best) return { note: best, kind: this.classify(Math.abs(bestErr)), errMs: bestErr };
    // wrong strike: the other side of the SAME limb class inside a strike note's Great window. Deferred: it only
    // flags the note (shown as WRONG if the window then closes without the right move); it never resolves it.
    if (!this.settings.wrongMovePenalty || !/^(punch|kick)/.test(name)) return null;
    const limb = name.startsWith('punch') ? 'punch' : 'kick';
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.resolved || !n.live || n.react || n.move !== limb) continue;
      if (Judge.actionFor(n) !== name && Math.abs(this.errorFor(n, tc)) <= this.win.great) n.wrongTry = true;
    }
    return null;
  }

  /** Call every frame: records the detector's held states for the newest tracker frame (capture-time stamped). */
  sampleStates(motion) {
    const f = motion?.lastFrame;
    const st = motion?.actions?.state;
    if (!f || !st || !f.joints) return;
    const t = f.tCapture ?? f.tArrive;
    if (t == null || t === this.lastSampleT) return;
    this.lastSampleT = t;
    let b = 0;
    for (let i = 0; i < STATE_NAMES.length; i++) if (st[STATE_NAMES[i]]) b |= 1 << i;
    this.t[this.head] = t; this.bits[this.head] = b;
    this.head = (this.head + 1) % RING; if (this.n < RING) this.n++;
  }

  /** Bit mask of the states that satisfy a held-move note. */
  static maskFor(note) {
    if (note.move === 'squat') return BIT.squat;
    if (note.move === 'guard') return BIT.guard;
    if (note.move === 'dodge') return note.side === 'left' ? BIT.leanRight | BIT.stepRight : BIT.leanLeft | BIT.stepLeft;
    return 0;
  }

  /**
   * Judge a held-move note once enough frames exist. Returns {kind, errMs} or null (still pending).
   * `songNow` (s) bounds the wait when tracking is lost.
   */
  evalState(note, songNow) {
    const mask = Judge.maskFor(note);
    const lead = (LEAD_MS[note.move] ?? 0) + (this.settings.judgeOffsetMs || 0);
    const targetPerf = this.clock.toPerf(this.noteTime(note)) + lead;
    const good = this.win.good;
    const newest = this.n ? this.t[(this.head - 1 + RING) % RING] : -1e12;
    const timedOut = songNow > this.clock.timeAtBeat(note.beat) + (good + 400) / 1000;   // songNow is in the note's timeline
    if (newest < targetPerf && !timedOut) return null;
    // walk back from the newest sample
    let atTarget = -1, firstAfter = -1, lastBefore = -1;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - 1 - k + RING * 2) % RING;
      const t = this.t[i], on = (this.bits[i] & mask) !== 0;
      if (t > targetPerf) { if (on && t - targetPerf <= good) firstAfter = i; continue; }
      if (atTarget < 0) { atTarget = i; if (!on) { /* keep looking for an early release */ } }
      if (on) { lastBefore = i; break; }
      if (targetPerf - t > good) break;
    }
    if (atTarget >= 0 && (this.bits[atTarget] & mask)) {
      // in the state on the hit: graded by the entry time (negative = how early it started)
      let entry = this.t[atTarget];
      for (let k = 1; k < this.n; k++) {
        const i = (atTarget - k + RING * 2) % RING;
        if (!(this.bits[i] & mask) || targetPerf - this.t[i] > 2000) break;
        entry = this.t[i];
      }
      const e = entry - targetPerf;
      return { kind: e >= -HELD_EARLY_MS ? 'perfect' : 'great', errMs: e };
    }
    if (firstAfter >= 0) { const e = this.t[firstAfter] - targetPerf; return { kind: this.classify(e), errMs: e }; }
    if (newest < targetPerf + good && !timedOut) return null;    // it may still come (late)
    if (lastBefore >= 0) { const e = this.t[lastBefore] - targetPerf; return { kind: this.classify(-e), errMs: e }; }
    return { kind: 'miss', errMs: NaN };
  }

  record(note, kind, errMs) {
    this.log.unshift({ kind, errMs, type: note.type, side: note.side, react: !!note.react });
    if (this.log.length > 14) this.log.pop();
    if (kind !== 'miss' && Number.isFinite(errMs) && !note.react && (note.move === 'punch' || note.move === 'kick' || note.move === 'jump')) {
      this.errHist.push(errMs); if (this.errHist.length > 64) this.errHist.shift();
    }
  }
}

export { STATE_NAMES, BIT };
