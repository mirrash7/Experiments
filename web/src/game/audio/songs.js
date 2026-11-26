// BREAKLIGHT soundtrack: four original procedural songs at 128 BPM (synthwave × drum-and-bass hybrid).
// Every song is a loop of N bars on the 16th-note grid; the sequencer calls `step()` for each 16th.
// Instruments are persistent (created once per song), so playing notes only automates AudioParams.

import {
  STEP, BEAT, BAR, rng, makeOut, makeKit, Mono, Pad, Air,
  kick, snare, hat, shaker, ride, clap, crash, tom, riser, impact, bell,
} from './engine.js';

// [step, midi, lengthInSteps] per bar → 16-slot lookup tables
function seqMap(bars) {
  return bars.map((evs) => {
    const m = new Array(16).fill(null);
    for (const [s, n, l] of evs) m[s] = [n, l];
    return m;
  });
}
const tones5 = (ch, up = 0) => [ch[0] + up, ch[1] + up, ch[2] + up, ch[3] + up, ch[0] + 12 + up];

class Song {
  constructor(G, id, startStep, st, opt = {}) {
    this.G = G;
    this.id = id;
    this.startStep = startStep;
    this.R = rng(0x5eed + id.length * 977);
    this.out = makeOut(G, { drumDrive: opt.drumDrive || 0, drumGain: opt.drumGain ?? 0.65 });
    this.layers = {};
    this.insts = [];
    this.stopAt = null;
    this.bars = opt.bars || 8;
    this.cut = opt.cut ?? 20000;
    this.duck = opt.duck ?? 0.45;
    this.odAmt = opt.odAmt ?? 1;
    // overdrive layer: gated supersaw arpeggio through a swept band-pass
    this.odG = new GainNode(G.ctx, { gain: 0 });
    this.odG.connect(this.out.dry);
    this.out.nodes.push(this.odG);
    this.odOn = !!st.od;
    this.odWas = false;
    this.od = this.inst(new Mono(G, { dry: this.odG, rev: this.out.rev, dly: this.out.dly }, {
      oscs: [{ detune: -12 }, { detune: 12 }, { type: 'square', semi: 12, gain: 0.45 }],
      ftype: 'bandpass', cut: 1900, q: 3.5, flfo: { rate: 1 / (BEAT * 2), depth: 1300 },
      env: { a: 0.002, d: 0.09, s: 0.25, r: 0.05 }, level: 0.7 * this.odAmt, spread: 0.5, dly: 0.25, rev: 0.15,
    }));
  }
  inst(i) { this.insts.push(i); return i; }
  solo(name) { return this.G.solo && this.G.solo !== name ? 0 : 1; } // offline stem analysis only
  dest(name, thr) {
    const g = new GainNode(this.G.ctx, { gain: 0 });
    g.connect(this.out.dry);
    this.out.nodes.push(g);
    this.layers[name] = { g, thr, on: false, was: false };
    return { dry: g, rev: this.out.rev, dly: this.out.dly };
  }
  on(name) { const L = this.layers[name]; return L.on || L.was; }
  start(t, st) {
    for (const i of this.insts) i.start(t);
    for (const k in this.layers) {
      const L = this.layers[k];
      L.on = st.inten >= L.thr - 1e-6;
      L.was = false;
      L.g.gain.setValueAtTime(L.on ? this.solo(k) : 0, t);
    }
    this.odG.gain.setValueAtTime(this.odOn ? this.solo('od') : 0, t);
    if (this.G.solo && this.G.solo !== 'drums') this.out.drums.gain.setValueAtTime(0, t);
    if (this.kit) this.kit.duckDepth = this.duck;
  }
  bar(n, t, st) {
    for (const k in this.layers) {
      const L = this.layers[k];
      const on = st.inten >= L.thr - 1e-6;
      L.was = L.on;
      if (on !== L.on) L.g.gain.setTargetAtTime(on ? this.solo(k) : 0, t, on ? BEAT * 0.35 : BEAT * 0.5);
      L.on = on;
    }
    this.odWas = false; // an overdrive fade-out lasts < 1 bar
  }
  setOd(t, on) {
    this.odWas = this.odOn;
    this.odOn = on;
    this.odG.gain.setTargetAtTime(on ? this.solo('od') : 0, t, on ? 0.04 : BEAT * 0.4);
  }
  // shared overdrive pattern, driven by the song's current chord
  odStep(t, s, chord) {
    if (!this.odOn && !this.odWas) return;
    const idx = OD_IDX[s];
    this.od.note(t, chord[idx % 4] + (idx >= 4 ? 36 : 24), STEP * 0.55, s % 4 === 0 ? 1 : 0.72);
    if (this.kit && this.odOn) shaker(this.kit, t, s % 2 ? 0.5 : 0.8);
  }
  tick(t) { for (const i of this.insts) i.flush(t); }
  end(t, fadeTc = 0.03) {
    this.out.fade(t, fadeTc);
    for (const i of this.insts) i.stop(t + fadeTc * 10 + 0.05);
  }
  dispose() {
    for (const i of this.insts) i.dispose();
    this.out.dispose();
  }
  pos(n) {
    const sp = n - this.startStep;
    const s = ((sp % 16) + 16) % 16;
    const bar = ((Math.floor(sp / 16) % this.bars) + this.bars) % this.bars;
    return [s, bar];
  }
}
const OD_IDX = [0, 2, 1, 3, 0, 2, 1, 3, 1, 3, 2, 4, 2, 4, 3, 1];

// ================================================================= RUN — A minor, driving
const RUN_CH = [[57, 60, 64, 71], [53, 57, 60, 67], [55, 60, 64, 71], [55, 59, 62, 69],
  [57, 60, 64, 71], [53, 57, 60, 67], [55, 59, 62, 67], [56, 59, 64, 68]];
const RUN_ROOT = [33, 29, 36, 31, 33, 29, 31, 28];
const RUN_LEAD = seqMap([
  [[0, 76, 4], [4, 81, 2], [6, 79, 2], [8, 76, 4], [12, 74, 2], [14, 76, 2]],
  [[0, 72, 6], [6, 74, 2], [8, 76, 6], [14, 72, 2]],
  [[0, 79, 4], [4, 76, 2], [6, 79, 2], [8, 84, 4], [12, 83, 4]],
  [[0, 83, 6], [6, 81, 2], [8, 79, 4], [12, 74, 4]],
  [[0, 76, 4], [4, 81, 2], [6, 83, 2], [8, 84, 4], [12, 83, 2], [14, 81, 2]],
  [[0, 81, 6], [6, 79, 2], [8, 77, 4], [12, 81, 4]],
  [[0, 79, 4], [4, 83, 4], [8, 86, 6], [14, 84, 2]],
  [[0, 83, 8], [8, 80, 4], [12, 76, 4]],
]);
const RUN_T = RUN_CH.map((c) => tones5(c, 12));
const RUN_ARP = [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 3, 2, 1, 2, 3];
const RK_0 = [0, 10], RK_A = [0, 6, 10], RK_B = [0, 3, 10];
const GALLOP = [0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 12, 12, 0];

class RunSong extends Song {
  constructor(G, id, ss, st) {
    super(G, id, ss, st, { bars: 16, duck: 0.5, drumGain: 0.6 });
    this.kit = makeKit(G, this.out, {
      kick: { f0: 165, f1: 47, pt: 0.09, dec: 0.36, lvl: 1, click: 0.35 },
      snare: { tone: 190, toneLvl: 0.45, noiseLvl: 0.6, dec: 0.16 }, hatLvl: 0.5, duck: 0.5,
    });
    this.pad = this.inst(new Pad(G, this.dest('pads', 0), {
      detunes: [-12, 0, 12], cut: 1500, q: 1, level: 0.9, rev: 0.4, spread: 0.7,
    }));
    this.bass = this.inst(new Mono(G, this.dest('bass', 0), {
      oscs: [{ detune: -7 }, { type: 'square', detune: 7, gain: 0.5 }, { type: 'sine', gain: 0.9 }],
      cut: 380, famt: 1500, fdec: 0.12, q: 4, env: { a: 0.003, d: 0.14, s: 0.55, r: 0.04 }, level: 0.5,
    }));
    this.arp = this.inst(new Mono(G, this.dest('arp', 0.25), {
      oscs: [{ type: 'square', detune: -6 }, { detune: 6 }], cut: 1100, famt: 2600, fdec: 0.1, q: 3,
      env: { a: 0.002, d: 0.11, s: 0.15, r: 0.05 }, level: 0.34, spread: 0.45, dly: 0.35, rev: 0.15,
    }));
    this.lead = this.inst(new Mono(G, this.dest('lead', 0.5), {
      oscs: [{ detune: -16 }, { detune: -8 }, { detune: 0 }, { detune: 8 }, { detune: 16 }, { semi: 12, gain: 0.35 }],
      cut: 3000, famt: 2200, fdec: 0.3, q: 1.2, env: { a: 0.012, d: 0.3, s: 0.75, r: 0.18 }, glide: 0.025,
      vib: { rate: 5.3, cents: 9 }, level: 0.4, spread: 0.55, rev: 0.32, dly: 0.24,
    }));
    this.dest('fx', 0.75);
    this.chordAt = (bar) => RUN_CH[bar % 8];
  }
  step(n, t, st) {
    const [s, bar] = this.pos(n);
    const ch = bar % 8, chord = RUN_CH[ch], root = RUN_ROOT[ch], I = st.inten, R = this.R, k = this.kit;
    if (s === 0) {
      this.pad.chord(t, chord);
      this.pad.hold(t, 1, 0.25);
      this.pad.setCut(t, 1100 + I * 2600);
      this.arp.setCut(t, 900 + I * 2400);
    }
    // drums
    const mid = I >= 0.25, hi = I >= 0.75;
    const fill = (ch === 7 && s >= 12) || (hi && bar === 15 && s >= 8);
    const kicks = hi ? (bar % 2 ? RK_B : RK_A) : RK_0;
    if (kicks.includes(s) && !(fill && s >= 12)) kick(k, t, s === 0 ? 1 : 0.92);
    if (fill) snare(k, t, 0.3 + 0.7 * ((s - 8) / 7) * (0.9 + R() * 0.1));
    else if (s === 4 || s === 12) snare(k, t, 1);
    else if (mid && (s === 7 || s === 15 || (hi && s === 9))) snare(k, t, 0.14 + R() * 0.08);
    if (s % 2 === 0) hat(k, t, s % 4 === 2 ? 0.95 : 0.6, hi && s === 14);
    else if (mid) hat(k, t, 0.26 + R() * 0.12);
    if (ch === 0 && s === 0 && (I >= 0.5 || bar === 0)) crash(k, t, 0.9);
    // bass
    if (I < 0.5) {
      if (s % 2 === 0) this.bass.note(t, root + (s === 6 || s === 14 ? 12 : 0), STEP * 1.5, s % 4 === 0 ? 1 : 0.8);
    } else this.bass.note(t, root + GALLOP[s], STEP * 0.7, s % 4 === 0 ? 1 : 0.78);
    // arp
    if (this.on('arp')) this.arp.note(t, RUN_T[ch][RUN_ARP[s]], STEP * 0.6, s % 4 === 0 ? 1 : 0.7);
    // lead (+ octave layer at high intensity)
    if (s === 0) this.lead.oscs[5].og.gain.setTargetAtTime(I >= 0.85 ? 0.1 : 0, t, 0.2);
    if (this.on('lead')) { const e = RUN_LEAD[ch][s]; if (e) this.lead.note(t, e[0], e[1] * STEP * 0.92, 1); }
    // fx: riser into each 8-bar phrase, impact on the downbeat
    if (this.on('fx') && s === 0) {
      if (ch === 6) riser(this.G, this.out, t, BAR * 2, 1.6);
      if (ch === 0) impact(this.G, this.out, t, 1);
    }
    this.odStep(t, s, chord);
  }
}

// ================================================================= BOSS — C# minor / phrygian, heavy
const BOSS_CH = [[49, 56, 61, 64], [49, 56, 61, 64], [45, 52, 57, 61], [50, 57, 62, 66],
  [49, 56, 61, 64], [49, 56, 61, 64], [47, 54, 59, 63], [44, 51, 56, 60]];
const BOSS_ROOT = [37, 37, 33, 38, 37, 37, 35, 32];
const RA = [[0, 73, 2], [2, 73, 1], [3, 74, 2], [5, 73, 2], [8, 76, 2], [10, 74, 2], [12, 73, 2], [14, 71, 2]];
const RB = [[0, 68, 3], [3, 69, 3], [6, 68, 2], [8, 73, 6], [14, 74, 2]];
const BOSS_RIFF = seqMap([RA, RB, RA, RB, RA, RB,
  [[0, 78, 3], [3, 75, 3], [6, 78, 2], [8, 83, 6], [14, 82, 2]],
  [[0, 80, 4], [4, 84, 4], [8, 87, 4], [12, 84, 4]]]);
const REESE = [[0, 3], [3, 3], [6, 4], [10, 2], [12, 4]];
const REESE_FILL = [[0, 2], [2, 2], [4, 2], [6, 2], [8, 4], [12, 4]];
const toMap = (p) => { const m = new Array(16).fill(0); for (const [s, l] of p) m[s] = l; return m; };
const REESE_M = toMap(REESE), REESE_FM = toMap(REESE_FILL);
const STABS = [0, 3, 6];
const BK_FA = [0, 10], BK_FB = [0, 7, 10], BK_HA = [0, 10, 13], BK_HB = [0, 3, 10];
const BOSS_T = BOSS_CH.map((c) => tones5(c, 12));
const TOMS = { 8: 220, 10: 196, 12: 165, 13: 147, 14: 131, 15: 110 };

class BossSong extends Song {
  constructor(G, id, ss, st) {
    super(G, id, ss, st, { bars: 8, duck: 0.55, drumDrive: 2.2, drumGain: 0.5 });
    this.kit = makeKit(G, this.out, {
      kick: { f0: 175, f1: 41, pt: 0.11, dec: 0.5, lvl: 1, click: 0.45 },
      snare: { tone: 170, toneLvl: 0.55, noiseLvl: 0.7, dec: 0.24 }, snareBP: 1600, snareRev: 0.45, hatLvl: 0.45, duck: 0.55,
    });
    this.pad = this.inst(new Pad(G, this.dest('pads', 0), {
      detunes: [-15, 0, 15], cut: 700, q: 2, level: 0.85, rev: 0.45, flfo: { rate: 0.11, depth: 250 },
    }));
    this.air = this.inst(new Air(G, this.dest('air', 0), { freq: 500, q: 2, level: 0.035, rate: 0.05, depth: 300 }));
    this.reese = this.inst(new Mono(G, this.dest('bass', 0), {
      oscs: [{ detune: -18 }, { detune: 18 }, { type: 'sine', semi: -12, gain: 1.3 }],
      cut: 420, famt: 900, fdec: 0.25, q: 5, flfo: { rate: 1 / (BEAT * 2), depth: 220 }, drive: 2,
      env: { a: 0.005, d: 0.3, s: 0.8, r: 0.07 }, level: 0.3,
    }));
    this.bellDest = this.dest('bell', 0.25);
    this.lead = this.inst(new Mono(G, this.dest('lead', 0.5), {
      oscs: [{ type: 'square', detune: -6 }, { detune: 6 }, { type: 'square', semi: -12, gain: 0.4 }],
      cut: 2200, famt: 2400, fdec: 0.14, q: 2, env: { a: 0.003, d: 0.15, s: 0.55, r: 0.07 }, glide: 0.01,
      level: 0.32, spread: 0.3, dly: 0.18, rev: 0.22,
    }));
    this.stab = this.inst(new Pad(G, this.dest('stabs', 0.75), {
      detunes: [-12, 0, 12], cut: 2600, q: 1.5, level: 1.0, env: { a: 0.003, d: 0.18, s: 0.25, r: 0.12 }, rev: 0.3,
    }));
    this.chordAt = (bar) => BOSS_CH[bar % 8];
  }
  start(t, st) { super.start(t, st); this.pad.hold(t, 1, 0.6); }
  step(n, t, st) {
    const [s, bar] = this.pos(n);
    const ch = bar % 8, chord = BOSS_CH[ch], root = BOSS_ROOT[ch], I = st.inten, R = this.R, k = this.kit;
    if (s === 0) { this.pad.chord(t, chord, 0.02); this.pad.setCut(t, 600 + I * 900); this.pad.hold(t, 1, 0.3); }
    const full = I >= 0.75;
    const fill = ch === 7 && s >= 8;
    // drums: half-time heavy below 0.75, full-time DnB two-step above
    if (!fill) {
      const kicks = full ? (bar % 2 ? BK_FB : BK_FA) : (bar % 2 ? BK_HB : BK_HA);
      if (kicks.includes(s)) kick(k, t, s === 0 ? 1 : 0.9);
      if (full ? s === 4 || s === 12 : s === 8) { snare(k, t, 1); clap(k, t, 0.6); }
      else if (full ? s === 9 || s === 15 : s === 14 || (bar % 2 && s === 5)) snare(k, t, 0.15 + R() * 0.08);
    } else {
      if (s === 8) kick(k, t, 1);
      if (TOMS[s]) tom(k, t, TOMS[s], 0.9);
      if (s >= 14) snare(k, t, 0.6 + (s - 14) * 0.3);
    }
    if (s % 2 === 0) hat(k, t, full ? 0.75 : 0.55); else hat(k, t, 0.22 + R() * 0.1);
    if (I >= 0.5 && s % 4 === 0) ride(k, t, s === 0 ? 1 : 0.7);
    if (ch === 0 && s === 0) crash(k, t, 1);
    // reese bass
    const rl = (ch === 7 ? REESE_FM : REESE_M)[s];
    if (rl) this.reese.note(t, root + (ch === 7 && s === 12 ? 12 : 0), rl * STEP * 0.95, s === 0 ? 1 : 0.85);
    // tolling bell every 2 bars
    if (this.on('bell') && s === 0 && bar % 2 === 0) bell(this.G, this.bellDest, t, root + 24, { ratio: 2.76, index: 3, indexTc: 0.4, dur: 3.2, lvl: 0.26, rev: 0.6 });
    // lead riff
    if (this.on('lead')) { const e = BOSS_RIFF[ch][s]; if (e) this.lead.note(t, e[0], e[1] * STEP * 0.85, s % 4 === 0 ? 1 : 0.85); }
    // brass stabs
    if (this.on('stabs') && ch !== 7 && STABS.includes(s)) { this.stab.chord(t, BOSS_T[ch]); this.stab.gate(t, STEP * 1.3, s === 0 ? 1 : 0.8); }
    this.odStep(t, s, chord);
  }
}

// ================================================================= TITLE — D dorian, chill + atmospheric
const TITLE_CH = [[53, 57, 60, 64], [50, 53, 57, 60], [52, 57, 60, 64], [50, 55, 60, 64]];
const TITLE_ROOT = [38, 34, 41, 36];
const TITLE_T = TITLE_CH.map((c) => tones5(c, 12));
const TITLE_ARP = [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 4, 3, 1, 3, 2, 4];
const TITLE_MEL = seqMap([
  [[0, 76, 6], [6, 77, 2], [8, 72, 8]],
  [[0, 69, 4], [4, 72, 4], [8, 76, 8]],
  [[0, 74, 6], [6, 76, 2], [8, 79, 8]],
  [[0, 76, 12], [12, 74, 4]],
]);

class TitleSong extends Song {
  constructor(G, id, ss, st) {
    super(G, id, ss, st, { bars: 16, duck: 0.18, cut: 14000, odAmt: 0.5, drumGain: 0.7 });
    this.kit = makeKit(G, this.out, {
      kick: { f0: 115, f1: 44, pt: 0.1, dec: 0.32, lvl: 0.6, click: 0 },
      snare: { tone: 330, toneLvl: 0.3, noiseLvl: 0.12, dec: 0.06 }, snareBP: 2600, snareRev: 0.6, hatLvl: 0.26, duck: 0.18,
    });
    this.pad = this.inst(new Pad(G, this.dest('pads', 0), {
      detunes: [-9, 0, 9], cut: 1100, q: 1.5, level: 0.95, rev: 0.6, flfo: { rate: 0.06, depth: 450 }, spread: 0.8,
    }));
    this.air = this.inst(new Air(G, this.dest('air', 0), { freq: 1400, q: 1.2, level: 0.03, rate: 0.045, depth: 900 }));
    this.sub = this.inst(new Mono(G, this.dest('bass', 0), {
      oscs: [{ type: 'sine' }, { type: 'triangle', gain: 0.3 }], cut: 600, env: { a: 0.08, d: 0.6, s: 0.9, r: 0.6 }, level: 0.12,
    }));
    this.arpDest = this.dest('arp', 0);
    this.mel = this.inst(new Mono(G, this.dest('lead', 0), {
      oscs: [{ type: 'triangle' }, { type: 'sine', semi: 12, gain: 0.3 }], cut: 3200, q: 0.5,
      env: { a: 0.06, d: 0.4, s: 0.8, r: 0.45 }, vib: { rate: 5, cents: 12 }, glide: 0.04, level: 0.28, rev: 0.55, dly: 0.35,
    }));
    this.chordAt = (bar) => TITLE_CH[(bar >> 1) % 4];
  }
  start(t, st) { super.start(t, st); this.pad.hold(t, 1, 1.2); }
  step(n, t) {
    const [s, bar] = this.pos(n);
    const ci = (bar >> 1) % 4, chord = TITLE_CH[ci], k = this.kit, R = this.R;
    if (s === 0 && bar % 2 === 0) { this.pad.chord(t, chord, 0.08); this.sub.note(t, TITLE_ROOT[ci], BAR * 2 - STEP, 1); }
    if (s % 2 === 0) {
      const tn = TITLE_T[ci][TITLE_ARP[(s >> 1) + (bar % 2) * 8]];
      bell(this.G, this.arpDest, t, tn, { ratio: 2, index: 1.6, indexTc: 0.08, dur: 1.1, lvl: s % 8 === 0 ? 0.17 : 0.12, rev: 0.35, dly: 0.5 });
    }
    if (bar >= 4) {
      if (s === 0 || s === 8 || (bar % 2 && s === 11)) kick(k, t, s === 11 ? 0.6 : 1);
      if (s === 12) snare(k, t, 0.9);
      if (s % 4 === 2) hat(k, t, 0.9 + R() * 0.1);
      else if (s % 2) shaker(k, t, 0.35 + R() * 0.15);
    }
    if (bar >= 12) { const e = TITLE_MEL[bar - 12][s]; if (e) this.mel.note(t, e[0], e[1] * STEP * 0.95, 0.9); }
    this.odStep(t, s, chord);
  }
}

// ================================================================= RESULTS — D major, triumphant + calm
const RES_CH = [[54, 57, 62, 66], [52, 57, 61, 64], [54, 59, 62, 66], [55, 59, 62, 67],
  [55, 59, 64, 67], [55, 59, 62, 67], [52, 57, 61, 64], [52, 57, 62, 64]];
const RES_ROOT = [38, 37, 35, 31, 40, 31, 33, 33];
const RES_LEAD = seqMap([
  [[0, 78, 8], [8, 81, 4], [12, 86, 4]],
  [[0, 88, 8], [8, 85, 4], [12, 81, 4]],
  [[0, 86, 6], [6, 85, 2], [8, 83, 8]],
  [[0, 79, 4], [4, 81, 4], [8, 83, 4], [12, 86, 4]],
  [[0, 88, 8], [8, 86, 4], [12, 83, 4]],
  [[0, 86, 6], [6, 83, 2], [8, 79, 8]],
  [[0, 81, 4], [4, 85, 4], [8, 88, 8]],
  [[0, 88, 12]],
]);
const RES_BELL = [0, 1, 2, 3, 4, 3, 2, 1];
const RES_A = [52, 57, 61, 64];
const RES_T = RES_CH.map((c) => tones5(c, 12));
const RES_AT = tones5(RES_A, 12);

class ResultsSong extends Song {
  constructor(G, id, ss, st) {
    super(G, id, ss, st, { bars: 16, duck: 0.25, odAmt: 0.6, drumGain: 0.75 });
    this.kit = makeKit(G, this.out, {
      kick: { f0: 130, f1: 45, pt: 0.1, dec: 0.42, lvl: 0.8, click: 0.15 },
      snare: { tone: 200, toneLvl: 0.3, noiseLvl: 0.4, dec: 0.15 }, hatLvl: 0.3, duck: 0.25,
    });
    this.pad = this.inst(new Pad(G, this.dest('pads', 0), { detunes: [-10, 0, 10], cut: 2200, q: 0.8, level: 0.8, rev: 0.5 }));
    this.bass = this.inst(new Mono(G, this.dest('bass', 0), {
      oscs: [{ detune: -5 }, { type: 'sine', gain: 1.2 }], cut: 480, famt: 350, fdec: 0.3,
      env: { a: 0.01, d: 0.4, s: 0.7, r: 0.2 }, level: 0.24,
    }));
    this.bellDest = this.dest('arp', 0);
    this.horn = this.inst(new Mono(G, this.dest('lead', 0), {
      oscs: [{ detune: -10 }, { detune: -4 }, { detune: 4 }, { detune: 10 }], cut: 1700, famt: 1300, fdec: 0.45, q: 0.8,
      env: { a: 0.05, d: 0.4, s: 0.8, r: 0.35 }, glide: 0.03, vib: { rate: 5, cents: 8 }, level: 0.34, spread: 0.5, rev: 0.45, dly: 0.2,
    }));
    this.chordAt = (bar) => RES_CH[bar % 8];
  }
  start(t, st) { super.start(t, st); this.pad.hold(t, 1, 0.8); }
  step(n, t) {
    const [s, bar] = this.pos(n);
    const ch = bar % 8, chord = RES_CH[ch], root = RES_ROOT[ch], k = this.kit, R = this.R;
    if (s === 0) this.pad.chord(t, chord, 0.03);
    if (ch === 7 && s === 8) this.pad.chord(t, RES_A, 0.03); // sus4 → A
    if (s === 0) this.bass.note(t, root, STEP * 7, 1);
    else if (s === 8) this.bass.note(t, root, STEP * 4, 0.85);
    else if (s === 12) this.bass.note(t, root + 7, STEP * 3, 0.75);
    if (s % 2 === 0) {
      const tt = ch === 7 && s >= 8 ? RES_AT : RES_T[ch];
      bell(this.G, this.bellDest, t, tt[RES_BELL[s >> 1]], { ratio: 3.5, index: 2.2, indexTc: 0.15, dur: 1.4, lvl: s % 8 === 0 ? 0.12 : 0.08, rev: 0.45, dly: 0.3 });
    }
    if (s === 0 || s === 11) kick(k, t, s === 0 ? 1 : 0.6);
    if (s === 8) { clap(k, t, 0.55); snare(k, t, 0.5); }
    if (s % 2 === 0) hat(k, t, s % 4 === 2 ? 0.9 : 0.5); else shaker(k, t, 0.3 + R() * 0.1);
    if (ch === 0 && s === 0) crash(k, t, 0.6);
    if (bar >= 8) { const e = RES_LEAD[ch][s]; if (e) this.horn.note(t, e[0], e[1] * STEP * 0.95, 0.95); }
    this.odStep(t, s, chord);
  }
}

export const SONGS = { title: TitleSong, run: RunSong, boss: BossSong, results: ResultsSong };
