// BREAKLIGHT AUDIO — `createAudio()` per docs/game/CONTRACTS.md.
// 100% procedural Web Audio: beat clock + lookahead scheduler, 4 original songs, synthesized SFX.
//
// Clock model
// -----------
// One continuous, monotonic transport ("song time", seconds). Beat b is at song time b * beatDur.
//   songTime = performance.now()/1000 + K
// While the AudioContext runs, K is continuously re-estimated from ctx.getOutputTimestamp() (fallback:
// currentTime − baseLatency − outputLatency), so song time is what is *audible now* (latency-compensated).
// Before unlock / while suspended, K is held and the transport keeps running on performance.now(); on (re)start
// the audio origin is re-anchored so song time stays continuous. Music events for song time s are scheduled at
// ctx time s + origin, whose audio reaches the speakers when songTime == s (the master compressor's 6 ms
// look-ahead is included). Songs start on bar lines of this transport; playSong() returns the start beat.

import { BPM, BEAT, STEP, PROC_DELAY, createGraph } from './engine.js';
import { createSequencer } from './sequencer.js';
import { createSfx, SFX_NAMES } from './sfx.js';

export { SFX_NAMES, BPM };
export const SONG_IDS = ['title', 'run', 'boss', 'results'];

const TICK_MS = 25;
const LOOKAHEAD = 0.1;
const LOOKAHEAD_HIDDEN = 1.5;

function makeTimer(cb) {
  try {
    const src = 'let id=0;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = cb;
    w.postMessage(TICK_MS);
    return { kind: 'worker', stop() { w.postMessage(0); w.terminate(); } };
  } catch {
    const id = setInterval(cb, TICK_MS);
    return { kind: 'interval', stop() { clearInterval(id); } };
  }
}

export function createAudio(opts = {}) {
  let ctx = null, G = null, seq = null, fx = null;
  const vol = { master: 0.9, music: 0.8, sfx: 1, ...(opts.volume || {}) };

  // ---- clock state
  let K = -performance.now() / 1000; // song time 0 at creation
  let origin = 0; // ctx time of song time 0
  let audioMode = false;
  let lastNow = 0;
  let latS = 0; // smoothed output latency (s)
  let usingTs = false;
  let nextStep = null; // next 16th to schedule (audio mode)
  let nextBeatQ = null; // next beat to queue for onBeat
  const beatCbs = new Set();
  const st = { inten: 0.5, od: false };
  let pendingSong = null; // request made before the graph exists
  let hidden = typeof document !== 'undefined' && document.hidden;
  let lookahead = hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;

  // ---- stats
  const S = {
    ticks: 0, tickMs: 0, tickMax: 0, sfxMs: 0, sfxMax: 0, sfxCalls: 0, lateSteps: 0, minMarginMs: Infinity,
    resyncs: 0, anchors: 0, beatsFired: 0, beatsSkipped: 0, K0: null, baseAt: 0, jitMax: 0, startPerf: 0, startCtx: 0,
  };

  function sync() {
    if (!ctx || ctx.state !== 'running') { audioMode = false; return; }
    const p = performance.now();
    let audible = -1;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      audible = ts.contextTime + (p - ts.performanceTime) / 1000;
      usingTs = true;
    } else {
      audible = ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
      usingTs = false;
    }
    const lat = ctx.currentTime - audible;
    latS = latS ? latS + (lat - latS) * 0.05 : lat;
    if (!audioMode) {
      // (re)anchor: keep song time continuous across the virtual → audio transition
      origin = audible - PROC_DELAY - (p / 1000 + K);
      audioMode = true;
      nextStep = null;
      S.anchors++;
      S.K0 = null; S.baseAt = p + 2000; // drift baseline is taken once the output clock has settled
      return;
    }
    const Kraw = audible - PROC_DELAY - origin - p / 1000;
    const d = Kraw - K;
    if (Math.abs(d) > S.jitMax && Math.abs(d) <= 0.03) S.jitMax = Math.abs(d);
    if (Math.abs(d) > 0.03) { K = Kraw; S.resyncs++; }
    else K += d * 0.04;
    if (S.K0 === null && p >= S.baseAt) { S.K0 = K; S.startPerf = p; S.startCtx = ctx.currentTime; }
  }

  const now = () => {
    const t = performance.now() / 1000 + K;
    if (t < lastNow) return lastNow;
    lastNow = t;
    return t;
  };

  function dispatchBeats() {
    if (!beatCbs.size) { nextBeatQ = null; return; }
    const s = now();
    if (nextBeatQ === null) nextBeatQ = Math.ceil(s / BEAT);
    const horizon = s + Math.min(lookahead, 0.15) + TICK_MS / 1000;
    while (nextBeatQ * BEAT <= horizon) {
      const b = nextBeatQ++;
      const bt = b * BEAT;
      if (bt < s - BEAT * 0.5) { S.beatsSkipped++; continue; }
      const delay = (bt - K) * 1000 - performance.now();
      setTimeout(fireBeat, Math.max(0, delay), b);
    }
  }
  function fireBeat(b) {
    S.beatsFired++;
    for (const cb of beatCbs) { try { cb(b); } catch (e) { console.error('[audio] onBeat callback', e); } }
  }

  function schedule() {
    const cur = ctx.currentTime - origin;
    const horizon = cur + lookahead;
    if (nextStep === null) nextStep = Math.ceil((cur + 0.005) / STEP);
    if (nextStep * STEP < cur) { const ns = Math.ceil((cur + 0.005) / STEP); S.lateSteps += ns - nextStep; nextStep = ns; }
    if (pendingSong && seq) { seq.request(pendingSong.id, pendingSong.step, pendingSong.startBeat); pendingSong = null; }
    while (nextStep * STEP < horizon) {
      const t = nextStep * STEP + origin;
      const m = (t - ctx.currentTime) * 1000;
      if (m < S.minMarginMs) S.minMarginMs = m;
      seq.step(nextStep, t);
      nextStep++;
    }
  }

  function tick() {
    const t0 = performance.now();
    sync();
    dispatchBeats();
    if (audioMode && seq) {
      schedule();
      const ct = ctx.currentTime;
      seq.cleanup(ct);
      fx.cleanup(ct);
    }
    const dt = performance.now() - t0;
    S.ticks++; S.tickMs += dt; if (dt > S.tickMax) S.tickMax = dt;
  }
  const timer = makeTimer(tick);

  // ---- context lifecycle
  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    G = createGraph(ctx);
    seq = createSequencer(G);
    seq.st.inten = st.inten;
    fx = createSfx(G);
    applyVolume(0);
    ctx.onstatechange = () => { if (ctx.state !== 'running') audioMode = false; tick(); };
  }
  async function unlock() {
    init();
    if (ctx.state !== 'running') {
      try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch {}
    }
    tick();
  }
  const gestures = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
  const onGesture = () => {
    unlock().then(() => {
      if (ctx && ctx.state === 'running') for (const g of gestures) window.removeEventListener(g, onGesture, true);
    });
  };
  if (opts.autoUnlock !== false && typeof window !== 'undefined') for (const g of gestures) window.addEventListener(g, onGesture, true);
  const onVis = () => {
    hidden = document.hidden;
    lookahead = hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;
    if (!hidden && ctx && ctx.state === 'suspended' && S.anchors > 0) ctx.resume().catch(() => {});
    tick();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);

  function applyVolume(tc = 0.05) {
    if (!G) return;
    const t = ctx.currentTime;
    const set = (param, v) => (tc ? param.setTargetAtTime(v, t, tc) : param.setValueAtTime(v, t));
    set(G.master.gain, vol.master);
    set(G.musicVol.gain, vol.music);
    set(G.musicVolRev.gain, vol.music);
    set(G.sfxVol.gain, vol.sfx);
    set(G.sfxVolRev.gain, vol.sfx);
  }

  // next bar line that has not been scheduled yet
  function nextBarStep() {
    let n;
    if (audioMode && nextStep !== null) n = nextStep;
    else n = Math.ceil((now() + (audioMode ? lookahead : 0.05)) / STEP);
    return Math.ceil(n / 16) * 16;
  }

  const clock = {
    bpm: BPM,
    beatDur: BEAT,
    now,
    beat: () => now() / BEAT,
    toPerf: (songTime) => (songTime - K) * 1000,
    fromPerf: (perfMs) => perfMs / 1000 + K,
    onBeat(cb) { beatCbs.add(cb); return () => beatCbs.delete(cb); },
    get running() { return audioMode; },
    /** transport beat at which the current (or pending) song started / starts */
    get songStartBeat() {
      const ss = seq ? seq.songStartStep : null;
      if (ss !== null) return ss / 4;
      return pendingSong ? pendingSong.step / 4 - (pendingSong.startBeat || 0) : null;
    },
  };

  const api = {
    clock,
    unlock,
    get ctx() { return ctx; },
    get unlocked() { return !!ctx && ctx.state === 'running'; },
    get latencyMs() {
      if (!ctx) return 0;
      const l = latS || (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
      return (l + PROC_DELAY) * 1000;
    },
    /** Starts `id` on the next bar line; returns the transport beat of the song's beat 0 (startBeat shifts into the song). */
    playSong(id, { startBeat = 0 } = {}) {
      if (!SONG_IDS.includes(id)) { console.warn('[audio] unknown song', id); return null; }
      const step = nextBarStep();
      if (!seq) {
        if (pendingSong && pendingSong.id === id) return pendingSong.step / 4 - startBeat;
        pendingSong = { id, step, startBeat };
        return step / 4 - startBeat;
      }
      if (seq.song === id && !seq.pending) return seq.songStartStep / 4;
      const r = seq.request(id, step, startBeat);
      return r ? r.startStep / 4 : seq.songStartStep / 4;
    },
    setIntensity(x) { st.inten = Math.max(0, Math.min(1, +x || 0)); if (seq) seq.st.inten = st.inten; },
    get intensity() { return st.inten; },
    setOverdrive(on) { st.od = !!on; if (seq) seq.setOd(st.od); },
    stopSong({ fadeMs = 800 } = {}) {
      pendingSong = null;
      if (!seq) return;
      const t = audioMode ? ctx.currentTime + 0.01 : 0;
      if (audioMode) seq.stop(t, Math.max(0.02, fadeMs / 1000));
      else seq.disposeAll();
    },
    get song() { return seq ? seq.song : pendingSong ? pendingSong.id : null; },
    sfx(name, o = {}) {
      if (!fx || !audioMode) return null;
      const t0 = performance.now();
      const when = o.at !== undefined ? o.at + origin : undefined; // optional: schedule at a song time
      const v = fx.play(name, o, when);
      const dt = performance.now() - t0;
      S.sfxCalls++; S.sfxMs += dt; if (dt > S.sfxMax) S.sfxMax = dt;
      return v ? true : null;
    },
    sfxLoop(name, o = {}) {
      if (!fx || !audioMode) return { stop() {}, set() {} };
      return fx.loop(name, o);
    },
    setVolume(v = {}) {
      for (const k of ['master', 'music', 'sfx']) if (v[k] !== undefined) vol[k] = Math.max(0, Math.min(1.5, +v[k]));
      applyVolume();
    },
    get volume() { return { ...vol }; },
    stats() {
      const p = performance.now();
      const o = {
        state: ctx ? ctx.state : 'none', audioMode, timer: timer.kind, song: api.song, intensity: st.inten, overdrive: st.od,
        songTime: now(), beat: now() / BEAT, latencyMs: api.latencyMs, usingOutputTimestamp: usingTs,
        ticks: S.ticks, tickAvgMs: S.ticks ? S.tickMs / S.ticks : 0, tickMaxMs: S.tickMax,
        sfxCalls: S.sfxCalls, sfxAvgMs: S.sfxCalls ? S.sfxMs / S.sfxCalls : 0, sfxMaxMs: S.sfxMax,
        lateSteps: S.lateSteps, minMarginMs: S.minMarginMs, mapJitterMaxMs: S.jitMax * 1000, resyncs: S.resyncs, anchors: S.anchors,
        beatsFired: S.beatsFired, beatsSkipped: S.beatsSkipped,
        liveSources: G ? G.live : 0, sfxVoices: fx ? fx.voices : 0, sfx: fx ? { ...fx.stats } : null,
        lookahead,
      };
      if (ctx && S.K0 !== null && audioMode) {
        o.clockDriftMs = (K - S.K0) * 1000; // perf↔audio mapping change since the anchor
        const dp = (p - S.startPerf) / 1000;
        o.audioVsPerfPpm = dp > 1 ? ((ctx.currentTime - S.startCtx) / dp - 1) * 1e6 : 0;
        o.runSeconds = dp;
      }
      return o;
    },
    resetStats() { Object.assign(S, { ticks: 0, tickMs: 0, tickMax: 0, sfxMs: 0, sfxMax: 0, sfxCalls: 0, lateSteps: 0, minMarginMs: Infinity, jitMax: 0 }); },
    _debug: {
      get graph() { return G; },
      get origin() { return origin; },
      get K() { return K; },
      setMarker(node) { if (seq) seq.setMarker(node); },
    },
    dispose() {
      timer.stop();
      for (const g of gestures) window.removeEventListener(g, onGesture, true);
      document.removeEventListener('visibilitychange', onVis);
      beatCbs.clear();
      if (seq) seq.disposeAll();
      if (G) G.dispose();
      if (ctx) ctx.close().catch(() => {});
      ctx = null; G = null; seq = null; fx = null; audioMode = false;
    },
  };
  return api;
}

/**
 * Render a song (and optional SFX) offline for analysis/tests.
 * events: [{ at: seconds, sfx?: name, opts?, intensity?, overdrive? }]
 */
export async function renderOffline({ song = 'run', seconds = 8, intensity = 1, overdrive = false, sampleRate = 48000, events = [], solo = null } = {}) {
  const octx = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);
  const G = createGraph(octx);
  G.solo = solo;
  const seq = createSequencer(G);
  const fx = createSfx(G);
  seq.st.inten = intensity;
  if (overdrive) seq.st.od = true;
  const origin = 0.02;
  if (song) seq.request(song, 0, 0);
  const evs = [...events].sort((a, b) => a.at - b.at);
  let ei = 0;
  const steps = Math.floor((seconds - origin) / STEP);
  for (let n = 0; n < steps; n++) {
    const t = n * STEP + origin;
    while (ei < evs.length && evs[ei].at <= t) {
      const e = evs[ei++];
      if (e.intensity !== undefined) seq.st.inten = e.intensity;
      if (e.overdrive !== undefined) seq.setOd(e.overdrive);
      if (e.sfx) fx.play(e.sfx, e.opts || {}, e.at);
    }
    seq.step(n, t);
  }
  return octx.startRendering();
}

export function analyseBuffer(buf) {
  let peak = 0, sum = 0, clips = 0, n = 0;
  const win = Math.floor(buf.sampleRate * 0.4);
  let maxWinRms = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    let ws = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clips++;
      sum += d[i] * d[i];
      ws += d[i] * d[i];
      if (i >= win) ws -= d[i - win] * d[i - win];
      if (i % 512 === 0 && i >= win) maxWinRms = Math.max(maxWinRms, Math.sqrt(ws / win));
      n++;
    }
  }
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / n)), maxShortRmsDb: db(maxWinRms), clippedSamples: clips, peak };
}
