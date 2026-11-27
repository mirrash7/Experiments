// Audio lab: manual test page + instrumentation used by the headless soak test (window.__lab).
import { createAudio, renderOffline, analyseBuffer, SONG_IDS, SFX_NAMES } from './index.js';

const audio = createAudio();
const $ = (id) => document.getElementById(id);
const BEAT = audio.clock.beatDur;

// ---------------------------------------------------------------- timing instrumentation
const D = {
  beatLate: [], // ms
  markerErr: [], // ms
  driftHist: [], // [t, ms]
  lateSum: 0, lateMax: 0, lateN: 0, lateAbsMax: 0,
  markerMaxAbs: 0, markerN: 0,
  nonMonotonic: 0, lastNow: -1,
};
const dots = [...document.querySelectorAll('.dot')];
audio.clock.onBeat((b) => {
  const late = performance.now() - audio.clock.toPerf(b * BEAT);
  D.lateN++; D.lateSum += late; D.lateMax = Math.max(D.lateMax, late); D.lateAbsMax = Math.max(D.lateAbsMax, Math.abs(late));
  D.beatLate.push(late); if (D.beatLate.length > 400) D.beatLate.shift();
  const d = dots[((b % 4) + 4) % 4];
  d.classList.add('flash');
  setTimeout(() => d.classList.remove('flash'), 90);
});

let markerReady = false;
async function setupMarker() {
  if (markerReady || !audio.ctx) return;
  markerReady = true;
  const ctx = audio.ctx;
  const code = `class M extends AudioWorkletProcessor{constructor(){super();this.prev=0}
    process(ins){const x=ins[0]&&ins[0][0];if(x){for(let i=0;i<x.length;i++){const v=x[i];if(v>0.5&&this.prev<=0.5)this.port.postMessage(currentTime+i/sampleRate);this.prev=v}}return true}}
    registerProcessor('onset-marker',M)`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, 'onset-marker', { numberOfInputs: 1, numberOfOutputs: 1 });
  const sink = new GainNode(ctx, { gain: 0 });
  node.connect(sink); sink.connect(ctx.destination);
  node.port.onmessage = (e) => {
    const onset = e.data, o = audio._debug.origin;
    const b = Math.round((onset - o) / BEAT);
    const err = (onset - (b * BEAT + o)) * 1000;
    D.markerN++; D.markerMaxAbs = Math.max(D.markerMaxAbs, Math.abs(err));
    D.markerErr.push(err); if (D.markerErr.length > 400) D.markerErr.shift();
  };
  audio._debug.setMarker(node);
}

// ---------------------------------------------------------------- UI
async function doUnlock() { await audio.unlock(); await setupMarker(); $('unlock').textContent = 'Audio: ' + audio.ctx.state; }
$('unlock').onclick = doUnlock;

for (const id of [...SONG_IDS, 'stop']) {
  const b = document.createElement('button');
  b.textContent = id === 'stop' ? 'Stop (fade)' : id;
  b.onclick = async () => {
    await doUnlock();
    if (id === 'stop') audio.stopSong({ fadeMs: 1200 });
    else audio.playSong(id);
  };
  $('songs').appendChild(b);
}
for (const v of [0, 0.25, 0.5, 0.75, 1]) {
  const b = document.createElement('button');
  b.textContent = v.toFixed(2);
  b.onclick = () => setInten(v);
  $('intens').appendChild(b);
}
function setInten(v) { audio.setIntensity(v); $('inten').value = v; $('intenV').textContent = (+v).toFixed(2); }
$('inten').oninput = (e) => setInten(+e.target.value);
let od = false;
$('od').onclick = () => { od = !od; audio.setOverdrive(od); $('od').classList.toggle('on', od); if (od) audio.sfx('overdrive'); };
const vol = () => audio.setVolume({ master: +$('vMaster').value, music: +$('vMusic').value, sfx: +$('vSfx').value });
for (const id of ['vMaster', 'vMusic', 'vSfx']) $(id).oninput = vol;

let hum = null;
for (const name of SFX_NAMES) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = async () => {
    await doUnlock();
    const o = { pan: +$('pan').value, pitch: +$('pitch').value };
    if (name === 'chargeHum') {
      if (hum) { hum.stop(); hum = null; b.classList.remove('on'); }
      else { hum = audio.sfxLoop('chargeHum', o); b.classList.add('on'); }
      return;
    }
    if ($('quant').checked) o.at = Math.ceil(audio.clock.beat()) * BEAT;
    audio.sfx(name, o);
  };
  $('sfx').appendChild(b);
}

// ---------------------------------------------------------------- readouts
const fmt = (x, d = 2) => (typeof x === 'number' ? (Number.isFinite(x) ? x.toFixed(d) : String(x)) : String(x));
let analyser = null, abuf = null;
function stats() {
  const s = audio.stats();
  return {
    ...s,
    beatLateAvgMs: D.lateN ? D.lateSum / D.lateN : 0, beatLateMaxMs: D.lateMax, beatLateAbsMaxMs: D.lateAbsMax, beatCallbacks: D.lateN,
    markerN: D.markerN, markerMaxAbsErrMs: D.markerMaxAbs, nonMonotonic: D.nonMonotonic,
  };
}
function render() {
  const t = audio.clock.now();
  if (t < D.lastNow) D.nonMonotonic++;
  D.lastNow = t;
  const s = stats();
  $('pos').textContent = `t=${t.toFixed(2)}s  beat ${Math.floor(s.beat)}  bar ${Math.floor(s.beat / 4)}  ${s.song || '—'}`;
  if (s.clockDriftMs !== undefined && (!D.driftHist.length || t - D.driftHist[D.driftHist.length - 1][0] > 0.5)) {
    D.driftHist.push([t, s.clockDriftMs]); if (D.driftHist.length > 400) D.driftHist.shift();
  }
  const rows = [
    ['ctx state', s.state], ['song / intensity / OD', `${s.song || '—'} / ${fmt(s.intensity)} / ${s.overdrive}`],
    ['song time (s)', fmt(s.songTime, 3)], ['latency (ms)', fmt(s.latencyMs, 1) + (s.usingOutputTimestamp ? ' (outputTimestamp)' : ' (fallback)')],
    ['clock drift since anchor (ms)', fmt(s.clockDriftMs ?? 0, 2)], ['audio vs perf clock (ppm)', fmt(s.audioVsPerfPpm ?? 0, 1)],
    ['K hard resyncs / anchors', `${s.resyncs} / ${s.anchors}`],
    ['onBeat late avg / max (ms)', `${fmt(s.beatLateAvgMs)} / ${fmt(s.beatLateMaxMs)}`],
    ['marker onset err max (ms)', `${fmt(s.markerMaxAbsErrMs, 3)} (n=${s.markerN})`],
    ['scheduler min margin (ms)', fmt(s.minMarginMs, 1)], ['late steps', s.lateSteps],
    ['tick avg / max (ms)', `${fmt(s.tickAvgMs, 3)} / ${fmt(s.tickMaxMs, 2)}`], ['sfx call avg / max (ms)', `${fmt(s.sfxAvgMs, 3)} / ${fmt(s.sfxMaxMs, 2)}`],
    ['live sources', s.liveSources], ['sfx voices', s.sfxVoices], ['timer', s.timer], ['lookahead (s)', s.lookahead],
  ];
  $('stats').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  plot();
  meter();
  requestAnimationFrame(render);
}
function plot() {
  const c = $('plot'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#2b3342'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  const line = (arr, col, scale) => {
    if (arr.length < 2) return;
    g.strokeStyle = col; g.beginPath();
    arr.forEach((v, i) => { const x = (i / (arr.length - 1)) * W, y = H / 2 - Math.max(-1, Math.min(1, v / scale)) * (H / 2 - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  };
  line(D.beatLate, '#ffb547', 20);
  line(D.driftHist.map((d) => d[1]), '#4ade80', 20);
  line(D.markerErr, '#60a5fa', 20);
  g.fillStyle = '#8b98a5'; g.font = '10px system-ui'; g.fillText('±20 ms', 4, 11);
}
function meter() {
  const G = audio._debug.graph;
  if (!G) return;
  if (!analyser) { analyser = new AnalyserNode(audio.ctx, { fftSize: 2048 }); G.out.connect(analyser); abuf = new Float32Array(2048); }
  analyser.getFloatTimeDomainData(abuf);
  let pk = 0, ss = 0;
  for (const v of abuf) { const a = Math.abs(v); if (a > pk) pk = a; ss += v * v; }
  const rms = Math.sqrt(ss / abuf.length);
  const c = $('meter'), g = c.getContext('2d'), W = c.width;
  const x = (db) => Math.max(0, Math.min(1, (db + 48) / 48)) * W;
  g.clearRect(0, 0, W, 40);
  g.fillStyle = '#4ade80'; g.fillRect(0, 4, x(20 * Math.log10(rms + 1e-9)), 14);
  g.fillStyle = pk > 0.99 ? '#f87171' : '#ffb547'; g.fillRect(0, 22, x(20 * Math.log10(pk + 1e-9)), 14);
}
requestAnimationFrame(render);

// ---------------------------------------------------------------- offline check
async function offline() {
  const out = {};
  const ev = [{ at: 1, sfx: 'punchHit' }, { at: 1.5, sfx: 'shatter' }, { at: 2, sfx: 'perfect' }, { at: 3, sfx: 'blast' },
    { at: 4, sfx: 'bossHit' }, { at: 4.5, overdrive: true }, { at: 5, sfx: 'overdrive' }, { at: 6, sfx: 'kickHit' }];
  for (const song of SONG_IDS) out[song] = analyseBuffer(await renderOffline({ song, seconds: 8, intensity: 1, events: ev }));
  out.runLowNoSfx = analyseBuffer(await renderOffline({ song: 'run', seconds: 8, intensity: 0 }));
  out.sfxOnly = analyseBuffer(await renderOffline({ song: null, seconds: 4, events: [{ at: 0.1, sfx: 'blast' }, { at: 0.12, sfx: 'bossRoar' }, { at: 0.15, sfx: 'punchHit' }, { at: 0.2, sfx: 'victory' }] }));
  // compressor look-ahead measurement: impulse through a DynamicsCompressor
  const o = new OfflineAudioContext(1, 4800, 48000);
  const b = o.createBuffer(1, 4800, 48000); b.getChannelData(0)[100] = 0.5;
  const src = new AudioBufferSourceNode(o, { buffer: b });
  const comp = new DynamicsCompressorNode(o, { threshold: -12, knee: 6, ratio: 4, attack: 0.003, release: 0.16 });
  src.connect(comp); comp.connect(o.destination); src.start();
  const r = (await o.startRendering()).getChannelData(0);
  let pi = 0; for (let i = 0; i < r.length; i++) if (Math.abs(r[i]) > Math.abs(r[pi])) pi = i;
  out.compressorDelayMs = ((pi - 100) / 48000) * 1000;
  return out;
}
$('offline').onclick = async () => {
  $('offOut').textContent = 'rendering…';
  const r = await offline();
  $('offOut').textContent = JSON.stringify(r, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v), 1);
};

window.__lab = { audio, stats, D, offline, doUnlock, setInten };
