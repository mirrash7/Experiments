// In-game HUD. Fixed regions on the screen edges (the hero stands lower-middle in the gameplay camera):
//   top-left  hearts + Flow meter      top-right  score      left-middle  combo + multiplier      bottom-right  PiP
// plus ONE message system with two lanes that never stack or collide:
//   TOP lane   (top centre)         banners + warnings: distance warning (3) > boss / warning banners (2) > info (1)
//   LOW lane   (lower third, next to the hero, follows the hero's projected bounds)  move prompts + Act 0 prompts
// Each lane shows only its highest-priority live message (ties: newest). Timed messages (banners) only count down
// while visible and are dropped if they wait too long behind a higher-priority one.
// The distance warning is gated: it must persist ~0.8 s, and it is suppressed during big moves (jump, squat/duck,
// hands up, kicks, charge/blast) and for the demo/autoplay trackers.
// Judgement pop-ups anchor to the strike point but are clamped into a safe area and pushed off the hero's screen
// bounds (never on the legs, never off-screen).
import { h, freshFrame, drawSkeleton, DISTANCE_TEXT } from './body.js';
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
  el.append(h('div', { class: 'bl-vitals' }, hearts, flow, modeTag));

  // ---------------------------------------------------------------- score (top-right)
  const scoreNum = h('div', { class: 'bl-score-num' }, '0');
  el.append(h('div', { class: 'bl-score' }, h('span', { class: 'bl-score-label' }, 'SCORE'), scoreNum));

  // ---------------------------------------------------------------- combo (left-middle)
  const comboNum = h('div', { class: 'bl-combo-num' }, '0');
  const comboMult = h('div', { class: 'bl-combo-mult' }, '×1');
  const combo = h('div', { class: 'bl-combo is-zero' }, comboNum, h('div', { class: 'bl-combo-label' }, 'COMBO'), comboMult);
  el.append(combo);

  // ---------------------------------------------------------------- lanes + judgements
  const judgeLayer = h('div', { class: 'bl-judge-layer' });
  const topLane = h('div', { class: 'bl-lane bl-lane-top' });
  const lowLane = h('div', { class: 'bl-lane bl-lane-low' });
  el.append(judgeLayer, topLane, lowLane);

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
      if (old) retire(L, old);
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
        if (L.cur && L.cur.node) hideNode(L.cur);
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
  function retire(L, m) { if (L.cur === m) L.cur = null; if (m.node) hideNode(m); }
  function showNode(host, m) {
    if (!m.node) m.node = m.render();
    m.node.getAnimations().forEach((a) => a.cancel());
    host.append(m.node);
    m.node.animate(m.enter || [{ opacity: 0, transform: 'scale(1.4)' }, { opacity: 1, transform: 'none' }], { duration: m.enterMs || 240, easing: 'cubic-bezier(.2,1.3,.4,1)', fill: 'both' });
  }
  function hideNode(m) {
    const n = m.node;
    if (!n || !n.isConnected) return;
    n.getAnimations().forEach((a) => a.cancel());
    n.animate(m.exit || [{ opacity: 1 }, { opacity: 0, transform: 'scale(.92)' }], { duration: m.exitMs || 200, easing: 'ease-in', fill: 'both' }).onfinish = () => { if (!m.node || m.node === n) n.remove(); };
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
    return {
      key: `p:${label}:${move}:${wait}:${sub}`,
      render: () => h('div', { class: 'bl-prompt' + (wait ? ' is-wait' : '') + (o.tone ? ' t-' + o.tone : '') },
        move ? h('div', { class: 'bl-prompt-glyph', html: GLYPHS[move] }, wait ? h('i', { class: 'bl-prompt-ring' }) : null) : null,
        h('div', { class: 'bl-prompt-body' },
          o.kicker ? h('span', { class: 'bl-prompt-kicker' }, o.kicker) : null,
          h('b', { class: 'bl-prompt-text', 'data-text': label }, label),
          sub ? h('span', { class: 'bl-prompt-sub' }, sub) : null)),
      enter: [{ opacity: 0, transform: 'translateY(14px) scale(1.25)' }, { opacity: 1, transform: 'none' }],
      enterMs: wait ? 320 : 200,
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
      S.prompt = null; lanes.low.clear('prompt'); return;
    }
    if (key === S.promptKey && S.prompt) return;
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
      pipStats.textContent = frame ? `${pipS.fps} fps · ${Math.round(pipS.lat)} ms` : 'NO SIGNAL';
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
      const map = v && v.videoWidth ? (x, y) => [ox + x * vw * s, oy + y * vh * s] : (x, y) => [W * (0.2 + x * 0.6), y * H];
      drawSkeleton(pg, fr, kp, edges, map, { width: 2.6, glow: 12 });
    }
  }

  // ---------------------------------------------------------------- per frame
  let laneY = -1, laneX = -1;
  function placeLowLane(dt) {
    const H = innerHeight, W = innerWidth;
    const hb = heroBounds();
    // lower third, centred on the hero, at knee height (above the feet, below the hands)
    let ty = H * 0.74, tx = W * 0.5;
    if (hb) { ty = Math.min(H * 0.82, Math.max(H * 0.66, hb.b - (hb.b - hb.t) * 0.26)); tx = Math.min(W * 0.7, Math.max(W * 0.3, hb.cx)); }
    const k = laneY < 0 ? 1 : 1 - Math.exp(-dt * 8);
    laneY = laneY < 0 ? ty : laneY + (ty - laneY) * k; laneX = laneX < 0 ? tx : laneX + (tx - laneX) * k;
    lowLane.style.transform = `translate(${laneX.toFixed(1)}px, ${laneY.toFixed(1)}px)`;
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
    lanes.top.update(dt); lanes.low.update(dt);
    placeLowLane(dt);
    if (now - pipS.drawT > 33) { pipS.drawT = now; drawPip(now); }
  }

  return {
    el,
    show(on) {
      on = !!on;
      if (S.shown && !on) { lanes.top.clearAll(); lanes.low.clearAll(); S.prompt = null; S.promptKey = null; S.distanceShown = null; D.raw = null; }
      S.shown = on; el.classList.toggle('bl-hidden', !on);
      if (on && S.max < 0) setHealth(5, 5); if (on && S.flow < 0) setFlow(0, false);
      if (on) { const m = ctx.settings?.mode; modeTag.textContent = m === 'showcase' ? 'SHOWCASE · NO-FAIL' : m === 'challenge' ? 'CHALLENGE' : ''; modeTag.dataset.mode = m || ''; }
    },
    setScore(n) {
      n = Math.round(n);
      if (n > S.score + 50) scoreNum.animate([{ scale: '1.12' }, { scale: '1' }], { duration: 160 });
      S.score = n;
    },
    setCombo, setHealth, setFlow, banner, judgement, prompt, distance, message,
    placeJudgement, heroBounds,
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
      return { ...S, distanceRaw: D.raw, distanceHeld: +D.held.toFixed(2), lanes: { top: lanes.top.cur?.id ?? null, low: lanes.low.cur?.id ?? null }, queued: { top: [...lanes.top.msgs.keys()], low: [...lanes.low.msgs.keys()] } };
    },
  };
}
