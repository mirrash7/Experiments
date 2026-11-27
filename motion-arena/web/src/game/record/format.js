// BREAKLIGHT playtest session format (shared by recorder.js, sessionSource.js and motion/replayBench.js; node + browser).
//
// A session file is gzip-compressed JSON (`breaklight-session-<date>.json.gz`):
//   { format: 'breaklight-session', version: 1, created, t0, f0, meta, layout, quant, frames: [...], events: [...], summary }
// Times are ms relative to t0 (the recording page's performance.now() at recorder start). Every event carries the
// absolute index of the next tracker frame (`f`), so frame / event order is exact on replay.
//
// Frames are quantised and delta-coded (each channel is the difference to the previous frame's channel when both
// exist with the same length, else absolute):
//   t   capture time, 0.1 ms ints (delta to the previous frame; the first is relative to t0)
//   p   push time - capture time, 0.1 ms (when the frame reached the motion pipeline / detector)
//   s   source index into layout.sources (omitted = 0)
//   j   joints (layout.joints order), mm, xyz        c   conf x100 (255 = joint missing, 254 = no conf value)
//   x   extra joints (layout.extra), mm               xc  their conf
//   k   kp2d, x and y x1e4, c x100 (triples)
//   m   MHR params x1e5        ct  camT x1e4        fo  focal (px)        d3  raw j3d (mm, only with record=full)
//   h   handState {left, right} (sources that classify hands themselves)
// A frame with no body has no j / c channels.
import * as THREE from 'three';

export const FORMAT = 'breaklight-session';
export const VERSION = 1;
export const QUANT = { pos: 1000, conf: 100, kp: 10000, mhr: 1e5, camT: 1e4, time: 10 };
const MISSING = 255, NOCONF = 254;

/** Mutable layout shared by the encoder: joint / extra / source name tables that grow as new names appear. */
export function createLayout() {
  return { joints: [], extra: [], sources: [], _j: new Map(), _x: new Map(), _s: new Map() };
}
export function layoutJSON(L) { return { joints: L.joints, extra: L.extra, sources: L.sources }; }

function idx(map, list, name) {
  let i = map.get(name);
  if (i === undefined) { i = list.length; list.push(name); map.set(name, i); }
  return i;
}

function encPoints(obj, conf, map, list) {
  for (const k in obj) if (obj[k]) idx(map, list, k);
  const n = list.length;
  const P = new Int32Array(3 * n), C = new Uint8Array(n).fill(MISSING);
  for (const k in obj) {
    const v = obj[k]; if (!v) continue;
    const i = map.get(k);
    P[3 * i] = Math.round(v.x * 1000); P[3 * i + 1] = Math.round(v.y * 1000); P[3 * i + 2] = Math.round(v.z * 1000);
    const c = conf?.[k];
    C[i] = c == null || !Number.isFinite(c) ? NOCONF : Math.max(0, Math.min(100, Math.round(c * 100)));
  }
  return [P, C];
}

/**
 * Quantise one PoseFrame (cheap: a few hundred integer ops, typed arrays only). `pushT` = performance.now() when the
 * frame reached the detector. Returns a compact record (typed arrays) + its byte size for the ring buffer.
 */
export function encodeFrame(f, pushT, t0, L, { full = false } = {}) {
  const tc = f.tCapture ?? pushT;
  const r = { t: Math.round((tc - t0) * 10), p: Math.round((pushT - tc) * 10), s: 0, bytes: 48 };
  const src = f.source ?? 'unknown';
  let si = L._s.get(src);
  if (si === undefined) {
    si = L.sources.length; L._s.set(src, si);
    L.sources.push({ name: src, edges: f.edges ?? null, absolute: f.absolute ?? null });
  }
  r.s = si;
  if (f.joints) {
    [r.j, r.c] = encPoints(f.joints, f.conf, L._j, L.joints);
    r.bytes += r.j.byteLength + r.c.byteLength;
  }
  if (f.extra) {
    [r.x, r.xc] = encPoints(f.extra, f.conf, L._x, L.extra);
    r.bytes += r.x.byteLength + r.xc.byteLength;
  }
  const K = f.kp2d;
  if (K && K.length) {
    const k = new Int16Array(3 * K.length);
    for (let i = 0; i < K.length; i++) {
      const q = K[i];
      k[3 * i] = Math.max(-32767, Math.min(32767, Math.round(q.x * 1e4)));
      k[3 * i + 1] = Math.max(-32767, Math.min(32767, Math.round(q.y * 1e4)));
      k[3 * i + 2] = Math.round((q.c ?? 1) * 100);
    }
    r.k = k; r.bytes += k.byteLength;
  }
  if (f.mhr) {
    const m = new Int32Array(f.mhr.length);
    for (let i = 0; i < m.length; i++) m[i] = Math.round(f.mhr[i] * 1e5);
    r.m = m; r.bytes += m.byteLength;
  }
  if (f.camT) { r.ct = [Math.round(f.camT[0] * 1e4), Math.round(f.camT[1] * 1e4), Math.round(f.camT[2] * 1e4)]; r.bytes += 24; }
  if (f.focal != null) r.fo = Math.round(f.focal * 10) / 10;
  if (f.handState) { r.h = { left: f.handState.left ?? null, right: f.handState.right ?? null }; r.bytes += 32; }
  if (full && f.j3d) {
    const d = new Int32Array(3 * f.j3d.length);
    for (let i = 0; i < f.j3d.length; i++) { const j = f.j3d[i]; d[3 * i] = Math.round(j[0] * 1000); d[3 * i + 1] = Math.round(j[1] * 1000); d[3 * i + 2] = Math.round(j[2] * 1000); }
    r.d3 = d; r.bytes += d.byteLength;
  }
  return r;
}

const CH = ['j', 'c', 'x', 'xc', 'k', 'm', 'd3'];

/** Encoded frame records -> JSON-ready rows (delta-coded). */
export function* frameRows(records) {
  let prev = null, prevT = 0;
  for (const r of records) {
    const o = { t: r.t - prevT, p: r.p };
    prevT = r.t;
    if (r.s) o.s = r.s;
    for (const ch of CH) {
      const a = r[ch]; if (!a) continue;
      const b = prev?.[ch];
      if (b && b.length === a.length) { const d = new Array(a.length); for (let i = 0; i < a.length; i++) d[i] = a[i] - b[i]; o[ch] = d; }
      else o[ch] = Array.from(a);
    }
    if (r.ct) o.ct = r.ct;
    if (r.fo != null) o.fo = r.fo;
    if (r.h) o.h = r.h;
    prev = r;
    yield o;
  }
}

/** Inverse of frameRows: rows -> absolute int arrays (plain arrays) + absolute t. */
export function undeltaRows(rows) {
  const out = new Array(rows.length);
  let prev = null, t = 0;
  for (let n = 0; n < rows.length; n++) {
    const o = rows[n];
    t += o.t;
    const r = { t, p: o.p, s: o.s ?? 0, ct: o.ct, fo: o.fo, h: o.h };
    for (const ch of CH) {
      const a = o[ch]; if (!a) continue;
      const b = prev?.[ch];
      if (b && b.length === a.length) { const d = new Array(a.length); for (let i = 0; i < a.length; i++) d[i] = a[i] + b[i]; r[ch] = d; }
      else r[ch] = a;
    }
    out[n] = r; prev = r;
  }
  return out;
}

function decPoints(P, C, names, joints, conf) {
  const n = Math.min(names.length, C.length);
  for (let i = 0; i < n; i++) {
    const c = C[i];
    if (c === MISSING) continue;
    joints[names[i]] = new THREE.Vector3(P[3 * i] / 1000, P[3 * i + 1] / 1000, P[3 * i + 2] / 1000);
    if (c !== NOCONF) conf[names[i]] = c / 100;
  }
}

/**
 * One absolute row -> canonical PoseFrame. Times are returned in the RECORDING's timebase (ms relative to t0) as
 * tCapture / tPush; callers re-stamp them (live replay) or use them as the simulated clock (replayBench).
 */
export function rowToFrame(r, layout, shape = null) {
  const srcInfo = layout.sources[r.s] ?? { name: 'unknown' };
  const tCapture = r.t / 10;
  const f = { source: srcInfo.name, tCapture, tPush: tCapture + r.p / 10, tArrive: tCapture + r.p / 10, joints: null, conf: {}, kp2d: [], edges: srcInfo.edges, absolute: srcInfo.absolute, recorded: true };
  if (r.c) { f.joints = {}; decPoints(r.j, r.c, layout.joints, f.joints, f.conf); }
  if (r.xc) { f.extra = {}; decPoints(r.x, r.xc, layout.extra, f.extra, f.conf); }
  if (r.k) {
    const k = r.k, K = new Array(k.length / 3);
    for (let i = 0; i < K.length; i++) K[i] = { x: k[3 * i] / 1e4, y: k[3 * i + 1] / 1e4, c: k[3 * i + 2] / 100 };
    f.kp2d = K;
    if (f.source === 'hmr') f.kpConf = K.map((q) => q.c);
  }
  if (r.m) { f.mhr = Float32Array.from(r.m, (x) => x / 1e5); f.shape = shape; }
  if (r.ct) f.camT = [r.ct[0] / 1e4, r.ct[1] / 1e4, r.ct[2] / 1e4];
  if (r.fo != null) f.focal = r.fo;
  if (r.h) f.handState = r.h;
  if (r.d3) {
    const d = r.d3, J = new Array(d.length / 3);
    for (let i = 0; i < J.length; i++) J[i] = [d[3 * i] / 1000, d[3 * i + 1] / 1000, d[3 * i + 2] / 1000];
    f.j3d = J;
    f.kp3d = J.map((j) => new THREE.Vector3(j[0], -j[1], -j[2]));
  }
  return f;
}

/**
 * Parsed session JSON -> { header, frames: PoseFrame[] (recording timebase), events: [{t, f (frame index in this
 * file), type, ...data}] }. Shape vectors come from 'shape' events and are attached to the following MHR frames.
 */
export function decodeSession(json) {
  if (json?.format !== FORMAT) throw new Error(`not a ${FORMAT} file (format: ${json?.format})`);
  const rows = undeltaRows(json.frames);
  const f0 = json.f0 ?? 0;
  const events = json.events.map(([t, f, type, data]) => { const e = { ...(data ?? {}), t, f: f - f0, type }; if (data && 'type' in data) e.ntype = data.type; return e; });   // a note's own type -> ntype
  let shape = null, ei = 0;
  const shapes = events.filter((e) => e.type === 'shape');
  const frames = rows.map((r, i) => {
    while (ei < shapes.length && shapes[ei].f <= i) shape = Float32Array.from(shapes[ei++].v, (x) => x / 1e4);
    return rowToFrame(r, json.layout, shape);
  });
  return { header: { ...json, frames: undefined, events: undefined }, frames, events };
}

/** gzip / plain JSON bytes -> parsed JSON (node: zlib; browser: DecompressionStream). */
export async function parseSessionBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    if (typeof DecompressionStream !== 'undefined') {
      const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
      text = await new Response(s).text();
    } else {
      const zlib = await import('node:zlib');
      text = zlib.gunzipSync(u8).toString('utf8');
    }
  } else text = new TextDecoder().decode(u8);
  return JSON.parse(text);
}

/** Load + decode a session: a URL (browser fetch), a File / Blob, or a path (node). */
export async function loadSession(src) {
  let bytes;
  if (typeof Blob !== 'undefined' && src instanceof Blob) bytes = new Uint8Array(await src.arrayBuffer());
  else if (typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined') {
    const fs = await import('node:fs');
    bytes = fs.readFileSync(src);
  } else {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`session ${src}: HTTP ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  return decodeSession(await parseSessionBytes(bytes));
}
