// Tutorial: 7 short drills (punch, kick, jump, duck, dodge, guard, charge-blast), each with a looping hint figure,
// live verification from the motion pipeline's action detector (the same ctx.motion.actions events gameplay judges:
// a rep is a detector event, never a separate speed heuristic), 3 reps to pass and coaching feedback on near misses
// ("FASTER!", "HIGHER!", "LOWER!", "HOLD IT!"). Upper-body-only mode skips the kick and jump drills. Measured values
// from the tracked 3D joints (wrist speed, jump height, squat depth…) are shown live as hints only.
// The charge-blast drill uses the SAME detector as gameplay (core/charge.js ChargeDetector): when CORE runs it during
// the tutorial (ctx.game.charge + bus 'charge' / 'blast') the drill listens to those events, otherwise (UI lab) it runs
// its own ChargeDetector instance on ctx.motion. Every drill change is announced on the bus:
//   bus.emit('tutorial', { drill, index, total, reps, phase: 'drill'|'rep'|'done' })   (lets the demo/autoplay player act it out)
import { h, uiButton, freshFrame, torsoForward } from './body.js';
import { ChargeDetector } from '../core/charge.js';

export const ALL_DRILLS = ['punch', 'kick', 'jump', 'duck', 'dodge', 'guard', 'blast'];
const LOWER_BODY = new Set(['kick', 'jump']);
// drills make the player punch and raise hands constantly: nav buttons need a long, deliberate hold and ignore punches
const guarded = (b) => { b.setAttribute('data-ui-dwell', '1.6'); b.setAttribute('data-ui-nopunch', ''); return b; };
const REPS = 3;

// ------------------------------------------------------------------ hint figures (SMIL, 120 x 160, mirror view)
const ST = { LA: '49,40 45,60 46,78', RA: '71,40 75,60 74,78', LL: '55,82 53,110 51,138', RL: '65,82 67,110 69,138' };
const GU = { LA: '49,40 42,56 53,34', RA: '71,40 78,56 67,34' };
const FS = { LL: '55,82 50,110 46,138', RL: '65,82 70,110 74,138' };
const anim = (attr, vals, dur, kt) => `<animate attributeName="${attr}" values="${vals.join(';')}" keyTimes="${kt.join(';')}" dur="${dur}s" repeatCount="indefinite"/>`;
function figure({ dur, kt, LA, RA, LL, RL, group = '', fx = '', groupAnim = '' }) {
  const line = (cls, vals) => `<polyline class="${cls}" points="${vals[0]}">${anim('points', vals, dur, kt)}</polyline>`;
  return `<svg viewBox="0 0 120 160" class="bl-fig">
    <ellipse cx="60" cy="142" rx="26" ry="5" class="bl-fig-shadow"/>
    ${fx}
    <g class="bl-fig-body" ${group}>${groupAnim}
      <circle cx="60" cy="22" r="10" class="bl-fig-head"/>
      <line x1="60" y1="33" x2="60" y2="82" class="bl-fig-torso"/>
      <line x1="49" y1="40" x2="71" y2="40" class="bl-fig-torso"/>
      ${line('bl-fig-limb l', LA)}${line('bl-fig-limb r', RA)}${line('bl-fig-limb l', LL)}${line('bl-fig-limb r', RL)}
    </g></svg>`;
}
const fist = (cx, cy, rs, dur, kt, cls = '') => `<circle cx="${cx}" cy="${cy}" r="3" class="bl-fig-fist ${cls}">${anim('r', rs, dur, kt)}${anim('opacity', rs.map((r) => (r > 4 ? 1 : 0)), dur, kt)}</circle>`;

const HINTS = {
  punch: (() => {
    const kt = [0, 0.1, 0.3, 0.5, 0.6, 0.8, 1], d = 1.6;
    const pR = '71,40 67,43 62,45', pL = '49,40 53,43 58,45';
    return figure({ dur: d, kt, LA: [GU.LA, GU.LA, GU.LA, GU.LA, pL, GU.LA, GU.LA], RA: [GU.RA, pR, GU.RA, GU.RA, GU.RA, GU.RA, GU.RA], LL: Array(7).fill(FS.LL), RL: Array(7).fill(FS.RL),
      fx: fist(62, 45, ['3', '13', '3', '3', '3', '3', '3'], d, kt, 'r') + fist(58, 45, ['3', '3', '3', '3', '13', '3', '3'], d, kt, 'l') });
  })(),
  kick: (() => {
    const kt = [0, 0.15, 0.3, 0.45, 0.6, 1], d = 1.6;
    const ch = '65,82 76,100 70,120', ex = '65,82 70,98 66,104';
    return figure({ dur: d, kt, LA: Array(6).fill(GU.LA), RA: Array(6).fill(GU.RA), LL: Array(6).fill('55,82 53,110 51,138'), RL: [FS.RL, ch, ex, ch, FS.RL, FS.RL],
      fx: fist(66, 104, ['3', '3', '14', '3', '3', '3'], d, kt, 'r') });
  })(),
  jump: (() => {
    const kt = [0, 0.2, 0.45, 0.7, 0.85, 1], d = 1.3;
    const up = { LA: '49,40 40,26 36,10', RA: '71,40 80,26 84,10' };
    const tuck = { LL: '55,82 50,104 54,124', RL: '65,82 70,104 66,124' };
    const bend = { LL: '55,82 47,108 51,132', RL: '65,82 73,108 69,132' };
    return figure({ dur: d, kt, LA: [ST.LA, '49,40 42,58 38,70', up.LA, up.LA, ST.LA, ST.LA], RA: [ST.RA, '71,40 78,58 82,70', up.RA, up.RA, ST.RA, ST.RA],
      LL: [ST.LL, bend.LL, tuck.LL, ST.LL, bend.LL, ST.LL], RL: [ST.RL, bend.RL, tuck.RL, ST.RL, bend.RL, ST.RL],
      groupAnim: `<animateTransform attributeName="transform" type="translate" values="0 0;0 6;0 -30;0 -4;0 6;0 0" keyTimes="${kt.join(';')}" dur="${d}s" repeatCount="indefinite"/>`,
      fx: `<line x1="-10" y1="134" x2="130" y2="134" class="bl-fig-beam b-red">${anim('opacity', ['0', '0', '1', '0', '0', '0'], d, kt)}</line>` });
  })(),
  duck: (() => {
    const kt = [0, 0.25, 0.65, 0.9, 1], d = 1.8;
    const sq = { LL: '55,82 41,96 49,116', RL: '65,82 79,96 71,116' };
    const arms = { LA: '49,40 44,52 54,58', RA: '71,40 76,52 66,58' };
    return figure({ dur: d, kt, LA: [GU.LA, arms.LA, arms.LA, GU.LA, GU.LA], RA: [GU.RA, arms.RA, arms.RA, GU.RA, GU.RA],
      LL: [ST.LL, sq.LL, sq.LL, ST.LL, ST.LL], RL: [ST.RL, sq.RL, sq.RL, ST.RL, ST.RL],
      groupAnim: `<animateTransform attributeName="transform" type="translate" values="0 0;0 22;0 22;0 0;0 0" keyTimes="${kt.join(';')}" dur="${d}s" repeatCount="indefinite"/>`,
      fx: `<line x1="0" y1="20" x2="120" y2="20" class="bl-fig-beam b-violet">${anim('opacity', ['0', '1', '1', '0', '0'], d, kt)}</line>` });
  })(),
  dodge: (() => {
    const kt = [0, 0.15, 0.4, 0.5, 0.65, 0.9, 1], d = 2.4;
    return figure({ dur: d, kt, LA: Array(7).fill(GU.LA), RA: Array(7).fill(GU.RA), LL: Array(7).fill(ST.LL), RL: Array(7).fill(ST.RL),
      groupAnim: `<animateTransform attributeName="transform" type="rotate" values="0 60 140;-17 60 140;-17 60 140;0 60 140;17 60 140;17 60 140;0 60 140" keyTimes="${kt.join(';')}" dur="${d}s" repeatCount="indefinite"/>`,
      fx: `<circle cx="72" cy="30" r="6" class="bl-fig-orb">${anim('cx', ['110', '74', '74', '110', '46', '46', '10'], d, kt)}${anim('opacity', ['0', '1', '0', '0', '1', '0', '0'], d, kt)}</circle>` });
  })(),
  guard: (() => {
    const kt = [0, 0.2, 0.75, 0.9, 1], d = 1.8;
    return figure({ dur: d, kt, LA: [ST.LA, GU.LA, GU.LA, ST.LA, ST.LA], RA: [ST.RA, GU.RA, GU.RA, ST.RA, ST.RA], LL: Array(5).fill(FS.LL), RL: Array(5).fill(FS.RL),
      fx: `<ellipse cx="60" cy="38" rx="30" ry="34" class="bl-fig-shield">${anim('opacity', ['0', '0.2', '1', '0', '0'], d, kt)}</ellipse>` });
  })(),
  blast: (() => {
    const kt = [0, 0.15, 0.55, 0.62, 0.8, 0.9, 1], d = 2.8;
    const up = { LA: '49,40 47,24 55,8', RA: '71,40 73,24 65,8' };
    const push = { LA: '49,40 54,44 58,46', RA: '71,40 66,44 62,46' };
    return figure({ dur: d, kt, LA: [ST.LA, up.LA, up.LA, push.LA, push.LA, ST.LA, ST.LA], RA: [ST.RA, up.RA, up.RA, push.RA, push.RA, ST.RA, ST.RA], LL: Array(7).fill(FS.LL), RL: Array(7).fill(FS.RL),
      fx: `<circle cx="60" cy="6" r="2" class="bl-fig-charge">${anim('r', ['0', '2', '13', '0', '0', '0', '0'], d, kt)}</circle>
        <circle cx="60" cy="46" r="2" class="bl-fig-blast">${anim('r', ['0', '0', '0', '8', '40', '0', '0'], d, kt)}${anim('opacity', ['0', '0', '0', '1', '0', '0', '0'], d, kt)}</circle>` });
  })(),
};

const DRILL_INFO = {
  punch: { title: 'PUNCH', text: 'Snap a fast straight punch toward the screen. Either hand.', meter: 'WRIST SPEED', unit: 'm/s', max: 8 },
  kick: { title: 'KICK', text: 'Knee up, then snap a front kick toward the screen.', meter: 'FOOT HEIGHT', unit: 'cm', max: 90 },
  jump: { title: 'JUMP', text: 'Jump! Both feet off the floor to clear the sweep beam.', meter: 'HIP RISE', unit: 'cm', max: 40 },
  duck: { title: 'DUCK', text: 'Squat down low to slip under the scythe beam.', meter: 'SQUAT DEPTH', unit: 'cm', max: 50 },
  dodge: { title: 'DODGE', text: 'Lean or step to the side shown to dodge the volley.', meter: 'LEAN', unit: '°', max: 30 },
  guard: { title: 'GUARD', text: 'Both fists up in front of your face. Hold the block.', meter: 'HOLD', unit: '%', max: 100 },
  blast: { title: 'BREAKLIGHT BLAST', text: 'Raise both hands above your head to charge… then PUSH both palms forward!', meter: 'CHARGE', unit: '%', max: 100 },
};

// ------------------------------------------------------------------ live body measurement (player frame)
function createMeasure() {
  const M = { t: 0, ok: false, wristFwd: 0, wristFwdL: 0, wristFwdR: 0, extL: 0, extR: 0, reachL: 0, reachR: 0, footLift: 0, hipRise: 0, hipDrop: 0, tilt: 0, stepX: 0, ruler: 0.5 };
  let prev = null, prevT = 0, base = null, baseX = null, last = null;
  const fwd = { x: 0, z: 1 };
  M.push = (f) => {
    if (!f || f === last) return false;
    last = f;
    const J = f.joints, t = f.tCapture ?? performance.now();
    if (!J.leftShoulder || !J.leftHip) return false;
    torsoForward(J, fwd);
    const hip = { x: (J.leftHip.x + J.rightHip.x) / 2, y: (J.leftHip.y + J.rightHip.y) / 2, z: (J.leftHip.z + J.rightHip.z) / 2 };
    const sh = { x: (J.leftShoulder.x + J.rightShoulder.x) / 2, y: (J.leftShoulder.y + J.rightShoulder.y) / 2 };
    M.ruler = Math.max(0.3, Math.hypot(sh.x - hip.x, sh.y - hip.y));
    const dt = prev ? Math.max(0.012, (t - prevT) / 1000) : 0;
    for (const s of ['left', 'right']) {
      const S = J[s + 'Shoulder'], E = J[s + 'Elbow'], W = J[s + 'Wrist'];
      const arm = Math.hypot(S.x - E.x, S.y - E.y, S.z - E.z) + Math.hypot(E.x - W.x, E.y - W.y, E.z - W.z) + 1e-6;
      const ext = Math.hypot(W.x - S.x, W.y - S.y, W.z - S.z) / arm;
      const reach = ((W.x - S.x) * fwd.x + (W.z - S.z) * fwd.z) / arm;
      let v = 0;
      if (prev && dt) {
        const pS = prev[s + 'Shoulder'], pW = prev[s + 'Wrist'];
        v = (((W.x - S.x) - (pW.x - pS.x)) * fwd.x + ((W.z - S.z) - (pW.z - pS.z)) * fwd.z) / dt;
      }
      if (s === 'left') { M.wristFwdL = M.wristFwdL * 0.4 + v * 0.6; M.extL = ext; M.reachL = reach; } else { M.wristFwdR = M.wristFwdR * 0.4 + v * 0.6; M.extR = ext; M.reachR = reach; }
    }
    M.wristFwd = Math.max(M.wristFwdL, M.wristFwdR);
    M.footLift = J.leftAnkle && J.rightAnkle ? Math.abs(J.leftAnkle.y - J.rightAnkle.y) : 0;
    const vy = prev && dt ? (hip.y - (prev.leftHip.y + prev.rightHip.y) / 2) / dt : 0;
    if (base === null) { base = hip.y; baseX = hip.x; }
    if (Math.abs(vy) < 0.2 && Math.abs(hip.y - base) < 0.06) { base += (hip.y - base) * 0.05; baseX += (hip.x - baseX) * 0.02; }
    M.hipRise = Math.max(0, hip.y - base); M.hipDrop = Math.max(0, base - hip.y);
    M.tilt = Math.atan2(sh.x - hip.x, sh.y - hip.y);
    M.stepX = hip.x - baseX;
    prev = J; prevT = t; M.t = t; M.ok = true;
    return true;
  };
  return M;
}

// ------------------------------------------------------------------ screen
export function tutorialScreen(ctx, { steps, onDone, onSkip } = {}) {
  const seated = !!ctx.settings?.seated;
  const upper = !!ctx.settings?.upperBodyOnly || seated;
  let list = (steps && steps.length ? steps.map((s) => (typeof s === 'string' ? s : s.id)) : ALL_DRILLS).filter((s) => DRILL_INFO[s]);
  if (upper) list = list.filter((s) => !LOWER_BODY.has(s));
  if (seated) list = list.filter((s) => s !== 'duck');        // same rule as CORE's seated chart (no scythes to duck)
  const sfx = (n, o) => { try { ctx.audio?.sfx?.(n, o); } catch { /* optional */ } };

  const stepEls = list.map((id, i) => h('li', { class: 'bl-tut-step' }, h('i', {}, String(i + 1)), h('span', {}, DRILL_INFO[id].title)));
  const idxEl = h('span', { class: 'bl-tut-idx' });
  const titleEl = h('h1', { class: 'bl-tut-title' });
  const textEl = h('p', { class: 'bl-tut-text' });
  const pips = h('div', { class: 'bl-tut-pips' }, Array.from({ length: REPS }, () => h('i')));
  const fbEl = h('div', { class: 'bl-tut-fb' });
  const meterFill = h('i', { class: 'bl-tut-meter-fill' });
  const meterPeak = h('b', { class: 'bl-tut-meter-peak' });
  const meterLab = h('span', { class: 'bl-tut-meter-lab' });
  const meterVal = h('span', { class: 'bl-tut-meter-val' });
  const sideEl = h('div', { class: 'bl-tut-side-cue' });
  const hintBox = h('div', { class: 'bl-tut-hint-fig' });
  const card = h('div', { class: 'bl-tut-card' }, h('div', { class: 'bl-tut-cardhead' }, idxEl, pips), titleEl, textEl, sideEl,
    h('div', { class: 'bl-tut-meter' }, meterLab, h('span', { class: 'bl-tut-meter-bar' }, meterFill, meterPeak), meterVal));
  const node = h('div', { class: 'bl-tut' },
    h('aside', { class: 'bl-tut-list' }, h('div', { class: 'bl-kicker' }, seated ? 'TRAINING · SEATED' : upper ? 'TRAINING · UPPER BODY' : 'TRAINING'), h('ol', {}, stepEls)),
    card, fbEl,
    h('aside', { class: 'bl-tut-hint' }, h('div', { class: 'bl-kicker' }, 'WATCH & COPY'), hintBox),
    h('div', { class: 'bl-tut-nav' },
      guarded(uiButton('EXIT', () => finish(true), { cls: 'is-small', id: 'tut-exit' })),
      guarded(uiButton('SKIP DRILL', () => next(true), { cls: 'is-small', id: 'tut-skip' }))));

  const M = createMeasure();
  const R = { i: -1, id: null, reps: 0, lastRep: -1e9, tip: { t: -1e9 }, attempt: null, peak: 0, done: false, results: {}, charge: 0, charged: 0, guardT: 0, guardPend: 0, side: 'left', meter: 0, clearing: false };
  let chargeLoop = null;
  const stopCharge = () => { try { chargeLoop?.stop?.(); } catch { /* */ } chargeLoop = null; };
  const announce = (phase) => { try { ctx.bus?.emit?.('tutorial', { drill: R.id, index: R.i, total: list.length, reps: R.reps, phase }); } catch (e) { console.error(e); } };

  // ---- charge-blast: the gameplay detector (CORE's instance via the bus, or our own on ctx.motion)
  const CH = { level: 0, charged: false, core: !!(ctx.game?.charge && ctx.bus?.on), det: null };
  function onChargeLevel(lv, charged) {
    if (R.id !== 'blast' || R.done) { CH.level = lv; CH.charged = charged; return; }
    if (charged && !CH.charged) { feedback('PUSH!', 'cue', 'both palms forward'); node.classList.add('is-charged'); sfx('combo', { pitch: 1.5 }); }
    if (!CH.core) {
      if (lv > 0 && !chargeLoop) { try { chargeLoop = ctx.audio?.sfxLoop?.('chargeHum'); } catch { /* */ } }
      if (lv <= 0) stopCharge();
    }
    if (lv <= 0 && (CH.level > 0 || CH.charged) && performance.now() - (CH.blastAt || 0) > 400) {
      if (CH.charged) tip('PUSH FASTER!', 'both palms forward, hard'); else if (CH.level > 0.25) tip('KEEP CHARGING!', 'hands up for a full second');
      node.classList.remove('is-charged');
    }
    CH.level = lv; CH.charged = charged;
  }
  function onBlastFired() {
    CH.blastAt = performance.now(); CH.level = 0; CH.charged = false;
    node.classList.remove('is-charged'); stopCharge();
    if (R.id !== 'blast' || R.done) return;
    rep('BREAKLIGHT!');
    if (!CH.core) sfx('blast');
  }
  const offCh = [];
  if (CH.core) {
    offCh.push(ctx.bus.on('charge', (d) => onChargeLevel(+d?.level || 0, !!d?.charged)));
    offCh.push(ctx.bus.on('blast', onBlastFired));
  } else {
    CH.det = new ChargeDetector({ onLevel: (lv, charged) => { if (lv !== CH.level || charged !== CH.charged) onChargeLevel(lv, charged); }, onBlast: onBlastFired, onCancel: () => onChargeLevel(0, false) });
  }

  function feedback(text, kind = 'tip', sub = '') {
    fbEl.className = 'bl-tut-fb is-on k-' + kind;
    fbEl.innerHTML = `<b data-text="${text}">${text}</b>${sub ? `<small>${sub}</small>` : ''}`;
    fbEl.getAnimations().forEach((a) => a.cancel());
    fbEl.animate([{ opacity: 0, transform: 'translate(-50%,0) scale(1.8) rotate(-4deg)' }, { opacity: 1, transform: 'translate(-50%,0) scale(1) rotate(-4deg)', offset: 0.15 }, { opacity: 1, offset: 0.75, transform: 'translate(-50%,-6px) scale(1) rotate(-4deg)' }, { opacity: 0, transform: 'translate(-50%,-20px) scale(.95) rotate(-4deg)' }], { duration: 1100, easing: 'ease-out', fill: 'forwards' });
  }
  function tip(text, sub = '') {
    const now = performance.now();
    if (now - R.tip.t < 900 || now - R.lastRep < 500 || R.clearing) return;
    R.tip.t = now;
    feedback(text, 'tip', sub);
    sfx('miss', { gain: 0.35 });
  }
  const PRAISE = ['NICE!', 'GREAT!', 'CLEAN!', 'SHARP!', 'YES!'];
  function rep(sub = '') {
    const now = performance.now();
    if (R.clearing || now - R.lastRep < 420) return false;
    R.lastRep = now; R.reps++;
    if (R.attempt) R.attempt.rep = true;
    pips.children[R.reps - 1]?.classList.add('is-on');
    pips.children[R.reps - 1]?.animate([{ scale: '2', filter: 'brightness(3)' }, { scale: '1' }], { duration: 300 });
    feedback(PRAISE[(R.reps + R.i) % PRAISE.length], 'good', sub);
    sfx(R.reps >= REPS ? 'perfect' : 'great');
    (R.results[R.id] ||= []).push(sub);
    if (R.id === 'dodge') { R.side = R.side === 'left' ? 'right' : 'left'; showSide(); }
    announce('rep');
    if (R.reps >= REPS) clear();
    return true;
  }
  function clear() {
    R.clearing = true;
    stepEls[R.i].classList.add('is-done');
    const stamp = h('div', { class: 'bl-tut-clear' }, 'DRILL CLEAR');
    node.append(stamp);
    stamp.animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(2.4) rotate(-10deg)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(-6deg)', offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1300, easing: 'ease-out', fill: 'forwards' }).onfinish = () => stamp.remove();
    setTimeout(() => next(false), 1300);
  }
  function showSide() {
    if (R.id !== 'dodge') { sideEl.className = 'bl-tut-side-cue'; sideEl.textContent = ''; return; }
    sideEl.className = 'bl-tut-side-cue is-on s-' + R.side;
    sideEl.innerHTML = R.side === 'left' ? '<b>◀</b> YOUR LEFT' : 'YOUR RIGHT <b>▶</b>';
  }
  function next(skipped) {
    stopCharge();
    if (R.i >= 0 && skipped) stepEls[R.i].classList.add('is-skipped');
    R.i++;
    if (R.i >= list.length) { finish(false); return; }
    Object.assign(R, { id: list[R.i], reps: 0, attempt: null, peak: 0, charge: 0, charged: 0, guardT: 0, guardPend: 0, guardHeld: false, side: 'left', clearing: false, meter: 0, lastRep: performance.now() });
    const D = DRILL_INFO[R.id];
    stepEls.forEach((e, i) => e.classList.toggle('is-cur', i === R.i));
    idxEl.textContent = `DRILL ${R.i + 1} / ${list.length}`;
    titleEl.textContent = D.title; titleEl.dataset.text = D.title;
    textEl.textContent = D.text;
    meterLab.textContent = D.meter;
    for (const p of pips.children) p.classList.remove('is-on');
    hintBox.innerHTML = HINTS[R.id];
    showSide();
    card.animate([{ opacity: 0, transform: 'translate(-50%, -16px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' });
    node.dataset.drill = R.id;
    announce('drill');
  }
  function finish(exited) {
    if (R.done) return;
    R.done = true; stopCharge();
    announce('done');
    const completed = list.filter((_, i) => stepEls[i].classList.contains('is-done'));
    if (exited) { onSkip?.(); onDone?.({ completed, exited: true, results: R.results }); return; }
    const end = h('div', { class: 'bl-tut-complete' }, h('b', {}, 'TRAINING COMPLETE'), h('span', {}, `${completed.length} / ${list.length} drills cleared`));
    node.append(end);
    end.animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(1.6)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,1.4,.4,1)', fill: 'forwards' });
    sfx('victory');
    setTimeout(() => onDone?.({ completed, exited: false, results: R.results }), 1600);
  }

  // ---- action events (player-side names). Reps are counted from the SAME detector events gameplay judges
  // (ctx.motion.actions: punchLeft/Right, kickLeft/Right, jump, squat, leanLeft/Right / stepLeft/Right, guard) and, for
  // the blast drill, CORE's charge detector (bus 'blast'). The measured values (wrist speed, foot height, hip rise…)
  // are only coaching hints in the praise line; they never veto a rep the detector already accepted.
  const SIDE = (name) => (name.endsWith('Left') ? 'left' : 'right');
  const off = ctx.motion?.actions?.on?.((name, info = {}) => {
    if (R.done || R.clearing || !R.id) return;
    const id = R.id;
    if (id === 'punch' && (name === 'punchLeft' || name === 'punchRight')) {
      const v = Math.max(+info.speed || 0, M.wristFwd);
      rep(`${v.toFixed(1)} m/s ${SIDE(name)}${v < 2.2 ? ' · snap it faster' : ''}`);
    } else if (id === 'kick' && (name === 'kickLeft' || name === 'kickRight')) {
      const cm = Math.round(M.footLift * 100);
      rep(`${cm > 5 ? cm + ' cm ' : ''}${SIDE(name)}${cm > 5 && M.footLift / M.ruler < 0.28 ? ' · knee higher' : ''}`);
    } else if (id === 'jump' && name === 'jump') {
      if (rep('JUMP!')) { R.peak = M.hipRise; setTimeout(() => { const sm = fbEl.querySelector('small'); if (R.id === 'jump' && sm && R.peak > 0.02) sm.textContent = `${Math.round(R.peak * 100)} cm`; }, 380); }
    } else if (id === 'duck' && name === 'squat') {
      if (rep('DUCK!')) setTimeout(() => { const sm = fbEl.querySelector('small'); if (R.id === 'duck' && sm && M.hipDrop > 0.03) sm.textContent = `${Math.round(M.hipDrop * 100)} cm low`; }, 160);
    } else if (id === 'dodge' && /^(lean|step)(Left|Right)$/.test(name)) {
      const side = SIDE(name);
      if (side === R.side) rep(name.startsWith('lean') ? 'lean' : 'step'); else tip('OTHER WAY!', `dodge to your ${R.side}`);
    } else if (id === 'guard' && name === 'guard') {
      R.guardPend = performance.now(); R.guardHeld = false;   // a fresh block starts; update() verifies it is held
    }
  });

  // near-miss coaching: an attempt starts when q rises above `start` and ends when it falls below `end`
  function attempt(q, start, end, text, sub) {
    const now = performance.now();
    if (!R.attempt && q > start) R.attempt = { peak: q, rep: false, t: now };
    else if (R.attempt) {
      R.attempt.peak = Math.max(R.attempt.peak, q);
      if (q < end) {
        const a = R.attempt; R.attempt = null;
        if (!a.rep && now - R.lastRep > 450 && now - a.t > 80) setTimeout(() => { if (performance.now() - R.lastRep > 300) tip(text, sub); }, 200);
      }
    }
  }

  function setMeter(v, D) {
    R.meter += (v - R.meter) * 0.35;
    const f = Math.max(0, Math.min(1, R.meter / D.max));
    meterFill.style.transform = `scaleX(${f.toFixed(3)})`;
    if (v > R.peakShown || performance.now() - (R.peakT || 0) > 1500) { R.peakShown = v; R.peakT = performance.now(); meterPeak.style.left = `${Math.min(100, (v / D.max) * 100).toFixed(1)}%`; }
    meterVal.textContent = `${D.unit === 'm/s' ? R.meter.toFixed(1) : Math.round(R.meter)} ${D.unit}`;
  }

  next(false);

  return {
    node,
    get drill() { return R.id; },
    get reps() { return R.reps; },
    skip: () => next(true),
    update(dt) {
      if (R.done || !R.id) return;
      const f = freshFrame(ctx.motion, 600);
      node.classList.toggle('is-lost', !f);
      const fresh = f ? M.push(f) : false;
      const st = ctx.motion?.actions?.state || {};
      const D = DRILL_INFO[R.id];
      switch (R.id) {
        case 'punch':
          if (fresh) attempt(M.wristFwd, 1.1, 0.2, 'FASTER!', 'snap it straight out');
          setMeter(Math.max(0, M.wristFwd), D); break;
        case 'kick':
          if (fresh) attempt(M.footLift / M.ruler, 0.28, 0.12, 'HIGHER!', 'knee up first');
          setMeter(M.footLift * 100, D); break;
        case 'jump':
          if (fresh) { attempt(M.hipRise, 0.035, 0.012, 'HIGHER!', 'explode up'); R.peak = Math.max(R.peak, M.hipRise); }
          setMeter(M.hipRise * 100, D); break;
        case 'duck':
          if (fresh) attempt(M.hipDrop / M.ruler, 0.12, 0.05, 'LOWER!', 'sit back into it');
          setMeter(M.hipDrop * 100, D); break;
        case 'dodge':
          setMeter(Math.abs(M.tilt) * 57.3, D); break;
        case 'guard': {
          // the detector's held guard: its 'guard' event (or the guard already being up when the drill starts) begins a
          // block; every GUARD_HOLD s it stays up counts one blocked hit (gameplay also accepts a guard held through the
          // hit moment), so both "raise on cue" and "hold the block" pass. Dropping it early coaches HOLD IT!
          const GUARD_HOLD = 0.6, now = performance.now();
          if (st.guard) {
            if (!R.guardPend) R.guardPend = now;
            R.guardT = (now - R.guardPend) / 1000;
            if (R.guardT >= GUARD_HOLD && rep(R.guardHeld ? 'still blocking' : 'blocked')) { R.guardPend = now; R.guardT = 0; R.guardHeld = true; }
          } else {
            if (R.guardPend && R.guardT > 0.18 && !R.guardHeld) tip('HOLD IT!', 'keep both fists up');
            R.guardPend = 0; R.guardT = 0; R.guardHeld = false;
          }
          setMeter(st.guard ? Math.min(1, R.guardT / GUARD_HOLD) * 100 : 0, D); break;
        }
        case 'blast': {
          if (CH.det) CH.det.update(dt, ctx.motion, ctx.hero?.info?.height || 1.6);
          const lv = CH.charged ? 1 : CH.level;
          node.style.setProperty('--charge', lv.toFixed(3));
          setMeter(lv * 100, D); break;
        }
      }
    },
    get charge() { return { level: CH.level, charged: CH.charged, source: CH.core ? 'core' : 'local' }; },
    dispose() { off?.(); offCh.forEach((f) => { try { f?.(); } catch { /* */ } }); stopCharge(); },
  };
}
