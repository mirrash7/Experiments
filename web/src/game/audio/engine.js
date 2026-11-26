// BREAKLIGHT audio engine: mixing graph, persistent synth voices and drum hits.
// All sound is synthesized with the Web Audio API (no samples).
//
// Graph:
//   music voices ─► duck (sidechain) ─► mFilter (overdrive sweep) ─► songDry ─► musicVol ─┐
//   drums        ──────────────────────► mFilter                                          ├► master ► comp ► softclip ► out
//   music sends  ─► revSend ─► songRev ─► musicVolRev ─► reverb ───────────────────────────┤
//   delay sends  ─► ping-pong delay ─► duck                                               │
//   sfx          ─► sfxVol ───────────────────────────────────────────────────────────────┘
//   sfx sends    ─► sfxVolRev ─► reverb
// `songLevel` (a ConstantSource) drives songDry.gain + songRev.gain so one automation fades the song and its sends.

export const BPM = 128;
export const BEAT = 60 / BPM; // 0.46875 s (exact in binary)
export const STEP = BEAT / 4; // 16th note
export const BAR = BEAT * 4;
// DynamicsCompressorNode look-ahead (Blink/WebKit/Gecko all use a 6 ms pre-delay); verified offline in the lab.
export const PROC_DELAY = 0.006;

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function softClipCurve(n = 2048) {
  // The shaper is fed signal * 0.5, so curve index x ∈ [-1, 1] ↔ signal u ∈ [-2, 2].
  // Linear up to 0.8, then a tanh knee that never exceeds 1.0.
  const c = new Float32Array(n);
  const k = 0.8;
  for (let i = 0; i < n; i++) {
    const u = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(u);
    const y = a < k ? a : k + (1 - k) * Math.tanh((a - k) / (1 - k));
    c[i] = Math.sign(u) * y;
  }
  return c;
}

export function driveCurve(amount = 2, n = 1024) {
  const c = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / norm;
  }
  return c;
}

function makeIR(ctx, dur, R) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * dur);
  const pre = Math.floor(sr * 0.014);
  const b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const x = (i - pre) / (n - pre);
      const env = Math.exp(-x * 6.2) * (1 - x);
      const coef = 0.92 - 0.78 * x; // bright early, darker tail
      lp += coef * (R() * 2 - 1 - lp);
      d[i] = lp * env;
    }
    for (let k = 0; k < 10; k++) {
      const idx = pre + Math.floor(sr * (0.006 + R() * 0.075));
      d[idx] += (R() < 0.5 ? -1 : 1) * (0.7 - k * 0.05);
    }
  }
  return b;
}

const g_ = (ctx, gain, dest) => {
  const n = new GainNode(ctx, { gain });
  if (dest) n.connect(dest);
  return n;
};

export function createGraph(ctx) {
  const R = rng(0xb1ea);
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  {
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = R() * 2 - 1;
  }
  const G = { ctx, R, noise, live: 0 };
  G._onEnd = () => { G.live--; };
  G.track = (src) => { G.live++; src.onended = G._onEnd; return src; };

  // master
  G.master = g_(ctx, 0.9);
  G.comp = new DynamicsCompressorNode(ctx, { threshold: -12, knee: 6, ratio: 4, attack: 0.003, release: 0.16 });
  G.pre = g_(ctx, 0.5);
  G.clip = new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: 'none' });
  G.master.connect(G.comp);
  G.comp.connect(G.pre);
  G.pre.connect(G.clip);
  G.clip.connect(ctx.destination);
  G.out = G.clip;

  // reverb (one shared convolver)
  G.reverbIn = g_(ctx, 1);
  const rhp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 220, Q: 0.5 });
  G.conv = new ConvolverNode(ctx, { buffer: makeIR(ctx, 2.6, R) });
  G.reverbIn.connect(rhp);
  rhp.connect(G.conv);
  G.reverbOut = g_(ctx, 0.9, G.master);
  G.conv.connect(G.reverbOut);

  // music chain
  G.musicVol = g_(ctx, 0.8, G.master);
  G.musicVolRev = g_(ctx, 0.8, G.reverbIn);
  G.songLevel = new ConstantSourceNode(ctx, { offset: 1 });
  G.songDry = g_(ctx, 0, G.musicVol);
  G.songRev = g_(ctx, 0, G.musicVolRev);
  G.songLevel.connect(G.songDry.gain);
  G.songLevel.connect(G.songRev.gain);
  G.songLevel.start();
  G.mFilter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.7 });
  G.mFilter.connect(G.songDry);
  G.duck = g_(ctx, 1, G.mFilter);
  G.drumBus = g_(ctx, 1, G.mFilter);
  G.revSend = g_(ctx, 1, G.songRev);

  // ping-pong delay (dotted 8th), returns into the ducked bus
  G.dlyIn = g_(ctx, 1);
  const dhp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 350 });
  const dL = new DelayNode(ctx, { maxDelayTime: 2, delayTime: BEAT * 0.75 });
  const dR = new DelayNode(ctx, { maxDelayTime: 2, delayTime: BEAT * 0.75 });
  const dlp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3400 });
  const fb = g_(ctx, 0.36);
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  G.dlyIn.connect(dhp);
  dhp.connect(dL);
  dL.connect(merger, 0, 0);
  dL.connect(dR);
  dR.connect(merger, 0, 1);
  dR.connect(dlp);
  dlp.connect(fb);
  fb.connect(dL);
  const dlyOut = g_(ctx, 0.55, G.duck);
  merger.connect(dlyOut);
  const dlyRev = g_(ctx, 0.25, G.revSend);
  dlyOut.connect(dlyRev);

  // sfx chain
  G.sfxVol = g_(ctx, 1, G.master);
  G.sfxVolRev = g_(ctx, 1, G.reverbIn);
  G.sfxBus = G.sfxVol;
  G.sfxRev = G.sfxVolRev;

  G.dispose = () => {
    try { G.songLevel.stop(); } catch {}
    for (const n of [G.master, G.comp, G.pre, G.clip, G.reverbIn, rhp, G.conv, G.reverbOut, G.musicVol, G.musicVolRev,
      G.songDry, G.songRev, G.songLevel, G.mFilter, G.duck, G.drumBus, G.revSend, G.dlyIn, dhp, dL, dR, dlp, fb, merger,
      dlyOut, dlyRev, G.sfxVol, G.sfxVolRev]) { try { n.disconnect(); } catch {} }
  };
  return G;
}

// ---------------------------------------------------------------- per-song output + kit

export function makeOut(G, { drumDrive = 0, drumGain = 1 } = {}) {
  const c = G.ctx;
  const out = { G, nodes: [] };
  out.dry = g_(c, 1, G.duck);
  out.rev = g_(c, 1, G.revSend);
  out.dly = g_(c, 1, G.dlyIn);
  if (drumDrive) {
    out.drums = g_(c, 1);
    const sh = new WaveShaperNode(c, { curve: driveCurve(drumDrive), oversample: 'none' });
    out.drums.connect(sh);
    const post = g_(c, 0.8 * drumGain, G.drumBus);
    sh.connect(post);
    out.nodes.push(sh, post);
  } else out.drums = g_(c, drumGain, G.drumBus);
  out.nodes.push(out.dry, out.rev, out.dly, out.drums);
  out.fade = (t, tc = 0.03) => { for (const n of [out.dry, out.rev, out.dly, out.drums]) n.gain.setTargetAtTime(0, t, tc); };
  out.dispose = () => { for (const n of out.nodes) { try { n.disconnect(); } catch {} } };
  return out;
}

export function makeKit(G, out, o) {
  const c = G.ctx;
  const k = {
    drums: out.drums,
    kick: { f0: 160, f1: 46, pt: 0.09, hold: 0.04, dec: 0.4, lvl: 1, click: 0.3, ...o.kick },
    snare: { tone: 185, toneLvl: 0.45, noiseLvl: 0.6, dec: 0.17, ...o.snare },
    hatLvl: o.hatLvl ?? 0.3,
    duckDepth: o.duck ?? 0.45,
    G,
  };
  k.clickF = new BiquadFilterNode(c, { type: 'highpass', frequency: 2800 });
  k.clickF.connect(out.drums);
  k.snareF = new BiquadFilterNode(c, { type: 'bandpass', frequency: o.snareBP ?? 1900, Q: 0.8 });
  k.snareF.connect(out.drums);
  k.snareRev = g_(c, o.snareRev ?? 0.25, out.rev);
  k.snareF.connect(k.snareRev);
  k.hatF = new BiquadFilterNode(c, { type: 'highpass', frequency: o.hatHP ?? 7200, Q: 0.7 });
  const hatPan = new StereoPannerNode(c, { pan: 0.18 });
  k.hatF.connect(hatPan);
  hatPan.connect(out.drums);
  k.clapF = new BiquadFilterNode(c, { type: 'bandpass', frequency: 1250, Q: 1.1 });
  k.clapF.connect(out.drums);
  const clapRev = g_(c, 0.35, out.rev);
  k.clapF.connect(clapRev);
  k.crashF = new BiquadFilterNode(c, { type: 'highpass', frequency: 5200 });
  k.crashF.connect(out.drums);
  const crashRev = g_(c, 0.3, out.rev);
  k.crashF.connect(crashRev);
  k.tomOut = g_(c, 1, out.drums);
  const tomRev = g_(c, 0.2, out.rev);
  k.tomOut.connect(tomRev);
  out.nodes.push(k.clickF, k.snareF, k.snareRev, k.hatF, hatPan, k.clapF, clapRev, k.crashF, crashRev, k.tomOut, tomRev);
  return k;
}

export function noiseSrc(G, t, dur, dest, rate = 1) {
  const s = new AudioBufferSourceNode(G.ctx, { buffer: G.noise, playbackRate: rate });
  if (dur > 1.2) { s.loop = true; s.start(t, G.R() * 1.5); s.stop(t + dur); }
  else s.start(t, G.R() * 0.75, dur);
  s.connect(dest);
  G.track(s);
  return s;
}

export function duck(G, t, depth) {
  const g = G.duck.gain;
  g.setTargetAtTime(1 - depth, t, 0.004);
  g.setTargetAtTime(1, t + 0.045, BEAT * 0.17);
}

export function kick(k, t, v = 1, o = k.kick) {
  const G = k.G, c = G.ctx;
  const osc = new OscillatorNode(c, { type: 'sine', frequency: o.f0 });
  osc.frequency.setValueAtTime(o.f0 * 1.6, t);
  osc.frequency.exponentialRampToValueAtTime(o.f0, t + 0.006);
  osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.pt);
  const g = new GainNode(c, { gain: 0 });
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * o.lvl, t + 0.0025);
  g.gain.setTargetAtTime(0, t + o.hold, o.dec / 4);
  osc.connect(g);
  g.connect(k.drums);
  osc.start(t);
  osc.stop(t + o.hold + o.dec + 0.05);
  G.track(osc);
  if (o.click) {
    const cg = new GainNode(c, { gain: v * o.click });
    cg.connect(k.clickF);
    noiseSrc(G, t, 0.012, cg);
  }
  if (k.duckDepth) duck(G, t, k.duckDepth * Math.min(1, v));
}

export function snare(k, t, v = 1, o = k.snare) {
  const G = k.G, c = G.ctx;
  const osc = new OscillatorNode(c, { type: 'triangle', frequency: o.tone });
  osc.frequency.setValueAtTime(o.tone * 1.4, t);
  osc.frequency.exponentialRampToValueAtTime(o.tone, t + 0.035);
  const g = new GainNode(c, { gain: 0 });
  g.gain.setValueAtTime(v * o.toneLvl, t);
  g.gain.setTargetAtTime(0, t + 0.004, 0.035);
  osc.connect(g);
  g.connect(k.drums);
  osc.start(t);
  osc.stop(t + 0.25);
  G.track(osc);
  const ng = new GainNode(c, { gain: 0 });
  ng.gain.setValueAtTime(v * o.noiseLvl, t);
  ng.gain.setTargetAtTime(0, t + 0.008, o.dec / 4);
  ng.connect(k.snareF);
  noiseSrc(G, t, o.dec + 0.08, ng);
}

export function hat(k, t, v = 1, open = false) {
  const G = k.G;
  const d = open ? 0.3 : 0.045;
  const g = new GainNode(G.ctx, { gain: 0 });
  g.gain.setValueAtTime(v * k.hatLvl, t);
  g.gain.setTargetAtTime(0, t + 0.002, d / 4);
  g.connect(k.hatF);
  noiseSrc(G, t, d + 0.04, g);
}

export function shaker(k, t, v = 1) {
  const G = k.G;
  const g = new GainNode(G.ctx, { gain: 0 });
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * k.hatLvl * 0.7, t + 0.012);
  g.gain.setTargetAtTime(0, t + 0.014, 0.018);
  g.connect(k.hatF);
  noiseSrc(G, t, 0.09, g, 0.8);
}

export function ride(k, t, v = 1) {
  const G = k.G, c = G.ctx;
  const g = new GainNode(c, { gain: 0 });
  g.gain.setValueAtTime(v * k.hatLvl * 0.55, t);
  g.gain.setTargetAtTime(0, t + 0.005, 0.12);
  g.connect(k.hatF);
  noiseSrc(G, t, 0.45, g, 0.7);
  // a faint bell partial
  const o = new OscillatorNode(c, { type: 'square', frequency: 3150 });
  const og = new GainNode(c, { gain: 0 });
  og.gain.setValueAtTime(v * 0.012, t);
  og.gain.setTargetAtTime(0, t + 0.003, 0.08);
  o.connect(og);
  og.connect(k.crashF);
  o.start(t);
  o.stop(t + 0.4);
  G.track(o);
}

export function clap(k, t, v = 1) {
  const G = k.G;
  const g = new GainNode(G.ctx, { gain: 0 });
  const p = g.gain;
  p.setValueAtTime(v, t);
  p.setTargetAtTime(v * 0.1, t + 0.001, 0.003);
  p.setValueAtTime(v * 0.85, t + 0.011);
  p.setTargetAtTime(v * 0.1, t + 0.012, 0.003);
  p.setValueAtTime(v * 0.9, t + 0.023);
  p.setTargetAtTime(0, t + 0.024, 0.045);
  g.connect(k.clapF);
  noiseSrc(G, t, 0.3, g);
}

export function crash(k, t, v = 1) {
  const G = k.G;
  const g = new GainNode(G.ctx, { gain: 0 });
  g.gain.setValueAtTime(v * 0.32, t);
  g.gain.setTargetAtTime(0, t + 0.01, 0.45);
  g.connect(k.crashF);
  noiseSrc(G, t, 2, g, 0.9);
}

export function tom(k, t, f, v = 1) {
  const G = k.G, c = G.ctx;
  const o = new OscillatorNode(c, { type: 'sine', frequency: f });
  o.frequency.setValueAtTime(f * 1.3, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.62, t + 0.22);
  const g = new GainNode(c, { gain: 0 });
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v * 0.7, t + 0.003);
  g.gain.setTargetAtTime(0, t + 0.02, 0.07);
  o.connect(g);
  g.connect(k.tomOut);
  o.start(t);
  o.stop(t + 0.4);
  G.track(o);
}

// noise + saw riser for `dur` seconds, into a song output (rev-heavy)
export function riser(G, out, t, dur, v = 1) {
  const c = G.ctx;
  const g = new GainNode(c, { gain: 0 });
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.22 * v, t + dur * 0.95);
  g.gain.setTargetAtTime(0, t + dur, 0.03);
  const f = new BiquadFilterNode(c, { type: 'bandpass', frequency: 400, Q: 2.2 });
  f.frequency.setValueAtTime(350, t);
  f.frequency.exponentialRampToValueAtTime(7500, t + dur);
  f.connect(g);
  g.connect(out.dry);
  const rs = new GainNode(c, { gain: 0.6 });
  g.connect(rs);
  rs.connect(out.rev);
  noiseSrc(G, t, dur + 0.05, f);
  const o = new OscillatorNode(c, { type: 'sawtooth', frequency: 180 });
  o.frequency.setValueAtTime(180, t);
  o.frequency.exponentialRampToValueAtTime(1400, t + dur);
  const og = new GainNode(c, { gain: 0.18 });
  o.connect(og);
  og.connect(f);
  o.start(t);
  o.stop(t + dur + 0.05);
  G.track(o);
}

export function impact(G, out, t, v = 1) {
  const c = G.ctx;
  const o = new OscillatorNode(c, { type: 'sine', frequency: 95 });
  o.frequency.setValueAtTime(95, t);
  o.frequency.exponentialRampToValueAtTime(30, t + 0.9);
  const g = new GainNode(c, { gain: 0 });
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.55 * v, t + 0.01);
  g.gain.setTargetAtTime(0, t + 0.1, 0.28);
  o.connect(g);
  g.connect(out.drums);
  o.start(t);
  o.stop(t + 1.3);
  G.track(o);
  const ng = new GainNode(c, { gain: 0 });
  ng.gain.setValueAtTime(0.25 * v, t);
  ng.gain.setTargetAtTime(0, t + 0.02, 0.35);
  const lp = new BiquadFilterNode(c, { type: 'lowpass', frequency: 2500 });
  lp.frequency.setValueAtTime(5000, t);
  lp.frequency.exponentialRampToValueAtTime(300, t + 1.2);
  ng.connect(lp);
  lp.connect(out.rev);
  noiseSrc(G, t, 1.4, ng);
}

// FM bell / pluck (polyphonic, one-shot)
export function bell(G, dest, t, midi, o = {}) {
  const c = G.ctx;
  const f = mtof(midi);
  const v = o.vel ?? 1;
  const dur = o.dur ?? 1.2;
  const car = new OscillatorNode(c, { type: 'sine', frequency: f });
  const mod = new OscillatorNode(c, { type: 'sine', frequency: f * (o.ratio ?? 3.5) });
  const mg = new GainNode(c, { gain: 0 });
  mg.gain.setValueAtTime(f * (o.index ?? 2), t);
  mg.gain.setTargetAtTime(f * (o.index ?? 2) * (o.indexEnd ?? 0.1), t + 0.002, o.indexTc ?? 0.12);
  mod.connect(mg);
  mg.connect(car.frequency);
  const eg = new GainNode(c, { gain: 0 });
  eg.gain.setValueAtTime(0, t);
  eg.gain.linearRampToValueAtTime(v * (o.lvl ?? 0.12), t + (o.a ?? 0.003));
  eg.gain.setTargetAtTime(0, t + (o.a ?? 0.003), dur / 4);
  car.connect(eg);
  eg.connect(dest.dry);
  if (o.rev) { const s = new GainNode(c, { gain: o.rev }); eg.connect(s); s.connect(dest.rev); }
  if (o.dly) { const s = new GainNode(c, { gain: o.dly }); eg.connect(s); s.connect(dest.dly); }
  const end = t + dur + 0.1;
  car.start(t); mod.start(t); car.stop(end); mod.stop(end);
  G.track(car);
}

// ---------------------------------------------------------------- persistent voices

// Monophonic synth with persistent oscillators: notes only automate params (no per-note node allocation).
// Releases are committed lazily (`flush`) so automation events are always inserted in time order.
export class Mono {
  constructor(G, dest, o) {
    const c = G.ctx;
    this.G = G;
    this.env = { a: 0.005, d: 0.2, s: 0.6, r: 0.12, ...o.env };
    this.level = o.level ?? 0.2;
    this.glide = o.glide || 0;
    this.cut = o.cut ?? 2000;
    this.famt = o.famt || 0;
    this.fdec = o.fdec ?? 0.15;
    this.fil = new BiquadFilterNode(c, { type: o.ftype || 'lowpass', frequency: this.cut, Q: o.q ?? 1 });
    this.vca = new GainNode(c, { gain: 0 });
    this.nodes = [this.fil, this.vca];
    this.srcs = [];
    this.oscs = [];
    const spread = o.spread || 0;
    let panL = null, panR = null;
    if (spread) {
      panL = new StereoPannerNode(c, { pan: -spread });
      panR = new StereoPannerNode(c, { pan: spread });
      panL.connect(this.fil); panR.connect(this.fil);
      this.nodes.push(panL, panR);
    }
    let post = this.fil;
    if (o.drive) {
      const sh = new WaveShaperNode(c, { curve: driveCurve(o.drive), oversample: 'none' });
      this.fil.connect(sh);
      post = sh;
      this.nodes.push(sh);
    }
    post.connect(this.vca);
    const sum = o.oscs.reduce((a, s) => a + (s.gain ?? 1), 0);
    for (const sp of o.oscs) {
      const osc = new OscillatorNode(c, { type: sp.type || 'sawtooth', detune: sp.detune || 0 });
      const og = new GainNode(c, { gain: (sp.gain ?? 1) / sum });
      osc.connect(og);
      const det = sp.detune || 0;
      og.connect(spread && det < 0 ? panL : spread && det > 0 ? panR : this.fil);
      this.oscs.push({ osc, og, mult: Math.pow(2, (sp.semi || 0) / 12) });
      this.nodes.push(og);
      this.srcs.push(osc);
    }
    if (o.vib) {
      const l = new OscillatorNode(c, { type: 'sine', frequency: o.vib.rate });
      const lg = new GainNode(c, { gain: o.vib.cents });
      l.connect(lg);
      for (const s of this.oscs) lg.connect(s.osc.detune);
      this.srcs.push(l); this.nodes.push(lg);
    }
    if (o.flfo) {
      const l = new OscillatorNode(c, { type: o.flfo.type || 'sine', frequency: o.flfo.rate });
      const lg = new GainNode(c, { gain: o.flfo.depth });
      l.connect(lg);
      lg.connect(this.fil.frequency);
      this.srcs.push(l); this.nodes.push(lg);
    }
    this.vca.connect(dest.dry);
    if (o.rev) { const s = new GainNode(c, { gain: o.rev }); this.vca.connect(s); s.connect(dest.rev); this.nodes.push(s); }
    if (o.dly) { const s = new GainNode(c, { gain: o.dly }); this.vca.connect(s); s.connect(dest.dly); this.nodes.push(s); }
    this.rel = -1;
    this.sounding = false;
  }
  start(t) { for (const s of this.srcs) s.start(t); }
  stop(t) { for (const s of this.srcs) { try { s.stop(t); } catch {} } }
  dispose() { for (const n of this.nodes) { try { n.disconnect(); } catch {} } for (const s of this.srcs) { try { s.disconnect(); } catch {} } }
  flush(T, newNote = false) {
    if (this.rel < 0) return;
    if (this.rel <= T + 1e-6) {
      this.vca.gain.setTargetAtTime(0, this.rel, this.env.r / 3);
      this.sounding = false;
      this.rel = -1;
    } else if (newNote) this.rel = -1; // legato
  }
  setCut(t, v, tc = 0.08) { this.cut = v; if (!this.famt) this.fil.frequency.setTargetAtTime(v, t, tc); }
  note(t, midi, dur, vel = 1) {
    this.flush(t, true);
    const f = mtof(midi);
    const gl = this.glide && this.sounding;
    for (const s of this.oscs) {
      if (gl) s.osc.frequency.setTargetAtTime(f * s.mult, t, this.glide);
      else s.osc.frequency.setValueAtTime(f * s.mult, t);
    }
    const e = this.env, pk = this.level * vel, g = this.vca.gain;
    g.setTargetAtTime(pk, t, Math.max(e.a / 3, 0.0008));
    g.setTargetAtTime(pk * e.s, t + e.a, e.d / 3);
    if (this.famt) {
      const fq = this.fil.frequency;
      fq.setTargetAtTime(Math.min(this.cut + this.famt * vel, 16000), t, 0.0015);
      fq.setTargetAtTime(this.cut, t + 0.008, this.fdec / 3);
    }
    this.rel = t + dur;
    this.sounding = true;
  }
}

// Polyphonic chord synth with persistent voices (retuned per chord). Used for pads (`hold`) and stabs (`gate`).
export class Pad {
  constructor(G, dest, o) {
    const c = G.ctx;
    this.G = G;
    this.env = { a: 0.004, d: 0.2, s: 0.3, r: 0.1, ...o.env };
    this.level = o.level ?? 0.1;
    this.fil = new BiquadFilterNode(c, { type: 'lowpass', frequency: o.cut ?? 1800, Q: o.q ?? 0.8 });
    this.vca = new GainNode(c, { gain: 0 });
    this.fil.connect(this.vca);
    this.vca.connect(dest.dry);
    this.nodes = [this.fil, this.vca];
    this.srcs = [];
    this.voices = [];
    const panL = new StereoPannerNode(c, { pan: -(o.spread ?? 0.6) });
    const panR = new StereoPannerNode(c, { pan: o.spread ?? 0.6 });
    panL.connect(this.fil); panR.connect(this.fil);
    this.nodes.push(panL, panR);
    const n = o.voices ?? 4;
    const det = o.detunes ?? [-10, 0, 10];
    const per = 1 / (n * det.length);
    for (let i = 0; i < n; i++) {
      const v = [];
      for (const d of det) {
        const osc = new OscillatorNode(c, { type: o.type || 'sawtooth', detune: d + (i % 2 ? 2 : -2) });
        const og = new GainNode(c, { gain: per * (d === 0 ? 0.8 : 1) });
        osc.connect(og);
        og.connect(d < 0 ? panL : d > 0 ? panR : this.fil);
        v.push(osc);
        this.srcs.push(osc);
        this.nodes.push(og);
      }
      this.voices.push(v);
    }
    if (o.flfo) {
      const l = new OscillatorNode(c, { type: 'sine', frequency: o.flfo.rate });
      const lg = new GainNode(c, { gain: o.flfo.depth });
      l.connect(lg); lg.connect(this.fil.frequency);
      this.srcs.push(l); this.nodes.push(lg);
    }
    if (o.rev) { const s = new GainNode(c, { gain: o.rev }); this.vca.connect(s); s.connect(dest.rev); this.nodes.push(s); }
    if (o.dly) { const s = new GainNode(c, { gain: o.dly }); this.vca.connect(s); s.connect(dest.dly); this.nodes.push(s); }
    this.tuned = false;
    this.rel = -1;
  }
  start(t) { for (const s of this.srcs) s.start(t); }
  stop(t) { for (const s of this.srcs) { try { s.stop(t); } catch {} } }
  dispose() { for (const n of this.nodes) { try { n.disconnect(); } catch {} } for (const s of this.srcs) { try { s.disconnect(); } catch {} } }
  chord(t, notes, tc = 0.006) {
    for (let i = 0; i < this.voices.length; i++) {
      const f = mtof(notes[i % notes.length]);
      for (const osc of this.voices[i]) {
        if (this.tuned) osc.frequency.setTargetAtTime(f, t, tc);
        else osc.frequency.setValueAtTime(f, t);
      }
    }
    this.tuned = true;
  }
  hold(t, level, tc = 0.4) { this.vca.gain.setTargetAtTime(level * this.level, t, tc); }
  setCut(t, v, tc = 0.15) { this.fil.frequency.setTargetAtTime(v, t, tc); }
  flush(T, newNote = false) {
    if (this.rel < 0) return;
    if (this.rel <= T + 1e-6) { this.vca.gain.setTargetAtTime(0, this.rel, this.env.r / 3); this.rel = -1; }
    else if (newNote) this.rel = -1;
  }
  gate(t, dur, vel = 1) {
    this.flush(t, true);
    const e = this.env, pk = this.level * vel, g = this.vca.gain;
    g.setTargetAtTime(pk, t, Math.max(e.a / 3, 0.0008));
    g.setTargetAtTime(pk * e.s, t + e.a, e.d / 3);
    this.rel = t + dur;
  }
}

// looping filtered noise "air" bed (one persistent source)
export class Air {
  constructor(G, dest, o = {}) {
    const c = G.ctx;
    this.src = new AudioBufferSourceNode(c, { buffer: G.noise, loop: true, playbackRate: 0.5 });
    this.f = new BiquadFilterNode(c, { type: 'bandpass', frequency: o.freq ?? 900, Q: o.q ?? 1.5 });
    this.g = new GainNode(c, { gain: o.level ?? 0.03 });
    this.lfo = new OscillatorNode(c, { frequency: o.rate ?? 0.07 });
    this.lg = new GainNode(c, { gain: o.depth ?? 500 });
    this.lfo.connect(this.lg); this.lg.connect(this.f.frequency);
    this.src.connect(this.f); this.f.connect(this.g); this.g.connect(dest.dry);
    this.rs = new GainNode(c, { gain: o.rev ?? 0.8 });
    this.g.connect(this.rs); this.rs.connect(dest.rev);
  }
  start(t) { this.src.start(t); this.lfo.start(t); }
  stop(t) { try { this.src.stop(t); this.lfo.stop(t); } catch {} }
  dispose() { for (const n of [this.src, this.f, this.g, this.lfo, this.lg, this.rs]) { try { n.disconnect(); } catch {} } }
  flush() {}
}
