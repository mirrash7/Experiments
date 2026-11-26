// Chart generator: authored per-act phrases (data) -> beat-quantized notes, with fairness rules, the upper-body-only
// filter and adaptive density. Notes are generated phrase by phrase just ahead of the music, so the density follows
// the player's current hit rate.
//
// Note = { id, type, side, beat (absolute clock beat of the hit), spawnBeat, teleBeats, act, opt, react, boss, ... }
// Types: striker (punch, side), crawler (kick, side), sweep (jump), scythe (duck), volley (dodge AWAY from side),
//        brute (guard on the beat, then 3 punches), core (charge + Breaklight blast while it hovers).
//
// Phrase notation: one string per bar, space-separated slots. 4 slots = quarter beats; 8 slots = eighth beats.
//   SL/SR striker  CL/CR crawler  J sweep (jump)  D scythe (duck)  VL/VR volley from the left/right  B brute  O core
//   '.' rest; a trailing '?' marks an optional note (kept by adaptive density only when the player is doing well).

export const MOVE_OF = { striker: 'punch', crawler: 'kick', sweep: 'jump', scythe: 'squat', volley: 'dodge', brute: 'guard', core: 'blast' };
const TOKENS = { SL: ['striker', 'left'], SR: ['striker', 'right'], CL: ['crawler', 'left'], CR: ['crawler', 'right'], J: ['sweep', 'center'],
  D: ['scythe', 'center'], VL: ['volley', 'left'], VR: ['volley', 'right'], B: ['brute', 'center'], O: ['core', 'center'] };

/** Per-act config: travel (beats from the rift to the hit point), telegraph lead (beats), phrases with difficulty 1..3. */
export const ACTS = [
  { // ACT 1, amber dusk: strikes, a first kick and jump
    name: 'ACT 1', sub: 'Dusk Rising', bars: 24, travel: 4, tele: 2,
    intro: ['SL . . .', 'SR . . .'],
    phrases: [
      { d: 1, bars: ['SL . . .', 'SR . . .'] },
      { d: 1, bars: ['SL . SR .', 'SL . SR .'] },
      { d: 1, bars: ['SR . . .', 'SL . SR? .'] },
      { d: 2, bars: ['SR . SL .', 'J . . .'] },
      { d: 2, bars: ['SL . SR? .', 'CL . . .'] },
      { d: 2, bars: ['SR . SL? .', 'CR . . .'] },
      { d: 2, bars: ['SL . SL? .', 'SR . SR? .'] },
      { d: 3, bars: ['SL SR? SL .', 'J . . .'] },
    ],
  },
  { // ACT 2, magenta: ducks, dodges and the first brute
    name: 'ACT 2', sub: 'Crimson Tide', bars: 24, travel: 3.5, tele: 1.75,
    intro: ['SL . SR .', 'D . . .'],
    phrases: [
      { d: 1, bars: ['SL . SR .', 'D . . .'] },
      { d: 1, bars: ['VL . . .', 'VR . . .'] },
      { d: 2, bars: ['SL SR? SL .', 'J . . .'] },
      { d: 2, bars: ['B . . .', '. . . .'] },
      { d: 2, bars: ['CL . CR? .', 'SL . SR .'] },
      { d: 2, bars: ['D . . .', 'SL . SR? .'] },
      { d: 3, bars: ['VR . SL .', 'VL . SR .'] },
      { d: 3, bars: ['SL SR SL SR?', 'CR . . .'] },
    ],
  },
  { // ACT 3, violet night: everything, eighth-note punch runs, a Spirit Core finale
    name: 'ACT 3', sub: 'Violet Night', bars: 24, travel: 3, tele: 1.5,
    intro: ['SL . . . SR . . .', 'J . . . . . . .'],
    finale: ['O . . . . . . .', '. . . . . . . .'],
    phrases: [
      { d: 1, bars: ['SL . . . SR . . .', 'J . . . . . . .'] },
      { d: 2, bars: ['SL . SR . SL . SR? .', 'D . . . . . . .'] },
      { d: 2, bars: ['VL . . . SR . SL .', 'D . . . . . . .'] },
      { d: 2, bars: ['CL . . . CR . . .', 'SL . SR . J . . .'] },
      { d: 2, bars: ['B . . . . . . .', '. . . . . . . .'] },
      { d: 3, bars: ['SL . SR . SL SR SL .', 'VR . . . VL . . .'] },
      { d: 3, bars: ['SR SL SR . . . CL .', '. . . . J . . .'] },
      { d: 3, bars: ['VR . SL SR VL . SR SL?', 'D . . . . . . .'] },
    ],
  },
];

/** Minimum beats after a note of this type before the next required move (recovery), and for the next one. */
const RECOVER = { striker: 0.5, crawler: 1.5, sweep: 2, scythe: 2, volley: 1, brute: 4, core: 8 };
const BEFORE = { striker: 0.5, crawler: 1, sweep: 1, scythe: 1, volley: 1, brute: 1.5, core: 2 };

/** Seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Parse one bar string into [{slotBeat, type, side, opt}]. */
export function parseBar(str) {
  const slots = str.trim().split(/\s+/);
  if (slots.length !== 4 && slots.length !== 8) console.warn(`[chart] bar "${str}" has ${slots.length} slots (want 4 or 8)`);
  const step = 4 / slots.length;
  const out = [];
  slots.forEach((tok, i) => {
    if (tok === '.' || !tok) return;
    const opt = tok.endsWith('?');
    const key = tok.replace(/[?.]/g, '');
    const def = TOKENS[key];
    if (!def) return;
    out.push({ at: i * step, type: def[0], side: def[1], opt });
  });
  return out;
}

/**
 * Fairness check of a candidate note against the previous kept note. Returns true when allowed.
 * - gap >= max(RECOVER[prev], BEFORE[next]); eighth-note gaps (0.5) only for alternating strikers from act 3;
 * - same-leg kicks >= 2 beats apart; a jump right after a duck (or vice versa) >= 2.5 beats.
 */
export function fair(prev, n, act) {
  if (!prev) return true;
  const gap = n.beat - prev.beat;
  let need = Math.max(RECOVER[prev.type] ?? 1, BEFORE[n.type] ?? 1);
  if (prev.type === 'striker' && n.type === 'striker') need = act >= 2 && prev.side !== n.side ? 0.5 : 1;
  if (prev.type === 'striker' && n.type !== 'striker') need = Math.max(need, 1);
  if (prev.type === 'crawler' && n.type === 'crawler' && prev.side === n.side) need = Math.max(need, 2);
  if ((prev.type === 'scythe' && n.type === 'sweep') || (prev.type === 'sweep' && n.type === 'scythe')) need = Math.max(need, 2.5);
  return gap >= need - 1e-6;
}

/** Upper-body-only substitution: no kicks or jumps (small rooms). */
export function upperOnly(n, flip) {
  if (n.type === 'crawler') { n.type = 'striker'; return n; }
  if (n.type === 'sweep') { n.type = 'volley'; n.side = flip ? 'left' : 'right'; return n; }
  return n;
}

/**
 * Incremental chart for one act. gen.update(beatNow, skill) appends phrases until `horizon` beats ahead.
 * Notes are pushed into the `out` array given to the constructor (consumers drain it).
 */
export class ActChart {
  constructor({ act, startBeat, settings, seed = 1, out = [] }) {
    this.cfg = ACTS[act];
    this.act = act;
    this.startBeat = startBeat;                     // first bar of the act (notes start after a 1-bar lead-in)
    this.endBeat = startBeat + this.cfg.bars * 4;
    this.cursor = startBeat + 4;                    // next phrase starts here
    this.settings = settings;
    this.rand = rng(seed * 7919 + act * 104729);
    this.out = out;
    this.last = null;
    this.count = 0;
    this.flip = false;
    this.done = false;
    this.phraseIdx = 0;
  }
  /** Beat the act's last note resolves (for transitions). */
  get lastBeat() { return this.last ? this.last.beat + (this.last.type === 'core' ? 8 : this.last.type === 'brute' ? 3 : 0) : this.cursor; }

  update(beatNow, skill = 0.7) {
    const horizon = beatNow + this.cfg.travel + 10;
    while (!this.done && this.cursor < horizon) {
      const remaining = (this.endBeat - this.cursor) / 4;
      let bars;
      if (this.phraseIdx === 4 && remaining > 6) { this._reaction(); this.phraseIdx++; continue; }
      if (this.phraseIdx === 0) bars = this.cfg.intro;
      else if (this.cfg.finale && remaining < this.cfg.finale.length + 2) bars = this.cfg.finale;
      else bars = this._pick(skill).bars;
      if (remaining < bars.length) { this.done = true; break; }
      this._emit(bars, skill);
      this.phraseIdx++;
      if (this.cfg.finale && bars === this.cfg.finale) this.done = true;
      if (this.endBeat - this.cursor < 4) this.done = true;
    }
  }

  /** A 2-bar rest with one unannounced reaction-test striker at a random (unquantized) moment. */
  _reaction() {
    const beat = this.cursor + 1.5 + this.rand() * 3.5;
    const n = reactionNote(this.act, beat, this.rand() < 0.5 ? 'left' : 'right');
    n.id = 0;
    this.out.push(n);
    this.last = { type: 'core', beat: this.cursor }; // RECOVER.core = 8: the next phrase starts right after the rest
    this.cursor += 8;
  }

  _pick(skill) {
    // weight phrases by how well their difficulty fits the current skill (0..1 -> target difficulty 1..3)
    const target = 1 + 2 * Math.min(1, Math.max(0, skill));
    const ph = this.cfg.phrases;
    let total = 0;
    const w = ph.map((p) => { const x = Math.exp(-((p.d - target) ** 2) / 0.8); total += x; return x; });
    let r = this.rand() * total;
    for (let i = 0; i < ph.length; i++) { r -= w[i]; if (r <= 0) return ph[i]; }
    return ph[ph.length - 1];
  }

  _emit(bars, skill) {
    const density = this.settings.adaptive ? Math.min(1, Math.max(0.15, 0.2 + skill * 0.9)) : 0.75;
    for (let b = 0; b < bars.length; b++) {
      for (const s of parseBar(bars[b])) {
        if (s.opt && this.rand() > density) continue;
        const n = { type: s.type, side: s.side, beat: this.cursor + b * 4 + s.at, opt: s.opt };
        if (this.settings.upperBodyOnly) { upperOnly(n, this.flip); this.flip = !this.flip; }
        // no eighth notes before act 3: snap to the beat
        if (this.act < 2) n.beat = Math.round(n.beat);
        let ok = fair(this.last, n, this.act);
        if (!ok) { // try pushing it back by up to a beat (stay inside the phrase)
          const orig = n.beat;
          for (const d of [0.5, 1]) {
            n.beat = orig + d;
            if (this.act < 2 && n.beat % 1) continue;
            if (n.beat < this.cursor + bars.length * 4 && fair(this.last, n, this.act)) { ok = true; break; }
          }
        }
        if (!ok) continue;
        this._push(n);
      }
    }
    this.cursor += bars.length * 4;
  }

  _push(n) {
    const c = this.cfg;
    n.id = 0; n.act = this.act;
    n.teleBeats = c.tele;
    n.travel = n.type === 'brute' ? c.travel + 2 : n.type === 'core' ? c.travel + 1 : c.travel;
    n.spawnBeat = n.beat - n.travel;
    n.move = MOVE_OF[n.type];
    this.last = n; this.count++;
    this.out.push(n);
  }
}

/** One reaction-test "flash" striker per act: unannounced, appears on the spot; judged on reaction time, not the beat. */
export function reactionNote(act, beat, side) {
  return { type: 'striker', side, beat, spawnBeat: beat, teleBeats: 0, travel: 0, act, react: true, move: 'punch', opt: false };
}
