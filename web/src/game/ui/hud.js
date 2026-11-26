// In-game HUD. Fixed regions on the screen edges (the hero stands lower-middle in the gameplay camera):
//   top-left  hearts + Flow meter      top-right  score      left-middle  combo + multiplier      bottom-right  PiP
// plus ONE message system with two lanes that never stack or collide:
//   TOP lane   (top centre)         banners + warnings: distance warning (3) > boss / warning banners (2) > info (1)
//   LOW lane   (BESIDE the hero, never on it)  move prompts + Act 0 prompts. The plate is placed next to the hero's
//              projected bounds on the side opposite the threat (a left punch / left kick / lean right puts the plate on
//              the right), at chest height, or above the head when neither side fits; clamped to the safe area and kept
//              off the combo, vitals, score, PiP and the skip button. It snaps when a new prompt appears or the side
//              flips (never slides across the hero) and follows the hero smoothly otherwise.
// Each lane shows only its highest-priority live message (ties: newest). Timed messages (banners) only count down
// while visible and are dropped if they wait too long behind a higher-priority one. A low-lane prompt that is
// replaced is removed at once (no cross-fade ghost / double exposure).
// Act 0 coaching (bus 'awaken' { phase: 'wait'|'coach'|'loose'|'auto'|'start'|'end', move, hint, note }): a coaching
// chip under the prompt (animated glyph + hint at 5 s, "almost: any punch works" at 10 s, "let's keep going" at 15 s)
// and a hand-cursor SKIP INTRO button (dwell 1.6 s, right edge, outside the hero; hand-targetable once a spirit has
// waited 5 s, mouse-clickable all intro long). Knockdowns (bus 'knockdown'): red vignette + "GET BACK UP!" + heart refill.
// The distance warning is gated: it must persist ~0.8 s, and it is suppressed during big moves (jump, squat/duck,
// hands up, kicks, charge/blast) and for the demo/autoplay trackers.
// Judgement pop-ups anchor to the strike point but are clamped into a safe area and pushed off the hero's screen
// bounds (never on the legs, never off-screen).
import { h, uiButton, freshFrame, drawSkeleton, DISTANCE_TEXT } from './body.js';
import { GLYPHS, MOVE_NAMES, moveFromText, normMove } from './glyphs.js';

const HEART = '<svg viewBox="0 0 32 30"><path d="M16 29 3.6 16.6A8.2 8.2 0 0 1 15.2 5l.8.8.8-.8a8.2 8.2 0 0 1 11.6 11.6Z"/></svg>';
const JUDGE = {
  perfect: { text: 'PERFECT', cls: 'j-perfect' },
  great: { text: 'GREAT', cls: 'j-great' },
  good: { text: 'GOOD', cls: 'j-good' },
  miss: { text: 'MISS', cls: 'j-miss' },
  block: { text: 'BLOCK', cls: 'j-great' },
  dodge: { text: 'DODGE', cls: 'j-good' },
};
const ARROWS = {
  up: '<svg viewBox="0 0 24 24"><path d="M12 3 4 13h5v8h6v-8h5z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 21 4 11h5V3h6v8h5z"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M3 12 13 4v5h8v6h-8v5z"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M21 12 11 4v5H3v6h8v5z"/></svg>',
};
export const PRIORITY = { info: 1, prompt: 2, warning: 3 };
const DIST_HOLD_S = 0.8;          // a distance problem must persist this long before the warning shows
const BIG_MOVE_QUIET_MS = 700;    // ...and no big move in the last 0.7 s
const BANNER_MAX_WAIT_S = 3.5;    // a banner waiting behind a warning is dropped after this
const COACH_FALLBACK_MS = 5500;   // no 'coach' event from CORE by then: show the generic hint ourselves
const SKIP_HAND_MS = 5000;        // the SKIP INTRO button becomes a hand target once a spirit has waited this long

// threat side of a prompt (screen side the spirit comes from; rear camera: the player's left is screen left)
const THREAT = { punchLeft: 'left', kickLeft: 'left', dodgeRight: 'left', punchRight: 'right', kickRight: 'right', dodgeLeft: 'right' };
const family = (m) => (m ? m.replace(/(Left|Right)$/, '') : null);
const COACH_HINT = {
  punch: 'Snap your fist straight out at the spirit', kick: 'Lift your knee high, then kick forward', jump: 'Bend your knees, then spring up',
  duck: 'Drop fast: bend your knees', dodge: 'Lean your whole upper body to the side', guard: 'Both fists up in front of your face',
  charge: 'Raise both elbows above your shoulders', blast: 'Push both palms at the screen', tpose: 'Arms straight out to the sides',
};
const LOOSE_TEXT = {
  punch: 'ANY PUNCH WORKS', kick: 'ANY KICK OR KNEE-UP WORKS', jump: 'A SMALL HOP WORKS', duck: 'JUST SQUAT DOWN', dodge: 'A SMALL LEAN WORKS',
  guard: 'HANDS UP ANYWHERE WORKS', charge: 'HALF-RAISE YOUR HANDS', blast: 'ANY PUSH WORKS', tpose: 'ARMS OUT IS ENOUGH',
};
const NOTE_MOVE = { striker: 'punch', crawler: 'kick', volley: 'dodge', sweep: 'jump', scythe: 'duck', brute: 'guard', core: 'charge' };
function noteMove(n) {
  if (!n) return null;
  if (n.type === 'striker' || n.type === 'crawler') return NOTE_MOVE[n.type] + (n.side === 'left' ? 'Left' : 'Right');
  if (n.type === 'volley') return n.side === 'left' ? 'dodgeRight' : 'dodgeLeft';
  return normMove(n.move) || normMove(NOTE_MOVE[n.type]) || null;
}

export function createHUD(ctx, root) {
  const el = h('div', { class: 'bl-hud bl-hidden' });
  root.append(el);
  const debug = () => !!(ctx.settings?.dev?.debug || /[?&]debug=1/.test(location.search));

  // ---------------------------------------------------------------- vitals (top-left)
  const hearts = h('div', { class: 'bl-hearts' });
  const flowFill = h('i', { class: 'bl-flow-fill' });
  const flowLabel = h('span', { class: 'bl-flow-label' }, 'FLOW');
  const flow = h('div', { class: 'bl-flow' }, h('div', { class: 'bl-flow-bar' }, flowFill, h('b', { class: 'bl-flow-ticks' })), flowLabel);
  const modeTag = h('div', { class: 'bl-mode-tag' });
  const vitals = h('div', { class: 'bl-vitals' }, hearts, flow, modeTag);
  el.append(vitals);

  // ---------------------------------------------------------------- score (top-right)
  const scoreNum = h('div', { class: 'bl-score-num' }, '0');
  const scoreBox = h('div', { class: 'bl-score' }, h('span', { class: 'bl-score-label' }, 'SCORE'), scoreNum);
  el.append(scoreBox);

  // ---------------------------------------------------------------- combo (left-middle)
  const comboNum = h('div', { class: 'bl-combo-num' }, '0');
  const comboMult = h('div', { class: 'bl-combo-mult' }, '×1');
  const combo = h('div', { class: 'bl-combo is-zero' }, comboNum, h('div', { class: 'bl-combo-label' }, 'COMBO'), comboMult);
  el.append(combo);

  // ---------------------------------------------------------------- lanes + judgements
  const judgeLayer = h('div', { class: 'bl-judge-layer' });
  const topLane = h('div', { class: 'bl-lane bl-lane-top' });
  const lowLane = h('div', { class: 'bl-lane bl-lane-low' });
  const kdVignette = h('div', { class: 'bl-kd-vignette' });
  el.prepend(kdVignette);
  el.append(judgeLayer, topLane, lowLane);
  // Act 0 coaching chip (lives in the low lane, under the prompt plate) + hand-cursor SKIP INTRO (right edge)
  const coachEl = h('div', { class: 'bl-coach bl-hidden' });
  lowLane.append(coachEl);
  const skipBtn = uiButton('SKIP INTRO', () => skipIntro(), { cls: 'is-small bl-awk-skip-btn', id: 'awaken-skip-hand', sub: 'hold 1.6 s' });
  skipBtn.setAttribute('data-ui-dwell', '1.6'); skipBtn.setAttribute('data-ui-nopunch', ''); skipBtn.setAttribute('data-ui-mouseonly', '');
  const skipWrap = h('div', { class: 'bl-awk-skip bl-hidden' }, skipBtn);
  el.append(skipWrap);

  // ---------------------------------------------------------------- PiP (bottom-right)
  const pipCanvas = h('canvas', { class: 'bl-pip-canvas', width: 384, height: 216 });
  const pipStats = h('span', { class: 'bl-pip-stats' }, '—');
  const pipSrc = h('span', { class: 'bl-pip-src' }, 'AI VISION');
  const pip = h('div', { class: 'bl-pip' }, pipCanvas, h('div', { class: 'bl-pip-bar' }, h('i', { class: 'bl-pip-rec' }), pipSrc, pipStats), h('div', { class: 'bl-pip-corners' }));
  el.append(pip);
  const pg = pipCanvas.getContext('2d');

  // ---------------------------------------------------------------- state
  const S = { shown: false, score: 0, scoreShown: 0, combo: 0, mult: 1, health: -1, max: -1, flow: -1, overdrive: null, prompt: null, distance: undefined, distanceShown: null };
  const pipS = { video: null, kp: null, edges: null, kpT: -1e9, drawT: 0, lastFrame: null, frames: 0, fps: 0, fpsT: performance.now(), lat: 0 };
  const D = { raw: null, held: 0, bigAt: -1e9, chargeAt: -1e9 };   // distance gating
  const offBus = [];
  if (ctx.bus?.on) {
    offBus.push(ctx.bus.on('charge', (d) => { if (d && (d.level > 0 || d.charged)) D.chargeAt = performance.now(); }));
    offBus.push(ctx.bus.on('blast', () => { D.chargeAt = performance.now(); }));
    offBus.push(ctx.bus.on('awaken', (d) => onAwaken(d)));
    offBus.push(ctx.bus.on('knockdown', (d) => { if (S.shown) knockdown(d || {}); }));
  }

  // ================================================================ hero screen bounds (projected bones, cached per frame)
  const HB = { ok: false, l: 0, r: 0, t: 0, b: 0, cx: 0, t0: -1 };
  const BONES = ['head', 'hips', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftShoulder', 'rightShoulder'];
  let _v = null;
  function heroBounds() {
    const now = performance.now();
    if (now - HB.t0 < 30) return HB.ok ? HB : null;
    HB.t0 = now; HB.ok = false;
    const hero = ctx.hero, cam = ctx.camera;
    if (!hero?.bones || !cam || !ctx.THREE) return null;
    _v ||= new ctx.THREE.Vector3();
    const W = innerWidth, H = innerHeight;
    let l = 1e9, r = -1e9, t = 1e9, b = -1e9, n = 0;
    for (const name of BONES) {
      const bone = hero.bones[name];
      if (!bone) continue;
      bone.getWorldPosition(_v);
      if (name === 'head') _v.y += 0.14;
      _v.project(cam);
      if (_v.z > 1 || _v.z < -1) continue;
      const x = (_v.x * 0.5 + 0.5) * W, y = (-_v.y * 0.5 + 0.5) * H;
      if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; n++;
    }
    if (n < 4 || r - l < 4 || b - t < 20) return null;
    const pad = Math.max(10, (r - l) * 0.12);
    Object.assign(HB, { ok: true, l: l - pad, r: r + pad, t: t - pad * 0.5, b: Math.min(H, b + pad * 0.5), cx: (l + r) / 2 });
    return HB;
  }

  // ================================================================ lanes
  let msgSeq = 0;
  function createLane(host, name) {
    const L = { name, msgs: new Map(), cur: null };
    L.set = (id, m) => {
      const old = L.msgs.get(id);
      if (old && old.key === m.key) { Object.assign(old, { priority: m.priority }); return old; }
      if (old) retire(L, old, true);
      const msg = { id, seq: ++msgSeq, waited: 0, shownFor: 0, ...m, node: null };
      L.msgs.set(id, msg);
      return msg;
    };
    L.clear = (id) => { const m = L.msgs.get(id); if (m) { L.msgs.delete(id); retire(L, m); } };
    L.clearAll = () => { for (const m of [...L.msgs.values()]) retire(L, m); L.msgs.clear(); L.cur = null; host.replaceChildren(); };
    L.update = (dt) => {
      let best = null;
      for (const m of L.msgs.values()) if (!best || m.priority > best.priority || (m.priority === best.priority && m.seq > best.seq)) best = m;
      if (best !== L.cur) {
        // low lane: a replaced prompt goes at once (a cross-fade reads as a double exposure); a cleared one fades fast
        if (L.cur && L.cur.node) hideNode(L.cur, name === 'low' ? (best ? 0 : 110) : undefined);
        L.cur = best;
        if (best) showNode(host, best);
      }
      for (const m of [...L.msgs.values()]) {
        if (m === L.cur) m.shownFor += dt; else m.waited += dt;
        if (m.ttl && (m.shownFor >= m.ttl || (m !== L.cur && m.waited > BANNER_MAX_WAIT_S))) L.clear(m.id);
      }
    };
    return L;
  }
  // replaced (same id, new content) on the low lane: the outgoing plate goes in the same frame (QA r3 art P1-1: a
  // fading HANDS UP plate under PUSH! read as "KE·PUSH!·M UP…"); a plain clear still fades fast
  function retire(L, m, replaced = false) { if (L.cur === m) L.cur = null; if (m.node) hideNode(m, L.name === 'low' ? (replaced ? 0 : 110) : undefined); }
  function showNode(host, m) {
    if (!m.node) m.node = m.render();
    // never two prompt plates at once: anything still fading out on this lane goes now
    if (m.prompt) for (const n of host.querySelectorAll(':scope > .bl-prompt')) if (n !== m.node) { n.getAnimations().forEach((a) => a.cancel()); n.remove(); }
    m.node.getAnimations().forEach((a) => a.cancel());
    host.append(m.node);
    m.node.animate(m.enter || [{ opacity: 0, transform: 'scale(1.4)' }, { opacity: 1, transform: 'none' }], { duration: m.enterMs || 240, easing: 'cubic-bezier(.2,1.3,.4,1)', fill: 'both' });
  }
  function hideNode(m, ms) {
    const n = m.node;
    if (!n || !n.isConnected) return;
    n.getAnimations().forEach((a) => a.cancel());
    if (ms === 0) { n.remove(); return; }
    n.animate(m.exit || [{ opacity: 1 }, { opacity: 0, transform: 'scale(.92)' }], { duration: ms ?? m.exitMs ?? 200, easing: 'ease-in', fill: 'both' }).onfinish = () => { if (!m.node || m.node === n) n.remove(); };
  }
  const lanes = { top: createLane(topLane, 'top'), low: createLane(lowLane, 'low') };

  // ---- renderers
  function bannerMsg(text, sub, warn) {
    return {
      key: `b:${text}:${sub}`,
      render: () => h('div', { class: 'bl-banner' + (warn ? ' is-warn' : '') },
        h('div', { class: 'bl-banner-stripe' }),
        h('div', { class: 'bl-banner-text', 'data-text': text }, text),
        sub ? h('div', { class: 'bl-banner-sub' }, sub) : null),
      enter: [{ opacity: 0, transform: 'translateX(-24%) skewX(-12deg) scaleY(.2)' }, { opacity: 1, transform: 'translateX(0) skewX(-12deg) scaleY(1)' }],
      exit: [{ opacity: 1, transform: 'translateX(0) skewX(-12deg) scaleY(1)' }, { opacity: 0, transform: 'translateX(24%) skewX(-12deg) scaleY(.6)' }],
      enterMs: 300, exitMs: 320,
    };
  }
  function promptMsg(text, o = {}) {
    const move = normMove(o.move) || moveFromText(text);
    const wait = !!o.wait;
    const label = text || (move ? MOVE_NAMES[move] : '');
    const sub = o.sub ?? (wait ? 'DO THE MOVE TO CONTINUE' : '');
    const threat = o.side === 'left' || o.side === 'right' ? o.side : THREAT[move] || null;
    return {
      key: `p:${label}:${move}:${wait}:${sub}`, move, threat, prompt: true,
      render: () => h('div', { class: 'bl-prompt' + (wait ? ' is-wait' : '') + (o.tone ? ' t-' + o.tone : '') },
        move ? h('div', { class: 'bl-prompt-glyph', html: GLYPHS[move] }, wait ? h('i', { class: 'bl-prompt-ring' }) : null) : null,
        h('div', { class: 'bl-prompt-body' },
          o.kicker ? h('span', { class: 'bl-prompt-kicker' }, o.kicker) : null,
          h('b', { class: 'bl-prompt-text', 'data-text': label }, label),
          sub ? h('span', { class: 'bl-prompt-sub' }, sub) : null)),
      // single clean entrance: a short rise + fade (no oversized ghost copy behind the real plate)
      enter: [{ opacity: 0, transform: 'translateY(10px) scale(.96)' }, { opacity: 1, transform: 'none' }],
      enterMs: wait ? 180 : 120, exitMs: 110,
    };
  }
  function distanceMsg(state) {
    const Dt = DISTANCE_TEXT[state] || { title: state, sub: '', arrow: 'up' };
    return {
      key: `d:${state}`,
      render: () => h('div', { class: 'bl-distance' }, h('i', { class: `bl-dist-arrow a-${Dt.arrow}`, html: ARROWS[Dt.arrow] }), h('b', {}, Dt.title), h('span', {}, Dt.sub)),
      enter: [{ opacity: 0, transform: 'translateY(-60%)' }, { opacity: 1, transform: 'none' }], enterMs: 260,
    };
  }

  // ================================================================ setters
  function setHealth(hp, max = 5) {
    hp = Math.max(0, Math.round(hp)); max = Math.max(1, Math.round(max));
    if (max !== S.max) {
      hearts.replaceChildren(...Array.from({ length: max }, () => h('i', { class: 'bl-heart', html: HEART })));
      S.max = max; S.health = max;
    }
    if (hp === S.health) return;
    const kids = hearts.children;
    for (let i = 0; i < max; i++) {
      const was = i < S.health, now = i < hp;
      kids[i].classList.toggle('is-lost', !now);
      if (was && !now) kids[i].animate([{ transform: 'scale(1.5) rotate(-12deg)', filter: 'brightness(3)' }, { transform: 'scale(.8) rotate(8deg)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
      if (!was && now) kids[i].animate([{ transform: 'scale(0)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 360, easing: 'ease-out' });
    }
    hearts.classList.toggle('is-low', hp <= 1);
    hearts.classList.toggle('is-empty', hp <= 0);
    if (hp < S.health) el.animate([{ translate: '6px 0' }, { translate: '-5px 0' }, { translate: '3px 0' }, { translate: '0 0' }], { duration: 260 });
    S.health = hp;
  }

  function setFlow(v, overdrive = false) {
    v = Math.max(0, Math.min(1, v));
    if (Math.abs(v - S.flow) > 0.002) { flowFill.style.transform = `scaleX(${v.toFixed(3)})`; S.flow = v; }
    if (overdrive !== S.overdrive) {
      S.overdrive = overdrive;
      flow.classList.toggle('is-overdrive', !!overdrive);
      el.classList.toggle('is-overdrive', !!overdrive);
      flowLabel.textContent = overdrive ? 'OVERDRIVE ×2' : 'FLOW';
      if (overdrive) flow.animate([{ scale: '1.25' }, { scale: '1' }], { duration: 500, easing: 'cubic-bezier(.2,1.6,.4,1)' });
    }
    flow.classList.toggle('is-full', v >= 0.999 && !overdrive);
  }

  function setCombo(n, mult = 1) {
    n = Math.max(0, n | 0);
    if (n === S.combo && mult === S.mult) return;
    const broke = n < S.combo && S.combo >= 5;
    comboNum.textContent = n;
    comboMult.textContent = '×' + mult;
    combo.classList.toggle('is-zero', n < 2);
    combo.dataset.mult = mult;
    if (n > S.combo) comboNum.animate([{ scale: '1.35', filter: 'brightness(2)' }, { scale: '1' }], { duration: 180, easing: 'ease-out' });
    if (mult > S.mult) comboMult.animate([{ scale: '2', rotate: '-14deg' }, { scale: '1', rotate: '0deg' }], { duration: 420, easing: 'cubic-bezier(.2,1.6,.4,1)' });
    if (broke) {
      const ghost = h('div', { class: 'bl-combo-break' }, 'COMBO BREAK');
      combo.append(ghost);
      ghost.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 30px' }], { duration: 900, easing: 'ease-in' }).onfinish = () => ghost.remove();
    }
    S.combo = n; S.mult = mult;
  }

  /** Top-lane banner. opts: { priority: 'info'|'warning'|number, duration (s) }. Warnings auto-detected from the text. */
  function banner(text, sub = '', opts = {}) {
    if (!text) return;
    if (/knocked down/i.test(text) && performance.now() - kdAt < 3000) return;   // knockdown() already says it
    const warn = opts.warn ?? /warning|boss|warden|weak point/i.test(text + ' ' + sub);
    const pr = typeof opts.priority === 'number' ? opts.priority : opts.priority === 'warning' || (opts.priority === undefined && warn) ? 2 : 1;
    // one banner id per priority class: a new info banner replaces a queued info banner
    lanes.top.set(pr >= 2 ? 'banner-warn' : 'banner', { ...bannerMsg(text, sub, warn), priority: pr, ttl: opts.duration ?? (warn ? 2.8 : 2.2) });
  }

  /**
   * Low-lane prompt next to the hero. prompt(null) clears it.
   * opts: { move, wait (Act 0 "do the move to continue" style), sub, kicker, tone: 'warn'|'gold', priority }
   */
  function prompt(text, opts = {}) {
    if (text && typeof text === 'object') { opts = text; text = opts.text || null; }
    const key = text || opts.move ? JSON.stringify([text, opts.move, opts.wait, opts.sub, opts.kicker, opts.tone]) : null;
    if (!key) {
      if (S.prompt && opts.success) promptSuccess(opts.success === true ? 'NICE!' : opts.success);
      if (opts.success && C.stage && C.stage !== 'auto') coach(null);     // the waiting move was answered
      S.prompt = null; lanes.low.clear('prompt'); return;
    }
    if (key === S.promptKey && S.prompt) return;
    if (/^get back up/i.test(text || '') && performance.now() - kdAt < 3000) return;   // already in the top lane
    S.prompt = text || opts.move; S.promptKey = key;
    lanes.low.set('prompt', { ...promptMsg(text, opts), priority: opts.priority ?? PRIORITY.prompt });
  }
  function promptSuccess(text) {
    const n = h('div', { class: 'bl-prompt-ok' }, text);
    lowLane.append(n);
    n.animate([{ opacity: 0, transform: 'scale(1.8)' }, { opacity: 1, transform: 'scale(1)', offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0, transform: 'translateY(-30px)' }], { duration: 800, easing: 'ease-out', fill: 'both' }).onfinish = () => n.remove();
  }

  /** Generic message on a lane: message(id, { lane: 'top'|'low', text, sub, priority, ttl, move, wait }); message(id, null) clears. */
  function message(id, m) {
    if (!m) { lanes.top.clear(id); lanes.low.clear(id); return; }
    const lane = lanes[m.lane === 'low' ? 'low' : 'top'];
    const pr = typeof m.priority === 'number' ? m.priority : PRIORITY[m.priority] ?? 1;
    const body = lane.name === 'low' ? promptMsg(m.text, m) : bannerMsg(m.text, m.sub || '', pr >= 2);
    lane.set(id, { ...body, priority: pr, ttl: m.ttl });
  }

  /** Raw distance state from CORE (or ui.measureDistance). Shown only after the gating in update(). */
  function distance(state) { D.raw = state || null; }

  function bigMoveActive(now) {
    const A = ctx.motion?.actions, st = A?.state || {}, lf = A?.lastFire || {};
    const recent = (k, ms) => now - (lf[k] ?? -1e9) < ms;
    const ch = ctx.game?.charge;
    return !!(st.jump || st.squat || st.handsUp || st.leftHandUp || st.rightHandUp || st.tPose || st.kickLeft || st.kickRight
      || recent('jump', 1000) || recent('kickLeft', 900) || recent('kickRight', 900) || recent('squat', 600) || recent('handsUp', 600)
      || (ch && (ch.level > 0.05 || ch.charged)) || now - D.chargeAt < 900);
  }
  function distanceSuppressed() {
    const k = ctx.game?.tracking?.kind;
    return k === 'demo' || k === 'autoplay' || !!ctx.settings?.dev?.autoplay;
  }
  function updateDistance(dt, now) {
    let show = null;
    if (D.raw && !distanceSuppressed()) {
      if (bigMoveActive(now)) D.bigAt = now;
      if (D.raw === D.cand) D.held += dt; else { D.cand = D.raw; D.held = 0; }
      if (now - D.bigAt < BIG_MOVE_QUIET_MS) D.held = 0;
      if (D.held >= DIST_HOLD_S) show = D.raw;
      else if (S.distanceShown === D.raw && now - D.bigAt >= BIG_MOVE_QUIET_MS) show = D.raw;   // keep showing while it persists
    } else { D.cand = null; D.held = 0; }
    if (show !== S.distanceShown) {
      S.distanceShown = show;
      if (show) lanes.top.set('distance', { ...distanceMsg(show), priority: PRIORITY.warning });
      else lanes.top.clear('distance');
    }
  }

  // ================================================================ judgement pop-ups (clamped to a safe area)
  const recentJ = [];
  function judgement(pos, kind, extra = {}) {
    const J = JUDGE[kind] || { text: String(kind).toUpperCase(), cls: 'j-good' };
    const W = innerWidth, H = innerHeight;
    let x = pos?.x ?? W / 2, y = pos?.y ?? H * 0.4;
    if (x <= 1.5 && y <= 1.5) { x *= W; y *= H; }
    let tag = null;
    const err = extra.errMs;
    if (Number.isFinite(err)) {
      if (debug()) tag = h('small', {}, `${err > 0 ? '+' : ''}${Math.round(err)} ms`);
      else if (kind !== 'perfect' && kind !== 'miss' && Math.abs(err) >= 40) tag = h('small', { class: err < 0 ? 'is-early' : 'is-late' }, err < 0 ? 'EARLY' : 'LATE');
    }
    const j = h('div', { class: 'bl-judge ' + J.cls }, h('span', { 'data-text': J.text }, J.text), tag);
    j.style.left = '0px'; j.style.top = '0px'; j.style.visibility = 'hidden';
    judgeLayer.append(j);
    const hw = Math.max(60, j.offsetWidth * 0.55), hh = Math.max(24, j.offsetHeight * 0.6);
    ({ x, y } = placeJudgement(x, y, hw, hh, W, H));
    j.style.left = x + 'px'; j.style.top = y + 'px'; j.style.visibility = '';
    while (judgeLayer.children.length > 8) judgeLayer.firstChild.remove();
    const big = kind === 'perfect';
    j.animate([
      { opacity: 0, transform: `translate(-50%,-50%) scale(${big ? 2.2 : 1.6}) rotate(-6deg)` },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(-6deg)', offset: 0.14 },
      { opacity: 1, transform: 'translate(-50%,-62%) scale(1) rotate(-6deg)', offset: 0.7 },
      { opacity: 0, transform: 'translate(-50%,-90%) scale(.9) rotate(-6deg)' }], { duration: kind === 'miss' ? 700 : 820, easing: 'cubic-bezier(.15,.9,.3,1)' }).onfinish = () => j.remove();
    return { x, y };
  }
  /** Safe-area + hero-avoidance placement. Exposed for tests as hud.placeJudgement. */
  function placeJudgement(x, y, hw = 110, hh = 30, W = innerWidth, H = innerHeight) {
    const u = Math.min(W / 100, H * 0.016);
    const safe = { l: hw + u * 2, r: W - hw - u * 2, t: H * 0.2 + hh, b: H * 0.8 - hh };
    // PiP corner (bottom-right) and score (top-right) are no-go boxes
    const clampSafe = () => { x = Math.min(safe.r, Math.max(safe.l, x)); y = Math.min(safe.b, Math.max(safe.t, y)); if (x > W - u * 20 - hw && y > H - u * 13 - hh) y = H - u * 13 - hh; };
    clampSafe();
    const hb = heroBounds();
    if (hb) {
      const inX = x + hw > hb.l && x - hw < hb.r, inY = y + hh > hb.t && y - hh < hb.b;
      const legsY = hb.t + (hb.b - hb.t) * 0.45;
      if (inX && inY) {
        const side = x < hb.cx ? -1 : 1;
        const out = (s) => (s < 0 ? hb.l - hw - u : hb.r + hw + u);
        x = out(side);
        if (x < safe.l || x > safe.r) x = out(-side);          // hero at the edge: use the other side
        y = Math.min(y, legsY);                                   // never at leg height next to the body either
        y = Math.max(y, hb.t + hh);
      }
      clampSafe();
      // last resort (huge hero): sit above the head
      if (x + hw > hb.l && x - hw < hb.r && y + hh > hb.t && y - hh < hb.b) y = Math.max(H * 0.12 + hh, hb.t - hh - u);
    }
    // never on top of the prompt plate (it sits beside the hero, so a pop-up pushed sideways can land on it)
    const pm = lanes.low.cur?.node;
    if (pm && pm.isConnected && laneX >= 0) {
      const pw = pm.offsetWidth / 2, ph = pm.offsetHeight / 2;
      if (Math.abs(x - laneX) < pw + hw && Math.abs(y - laneY) < ph + hh) y = laneY - ph - hh - u;
    }
    // de-overlap with pop-ups from the last 0.6 s
    const now = performance.now();
    while (recentJ.length && now - recentJ[0].t > 600) recentJ.shift();
    for (let k = 0; k < 4 && recentJ.some((p) => Math.abs(p.x - x) < hw * 1.4 && Math.abs(p.y - y) < hh * 1.6); k++) y -= hh * 1.7;
    y = Math.max(H * 0.12 + hh, y);
    recentJ.push({ x, y, t: now });
    return { x, y };
  }

  // ---------------------------------------------------------------- PiP drawing (~30 Hz)
  function drawPip(now) {
    const W = pipCanvas.width, H = pipCanvas.height;
    const frame = freshFrame(ctx.motion, 800, now);
    if (frame && frame !== pipS.lastFrame) {
      pipS.lastFrame = frame; pipS.frames++;
      if (frame.tArrive && frame.tCapture) pipS.lat += (frame.tArrive - frame.tCapture - pipS.lat) * 0.1;
    }
    if (now - pipS.fpsT > 1000) {
      pipS.fps = Math.round(pipS.frames * 1000 / (now - pipS.fpsT)); pipS.frames = 0; pipS.fpsT = now;
      // no camera (demo / autoplay bot): no tracker stats (QA r3 art P2-9: "24 fps · 45 ms" / "0 fps" read as lag)
      const synth = frame?.source === 'synthetic' || /^(demo|autoplay)$/.test(ctx.game?.tracking?.kind || '');
      pipStats.textContent = !frame ? 'NO SIGNAL' : synth ? '' : pipS.fps > 0 ? `${pipS.fps} fps · ${Math.round(pipS.lat)} ms` : '—';
      pipStats.hidden = !!frame && synth;
      const src = { hmr: 'INSTANT HMR', mediapipe: 'MEDIAPIPE', synthetic: 'DEMO PLAYER', recorded: 'REPLAY' }[frame?.source] || 'AI VISION';
      if (pipSrc.textContent !== src) pipSrc.textContent = src;
      pip.classList.toggle('is-lost', !frame);
    }
    pg.setTransform(1, 0, 0, 1, 0, 0);
    const v = pipS.video;
    if (v && v.readyState >= 2 && v.videoWidth) {
      const s = Math.max(W / v.videoWidth, H / v.videoHeight), dw = v.videoWidth * s, dh = v.videoHeight * s;
      pg.save(); pg.translate(W, 0); pg.scale(-1, 1);           // selfie view
      pg.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      pg.restore();
      pg.fillStyle = 'rgba(10,6,30,0.45)'; pg.fillRect(0, 0, W, H);
    } else {
      const g = pg.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#1a1036'); g.addColorStop(1, '#0a0618');
      pg.fillStyle = g; pg.fillRect(0, 0, W, H);
      pg.strokeStyle = 'rgba(140,120,255,0.14)'; pg.lineWidth = 1; pg.beginPath();
      for (let x = 0; x <= W; x += 24) { pg.moveTo(x, 0); pg.lineTo(x, H); }
      for (let y = 0; y <= H; y += 24) { pg.moveTo(0, y); pg.lineTo(W, y); }
      pg.stroke();
    }
    let kp = null, edges = null, fr = null;
    if (now - pipS.kpT < 500) { kp = pipS.kp; edges = pipS.edges; fr = pipS.selfie ? { source: 'synthetic' } : { source: 'camera' }; }
    else if (frame) { kp = frame.kp2d; edges = frame.edges; fr = frame; }
    if (kp && kp.length) {
      let vw = 16, vh = 9;
      if (v && v.videoWidth) { vw = v.videoWidth; vh = v.videoHeight; }
      const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
      // no video: the skeleton sits in a padded box below the label bar (arms-up poses no longer cross the label)
      const map = v && v.videoWidth ? (x, y) => [ox + x * vw * s, oy + y * vh * s] : (x, y) => [W * (0.22 + x * 0.56), H * (0.2 + y * 0.74)];
      drawSkeleton(pg, fr, kp, edges, map, { width: 2.6, glow: 12 });
    }
  }

  // ================================================================ low-lane placement (beside the hero, never on it)
  const KO = { t: -1e9, rects: [] };
  function keepOuts(now) {
    if (now - KO.t < 250) return KO.rects;
    KO.t = now; KO.rects = [];
    for (const n of [vitals, scoreBox, combo, pip, skipWrap]) {
      if (!n.isConnected || n.classList.contains('bl-hidden')) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) KO.rects.push({ l: r.left - 10, t: r.top - 10, r: r.right + 10, b: r.bottom + 10 });
    }
    return KO.rects;
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  let lastSide = 1;
  /**
   * Centre for a w x h box: beside the hero (opposite the threat side) at chest height, else above the head, clamped to
   * the safe area; candidates are scored by overlap with the hero (x40) and the HUD keep-outs. Exposed as hud.placePrompt.
   */
  function placePrompt(w, h, threat = null, now = performance.now()) {
    const W = innerWidth, H = innerHeight, u = Math.min(W / 100, H * 0.016);
    const safe = { l: u * 1.4, r: W - u * 1.4, t: H * 0.16, b: H - u * 1.2 };
    const hb = heroBounds();
    const ko = keepOuts(now);
    const cands = [];
    if (hb) {
      const gap = u * 1.4, hh = hb.b - hb.t;
      const yMid = hb.t + hh * 0.4;
      const roomR = safe.r - hb.r, roomL = hb.l - safe.l;
      let sides;
      if (threat === 'left') sides = [1, -1];
      else if (threat === 'right') sides = [-1, 1];
      else {
        const pref = (lastSide > 0 ? roomR : roomL) >= w + gap ? lastSide : roomR >= roomL ? 1 : -1;
        sides = [pref, -pref];
      }
      const beside = (sd, dy) => ({ x: sd > 0 ? hb.r + gap + w / 2 : hb.l - gap - w / 2, y: yMid + dy * hh, side: sd });
      for (const dy of [0, -0.14, 0.12, -0.28]) cands.push(beside(sides[0], dy));
      cands.push({ x: hb.cx, y: hb.t - gap - h / 2, side: 0 });                    // above the head
      for (const dy of [0, -0.14, 0.12, -0.28]) cands.push(beside(sides[1], dy));   // threat side, still off the body
    } else cands.push({ x: W * 0.5, y: H * 0.3, side: 0 });
    let best = null, bestCost = Infinity;
    const heroR = hb ? { l: hb.l, r: hb.r, t: hb.t, b: hb.b } : null;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const x = Math.min(safe.r - w / 2, Math.max(safe.l + w / 2, c.x)), y = Math.min(safe.b - h / 2, Math.max(safe.t + h / 2, c.y));
      const box = { l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 };
      let cost = heroR ? overlap(box, heroR) * 40 : 0;
      for (const k of ko) cost += overlap(box, k);
      cost += (Math.abs(x - c.x) + Math.abs(y - c.y)) * 0.5 + i * 2;            // prefer unclamped, earlier candidates
      if (cost < bestCost) { bestCost = cost; best = { x, y, side: c.side, clean: heroR ? overlap(box, heroR) === 0 : true }; }
    }
    if (best.side) lastSide = best.side;
    return best;
  }

  // ---------------------------------------------------------------- per frame
  let laneY = -1, laneX = -1, laneMsg = null, laneSide = 0, coachH = 0;
  function placeLowLane(dt, now) {
    const m = lanes.low.cur;
    const node = m?.node && m.node.isConnected ? m.node : null;
    const coachOn = !coachEl.classList.contains('bl-hidden');
    if (!node && !coachOn) { laneMsg = null; return; }
    // measured size of the plate (+ the coaching chip below it); offset sizes ignore the entrance transform
    const pw = node ? node.offsetWidth : 0, ph = node ? node.offsetHeight : 0;
    const gap = coachOn && node ? Math.min(innerWidth / 100, innerHeight * 0.016) * 0.6 : 0;
    coachH = coachOn ? coachEl.offsetHeight : 0;
    const cw = coachOn ? coachEl.offsetWidth : 0;
    let w = Math.max(pw, cw, 40), h = ph + gap + coachH;
    let p = placePrompt(w, h, m?.threat ?? null, now);
    // size-aware (QA r3 art P1-1): a plate too wide for the room beside (or above) the hero drops its kicker and
    // sub-line and is placed again, rather than landing on the torso
    if (!p.clean && node && !node.classList.contains('is-compact') && node.querySelector('.bl-prompt-sub, .bl-prompt-kicker')) {
      node.classList.add('is-compact');
      const pw2 = node.offsetWidth, ph2 = node.offsetHeight;
      w = Math.max(pw2, cw, 40); h = ph2 + gap + coachH;
      p = placePrompt(w, h, m?.threat ?? null, now);
      return placeAt(p, node, ph2, h, gap, coachOn, m, dt);
    }
    return placeAt(p, node, ph, h, gap, coachOn, m, dt);
  }
  function placeAt(p, node, ph, h, gap, coachOn, m, dt) {
    const tx = p.x, ty = p.y - h / 2 + ph / 2;                               // plate centre
    const snap = laneY < 0 || m !== laneMsg || (p.side && laneSide && p.side !== laneSide);
    const k = snap ? 1 : 1 - Math.exp(-dt * 10);
    laneX = snap ? tx : laneX + (tx - laneX) * k; laneY = snap ? ty : laneY + (ty - laneY) * k;
    laneMsg = m; if (p.side) laneSide = p.side;
    lowLane.style.transform = `translate(${laneX.toFixed(1)}px, ${laneY.toFixed(1)}px)`;
    if (coachOn) coachEl.style.top = `${(node ? ph / 2 + gap : -coachH / 2).toFixed(1)}px`;
    lowLane.dataset.side = p.side > 0 ? 'right' : p.side < 0 ? 'left' : 'above';
    lowLane.dataset.clean = p.clean ? '1' : '0';
  }

  // ================================================================ Act 0 coaching + SKIP INTRO
  const C = { stage: null, move: null, hint: '', t: 0, autoT: 0 };
  const AWK = { on: false, waitAt: 0, note: null, coachSeen: false, localCoach: false };
  /** coach({ stage: 'coach'|'loose'|'auto', move?, hint? } | null): the chip under the Act 0 prompt. */
  function coach(o) {
    if (!o || !o.stage) { C.stage = null; coachEl.classList.add('bl-hidden'); coachEl.replaceChildren(); return; }
    const move = normMove(o.move) || normMove(family(o.move)) || C.move || null;
    const fam = family(move);
    const hint = o.hint || COACH_HINT[fam] || '';
    C.stage = o.stage; C.move = move; C.hint = hint; C.t = performance.now();
    const glyph = move && o.stage !== 'auto' ? h('i', { class: `bl-coach-glyph m-${fam}`, html: GLYPHS[move] }) : null;
    let body;
    if (o.stage === 'coach') body = h('div', { class: 'bl-coach-body' }, h('span', { class: 'bl-coach-tag' }, 'TRY THIS'), h('b', {}, hint || 'Do the move shown above'), h('em', { class: 'bl-coach-like' }, 'LIKE THIS'));
    else if (o.stage === 'loose') body = h('div', { class: 'bl-coach-body' }, h('span', { class: 'bl-coach-tag' }, 'ALMOST!'), h('b', {}, (o.text || LOOSE_TEXT[fam] || 'ANY MOVE WORKS').toUpperCase()));
    else body = h('div', { class: 'bl-coach-body' }, h('b', {}, o.text || "LET'S KEEP GOING!"));
    coachEl.className = `bl-coach s-${o.stage}`;
    coachEl.replaceChildren(...[glyph, body].filter(Boolean));
    coachEl.getAnimations().forEach((a) => a.cancel());
    coachEl.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
    if (o.stage === 'auto') C.autoT = performance.now();
  }
  function setSkipHand(on) { skipBtn.toggleAttribute('data-ui-mouseonly', !on); skipWrap.classList.toggle('is-hand', !!on); }
  function showSkip(on) {
    skipWrap.classList.toggle('bl-hidden', !on);
    root.toggleAttribute('data-awaken-ui', !!on);      // CORE's mouse-only fallback button stands down (game.css)
    if (!on) setSkipHand(false);
    KO.t = -1e9;
  }
  function skipIntro() {
    showSkip(false); coach(null);
    try { if (ctx.game?.skipAwaken) ctx.game.skipAwaken(); else ctx.bus?.emit?.('awaken:skip', {}); } catch (e) { console.error(e); }
  }
  /** The move a coaching event is about (the brute in its punch phase wants punches, not a guard). */
  function awkMove(d) {
    const n = d.note || AWK.note;
    if (n?.type === 'brute' && n.phase === 'punch') return 'punch';
    return noteMove(n) || d.move;
  }
  function onAwaken(d = {}) {
    const now = performance.now();
    switch (d.phase) {
      case 'start': AWK.on = true; AWK.waitAt = 0; AWK.coachSeen = false; coach(null); showSkip(true); break;
      case 'wait': AWK.waitAt = now; AWK.note = d.note || null; AWK.localCoach = false; if (C.stage !== 'auto') coach(null); setSkipHand(false); if (!AWK.on) { AWK.on = true; showSkip(true); } break;
      case 'coach': AWK.coachSeen = true; coach({ stage: 'coach', move: awkMove(d), hint: d.hint }); setSkipHand(true); break;
      case 'loose': AWK.coachSeen = true; coach({ stage: 'loose', move: awkMove(d), hint: d.hint, text: d.text }); setSkipHand(true); break;
      case 'auto': case 'assist': coach({ stage: 'auto', move: d.move, text: d.text }); AWK.waitAt = 0; setSkipHand(false); break;
      case 'resolved': case 'release': if (C.stage !== 'auto') coach(null); AWK.waitAt = 0; setSkipHand(false); break;
      case 'end': AWK.on = false; AWK.waitAt = 0; coach(null); showSkip(false); break;
      default: break;
    }
  }
  function updateAwaken(now) {
    if (C.stage === 'auto' && now - C.autoT > 1600) coach(null);
    // CORE may put the same hint in the prompt's sub-line (or flash "LET'S KEEP GOING!" as the prompt): never say it twice
    if (C.stage) {
      const pn = lanes.low.cur?.node;
      const sub = pn?.querySelector('.bl-prompt-sub')?.textContent?.trim().toLowerCase() || '';
      const txt = pn?.querySelector('.bl-prompt-text')?.textContent?.trim().toLowerCase() || '';
      const dupe = C.stage === 'coach' ? !!sub && sub === C.hint.trim().toLowerCase() : C.stage === 'auto' ? /keep going/.test(txt) : false;
      if (coachEl.classList.contains('is-compact') !== dupe) coachEl.classList.toggle('is-compact', dupe);
    }
    if (!AWK.on || !AWK.waitAt) return;
    const waited = now - AWK.waitAt;
    // the wait ended without an event (CORE resolved the note): a resolved note or no waiting prompt clears the chip
    if (AWK.note && AWK.note.resolved) { AWK.waitAt = 0; if (C.stage !== 'auto') coach(null); setSkipHand(false); return; }
    if (waited > SKIP_HAND_MS && skipBtn.hasAttribute('data-ui-mouseonly')) setSkipHand(true);
    if (!AWK.coachSeen && !AWK.localCoach && waited > COACH_FALLBACK_MS) { AWK.localCoach = true; coach({ stage: 'coach', move: noteMove(AWK.note) || lanes.low.cur?.move }); }
  }

  // ================================================================ knockdown
  /** knockdown({ health, max, count }?): red vignette + "GET BACK UP!" (top lane) + staggered heart refill. */
  let kdAt = -1e9;
  function knockdown(d = {}) {
    const now = performance.now();
    if (now - kdAt < 1200) return;                      // bus 'knockdown' + CORE's direct call for the same knockdown
    kdAt = now;
    const reduce = !!ctx.settings?.reduceFlashes;
    if (/knocked/i.test(lanes.top.msgs.get('banner-warn')?.key || '')) lanes.top.clear('banner-warn');
    kdVignette.getAnimations().forEach((a) => a.cancel());
    kdVignette.animate(reduce
      ? [{ opacity: 0 }, { opacity: 0.55, offset: 0.25 }, { opacity: 0.45, offset: 0.7 }, { opacity: 0 }]
      : [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 0.55, offset: 0.3 }, { opacity: 0.75, offset: 0.45 }, { opacity: 0 }], { duration: reduce ? 1800 : 1700, easing: 'ease-out' });
    lanes.top.set('knockdown', { ...bannerMsg('GET BACK UP!', d.sub || 'KNOCKED DOWN · HEARTS REFILLED', true), priority: 2.5, ttl: 2.4 });
    if (!reduce) el.animate([{ translate: '0 10px' }, { translate: '-8px -4px' }, { translate: '6px 3px' }, { translate: '0 0' }], { duration: 320 });
    const max = d.max ?? d.maxHealth ?? (S.max > 0 ? S.max : 5);
    setTimeout(() => {
      const sc = ctx.game?.score;
      const hp = Math.round(Number.isFinite(d.health) ? d.health : Number.isFinite(sc?.health) ? sc.health : Math.ceil(max / 2));
      setHealth(hp, max);
      const kids = hearts.children;
      for (let i = 0; i < kids.length; i++) {
        kids[i].getAnimations().forEach((a) => a.cancel());
        if (i >= hp) continue;
        kids[i].animate([{ transform: 'scale(0)', filter: 'brightness(3) saturate(0)' }, { transform: 'scale(1.4)', filter: 'brightness(2)', offset: 0.6 }, { transform: 'scale(1)', filter: 'none' }],
          { duration: 420, delay: i * 120, easing: 'ease-out', fill: 'backwards' });
      }
      hearts.animate([{ filter: 'drop-shadow(0 0 0 transparent)' }, { filter: 'drop-shadow(0 0 14px #6dffb0)' }, { filter: 'drop-shadow(0 0 0 transparent)' }], { duration: 300 + hp * 120 });
    }, 380);
  }

  let rfT = 0;
  function syncReduceFlash(now) {
    if (now - rfT < 400) return;
    rfT = now;
    root.classList.toggle('bl-reduce-flash', !!ctx.settings?.reduceFlashes);
  }

  function update(dt) {
    if (!S.shown) return;
    const now = performance.now();
    if (S.scoreShown !== S.score) {
      const d = S.score - S.scoreShown;
      S.scoreShown = Math.abs(d) < 1 ? S.score : S.scoreShown + d * (1 - Math.exp(-dt * 14));
      scoreNum.textContent = Math.round(S.scoreShown).toLocaleString('en-US');
    }
    updateDistance(dt, now);
    updateAwaken(now);
    syncReduceFlash(now);
    lanes.top.update(dt); lanes.low.update(dt);
    placeLowLane(dt, now);
    if (now - pipS.drawT > 33) { pipS.drawT = now; drawPip(now); }
  }

  return {
    el,
    show(on) {
      on = !!on;
      if (S.shown && !on) { lanes.top.clearAll(); lanes.low.clearAll(); lowLane.append(coachEl); coach(null); showSkip(false); AWK.on = false; AWK.waitAt = 0; S.prompt = null; S.promptKey = null; S.distanceShown = null; D.raw = null; }
      const appear = on && !S.shown;
      S.shown = on; el.classList.toggle('bl-hidden', !on);
      // title / clear-space -> run (QA r3 art P2-3): the HUD fades in only after the outgoing screen is gone (the host
      // fades a hidden screen out in 140 ms), so menu, logo, hearts and SKIP INTRO never share a frame
      if (appear) { el.getAnimations().forEach((a) => a.cancel()); el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 170, easing: 'ease-out', fill: 'backwards' }); }
      if (on && S.max < 0) setHealth(5, 5); if (on && S.flow < 0) setFlow(0, false);
      if (on) { const m = ctx.settings?.mode; modeTag.textContent = m === 'showcase' ? 'SHOWCASE · NO-FAIL' : m === 'challenge' ? 'CHALLENGE' : ''; modeTag.dataset.mode = m || ''; }
    },
    setScore(n) {
      n = Math.round(n);
      if (n > S.score + 50) scoreNum.animate([{ scale: '1.12' }, { scale: '1' }], { duration: 160 });
      S.score = n;
    },
    setCombo, setHealth, setFlow, banner, judgement, prompt, distance, message,
    placeJudgement, heroBounds, placePrompt, coach, knockdown,
    /** Show / hide the hand-cursor SKIP INTRO button by hand (normally driven by bus 'awaken'). */
    awakenSkip(on, { hand = false } = {}) { showSkip(!!on); if (on) setSkipHand(hand); },
    /** Mode badge under the Flow meter: 'showcase' | 'challenge' | null. */
    setMode(m) { modeTag.textContent = m === 'showcase' ? 'SHOWCASE · NO-FAIL' : m === 'challenge' ? 'CHALLENGE' : ''; modeTag.dataset.mode = m || ''; },
    pip: {
      el: pip,
      setVideo(video) { pipS.video = video || null; pip.classList.toggle('has-video', !!video); },
      setSkeleton(kp2d, edges, { selfie } = {}) { pipS.kp = kp2d; pipS.edges = edges; pipS.kpT = performance.now(); pipS.selfie = selfie ?? false; },
    },
    update,
    dispose() { offBus.forEach((f) => { try { f?.(); } catch { /* */ } }); },
    get state() {
      return { ...S, coach: C.stage, awaken: { on: AWK.on, waiting: !!AWK.waitAt, skipVisible: !skipWrap.classList.contains('bl-hidden'), skipHand: !skipBtn.hasAttribute('data-ui-mouseonly') }, lowSide: lowLane.dataset.side || null, lowClean: lowLane.dataset.clean === '1', distanceRaw: D.raw, distanceHeld: +D.held.toFixed(2), lanes: { top: lanes.top.cur?.id ?? null, low: lanes.low.cur?.id ?? null }, queued: { top: [...lanes.top.msgs.keys()], low: [...lanes.low.msgs.keys()] } };
    },
  };
}
