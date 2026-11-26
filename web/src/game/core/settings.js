// Game settings: defaults <- localStorage ('breaklight.settings') <- URL params. CORE owns the object; the UI settings
// screen edits it in place and calls settings.save().
//
// URL params (dev): ?tracker=hmr|mediapipe|demo  ?autoplay=1  ?debug=1  ?skip=calibrate|title|run|boss|results
//   ?upper=1 (upper body only)  ?difficulty=easy|normal|hard  ?seed=123  ?stub=all|visual,audio,ui  ?quality=low|medium|high|auto
//   ?offset=ms (judge offset)  ?mute=1  ?act=0|1|2 (start at that act, no Awakening)  ?mode=showcase|challenge
//   ?awaken=1|0 (force / skip the Act 0 "Awakening" intro)  ?seated=1  ?space=0 (skip the clear-space prompt)

const KEY = 'breaklight.settings';

/** Judgement windows (ms, half-width) per tracker; MediaPipe frames jitter more, so it gets a little more slack. */
export const WINDOWS = {
  base: { perfect: 90, great: 160, good: 250 },
  trackerScale: { hmr: 1.0, mediapipe: 1.15, demo: 1.0, autoplay: 1.0 },
  difficultyScale: { easy: 1.25, normal: 1.0, hard: 0.85 },
};

/**
 * Expected detection time of each move relative to the musical hit (ms, negative = the detector fires before the
 * strike lands). A real jab is detected ~0.1 s into the strike, i.e. a few tens of ms before full extension; a jump is
 * detected after take-off, so a player who is airborne on the beat fires it a little early.
 */
export const LEAD_MS = { punch: -40, kick: -60, jump: -70, squat: 0, guard: 0, dodge: 0, blast: 0 };

export const DEFAULTS = {
  tracker: 'auto',            // 'auto' (hmr -> mediapipe -> demo) | 'hmr' | 'mediapipe' | 'demo'
  mode: 'showcase',           // 'showcase' (no-fail: only hazards that hit you cost hearts, fast regen) | 'challenge' (strict)
  upperBodyOnly: false,
  seated: false,              // seated mode: upper-body moves only, dodges are leans (no steps, kicks, jumps or ducks)
  difficulty: 'normal',
  volume: { master: 0.9, music: 0.8, sfx: 0.9 },   // the settings screen gives each channel a stepper
  judgeOffsetMs: 0,           // + = the player is late (shift the windows later)
  wrongMovePenalty: false,    // true: a note whose window closes after only the wrong strike (other hand / leg) shows WRONG
  adaptive: true,             // spawn density follows the hit rate
  quality: 'auto',
  showPip: true,
  hearts: null,               // null = by difficulty (HEARTS)
};

/** Hearts per difficulty (settings.hearts overrides). */
export const HEARTS = { easy: 8, normal: 5, hard: 4 };
export function heartsFor(settings) { return settings.hearts || HEARTS[settings.difficulty] || 5; }

/** AUDIO's setVolume() argument from the flat settings. */
export function audioVolume(s) {
  const v = s.volume;
  if (v && typeof v === 'object') return { master: v.master ?? 0.9, music: v.music ?? 0.8, sfx: v.sfx ?? 0.9 };
  return { master: Number.isFinite(+v) ? +v : 0.9, music: s.musicVolume ?? 0.8, sfx: s.sfxVolume ?? 0.9 };
}

/** Upper-body-only chart (no kicks / jumps): the setting, or implied by seated mode. */
export const upperOnlyOf = (s) => !!(s.upperBodyOnly || s.seated);

// ------------------------------------------------------------------------------------------ persistent flags + bests
const FLAGS = 'breaklight.flags', BEST = 'breaklight.best';
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch { return {}; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }
export const flags = {
  get(name) { return !!readJSON(FLAGS)[name]; },
  set(name, on = true) { const f = readJSON(FLAGS); f[name] = on; writeJSON(FLAGS, f); },
};
const bestKey = (settings) => `${settings.mode}:${settings.difficulty}${settings.seated ? ':seated' : upperOnlyOf(settings) ? ':upper' : ''}`;
/** Stored best for the current mode / difficulty (0 = none). */
export function bestFor(settings) { return readJSON(BEST)[bestKey(settings)] ?? 0; }
/** Best score per mode + difficulty (+ seated / upper). Returns { best, previous, isNew }. */
export function submitBest(settings, score) {
  const key = bestKey(settings);
  const all = readJSON(BEST);
  const previous = all[key] ?? 0;
  const isNew = score > previous && score > 0;
  if (isNew) { all[key] = Math.round(score); writeJSON(BEST, all); }
  return { best: Math.max(previous, Math.round(score)), previous, isNew, key };
}

function deepMerge(a, b) {
  for (const k of Object.keys(b ?? {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}

export function loadSettings(params = new URLSearchParams(location.search)) {
  const s = structuredClone(DEFAULTS);
  try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved) deepMerge(s, saved); } catch { /* private mode */ }
  const p = (k) => params.get(k);
  if (p('tracker')) s.tracker = p('tracker') === 'synthetic' ? 'demo' : p('tracker');
  if (p('upper')) s.upperBodyOnly = p('upper') === '1';
  if (p('difficulty')) s.difficulty = p('difficulty');
  if (p('offset')) s.judgeOffsetMs = +p('offset') || 0;
  if (p('quality')) s.quality = p('quality');
  if (p('mode')) s.mode = p('mode') === 'challenge' ? 'challenge' : 'showcase';
  if (p('seated')) s.seated = p('seated') === '1';
  // a legacy number volume (an older settings screen stepped it as one value) becomes the channel object again
  s.volume = audioVolume(s);
  delete s.musicVolume; delete s.sfxVolume;
  if (s.mode !== 'challenge') s.mode = 'showcase';
  if (p('mute') === '1') s.volume.master = 0;
  // dev flags (not persisted)
  const dev = {
    debug: p('debug') === '1',
    autoplay: p('autoplay') === '1',
    skip: p('skip') || null,
    seed: p('seed') ? +p('seed') : null,
    stub: p('stub') || '',
    act: p('act') != null ? +p('act') : null,
    awaken: p('awaken'),                    // '1' force the Awakening intro, '0' skip it, null = first run only
    space: p('space'),                      // '0' skip the clear-space prompt
  };
  Object.defineProperty(s, 'dev', { value: dev, enumerable: false });
  Object.defineProperty(s, 'save', {
    enumerable: false,
    value() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } },
  });
  return s;
}

/** Judgement windows (ms) for the current tracker / difficulty. */
export function windowsFor(settings, trackerKind) {
  const k = (WINDOWS.trackerScale[trackerKind] ?? 1) * (WINDOWS.difficultyScale[settings.difficulty] ?? 1);
  const b = WINDOWS.base;
  return { perfect: b.perfect * k, great: b.great * k, good: b.good * k };
}
