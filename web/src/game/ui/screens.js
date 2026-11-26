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
  user: '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M1 21v-1a7 7 0 0 1 14 0v1z"/><path d="M19 7v6M16 10h6"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M12 5C6.5 5 2.4 8.6 1 12c1.4 3.4 5.5 7 11 7s9.6-3.6 11-7c-1.4-3.4-5.5-7-11-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/><circle cx="12" cy="12" r="2"/></svg>',
  warn: '<svg viewBox="0 0 48 48"><path d="M24 4 2 44h44z" class="w-tri"/><path d="M24 17v13M24 35v3" class="w-mark"/><path d="M33 9l3-5M38 14l5-2M15 9l-3-5M10 14l-5-2" class="w-ray"/></svg>',
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
        // hide() (into gameplay / a replay): a quick 140 ms fade, so the HUD (which waits 170 ms) never overlaps it
        old.node.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(6px)', transform: 'scale(1.03)' }], { duration: scr ? 260 : 140, easing: 'ease-in', fill: 'forwards' }).onfinish = () => old.node.remove();
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
const MODES = [['showcase', 'SHOWCASE', 'No-fail · see it all'], ['challenge', 'CHALLENGE', 'Hard · lose hearts = game over']];
/** Showcase / Challenge segmented toggle. Writes settings.mode, emits 'settings:change', calls onMode(mode). */
function modeToggle(ctx, { mode, onMode, idPrefix = 'mode' }) {
  const settings = ctx.settings || {};
  let cur = mode ?? settings.mode ?? 'showcase';
  const btns = MODES.map(([id, label, sub]) => uiButton(label, () => {
    cur = id; settings.mode = id;
    btns.forEach((b) => b.classList.toggle('is-on', b.dataset.mode === id));
    try { onMode?.(id); } catch (e) { console.error(e); }
    ctx.bus?.emit?.('settings:change', { key: 'mode', value: id, settings });
  }, { cls: 'bl-seg-btn bl-mode-btn' + (cur === id ? ' is-on' : ''), sub, id: `${idPrefix}-${id}` }));
  btns.forEach((b, i) => { b.dataset.mode = MODES[i][0]; });
  return h('div', { class: 'bl-mode' }, h('span', { class: 'bl-mode-lab' }, 'MODE'), h('div', { class: 'bl-seg' }, btns));
}

/**
 * title({ onPlay, onTutorial, onSettings, mode?, onMode?(mode), best?, tutorialLabel?, onNewPlayer?, kiosk? })
 * NEW PLAYER (hand dwell 1.2 s, never punch-selected): onNewPlayer, else ctx.game.newPlayer() (CORE resets the per-player
 * flags / mode / seated and recalibrates). kiosk: shows the KIOSK badge (default: settings.dev.kiosk, ctx.game.kiosk, ?kiosk=1).
 */
export function titleScreen(ctx, { onPlay, onTutorial, onSettings, mode, onMode, best, todayBest, tutorialLabel = 'TUTORIAL', onNewPlayer, kiosk } = {}) {
  const isKiosk = !!(kiosk ?? (ctx.settings?.dev?.kiosk || ctx.game?.kiosk || /[?&]kiosk=1\b/.test(location.search)));
  const newPlayer = () => {
    try { if (onNewPlayer) onNewPlayer(); else ctx.game?.newPlayer?.(); } catch (e) { console.error(e); }
    ctx.bus?.emit?.('ui:newPlayer', {});
  };
  const np = uiButton('NEW PLAYER', newPlayer, { cls: 'is-small bl-title-newplayer', icon: ICON.user, id: 'new-player', sub: 'fresh start: intro + safety check' });
  np.setAttribute('data-ui-dwell', '1.2'); np.setAttribute('data-ui-nopunch', '');
  const node = h('div', { class: 'bl-title' },
    h('div', { class: 'bl-title-top' }, LOGO(),
      h('p', { class: 'bl-title-tagline' }, h('b', {}, 'Your body is the controller'), h('span', {}, 'Punch · kick · dodge to the beat · shatter the glitch'))),
    isKiosk ? h('div', { class: 'bl-kiosk-tag' }, h('i'), h('b', {}, 'KIOSK MODE'), h('span', {}, 'resets for every new player')) : null,
    h('nav', { class: 'bl-menu' },
      uiButton('PLAY', onPlay, { cls: 'is-primary', icon: ICON.play, id: 'play' }),
      uiButton(tutorialLabel, onTutorial, { icon: ICON.learn, id: 'tutorial' }),
      uiButton('SETTINGS', onSettings, { icon: ICON.gear, id: 'settings' }),
      modeToggle(ctx, { mode, onMode }),
      Number.isFinite(+best) && +best > 0 ? h('div', { class: 'bl-title-best' }, h('span', {}, isKiosk ? 'YOUR BEST' : 'BEST'), h('b', {}, Math.round(+best).toLocaleString('en-US'))) : null,
      Number.isFinite(+todayBest) && +todayBest > 0 && +todayBest !== +best ? h('div', { class: 'bl-title-best is-today' }, h('span', {}, "TODAY'S BEST"), h('b', {}, Math.round(+todayBest).toLocaleString('en-US'))) : null,
      np),
    h('div', { class: 'bl-hint-card' }, h('i', { html: ICON.hand }),
      h('div', {}, h('b', {}, 'Raise a hand to aim'), h('span', {}, 'Hold still 0.8 s or punch to select · mouse & keys work too'))));
  return { node, kiosk: isKiosk };
}

// ======================================================================================= photosensitivity notice
/**
 * flashNotice({ onDone({ reduceFlashes }), onReduce?(on) | onToggle?(on), reduce? | reduceFlashes?, autoContinueS? }):
 * first-boot photosensitivity notice (autoContinueS > 0: continues by itself, progress bar on OK).
 * OK (hand dwell 1.2 s, click, Enter / Space) continues; "REDUCE FLASHES" toggles settings.reduceFlashes and emits
 * bus 'settings:change' { key: 'reduceFlashes', value }. Handle: { node, get reduce, finish() }.
 */
export function flashNoticeScreen(ctx, { onDone, onReduce, onToggle, reduce, reduceFlashes, autoContinueS = 0 } = {}) {
  const settings = ctx.settings || {};
  let on = !!(reduce ?? reduceFlashes ?? settings.reduceFlashes);
  onReduce ??= onToggle;
  const state = h('b', { class: 'bl-fn-state' });
  const toggle = uiButton('REDUCE FLASHES', () => {
    on = !on; settings.reduceFlashes = on; paint();
    try { onReduce?.(on); } catch (e) { console.error(e); }
    ctx.bus?.emit?.('settings:change', { key: 'reduceFlashes', value: on, settings });
  }, { cls: 'bl-fn-toggle', icon: ICON.eye, id: 'flash-reduce' });
  toggle.querySelector('.bl-btn-label').append(state);
  toggle.setAttribute('data-ui-dwell', '1.2'); toggle.setAttribute('data-ui-nopunch', '');
  const ok = uiButton("OK, LET'S GO", () => finish(), { cls: 'is-primary', icon: ICON.play, id: 'flash-ok' });
  ok.setAttribute('data-ui-dwell', '1.2');
  function paint() {
    state.textContent = on ? 'ON' : 'OFF';
    toggle.classList.toggle('is-on', on);
    node.classList.toggle('is-reduced', on);
  }
  const node = h('div', { class: 'bl-fn' },
    h('div', { class: 'bl-panel bl-fn-panel' },
      h('div', { class: 'bl-fn-icon', html: ICON.warn }),
      h('div', { class: 'bl-kicker bl-fn-kicker' }, 'PHOTOSENSITIVITY WARNING'),
      h('h1', { class: 'bl-fn-title' }, 'Bright flashes ahead'),
      h('p', { class: 'bl-fn-text' }, 'This game uses flashing lights and fast-moving patterns. If you or anyone watching has epilepsy or has had a seizure, check with a doctor before playing.'),
      h('p', { class: 'bl-fn-stop' }, 'Stop at once if you feel dizzy, sick or your vision changes.'),
      h('div', { class: 'bl-fn-actions' }, toggle, ok),
      h('p', { class: 'bl-fn-hint' }, 'Reduce flashes softens blasts, hits and the photo flash. You can change it later in Settings.')));
  paint();
  // optional auto-continue (kiosk: nobody at the keyboard); a ring on the OK button shows it
  const autoBar = h('i', { class: 'bl-fn-auto' });
  if (autoContinueS > 0) ok.append(autoBar);
  let done = false, t = 0;
  function finish() {
    if (done) return;
    done = true;
    removeEventListener('keydown', onKey);
    try { ctx.audio?.sfx?.('uiSelect'); } catch { /* */ }
    onDone?.({ reduceFlashes: on });
  }
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); } };
  addEventListener('keydown', onKey);
  return {
    node, get reduce() { return on; }, finish,
    update(dt) {
      if (done || !(autoContinueS > 0)) return;
      t += dt;
      autoBar.style.transform = `scaleX(${Math.min(1, t / autoContinueS).toFixed(3)})`;
      if (t >= autoContinueS) finish();
    },
    dispose() { removeEventListener('keydown', onKey); },
  };
}

// ======================================================================================= settings
const SETTING_ROWS = [
  { key: 'mode', label: 'Mode', sub: 'Showcase never ends the run', options: [['showcase', 'Showcase'], ['challenge', 'Challenge']] },
  { key: 'tracker', label: 'Tracker', options: [['hmr', 'InstantHMR'], ['mediapipe', 'MediaPipe'], ['demo', 'Demo']] },
  { key: 'seated', label: 'Seated mode', sub: 'Play from a chair: no legs, no jumps', options: [[false, 'Off'], [true, 'On']] },
  { key: 'upperBodyOnly', label: 'Upper body only', sub: 'No kicks or jumps (small rooms)', options: [[false, 'Off'], [true, 'On']] },
  { key: 'difficulty', label: 'Difficulty', options: [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']] },
  { key: 'volume', label: 'Volume', step: 0.1, min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'judgeOffsetMs', label: 'Judge offset', sub: 'Shift timing if hits feel late / early', step: 10, min: -150, max: 150, fmt: (v) => `${v > 0 ? '+' : ''}${v} ms` },
  { key: 'quality', label: 'Graphics', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'reduceFlashes', label: 'Reduce flashes', sub: 'Softer blasts, hits and photo flash', options: [[false, 'Off'], [true, 'On']] },
];
const VOLUME_PARTS = [['master', 'Master volume'], ['music', 'Music'], ['sfx', 'Effects']];

/**
 * settings({ settings, onClose, onChange(key, value, settings) }). settings.volume may be a number (legacy) or
 * CORE's { master, music, sfx } object: the object gets one stepper per channel and audio.setVolume({ ...volume }).
 */
export function settingsScreen(ctx, { settings = {}, onClose, onChange } = {}) {
  const defaults = { mode: 'showcase', tracker: 'hmr', seated: false, upperBodyOnly: false, difficulty: 'normal', volume: { master: 0.9, music: 0.8, sfx: 0.9 }, judgeOffsetMs: 0, quality: 'high', reduceFlashes: false };
  for (const [k, v] of Object.entries(defaults)) if (settings[k] === undefined) settings[k] = typeof v === 'object' ? { ...v } : v;
  const emit = (key, value) => {
    try { onChange?.(key, value, settings); } catch (e) { console.error(e); }
    ctx.bus?.emit?.('settings:change', { key, value, settings });
  };
  const applyVolume = () => {
    const v = settings.volume;
    try { ctx.audio?.setVolume?.(typeof v === 'object' ? { ...v } : { master: v }); } catch { /* optional */ }
  };
  const change = (key, value) => { settings[key] = value; emit(key, value); if (key === 'volume') applyVolume(); };
  const stepper = (id, get, set, R) => {
    const val = h('output', { class: 'bl-step-val' }, R.fmt(get()));
    const bar = h('i', { class: 'bl-step-bar' });
    const upd = () => { val.textContent = R.fmt(get()); bar.style.transform = `scaleX(${(get() - R.min) / (R.max - R.min)})`; };
    const step = (d) => { const v = Math.round((get() + d * R.step) / R.step) * R.step; set(+Math.max(R.min, Math.min(R.max, v)).toFixed(3)); upd(); };
    const minus = uiButton('−', () => step(-1), { cls: 'bl-step-btn', id: `set-${id}-minus` });
    const plus = uiButton('+', () => step(1), { cls: 'bl-step-btn', id: `set-${id}-plus` });
    minus.setAttribute('data-ui-repeat', ''); plus.setAttribute('data-ui-repeat', '');
    upd();
    return h('div', { class: 'bl-stepper' }, minus, h('div', { class: 'bl-step-mid' }, val, h('span', { class: 'bl-step-track' }, bar)), plus);
  };
  const row = (label, sub, ctl, cls = '') => h('div', { class: 'bl-set-row ' + cls }, h('div', { class: 'bl-set-label' }, label, sub ? h('small', {}, sub) : null), h('div', { class: 'bl-set-ctl' }, ctl));
  const rows = [];
  for (const R of SETTING_ROWS) {
    if (R.options) {
      const seg = h('div', { class: 'bl-seg' });
      const btns = R.options.map(([val, lab]) => uiButton(lab, () => { change(R.key, val); btns.forEach((x, i) => x.classList.toggle('is-on', R.options[i][0] === val)); }, { cls: 'bl-seg-btn' + (settings[R.key] === val ? ' is-on' : ''), id: `set-${R.key}-${val}` }));
      seg.append(...btns);
      rows.push(row(R.label, R.sub, seg));
    } else if (R.key === 'volume' && settings.volume && typeof settings.volume === 'object') {
      for (const [ch, lab] of VOLUME_PARTS) {
        const get = () => +(settings.volume[ch] ?? 1);
        const set = (v) => { settings.volume = { ...settings.volume, [ch]: v }; emit('volume', settings.volume); applyVolume(); };
        rows.push(row(lab, null, stepper(`volume-${ch}`, get, set, R), 'is-sub'));
      }
    } else {
      rows.push(row(R.label, R.sub, stepper(R.key, () => +settings[R.key] || 0, (v) => change(R.key, v), R)));
    }
  }
  const node = h('div', { class: 'bl-settings' },
    h('div', { class: 'bl-panel bl-settings-panel' },
      h('h2', { class: 'bl-h2' }, 'Settings'),
      h('div', { class: 'bl-set-rows' }, rows),
      h('div', { class: 'bl-panel-foot' }, uiButton('DONE', () => onClose?.(settings), { cls: 'is-primary', id: 'settings-done' }))));
  return { node, settings };
}

// ======================================================================================= clear-space check
/**
 * clearSpace({ onDone({ skipped, auto, seated, how }), seated?, holdS = 3, timeoutS = 0, kiosk? }): a safety check before
 * the T-pose / first run, readable at a glance: a big top-down 2 m x 2 m diagram (or the seated "arm's reach" variant),
 * three short bullets with pictograms and a live framing check. It needs an explicit confirmation (QA r3 design P2-3):
 * "I'M CLEAR" (hand dwell / click / Enter) or holding still, whole body in frame, for holdS seconds (countdown ring).
 * timeoutS > 0 (kiosk only, default 30 s there) is a last-resort fallback so an unattended stand never sticks.
 * "PLAY SEATED / STANDING INSTEAD" switches the variant; onDone reports it.
 */
const CS_DIAGRAM = {
  seated: `<svg viewBox="0 0 240 260" class="bl-cs-svg"><rect x="70" y="14" width="100" height="12" rx="3" class="cs-screen"/><circle cx="120" cy="20" r="3" class="cs-cam"/>
      <path d="M120 34v58" class="cs-dim"/><text x="128" y="68" class="cs-txt">~1.5 m</text>
      <circle cx="120" cy="160" r="62" class="cs-zone"/><text x="120" y="244" class="cs-txt cs-mid">ARM'S REACH CLEAR (~1 m)</text>
      <rect x="100" y="150" width="40" height="34" rx="6" class="cs-chair"/><circle cx="120" cy="140" r="12" class="cs-player"/><path d="M84 140h72" class="cs-player-arms"/></svg>`,
  standing: `<svg viewBox="0 0 240 260" class="bl-cs-svg"><rect x="70" y="10" width="100" height="12" rx="3" class="cs-screen"/><circle cx="120" cy="16" r="3" class="cs-cam"/>
      <path d="M120 28v34" class="cs-dim"/><text x="128" y="50" class="cs-txt">2–2.5 m</text>
      <rect x="40" y="66" width="160" height="160" rx="6" class="cs-zone"/>
      <path d="M40 238h160M40 233v10M200 233v10" class="cs-dim"/><text x="120" y="254" class="cs-txt cs-mid">2 m</text>
      <path d="M212 66v160M207 66h10M207 226h10" class="cs-dim"/><text x="222" y="146" class="cs-txt cs-mid" transform="rotate(90 222 146)">2 m</text>
      <circle cx="120" cy="146" r="14" class="cs-player"/><path d="M78 146h84" class="cs-player-arms"/><path d="M120 120v-14M114 112l6-8 6 8" class="cs-facing"/></svg>`,
};
const CS_ITEMS = {
  seated: ['Stable chair, no wheels', "Nothing within arm's reach", 'Sit ~1.5 m from the camera'],
  standing: ['Nothing inside the square', 'Stand 2–2.5 m from the screen', 'Shoes or bare feet, no socks'],
};
const CS_ICONS = {
  // tiny pictograms for the bullets: clear zone, distance, footing / chair, reach
  zone: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 3"/><path d="M8 8l8 8M16 8l-8 8"/></svg>',
  dist: '<svg viewBox="0 0 24 24"><path d="M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4"/></svg>',
  feet: '<svg viewBox="0 0 24 24"><path d="M7 3c2 0 3 2 3 5s-1 7-3 7-3-3-3-6 1-6 3-6zM17 8c2 0 3 2 3 5s-1 7-3 7-3-3-3-6 1-6 3-6z"/></svg>',
  chair: '<svg viewBox="0 0 24 24"><path d="M7 3v10h10M7 13v8M17 13v8M7 9h10"/></svg>',
  reach: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/><circle cx="12" cy="12" r="2"/></svg>',
};
const CS_ITEM_ICONS = { seated: ['chair', 'reach', 'dist'], standing: ['zone', 'dist', 'feet'] };
export function clearSpaceScreen(ctx, { onDone, seated, autoContinue = true, holdS = 3, timeoutS, kiosk } = {}) {
  const isKiosk = !!(kiosk ?? (ctx.settings?.kiosk || /[?&]kiosk=1\b/.test(location.search)));
  timeoutS = timeoutS ?? (isKiosk ? 30 : 0);
  let isSeated = !!(seated ?? ctx.settings?.seated);
  const live = h('div', { class: 'bl-cs-live' }, h('i'), h('b', {}, 'LOOKING FOR YOU…'), h('span', {}, ''));
  const autoNum = h('b', {}, '');
  const auto = h('div', { class: 'bl-cs-auto' }, h('span', { class: 'bl-cs-ring', html: '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" class="cs-ring-bg"/><circle cx="20" cy="20" r="17" class="cs-ring" pathLength="100"/></svg>' }), autoNum);
  const autoLab = h('span', { class: 'bl-cs-auto-lab' }, 'or hold still in frame to confirm');
  const timeoutEl = h('div', { class: 'bl-cs-timeout' }, '');
  const btn = uiButton("I'M CLEAR", () => finish(false, false, 'button'), { cls: 'is-primary', icon: ICON.play, id: 'clear-ok' });
  btn.setAttribute('data-ui-dwell', '1.2'); btn.setAttribute('data-ui-nopunch', '');
  const swap = uiButton('', () => { isSeated = !isSeated; build(); good = 0; }, { cls: 'is-small', id: 'clear-seated' });
  swap.setAttribute('data-ui-dwell', '1.2'); swap.setAttribute('data-ui-nopunch', '');
  const skip = uiButton('SKIP', () => finish(true, false), { cls: 'is-small', id: 'clear-skip' });
  skip.setAttribute('data-ui-mouseonly', '');
  const kicker = h('div', { class: 'bl-kicker' }, 'SAFETY CHECK');
  const title = h('h1', { class: 'bl-h1' });
  const list = h('ul', { class: 'bl-cs-list' });
  const diagram = h('div', { class: 'bl-cs-diagram' });
  const node = h('div', { class: 'bl-cs' },
    h('div', { class: 'bl-panel bl-cs-panel' },
      diagram,
      h('div', { class: 'bl-cs-copy' }, kicker, title, list, live, h('div', { class: 'bl-cs-actions' }, btn, auto, autoLab), timeoutEl, h('div', { class: 'bl-cs-swap' }, swap))),
    h('div', { class: 'bl-calib-skip' }, skip));
  function build() {
    node.classList.toggle('is-seated', isSeated);
    title.replaceChildren(...(isSeated ? ['CLEAR YOUR', h('br'), 'REACH'] : ['CLEAR', h('br'), h('em', {}, '2 × 2 m')]));
    list.replaceChildren(...CS_ITEMS[isSeated ? 'seated' : 'standing'].map((t, i) => h('li', {}, h('i', { html: CS_ICONS[CS_ITEM_ICONS[isSeated ? 'seated' : 'standing'][i]] }), t)));
    diagram.innerHTML = CS_DIAGRAM[isSeated ? 'seated' : 'standing'];
    swap.querySelector('.bl-btn-label').firstChild.textContent = isSeated ? 'PLAY STANDING INSTEAD' : 'PLAY SEATED INSTEAD';
  }
  build();
  let done = false, good = 0, elapsed = 0, motionE = 0, prevKp = null;
  function finish(skipped, wasAuto, how = skipped ? 'skip' : wasAuto ? 'timeout' : 'button') {
    if (done) return;
    done = true;
    removeEventListener('keydown', onKey);
    try { ctx.audio?.sfx?.('uiSelect'); } catch { /* */ }
    onDone?.({ skipped, auto: wasAuto, seated: isSeated, how });
  }
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(false, false, 'key'); } };
  addEventListener('keydown', onKey);
  /** Body motion: travel per second (in body heights) of the EMA-smoothed keypoints (tracker jitter is mostly
   *  filtered out), itself smoothed. "Holding still" = below ~0.25 body heights / s. */
  function stillness(f) {
    const kp = f?.kp2d;
    if (!kp || !kp.length) { prevKp = null; motionE = Infinity; return motionE; }
    if (prevKp?.f === f) return motionE;
    const t = f.tCapture ?? f.tArrive ?? performance.now();
    if (!prevKp || prevKp.length !== kp.length) {
      prevKp = kp.map((p) => (p ? { x: p.x, y: p.y } : null)); prevKp.f = f; prevKp.t = t; motionE = 1; return motionE;
    }
    let y0 = 1e9, y1 = -1e9, sum = 0, n = 0;
    for (let i = 0; i < kp.length; i++) {
      const p = kp[i], q = prevKp[i];
      if (!p || !q || (p.c ?? 1) < 0.3) continue;
      const nx = q.x + (p.x - q.x) * 0.3, ny = q.y + (p.y - q.y) * 0.3;
      sum += Math.hypot(nx - q.x, ny - q.y); n++;
      q.x = nx; q.y = ny;
      if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
    }
    const fdt = Math.min(0.25, Math.max(1 / 120, (t - prevKp.t) / 1000));
    prevKp.f = f; prevKp.t = t;
    const sp = n ? sum / n / Math.max(0.05, y1 - y0) / fdt : 1;
    motionE = Number.isFinite(motionE) ? motionE + (sp - motionE) * 0.25 : sp;
    return motionE;
  }
  return {
    node,
    get seated() { return isSeated; },
    finish: () => finish(false, false, 'api'),
    get stillFor() { return good; },
    update(dt) {
      if (done) return;
      elapsed += dt;
      const f = freshFrame(ctx.motion, 700);
      const d = f ? measureDistance(f, { upperBodyOnly: isSeated || !!ctx.settings?.upperBodyOnly }) : null;
      const still = stillness(f) < 0.25;
      const ok = !!f && !d && still;
      good = ok ? good + dt : Math.max(0, good - dt * 2);
      const [ttl, sub, kind] = !f ? ['LOOKING FOR YOU…', 'Step in front of the camera', 'wait'] : d ? [DISTANCE_TEXT[d].title, DISTANCE_TEXT[d].sub, 'warn'] : [isSeated ? 'FRAMED WELL' : 'WHOLE BODY IN VIEW', 'Distance looks right', 'ok'];
      if (live.dataset.kind !== kind || live.children[1].textContent !== ttl) { live.dataset.kind = kind; live.children[1].textContent = ttl; live.children[2].textContent = sub; }
      const showAuto = autoContinue && good > 0;
      auto.classList.toggle('is-on', showAuto);
      autoLab.classList.toggle('is-on', showAuto);
      const lab = showAuto ? 'HOLD STILL… confirming' : f && !d ? 'or hold still in frame to confirm' : 'or step into frame and hold still';
      if (autoLab.textContent !== lab) autoLab.textContent = lab;
      if (showAuto) {
        const left = Math.max(0, holdS - good);
        const txt = String(Math.ceil(left));
        if (autoNum.textContent !== txt) autoNum.textContent = txt;
        auto.style.setProperty('--k', Math.min(1, good / holdS).toFixed(3));
        if (good >= holdS) { finish(false, false, 'still'); return; }
      } else if (autoNum.textContent) { autoNum.textContent = ''; auto.style.setProperty('--k', 0); }
      // kiosk only: a long fallback so an unattended stand never sticks here
      if (timeoutS > 0) {
        const left = timeoutS - elapsed;
        const tt = left <= 10 ? `Continuing in ${Math.max(0, Math.ceil(left))} s` : '';
        if (timeoutEl.textContent !== tt) timeoutEl.textContent = tt;
        if (left <= 0) finish(false, true, 'timeout');
      }
    },
    dispose() { removeEventListener('keydown', onKey); },
  };
}

// ======================================================================================= pause
/**
 * pause({ reason, onResume?, onQuit?, onNewPlayer? }). Handle: setAbandon(secondsLeft | null, { kiosk }) shows the
 * abandoned-run countdown ("STILL THERE? Step in to continue · 8") that CORE drives while nobody is tracked.
 */
export function pauseScreen(ctx, { reason = 'player-lost', onResume, onQuit, onNewPlayer } = {}) {
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
  if (onNewPlayer) { const b = uiButton('NEW PLAYER', onNewPlayer, { cls: 'is-small', icon: ICON.user, id: 'pause-new-player' }); b.setAttribute('data-ui-dwell', '1.2'); b.setAttribute('data-ui-nopunch', ''); btns.push(b); }
  const abNum = h('em', {}, '');
  const abandon = h('div', { class: 'bl-pause-abandon', role: 'status' }, h('b', {}, 'STILL THERE?'), h('span', {}, 'Step in to continue · ', abNum));
  const node = h('div', { class: 'bl-pause' + (reason === 'user' ? ' is-user' : '') },
    h('div', { class: 'bl-panel bl-pause-panel' },
      h('div', { class: 'bl-pause-kicker' }, 'PAUSED'),
      h('h2', { class: 'bl-pause-title' }, title),
      h('p', { class: 'bl-pause-sub' }, sub),
      h('div', { class: 'bl-pause-frame' }, cv, h('i', { class: 'bl-pause-box' }), live),
      h('p', { class: 'bl-pause-auto' }, 'The game resumes with a 3-2-1 countdown when you are back.'),
      abandon,
      btns.length ? h('div', { class: 'bl-panel-foot' }, btns) : null));
  let t = 0, abKiosk = false;
  return {
    node,
    /** Abandoned-run countdown: seconds left before the run ends (null hides it). */
    setAbandon(secs, { kiosk = abKiosk } = {}) {
      abKiosk = kiosk;
      const on = Number.isFinite(secs);
      abandon.classList.toggle('is-on', on);
      if (!on) return;
      const txt = `${kiosk ? 'new player in' : 'back to the title in'} ${Math.max(0, Math.ceil(secs))}`;
      if (abNum.textContent !== txt) abNum.textContent = txt;
    },
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
  { key: 'jumpHeight', alias: ['highestJump', 'jumpCm', 'maxJumpCm'], label: 'Highest jump', unit: 'cm', dec: 0, ref: 60,
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="4" r="2.2"/><path d="M12 7v7M12 9l-5-3M12 9l5-3M12 14l-4 4M12 14l4 4"/><path d="M4 22h16" class="i-acc"/></svg>',
    tier: (v) => (v >= 45 ? 'Sky walker' : v >= 30 ? 'Spring-loaded' : v >= 15 ? 'Light feet' : 'Grounded') },
  { key: 'reactionMs', alias: ['bestReaction', 'reaction', 'bestReactionMs'], label: 'Best reaction', unit: 'ms', dec: 0, ref: 700, invert: true,
    icon: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    // CORE's tier (core/score.js reactionTier: <= 330 / 400 / 480 ms) wins; the local mirror only covers stand-in stats
    tier: (v, b) => (typeof b?.reactionTier === 'string' && b.reactionTier ? b.reactionTier : v <= 330 ? 'Lightning reflexes' : v <= 400 ? 'Quick draw' : v <= 480 ? 'Alert' : 'Steady') },
  { key: 'timingSdMs', alias: ['timingConsistencyMs', 'timingSd'], label: 'Timing consistency', unit: 'ms', dec: 0, ref: 120, invert: true, prefix: '±',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6" class="i-acc"/></svg>',
    tier: (v) => (v <= 25 ? 'Metronome' : v <= 45 ? 'On the beat' : v <= 70 ? 'Grooving' : 'Finding the beat') },
  { key: 'moves', alias: ['movesCount', 'moveCount'], label: 'Moves performed', unit: '', dec: 0, ref: 300,
    icon: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>', tier: (v) => (v >= 200 ? 'Relentless' : v >= 100 ? 'Busy body' : 'Getting going') },
  { key: 'kcal', alias: ['calories'], label: 'Energy burned', unit: 'kcal', dec: 0, ref: 80, approx: true,
    icon: '<svg viewBox="0 0 24 24"><path d="M12 2s6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 2-5s0 3 2 4c0-5 2-11 2-11z"/></svg>', tier: () => 'estimate' },
];
const MIX = [['punch', 'PUNCH', '#ff8a3d'], ['kick', 'KICK', '#4ff3ff'], ['jump', 'JUMP', '#ff3b5c'], ['squat', 'DUCK', '#b06bff'], ['dodge', 'DODGE', '#ffd34f'], ['guard', 'GUARD', '#7fb8ff'], ['blast', 'BLAST', '#fff2a8']];
const pick = (o, k, aliases) => { if (!o) return undefined; if (o[k] !== undefined && o[k] !== null) return o[k]; for (const a of aliases) if (o[a] !== undefined && o[a] !== null) return o[a]; return undefined; };
const fmtInt = (v) => Math.round(+v || 0).toLocaleString('en-US');

/**
 * results({ stats, onReplay, onAgain, onTitle, onSkipReplay?, photoCard? })
 * Phase 1 "replay": full-screen letterboxed replay (cinematic bars, "REPLAY · BEST MOMENT" label, progress bar) driven by
 *   bus 'replay' events ({ on:true|false } or { type|phase: 'start'|'progress'|'end', progress, label, speed }) and/or
 *   ctx.game.replay.{active, progress}. Skipped when no replay starts within a short wait.
 * Phase 2 "stats": the panels slide in, counters run, rank stamp, NEW BEST. Pressing REPLAY returns to phase 1.
 * stats extras (all optional): newBest, best / prevBest, mode ('showcase'|'challenge'), replay { label, speed, hits },
 *   body.timingSdMs, body.moveCounts { punch, kick, jump, squat, dodge, guard, blast }.
 * photoCard (CV team): HTMLElement | canvas | { node|canvas|src, caption?, pending?: true } ; also handle.setPhotoCard().
 */
export function resultsScreen(ctx, { stats = {}, onReplay, onAgain, onTitle, onSkipReplay, photoCard = null } = {}, shared = {}) {
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
      h('span', { class: 'bl-res-jbar' }, h('i', { style: { '--w': ((j[k] || 0) / total).toFixed(3), '--d': `${0.5 + i * 0.12}s` } })),
      counter(j[k] || 0, 0, 0.5 + i * 0.12)));
  const body = stats.body || stats;
  let ci = 0;
  const cards = BODY.map((B) => {
    const v = pick(body, B.key, B.alias);
    if (!(Number.isFinite(+v) && v !== null && v !== '' && +v > 0)) return null;     // hide unmeasured stats (no dead rows)
    const i = ci++;
    const frac = Math.max(0.04, Math.min(1, B.invert ? 1 - (+v - 0) / B.ref : +v / B.ref));
    return h('div', { class: 'bl-bodycard', style: { '--d': `${0.9 + i * 0.14}s`, '--f': frac.toFixed(3) } },
      h('i', { class: 'bl-bodycard-icon', html: B.icon }),
      h('div', { class: 'bl-bodycard-main' },
        h('span', { class: 'bl-bodycard-label' }, B.label),
        h('span', { class: 'bl-bodycard-val' }, B.approx ? '≈' : '', B.prefix || '', counter(+v, B.dec, 0.9 + i * 0.14), h('small', {}, B.unit)),
        h('span', { class: 'bl-bodycard-meter' }, h('i')),
        h('span', { class: 'bl-bodycard-tier' }, B.tier(+v, body))));
  }).filter(Boolean);
  // move mix: share of each move type (real counts from the detector)
  const mc = body.moveCounts || stats.moveCounts || null;
  let mix = null;
  if (mc) {
    const parts = MIX.map(([k, lab, col]) => [k, lab, col, +mc[k] || 0]).filter((p) => p[3] > 0);
    const sum = parts.reduce((s, p) => s + p[3], 0);
    if (sum > 0) {
      mix = h('div', { class: 'bl-res-mix', style: { '--d': `${0.9 + ci * 0.14}s` } },
        h('div', { class: 'bl-res-mix-head' }, h('span', {}, 'MOVE MIX'), h('b', {}, `${sum} moves`)),
        h('div', { class: 'bl-res-mix-bar' }, parts.map(([, , col, n]) => h('i', { style: { flexGrow: n, background: col } }))),
        h('div', { class: 'bl-res-mix-legend' }, parts.map(([, lab, col, n]) => h('span', {}, h('i', { style: { background: col } }), lab, h('b', {}, n)))));
    }
  }
  const newBest = !!stats.newBest;
  const prevBestV = stats.prevBest ?? stats.previousBest;
  const prevBest = newBest ? prevBestV : (stats.best ?? prevBestV);
  const stamp = h('div', { class: 'bl-stamp r-' + rank }, h('span', {}, rank), h('i', { class: 'bl-stamp-ring' }));
  const bestEl = newBest
    ? h('div', { class: 'bl-res-newbest' }, h('b', { 'data-text': 'NEW BEST!' }, 'NEW BEST!'), Number.isFinite(+prevBestV) && +prevBestV > 0 ? h('span', {}, `previous ${fmtInt(prevBestV)}`) : null)
    : Number.isFinite(+prevBest) && +prevBest > 0 ? h('div', { class: 'bl-res-bestline' }, 'BEST ', h('b', {}, fmtInt(prevBest))) : null;
  const modeLab = stats.mode === 'showcase' ? 'SHOWCASE · ' : stats.mode === 'challenge' ? 'CHALLENGE · ' : '';
  const photoSlot = h('section', { class: 'bl-res-photo bl-hidden' });
  const left = h('div', { class: 'bl-res-col bl-res-colL' },
    h('section', { class: 'bl-panel bl-res-left' + (newBest ? ' is-newbest' : '') },
      h('div', { class: 'bl-res-kicker' }, modeLab + (stats.cleared === false ? 'DEFEATED' : 'STAGE CLEAR')),
      h('div', { class: 'bl-res-scorebox' },
        h('div', {}, h('span', { class: 'bl-res-label' }, 'SCORE'), h('div', { class: 'bl-res-score' }, counter(stats.score || 0, 0, 0.15)), bestEl),
        stamp),
      h('div', { class: 'bl-res-mini' },
        h('div', {}, h('span', {}, 'MAX COMBO'), h('b', {}, counter(stats.maxCombo || 0, 0, 0.4))),
        h('div', {}, h('span', {}, 'ACCURACY'), h('b', {}, counter(((stats.accuracy ?? (((j.perfect || 0) * 3 + (j.great || 0) * 2 + (j.good || 0)) / (total * 3))) * 100), 1, 0.4), '%'))),
      h('div', { class: 'bl-res-judges' }, judgeRows)),
    photoSlot);
  const right = h('div', { class: 'bl-res-col bl-res-colR' },
    h('section', { class: 'bl-panel bl-res-right' },
      h('div', { class: 'bl-res-ai' }, h('i', { class: 'bl-res-ai-dot' }), 'YOUR BODY, MEASURED BY AI'),
      h('p', { class: 'bl-res-ai-sub' }, 'Computed live from your tracked skeleton: wrist speed, hip rise, timing spread and the gap between each cue and your first movement.'),
      h('div', { class: 'bl-bodycards' }, cards.length ? cards : h('div', { class: 'bl-bodycard-empty' }, 'Play a full run to get your body stats.')),
      mix));
  const nopunch = (b, dwell) => { b.setAttribute('data-ui-nopunch', ''); if (dwell) b.setAttribute('data-ui-dwell', String(dwell)); return b; };
  const nav = h('nav', { class: 'bl-res-nav' },
    onReplay ? nopunch(uiButton('REPLAY', () => { wantReplay = performance.now(); onReplay(); }, { icon: ICON.replay, id: 'res-replay' }), 1.0) : null,
    nopunch(uiButton('PLAY AGAIN', onAgain, { cls: 'is-primary', icon: ICON.again, id: 'res-again' }), 1.2),
    nopunch(uiButton('TITLE', onTitle, { icon: ICON.home, id: 'res-title' }), 1.0));

  // ---- cinematic replay layer
  const R0 = stats.replay || {};
  const cineLabel = h('b', {}, 'BEST MOMENT');
  const cineMeta = h('span', { class: 'bl-cine-meta' });
  const cineFill = h('i', { class: 'bl-cine-fill' });
  const cineSkip = nopunch(uiButton('SKIP', () => { showStats('skip'); try { onSkipReplay?.(); } catch (e) { console.error(e); } }, { cls: 'is-small bl-cine-skip', id: 'res-skip-replay' }), 0.8);
  // picture-in-picture: the CV mirror's recorded neon silhouette ("YOU · 0.35×") framed inside the letterbox, beside the
  // 3D replay. The UI sets ui.replayOverlay = true, so CORE's fallback inset (core/space.js mirrorInset) stands down;
  // if CORE still mounted its inset this round, the canvas is borrowed from it and its empty box is hidden.
  const pipMedia = h('div', { class: 'bl-cine-pip-media' });
  const pipTag = h('span', { class: 'bl-cine-pip-tag' }, h('i'), 'YOU');
  const pip = h('figure', { class: 'bl-cine-pip' }, pipMedia, pipTag, h('figcaption', {}, 'your silhouette, same moment'));
  const cine = h('div', { class: 'bl-cine' },
    h('div', { class: 'bl-cine-bar bl-cine-top' }, h('div', { class: 'bl-cine-label' }, h('i', { class: 'bl-cine-rec' }), h('span', {}, 'REPLAY'), h('em', {}, '·'), cineLabel), cineMeta),
    pip,
    h('div', { class: 'bl-cine-bar bl-cine-bot' }, h('div', { class: 'bl-cine-prog' }, cineFill), h('span', { class: 'bl-cine-hint' }, 'Rebuilt from your tracked poses, not a video'), cineSkip));
  let adopted = null;
  function adoptMirror(d = {}) {
    const m = ctx.mirror, c = m?.canvas;
    if (!c || adopted) return;
    const coreBox = c.closest?.('.bl-mirror-inset') || null;
    if (!coreBox && m.mode !== 'replay') return;              // no recorded silhouette to show
    adopted = { c, parent: c.parentNode, next: c.nextSibling, style: c.getAttribute('style'), coreBox };
    if (coreBox) coreBox.style.visibility = 'hidden';
    c.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block');
    pipMedia.append(c);
    const sp = d.speed ?? R0.speed ?? 0.35;
    pipTag.lastChild.textContent = `YOU · ${(+sp).toFixed(2).replace(/0$/, '')}×`;
    pip.querySelector('figcaption').textContent = 'your silhouette, same moment';
    node.classList.add('has-pip');
    node.classList.toggle('is-bosskill', !!(d.bossKill ?? R0.bossKill));
  }
  // no recorded silhouette (no camera segmentation: demo / autoplay, CV off): the tracked 2D skeleton the replay was
  // rebuilt from, same moment (ctx.game.replaySkeletonAt(songT), driven by the 3D replay's clock) - QA r3 art P2-2
  let skel = null;
  function adoptSkeleton(d = {}) {
    const G = ctx.game;
    if (adopted || skel || !d.skeleton || typeof G?.replaySkeletonAt !== 'function') return;
    const c = h('canvas', { class: 'bl-cine-pip-skel', width: 300, height: 400, style: { position: 'absolute', inset: '0', width: '100%', height: '100%' } });
    pipMedia.append(c);
    skel = { c, g: c.getContext('2d'), box: null, w: d.window ?? null };
    const sp = d.speed ?? R0.speed ?? 0.35;
    pipTag.lastChild.textContent = `YOU · ${(+sp).toFixed(2).replace(/0$/, '')}×`;
    pip.querySelector('figcaption').textContent = 'your tracked skeleton, same moment';
    node.classList.add('has-pip');
    node.classList.toggle('is-bosskill', !!(d.bossKill ?? R0.bossKill));
  }
  function drawSkel() {
    const G = ctx.game, rp = G?.replay;
    if (!skel) return;
    const fr = rp?.active ? G.replaySkeletonAt(rp.t) : null;
    node.classList.toggle('has-pip', !!fr);             // nothing to show (replay over / no frame): no empty box
    const { c, g } = skel, W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(26,16,54,.92)'); gr.addColorStop(1, 'rgba(10,6,24,.92)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (!fr) return;
    // a stable box: the union of the bounds seen so far (no breathing zoom)
    const selfie = fr.source === 'synthetic';
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of fr.kp) { if (!p || p.c < 0.3) continue; const x = selfie ? p.x : 1 - p.x; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    if (!(x1 > x0)) return;
    const b = skel.box ??= { x0, x1, y0, y1 };
    b.x0 = Math.min(b.x0, x0); b.x1 = Math.max(b.x1, x1); b.y0 = Math.min(b.y0, y0); b.y1 = Math.max(b.y1, y1);
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0, sc = Math.min(W * 0.74 / bw, H * 0.62 / bh);
    const ox = W / 2 - (b.x0 + bw / 2) * sc, oy = H * 0.5 - (b.y0 + bh / 2) * sc;
    drawSkeleton(g, { source: fr.source }, fr.kp, fr.edges, (x, y) => [ox + x * sc, oy + y * sc], { width: 4, glow: 16 });
  }
  function releaseMirror() {
    if (skel) { skel.c.remove(); skel = null; node.classList.remove('has-pip'); }
    const a = adopted;
    if (!a) return;
    adopted = null;
    node.classList.remove('has-pip');
    if (a.coreBox) a.coreBox.style.visibility = '';
    if (a.c.parentNode !== pipMedia) return;                   // CORE's inset already put it back
    if (a.style == null) a.c.removeAttribute('style'); else a.c.setAttribute('style', a.style);
    if (a.parent) a.parent.insertBefore(a.c, a.next && a.next.parentNode === a.parent ? a.next : null); else a.c.remove();
  }
  const node = h('div', { class: 'bl-results is-wait' }, cine, left, right, nav);

  let phase = 'wait', t = 0, statsT = -1, stampDone = false, wantReplay = 0, replayT = 0, prog = 0, sawReplay = false;
  const expectReplay = !!stats.replay || !!ctx.game?.replayWin;
  function setMeta(d = {}) {
    cineLabel.textContent = String(d.label || d.title || R0.label || 'BEST MOMENT').toUpperCase();
    const sp = d.speed ?? R0.speed ?? 0.35, hits = d.hits ?? d.window?.hits ?? R0.hits;
    cineMeta.textContent = [sp ? `${(+sp).toFixed(2).replace(/0$/, '')}×` : null, hits ? `${hits} HITS` : null, d.seconds ?? R0.seconds ? `${(+(d.seconds ?? R0.seconds)).toFixed(1)} s` : null].filter(Boolean).join(' · ');
  }
  setMeta();
  function showReplay(d) {
    sawReplay = true; replayT = 0; prog = 0; cineFill.style.transform = 'scaleX(0)';
    if (d) setMeta(d);
    if (phase === 'replay') return;
    phase = 'replay';
    node.classList.remove('is-wait', 'is-stats'); node.classList.add('is-replay');
    inert(true);
  }
  function inert(replay) { for (const x of [left, right, nav]) x.toggleAttribute('data-ui-inert', replay); cine.toggleAttribute('data-ui-inert', !replay); }
  function showStats(why) {
    if (phase === 'stats') return;
    phase = 'stats';
    node.classList.remove('is-wait', 'is-replay', 'is-pending'); node.classList.add('is-stats');
    inert(false);
    if (statsT < 0) statsT = t;
    node.dataset.statsWhy = why || '';
  }
  function onReplayEvent(d = {}) {
    const ty = d.type || d.phase || (d.on === true ? 'start' : d.on === false ? 'end' : Number.isFinite(d.progress) ? 'progress' : null);
    if (ty === 'start') { showReplay(d); try { adoptMirror(d); adoptSkeleton(d); } catch (e) { console.warn('[ui] replay pip', e); } }
    else if (ty === 'progress') { if (phase !== 'replay' && !sawReplay) showReplay(d); prog = Math.max(0, Math.min(1, +d.progress || 0)); }
    else if (ty === 'end') { releaseMirror(); prog = 1; cineFill.style.transform = 'scaleX(1)'; setTimeout(() => showStats('end'), 350); }
  }
  const offs = [];
  if (ctx.bus?.on) offs.push(ctx.bus.on('replay', onReplayEvent));
  if (expectReplay) { phase = 'replay-wait'; node.classList.remove('is-wait'); node.classList.add('is-replay', 'is-pending'); inert(true); }

  // photo card slot (CV team)
  function setPhotoCard(pc) {
    photoSlot.replaceChildren();
    if (!pc) { photoSlot.classList.add('bl-hidden'); return; }
    const o = pc.nodeType ? { node: pc } : pc;
    let media = o.node || o.canvas || null;
    if (!media && o.src) media = h('img', { src: o.src, alt: o.caption || 'Photo card' });
    photoSlot.classList.remove('bl-hidden');
    photoSlot.classList.toggle('is-pending', !!o.pending && !media);
    // native append() would print falsy children as text ("null"): filter them out
    photoSlot.append(...[
      h('div', { class: 'bl-res-photo-head' }, h('i', { html: ICON.cam }), h('span', {}, o.title || 'PHOTO BOOTH')),
      h('div', { class: 'bl-res-photo-media' }, media || h('div', { class: 'bl-res-photo-wait' }, h('i', { html: ICON.cam }), h('b', {}, o.caption || 'STRIKE YOUR VICTORY POSE'), h('span', {}, 'both hands up · V · flex'))),
      media && o.caption ? h('div', { class: 'bl-res-photo-cap' }, o.caption) : null,
      ...(o.actions || [])].filter((c) => c !== null && c !== undefined && c !== false));
    photoSlot.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { duration: 400, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  setPhotoCard(photoCard);

  // CV Photo Booth overlay (cv/photobooth.js, fixed full-screen): while the stats show, lay it out around the panels.
  // html.bl-booth-results + CSS vars, consumed by game.css: headline in the centre gap between the columns on a dark
  // plate, countdown + hold ring beside the hero (not on its chest), privacy line above the button row.
  const de = document.documentElement;
  let layoutT = -1;
  function boothLayout() {
    const W = innerWidth, H = innerHeight;
    const lr = left.getBoundingClientRect(), rr = right.querySelector('.bl-res-right')?.getBoundingClientRect() || right.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    if (!(lr.width > 0 && rr.width > 0)) return;
    const gl = lr.right, gr = rr.left;
    const set = (k, v) => de.style.setProperty(k, `${Math.round(v)}px`);
    set('--bl-booth-cx', (gl + gr) / 2);
    set('--bl-booth-w', Math.max(180, gr - gl - 28));
    set('--bl-booth-toast-b', Math.max(12, H - nr.top + 12));
    // countdown + hold ring: inside the PHOTO BOOTH panel (where the card lands), else beside the hero
    const pr = !photoSlot.classList.contains('bl-hidden') ? photoSlot.getBoundingClientRect() : null;
    if (pr && pr.height > 60) {
      set('--bl-booth-count-x', pr.left + pr.width / 2);
      set('--bl-booth-count-y', pr.top + pr.height * 0.55);
      set('--bl-booth-count-size', Math.min(pr.height * 0.95, H * 0.3));
    } else {
      const hb = shared.heroBounds?.();
      let cx = hb ? (hb.r + gr) / 2 : W * 0.78;
      cx = Math.max(hb ? hb.r + H * 0.1 : W * 0.6, cx);
      set('--bl-booth-count-x', cx);
      set('--bl-booth-count-y', Math.min(Math.max(rr.bottom + H * 0.17, H * 0.56), nr.top - H * 0.16));
      set('--bl-booth-count-size', H * 0.26);
    }
  }
  function setDocPhase() {
    de.classList.toggle('bl-booth-results', phase === 'stats');
    de.classList.toggle('bl-res-replay', phase === 'replay' || phase === 'replay-wait');
  }

  function slamStamp() {
    stampDone = true;
    stamp.classList.add('is-in');
    stamp.animate([
      { opacity: 0, transform: 'scale(4) rotate(-40deg)' },
      { opacity: 1, transform: 'scale(.86) rotate(-14deg)', offset: 0.55 },
      { opacity: 1, transform: 'scale(1.06) rotate(-12deg)', offset: 0.78 },
      { opacity: 1, transform: 'scale(1) rotate(-12deg)' }], { duration: 520, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' });
    stamp.querySelector('.bl-stamp-ring').animate([{ transform: 'scale(.6)', opacity: 0.9 }, { transform: 'scale(2.2)', opacity: 0 }], { duration: 700, delay: 280, easing: 'ease-out', fill: 'forwards' });
    left.querySelector('.bl-res-left').animate([{ translate: '0 0' }, { translate: '-7px 5px' }, { translate: '6px -4px' }, { translate: '0 0' }], { duration: 240, delay: 290 });
    try { ctx.audio?.sfx?.(rank === 'S' || rank === 'A' ? 'perfect' : 'great'); } catch { /* optional */ }
    if (newBest) {
      const nb = left.querySelector('.bl-res-newbest');
      nb?.classList.add('is-in');
      nb?.animate([{ opacity: 0, transform: 'scale(2.4) rotate(-8deg)' }, { opacity: 1, transform: 'scale(.94) rotate(-3deg)', offset: 0.6 }, { opacity: 1, transform: 'scale(1) rotate(-3deg)' }], { duration: 560, delay: 420, easing: 'cubic-bezier(.3,1.4,.5,1)', fill: 'both' });
      setTimeout(() => { try { ctx.audio?.sfx?.('combo', { pitch: 1.3 }); } catch { /* */ } }, 450);
    }
  }

  return {
    node, rank,
    get phase() { return phase; },
    showStats: () => showStats('api'),
    setPhotoCard,
    update(dt) {
      t += dt;
      setDocPhase();
      if (phase === 'stats' && t - layoutT > 0.25) { layoutT = t; boothLayout(); }
      // replay state: bus events, or poll CORE's player
      const rp = ctx.game?.replay;
      if (rp && rp.active) { if (phase !== 'replay') showReplay(); prog = Math.max(prog, Math.min(1, rp.progress || 0)); }
      else if (rp && phase === 'replay' && sawReplay && replayT > 0.5 && !rp.active && prog > 0.02) onReplayEvent({ type: 'end' });
      if (phase === 'replay') {
        replayT += dt;
        drawSkel();
        cineFill.style.transform = `scaleX(${prog.toFixed(4)})`;
        node.classList.remove('is-pending');
        if (replayT > 30) showStats('timeout');
      } else if (phase === 'replay-wait') {
        if (t > 3.2) showStats('no-replay');
      } else if (phase === 'wait') {
        if (t > 0.4) showStats('none');
      } else if (wantReplay && performance.now() - wantReplay > 1500) wantReplay = 0;
      if (statsT < 0) return;
      const st = t - statsT;
      for (const c of counters) {
        if (c.done) continue;
        const k = Math.max(0, Math.min(1, (st - c.delay) / 1.0));
        const e = 1 - (1 - k) ** 3;
        const v = c.to * e;
        c.el.textContent = c.dec ? v.toFixed(c.dec) : Math.round(v).toLocaleString('en-US');
        if (k >= 1) c.done = true;
      }
      if (!stampDone && st > 1.3) slamStamp();
    },
    dispose() { offs.forEach((f) => { try { f?.(); } catch { /* */ } }); releaseMirror(); de.classList.remove('bl-booth-results', 'bl-res-replay'); },
  };
}

export { kpBounds };
