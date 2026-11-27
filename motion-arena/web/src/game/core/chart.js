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

/**
 * Per-act config: travel (beats from the rift to the hit point), telegraph lead (beats), phrases with difficulty 1..3.
 *   teach:  fixed phrases that ALWAYS open the act (whatever the seed / skill): they introduce the act's new mechanics.
 *   finale: every act ends on a Spirit Core (the Breaklight blast is the recurring payoff, not a 2-minute wait).
 *   npm:    density ceiling (notes / beat x 128 over the act, scaled down a little for a struggling player): pool notes
 *           past it are dropped. The curve rises act by act (QA r2 P1-3): measured over the act's span that is
 *           Act 1 ~30-34, Act 2 ~38-42, Act 3 ~44-48 notes / min for a player who hits most notes.
 *   rest:   chance an over-cap note becomes a rest instead of another move (Act 1 is mostly strikes + rests).
 *   demo:   the ~4-minute "Demo" length (kiosk default): fewer bars and a shorter teaching block (the Awakening
 *           already taught every move).
 * Phrase pools keep strikers under half the notes and kicks rare (screen-directed, tiring); ActChart caps both
 * (STRIKER_CAP, KICK_CAP) and spreads over-cap notes across the act's other moves (see _convert).
 */
export const ACTS = [
  { // ACT 1, amber dusk: strikes, then kicks, jumps and ducks are introduced
    name: 'ACT 1', sub: 'Dusk Rising', bars: 26, travel: 4, tele: 2, npm: 30, rest: 0.4,
    teach: ['SL . SR .', 'CL . . .', 'SR . SL .', 'J . . .', 'SL . SR .', 'D . . .', 'SR . SL .', 'CR . . .'],
    demo: { bars: 16, teach: ['SL . SR .', 'J . . .', 'SR . SL .', 'D . . .'] },
    convert: ['scythe', 'crawler', 'sweep'],
    finale: ['O . . .', '. . . .'],
    phrases: [
      { d: 1, bars: ['SL . SR .', 'J . . .'] },
      { d: 1, bars: ['SR . . .', 'D . . .'] },
      { d: 1, bars: ['SL . . .', 'CR . . .'] },
      { d: 2, bars: ['SL . SR .', '. . D .'] },
      { d: 2, bars: ['CL . . .', 'SR . SL? .'] },
      { d: 2, bars: ['SR . SL .', 'J . . .'] },
      { d: 2, bars: ['D . . .', 'SL . SR? .'] },
      { d: 3, bars: ['SL . SR .', 'SL . J .'] },
      { d: 3, bars: ['SR . SL .', 'D . SR? .'] },
      { d: 3, bars: ['J . . SL', 'SR . D .'] },
    ],
  },
  { // ACT 2, magenta: dodges and the first brute are introduced; denser than Act 1 (off-beat jabs, dodge-counters)
    name: 'ACT 2', sub: 'Crimson Tide', bars: 26, travel: 3.5, tele: 1.75, npm: 38, rest: 0.15,
    teach: ['VL . . .', 'VR . SL .', 'SR . SL .', 'B . . .', '. . . .', 'VL . SR .'],
    demo: { bars: 16, teach: ['VL . SR .', 'B . . .', '. . . .', 'VR . SL .'] },
    convert: ['volley', 'scythe', 'sweep', 'crawler'],
    finale: ['O . . .', '. . . .'],
    phrases: [
      { d: 1, bars: ['VL . SR .', 'SL . SR .'] },          // dodge the left-side orb, counter right, double jab
      { d: 1, bars: ['VR . SL .', 'D . . .'] },
      { d: 1, bars: ['SL . SR .', 'J . . .'] },
      { d: 2, bars: ['D . . SL', 'SR . SL? .'] },          // duck, then off-beat jabs
      { d: 2, bars: ['J . . .', 'CL . SR .'] },            // jump, a kick on landing, counter
      { d: 2, bars: ['VL . VR? .', 'SL SR . .'] },
      { d: 2, bars: ['B . . .', '. SL . SR'] },
      { d: 3, bars: ['VR . SL SR', 'VL . SR SL?'] },
      { d: 3, bars: ['SL SR . D', '. . SL SR?'] },
      { d: 3, bars: ['SL . SR SL', 'J . . VR?'] },
    ],
  },
  { // ACT 3, violet night: everything, eighth-note punch runs, a Spirit Core finale
    name: 'ACT 3', sub: 'Violet Night', bars: 26, travel: 3, tele: 1.5, npm: 44, rest: 0.15,
    teach: ['SL . SR . VL . . .', 'D . . . CR . . .', 'B . . . . . . .', '. . . . J . . .'],
    demo: { bars: 18, teach: ['SL . SR . VL . . .', 'B . . . . . . .', '. . . . J . . .'] },
    convert: ['volley', 'scythe', 'sweep', 'crawler'],
    finale: ['O . . . . . . .', '. . . . . . . .'],
    phrases: [
      { d: 1, bars: ['SL . . . SR . . .', 'J . . . . . . .'] },
      { d: 1, bars: ['VR . . . SL . . .', 'D . . . . . . .'] },
      { d: 2, bars: ['SL . SR . SL . . .', 'VL . . . SR . . .'] },
      { d: 2, bars: ['VL . . . SR . SL .', 'D . . . . . . .'] },
      { d: 2, bars: ['CL . . . SR . SL .', 'J . . . . . . .'] },
      { d: 2, bars: ['B . . . . . . .', '. . . . SL . SR .'] },
      { d: 3, bars: ['SL . SR . SL SR . .', 'VR . . . J . . .'] },
      { d: 3, bars: ['D . . . SL . SR .', 'VL . . . SR SL? . .'] },
      { d: 3, bars: ['VR . SL . VL . SR .', 'J . . . . . . .'] },
    ],
  },
];

/** Max share of strikers in an act (counted over the notes kept so far, from the 6th note on). */
export const STRIKER_CAP = 0.45;
/** Max share of kicks (crawlers) in an act: front kicks are aimed at the screen and are the most tiring move. */
export const KICK_CAP = 0.2;
/** Beats of calm before the boss (no notes; banner + groove), and the act-length key. */
export const BREATHER_BEATS = 12;
export const isDemo = (settings) => settings?.length === 'demo';

/**
 * Act 0 "Awakening": the guided first minute, on the real music. Each section introduces one spirit type; the
 * first note of a section WAITS (the field freezes with the spirit at its hit point and its prompt) until the player
 * does the move once, then the rest of the section plays at tempo. After a wait note the next note is >= 6 beats
 * later (travel 4 + margin), so nothing else is in flight while the field is frozen.
 *   [beat in section, token, wait]
 */
export const AWAKEN = {
  name: 'ACT 0', sub: 'Awakening', travel: 4, tele: 2,
  sections: [
    { id: 'punch', len: 26, notes: [[2, 'SL', 1], [8, 'SR', 1], [14, 'SL'], [16, 'SR'], [18, 'SL'], [20, 'SR']] },
    { id: 'guard', len: 14, notes: [[6, 'B', 1]] },
    { id: 'dodge', len: 16, notes: [[2, 'VL', 1], [8, 'VR'], [11, 'VL']] },
    { id: 'duck', len: 14, notes: [[2, 'D', 1], [8, 'D']], seated: false },
    { id: 'jump', len: 14, notes: [[2, 'J', 1], [8, 'J']], lower: true },
    { id: 'kick', len: 16, notes: [[2, 'CL', 1], [8, 'CR'], [10, 'CL']], lower: true },
    { id: 'blast', len: 14, notes: [[2, 'O', 1]] },
  ],
};
/** Prompt shown while an Awakening spirit waits for its move. */
export const AWAKEN_PROMPT = {
  striker: { left: '◀ LEFT PUNCH', right: 'RIGHT PUNCH ▶' },
  crawler: { left: '◀ LEFT KICK', right: 'RIGHT KICK ▶' },
  sweep: 'JUMP!', scythe: 'DUCK!', volley: { left: 'LEAN RIGHT ▶', right: '◀ LEAN LEFT' },
  brute: 'GUARD!', core: 'HANDS UP!',
};
export const AWAKEN_HINT = {
  punch: 'Punch the orange spirits: left lane = left hand', guard: 'Block the gold brute, then punch it 3 times',
  dodge: 'Lean away from the yellow orbs', duck: 'Duck under the violet beam', jump: 'Jump the red floor beam',
  kick: 'Kick the cyan crawlers', blast: 'Charge your Breaklight',
};

/** Build the Awakening notes from beat `startBeat` (virtual timeline). Returns { notes, endBeat }. */
export function awakeningNotes(startBeat, settings) {
  const notes = [];
  const upper = !!(settings.upperBodyOnly || settings.seated);
  let cursor = startBeat;
  for (const sec of AWAKEN.sections) {
    if (sec.lower && upper) continue;
    if (sec.seated === false && settings.seated) continue;
    for (const [at, tok, wait] of sec.notes) {
      const [type, side] = TOKENS[tok];
      const n = { type, side, beat: cursor + at, opt: false, act: 'awaken', section: sec.id, waitFor: !!wait };
      n.id = 0; n.teleBeats = AWAKEN.tele;
      n.travel = type === 'brute' ? AWAKEN.travel + 2 : type === 'core' ? AWAKEN.travel + 1 : AWAKEN.travel;
      n.spawnBeat = n.beat - n.travel;
      n.move = MOVE_OF[type];
      if (type === 'core') n.hover = 8;
      notes.push(n);
    }
    cursor += sec.len;
  }
  return { notes, endBeat: cursor };
}

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

/** Upper-body-only substitution: no kicks or jumps (small rooms). Seated also turns ducks into leans. */
export function upperOnly(n, flip, seated = false) {
  if (n.type === 'crawler') { n.type = 'striker'; return n; }
  if (n.type === 'sweep' || (seated && n.type === 'scythe')) { n.type = 'volley'; n.side = flip ? 'left' : 'right'; return n; }
  return n;
}

/**
 * Incremental chart for one act. gen.update(beatNow, skill) appends phrases until `horizon` beats ahead.
 * Notes are pushed into the `out` array given to the constructor (consumers drain it).
 */
export class ActChart {
  constructor({ act, startBeat, settings, seed = 1, out = [] }) {
    const base = ACTS[act];
    this.demo = isDemo(settings) && !!base.demo;
    this.cfg = this.demo ? { ...base, ...base.demo } : base;
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
    this.teachIdx = 0;                              // teach bars emitted so far
    this.strikers = 0;
    this.types = {};                                // kept notes per type (variety rules)
    this.converted = 0;
    this.upper = !!(settings.upperBodyOnly || settings.seated);
    this.seated = !!settings.seated;
  }
  /** Beat the act's last note resolves (for transitions). */
  get lastBeat() { return this.last ? this.last.beat + (this.last.type === 'core' ? 8 : this.last.type === 'brute' ? 3 : 0) : this.cursor; }

  update(beatNow, skill = 0.7) {
    const horizon = beatNow + this.cfg.travel + 10;
    const fin = this.cfg.finale;
    while (!this.done && this.cursor < horizon) {
      const remaining = (this.endBeat - this.cursor) / 4;
      let bars;
      if (this.teachIdx < this.cfg.teach.length) {          // fixed teaching phrases, 2 bars at a time
        bars = this.cfg.teach.slice(this.teachIdx, this.teachIdx + 2);
        this.teachIdx += bars.length;
        this._emit(bars, skill, true);
        this.phraseIdx++;
        continue;
      }
      if (this.phraseIdx === this._reactAt() && remaining > fin.length + 4) { this._reaction(); this.phraseIdx++; continue; }
      if (remaining < fin.length + 2) bars = fin;
      else bars = this._pick(skill).bars;
      if (bars !== fin && remaining - bars.length < fin.length) bars = fin;
      this._emit(bars, skill, bars === fin);
      this.phraseIdx++;
      if (bars === fin) this.done = true;
    }
  }
  /** Phrase index of the reaction-test rest (right after the teaching phrases + 2). */
  _reactAt() { return Math.ceil(this.cfg.teach.length / 2) + 2; }

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

  _emit(bars, skill, fixed = false) {
    this._skill = skill;
    const density = this.settings.adaptive ? Math.min(1, Math.max(0.15, 0.2 + skill * 0.9)) : 0.75;
    for (let b = 0; b < bars.length; b++) {
      for (const s of parseBar(bars[b])) {
        if (s.opt && this.rand() > density) continue;
        const n = { type: s.type, side: s.side, beat: this.cursor + b * 4 + s.at, opt: s.opt };
        if (this.upper) { upperOnly(n, this.flip, this.seated); this.flip = !this.flip; }
        // density ceiling (notes / min): pool notes past it are dropped (never the teaching block or the finale core)
        if (!fixed && this.count >= this._allowed(n.beat)) continue;
        // caps: an optional striker / kick over its cap is dropped, a fixed one is converted to another move of this
        // act (spread by the variety rules, kicks never over KICK_CAP), or dropped when nothing fits
        if (!fixed && this.count >= 5 && this._over(n.type)) {
          if (n.opt || !this._convert(n)) continue;
        }
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

  /** Notes allowed up to `beat` by the act's density ceiling (cfg.npm notes / min at 128 bpm, plus a small slack). */
  _allowed(beat) {
    const npm = (this.cfg.npm ?? 60) * (0.82 + 0.18 * Math.min(1, Math.max(0, this._skill ?? 0.7) / 0.9));
    return 3 + Math.max(0, beat - this.startBeat) * (npm / 128);
  }
  /** Would one more note of this type break its cap? */
  _over(type) {
    const c = this.count + 1;
    if (type === 'striker') return (this.strikers + 1) / c > STRIKER_CAP;
    if (type === 'crawler') return ((this.types.crawler || 0) + 1) / c > KICK_CAP;
    return false;
  }
  /**
   * Convert an over-cap note into another move of this act (cfg.convert, filtered for upper-body / seated play).
   * Variety rules: never a type over its cap, never the same type as either of the last two kept notes, never a move
   * the fairness rules reject right here; among the rest the least used type wins. Returns false when nothing fits.
   */
  _convert(n) {
    let pool = this.cfg.convert ?? ['scythe', 'sweep'];
    if (this.upper) pool = pool.filter((t) => t === 'volley' || (t === 'scythe' && !this.seated));
    if (this.upper && !pool.includes('volley')) pool = [...pool, 'volley'];
    const recent = [this.last?.type, this._prevType];
    let best = null, bestUse = Infinity;
    const side0 = n.side;
    for (const t of pool) {
      if (t === n.type || recent.includes(t) || this._over(t)) continue;
      const cand = { ...n, type: t, side: t === 'volley' ? (side0 === 'left' ? 'right' : 'left') : t === 'crawler' ? side0 : 'center' };
      if (this.act < 2) cand.beat = Math.round(cand.beat);
      if (!fair(this.last, cand, this.act)) continue;
      const use = (this.types[t] || 0) * (t === 'sweep' ? 1.6 : 1) + pool.indexOf(t) * 0.3 + this.rand() * 0.5;
      if (use < bestUse) { bestUse = use; best = cand; }
    }
    if (!best || this.rand() < (this.cfg.rest ?? 0)) return false;
    n.type = best.type; n.side = best.side; n.converted = true;
    this.converted++;
    return true;
  }

  _push(n) {
    const c = this.cfg;
    n.id = 0; n.act = this.act;
    n.teleBeats = c.tele;
    n.travel = n.type === 'brute' ? c.travel + 2 : n.type === 'core' ? c.travel + 1 : c.travel;
    n.spawnBeat = n.beat - n.travel;
    n.move = MOVE_OF[n.type];
    if (n.type === 'core') n.hover = 8;
    this._prevType = this.last?.type;
    this.last = n; this.count++;
    if (n.type === 'striker') this.strikers++;
    this.types[n.type] = (this.types[n.type] || 0) + 1;
    this.out.push(n);
  }
}

/** One reaction-test "flash" striker per act: unannounced, appears on the spot; judged on reaction time, not the beat. */
export function reactionNote(act, beat, side) {
  return { type: 'striker', side, beat, spawnBeat: beat, teleBeats: 0, travel: 0, act, react: true, move: 'punch', opt: false };
}
