// Menu screens: boot, title, settings, pause, countdown, results (+ the screen host with enter/leave transitions).
// Calibration and the tutorial live in calibrate.js / tutorial.js. Every screen builder returns
// { node, update?(dt), dispose?(), ...handle } and the host keeps exactly one screen (countdown is an overlay).
import { h, uiButton, freshFrame, drawSkeleton, measureDistance, DISTANCE_TEXT, kpBounds } from './body.js';

const ICON = {
  hmr: '<svg viewBox="0 0 48 48"><circle cx="24" cy="9" r="5"/><path d="M24 15v15M24 30l-7 13M24 30l7 13M12 21l12 -2 12 2"/><path d="M4 4h8M4 4v8M44 4h-8M44 4v8M4 44h8M4 44v-8M44 44h-8M44 44v-8" class="i-acc"/></svg>',
  mediapipe: '<svg viewBox="0 0 48 48"><rect x="6" y="10" width="36" height="26" rx="4"/><circle cx="24" cy="23" r="7"/><circle cx="24" cy="23" r="2.5" class="i-acc-fill"/><path d="M18 42h12"/></svg>',
  demo: '<svg viewBox="0 0 48 48"><path d="M16 10v28l22-14z" class="i-acc-fill"/><path d="M6 6l36 36" class="i-strike"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  learn: '<svg viewBox="0 0 24 24"><path d="M12 3 1 9l11 6 9-4.9V17h2V9zM5 13.2v4L12 21l7-3.8v-4L12 17z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1L11 21h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
  replay: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
  again: '<svg viewBox="0 0 24 24"><path d="M17.6 6.4A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4z"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M12 3 2 12h3v8h5v-6h4v6h5v-8h3z"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9z"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M13 1.5a1.5 1.5 0 0 0-1.5 1.5v8h-1V4a1.5 1.5 0 0 0-3 0v10.3L5.4 12a1.6 1.6 0 0 0-2.3 2.2l4.6 5.6A6 6 0 0 0 12.4 22H14a6 6 0 0 0 6-6V7a1.5 1.5 0 0 0-3 0v4h-1V3a1.5 1.5 0 0 0-1.5-1.5c-.5 0-1 .3-1.5.6z"/></svg>',
};
export { ICON };

export const LOGO = (cls = '') => h('div', { class: 'bl-logo ' + cls },
  h('span', { class: 'bl-logo-word', 'data-text': 'BREAKLIGHT' }, 'BREAK', h('em', {}, 'LIGHT')),
  h('i', { class: 'bl-logo-flare' }));

// ======================================================================================= screen host
export function createScreenHost(root) {
  const host = h('div', { class: 'bl-screens' });
  const overlay = h('div', { class: 'bl-overlay-layer' });
  root.append(host, overlay);
  let cur = null, curName = null;
  return {
    host, overlay,
    get name() { return curName; },
    get current() { return cur; },
    show(name, scr) {
      if (cur) {
        const old = cur; old.dispose?.();
        old.node.classList.add('is-leaving');
        old.node.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(6px)', transform: 'scale(1.03)' }], { duration: 260, easing: 'ease-in' }).onfinish = () => old.node.remove();
      }
      cur = scr; curName = name;
      if (scr) {
        scr.inner = scr.node;
        scr.node = h('div', { class: 'bl-screen scr-' + name }, scr.inner);
        host.append(scr.node);
        scr.node.animate([{ opacity: 0, transform: 'scale(.97)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      return scr;
    },
    update(dt) { cur?.update?.(dt); },
  };
}

// ======================================================================================= boot
export function bootScreen(ctx, { onTracker, current = null, available = {}, status = '' } = {}) {
  const statusEl = h('div', { class: 'bl-boot-status' }, status);
  const cards = [
    ['hmr', 'INSTANT HMR', '3D body mesh · local AI server', 'Most accurate · full 3D'],
    ['mediapipe', 'MEDIAPIPE', 'Runs in your browser', 'No install · fast start'],
    ['demo', 'DEMO PLAYER', 'No camera? Play the demo', 'An AI player moves for you'],
  ].map(([id, title, sub, tag]) => {
    const b = uiButton(title, () => { node.querySelectorAll('.bl-tracker').forEach((x) => x.classList.toggle('is-picked', x === b)); onTracker?.(id); },
      { cls: 'bl-tracker t-' + id + (current === id ? ' is-picked' : ''), icon: ICON[id], sub, id: 'tracker-' + id });
    b.append(h('span', { class: 'bl-tracker-tag' }, tag));
    if (available[id] === false) { b.disabled = true; b.classList.add('is-unavailable'); b.append(h('span', { class: 'bl-tracker-na' }, 'unavailable')); }
    return b;
  });
  const node = h('div', { class: 'bl-boot' },
    h('div', { class: 'bl-boot-head' }, LOGO('is-small'), h('p', { class: 'bl-tagline' }, 'Your body is the controller')),
    h('h2', { class: 'bl-h2' }, 'Choose your tracker'),
    h('div', { class: 'bl-trackers' }, cards),
    h('div', { class: 'bl-privacy' },
      h('i', { html: ICON.cam }),
      h('div', {},
        h('b', {}, 'Camera access'),
        h('p', {}, 'BREAKLIGHT watches your whole body through your webcam. Your browser will ask for permission next. Frames are processed on this computer (or your own local InstantHMR server) and never uploaded.')),
      h('i', { class: 'bl-privacy-lock', html: ICON.lock })),
    statusEl);
  return {
    node,
    setStatus(text, kind = '') { statusEl.textContent = text || ''; statusEl.dataset.kind = kind; },
    setAvailable(map) { for (const b of cards) { const id = b.getAttribute('data-ui-button').replace('tracker-', ''); if (id in map) { b.disabled = map[id] === false; b.classList.toggle('is-unavailable', map[id] === false); } } },
  };
}

// ======================================================================================= title
export function titleScreen(ctx, { onPlay, onTutorial, onSettings } = {}) {
  const node = h('div', { class: 'bl-title' },
    h('div', { class: 'bl-title-top' }, LOGO(), h('p', { class: 'bl-tagline' }, 'Strike to the beat · Shatter the glitch')),
    h('nav', { class: 'bl-menu' },
      uiButton('PLAY', onPlay, { cls: 'is-primary', icon: ICON.play, id: 'play' }),
      uiButton('TUTORIAL', onTutorial, { icon: ICON.learn, id: 'tutorial' }),
      uiButton('SETTINGS', onSettings, { icon: ICON.gear, id: 'settings' })),
    h('div', { class: 'bl-hint-card' }, h('i', { html: ICON.hand }),
      h('div', {}, h('b', {}, 'Raise a hand to aim'), h('span', {}, 'Hold still 0.8 s or punch to select · mouse & keys work too'))));
  return { node };
}

// ======================================================================================= settings
const SETTING_ROWS = [
  { key: 'tracker', label: 'Tracker', options: [['hmr', 'InstantHMR'], ['mediapipe', 'MediaPipe'], ['demo', 'Demo']] },
  { key: 'upperBodyOnly', label: 'Upper body only', sub: 'No kicks or jumps (small rooms)', options: [[false, 'Off'], [true, 'On']] },
  { key: 'difficulty', label: 'Difficulty', options: [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']] },
  { key: 'volume', label: 'Volume', step: 0.1, min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'judgeOffsetMs', label: 'Judge offset', sub: 'Shift timing if hits feel late / early', step: 10, min: -150, max: 150, fmt: (v) => `${v > 0 ? '+' : ''}${v} ms` },
  { key: 'quality', label: 'Graphics', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
];

export function settingsScreen(ctx, { settings = {}, onClose, onChange } = {}) {
  const defaults = { tracker: 'hmr', upperBodyOnly: false, difficulty: 'normal', volume: 0.8, judgeOffsetMs: 0, quality: 'high' };
  for (const [k, v] of Object.entries(defaults)) if (settings[k] === undefined) settings[k] = v;
  const change = (key, value) => {
    settings[key] = value;
    try { onChange?.(key, value, settings); } catch (e) { console.error(e); }
    ctx.bus?.emit?.('settings:change', { key, value, settings });
    if (key === 'volume') { try { ctx.audio?.setVolume?.({ master: value }); } catch { /* optional */ } }
  };
  const rows = SETTING_ROWS.map((R) => {
    const ctl = h('div', { class: 'bl-set-ctl' });
    if (R.options) {
      const seg = h('div', { class: 'bl-seg' });
      const btns = R.options.map(([val, lab]) => {
        const b = uiButton(lab, () => { change(R.key, val); btns.forEach((x) => x.classList.toggle('is-on', x === b)); }, { cls: 'bl-seg-btn' + (settings[R.key] === val ? ' is-on' : ''), id: `set-${R.key}-${val}` });
        return b;
      });
      seg.append(...btns); ctl.append(seg);
    } else {
      const val = h('output', { class: 'bl-step-val' }, R.fmt(settings[R.key]));
      const bar = h('i', { class: 'bl-step-bar' });
      const upd = () => { val.textContent = R.fmt(settings[R.key]); bar.style.transform = `scaleX(${(settings[R.key] - R.min) / (R.max - R.min)})`; };
      const step = (d) => { const v = Math.round((settings[R.key] + d * R.step) / R.step) * R.step; change(R.key, +Math.max(R.min, Math.min(R.max, v)).toFixed(3)); upd(); };
      const minus = uiButton('−', () => step(-1), { cls: 'bl-step-btn', id: `set-${R.key}-minus` });
      const plus = uiButton('+', () => step(1), { cls: 'bl-step-btn', id: `set-${R.key}-plus` });
      minus.setAttribute('data-ui-repeat', ''); plus.setAttribute('data-ui-repeat', '');
      ctl.append(h('div', { class: 'bl-stepper' }, minus, h('div', { class: 'bl-step-mid' }, val, h('span', { class: 'bl-step-track' }, bar)), plus));
      upd();
    }
    return h('div', { class: 'bl-set-row' }, h('div', { class: 'bl-set-label' }, R.label, R.sub ? h('small', {}, R.sub) : null), ctl);
  });
  const node = h('div', { class: 'bl-settings' },
    h('div', { class: 'bl-panel bl-settings-panel' },
      h('h2', { class: 'bl-h2' }, 'Settings'),
      h('div', { class: 'bl-set-rows' }, rows),
      h('div', { class: 'bl-panel-foot' }, uiButton('DONE', () => onClose?.(settings), { cls: 'is-primary', id: 'settings-done' }))));
  return { node, settings };
}

// ======================================================================================= pause
export function pauseScreen(ctx, { reason = 'player-lost', onResume, onQuit } = {}) {
  const TXT = {
    'player-lost': ['STEP BACK INTO VIEW', 'We lost sight of you. Stand where your whole body fits in the camera.'],
    'tracking-lost': ['TRACKING LOST', 'The tracker stopped sending poses. Hold on, or check the camera / server.'],
    user: ['PAUSED', 'Take a breath.'],
  };
  const [title, sub] = TXT[reason] || [String(reason).toUpperCase(), ''];
  const cv = h('canvas', { class: 'bl-pause-cv', width: 360, height: 400 });
  const live = h('div', { class: 'bl-pause-live' }, '');
  const g = cv.getContext('2d');
  const btns = [];
  if (onResume) btns.push(uiButton('RESUME', onResume, { cls: 'is-primary', icon: ICON.play, id: 'pause-resume' }));
  if (onQuit) btns.push(uiButton('QUIT', onQuit, { icon: ICON.home, id: 'pause-quit' }));
  const node = h('div', { class: 'bl-pause' + (reason === 'user' ? ' is-user' : '') },
    h('div', { class: 'bl-panel bl-pause-panel' },
      h('div', { class: 'bl-pause-kicker' }, 'PAUSED'),
      h('h2', { class: 'bl-pause-title' }, title),
      h('p', { class: 'bl-pause-sub' }, sub),
      h('div', { class: 'bl-pause-frame' }, cv, h('i', { class: 'bl-pause-box' }), live),
      h('p', { class: 'bl-pause-auto' }, 'The game resumes with a 3-2-1 countdown when you are back.'),
      btns.length ? h('div', { class: 'bl-panel-foot' }, btns) : null));
  let t = 0;
  return {
    node,
    update(dt) {
      t += dt;
      const W = cv.width, H = cv.height;
      g.clearRect(0, 0, W, H);
      const f = freshFrame(ctx.motion, 700);
      const map = (x, y) => [W * (0.5 + (x - 0.5) * 1.15), H * (0.04 + y * 0.92)];
      // target zone
      g.strokeStyle = 'rgba(160,140,255,.25)'; g.setLineDash([6, 8]); g.lineWidth = 2;
      g.strokeRect(W * 0.2, H * 0.05, W * 0.6, H * 0.9); g.setLineDash([]);
      if (f) {
        drawSkeleton(g, f, f.kp2d, f.edges, map, { width: 4, glow: 18, color: '#ff7ad9' });
        const d = measureDistance(f, { upperBodyOnly: !!ctx.settings?.upperBodyOnly });
        const txt = d ? DISTANCE_TEXT[d].title : 'LOOKING GOOD';
        if (live.textContent !== txt) { live.textContent = txt; live.classList.toggle('is-ok', !d); }
      } else {
        g.fillStyle = `rgba(255,122,217,${0.25 + 0.2 * Math.sin(t * 4)})`;
        g.font = '600 18px "Chakra Petch", sans-serif'; g.textAlign = 'center';
        g.fillText('NO BODY DETECTED', W / 2, H / 2);
        if (live.textContent !== 'SEARCHING…') { live.textContent = 'SEARCHING…'; live.classList.remove('is-ok'); }
      }
    },
  };
}

// ======================================================================================= countdown (overlay)
export function countdownOverlay(layer, n) {
  layer.querySelectorAll('.bl-count').forEach((x) => x.remove());
  const go = !(n > 0);
  const el = h('div', { class: 'bl-count' + (go ? ' is-go' : '') }, h('span', { 'data-text': go ? 'GO!' : String(n) }, go ? 'GO!' : String(n)), h('i', { class: 'bl-count-ring' }));
  layer.append(el);
  el.querySelector('span').animate([
    { transform: 'scale(2.6)', opacity: 0, filter: 'blur(10px)' },
    { transform: 'scale(1)', opacity: 1, filter: 'blur(0)', offset: 0.25 },
    { transform: 'scale(.92)', opacity: 1, offset: 0.75 },
    { transform: 'scale(.6)', opacity: 0 }], { duration: go ? 900 : 950, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'forwards' });
  el.querySelector('i').animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(2.4)', opacity: 0 }], { duration: 700, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => el.remove(), 1000);
  return el;
}

// ======================================================================================= results
export function computeRank(stats) {
  if (stats.rank) return stats.rank;
  const j = stats.judgements || {};
  const total = (j.perfect || 0) + (j.great || 0) + (j.good || 0) + (j.miss || 0);
  const acc = stats.accuracy ?? (total ? ((j.perfect || 0) * 300 + (j.great || 0) * 200 + (j.good || 0) * 100) / (total * 300) : 0);
  return acc >= 0.9 ? 'S' : acc >= 0.78 ? 'A' : acc >= 0.62 ? 'B' : 'C';
}

const BODY = [
  { key: 'punchSpeed', alias: ['fastestPunch', 'punchSpeedMs'], label: 'Fastest punch', unit: 'm/s', dec: 1, ref: 10,
    icon: '<svg viewBox="0 0 24 24"><path d="M4 9h3l2-3h6a3 3 0 0 1 3 3v1h1a2 2 0 0 1 0 4h-1v1a4 4 0 0 1-4 4H9a5 5 0 0 1-5-5z"/><path d="M1 8h2M1 12h2M1 16h2" class="i-acc"/></svg>',
    tier: (v) => (v >= 8 ? 'Pro boxer speed' : v >= 6 ? 'Fighter class' : v >= 4 ? 'Sharp' : 'Warming up') },
  { key: 'jumpHeight', alias: ['highestJump', 'jumpCm'], label: 'Highest jump', unit: 'cm', dec: 0, ref: 60,
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="4" r="2.2"/><path d="M12 7v7M12 9l-5-3M12 9l5-3M12 14l-4 4M12 14l4 4"/><path d="M4 22h16" class="i-acc"/></svg>',
    tier: (v) => (v >= 45 ? 'Sky walker' : v >= 30 ? 'Spring-loaded' : v >= 15 ? 'Light feet' : 'Grounded') },
  { key: 'reactionMs', alias: ['bestReaction', 'reaction'], label: 'Best reaction', unit: 'ms', dec: 0, ref: 600, invert: true,
    icon: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    tier: (v) => (v <= 180 ? 'Lightning reflexes' : v <= 250 ? 'Quick draw' : v <= 350 ? 'Alert' : 'Steady') },
  { key: 'moves', alias: ['movesCount', 'moveCount'], label: 'Moves performed', unit: '', dec: 0, ref: 300,
    icon: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>', tier: (v) => (v >= 200 ? 'Relentless' : v >= 100 ? 'Busy body' : 'Getting going') },
  { key: 'kcal', alias: ['calories'], label: 'Energy burned', unit: 'kcal', dec: 0, ref: 80, approx: true,
    icon: '<svg viewBox="0 0 24 24"><path d="M12 2s6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 2-5s0 3 2 4c0-5 2-11 2-11z"/></svg>', tier: () => 'approx.' },
];
const pick = (o, k, aliases) => { if (!o) return undefined; if (o[k] !== undefined) return o[k]; for (const a of aliases) if (o[a] !== undefined) return o[a]; return undefined; };

export function resultsScreen(ctx, { stats = {}, onReplay, onAgain, onTitle } = {}) {
  const rank = computeRank(stats);
  const j = stats.judgements || {};
  const total = Math.max(1, (j.perfect || 0) + (j.great || 0) + (j.good || 0) + (j.miss || 0));
  const counters = [];
  const counter = (to, dec = 0, delay = 0, fmt = null) => {
    const el = h('span', { class: 'bl-count-num' }, '0');
    counters.push({ el, to: +to || 0, dec, delay, fmt, t: 0 });
    return el;
  };
  const judgeRows = [['perfect', 'PERFECT'], ['great', 'GREAT'], ['good', 'GOOD'], ['miss', 'MISS']].map(([k, lab], i) =>
    h('div', { class: 'bl-res-jrow j-' + k },
      h('span', { class: 'bl-res-jlab' }, lab),
      h('span', { class: 'bl-res-jbar' }, h('i', { style: { '--w': ((j[k] || 0) / total).toFixed(3), '--d': `${0.9 + i * 0.12}s` } })),
      counter(j[k] || 0, 0, 0.9 + i * 0.12)));
  const body = stats.body || stats;
  const cards = BODY.map((B, i) => {
    const v = pick(body, B.key, B.alias);
    const has = Number.isFinite(+v) && v !== null;
    const frac = has ? Math.max(0.04, Math.min(1, B.invert ? 1 - (+v - 120) / (B.ref - 120) : +v / B.ref)) : 0;
    return h('div', { class: 'bl-bodycard' + (has ? '' : ' is-na'), style: { '--d': `${1.6 + i * 0.16}s`, '--f': frac.toFixed(3) } },
      h('i', { class: 'bl-bodycard-icon', html: B.icon }),
      h('div', { class: 'bl-bodycard-main' },
        h('span', { class: 'bl-bodycard-label' }, B.label),
        h('span', { class: 'bl-bodycard-val' }, B.approx && has ? '≈' : '', has ? counter(+v, B.dec, 1.6 + i * 0.16) : '—', h('small', {}, B.unit)),
        h('span', { class: 'bl-bodycard-meter' }, h('i')),
        h('span', { class: 'bl-bodycard-tier' }, has ? B.tier(+v) : 'not measured')));
  });
  const stamp = h('div', { class: 'bl-stamp r-' + rank }, h('span', {}, rank), h('i', { class: 'bl-stamp-ring' }));
  const node = h('div', { class: 'bl-results' },
    h('section', { class: 'bl-panel bl-res-left' },
      h('div', { class: 'bl-res-kicker' }, stats.cleared === false ? 'DEFEATED' : 'STAGE CLEAR'),
      h('div', { class: 'bl-res-scorebox' },
        h('div', {}, h('span', { class: 'bl-res-label' }, 'SCORE'), h('div', { class: 'bl-res-score' }, counter(stats.score || 0, 0, 0.2)),
          stats.newBest ? h('span', { class: 'bl-res-best' }, 'NEW BEST!') : null),
        stamp),
      h('div', { class: 'bl-res-mini' },
        h('div', {}, h('span', {}, 'MAX COMBO'), h('b', {}, counter(stats.maxCombo || 0, 0, 0.6))),
        h('div', {}, h('span', {}, 'ACCURACY'), h('b', {}, counter(((stats.accuracy ?? (((j.perfect || 0) * 3 + (j.great || 0) * 2 + (j.good || 0)) / (total * 3))) * 100), 1, 0.6), '%'))),
      h('div', { class: 'bl-res-judges' }, judgeRows)),
    h('section', { class: 'bl-panel bl-res-right' },
      h('div', { class: 'bl-res-ai' }, h('i', { class: 'bl-res-ai-dot' }), 'YOUR BODY, MEASURED BY AI'),
      h('p', { class: 'bl-res-ai-sub' }, 'Computed live from your tracked skeleton: wrist speed, hip rise and the gap between each cue and your first movement.'),
      h('div', { class: 'bl-bodycards' }, cards)),
    h('nav', { class: 'bl-res-nav' },
      onReplay ? uiButton('REPLAY', onReplay, { icon: ICON.replay, id: 'res-replay' }) : null,
      uiButton('PLAY AGAIN', onAgain, { cls: 'is-primary', icon: ICON.again, id: 'res-again' }),
      uiButton('TITLE', onTitle, { icon: ICON.home, id: 'res-title' })));
  // rank stamp: slams in after the score has counted up
  setTimeout(() => {
    if (!node.isConnected) return;
    stamp.classList.add('is-in');
    stamp.animate([
      { opacity: 0, transform: 'scale(4) rotate(-40deg)' },
      { opacity: 1, transform: 'scale(.86) rotate(-14deg)', offset: 0.55 },
      { opacity: 1, transform: 'scale(1.06) rotate(-12deg)', offset: 0.78 },
      { opacity: 1, transform: 'scale(1) rotate(-12deg)' }], { duration: 520, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' });
    stamp.querySelector('.bl-stamp-ring').animate([{ transform: 'scale(.6)', opacity: 0.9 }, { transform: 'scale(2.2)', opacity: 0 }], { duration: 700, delay: 280, easing: 'ease-out', fill: 'forwards' });
    node.querySelector('.bl-res-left').animate([{ translate: '0 0' }, { translate: '-7px 5px' }, { translate: '6px -4px' }, { translate: '0 0' }], { duration: 240, delay: 290 });
    try { ctx.audio?.sfx?.(rank === 'S' || rank === 'A' ? 'perfect' : 'great'); } catch { /* optional */ }
  }, 1500);
  let t = 0;
  return {
    node, rank,
    update(dt) {
      t += dt;
      for (const c of counters) {
        if (c.done) continue;
        const k = Math.max(0, Math.min(1, (t - c.delay) / 1.0));
        const e = 1 - (1 - k) ** 3;
        const v = c.to * e;
        c.el.textContent = c.dec ? v.toFixed(c.dec) : Math.round(v).toLocaleString('en-US');
        if (k >= 1) c.done = true;
      }
    },
  };
}

export { kpBounds };
