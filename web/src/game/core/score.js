// Score, combo multiplier, Flow / Overdrive, health, and the body stats shown on the results screen.
export const POINTS = { perfect: 300, great: 200, good: 100, miss: 0 };
const FLOW_GAIN = { perfect: 0.075, great: 0.055, good: 0.035 };
const OVERDRIVE_S = 10;
export let HEART_REGEN = 30;
export function setHeartRegen(n) { HEART_REGEN = n; }
/** Approximate energy per move (kcal) on top of a ~5 MET baseline for an active 70 kg player. */
const KCAL = { punch: 0.1, kick: 0.25, jump: 0.3, squat: 0.3, dodge: 0.1, guard: 0.05, blast: 0.4 };

export function multiplierFor(combo) { return combo >= 50 ? 4 : combo >= 25 ? 3 : combo >= 10 ? 2 : 1; }

export class Score {
  constructor({ bus, hearts = 5 }) {
    this.bus = bus;
    this.maxHealth = hearts;
    this.reset();
  }
  reset() {
    this.score = 0; this.combo = 0; this.maxCombo = 0; this.health = this.maxHealth;
    this.flow = 0; this.overdrive = false; this.overdriveLeft = 0;
    this.judgements = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.basePoints = 0; this.judged = 0;
    this.recent = [];                     // last 16 outcomes (1 hit / 0 miss) for adaptive density
    this.playTime = 0;
    this.body = { fastestPunch: 0, maxJumpCm: 0, bestReactionMs: 0, moves: { punch: 0, kick: 0, jump: 0, squat: 0, dodge: 0, guard: 0, blast: 0, total: 0 }, kcal: 0 };
    this.failed = false;
    this.bossDefeated = false;
    this.events = [];                     // {t: song time, kind, combo} for the replay's best-window pick
  }
  get mult() { return multiplierFor(this.combo); }
  /** Rolling hit rate 0..1 (0.7 before there is data). */
  get skill() {
    if (this.recent.length < 4) return 0.7;
    let s = 0; for (const x of this.recent) s += x;
    return s / this.recent.length;
  }
  get accuracy() { return this.judged ? this.basePoints / (this.judged * POINTS.perfect) : 0; }
  get rank() {
    const a = this.accuracy;
    if (this.failed) return a >= 0.8 ? 'B' : 'C';
    return a >= 0.9 ? 'S' : a >= 0.78 ? 'A' : a >= 0.6 ? 'B' : 'C';
  }

  /** Register a judgement; returns the points awarded. `hurt` = a miss costs a heart (hazards / strikes that hit you). */
  judge(kind, { songT = 0, hurt = true, bonus = 0, countCombo = true } = {}) {
    this.judgements[kind]++;
    this.judged++;
    this.basePoints += POINTS[kind];
    let pts = 0;
    if (kind === 'miss') {
      if (this.combo >= 10) this.bus.emit('comboBreak', { combo: this.combo });
      this.combo = 0;
      if (hurt) this.health = Math.max(0, this.health - 1);
      this.recent.push(0);
    } else {
      if (countCombo) this.combo++;
      // a heart back every HEART_REGEN combo (keeps a 5-heart run survivable for real trackers; 0 disables)
      if (HEART_REGEN && countCombo && this.combo % HEART_REGEN === 0 && this.health < this.maxHealth) { this.health++; this.bus.emit('heal', { health: this.health }); }
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      pts = (POINTS[kind] + bonus) * this.mult * (this.overdrive ? 2 : 1);
      this.score += pts;
      if (!this.overdrive) {
        this.flow = Math.min(1, this.flow + FLOW_GAIN[kind]);
        if (this.flow >= 1) this.setOverdrive(true);
      }
      this.recent.push(1);
    }
    if (this.recent.length > 16) this.recent.shift();
    this.events.push({ t: songT, kind, combo: this.combo, pts });
    if (this.events.length > 400) this.events.shift();
    this.emit();
    if (this.health <= 0) this.failed = true;
    return pts;
  }
  addBonus(points) { const p = points * this.mult * (this.overdrive ? 2 : 1); this.score += p; this.emit(); return p; }
  setOverdrive(on) {
    if (this.overdrive === on) return;
    this.overdrive = on;
    this.overdriveLeft = on ? OVERDRIVE_S : 0;
    if (!on) this.flow = 0;
    this.bus.emit('overdrive', { on });
  }
  update(dt) {
    this.playTime += dt;
    if (this.overdrive) {
      this.overdriveLeft -= dt;
      this.flow = Math.max(0, this.overdriveLeft / OVERDRIVE_S);
      if (this.overdriveLeft <= 0) { this.setOverdrive(false); this.emit(); }
    }
  }
  emit() {
    this.bus.emit('score', { score: this.score, combo: this.combo, mult: this.mult, health: this.health, maxHealth: this.maxHealth, flow: this.flow, overdrive: this.overdrive });
  }

  // ------------------------------------------------------------------------------------------ body stats
  move(kind) {
    const m = this.body.moves;
    if (m[kind] === undefined) return;
    m[kind]++; m.total++;
    this.body.kcal += KCAL[kind] ?? 0;
  }
  punchSpeed(mps) { if (Number.isFinite(mps) && mps > 0 && mps < 20) this.body.fastestPunch = Math.max(this.body.fastestPunch, mps); }
  jumpHeight(cm) { if (Number.isFinite(cm) && cm > 0 && cm < 120) this.body.maxJumpCm = Math.max(this.body.maxJumpCm, cm); }
  reaction(ms) { if (Number.isFinite(ms) && ms > 80 && (!this.body.bestReactionMs || ms < this.body.bestReactionMs)) this.body.bestReactionMs = ms; }

  /** Final stats object for ui.screens.results(). */
  results({ cleared }) {
    // ~4 MET baseline (active play) for a 70 kg player: kcal = MET * kg * hours, plus per-move costs
    const base = 4 * 70 * (this.playTime / 3600);
    const b = this.body;
    return {
      cleared, failed: this.failed, bossDefeated: this.bossDefeated,
      score: Math.round(this.score), rank: this.rank, accuracy: this.accuracy, maxCombo: this.maxCombo,
      judgements: { ...this.judgements },
      body: {
        fastestPunch: b.fastestPunch, maxJumpCm: b.maxJumpCm, bestReactionMs: b.bestReactionMs || null,
        moves: b.moves.total, moveCounts: { ...b.moves }, kcal: b.kcal + base,
        // aliases (UI results cards)
        punchSpeed: b.fastestPunch || null, jumpHeight: b.maxJumpCm || null, reactionMs: b.bestReactionMs || null,
      },
      playTime: this.playTime,
    };
  }
}
