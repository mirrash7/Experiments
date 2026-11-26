// Boss script: the Eclipse Warden. Turns a beat timeline into notes on the shared spirit field and drives BossView:
//   slam -> jump (a floor shockwave: sweep beam)      sweep -> duck (a high scythe beam)
//   barrage -> punches (strikers fired from the boss)  weak point -> charge + Breaklight blast (3 blasts defeat it)
// ~60 s: an 8-beat intro, three 36-beat cycles (the third one faster), then the defeat / retreat.
import * as THREE from 'three';

const INTRO = 8, CYCLE = 36;
export const BOSS_BEATS = INTRO + CYCLE * 3 + 8;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class BossScript {
  /**
   * @param {object} o
   * @param {object} o.view     BossView (VISUAL)
   * @param {object} o.field    SpiritField
   * @param {number} o.startBeat
   * @param {object} o.cb       { onPhase(phase, info), onDefeat(), onRetreat() }
   */
  constructor({ view, field, startBeat, cb, upperBodyOnly = false }) {
    this.view = view; this.field = field; this.start = startBeat; this.cb = cb;
    this.hp = 1; this.blasts = 0; this.done = false; this.phase = 'intro';
    this.notes = [];
    this.origin = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this.upper = upperBodyOnly;
    this.endBeat = startBeat + BOSS_BEATS;
    this.defeatBeat = Infinity;
    this._build();
  }

  /** Projectile origin near the weak point (the rift is closed while the boss stands), at height y (null = weak point's). */
  _origin(y = null) {
    const w = this.view?.weakPoint;
    if (w) return new THREE.Vector3(w.x, y ?? w.y, w.z - 1.5);
    const o = this.view?.object?.position;
    return new THREE.Vector3(o ? o.x : 0, y ?? 5, o ? Math.max(8, o.z - 3) : 22);
  }

  _note(type, side, rel, extra = {}) {
    const beat = this.start + rel;
    const travel = extra.travel ?? 3;
    const n = { type, side, beat, spawnBeat: beat - travel, travel, teleBeats: 2, act: 'boss', boss: true, opt: false,
      move: { striker: 'punch', crawler: 'kick', sweep: 'jump', scythe: 'squat', volley: 'dodge', core: 'blast' }[type], ...extra };
    if (this.upper && type === 'sweep') { n.type = 'volley'; n.move = 'dodge'; n.side = rel % 2 ? 'left' : 'right'; }
    this.notes.push(n);
    return n;
  }

  _build() {
    for (let c = 0; c < 3; c++) {
      const b = INTRO + c * CYCLE;
      this._note('sweep', 'center', b + 4, { bossAttack: 'slam', origin: this._origin(0.15), travel: 3.5 });
      this._note('scythe', 'center', b + 9, { bossAttack: 'sweep', origin: this._origin(1.5), travel: 3.5 });
      const step = c === 2 ? 0.5 : 1;
      const count = c === 2 ? 6 : 4;
      for (let i = 0; i < count; i++) {
        this._note('striker', i % 2 ? 'right' : 'left', b + 14 + i * step, { bossAttack: i === 0 ? 'barrage' : null, origin: this._origin(), travel: 3.5 });
      }
      this._note('volley', c % 2 ? 'right' : 'left', b + 20, { origin: this._origin(), travel: 3.5 });
      this._note('volley', c % 2 ? 'left' : 'right', b + 22, { origin: this._origin(), travel: 3.5 });
      this._note('sweep', 'center', b + 25, { bossAttack: 'slam', origin: this._origin(0.15), travel: 3.5 });
      // weak point: opens on b+28 and stays open 6 beats; the blast target is the boss' weak point
      const wp = this.view?.weakPoint ?? new THREE.Vector3(0, 5, 24);
      this._note('core', 'center', b + 28, { travel: 0.01, hover: 6, target: wp.clone(), weak: true,
        makeView: () => this._weakView() });
    }
    for (const n of this.notes) this.field.add(n);
  }

  /** SpiritView adapter for the weak point (no spirit mesh: the boss' own seam opens). */
  _weakView() {
    const view = this.view;
    try { view.openWeakPoint?.(true); } catch { /* */ }
    this.cb.onPhase?.('weak', { hp: this.hp });
    const obj = new THREE.Object3D();
    return {
      object: obj, side: 'center', hitPoint: view?.weakPoint ?? obj.position,
      setTelegraph() {}, update() {},
      hit: () => { try { view.openWeakPoint?.(false); } catch { /* */ } },
      dodged: () => { try { view.openWeakPoint?.(false); } catch { /* */ } },
      strikeHero: () => { try { view.openWeakPoint?.(false); } catch { /* */ } },
      release: () => { try { view.openWeakPoint?.(false); } catch { /* */ } },
    };
  }

  /** A blast hit the weak point. Returns true when the boss is defeated. */
  blastHit(beatNow) {
    this.blasts++;
    this.hp = Math.max(0, 1 - this.blasts / 3);
    try { this.view.hit?.('perfect'); this.view.stagger?.(); } catch { /* */ }
    this.cb.onPhase?.('stagger', { hp: this.hp });
    if (this.blasts >= 3) {
      this.done = true; this.phase = 'defeat';
      // drop the rest of the script, play the death sequence
      for (const n of this.notes) if (!n.resolved && !n.live) n.cancelled = true;
      this.field.pending = this.field.pending.filter((n) => !n.cancelled);
      try { this.view.defeat?.(); } catch { /* */ }
      this.defeatBeat = beatNow;
      this.endBeat = beatNow + 10;
      this.cb.onDefeat?.();
      return true;
    }
    return false;
  }
  /** A barrage spirit hit: small chip + flinch. */
  chip() { try { this.view.hit?.('good'); } catch { /* */ } }

  update(dt, beatNow) {
    const v = this.view;
    if (!v) return;
    const rel = beatNow - this.start;
    if (this.phase === 'intro' && rel >= INTRO) { this.phase = 'fight'; this.cb.onPhase?.('fight', { hp: this.hp }); }
    // telegraph the next boss attack within 2 beats, fire it on its beat
    let tele = null, teleT = 0;
    for (const n of this.notes) {
      if (!n.bossAttack || n.attacked || n.cancelled) continue;
      const left = n.beat - beatNow;
      if (left <= 0) { n.attacked = true; try { v.attack?.(n.bossAttack); } catch { /* */ } continue; }
      if (left < 2.5 && (!tele || n.beat < tele.beat)) { tele = n; teleT = clamp01(1 - left / 2.5); }
    }
    if (tele) { try { v.telegraph?.(tele.bossAttack, teleT); } catch { /* */ } }
    try { v.update?.(dt); } catch { /* */ }
    if (!this.done && beatNow >= this.endBeat) { this.done = true; this.phase = 'retreat'; this.cb.onRetreat?.(); }
  }
}
