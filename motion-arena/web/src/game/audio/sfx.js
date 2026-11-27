// BREAKLIGHT synthesized sound effects (anime-action style). One-shot voices are short-lived node
// clusters behind a per-instance gain (+ optional panner and reverb send); voice limiting steals the oldest.

import { mtof, driveCurve } from './engine.js';

// --- tiny builders (X = { c, G, t, p, out, rev, v }) ---------------------------------------------
function O(X, type, f, t0, t1, dest) {
  const o = new OscillatorNode(X.c, { type, frequency: f });
  o.connect(dest);
  o.start(t0);
  o.stop(t1);
  X.v.srcs.push(o);
  X.G.track(o);
  return o;
}
function N(X, t0, dur, dest, rate = 1) {
  const s = new AudioBufferSourceNode(X.c, { buffer: X.G.noise, playbackRate: rate });
  if (dur > 1.2) { s.loop = true; s.start(t0, X.G.R() * 1.5); s.stop(t0 + dur); }
  else s.start(t0, X.G.R() * 0.75, dur);
  s.connect(dest);
  X.v.srcs.push(s);
  X.G.track(s);
  return s;
}
function Gn(X, g, dest) { const n = new GainNode(X.c, { gain: g }); n.connect(dest); return n; }
function F(X, type, f, q, dest) { const n = new BiquadFilterNode(X.c, { type, frequency: f, Q: q }); n.connect(dest); return n; }
// attack/decay envelope; `d` ≈ time to -35 dB
function env(param, t, a, peak, d) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(0, t + a, d / 4);
  return t + a + d;
}
function sweep(param, t, f0, f1, dur) {
  param.setValueAtTime(f0, t);
  param.exponentialRampToValueAtTime(f1, t + dur);
}
// tonal blip: osc pair (fundamental + octave sparkle) with an env, into X.out (+ reverb send)
function chime(X, t, midi, d, peak, type = 'sine') {
  const f = mtof(midi) * X.p;
  const g = Gn(X, 0, X.out);
  env(g.gain, t, 0.003, peak, d);
  O(X, type, f, t, t + d + 0.05, g);
  const g2 = Gn(X, 0.25, g);
  O(X, 'sine', f * 2.003, t, t + d + 0.05, g2);
  return t + d;
}

// --- definitions: each returns its end time ------------------------------------------------------
const DEFS = {
  whoosh(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const f = F(X, 'bandpass', 500 * p, 1.6, g);
    N(X, t, 0.36, f);
    f.frequency.setValueAtTime(320 * p, t);
    f.frequency.exponentialRampToValueAtTime(2700 * p, t + 0.12);
    f.frequency.exponentialRampToValueAtTime(650 * p, t + 0.32);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.1, t + 0.09);
    g.gain.setTargetAtTime(0, t + 0.11, 0.06);
    return t + 0.4;
  },
  punchHit(X) {
    const { t, p } = X;
    const gb = Gn(X, 0, X.out);
    const b = O(X, 'sine', 220 * p, t, t + 0.3, gb);
    sweep(b.frequency, t, 240 * p, 52 * p, 0.12);
    env(gb.gain, t, 0.002, 1.0, 0.2);
    const gk = Gn(X, 0, X.out);
    const lp = F(X, 'lowpass', 2200, 1, gk);
    const k = O(X, 'square', 420 * p, t, t + 0.08, lp);
    sweep(k.frequency, t, 420 * p, 110 * p, 0.05);
    env(gk.gain, t, 0.001, 0.32, 0.06);
    const gc = Gn(X, 0, X.out);
    N(X, t, 0.08, F(X, 'highpass', 1800, 0.7, gc));
    env(gc.gain, t, 0.001, 0.75, 0.06);
    return t + 0.32;
  },
  kickHit(X) {
    const { t, p } = X;
    const gb = Gn(X, 0, X.out);
    const b = O(X, 'sine', 170 * p, t, t + 0.4, gb);
    sweep(b.frequency, t, 190 * p, 40 * p, 0.17);
    env(gb.gain, t, 0.002, 1.1, 0.28);
    const gt = Gn(X, 0, X.out);
    N(X, t, 0.12, F(X, 'lowpass', 1300, 0.8, gt));
    env(gt.gain, t, 0.001, 0.8, 0.09);
    const gw = Gn(X, 0, X.out);
    const bw = F(X, 'bandpass', 900 * p, 1.5, gw);
    N(X, t, 0.3, bw);
    sweep(bw.frequency, t, 1800 * p, 500 * p, 0.25);
    env(gw.gain, t, 0.01, 0.35, 0.22);
    return t + 0.42;
  },
  perfect(X) {
    const { t } = X;
    chime(X, t, 88, 0.5, 0.45);
    chime(X, t + 0.045, 95, 0.5, 0.4);
    chime(X, t + 0.09, 100, 0.6, 0.38, 'triangle');
    const gs = Gn(X, 0, X.out);
    N(X, t + 0.02, 0.35, F(X, 'highpass', 7000, 0.7, gs));
    env(gs.gain, t + 0.02, 0.01, 0.18, 0.28);
    return t + 0.75;
  },
  great(X) {
    const { t } = X;
    chime(X, t, 83, 0.4, 0.42);
    chime(X, t + 0.05, 88, 0.45, 0.38);
    return t + 0.55;
  },
  good(X) {
    return chime(X, X.t, 81, 0.25, 0.4, 'triangle') + 0.05;
  },
  miss(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const lp = F(X, 'lowpass', 900, 3, g);
    sweep(lp.frequency, t, 1200, 200, 0.3);
    const a = O(X, 'sawtooth', 220 * p, t, t + 0.4, lp);
    const b = O(X, 'sawtooth', 220 * p * 1.018, t, t + 0.4, lp);
    sweep(a.frequency, t, 230 * p, 70 * p, 0.28);
    sweep(b.frequency, t, 234 * p, 71 * p, 0.28);
    env(g.gain, t, 0.005, 0.5, 0.32);
    const gt = Gn(X, 0, X.out);
    const s = O(X, 'sine', 95 * p, t, t + 0.25, gt);
    sweep(s.frequency, t, 100 * p, 48 * p, 0.15);
    env(gt.gain, t, 0.002, 0.6, 0.16);
    return t + 0.42;
  },
  shatter(X) {
    const { t, p, G } = X;
    const R = G.R;
    const gn = Gn(X, 0, X.out);
    N(X, t, 0.2, F(X, 'highpass', 2600, 0.7, gn));
    env(gn.gain, t, 0.001, 0.55, 0.13);
    const gr = Gn(X, 0, X.out);
    env(gr.gain, t, 0.002, 1.6, 0.45);
    const rin = new GainNode(X.c, { gain: 1 });
    for (let i = 0; i < 4; i++) rin.connect(F(X, 'bandpass', (2300 + R() * 5200) * p, 22, gr));
    N(X, t, 0.5, rin);
    let end = t + 0.5;
    for (let i = 0; i < 6; i++) {
      const t0 = t + 0.012 + i * 0.028 + R() * 0.02;
      const d = 0.16 + R() * 0.22;
      const g = Gn(X, 0, X.out);
      env(g.gain, t0, 0.001, 0.12 + R() * 0.08, d);
      O(X, i % 2 ? 'triangle' : 'sine', (2600 + R() * 4200) * p, t0, t0 + d + 0.03, g);
      end = Math.max(end, t0 + d + 0.03);
    }
    return end;
  },
  block(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const bp = F(X, 'bandpass', 1800 * p, 2, g);
    for (const f of [310, 467, 721, 1033]) O(X, 'square', f * p, t, t + 0.35, bp);
    env(g.gain, t, 0.001, 0.75, 0.24);
    const gt = Gn(X, 0, X.out);
    N(X, t, 0.12, F(X, 'lowpass', 650, 1, gt));
    env(gt.gain, t, 0.002, 0.8, 0.09);
    const gs = Gn(X, 0, X.out);
    const s = O(X, 'sine', 150 * p, t, t + 0.18, gs);
    sweep(s.frequency, t, 160 * p, 85 * p, 0.12);
    env(gs.gain, t, 0.002, 0.6, 0.12);
    return t + 0.38;
  },
  dodge(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const bp = F(X, 'bandpass', 1200 * p, 2.2, g);
    N(X, t, 0.2, bp);
    sweep(bp.frequency, t, 1100 * p, 4800 * p, 0.14);
    env(g.gain, t, 0.03, 0.9, 0.12);
    const gw = Gn(X, 0, X.out);
    const w = O(X, 'sine', 900 * p, t, t + 0.2, gw);
    sweep(w.frequency, t, 900 * p, 1900 * p, 0.14);
    env(gw.gain, t, 0.02, 0.1, 0.12);
    return t + 0.24;
  },
  jumpOver(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const o = O(X, 'triangle', 260 * p, t, t + 0.35, g);
    sweep(o.frequency, t, 260 * p, 840 * p, 0.18);
    env(g.gain, t, 0.01, 0.35, 0.26);
    const gn = Gn(X, 0, X.out);
    const bp = F(X, 'bandpass', 800 * p, 1.8, gn);
    N(X, t, 0.3, bp);
    sweep(bp.frequency, t, 700 * p, 3800 * p, 0.2);
    env(gn.gain, t, 0.04, 0.6, 0.2);
    chime(X, t + 0.12, 91, 0.22, 0.12);
    return t + 0.4;
  },
  duckUnder(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const bp = F(X, 'bandpass', 2200 * p, 1.8, g);
    N(X, t, 0.3, bp);
    sweep(bp.frequency, t, 2400 * p, 380 * p, 0.22);
    env(g.gain, t, 0.03, 0.85, 0.2);
    const gs = Gn(X, 0, X.out);
    const s = O(X, 'sine', 300 * p, t, t + 0.28, gs);
    sweep(s.frequency, t, 320 * p, 110 * p, 0.2);
    env(gs.gain, t, 0.01, 0.4, 0.2);
    return t + 0.34;
  },
  blast(X) {
    const { t, p } = X;
    const gs = Gn(X, 0, X.out);
    const s = O(X, 'sine', 140 * p, t, t + 1.6, gs);
    sweep(s.frequency, t, 150 * p, 28 * p, 1.2);
    env(gs.gain, t, 0.005, 1.0, 1.4);
    const gn = Gn(X, 0, X.out);
    const lp = F(X, 'lowpass', 9000, 2, gn);
    sweep(lp.frequency, t, 9000, 220, 1.3);
    N(X, t, 1.6, lp);
    env(gn.gain, t, 0.01, 0.95, 1.4);
    const gc = Gn(X, 0, X.out);
    const sh = new WaveShaperNode(X.c, { curve: driveCurve(2.5), oversample: 'none' });
    sh.connect(gc);
    const lc = F(X, 'lowpass', 2400, 1.5, sh);
    sweep(lc.frequency, t, 3200, 280, 1.0);
    for (const [m, d] of [[43, -12], [50, 10], [55, -6], [43, 14]]) {
      const o = O(X, 'sawtooth', mtof(m) * p, t, t + 1.3, lc);
      o.detune.value = d;
    }
    env(gc.gain, t, 0.005, 0.32, 1.05);
    const gk = Gn(X, 0, X.out);
    N(X, t, 0.12, F(X, 'highpass', 3000, 0.7, gk));
    env(gk.gain, t, 0.001, 0.8, 0.09);
    return t + 1.65;
  },
  hurt(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const lp = F(X, 'lowpass', 1500, 2, g);
    const a = O(X, 'square', 330 * p, t, t + 0.35, lp);
    const b = O(X, 'sawtooth', 336 * p, t, t + 0.35, lp);
    sweep(a.frequency, t, 340 * p, 120 * p, 0.22);
    sweep(b.frequency, t, 346 * p, 118 * p, 0.22);
    env(g.gain, t, 0.003, 0.45, 0.28);
    const gt = Gn(X, 0, X.out);
    N(X, t, 0.15, F(X, 'lowpass', 900, 1, gt));
    env(gt.gain, t, 0.001, 0.9, 0.12);
    const gs = Gn(X, 0, X.out);
    const s = O(X, 'sine', 120 * p, t, t + 0.25, gs);
    sweep(s.frequency, t, 130 * p, 50 * p, 0.18);
    env(gs.gain, t, 0.002, 0.7, 0.18);
    return t + 0.4;
  },
  combo(X) {
    const { t } = X;
    const notes = [76, 79, 83, 88];
    let end = t;
    for (let i = 0; i < 4; i++) end = chime(X, t + i * 0.055, notes[i], 0.22 + i * 0.04, 0.26, i % 2 ? 'triangle' : 'square');
    return end + 0.05;
  },
  overdrive(X) {
    const { t, p } = X;
    const T = 0.55;
    const gr = Gn(X, 0, X.out);
    gr.gain.setValueAtTime(0, t);
    gr.gain.linearRampToValueAtTime(0.35, t + T);
    gr.gain.setTargetAtTime(0, t + T, 0.03);
    const bp = F(X, 'bandpass', 600, 2, gr);
    sweep(bp.frequency, t, 500, 8000, T);
    N(X, t, T + 0.05, bp);
    const a = O(X, 'sawtooth', 110 * p, t, t + T + 0.05, bp);
    const b = O(X, 'sawtooth', 111.5 * p, t, t + T + 0.05, bp);
    sweep(a.frequency, t, 110 * p, 880 * p, T);
    sweep(b.frequency, t, 111.5 * p, 892 * p, T);
    const t2 = t + T;
    const gc = Gn(X, 0, X.out);
    const lp = F(X, 'lowpass', 5000, 1.5, gc);
    sweep(lp.frequency, t2, 6000, 1100, 1.0);
    for (const m of [57, 64, 69, 76]) for (const d of [-9, 9]) { const o = O(X, 'sawtooth', mtof(m) * p, t2, t2 + 1.3, lp); o.detune.value = d; }
    env(gc.gain, t2, 0.005, 0.32, 1.1);
    const gk = Gn(X, 0, X.out);
    N(X, t2, 0.1, F(X, 'highpass', 2500, 0.7, gk));
    env(gk.gain, t2, 0.001, 0.6, 0.08);
    chime(X, t2 + 0.05, 93, 0.5, 0.25);
    chime(X, t2 + 0.1, 100, 0.6, 0.22);
    return t2 + 1.35;
  },
  uiHover(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    env(g.gain, t, 0.002, 0.22, 0.05);
    O(X, 'sine', 1400 * p, t, t + 0.08, g);
    const g2 = Gn(X, 0, X.out);
    env(g2.gain, t, 0.001, 0.06, 0.03);
    O(X, 'triangle', 2800 * p, t, t + 0.05, g2);
    return t + 0.1;
  },
  uiSelect(X) {
    const { t } = X;
    chime(X, t, 81, 0.12, 0.3, 'triangle');
    chime(X, t + 0.06, 88, 0.18, 0.3, 'triangle');
    const gs = Gn(X, 0, X.out);
    N(X, t + 0.06, 0.06, F(X, 'highpass', 6000, 0.7, gs));
    env(gs.gain, t + 0.06, 0.002, 0.12, 0.04);
    return t + 0.3;
  },
  countdown(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    env(g.gain, t, 0.003, 0.32, 0.18);
    O(X, 'square', 880 * p, t, t + 0.22, F(X, 'lowpass', 3000, 0.7, g));
    const g2 = Gn(X, 0, X.out);
    env(g2.gain, t, 0.002, 0.15, 0.15);
    O(X, 'sine', 1760 * p, t, t + 0.2, g2);
    return t + 0.25;
  },
  go(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const lp = F(X, 'lowpass', 6000, 1, g);
    for (const m of [72, 76, 79, 84]) for (const d of [-7, 7]) { const o = O(X, 'sawtooth', mtof(m) * p, t, t + 0.75, lp); o.detune.value = d; }
    env(g.gain, t, 0.005, 0.32, 0.6);
    const gn = Gn(X, 0, X.out);
    const bp = F(X, 'bandpass', 1000, 1.5, gn);
    sweep(bp.frequency, t, 800, 6000, 0.25);
    N(X, t, 0.3, bp);
    env(gn.gain, t, 0.02, 0.4, 0.25);
    return t + 0.8;
  },
  bossRoar(X) {
    const { t, p, c } = X;
    const D = 2.2;
    const g = Gn(X, 0, X.out);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.25);
    g.gain.setTargetAtTime(0.65, t + 0.3, 0.4);
    g.gain.setTargetAtTime(0, t + D - 0.6, 0.18);
    const sh = new WaveShaperNode(c, { curve: driveCurve(3), oversample: 'none' });
    sh.connect(g);
    const f1 = F(X, 'bandpass', 700, 6, sh);
    const f2 = F(X, 'bandpass', 1100, 7, sh);
    sweep(f1.frequency, t, 750, 380, D);
    sweep(f2.frequency, t, 1200, 760, D);
    const vg = new GainNode(c, { gain: 4 * p });
    O(X, 'sine', 7, t, t + D, vg);
    for (const m of [1, 1.05, 1.5]) {
      const o = O(X, 'sawtooth', 60 * m * p, t, t + D, f1);
      o.connect(f2);
      sweep(o.frequency, t, 62 * m * p, 41 * m * p, D);
      vg.connect(o.frequency);
    }
    const gr = Gn(X, 0, X.out);
    N(X, t, D, F(X, 'lowpass', 220, 1, gr));
    gr.gain.setValueAtTime(0, t);
    gr.gain.linearRampToValueAtTime(1.0, t + 0.3);
    gr.gain.setTargetAtTime(0, t + D - 0.6, 0.2);
    return t + D + 0.1;
  },
  bossHit(X) {
    const { t, p } = X;
    const gs = Gn(X, 0, X.out);
    const s = O(X, 'sine', 110 * p, t, t + 0.7, gs);
    sweep(s.frequency, t, 120 * p, 30 * p, 0.5);
    env(gs.gain, t, 0.002, 1.0, 0.55);
    const gm = Gn(X, 0, X.out);
    const bp = F(X, 'bandpass', 900 * p, 1.4, gm);
    for (const f of [180, 287, 431, 610]) O(X, 'square', f * p, t, t + 0.6, bp);
    env(gm.gain, t, 0.002, 0.45, 0.5);
    const gc = Gn(X, 0, X.out);
    N(X, t, 0.14, F(X, 'highpass', 1500, 0.7, gc));
    env(gc.gain, t, 0.001, 0.9, 0.1);
    const gr = Gn(X, 0, X.out);
    N(X, t, 0.7, F(X, 'lowpass', 400, 1, gr));
    env(gr.gain, t, 0.01, 0.7, 0.6);
    return t + 0.75;
  },
  victory(X) {
    const { t, p } = X;
    const brass = (t0, ms, dur, pk) => {
      const g = Gn(X, 0, X.out);
      const lp = F(X, 'lowpass', 900, 1.2, g);
      lp.frequency.setValueAtTime(900, t0);
      lp.frequency.linearRampToValueAtTime(3800, t0 + 0.04);
      lp.frequency.setTargetAtTime(1900, t0 + 0.05, 0.2);
      for (const m of ms) for (const d of [-8, 0, 8]) { const o = O(X, 'sawtooth', mtof(m) * p, t0, t0 + dur + 0.4, lp); o.detune.value = d; }
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(pk, t0 + 0.02);
      g.gain.setTargetAtTime(pk * 0.75, t0 + 0.03, 0.1);
      g.gain.setTargetAtTime(0, t0 + dur, 0.12);
    };
    brass(t, [67], 0.11, 0.22);
    brass(t + 0.13, [72], 0.11, 0.22);
    brass(t + 0.26, [76], 0.11, 0.22);
    brass(t + 0.39, [79], 0.3, 0.24);
    brass(t + 0.75, [72, 76, 79, 84], 1.5, 0.2);
    const gt = Gn(X, 0, X.out);
    const s = O(X, 'sine', 65 * p, t + 0.75, t + 2, gt);
    sweep(s.frequency, t + 0.75, 70 * p, 52 * p, 0.6);
    env(gt.gain, t + 0.75, 0.003, 0.7, 0.9);
    chime(X, t + 0.8, 96, 0.9, 0.18);
    chime(X, t + 0.88, 100, 1.0, 0.16);
    return t + 2.8;
  },
  defeat(X) {
    const { t, p } = X;
    const g = Gn(X, 0, X.out);
    const lp = F(X, 'lowpass', 2500, 1, g);
    sweep(lp.frequency, t, 2500, 350, 3.0);
    const seq = [[0, 67], [0.45, 63], [0.9, 60], [1.35, 55]];
    const a = O(X, 'triangle', mtof(67) * p, t, t + 3.2, lp);
    const b = O(X, 'sawtooth', mtof(67) * p, t, t + 3.2, lp);
    b.detune.value = 12;
    for (const [dt, m] of seq) { a.frequency.setTargetAtTime(mtof(m) * p, t + dt, 0.02); b.frequency.setTargetAtTime(mtof(m) * p, t + dt, 0.02); }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.05);
    g.gain.setTargetAtTime(0.25, t + 0.1, 0.5);
    g.gain.setTargetAtTime(0, t + 2.2, 0.3);
    const gs = Gn(X, 0, X.out);
    const s = O(X, 'sine', mtof(31) * p, t + 1.35, t + 3.2, gs);
    s.frequency.value = mtof(31) * p;
    env(gs.gain, t + 1.35, 0.05, 0.5, 1.6);
    return t + 3.25;
  },
};

// per-sound mix: base gain, reverb send, per-name voice limit
const MIX = {
  whoosh: [0.7, 0.1, 4], punchHit: [0.9, 0.12, 4], kickHit: [0.9, 0.12, 3], perfect: [0.55, 0.45, 3], great: [0.5, 0.4, 3],
  good: [0.45, 0.3, 3], miss: [0.6, 0.15, 3], shatter: [0.6, 0.35, 6], block: [0.7, 0.25, 3], dodge: [0.6, 0.15, 3],
  jumpOver: [0.6, 0.2, 2], duckUnder: [0.6, 0.15, 2], blast: [0.85, 0.5, 2], hurt: [0.75, 0.15, 2], combo: [0.45, 0.35, 2],
  overdrive: [0.7, 0.5, 1], uiHover: [0.4, 0.05, 2], uiSelect: [0.5, 0.15, 2], countdown: [0.55, 0.25, 2], go: [0.6, 0.4, 1],
  bossRoar: [0.85, 0.5, 1], bossHit: [0.85, 0.35, 2], victory: [0.6, 0.45, 1], defeat: [0.6, 0.45, 1], chargeHum: [0.55, 0.3, 2],
};
export const SFX_NAMES = [...Object.keys(DEFS), 'chargeHum'];
const GLOBAL_LIMIT = 24;

export function createSfx(G) {
  const c = G.ctx;
  const active = [];
  const lastAt = Object.create(null);
  const stats = { played: 0, stolen: 0, dropped: 0 };

  function makeVoice(name, o) {
    const mix = MIX[name];
    const gain = Math.max(0, o.gain ?? 1) * mix[0];
    const out = new GainNode(c, { gain });
    let pan = null;
    if (o.pan) {
      pan = new StereoPannerNode(c, { pan: Math.max(-1, Math.min(1, o.pan)) });
      out.connect(pan);
      pan.connect(G.sfxBus);
    } else out.connect(G.sfxBus);
    let rev = null;
    if (mix[1] > 0) { rev = new GainNode(c, { gain: mix[1] }); (pan || out).connect(rev); rev.connect(G.sfxRev); }
    return { name, out, pan, rev, srcs: [], end: 0, loop: false, dead: false };
  }
  function steal(v, now) {
    v.dead = true;
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setTargetAtTime(0, now, 0.008);
    for (const s of v.srcs) { try { s.stop(now + 0.06); } catch {} }
    v.end = now + 0.07;
    stats.stolen++;
  }
  function limit(name, now) {
    let same = 0, oldestSame = null, live = 0, oldest = null;
    for (const v of active) {
      if (v.dead || v.loop) continue;
      live++;
      if (!oldest) oldest = v;
      if (v.name === name) { same++; if (!oldestSame) oldestSame = v; }
    }
    if (same >= MIX[name][2] && oldestSame) steal(oldestSame, now);
    else if (live >= GLOBAL_LIMIT && oldest) steal(oldest, now);
  }

  function play(name, o = {}, when) {
    const fn = DEFS[name];
    if (!fn) {
      if (name === 'chargeHum') { const h = loop(name, o); setTimeout(() => h.stop(), 1200); return h; } // one-shot use
      return null;
    }
    const now = c.currentTime;
    const t = when !== undefined && when > now ? when : now;
    if (lastAt[name] !== undefined && Math.abs(t - lastAt[name]) < 0.012) { stats.dropped++; return null; }
    lastAt[name] = t;
    limit(name, now);
    const v = makeVoice(name, o);
    v.end = fn({ c, G, t, p: o.pitch ?? 1, out: v.out, v });
    active.push(v);
    stats.played++;
    return v;
  }

  function loop(name, o = {}) {
    if (name !== 'chargeHum') return { stop() {}, set() {} };
    const now = c.currentTime, t = now, p = o.pitch ?? 1;
    const v = makeVoice(name, o);
    v.loop = true;
    v.end = Infinity;
    const X = { c, G, t, p, out: v.out, v };
    const g = Gn(X, 0, v.out);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.15);
    const trem = Gn(X, 0.75, g);
    const lfo = O(X, 'sine', 9, t, t + 3600, Gn(X, 0.25, trem.gain));
    lfo.frequency.setValueAtTime(8, t);
    lfo.frequency.linearRampToValueAtTime(17, t + 1.2);
    const lp = F(X, 'lowpass', 300, 8, trem);
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(1900, t + 1.2);
    const oscs = [];
    for (const [type, f, gg] of [['sawtooth', 55, 0.5], ['sawtooth', 55.7, 0.5], ['sine', 110, 0.6], ['square', 220, 0.12]]) {
      const o2 = O(X, type, f * p, t, t + 3600, Gn(X, gg, lp));
      o2.frequency.setValueAtTime(f * p, t);
      o2.frequency.linearRampToValueAtTime(f * p * 1.26, t + 1.2);
      oscs.push(o2);
    }
    const crackle = Gn(X, 0, g);
    const nsrc = new AudioBufferSourceNode(c, { buffer: G.noise, loop: true });
    nsrc.connect(F(X, 'bandpass', 3200, 3, crackle));
    nsrc.start(t);
    v.srcs.push(nsrc);
    G.track(nsrc);
    const gate = O(X, 'square', 23, t, t + 3600, Gn(X, 0.06, crackle.gain));
    gate.frequency.value = 23;
    active.push(v);
    stats.played++;
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        const n = c.currentTime;
        v.out.gain.cancelScheduledValues(n);
        v.out.gain.setTargetAtTime(0, n, 0.06);
        for (const s of v.srcs) { try { s.stop(n + 0.35); } catch {} }
        v.end = n + 0.4;
        v.loop = false;
      },
      set(level) { // 0..1 charge progress: brightens + raises pitch
        if (stopped) return;
        const n = c.currentTime, k = Math.max(0, Math.min(1, level));
        lp.frequency.cancelScheduledValues(n);
        lp.frequency.setTargetAtTime(300 + k * 2400, n, 0.05);
        for (const o2 of oscs) { o2.frequency.cancelScheduledValues(n); }
        oscs[0].frequency.setTargetAtTime(55 * p * (1 + k * 0.4), n, 0.05);
        oscs[1].frequency.setTargetAtTime(55.7 * p * (1 + k * 0.4), n, 0.05);
        oscs[2].frequency.setTargetAtTime(110 * p * (1 + k * 0.4), n, 0.05);
        oscs[3].frequency.setTargetAtTime(220 * p * (1 + k * 0.4), n, 0.05);
      },
    };
  }

  function cleanup(now) {
    let w = 0;
    for (let i = 0; i < active.length; i++) {
      const v = active[i];
      if (v.end < now - 0.05) {
        try { v.out.disconnect(); } catch {}
        if (v.pan) { try { v.pan.disconnect(); } catch {} }
        if (v.rev) { try { v.rev.disconnect(); } catch {} }
        for (const s of v.srcs) { try { s.disconnect(); } catch {} }
      } else active[w++] = v;
    }
    active.length = w;
  }

  return { play, loop, cleanup, stats, get voices() { return active.length; } };
}
