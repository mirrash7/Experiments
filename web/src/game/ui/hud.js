// In-game HUD. Everything lives on the screen edges (the hero stands lower-middle in the gameplay camera):
//   top-left  hearts + Flow meter      top-right  score         left-middle  combo + multiplier
//   top-centre banners / prompts / distance warnings (transient)  bottom-right  webcam PiP with glowing skeleton
// Judgement pop-ups appear at a screen position (the strike point). Setters are cheap when nothing changes.
import { h, freshFrame, drawSkeleton, DISTANCE_TEXT } from './body.js';

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

export function createHUD(ctx, root) {
  const el = h('div', { class: 'bl-hud bl-hidden' });
  root.append(el);

  // ---------------------------------------------------------------- vitals (top-left)
  const hearts = h('div', { class: 'bl-hearts' });
  const flowFill = h('i', { class: 'bl-flow-fill' });
  const flowLabel = h('span', { class: 'bl-flow-label' }, 'FLOW');
  const flow = h('div', { class: 'bl-flow' }, h('div', { class: 'bl-flow-bar' }, flowFill, h('b', { class: 'bl-flow-ticks' })), flowLabel);
  el.append(h('div', { class: 'bl-vitals' }, hearts, flow));

  // ---------------------------------------------------------------- score (top-right)
  const scoreNum = h('div', { class: 'bl-score-num' }, '0');
  el.append(h('div', { class: 'bl-score' }, h('span', { class: 'bl-score-label' }, 'SCORE'), scoreNum));

  // ---------------------------------------------------------------- combo (left-middle)
  const comboNum = h('div', { class: 'bl-combo-num' }, '0');
  const comboMult = h('div', { class: 'bl-combo-mult' }, '×1');
  const combo = h('div', { class: 'bl-combo is-zero' }, comboNum, h('div', { class: 'bl-combo-label' }, 'COMBO'), comboMult);
  el.append(combo);

  // ---------------------------------------------------------------- centre-top transient layer
  const bannerHost = h('div', { class: 'bl-banner-host' });
  const promptEl = h('div', { class: 'bl-prompt' });
  const distEl = h('div', { class: 'bl-distance' });
  el.append(bannerHost, promptEl, distEl);
  const judgeLayer = h('div', { class: 'bl-judge-layer' });
  el.append(judgeLayer);

  // ---------------------------------------------------------------- PiP (bottom-right)
  const pipCanvas = h('canvas', { class: 'bl-pip-canvas', width: 384, height: 216 });
  const pipStats = h('span', { class: 'bl-pip-stats' }, '—');
  const pipSrc = h('span', { class: 'bl-pip-src' }, 'AI VISION');
  const pip = h('div', { class: 'bl-pip' }, pipCanvas, h('div', { class: 'bl-pip-bar' }, h('i', { class: 'bl-pip-rec' }), pipSrc, pipStats), h('div', { class: 'bl-pip-corners' }));
  el.append(pip);
  const pg = pipCanvas.getContext('2d');

  // ---------------------------------------------------------------- state
  const S = { shown: false, score: 0, scoreShown: 0, combo: 0, mult: 1, health: -1, max: -1, flow: -1, overdrive: null, prompt: null, distance: undefined };
  const pipS = { video: null, kp: null, edges: null, kpT: -1e9, drawT: 0, lastFrame: null, frames: 0, fps: 0, fpsT: performance.now(), lat: 0 };

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

  function banner(text, sub = '') {
    bannerHost.replaceChildren();
    const warn = /warning|boss|warden/i.test(text + ' ' + sub);
    const b = h('div', { class: 'bl-banner' + (warn ? ' is-warn' : '') },
      h('div', { class: 'bl-banner-stripe' }),
      h('div', { class: 'bl-banner-text', 'data-text': text }, text),
      sub ? h('div', { class: 'bl-banner-sub' }, sub) : null);
    bannerHost.append(b);
    const a = b.animate([
      { opacity: 0, transform: 'translateX(-30%) skewX(-12deg) scaleY(.2)' },
      { opacity: 1, transform: 'translateX(0) skewX(-12deg) scaleY(1)', offset: 0.12 },
      { opacity: 1, transform: 'translateX(2%) skewX(-12deg) scaleY(1)', offset: 0.82 },
      { opacity: 0, transform: 'translateX(30%) skewX(-12deg) scaleY(.6)' }], { duration: warn ? 3000 : 2400, easing: 'cubic-bezier(.2,.7,.2,1)' });
    a.onfinish = () => b.remove();
  }

  function judgement(pos, kind, extra = {}) {
    const J = JUDGE[kind] || { text: String(kind).toUpperCase(), cls: 'j-good' };
    let x = pos?.x ?? innerWidth / 2, y = pos?.y ?? innerHeight * 0.4;
    if (x <= 1.5 && y <= 1.5) { x *= innerWidth; y *= innerHeight; }
    x = Math.max(120, Math.min(innerWidth - 120, x)); y = Math.max(80, Math.min(innerHeight - 80, y));
    const ms = Number.isFinite(extra.errMs) ? h('small', {}, `${extra.errMs > 0 ? '+' : ''}${Math.round(extra.errMs)} ms`) : null;
    const j = h('div', { class: 'bl-judge ' + J.cls }, h('span', { 'data-text': J.text }, J.text), ms);
    j.style.left = x + 'px'; j.style.top = y + 'px';
    judgeLayer.append(j);
    while (judgeLayer.children.length > 8) judgeLayer.firstChild.remove();
    const big = kind === 'perfect';
    j.animate([
      { opacity: 0, transform: `translate(-50%,-50%) scale(${big ? 2.2 : 1.6}) rotate(-6deg)` },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(-6deg)', offset: 0.14 },
      { opacity: 1, transform: 'translate(-50%,-62%) scale(1) rotate(-6deg)', offset: 0.7 },
      { opacity: 0, transform: 'translate(-50%,-90%) scale(.9) rotate(-6deg)' }], { duration: kind === 'miss' ? 700 : 820, easing: 'cubic-bezier(.15,.9,.3,1)' }).onfinish = () => j.remove();
  }

  function prompt(text) {
    text = text || null;
    if (text === S.prompt) return;
    S.prompt = text;
    if (!text) { promptEl.classList.remove('is-on'); return; }
    promptEl.textContent = text; promptEl.dataset.text = text;
    promptEl.classList.add('is-on');
    promptEl.animate([{ scale: '1.6', opacity: 0 }, { scale: '1', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  function distance(state) {
    state = state || null;
    if (state === S.distance) return;
    S.distance = state;
    if (!state) { distEl.classList.remove('is-on'); return; }
    const D = DISTANCE_TEXT[state] || { title: state, sub: '', arrow: 'up' };
    distEl.innerHTML = `<i class="bl-dist-arrow a-${D.arrow}">${ARROWS[D.arrow]}</i><b>${D.title}</b><span>${D.sub}</span>`;
    distEl.classList.add('is-on');
  }

  // ---------------------------------------------------------------- PiP drawing (~30 Hz)
  function drawPip(now) {
    const W = pipCanvas.width, H = pipCanvas.height;
    const frame = freshFrame(ctx.motion, 800, now);
    // stats: tracker frame rate + capture→arrival latency
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
    // skeleton: explicit setSkeleton() data if recent, else the tracker's latest frame
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

  function update(dt) {
    if (!S.shown) return;
    if (S.scoreShown !== S.score) {
      const d = S.score - S.scoreShown;
      S.scoreShown = Math.abs(d) < 1 ? S.score : S.scoreShown + d * (1 - Math.exp(-dt * 14));
      scoreNum.textContent = Math.round(S.scoreShown).toLocaleString('en-US');
    }
    const now = performance.now();
    if (now - pipS.drawT > 33) { pipS.drawT = now; drawPip(now); }
  }

  return {
    el,
    show(on) { S.shown = !!on; el.classList.toggle('bl-hidden', !on); if (on && S.max < 0) setHealth(5, 5); if (on && S.flow < 0) setFlow(0, false); },
    setScore(n) {
      n = Math.round(n);
      if (n > S.score + 50) scoreNum.animate([{ scale: '1.12' }, { scale: '1' }], { duration: 160 });
      S.score = n;
    },
    setCombo, setHealth, setFlow, banner, judgement, prompt, distance,
    pip: {
      el: pip,
      setVideo(video) { pipS.video = video || null; pip.classList.toggle('has-video', !!video); },
      setSkeleton(kp2d, edges, { selfie } = {}) { pipS.kp = kp2d; pipS.edges = edges; pipS.kpT = performance.now(); pipS.selfie = selfie ?? false; },
    },
    update,
    get state() { return { ...S }; },
  };
}
