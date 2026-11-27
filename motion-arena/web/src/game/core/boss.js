// Boss script: the Eclipse Warden. Turns a beat timeline into notes on the shared spirit field and drives BossView:
//   slam -> jump (a floor shockwave: sweep beam)      sweep -> duck (a high scythe beam)
//   barrage -> punches / dodges (spirits fired from the boss)   fist -> guard, then punch 3x (brute)
//   weak point -> charge + Breaklight blast (3 blasts defeat it)
//
// Three phases, each one a different, denser attack pattern (not copies of one cycle):
//   1 "Awakened"    slams, a scythe, a 4-jab barrage, a pair of volleys            (~30 notes/min)
//   2 "Eclipse"     mirrored volleys with counters, crawler shards, the Warden's fist (guard + 3 punches)
//   3 "Breaklight"  eighth-note barrages, dodge-counters, slam / scythe combos       (~45-55 notes/min)
// Each phase ends in a weak-point window. A blast that lands advances the phase; a missed window repeats the phase's
// pattern (a variant) with a LONGER window, until 3 blasts land. Showcase mode never gives up; Challenge mode makes the
// Warden retreat after `capS` seconds.
import * as THREE from 'three';
import { parseBar } from './chart.js';

const INTRO = 8;
/** Nominal boss length in beats (kept for older callers; the fight now runs until 3 blasts land). */
export const BOSS_BEATS = INTRO + 36 * 3 + 8;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const MOVE = { striker: 'punch', crawler: 'kick', sweep: 'jump', scythe: 'squat', volley: 'dodge', brute: 'guard', core: 'blast' };

/**
 * Phase patterns: bars of the chart notation (4 or 8 slots per bar). Two variants per phase (the repeat after a missed
 * weak point uses the next one). The weak point opens 2 beats after the last bar.
 */
export const BOSS_PHASES = [
  { name: 'AWAKENED', travel: 3.5, window: 6, variants: [
    ['. . . .', 'J . . .', '. . D .', '. . . .', 'SL . SR .', 'SL . SR .', 'VL . . .', 'VR . . .', 'J . . .'],
    ['. . . .', 'D . . .', '. . J .', '. . . .', 'SR . SL .', 'SR . SL .', 'VR . . .', 'VL . . .', 'J . . .'],
  ] },
  { name: 'ECLIPSE', travel: 3.25, window: 7, variants: [
    ['. . . .', 'VL . SR .', 'VR . SL .', 'CL . CR .', 'B . . .', '. . . .', '. . . .', 'D . . .', 'SL . SR .', 'VL . VR .', 'J . . .'],
    ['. . . .', 'VR . SL .', 'VL . SR .', 'CR . CL .', 'B . . .', '. . . .', '. . . .', 'J . . .', 'SR . SL .', 'VR . VL .', 'D . . .'],
  ] },
  { name: 'BREAKLIGHT', travel: 3, window: 8, variants: [
    ['. . . . . . . .', 'SL SR SL SR . . J .', '. . . . VL . . .', 'VR . SL . D . . .', '. . . . CL . CR .',
      'SL SR SL . . . . .', 'B . . . . . . .', '. . . . . . . .', 'VL . VR . J . . .'],
    ['. . . . . . . .', 'SR SL SR SL . . D .', '. . . . VR . . .', 'VL . SR . J . . .', '. . . . CR . CL .',
      'SR SL SR . . . . .', 'B . . . . . . .', '. . . . . . . .', 'VR . VL . D . . .'],
  ] },
];
const RECOVER = { striker: 0.5, crawler: 1, sweep: 2, scythe: 2, volley: 1, brute: 4, core: 4 };

export class BossScript {
  /**
   * @param {object} o
   * @param {object} o.view     BossView (VISUAL)
   * @param {object} o.field    SpiritField
   * @param {number} o.startBeat
   * @param {object} o.cb       { onPhase(phase, info), onDefeat(), onRetreat() }
   * @param {boolean} [o.upperBodyOnly]
   * @param {boolean} [o.seated]
   * @param {boolean} [o.canRetreat]  Challenge: the Warden leaves after capS seconds without 3 blasts
   * @param {number} [o.beatDur]
   */
  constructor({ view, field, startBeat, cb, upperBodyOnly = false, seated = false, canRetreat = false, capS = 100, beatDur = 60 / 128 }) {
    this.view = view; this.field = field; this.start = startBeat; this.cb = cb;
    this.hp = 1; this.blasts = 0; this.done = false; this.phase = 'intro';
    this.stage = 0;                 // 0..2: which attack phase (= blasts landed)
    this.tries = 0;                 // weak windows missed in the current stage
    this.notes = [];
    this.upper = upperBodyOnly || seated; this.seated = seated;
    this.canRetreat = canRetreat;
    this.retreatBeat = startBeat + capS / beatDur;
    this.endBeat = Infinity;        // set on defeat / retreat (the game leaves to results after it)
    this.defeatBeat = Infinity;
    this.cycle = null;              // { stage, startBeat, core, notes }
    this.flip = false;
    this.stats = { cycles: 0, notesByStage: [0, 0, 0], beatsByStage: [0, 0, 0] };
    this._schedule(startBeat + INTRO);
  }

  /** Projectile origin near the weak point (the rift is closed while the boss stands), at height y (null = weak point's). */
  _origin(y = null) {
    const w = this.view?.weakPoint;
    if (w) return new THREE.Vector3(w.x, y ?? w.y, w.z - 1.5);
    const o = this.view?.object?.position;
    return new THREE.Vector3(o ? o.x : 0, y ?? 5, o ? Math.max(8, o.z - 3) : 22);
  }

  _note(type, side, beat, extra = {}) {
    const travel = extra.travel ?? 3.5;
    const n = { type, side, beat, spawnBeat: beat - travel, travel, teleBeats: 2, act: 'boss', boss: true, opt: false, move: MOVE[type], ...extra };
    if (this.upper) {
      if (type === 'crawler') { n.type = 'striker'; n.move = 'punch'; }
      if (type === 'sweep' || (this.seated && type === 'scythe')) { n.type = 'volley'; n.move = 'dodge'; n.side = (this.flip = !this.flip) ? 'left' : 'right'; n.bossAttack = 'barrage'; }
    }
    this.notes.push(n);
    return n;
  }

  /** Lay out one attack cycle of the current stage from `b0` (a bar line), ending in a weak-point window. */
  _schedule(b0) {
    const P = BOSS_PHASES[this.stage];
    const bars = P.variants[this.tries % P.variants.length];
    const notes = [];
    let last = null, firstStrike = true;
    bars.forEach((bar, bi) => {
      for (const s of parseBar(bar)) {
        const beat = b0 + bi * 4 + s.at;
        if (last && beat - last.beat < Math.min(RECOVER[last.type] ?? 1, s.type === 'striker' && last.type === 'striker' ? 0.5 : 1) - 1e-6) continue;
        const extra = { travel: s.type === 'brute' ? P.travel + 2 : P.travel };
        if (s.type === 'sweep') { extra.bossAttack = 'slam'; extra.origin = this._origin(0.15); }
        else if (s.type === 'scythe') { extra.bossAttack = 'sweep'; extra.origin = this._origin(1.5); }
        else if (s.type === 'striker' || s.type === 'volley') {
          extra.origin = this._origin();
          if (firstStrike || (last && last.type !== s.type)) extra.bossAttack = 'barrage';
          firstStrike = false;
        } else if (s.type === 'brute') extra.bossAttack = 'slam';      // the Warden's fist comes down: guard it
        last = this._note(s.type, s.side, beat, extra);
        notes.push(last);
      }
    });
    // weak point: opens 2 beats after the pattern, longer after every miss (6 / 7 / 8 beats, +2 per miss, max 14)
    const coreBeat = b0 + bars.length * 4 + 2;
    const hover = Math.min(14, P.window + this.tries * 2);
    const wp = this.view?.weakPoint ?? new THREE.Vector3(0, 5, 24);
    const core = this._note('core', 'center', coreBeat, { travel: 0.01, hover, target: wp.clone(), weak: true, stage: this.stage, makeView: () => this._weakView() });
    notes.push(core);
    for (const n of notes) this.field.add(n);
    this.cycle = { stage: this.stage, startBeat: b0, core, notes, endBeat: coreBeat + hover };
    this.stats.cycles++;
    this.stats.notesByStage[this.stage] += notes.length;
    this.stats.beatsByStage[this.stage] += coreBeat + hover - b0;
  }

  /** SpiritView adapter for the weak point (no spirit mesh: the boss' own seam opens). */
  _weakView() {
    const view = this.view;
    try { view.openWeakPoint?.(true); } catch { /* */ }
    this.cb.onPhase?.('weak', { hp: this.hp, stage: this.stage, tries: this.tries });
    const obj = new THREE.Object3D();
    const close = () => { try { view.openWeakPoint?.(false); } catch { /* */ } };
    return { object: obj, side: 'center', hitPoint: view?.weakPoint ?? obj.position, setTelegraph() {}, update() {}, hit: close, dodged: close, strikeHero: close, release: close };
  }

  /** A blast hit the weak point. Returns true when the boss is defeated. */
  blastHit(beatNow) {
    this.blasts++;
    this.hp = Math.max(0, 1 - this.blasts / 3);
    try { this.view.hit?.('perfect'); this.view.stagger?.(); } catch { /* */ }
    this.cb.onPhase?.('stagger', { hp: this.hp, stage: this.stage });
    if (this.blasts >= 3) {
      this.done = true; this.phase = 'defeat';
      this._cancelRest();
      try { this.view.defeat?.(); } catch { /* */ }
      this.defeatBeat = beatNow;
      this.endBeat = beatNow + 10;
      this.cb.onDefeat?.();
      return true;
    }
    this.stage = Math.min(2, this.blasts); this.tries = 0;
    this.cb.onPhase?.('phase', { hp: this.hp, stage: this.stage, name: BOSS_PHASES[this.stage].name });
    return false;
  }
  _cancelRest() {
    for (const n of this.notes) if (!n.resolved && !n.live) n.cancelled = true;
    this.field.pending = this.field.pending.filter((n) => !n.cancelled);
  }
  /** A barrage spirit hit: small chip + flinch. */
  chip() { try { this.view.hit?.('good'); } catch { /* */ } }

  /** Pause/resume: every scheduled beat moves by `beats` (the field shifts its own notes). */
  shift(beats) {
    this.start += beats; this.retreatBeat += beats;
    if (Number.isFinite(this.endBeat)) this.endBeat += beats;
    if (this.cycle) { this.cycle.startBeat += beats; this.cycle.endBeat += beats; }
  }

  update(dt, beatNow) {
    const v = this.view;
    const rel = beatNow - this.start;
    if (this.phase === 'intro' && rel >= INTRO) { this.phase = 'fight'; this.cb.onPhase?.('fight', { hp: this.hp, stage: 0, name: BOSS_PHASES[0].name }); }
    // next cycle once the weak-point window of the current one is over (hit -> next stage, missed -> same stage again)
    const c = this.cycle;
    if (!this.done && c && c.core.resolved && c.core.kind !== 'perfect' && !c.missed) {
      c.missed = true; this.tries++;
      this.cb.onPhase?.('missed', { hp: this.hp, stage: this.stage, tries: this.tries });
    }
    if (!this.done && c && c.core.resolved && !c.next) {
      if (this.canRetreat && beatNow >= this.retreatBeat) {
        this.done = true; this.phase = 'retreat'; this._cancelRest(); this.endBeat = beatNow; this.cb.onRetreat?.();
      } else {
        c.next = true;
        this._schedule(Math.ceil((beatNow + 4) / 4) * 4);
      }
    }
    if (!v) return;
    // telegraph the next boss attack within 2.5 beats, fire it on its beat
    let tele = null, teleT = 0;
    for (const n of this.notes) {
      if (!n.bossAttack || n.attacked || n.cancelled) continue;
      const left = n.beat - beatNow;
      if (left <= 0) { n.attacked = true; try { v.attack?.(n.bossAttack); } catch { /* */ } continue; }
      if (left < 2.5 && (!tele || n.beat < tele.beat)) { tele = n; teleT = clamp01(1 - left / 2.5); }
    }
    if (tele) { try { v.telegraph?.(tele.bossAttack, teleT); } catch { /* */ } }
    try { v.update?.(dt); } catch { /* */ }
    // keep the note list short (old resolved notes)
    if (this.notes.length > 160) this.notes = this.notes.filter((n) => !n.resolved || beatNow - n.beat < 8);
  }
}
