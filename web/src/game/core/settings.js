// Game settings: defaults <- localStorage ('breaklight.settings') <- URL params. CORE owns the object; the UI settings
// screen edits it in place and calls settings.save().
//
// URL params (dev): ?tracker=hmr|mediapipe|demo  ?autoplay=1  ?debug=1  ?skip=calibrate|title|run|boss|results
//   ?upper=1 (upper body only)  ?difficulty=easy|normal|hard  ?seed=123  ?stub=all|visual,audio,ui  ?quality=low|medium|high|auto
//   ?offset=ms (judge offset)  ?mute=1  ?act=0|1|2 (with skip=run: start at that act)

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
  upperBodyOnly: false,
  difficulty: 'normal',
  volume: { master: 0.9, music: 0.8, sfx: 0.9 },
  judgeOffsetMs: 0,           // + = the player is late (shift the windows later)
  wrongMovePenalty: true,     // the wrong strike (other hand / leg) inside a spirit's window is a Miss
  adaptive: true,             // spawn density follows the hit rate
  quality: 'auto',
  showPip: true,
  hearts: 5,
};

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
  if (p('mute') === '1') s.volume.master = 0;
  // dev flags (not persisted)
  const dev = {
    debug: p('debug') === '1',
    autoplay: p('autoplay') === '1',
    skip: p('skip') || null,
    seed: p('seed') ? +p('seed') : null,
    stub: p('stub') || '',
    act: p('act') != null ? +p('act') : 0,
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
