// Replay bench: re-runs the CURRENT ActionDetector (and optionally the whole motion pipeline) on a recorded
// BREAKLIGHT playtest session (web/src/game/record/recorder.js) and scores it against the judge expectations recorded
// live, so detector / threshold changes can be regression-tested on real players.
//
//   node web/src/motion/replayBench.js session.json.gz [more.json.gz ...] [--detector=path/to/actions.js]
//        [--pipeline] [--json=out.json] [--notes] [--quiet]
//   browser / motion lab:  const r = await replayBench(await loadSession(url)); console.log(formatReplay(r))
//
// What it does, per session:
//  1. Feeds every recorded tracker frame to a fresh detector on a SIMULATED clock (each frame at its recorded push
//     time; recalibrations and seated / kneeStrike / sensitivity changes applied at the same frame index as live).
//  2. Detector parity: replayed events vs the recorded live detector events (same name, capture time within 1 ms).
//     With an unchanged detector this should be ~100 % (only mm quantisation can flip a borderline frame).
//  3. Offline judge (core/judge.js, the real one, on an identity clock) run twice over the recorded notes (target
//     times on the capture timebase, recorded windows / offset): once with the LIVE detector events (must reproduce
//     the live judge log: the self-check) and once with the REPLAYED events (what the new detector would score).
//     Awakening waits, reaction strikers, brute punch phases, charge-busy punches and menus are handled like the game.
//  4. For every miss, a heuristic split "not detected" (the limb clearly moved: speed / extension / rise / drop / tilt
//     in the window, a detector near miss or a suppressed punch) vs "not attempted" (nothing moved) vs "untracked"
//     (no body in most of the window) vs "wrong side". Video is the ground truth; this only ranks the misses.
//  5. Phantoms: strike events in play that no note consumed, split "wrong side" (a note of the same limb nearby) vs
//     "stray" (nothing of that limb within the window): stray strikes per minute of play is the phantom rate.
import { ActionDetector } from '../actions.js';
import { Judge } from '../game/core/judge.js';
import { LEAD_MS, WINDOWS } from '../game/core/settings.js';
import { loadSession } from '../game/record/format.js';

const IMPULSE = new Set(['punch', 'kick', 'jump']);
const HELD = new Set(['squat', 'dodge', 'guard']);
const PLAY = new Set(['run', 'boss']);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const limbOf = (name) => (name.startsWith('punch') ? 'punch' : name.startsWith('kick') ? 'kick' : name === 'jump' ? 'jump' : null);
const sideOf = (name) => (name.endsWith('Left') ? 'left' : name.endsWith('Right') ? 'right' : null);

// ------------------------------------------------------------------------------------------ detector replay
/**
 * Re-run a detector over the decoded session frames. Returns {events, states (per frame bit masks via judge),
 * stats (near-miss / suppressed increments with capture times), frames}.
 */
export function replayDetector(session, { Detector = ActionDetector, pipeline = null, onFrame = null, clockRef = { t: 0 } } = {}) {
  const { frames, events } = session;
  const det = pipeline ? pipeline.actions : new Detector();
  clockRef.t = frames[0]?.tPush ?? 0;
  det.clock = () => clockRef.t;
  const out = [];
  det.on((name, info) => out.push({ name, tc: info.tCapture, t: info.t, side: info.side, speed: info.speed, score: info.score, knee: info.knee, f: cur }));
  const ctrl = events.filter((e) => e.type === 'recal' || e.type === 'flags').sort((a, b) => a.f - b.f || a.t - b.t);
  const startFlags = session.header.meta?.start?.detector;
  if (startFlags) applyFlags(det, startFlags);
  const statInc = [];
  let ci = 0, cur = 0;
  const near0 = () => det.stats ? { n: det.stats.punchNearMiss, s: { ...det.stats.suppressed } } : null;
  for (cur = 0; cur < frames.length; cur++) {
    const fr = frames[cur];
    while (ci < ctrl.length && ctrl[ci].f <= cur) {
      const e = ctrl[ci++];
      if (e.type === 'flags') applyFlags(det, e);
      else if (pipeline) pipeline.calibrate(); else det.recalibrate();
    }
    clockRef.t = fr.tPush;
    const before = near0();
    if (pipeline) pipeline.push(fr); else det.pushFrame(fr);
    if (before && det.stats) {
      if (det.stats.punchNearMiss > before.n) statInc.push({ tc: fr.tCapture, kind: 'near' });
      for (const k in det.stats.suppressed) if (det.stats.suppressed[k] > (before.s[k] ?? 0)) statInc.push({ tc: fr.tCapture, kind: 'sup:' + k });
    }
    onFrame?.(fr, det, cur);
  }
  return { events: out, statInc, det };
}
function applyFlags(det, f) {
  if (f.seated != null) det.seated = !!f.seated;
  if (f.kneeStrike != null && 'kneeStrike' in det) det.kneeStrike = !!f.kneeStrike;
  if (f.sensitivity != null) det.sensitivity = f.sensitivity;
}

/** Recorded live detector events vs replayed ones (impulses + state entries). */
export function detectorParity(liveEvents, replayEvents, tolMs = 1) {
  const byName = {};
  const used = new Set();
  const key = (e) => e.name;
  const R = replayEvents.map((e, i) => ({ ...e, i }));
  const idx = {};
  for (const e of R) (idx[key(e)] ??= []).push(e);
  let matched = 0;
  const onlyLive = [], dt = [];
  for (const e of liveEvents) {
    const b = (byName[e.name] ??= { live: 0, replay: 0, matched: 0 });
    b.live++;
    const cand = idx[e.name] ?? [];
    let best = null;
    for (const c of cand) {
      if (used.has(c.i) || c.tc == null || e.tc == null) continue;
      const d = Math.abs(c.tc - e.tc);
      if (d <= tolMs + 1e-6 && (!best || d < Math.abs(best.tc - e.tc))) best = c;
    }
    if (best) { used.add(best.i); matched++; b.matched++; dt.push(best.tc - e.tc); } else onlyLive.push(e);
  }
  for (const e of R) (byName[e.name] ??= { live: 0, replay: 0, matched: 0 }).replay++;
  const onlyReplay = R.filter((e) => !used.has(e.i));
  return { live: liveEvents.length, replay: replayEvents.length, matched, onlyLive, onlyReplay, byName, rate: liveEvents.length ? matched / liveEvents.length : 1 };
}

// ------------------------------------------------------------------------------------------ session timeline
function buildTimeline(session) {
  const { events, header } = session;
  const m0 = header.meta?.start ?? {}, m1 = header.meta?.end ?? {};
  const meta = { ...m0, tracker: m1.tracker ?? m0.tracker, model: m1.model ?? m0.model, bpm: m0.bpm ?? m1.bpm };
  const S = m0.settings ?? m1.settings ?? {};
  // judgement windows in effect at a time (the tracker kind can change after boot: 'win' events)
  const winEvs = events.filter((e) => e.type === 'win');
  const base = m1.windows ?? m0.windows ?? WINDOWS.base;
  const winAt = (t) => { let w = null; for (const e of winEvs) { if (e.t <= t) w = e; else break; } w ??= winEvs[0]; return w ? { perfect: w.perfect, great: w.great, good: w.good } : base; };
  const win = winEvs.length ? winAt(Infinity) : base;
  const bpm = meta.bpm || 128;
  // state intervals
  const states = [];
  let st = null, stT = -Infinity;
  for (const e of events) if (e.type === 'state') { states.push({ s: st ?? e.from, a: stT, b: e.t }); st = e.to; stT = e.t; }
  states.push({ s: st, a: stT, b: Infinity });
  const stateAt = (t) => { for (const x of states) if (t >= x.a && t < x.b) return x.s; return null; };
  // charge busy intervals
  const busy = [];
  let bOn = null;
  for (const e of events) if (e.type === 'busy') { if (e.on && bOn == null) bOn = e.t; else if (!e.on && bOn != null) { busy.push([bOn, e.t]); bOn = null; } }
  if (bOn != null) busy.push([bOn, Infinity]);
  const busyAt = (t) => busy.some(([a, b]) => t >= a && t <= b);
  // notes (one judge event per note id; spawn times when known)
  const spawnT = new Map();
  for (const e of events) if (e.type === 'spawn' && e.id != null && !spawnT.has(e.id)) spawnT.set(e.id, e.t);
  const waits = new Map();     // note id -> {start, loose, auto, coach, resolvedT}
  for (const e of events) if (e.type === 'awaken' && e.id != null) {
    const w = waits.get(e.id) ?? (e.phase === 'wait' ? { id: e.id, start: e.t, move: e.move, side: e.side, sec: e.sec, type: e.ntype } : null);
    if (!w) continue;
    waits.set(e.id, w);
    if (e.phase === 'loose') w.loose ??= e.t;
    if (e.phase === 'coach') w.coach ??= e.t;
    if (e.phase === 'auto') w.auto ??= e.t;
    if (e.phase === 'resolved') w.resolvedT ??= e.t;
  }
  const notes = [];
  const seen = new Set();
  for (const e of events) {
    if (e.type !== 'judge' || e.id == null || seen.has(e.id)) continue;
    seen.add(e.id);
    const w = waits.get(e.id);
    const n = {
      id: e.id, type: e.ntype, move: e.move, side: e.side, act: e.act, sec: e.sec, react: !!e.react, boss: !!e.boss,
      tn: e.tn, off: e.off || 0, cue: e.cue, judgedAt: e.t, spawnAt: spawnT.get(e.id),
      live: { kind: e.kind, err: e.err, how: e.how, wrong: !!e.wrong, hurt: !!e.hurt },
      wait: w ?? null,
    };
    if (w) w.resolvedT ??= e.t;
    n.cat = w ? 'wait' : n.react ? 'react' : n.move === 'blast' ? 'blast' : n.move === 'guard' ? 'guard' : IMPULSE.has(n.move) ? 'impulse' : HELD.has(n.move) ? 'held' : 'other';
    notes.push(n);
  }
  notes.sort((a, b) => (a.tn ?? a.judgedAt) - (b.tn ?? b.judgedAt));
  // brute punch phases: a successful block opens ~3.5 beats of punches that only hit the brute
  const brute = notes.filter((n) => n.move === 'guard' && n.live.how === 'block' && n.live.kind !== 'miss').map((n) => [n.judgedAt, n.judgedAt + 3.5 * 60000 / bpm]);
  // pauses
  let paused = 0, pauseN = 0;
  const pauses = [];
  for (const x of states) if (x.s === 'pause' && Number.isFinite(x.b)) { paused += x.b - x.a; pauseN++; }
  for (const e of events) if (e.type === 'pause') pauses.push({ t: e.t, reason: e.reason, manual: e.manual });
  let playMs = 0;
  for (const x of states) if (PLAY.has(x.s)) playMs += Math.min(x.b, session.frames.at(-1)?.tPush ?? x.b) - Math.max(x.a, session.frames[0]?.tPush ?? x.a);
  return { win, winAt, bpm, S, states, stateAt, busyAt, notes, waits, brute, pauses, paused, pauseN, playMs: Math.max(0, playMs), meta };
}

// ------------------------------------------------------------------------------------------ offline judge
/**
 * Judge the recorded notes with a given impulse event stream (live or replayed) and per-frame held states.
 * `stateFrames`: [{tc, tPush, state}] (detector held states after each frame).
 */
export function judgeOffline(TL, impulses, stateFrames) {
  const settings = { judgeOffsetMs: 0, wrongMovePenalty: !!TL.S.wrongMovePenalty, difficulty: TL.S.difficulty };
  const clock = { fromPerf: (ms) => ms / 1000, toPerf: (s) => s * 1000, timeAtBeat: (b) => b };
  const judge = new Judge({ clock, settings });
  judge.win = { ...TL.win };
  const N = TL.notes.map((n) => ({ ...n, liveOut: n.live, beat: (n.tn ?? n.judgedAt) / 1000, resolved: false, live: false, out: null, wrongTry: false, consumed: [] }));
  const res = (n, kind, err, how) => { if (n.resolved) return; n.resolved = true; n.out = { kind, err: Number.isFinite(err) ? err : null, how }; };
  const good = TL.win.good;
  const unconsumed = [];
  let ei = 0;
  const ev = [...impulses].filter((e) => limbOf(e.name)).sort((a, b) => a.t - b.t);
  const motionStub = { lastFrame: null, actions: { state: null } };
  let curState = {};
  const heldOn = (n, st) => {
    if (n.move === 'squat') return !!st.squat;
    if (n.move === 'dodge') return n.side === 'left' ? !!(st.leanRight || st.stepRight) : !!(st.leanLeft || st.stepLeft);
    if (n.move === 'guard') return !!(st.guard || st.handsUp);
    return false;
  };
  const tick = (now) => {
    judge.win = TL.winAt(now);
    for (const n of N) {
      if (n.resolved) continue;
      const liveFrom = n.spawnAt ?? (n.tn ?? n.judgedAt) - 4000;
      if (!n.live && now >= liveFrom) n.live = true;
      if (!n.live) continue;
      if (n.cat === 'held' || n.cat === 'guard') {
        if (n.tn == null) continue;
        // per-note offset (the recorded judgeOffsetMs at judge time)
        settings.judgeOffsetMs = n.off;
        const r = judge.evalState(n, now / 1000);
        settings.judgeOffsetMs = 0;
        if (r) res(n, r.kind, r.errMs, n.cat === 'guard' && r.kind !== 'miss' ? 'block' : 'state');
      } else if (n.cat === 'impulse') {
        if (n.tn != null && now > n.tn + judge.win.good + 50) res(n, 'miss', NaN, 'timeout');
      } else if (n.cat === 'react') {
        if (n.cue != null && now - n.cue > 1600) res(n, 'miss', NaN, 'timeout');
      } else if (n.cat === 'wait') {
        if (n.move === 'blast') { if (now >= n.judgedAt) res(n, n.liveOut.kind, n.liveOut.err, 'copied'); continue; }
        if (HELD.has(n.move) && now >= n.wait.start && now <= n.judgedAt + 150 && heldOn(n, curState)) { res(n, 'perfect', 0, 'hit'); n.firstAfter = (now - n.wait.start) / 1000; continue; }
        // the live game resolved it (hit / loose / auto) at judgedAt: unresolved here by then = not by the exact move
        if (now > n.judgedAt + 150) res(n, 'miss', NaN, 'wait-unmet');
      } else if (n.cat === 'blast' || n.cat === 'other') {
        if (now >= n.judgedAt) res(n, n.liveOut.kind, n.liveOut.err, 'copied');
      }
    }
  };
  const onImpulse = (e) => {
    judge.win = TL.winAt(e.t);
    const st = TL.stateAt(e.t);
    if (!PLAY.has(st)) return;                                            // menus / pause: the game ignores it
    const limb = limbOf(e.name);
    if (limb === 'punch' && TL.busyAt(e.t)) { e.use = 'charge'; return; }
    // Awakening: a waiting spirit takes the move first
    const W = N.find((n) => n.cat === 'wait' && !n.resolved && e.t >= n.wait.start && e.t <= n.judgedAt + 150);
    if (W && W.move !== 'guard') {
      const exact = Judge.actionFor(W) === e.name;
      if (exact) { res(W, 'perfect', 0, 'hit'); W.firstAfter = (e.t - W.wait.start) / 1000; e.use = 'wait'; return; }
      if (W.wait.loose != null && e.t >= W.wait.loose && limb === W.move) { res(W, 'good', 0, 'loose'); W.firstAfter = (e.t - W.wait.start) / 1000; e.use = 'wait'; return; }
      if (limb === W.move) { W.wrongTries = (W.wrongTries ?? 0) + 1; e.use = 'wait-wrong'; return; }
    }
    if (limb === 'punch' && TL.brute.some(([a, b]) => e.t >= a && e.t <= b)) { e.use = 'brute'; return; }
    if (limb === 'punch') {
      const r = N.find((n) => n.cat === 'react' && !n.resolved && n.live && n.cue != null && e.t >= n.cue - 50);
      if (r && (sideOf(e.name) === r.side || !TL.S.wrongMovePenalty)) {
        const ms = (e.tc ?? e.t) - r.cue;
        res(r, ms <= 420 ? 'perfect' : ms <= 600 ? 'great' : ms <= 900 ? 'good' : 'miss', ms, 'react'); e.use = 'react'; return;
      }
    }
    const liveNotes = N.filter((n) => n.cat === 'impulse' && n.live && !n.resolved);
    // per-note judge offset: the recorded offset is almost always constant; use the first candidate's
    settings.judgeOffsetMs = liveNotes[0]?.off ?? 0;
    const m = judge.matchAction(e.name, { tCapture: e.tc ?? e.t }, liveNotes);
    settings.judgeOffsetMs = 0;
    if (m) { res(m.note, m.kind, m.errMs, 'hit'); e.use = 'note'; return; }
    unconsumed.push(e);
  };
  for (const sf of stateFrames) {
    while (ei < ev.length && ev[ei].t <= sf.tPush) { tick(ev[ei].t); onImpulse(ev[ei++]); }
    motionStub.lastFrame = sf.frame; motionStub.actions.state = sf.state; curState = sf.state;
    judge.sampleStates(motionStub);
    tick(sf.tPush);
  }
  while (ei < ev.length) { tick(ev[ei].t); onImpulse(ev[ei++]); }
  tick(Infinity);
  // phantoms: unconsumed strikes in play
  const phantoms = unconsumed.map((e) => {
    const limb = limbOf(e.name), side = sideOf(e.name);
    const near = N.some((n) => n.move === limb && n.tn != null && Math.abs((e.tc ?? e.t) - (n.tn + (LEAD_MS[limb] ?? 0))) <= good + 150);
    const nearOther = near && N.some((n) => n.move === limb && n.side !== side && n.tn != null && Math.abs((e.tc ?? e.t) - (n.tn + (LEAD_MS[limb] ?? 0))) <= good + 150);
    return { name: e.name, t: e.t, tc: e.tc, kind: !near ? 'stray' : nearOther ? 'wrong side' : 'extra' };
  });
  return { notes: N, phantoms };
}

// ------------------------------------------------------------------------------------------ attempt heuristic
const mid = (a, b) => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 } : null);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** "attempted" / "not attempted" / "untracked" for a note, from the raw frames + detector hints around its window. */
export function attemptFor(n, frames, statInc, impulses, win) {
  if (n.tn == null) return { label: 'unknown' };
  const lead = LEAD_MS[n.move] ?? 0;
  const c = n.cat === 'wait' ? null : n.tn + lead;
  const a = n.cat === 'wait' ? n.wait.start - 500 : c - win.good - 250;
  const b = n.cat === 'wait' ? Math.max(n.judgedAt, n.wait.start + 1000) : c + win.good + 250;
  const F = [];
  for (const f of frames) { if (f.tCapture < a) continue; if (f.tCapture > b) break; F.push(f); }
  const withBody = F.filter((f) => f.joints?.leftShoulder && f.joints?.rightShoulder && f.joints?.leftHip && f.joints?.rightHip);
  if (F.length < 3 || withBody.length < 0.4 * F.length) return { label: 'untracked', frames: F.length, body: withBody.length };
  const why = [];
  const limb = n.move, side = n.side;
  if (IMPULSE.has(limb) && impulses.some((e) => limbOf(e.name) === limb && e.tc >= a && e.tc <= b && (limb === 'jump' || sideOf(e.name) !== side))) why.push('other-side ' + limb);
  if (limb === 'punch' && statInc.some((s) => s.tc >= a && s.tc <= b)) why.push('detector near miss / suppressed');
  const J = (f, k) => f.joints?.[k];
  if (limb === 'punch' || limb === 'guard') {
    const sides = limb === 'punch' && side !== 'center' ? [side] : ['left', 'right'];
    for (const s of sides) {
      let eMin = Infinity, eMax = -Infinity, vMax = 0, prev = null, vPrev = 0;
      for (const f of withBody) {
        const W = J(f, s + 'Wrist'), S = J(f, s + 'Shoulder');
        if (!W || !S) { prev = null; vPrev = 0; continue; }
        const e = dist(W, S); eMin = Math.min(eMin, e); eMax = Math.max(eMax, e);
        // sustained speed (2 consecutive frames), so a single-frame tracking jump does not count as a strike
        if (prev) { const dt = (f.tCapture - prev.t) / 1000; if (dt > 0.005 && dt < 0.2) { const v = dist(W, prev.w) / dt; vMax = Math.max(vMax, Math.min(v, vPrev)); vPrev = v; } }
        prev = { w: W, t: f.tCapture };
      }
      if (limb === 'punch' && eMax - eMin > 0.15) why.push(`${s} arm extension +${(eMax - eMin).toFixed(2)} m`);
      else if (limb === 'punch' && vMax > 1.8) why.push(`${s} wrist ${vMax.toFixed(1)} m/s`);
    }
    if (limb === 'guard' && withBody.some((f) => J(f, 'nose') && J(f, 'leftWrist') && J(f, 'rightWrist') && dist(J(f, 'nose'), J(f, 'leftWrist')) < 0.3 && dist(J(f, 'nose'), J(f, 'rightWrist')) < 0.3)) why.push('both fists near the face');
  }
  if (limb === 'kick') {
    const sides = side === 'left' || side === 'right' ? [side] : ['left', 'right'];
    for (const s of sides) {
      const ys = withBody.map((f) => J(f, s + 'Ankle')?.y).filter(Number.isFinite), ks = withBody.map((f) => J(f, s + 'Knee')?.y).filter(Number.isFinite);
      if (ys.length && Math.max(...ys) - Math.min(...ys) > 0.15) why.push(`${s} ankle rise ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} m`);
      else if (ks.length && Math.max(...ks) - Math.min(...ks) > 0.12) why.push(`${s} knee rise ${(Math.max(...ks) - Math.min(...ks)).toFixed(2)} m`);
    }
  }
  if (limb === 'jump' || limb === 'squat') {
    const hy = withBody.map((f) => mid(J(f, 'leftHip'), J(f, 'rightHip')).y);
    const hd = withBody.map((f) => (J(f, 'nose') ?? mid(J(f, 'leftShoulder'), J(f, 'rightShoulder'))).y);
    const rise = Math.max(...hy) - hy[0], drop = Math.max(hd[0], ...hd.slice(0, 3)) - Math.min(...hd);
    if (limb === 'jump' && (rise > 0.07 || Math.max(...hy) - Math.min(...hy) > 0.12)) why.push(`hips rise ${Math.max(rise, Math.max(...hy) - Math.min(...hy)).toFixed(2)} m`);
    if (limb === 'squat' && drop > 0.1) why.push(`head drop ${drop.toFixed(2)} m`);
  }
  if (limb === 'dodge') {
    const tilt = withBody.map((f) => { const s = mid(J(f, 'leftShoulder'), J(f, 'rightShoulder')), h = mid(J(f, 'leftHip'), J(f, 'rightHip')); return { t: s.x - h.x, h: h.x }; });
    const tr = Math.max(...tilt.map((x) => x.t)) - Math.min(...tilt.map((x) => x.t)), hr = Math.max(...tilt.map((x) => x.h)) - Math.min(...tilt.map((x) => x.h));
    if (tr > 0.07) why.push(`torso tilt ${tr.toFixed(2)} m`); else if (hr > 0.12) why.push(`hip shift ${hr.toFixed(2)} m`);
  }
  return { label: why.length ? 'attempted' : 'not attempted', why };
}

// ------------------------------------------------------------------------------------------ bench
/**
 * Full bench on one decoded session (loadSession()). Options: Detector (class), pipeline (true: run the whole
 * MotionPipeline in node / pass a pipeline instance), mhr (MHRSkeleton for the node pipeline).
 */
export async function replayBench(session, { Detector = ActionDetector, pipeline = false, mhr = null, detectorName = 'current actions.js' } = {}) {
  const TL = buildTimeline(session);
  const { frames } = session;
  // pipeline mode: simulated performance.now() so the pipeline's own timing is on the recorded clock too
  let pipe = null, restoreNow = null;
  const clockRef = { t: frames[0]?.tPush ?? 0 };
  if (pipeline) {
    const { createMotionPipeline } = await import('./pipeline.js');
    const realNow = performance.now.bind(performance);
    try { performance.now = () => clockRef.t; restoreNow = () => { performance.now = realNow; }; } catch { /* read-only: metrics use wall time */ }
    pipe = typeof pipeline === 'object' ? pipeline : await createMotionPipeline({ mhr, actions: new Detector(), options: { apply: false, mirror: false, predict: true, predictMs: 50, footLock: true, ikArms: true, accents: true, hands: 'pose', autoCalibrate: true } });
  }
  const stateFrames = [];
  let nextUpdate = frames[0]?.tPush ?? 0;
  const wall = () => (globalThis.process?.hrtime ? Number(process.hrtime.bigint() / 1000000n) : Date.now());
  const t0 = wall();
  const rp = replayDetector(session, {
    Detector, pipeline: pipe, clockRef,
    onFrame: (fr, det) => {
      stateFrames.push({ tPush: fr.tPush, frame: fr.joints ? fr : null, state: { ...det.state } });
      if (pipe) {
        const tf = fr.tPush;
        while (nextUpdate <= tf) { clockRef.t = nextUpdate; pipe.update(1 / 60, nextUpdate); nextUpdate += 1000 / 60; }
        clockRef.t = tf;
      }
    },
  });
  const wallMs = wall() - t0;
  restoreNow?.();
  const liveDet = session.events.filter((e) => e.type === 'det').map((e) => ({ name: e.n, tc: e.tc, t: e.t, side: e.side }));
  const parity = detectorParity(liveDet, rp.events);
  const liveJ = judgeOffline(TL, liveDet, stateFrames);
  const repJ = judgeOffline(TL, rp.events, stateFrames);
  // per-note rows
  const rows = TL.notes.map((n, i) => {
    const L = liveJ.notes[i], R = repJ.notes[i];
    const row = { id: n.id, move: n.move, side: n.side, type: n.type, cat: n.cat, act: n.act, sec: n.sec, tn: n.tn, live: n.live, offline: L.out, replay: R.out };
    if (n.wait) row.wait = { secs: +((n.judgedAt - n.wait.start) / 1000).toFixed(1), how: n.live.how, replayAfter: R.firstAfter ?? null, liveAfter: L.firstAfter ?? null };
    const missR = !R.out || R.out.kind === 'miss', missL = n.live.kind === 'miss';
    if (missR || missL) row.attempt = attemptFor(n, frames, rp.statInc, rp.events, TL.win);
    return row;
  });
  // self-check: offline judge on the LIVE events vs the live judge log
  const comparable = rows.filter((r) => r.offline?.how !== 'copied');
  let same = 0, errD = [];
  for (const r of comparable) {
    const a = r.live.kind === 'miss', b = !r.offline || r.offline.kind === 'miss';
    if (a === b && (a || r.live.kind === r.offline.kind)) same++;
    if (!a && !b && Number.isFinite(r.live.err) && Number.isFinite(r.offline.err)) errD.push(Math.abs(r.live.err - r.offline.err));
  }
  const selfCheck = { notes: comparable.length, sameKind: same, rate: comparable.length ? same / comparable.length : 1, maxErrDiff: errD.length ? Math.max(...errD) : 0 };
  // per move
  const moves = {};
  for (const r of rows) {
    const key = r.cat === 'wait' ? `wait:${r.move}` : r.cat === 'react' ? 'react' : r.move + (r.cat === 'guard' ? '' : '');
    const m = (moves[key] ??= { notes: 0, liveHit: 0, offlineHit: 0, replayHit: 0, notDetected: 0, notAttempted: 0, untracked: 0, wrongSide: 0, gained: 0, lost: 0, errs: [], dErr: [], liveErrs: [] });
    m.notes++;
    const lh = r.live.kind !== 'miss', oh = r.offline && r.offline.kind !== 'miss', rh = r.replay && r.replay.kind !== 'miss';
    if (lh) m.liveHit++; if (oh) m.offlineHit++; if (rh) m.replayHit++;
    if (rh && !lh) m.gained++; if (lh && !rh) m.lost++;
    if (rh && Number.isFinite(r.replay.err) && r.cat !== 'wait') { m.errs.push(r.replay.err); if (lh && Number.isFinite(r.live.err)) m.dErr.push(r.replay.err - r.live.err); }
    if (lh && Number.isFinite(r.live.err) && r.cat !== 'wait') m.liveErrs.push(r.live.err);
    if (!rh) {
      const at = r.attempt?.label;
      if (at === 'untracked') m.untracked++;
      else if (r.attempt?.why?.some((w) => w.startsWith('other-side'))) m.wrongSide++;
      else if (at === 'attempted') m.notDetected++;
      else m.notAttempted++;
    }
  }
  for (const m of Object.values(moves)) {
    const st = (a) => { if (!a.length) return null; const mu = a.reduce((s, x) => s + x, 0) / a.length; return { mean: +mu.toFixed(1), sd: +Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length).toFixed(1), n: a.length }; };
    m.replayErr = st(m.errs); m.liveErr = st(m.liveErrs); m.deltaErr = st(m.dErr);
    delete m.errs; delete m.dErr; delete m.liveErrs;
  }
  const playMin = TL.playMs / 60000;
  const phantom = (P) => ({ stray: P.filter((p) => p.kind === 'stray').length, wrongSide: P.filter((p) => p.kind === 'wrong side').length, extra: P.filter((p) => p.kind === 'extra').length });
  const ph = { live: phantom(liveJ.phantoms), replay: phantom(repJ.phantoms) };
  ph.live.perMin = playMin ? +(ph.live.stray / playMin).toFixed(2) : null;
  ph.replay.perMin = playMin ? +(ph.replay.stray / playMin).toFixed(2) : null;
  // perf + session facts
  const fps = session.events.filter((e) => e.type === 'fps');
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const inState = (s) => fps.filter((e) => e.st === s);
  const perf = {
    fpsMedian: med(fps.map((e) => e.fps)), fpsBossMedian: med(inState('boss').map((e) => e.fps)), fpsBossMin: inState('boss').length ? Math.min(...inState('boss').map((e) => e.fps)) : null,
    trackerFps: med(fps.map((e) => e.tfps)), trackerLatMs: med(fps.map((e) => e.lat)), motionMs: med(fps.map((e) => e.mms)),
  };
  const waits = rows.filter((r) => r.wait).map((r) => ({ sec: r.sec, move: r.move, side: r.side, ...r.wait }));
  const awk = session.events.filter((e) => e.type === 'awaken');
  const aStart = awk.find((e) => e.phase === 'start')?.t, aEnd = awk.find((e) => e.phase === 'end')?.t;
  const facts = {
    tracker: TL.meta.tracker, model: TL.meta.model, frames: frames.length,
    seconds: frames.length ? +((frames.at(-1).tPush - frames[0].tPush) / 1000).toFixed(1) : 0,
    playMinutes: +playMin.toFixed(2), pauses: TL.pauses.length, pauseReasons: TL.pauses.map((p) => p.reason),
    distanceWarnings: session.events.filter((e) => e.type === 'distance' && e.state && e.state !== 'ok').length,
    knockdowns: session.events.filter((e) => e.type === 'knockdown').length,
    reachedBoss: session.events.some((e) => e.type === 'state' && e.to === 'boss'),
    results: session.events.filter((e) => e.type === 'state' && e.to === 'results').length,
    awakeningSeconds: aStart != null && aEnd != null ? +((aEnd - aStart) / 1000).toFixed(1) : null,
    waitsAuto: waits.filter((w) => w.how === 'assist').length,
    windows: TL.win, recordedJudgements: TL.notes.length,
  };
  return { detector: detectorName, facts, perf, parity: { ...parity, onlyLive: parity.onlyLive.slice(0, 50), onlyReplay: parity.onlyReplay.slice(0, 50) }, selfCheck, moves, phantoms: ph, waits, rows, wallMs: Math.round(wallMs), pipeline: pipe ? pipe.metrics.snapshot() : null };
}

/** Bars from docs/game/qa-design-r3.md (judge-expectation proxies; the real bar is video-verified intent). */
export const PASS_BARS = { punch: 0.9, kick: 0.85, jump: 0.85, squat: 0.85, dodge: 0.85, guard: 0.85, phantomPerMin: 1, awakeningMedianS: 90, bossFps: 45 };

export function formatReplay(r, { notes = false } = {}) {
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
  const F = r.facts;
  const L = [];
  L.push(`session: ${F.tracker}${F.model ? ' (' + F.model + ')' : ''}, ${F.frames} frames, ${F.seconds} s, play ${F.playMinutes} min, detector: ${r.detector}`);
  L.push(`detector parity vs live: ${r.parity.matched}/${r.parity.live} live events reproduced (${pct(r.parity.matched, r.parity.live)}), ${r.parity.onlyReplay.length ? r.parity.replay - r.parity.matched : 0} new, ${r.parity.live - r.parity.matched} lost`);
  const bn = Object.entries(r.parity.byName).map(([k, v]) => `${k} ${v.live}->${v.replay}`).join('  ');
  L.push(`  by event (live->replay): ${bn}`);
  L.push(`offline judge self-check (live events): ${r.selfCheck.sameKind}/${r.selfCheck.notes} notes match the live judge log (${pct(r.selfCheck.sameKind, r.selfCheck.notes)}), max |err diff| ${r.selfCheck.maxErrDiff.toFixed(1)} ms`);
  L.push('');
  L.push('move            notes  live hit   replay hit  gained lost | replay misses: not-det not-att untracked wrong | replay err ms (mean±sd)  Δ vs live');
  for (const [k, m] of Object.entries(r.moves).sort()) {
    L.push(`${k.padEnd(15)} ${String(m.notes).padStart(5)}  ${pct(m.liveHit, m.notes).padStart(7)}  ${pct(m.replayHit, m.notes).padStart(9)}   ${String(m.gained).padStart(5)} ${String(m.lost).padStart(4)} |               ${String(m.notDetected).padStart(7)} ${String(m.notAttempted).padStart(7)} ${String(m.untracked).padStart(9)} ${String(m.wrongSide).padStart(5)} | ${m.replayErr ? `${m.replayErr.mean.toFixed(0)}±${m.replayErr.sd.toFixed(0)}`.padStart(10) : '-'.padStart(10)}               ${m.deltaErr ? m.deltaErr.mean.toFixed(1) : '-'}`);
  }
  L.push('');
  L.push(`phantoms (unconsumed strikes in play): live stray ${r.phantoms.live.stray} (${r.phantoms.live.perMin}/min), wrong-side ${r.phantoms.live.wrongSide}, extra ${r.phantoms.live.extra}  |  replay stray ${r.phantoms.replay.stray} (${r.phantoms.replay.perMin}/min), wrong-side ${r.phantoms.replay.wrongSide}, extra ${r.phantoms.replay.extra}`);
  if (r.waits.length) {
    L.push(`awakening: ${F.awakeningSeconds ?? '?'} s, ${r.waits.length} waits, ${F.waitsAuto} reached auto`);
    for (const w of r.waits) L.push(`  ${String(w.sec ?? '').padEnd(8)} ${String(w.move).padEnd(6)} ${String(w.side ?? '').padEnd(6)} live ${String(w.secs).padStart(5)} s (${w.how})   replay: exact move ${w.replayAfter != null ? 'after ' + w.replayAfter.toFixed(1) + ' s' : 'not seen'}`);
  }
  L.push(`perf: fps median ${r.perf.fpsMedian}, boss median ${r.perf.fpsBossMedian ?? '-'} (min ${r.perf.fpsBossMin ?? '-'}), tracker ${r.perf.trackerFps} fps, latency ${r.perf.trackerLatMs} ms, motion ${r.perf.motionMs} ms`);
  L.push(`session: pauses ${F.pauses}${F.pauses ? ' (' + F.pauseReasons.join(', ') + ')' : ''}, distance warnings ${F.distanceWarnings}, knockdowns ${F.knockdowns}, reached boss ${F.reachedBoss ? 'yes' : 'no'}, results screens ${F.results}`);
  // pass bars (proxy)
  const bars = [];
  for (const mv of ['punch', 'kick', 'jump', 'squat', 'dodge', 'guard']) {
    const m = r.moves[mv]; if (!m || !m.notes) continue;
    const att = m.notes - m.notAttempted - m.untracked;      // judge expectation minus moves the player did not do
    const rate = att ? m.replayHit / att : 1;
    bars.push(`${mv} ${(rate * 100).toFixed(0)}% of attempted ${rate >= PASS_BARS[mv] ? 'ok' : 'BELOW ' + PASS_BARS[mv] * 100 + '%'}`);
  }
  if (r.phantoms.replay.perMin != null) bars.push(`phantoms ${r.phantoms.replay.perMin}/min ${r.phantoms.replay.perMin <= PASS_BARS.phantomPerMin ? 'ok' : 'ABOVE 1/min'}`);
  if (r.perf.fpsBossMedian != null) bars.push(`boss fps ${r.perf.fpsBossMedian} ${r.perf.fpsBossMedian >= PASS_BARS.bossFps ? 'ok' : 'BELOW 45'}`);
  L.push('bars (proxy, confirm on video): ' + bars.join(' · '));
  if (r.pipeline) L.push('pipeline metrics: ' + JSON.stringify(r.pipeline));
  L.push(`replay cost ${r.wallMs} ms`);
  if (notes) {
    L.push('', 'notes (id move side cat | live | offline(live events) | replay | attempt):');
    for (const x of r.rows) L.push(`  ${String(x.id).padStart(4)} ${x.move.padEnd(6)} ${String(x.side ?? '').padEnd(6)} ${x.cat.padEnd(7)} | ${x.live.kind.padEnd(7)} ${fmtE(x.live.err)} ${String(x.live.how).padEnd(8)} | ${(x.offline?.kind ?? '-').padEnd(7)} ${fmtE(x.offline?.err)} | ${(x.replay?.kind ?? '-').padEnd(7)} ${fmtE(x.replay?.err)} | ${x.attempt ? x.attempt.label + (x.attempt.why?.length ? ' (' + x.attempt.why.join('; ') + ')' : '') : ''}`);
  }
  return L.join('\n');
}
const fmtE = (e) => (Number.isFinite(e) ? `${e >= 0 ? '+' : ''}${Math.round(e)}`.padStart(5) : '    -');

// ------------------------------------------------------------------------------------------ node entry
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.log('usage: node web/src/motion/replayBench.js session.json.gz [...] [--detector=path/to/actions.js] [--pipeline] [--json=out.json] [--notes]');
    process.exit(2);
  }
  const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const detPath = opt('detector');
  const Detector = detPath ? (await import(new URL(detPath, 'file://' + process.cwd() + '/').href)).ActionDetector : ActionDetector;
  let mhr = null;
  if (args.includes('--pipeline')) {
    const fs = await import('node:fs');
    const { MHRSkeleton } = await import('./mhrFK.js');
    mhr = new MHRSkeleton(JSON.parse(fs.readFileSync(new URL('../../public/motion/mhr-rig.json', import.meta.url), 'utf8')));
  }
  const all = [];
  for (const f of files) {
    const s = await loadSession(f);
    const r = await replayBench(s, { Detector, pipeline: args.includes('--pipeline'), mhr, detectorName: detPath ?? 'current actions.js' });
    r.file = f;
    all.push(r);
    console.log(`\n=== ${f}\n` + formatReplay(r, { notes: args.includes('--notes') }));
  }
  const out = opt('json');
  if (out) { (await import('node:fs')).writeFileSync(out, JSON.stringify(all.length === 1 ? all[0] : all, null, 1)); console.log(`\nwrote ${out}`); }
}
