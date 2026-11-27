// BREAKLIGHT playtest recorder (?record=1): captures what a real-webcam playtest needs to become regression data.
//
//   const rec = createRecorder({ source, motion, bus, getMeta, game });
//
// Records, on the page's performance.now() timebase:
//   - every raw tracker frame as it reaches the detector (joints, conf, kp2d, extra palm points, MHR params, camT,
//     focal, tCapture + push time; quantised, ~1.5 KB / frame in memory, see format.js), wrapped around motion.push
//   - detector events (name, side, tCapture, speed, score, ...), detector stat changes (punchNearMiss, suppressed
//     punches by reason), recalibrations and detector flag changes (seated, kneeStrike, sensitivity)
//   - spirit spawns and judgements (note type / move / side, target time on the capture timebase, outcome, error, how),
//     Awakening phases (wait / coach / loose / auto / resolved), state changes, pauses, knockdowns, distance warnings
//   - a 1 s sample of fps / frame time / tracker fps + latency / motion cost, and the settings + tracker meta
// Memory is a ring buffer capped at `maxMB` (default 64 MB of frames, ~20 min at 30 Hz); the oldest frames drop first.
// Saving (R key, `rec.save()`, and automatically on each results screen) writes a gzip JSON download
// `breaklight-session-<date>.json.gz`. Everything stays on this machine: nothing is uploaded. Pose data only, never
// camera images. Per-frame cost: one quantisation pass into typed arrays (~10-30 us).
//
// `source` is optional (a tracker source or a getter returning the current one, only used for its model name).
// `game` is optional but needed for note target times (judge + clock) and pause reasons.
import { createLayout, layoutJSON, encodeFrame, frameRows, FORMAT, VERSION, QUANT } from './format.js';

const BUS_TYPES = ['state', 'act', 'pause', 'resume', 'knockdown:fx', 'distance', 'boss', 'blast', 'newPlayer', 'settings:change', 'overdrive', 'breather', 'notice', 'quality'];

/** True when the URL asks for recording (?record=1 / ?record=full). */
export function recordingRequested(params = new URLSearchParams(globalThis.location?.search ?? '')) {
  const v = params.get('record');
  return v != null && v !== '0' && v !== 'false';
}

export function createRecorder({ source = null, motion, bus, getMeta = () => ({}), game = null, maxMB = null, autoSave = true, badge = true, hotkey = 'r', params = null } = {}) {
  if (!motion?.actions) throw new Error('createRecorder: motion pipeline (with .actions) required');
  const P = params ?? new URLSearchParams(globalThis.location?.search ?? '');
  const full = P.get('record') === 'full';
  const capBytes = (maxMB ?? (+P.get('recordMB') || 64)) * 1024 * 1024;
  const now = () => performance.now();
  const t0 = now();
  const rel = (t) => Math.round((t - t0) * 10) / 10;
  const L = createLayout();
  let frames = [], head = 0, bytes = 0, fAbs = 0, f0 = 0, dropped = 0;
  let events = [];
  const MAX_EVENTS = 400000;
  const ids = new WeakMap(); let nextId = 1;
  const nid = (n) => { if (!n) return null; let i = ids.get(n); if (!i) { i = nextId++; ids.set(n, i); } return i; };
  const ev = (type, data) => {
    events.push([rel(now()), fAbs, type, data ?? null]);
    if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS * 0.9);
  };
  const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
  const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
  const det = motion.actions;
  let active = true, lastSaveAt = t0, saves = 0;
  const offs = [];

  // ------------------------------------------------------------------ frames (wrap motion.push: every source path)
  const origPush = motion.push;
  let lastShape = null;
  motion.push = function recPush(f) {
    if (active && f) {
      try {
        const pt = now();
        if (f.shape && f.shape !== lastShape) {
          lastShape = f.shape;
          ev('shape', { v: Array.from(f.shape, (x) => Math.round(x * 1e4)) });
        }
        const r = encodeFrame(f, pt, t0, L, { full });
        frames.push(r); bytes += r.bytes; fAbs++;
        while (bytes > capBytes && frames.length - head > 1) { bytes -= frames[head].bytes; frames[head++] = null; f0++; dropped++; }
        if (head > 4096) { frames = frames.slice(head); head = 0; }
      } catch (e) { if (!recPush._warned) { recPush._warned = true; console.warn('[record] frame encode failed', e); } }
    }
    return origPush.call(this, f);
  };

  // ------------------------------------------------------------------ detector
  offs.push(det.on((name, info) => {
    if (!active) return;
    ev('det', { n: name, tc: r1(info.tCapture != null ? info.tCapture - t0 : null), t: r1(info.t - t0), side: info.side, sp: r3(info.speed), sc: r3(info.score), ext: r3(info.ext), knee: info.knee || undefined, cf: info.confirmed || undefined, seated: info.seated || undefined });
  }));
  const origRecal = det.recalibrate;
  det.recalibrate = function recRecal(...a) { if (active) { checkDet(); ev('recal', {}); } return origRecal.apply(this, a); };
  let flags = '', statKey = '';
  const checkDet = () => {
    const fl = JSON.stringify({ seated: !!det.seated, kneeStrike: !!det.kneeStrike, sensitivity: det.sensitivity });
    if (fl !== flags) { flags = fl; ev('flags', JSON.parse(fl)); }
    const st = det.stats;
    if (st) {
      const k = JSON.stringify(st);
      if (k !== statKey) { statKey = k; ev('stat', { near: st.punchNearMiss, sup: { ...st.suppressed } }); }
    }
  };
  // stat counters change inside update(): check right after each detector update (cheap string compare only on change)
  const origPushFrame = det.pushFrame;
  det.pushFrame = function recPushFrame(f) {
    const r = origPushFrame.call(this, f);
    if (active && det.stats && (det.stats.punchNearMiss !== checkDet._n || sumSup(det.stats) !== checkDet._s)) {
      checkDet._n = det.stats.punchNearMiss; checkDet._s = sumSup(det.stats); checkDet();
    }
    return r;
  };
  function sumSup(st) { let s = 0; for (const k in st.suppressed) s += st.suppressed[k]; return s; }

  // ------------------------------------------------------------------ game events
  const noteData = (n) => n && ({
    id: nid(n), type: n.type, move: n.move, side: n.side, beat: r3(n.beat), act: n.act, react: n.react || undefined,
    wait: n.waitFor || undefined, sec: n.section, boss: n.boss || undefined,
  });
  const notePerf = (n) => {
    try { return game?.judge && game?.clock ? rel(game.clock.toPerf(game.judge.noteTime(n))) : null; } catch { return null; }
  };
  if (bus) {
    offs.push(bus.on('spawn', ({ note }) => active && ev('spawn', { ...noteData(note), tn: notePerf(note) })));
    offs.push(bus.on('judge', (j) => {
      if (!active) return;
      const n = j.note;
      const S = game?.ctx?.settings ?? game?.settings;
      ev('judge', {
        ...noteData(n), kind: j.kind, err: r1(j.errMs), how: j.how, hurt: j.hurt || undefined, wrong: j.wrong || undefined,
        tn: notePerf(n), off: S?.judgeOffsetMs || 0, cue: n?.cuePerf ? rel(n.cuePerf) : undefined, phase: n?.phase, assisted: n?.assisted || undefined,
        awk: game?.awk ? { waiting: game.awk.waiting === n, offset: r3(game.awk.offset) } : undefined,
      });
      checkWin();
    }));
    offs.push(bus.on('awaken', (a) => {
      if (!active) return;
      const d = { phase: a.phase, move: a.move ?? a.note?.move, type: a.type ?? a.note?.type, side: a.side ?? a.note?.side, sec: a.section ?? a.note?.section, id: nid(a.note), completed: a.completed };
      if (a.phase === 'wait' && a.note) d.tn = notePerf(a.note);
      ev('awaken', d);
    }));
    for (const type of BUS_TYPES) {
      offs.push(bus.on(type, (d) => {
        if (!active) return;
        let data = null;
        if (type === 'state') data = { from: d?.from, to: d?.to };
        else if (type === 'act') data = { act: d?.act };
        else if (type === 'pause') data = { reason: game?.paused?.reason ?? null, manual: !!game?.paused?.manual };
        else if (type === 'distance') data = { state: d?.state, big: d?.bigMove || undefined };
        else if (type === 'boss') data = { phase: d?.phase, hp: d?.hp, stage: d?.stage };
        else if (type === 'knockdown:fx') data = { count: d?.count };
        else if (type === 'settings:change') data = { key: d?.key, value: typeof d?.value === 'object' ? null : d?.value };
        else if (type === 'overdrive') data = { on: !!d?.on };
        else if (type === 'notice') data = { phase: d?.phase };
        else if (type === 'quality') data = { preset: d?.preset, dpr: d?.dpr };
        ev(type === 'knockdown:fx' ? 'knockdown' : type === 'settings:change' ? 'settings' : type, data);
        if (type === 'state' && d?.to === 'results' && autoSave) setTimeout(() => save({ reason: 'results', clear: true }), 1500);
      }));
    }
    // charge "busy" transitions (live punches are ignored while the charge is busy: the blast push reads as a jab)
    let busy = false;
    offs.push(bus.on('charge', (d) => {
      const b = (d?.level ?? 0) > 0.5 || !!d?.charged;
      if (active && b !== busy) { busy = b; ev('busy', { on: b }); }
    }));
    offs.push(bus.on('replay', (d) => { if (active && (d?.phase === 'start' || d?.phase === 'end')) ev('replay', { phase: d.phase }); }));
  }
  let winKey = '';
  function checkWin() {
    const w = game?.judge?.win;
    if (!w) return;
    const k = `${w.perfect}|${w.great}|${w.good}|${game.judge.tracker}`;
    if (k !== winKey) { winKey = k; ev('win', { perfect: w.perfect, great: w.great, good: w.good, tracker: game.judge.tracker }); }
  }

  // ------------------------------------------------------------------ 1 s samples
  const metaNow = () => {
    let m = {};
    try { m = getMeta() ?? {}; } catch (e) { m = { metaError: String(e) }; }
    return m;
  };
  const sampleTimer = setInterval(() => {
    if (!active) return;
    checkDet(); checkWin();
    const m = metaNow(), s = m.snap ?? m;
    const perf = game?.ctx?.perf;
    ev('fps', {
      fps: s.fps ?? perf?.fps, fms: r1(s.frameMs ?? perf?.frameMs), fmax: r1(s.frameMax ?? perf?.frameMax), q: s.quality,
      tfps: s.trackFps ?? game?.tracking?.fps, lat: r1(s.trackLat ?? game?.tracking?.lat), mms: r3(s.motionMs ?? perf?.motionMs),
      lost: r1(s.lostFor ?? game?.tracking?.lostFor), st: s.state ?? game?.state,
    });
    updateBadge();
  }, 1000);

  // ------------------------------------------------------------------ meta
  function fullMeta() {
    const m = metaNow();
    const src = typeof source === 'function' ? source() : source ?? game?.tracking?.source;
    const S = game?.ctx?.settings;
    return {
      ...m,
      tracker: m.tracker ?? game?.tracking?.kind ?? null,
      model: m.model ?? src?.model ?? null,
      settings: m.settings ?? (S ? strip(S) : undefined),
      windows: game?.judge?.win ?? undefined,
      bpm: game?.clock?.bpm,
      detector: { seated: !!det.seated, kneeStrike: !!det.kneeStrike, sensitivity: det.sensitivity, stats: det.stats },
      awakeningLog: game?.awkLog ?? undefined,
      results: game?.lastResults ? strip(game.lastResults) : undefined,
      url: globalThis.location ? location.pathname + location.search : undefined,
      userAgent: globalThis.navigator?.userAgent,
      screen: globalThis.innerWidth ? [innerWidth, innerHeight, globalThis.devicePixelRatio] : undefined,
      recordFull: full,
    };
  }
  const startMeta = fullMeta();
  checkDet(); checkWin();

  // ------------------------------------------------------------------ save
  function summary() {
    const live = frames.slice(head);
    const j = {}; let nJ = 0;
    for (const e of events) if (e[2] === 'judge') { j[e[3].kind] = (j[e[3].kind] ?? 0) + 1; nJ++; }
    const dur = live.length ? (live[live.length - 1].t - live[0].t) / 10000 : 0;
    return { frames: live.length, droppedFrames: dropped, seconds: Math.round(dur), events: events.length, judgements: nJ, kinds: j, memMB: +(bytes / 1048576).toFixed(1) };
  }
  async function encode({ clear = false } = {}) {
    const live = frames.slice(head);
    const evs = events;
    const header = {
      format: FORMAT, version: VERSION, created: new Date().toISOString(), t0: Math.round(t0 * 10) / 10, f0, quant: QUANT,
      layout: layoutJSON(L), meta: { start: startMeta, end: fullMeta() }, summary: summary(),
    };
    if (clear) { frames = []; head = 0; bytes = 0; f0 = fAbs; events = []; }
    // stream the JSON in pieces through gzip (no single giant string)
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    const out = new Response(cs.readable).blob();
    const enc = new TextEncoder();
    const head0 = JSON.stringify(header);
    await w.write(enc.encode(head0.slice(0, -1) + ',"frames":['));
    let buf = [], first = true;
    for (const row of frameRows(live)) {
      buf.push(JSON.stringify(row));
      if (buf.length >= 400) { await w.write(enc.encode((first ? '' : ',') + buf.join(','))); first = false; buf = []; }
    }
    if (buf.length) { await w.write(enc.encode((first ? '' : ',') + buf.join(','))); }
    await w.write(enc.encode('],"events":['));
    for (let i = 0; i < evs.length; i += 2000) await w.write(enc.encode((i ? ',' : '') + evs.slice(i, i + 2000).map((e) => JSON.stringify(e)).join(',')));
    await w.write(enc.encode(']}'));
    await w.close();
    return { blob: await out, header };
  }
  async function save({ reason = 'manual', clear = false, download = true } = {}) {
    if (frames.length - head === 0 && !events.length) return null;
    const t = performance.now();
    const { blob, header } = await encode({ clear });
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const name = `breaklight-session-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json.gz`;
    if (download && typeof document !== 'undefined') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    saves++; lastSaveAt = t;
    const s = header.summary;
    console.info(`[record] saved ${name} (${reason}): ${s.frames} frames, ${s.seconds} s, ${s.judgements} judgements ${JSON.stringify(s.kinds)}, ${(blob.size / 1048576).toFixed(2)} MB gz, encode ${Math.round(performance.now() - t)} ms`);
    flash(`saved ${name} · ${(blob.size / 1048576).toFixed(1)} MB`);
    return { name, blob, summary: s };
  }

  // ------------------------------------------------------------------ badge + hotkey
  let el = null, flashUntil = 0, flashText = '';
  if (badge && typeof document !== 'undefined') {
    el = document.createElement('div');
    el.id = 'bl-rec';
    el.title = 'Playtest recording: body-pose numbers and game events only (no camera images). Saved as a local download when you press R or reach the results; nothing is uploaded.';
    el.style.cssText = 'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:10000;opacity:.85;font:600 11px/1.3 ui-monospace,Menlo,monospace;color:#fff;'
      + 'background:#000a;border:1px solid #f446;border-radius:10px;padding:3px 9px;pointer-events:none;user-select:none';
    document.body.appendChild(el);
  }
  function flash(t) { flashText = t; flashUntil = performance.now() + 4000; updateBadge(); }
  function updateBadge() {
    if (!el) return;
    const s = (performance.now() - t0) / 1000;
    const mm = Math.floor(s / 60), ss = String(Math.floor(s % 60)).padStart(2, '0');
    const extra = performance.now() < flashUntil ? ` · ${flashText}` : ` · ${(bytes / 1048576).toFixed(1)} MB · R save`;
    el.innerHTML = `<span style="color:#f44">●</span> REC ${mm}:${ss}${extra}`;
  }
  updateBadge();
  const onKey = (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT' || e.repeat) return;
    if (e.key?.toLowerCase() === hotkey) save({ reason: 'hotkey' });
  };
  if (hotkey && typeof addEventListener !== 'undefined') addEventListener('keydown', onKey);
  console.info('[record] playtest recording ON: pose numbers + game events, kept in memory, saved locally with R / on results (nothing is uploaded)');

  function stop() {
    active = false;
    clearInterval(sampleTimer);
    for (const o of offs) o?.();
    if (motion.push?.name === 'recPush') motion.push = origPush;
    if (det.recalibrate.name === 'recRecal') det.recalibrate = origRecal;
    if (det.pushFrame.name === 'recPushFrame') det.pushFrame = origPushFrame;
    globalThis.removeEventListener?.("keydown", onKey);
    el?.remove();
  }

  return {
    save, encode, stop, summary,
    /** Add a custom event (e.g. a hand-written note from the console: rec.mark('fell over')). */
    mark: (text, data) => ev('mark', { text, ...(data ?? {}) }),
    get t0() { return t0; },
    get frameCount() { return frames.length - head; },
    get bytes() { return bytes; },
    get saves() { return saves; },
    get lastSaveAt() { return lastSaveAt; },
  };
}

function strip(o, depth = 0) {
  if (o == null || typeof o !== 'object') return o;
  if (depth > 3) return undefined;
  if (Array.isArray(o)) return o.length > 64 ? undefined : o.map((x) => strip(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'function' || k.startsWith('_')) continue;
    if (v && typeof v === 'object' && (v.isVector3 || v.isObject3D || (typeof Element !== 'undefined' && v instanceof Element))) continue;
    out[k] = strip(v, depth + 1);
  }
  return out;
}
