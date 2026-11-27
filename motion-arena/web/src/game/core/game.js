// BREAKLIGHT gameplay core: the state machine and everything that happens between the tracker, the beat clock and
// the AUDIO / VISUAL / UI modules.
//
//   boot -> calibrate -> title -> (tutorial | settings) -> [space] -> run ([Awakening] + acts 0..2) -> boss -> results
//   pause (from run / boss when the player is lost for > 1.5 s; resumes with a 3-2-1 countdown on a bar line)
//
// Act 0 "Awakening" (first run, or ?awaken=1): a guided minute on the real music. The spirit field runs on a virtual
// beat (fieldBeat) that lags the music clock: when a spirit flagged waitFor reaches its hit point the virtual beat
// holds there (the spirit freezes with its prompt) until the player does the move once, using the same detectors as
// gameplay (actions, held states, ChargeDetector). The accumulated lag is then rounded up to whole bars so the rest
// stays on the music's downbeats. The judge reads the lag as judge.beatOffset.
import * as THREE from 'three';
import { ACTS, ActChart, awakeningNotes, AWAKEN, AWAKEN_PROMPT, AWAKEN_HINT, BREATHER_BEATS } from './chart.js';
import { SpiritField } from './spirits.js';
import { Judge } from './judge.js';
import { Score } from './score.js';
import { BossScript, BOSS_BEATS } from './boss.js';
import { ChargeDetector } from './charge.js';
import { ReplayRecorder, ReplayPlayer } from './replay.js';
import { flags, submitBest, bestFor, todayBest, resetPlayerBest, heartsFor, audioVolume, upperOnlyOf } from './settings.js';
import { spaceCheck, skipButton, letterbox, mirrorInset, flashNotice, vignette, newPlayerButton } from './space.js';
import * as cameraMod from './camera.js';
import { PoseOverlay } from './pose.js';

const PLAY = new Set(['run', 'boss']);
const LOST_PAUSE_S = 1.5;

export const TUTORIAL_STEPS = [
  { id: 'punch', label: 'Punch', hint: 'Jab at the orange strikers: left lane = left hand', actions: ['punchLeft', 'punchRight'], reps: 3 },
  { id: 'kick', label: 'Kick', hint: 'Kick the cyan crawlers with the matching leg', actions: ['kickLeft', 'kickRight'], reps: 3, lower: true },
  { id: 'jump', label: 'Jump', hint: 'Jump over the red floor beam', actions: ['jump'], reps: 3, lower: true },
  { id: 'duck', label: 'Duck', hint: 'Squat under the violet beam', actions: ['squat'], reps: 3 },
  { id: 'dodge', label: 'Dodge', hint: 'Lean or step away from the yellow orbs', actions: ['leanLeft', 'leanRight', 'stepLeft', 'stepRight'], reps: 3 },
  { id: 'guard', label: 'Guard', hint: 'Fists up by your face to block the gold brute', actions: ['guard'], reps: 3 },
  { id: 'blast', label: 'Breaklight', hint: 'Both hands up for a second, then push forward!', actions: ['blast'], reps: 1 },
];

const PROMPT = {
  sweep: 'JUMP!', scythe: 'DUCK!', brute: 'GUARD!', core: 'HANDS UP!',
};
/** Notes whose prompt shows at least 2 beats ahead whatever the act's travel (slow full-body moves). */
const SLOW = new Set(['jump', 'squat', 'guard', 'blast']);
const HAZARD = new Set(['jump', 'squat', 'dodge']);
/** Replay: seconds of game time in the results highlight, and its playback speed. */
const REPLAY_WIN = 2.6, REPLAY_SPEED = 0.35;
/**
 * Awakening wait escalation (QA r2 P0-1): a waiting spirit coaches after COACH_S, accepts a looser version of the move
 * after LOOSE_S (any punch / any kick or knee-up / a partial squat / any lean or step / any guard / hands up for the
 * core) and resolves itself as Good ("Let's keep going!") after AUTO_S, so the intro can never soft-lock.
 */
const COACH_S = 5, LOOSE_S = 10, AUTO_S = 15;
const LOOSE_HINT = {
  punch: 'Any punch will do: either hand!', kick: 'Any kick or knee raise will do!', squat: 'Just bend your knees a little!',
  dodge: 'Lean or step to either side!', guard: 'Raise your hands!', jump: 'A little hop is enough!', blast: 'Hands up: we will do the rest!',
  brutePunch: 'One punch will do: either hand!',
};
/** Loose-stage headline: names what is now accepted (QA r3 design P2-1), so it never contradicts the hint. */
const LOOSE_HEAD = { punch: 'ANY PUNCH!', kick: 'ANY KICK!', squat: 'BEND DOWN!', dodge: 'ANY LEAN!', guard: 'HANDS UP!', jump: 'LITTLE HOP!', blast: 'HANDS UP!', brutePunch: 'PUNCH IT!' };
/** Loose key for a waiting note: the brute in its punch phase wants a punch, not a guard. */
const looseKey = (W) => (W.move === 'guard' && W.phase === 'punch' ? 'brutePunch' : W.move);
/** Awakening wait cap (QA r3 design P2-2): after this many auto-advances the remaining lessons are skipped. */
const AWAKEN_AUTO_CAP = 3;
/** Abandoned run (QA r3 design P1-1): paused with nobody tracked -> "Still there?" countdown -> quit. Kiosk: warn at
 *  20 s, new player at 30 s. Elsewhere: warn at 50 s, back to the title at 60 s. */
const ABANDON = { kiosk: { warn: 20, quit: 30 }, home: { warn: 50, quit: 60 } };
/** Two-hand push accent on every Breaklight (QA r3 art P2-1): blend in / hold / out (s). */
const PUSH_POSE = { in: 0.09, hold: 0.5, out: 0.35 };
/** Bloom bumps (added to the preset's base intensity): kept low so blasts and the kill never white out (QA r2 art
 *  P1-5). Cinematic shots clamp the total further; reduceFlashes caps everything at FLASH_CAP_REDUCED. */
const BLOOM = { perfect: 0.12, blast: 0.2, kill: 0.28 };
const FLASH_CAP = 0.3, FLASH_CAP_CINE = 0.18, FLASH_CAP_REDUCED = 0.08;
const CINE_SHOTS = new Set(['blast', 'bossKill', 'replayKill']);
/** Fallback echo placements per game state (used only when the CV mirror has no setEchoPreset): never over the
 *  Warden (boss) or the rift (run), whole figure in frame. */
const ECHO_PLACE = { run: { pos: [-26, 12, 78], h: 26 }, boss: { pos: [-44, 16, 70], h: 24 } };
/** Kiosk: results idle -> next player; title idle with nobody tracked -> fresh state for the next player. */
const KIOSK_RESULTS_IDLE_S = 40, KIOSK_TITLE_IDLE_S = 45;

export class Game {
  constructor(ctx, { clock, tracking, director, debug = null }) {
    this.ctx = ctx;
    this.clock = clock;
    this.tracking = tracking;
    this.director = director;
    this.debug = debug;
    const { bus, settings } = ctx;
    this.judge = new Judge({ clock, settings });
    this.score = new Score({ bus, hearts: heartsFor(settings), mode: settings.mode });
    this.field = new SpiritField({
      getVisuals: () => ctx.visuals, clock, judge: this.judge, heroHeight: () => this.heroH,
      cb: {
        onSpawn: (n) => { this.rec.noteSpawn(n, clock); bus.emit('spawn', { note: n }); },
        onResolve: (n, kind, err, how) => this._onResolve(n, kind, err, how),
        onBlock: (n, kind, err) => this._onBlock(n, kind, err),
      },
    });
    this.charge = new ChargeDetector({
      onLevel: (lv, charged) => this._onChargeLevel(lv, charged),
      onCharged: () => { this.ctx.audio.sfx('combo', { pitch: 1.5 }); this.ctx.bus.emit('charge', { level: 1, charged: true }); },
      onBlast: (o, d) => this._onBlast(o, d),
      onCancel: () => this._stopHum(),
    });
    this.poseOverlay = new PoseOverlay();   // two-hand push on every Breaklight (applied after motion.update)
    this.rec = new ReplayRecorder();
    this.replay = new ReplayPlayer({ rec: this.rec, getVisuals: () => ctx.visuals, ui: ctx.ui, audio: ctx.audio });
    this.state = 'boot'; this.prevState = null; this.stateT = 0;
    this.act = null; this.chart = null; this.boss = null;
    this.heroH = 1.6;
    this.paused = null;
    this.lastBeatInt = -1;
    this.notesAll = [];               // chart output buffer (drained into the field)
    this._prompt = null; this._auraLv = -1; this._hum = null;
    this._jump = { active: false, t0: 0, peak: 0, base: NaN };
    this._v = new THREE.Vector3(); this._sp = { x: 0, y: 0 };
    this.stats = { coreMs: 0 };
    this.awk = null;                  // Act 0 Awakening state
    this.fieldBeat = 0;               // beat the spirit field runs on (= clock beat outside the Awakening)
    this._dist = null; this._distCand = null; this._distCandT = 0; this._bigUntil = 0;
    this.seed = settings.dev.seed ?? ((Math.random() * 1e6) | 0);
    this._offs = [];
    this._offs.push(bus.on('overdrive', ({ on }) => this._onOverdrive(on)));
    this._offs.push(bus.on('knockdown', (d) => this._onKnockdown(d)));
    this._knee = { left: { armed: true, last: -1e9, up: false }, right: { armed: true, last: -1e9, up: false }, f: null };
    this.awkLog = [];                 // Awakening waits this run: { section, move, secs, how } (debug / playtest logging)
    // the UI's title / settings screens write settings.mode / seated / difficulty and announce it
    this._offs.push(bus.on('tutorial', (d) => { this._tutDrill = d?.phase === 'done' ? null : d?.drill ?? null; }));
    this._offs.push(bus.on('settings:change', ({ key, value } = {}) => {
      if (key === 'mode' || key === 'difficulty') this._applyMode();
      if (key === 'reduceFlashes') this.applyFlashSetting();
      if (key === 'kneeStrikes' && this.motion && 'kneeStrike' in this.motion.actions) this.motion.actions.kneeStrike = !!value;
      if (key === 'seated') {
        if (this.motion) this.motion.actions.seated = !!value;
        // the seated calibration (upper-body silhouette, seated height) only applies after re-calibrating
        if (this.state === 'title') this.setState('calibrate');
      }
    }));
  }

  /** Guarded call into the CV team's mirror (ctx.mirror may be absent). */
  _mirror(fn, ...args) {
    const m = this.ctx.mirror;
    if (!m || typeof m[fn] !== 'function') return undefined;
    try { return m[fn](...args); } catch (e) { if (!this._mirrorWarned) { this._mirrorWarned = true; console.warn('[game] mirror.' + fn, e); } return undefined; }
  }

  /** Mode / difficulty changed (between runs): the health economy follows. */
  _applyMode() {
    const S = this.ctx.settings;
    if (S.mode !== 'challenge') S.mode = 'showcase';
    if (!PLAY.has(this.state)) { this.score.setMode(S.mode, heartsFor(S)); this.score.reset(); }
    try { this.ctx.ui?.hud?.setMode?.(S.mode); } catch { /* */ }
  }

  /** Bind the motion pipeline (after the hero loads). */
  setMotion(motion) {
    this._actOff?.();
    this.motion = motion;
    motion.actions.seated = !!this.ctx.settings.seated; // seated duck rules (head drop vs seated height), no jumps/kicks
    if ('kneeStrike' in motion.actions) motion.actions.kneeStrike = !!this.ctx.settings.kneeStrikes;   // detector knee raises -> kick events
    this._actOff = motion.actions.on((name, info) => this._onAction(name, info));
  }
  setHero(hero) {
    this.hero = hero;
    this.heroH = hero.info?.height || 1.6;
    this.director.setHeroHeight(this.heroH);
    this.rec.setHero(hero);
  }
  setTrackerKind(kind) { this.judge.setTracker(kind); }

  /** Named cinematic shot from the CAMERA director ('blast' | 'bossIntro' | 'bossKill' | 'frontCut'); a no-op when the
   *  director does not know the shot yet. */
  cameraCut(name, dur, opts) {
    const d = this.director;
    try {
      const known = typeof d.hasShot === 'function' ? d.hasShot(name) : !!(d.shots?.[name] ?? cameraMod.SHOTS?.[name]);
      if (!known) return false;
      return d.cut(name, dur, opts) !== false;
    } catch (e) { console.warn('[game] camera cut', name, e); return false; }
  }

  /** For the director's automatic front cuts: seconds until the next required hit (Infinity if none within aheadSec).
   *  Uses the judge's note times, so it stays right while the Awakening lags the field behind the music. */
  upcomingHit(aheadSec = 4) {
    if (!PLAY.has(this.state)) return Infinity;
    if (this.awk?.waiting) return 0;                 // a spirit is waiting for the player: never cut away
    const now = this.clock.frameNow;
    let best = Infinity;
    const scan = (n) => {
      if (n.resolved || n.cancelled) return;
      const dt = this.judge.noteTime(n) - now;
      if (dt > -0.3 && dt < best) best = dt;
    };
    for (const n of this.field.live) scan(n);
    for (const n of this.field.pending) { if (n.spawnBeat > this.fieldBeat + 16) break; scan(n); }
    if (this.charge.level > 0 || this.charge.charged || this.field.brutePunchTarget()) best = 0;
    return best <= aheadSec ? Math.max(0, best) : Infinity;
  }

  // ======================================================================================== state machine
  setState(next, opts = {}) {
    const prev = this.state;
    if (prev !== next) this._exit(prev, next);
    this.prevState = prev; this.state = next; this.stateT = 0;
    this._enter(next, prev, opts);
    this.ctx.bus.emit('state', { from: prev, to: next });
    if (this.settingsDev?.debug) console.info(`[game] ${prev} -> ${next}`);
  }

  _exit(s, next) {
    const { ui } = this.ctx;
    if (s === 'results') { this.replay.stop(); this._replayDone(); this._resIntro = null; this._boothArmed = false; this.ctx.booth?.disarm?.(); this._mirror('setMode', 'off'); }
    if (s === 'title') { this._npBtn?.close(); this._npBtn = null; }
    if (s === 'space') { this._space?.close(); this._space = null; }
    if (s === 'calibrate') setTimeout(() => { if (this.ctx.mirror?.mode === 'calibrate' && this.state !== 'calibrate') this._mirror('setMode', 'off'); }, 1600);
    if (PLAY.has(s) && next !== 'pause') {
      this._breather = null; this._graceUntil = 0;
      this._stopHum(); this.charge.reset(); ui.hud.prompt(null); this._prompt = null; this._promptKey = null; this._promptWait = false;
      this._endAwaken(false);
      if (this._dist) { this._dist = null; ui.hud.distance(null); }
    }
  }

  _enter(s, prev, opts) {
    const { ui, audio, visuals, settings } = this.ctx;
    const V = visuals;
    switch (s) {
      case 'boot':
        this.director.setMode('title', { cut: true });
        V.stage.setAct('title');
        break;
      case 'calibrate':
        ui.hud.show(false);
        this.director.setMode('calibrate');
        V.stage.setAct('title');
        this.motion?.calibrate();
        this._mirror('setMode', 'calibrate');
        ui.screens.calibrate({
          recalibrate: true, seated: !!settings.seated,
          silhouetteCanvas: this.ctx.mirror?.canvas, silhouetteMirrored: true,
          onDone: (r = {}) => {                         // the UI re-calibrates the pipeline on success
            if (this.state !== 'calibrate') return;
            const m = this.ctx.mirror, cv = this.ctx.cv;
            if (m && cv && !r.skipped) {                // the neon silhouette pours into the hero
              try { Promise.resolve(m.pourInto(cv.heroScreenRect(this.hero.root ? this.hero : this.ctx.hero, this.ctx.camera, this.ctx.renderer.domElement))).catch(() => {}).finally(() => this._mirror('setMode', 'off')); } catch { this._mirror('setMode', 'off'); }
            } else this._mirror('setMode', 'off');
            this.setState('title');
          },
        });
        break;
      case 'title':
        ui.hud.show(false);
        this.director.setMode('title');
        V.stage.setAct('title');
        audio.playSong('title', { startBeat: this.clock.nextBar(1) });
        audio.setIntensity(0.2); audio.setOverdrive(false);
        V.vfx.aura(false, {});
        this.field.clear();
        V.boss.hide?.();
        this._placeEcho('title');
        this._titleHandle = ui.screens.title({
          onPlay: () => { audio.unlock(); this.play(); },
          onTutorial: () => { audio.unlock(); this.setState('tutorial'); },
          onSettings: () => this.setState('settings'),
          onNewPlayer: () => this.newPlayer(),
          mode: settings.mode,
          onMode: (m) => { settings.mode = m === 'challenge' ? 'challenge' : 'showcase'; settings.save?.(); this._applyMode(); },
          best: bestFor(settings),
          todayBest: todayBest(settings),
          kiosk: !!settings.kiosk,
          length: settings.length,
          tutorialLabel: flags.get('awakened') ? 'TRAINING' : 'TUTORIAL',
        });
        // NEW PLAYER (shared machine): the UI's title draws it when it knows onNewPlayer; else CORE's stand-in button
        try {
          const root = ui.root ?? document.body;
          if (!root.querySelector('[data-ui-button*="new" i], [data-ui-button*="player" i]')) this._npBtn = newPlayerButton(root, () => this.newPlayer());
        } catch { /* */ }
        this._idleT = 0;
        break;
      case 'settings':
        ui.screens.settings({
          settings,
          onChange: () => { try { audio.setVolume(audioVolume(settings)); if (settings.quality && this.ctx.quality.mode !== settings.quality) this.ctx.quality.setMode(settings.quality); } catch { /* */ } },
          onClose: () => { settings.save?.(); try { audio.setVolume(audioVolume(settings)); } catch { /* */ } this.score.setMode(settings.mode, heartsFor(settings)); this.setState('title'); },
        });
        break;
      case 'tutorial': {
        this.director.setMode('tutorial');
        const steps = TUTORIAL_STEPS.filter((x) => !(upperOnlyOf(settings) && x.lower) && !(settings.seated && x.id === 'duck'));
        this._tutDrill = null;
        this._tutorial = ui.screens.tutorial({ steps, onDone: () => { flags.set('tutorialDone'); this.setState('title'); } });
        break;
      }
      case 'space': {
        const done = ({ seated } = {}) => {
          flags.set('spaceChecked');
          if (!!seated !== !!settings.seated) { settings.seated = !!seated; settings.save?.(); }
          if (this.state === 'space') this.setState('run', opts);
        };
        ui.hud.show(false);
        const uiSpace = ui.screens.clearSpace ?? ui.screens.space;
        if (uiSpace && !ui.stub) this._space = { close() {}, handle: uiSpace({ seated: settings.seated, kiosk: !!settings.kiosk, onDone: (r = {}) => done({ seated: r.seated ?? settings.seated }) }) };
        else { ui.screens.hide(); this._space = spaceCheck(ui.root ?? document.body, { seated: settings.seated, onDone: done }); }
        break;
      }
      case 'run': {
        if (prev === 'pause') break;
        const dev = settings.dev;
        const act = opts.act ?? dev.act;
        const awaken = opts.awaken ?? (act == null && (dev.awaken === '1' || (dev.awaken !== '0' && !flags.get('awakened'))));
        this._startRun(act ?? 0, { awaken });
        break;
      }
      case 'boss':
        if (prev === 'pause') break;
        if (prev !== 'run') this._resetRun();
        this._startBoss();
        break;
      case 'results':
        this._startResults(opts);
        break;
      case 'pause':
        this._startPause(prev, opts.reason);
        break;
      default: break;
    }
  }

  // ======================================================================================== run / acts
  _resetRun() {
    const { ui, settings } = this.ctx;
    this.score.setMode(settings.mode, heartsFor(settings));
    this.score.reset(); this.score.emit();
    try { ui.hud.setMode?.(this.score.mode); } catch { /* */ }
    this.field.clear(); this.notesAll.length = 0;
    this.rec.clear(); this._kpRing = []; this._kpLast = null;
    this.judge.log.length = 0; this.judge.errHist.length = 0;
    ui.screens.hide();
    ui.hud.show(true);
    ui.hud.setHealth(this.score.health, this.score.maxHealth);
    ui.hud.setScore(0); ui.hud.setCombo(0, 1); ui.hud.setFlow(0, false);
    if (this.ctx.mirror?.mode === 'replay') this._mirror('setMode', 'off');
    this._mirror('record', true);
    this.ctx.booth?.disarm?.();
    this.charge.reset();
    this.boss = null;
    this.runStartPerf = performance.now();
  }

  /** PLAY from the title: the clear-space check first (once), then the run (with the Awakening on the first run). */
  play(opts = {}) {
    const { settings } = this.ctx;
    const needSpace = !flags.get('spaceChecked') && settings.dev.space !== '0' && !settings.dev.autoplay && this.tracking.kind !== 'demo';
    this.setState(needSpace ? 'space' : 'run', opts);
  }

  _startRun(act, { awaken = false } = {}) {
    const { audio } = this.ctx;
    this._fresh = false; this.awkLog = [];
    this._resetRun();
    this.director.setMode('gameplay');
    let start = this.clock.nextBar(2);
    const b0 = audio.playSong('run', { startBeat: start });     // AUDIO returns the transport beat of the song's beat 0
    if (Number.isFinite(b0) && b0 >= start && b0 - start < 16) start = b0;
    if (awaken) this._startAwaken(start);
    else this._startAct(act, start);
  }

  // ======================================================================================== Act 0: Awakening
  _startAwaken(startBeat) {
    const { ui, audio, visuals, bus, settings } = this.ctx;
    this.act = 'awaken';
    this.chart = null;
    visuals.stage.setAct(0);
    audio.setIntensity(0.25);
    const { notes, endBeat } = awakeningNotes(startBeat + 4, settings);
    for (const n of notes) this.field.add(n);
    this.awk = { startBeat, endBeat, offset: 0, waiting: null, waitSince: 0, sections: new Set(), lastNote: notes[notes.length - 1], doneAt: null, assisted: [] };
    this.judge.beatOffset = 0;
    this._bannerAt = startBeat; this._bannerText = [AWAKEN.name, AWAKEN.sub];
    // SKIP INTRO: the UI shows its hand-cursor button from bus 'awaken' {phase:'start'} (right edge, long dwell, hand
    // target once a spirit waits); the stand-in UI gets CORE's (2 s dwell, never by a punch, right edge, upper third)
    if (ui.stub) { try { this._skipBtn = skipButton(ui.root ?? document.body, () => this.skipAwaken()); } catch { /* */ } }
    bus.emit('act', { act: 'awaken' });
    bus.emit('awaken', { phase: 'start' });
  }

  /** Awakening wait cap reached: drop the remaining lessons, a friendly banner, Act 1 on the next bars. */
  _capAwaken() {
    const { ui, bus } = this.ctx;
    const log = this.awkLog;
    this._endAwaken(true);
    this.field.clear();
    try { ui.hud.banner("LET'S JUMP IN!", "You'll pick up the rest as you play", { priority: 'warning', duration: 2.4, warn: false }); } catch { /* */ }
    this._startAct(0, this.clock.nextBar(2));
    bus.emit('awaken', { phase: 'capped', assisted: log.filter((e) => e.how === 'assist').length });
    console.info('[game] awakening capped after', AWAKEN_AUTO_CAP, 'auto-advances');
  }

  /** Skip the Awakening (button / Esc): straight into Act 1 on the next bar. */
  skipAwaken() {
    if (!this.awk || this.state !== 'run') return;
    this._endAwaken(true);
    this.field.clear();
    this._startAct(0, this.clock.nextBar(2));
  }

  _endAwaken(completed) {
    if (!this.awk) return;
    const A = this.awk;
    if (A.waiting && !A.waiting.resolved) this._logWait(A.waiting, 'quit');
    this.awk = null;
    this.judge.beatOffset = 0;
    this._skipBtn?.close(); this._skipBtn = null;
    flags.set('awakened');
    if (this._promptKey) { this._prompt = null; this._promptKey = null; this._promptWait = false; this.ctx.ui.hud.prompt(null); }
    this.ctx.bus.emit('awaken', { phase: 'end', completed });
  }

  /** Earliest unresolved wait note (live or pending), or null. */
  _nextWait() {
    let w = null;
    for (const n of this.field.live) if (n.waitFor && !n.resolved && (!w || n.beat < w.beat)) w = n;
    for (const n of this.field.pending) { if (n.waitFor && (!w || n.beat < w.beat)) w = n; if (w && n.spawnBeat > w.beat) break; }
    return w;
  }

  /** Per frame: the virtual field beat, the wait hold and its held-state checks. Returns the field beat. */
  _updateAwaken(beat) {
    const A = this.awk;
    const { audio, ui } = this.ctx;
    if (A.waiting && A.waiting.resolved) {               // released: round the lag up to whole bars (back on the downbeat)
      this._logWait(A.waiting, A.waiting.assisted ? 'assist' : A.looseFor === A.waiting ? 'loose' : 'hit');
      this.ctx.bus.emit('awaken', { phase: 'resolved', move: A.waiting.move, note: A.waiting });
      const rem = A.offset % 4;                         // answered at tempo (tiny lag): snap back instead of losing a bar
      A.offset = rem < 0.75 ? A.offset - rem : Math.ceil(A.offset / 4 - 1e-6) * 4;
      A.waiting = null;
      audio.setIntensity(0.3);
    }
    if (A.capAt && performance.now() >= A.capAt && !A.waiting) { this._capAwaken(); return beat; }
    let vb = beat - A.offset;
    const w = this._nextWait();
    if (w) {
      const hold = w.type === 'core' ? w.beat + 0.05 : w.beat - 0.03;
      if (vb >= hold) {
        vb = hold; A.offset = beat - hold;
        if (A.waiting !== w) { A.waiting = w; A.waitSince = performance.now(); audio.setIntensity(0.12); this.ctx.bus.emit('awaken', { phase: 'wait', note: w }); }
      }
    }
    this.judge.beatOffset = A.offset;
    // held moves while a spirit waits: the detector's live state (the same detector as gameplay)
    const W = A.waiting, st = this.motion?.actions?.state;
    if (W && st && !W.resolved) {
      if (W.move === 'squat' && st.squat) this.field.resolve(W, 'perfect', 0, 'hit');
      else if (W.move === 'dodge' && (W.side === 'left' ? st.leanRight || st.stepRight : st.leanLeft || st.stepLeft)) this.field.resolve(W, 'perfect', 0, 'hit');
      else if (W.move === 'guard' && W.phase === 'fly' && st.guard) { W.phase = 'punch'; W.blockKind = 'perfect'; W.blockErr = 0; this._onBlock(W, 'perfect', 0); }
    }
    if (W && !W.resolved) this._escalateWait(W, A, st ?? {});
    // section hints (once per section, when its first spirit appears)
    for (const n of this.field.live) {
      if (n.section && !A.sections.has(n.section)) { A.sections.add(n.section); this.ctx.bus.emit('awaken', { phase: 'section', section: n.section, hint: AWAKEN_HINT[n.section] }); }
    }
    // done: the finale core is resolved -> Act 1 on the next bar line, its banner right away over the blast's tail
    // (no dead air: QA r2 art P2-7)
    if (!A.waiting && A.lastNote.resolved) {
      A.doneAt ??= beat;
      if (beat > A.doneAt + 1.5) {
        this._endAwaken(true);
        this._startAct(0, this.clock.nextBar(1));
        this._bannerAt = beat;
        return beat;
      }
    }
    return vb;
  }

  /** Coach (5 s) -> accept a looser move (10 s) -> resolve as Good and move on (15 s). */
  _escalateWait(W, A, st) {
    const { bus } = this.ctx;
    const el = (performance.now() - A.waitSince) / 1000;
    const phaseKey = `${W.move}:${W.phase ?? ''}`;              // the brute's fly -> punch phase re-coaches
    if (el >= COACH_S) {
      const hint = this._coachHint(W, st);
      if (A.coachFor !== W || A.coachPhase !== phaseKey) {
        A.coachFor = W; A.coachPhase = phaseKey;
        const move = W.move === 'guard' && W.phase === 'punch' ? 'punch' : W.move;
        if (A.looseFor !== W) bus.emit('awaken', { phase: 'coach', move, type: W.type, side: W.side, section: W.section, hint, note: W });
      }
      A.coach = hint;
    }
    if (el >= LOOSE_S) {
      if (A.looseFor !== W || A.loosePhase !== phaseKey) {
        A.looseFor = W; A.loosePhase = phaseKey;
        const lk = looseKey(W), move = lk === 'brutePunch' ? 'punch' : W.move;
        bus.emit('awaken', { phase: 'loose', move, type: W.type, section: W.section, hint: LOOSE_HINT[lk], text: LOOSE_HINT[lk], note: W });
      }
      this._looseCheck(W, st);
    }
    if (!W.resolved && el >= AUTO_S) this._assistWait(W);
  }

  /** Move-specific coaching from the detector's live state (prompt sub-line + bus 'awaken' {phase:'coach'}). */
  _coachHint(W, st) {
    const S = this.ctx.settings, f = this.tracking.lastFrame, c = f?.conf ?? {};
    const seen = (k) => f?.joints?.[k] && (c[k] == null || c[k] >= 0.4);
    switch (W.move) {
      case 'punch': return (this.awk?.wrongTries ?? 0) > 0 ? `Use your ${W.side === 'left' ? 'LEFT' : 'RIGHT'} hand: snap it at the screen`
        : 'Snap your fist straight at the screen, then pull it back';
      case 'kick':
        if (!seen('leftAnkle') || !seen('rightAnkle')) return 'Step back so your feet are in view';
        return S.kneeStrikes ? 'Drive your knee up to hip height' : 'Lift your knee higher, then snap your foot forward';
      case 'squat': return 'Drop fast: bend your knees, head down';
      case 'dodge': return `Lean your whole upper body to the ${W.side === 'left' ? 'RIGHT' : 'LEFT'}, or step`;
      case 'guard': return W.phase === 'punch' ? 'Now punch it: any hand, 3 times' : 'Both fists up beside your face';
      case 'jump': return 'Both feet off the floor: a small hop is enough';
      case 'blast': {
        const hu = this.motion?.actions?.handsUpConfidence ?? 0;
        if (this.charge.charged) return 'Now PUSH both hands forward, fast!';
        if (this.charge.level > 0) return 'Keep them up… the aura is charging';
        return hu < 0.35 ? 'Elbows above your shoulders, hands high' : 'Hold both hands up for a second';
      }
      default: return AWAKEN_HINT[W.section] ?? '';
    }
  }

  /** After LOOSE_S: a looser version of the waiting move is enough (held states; impulses go through _onAction). */
  _looseCheck(W, st) {
    if (W.resolved) return;
    const J = this._jump, f = this.tracking.lastFrame?.joints;
    const hipY = f?.leftHip && f?.rightHip ? (f.leftHip.y + f.rightHip.y) * 0.5 : NaN;
    const drop = Number.isFinite(J.base) && Number.isFinite(hipY) ? J.base - hipY : 0;
    switch (W.move) {
      case 'squat': if (st.squat || st.duck || drop > 0.06 * (this.heroH / 1.6)) this.field.resolve(W, 'good', 0, 'loose'); break;
      case 'dodge': if (st.leanLeft || st.leanRight || st.stepLeft || st.stepRight) this.field.resolve(W, 'good', 0, 'loose'); break;
      case 'jump': if (st.jump || drop < -0.04) this.field.resolve(W, 'good', 0, 'loose'); break;
      case 'kick': if (st.kickLeft || st.kickRight || this._knee.left.up || this._knee.right.up) this.field.resolve(W, 'good', 0, 'loose'); break;
      case 'guard':
        if (W.phase === 'fly' && (st.guard || st.handsUp)) { W.phase = 'punch'; W.blockKind = 'good'; W.blockErr = 0; this._onBlock(W, 'good', 0); }
        break;
      case 'blast': if (st.handsUp || this.charge.level > 0.3 || this.charge.charged) this._assistBlast(); break;
      default: break;
    }
  }

  /** After AUTO_S: resolve the waiting spirit as Good and keep going (the core still gets its blast payoff). */
  _assistWait(W) {
    W.assisted = true;
    this._flashPrompt("LET'S KEEP GOING!", 1400);
    this.awk?.assisted.push(W.section);
    // cap the total waiting (QA r3 design P2-2): after AWAKEN_AUTO_CAP auto-advances, skip the remaining lessons
    if (this.awk && this.awk.assisted.length >= AWAKEN_AUTO_CAP && W !== this.awk.lastNote && !this.awk.capAt) this.awk.capAt = performance.now() + 1100;
    this.ctx.bus.emit('awaken', { phase: 'auto', move: W.move, type: W.type, section: W.section, note: W, text: "LET'S KEEP GOING!" });
    if (W.move === 'blast') { this._assistBlast(); if (W.resolved) return; }
    this.field.resolve(W, 'good', 0, 'assist');
  }
  /** Fire the Breaklight for the player (the waiting core): the same blast path as a real push. */
  _assistBlast() {
    const k = this.heroH / 1.6;
    this._onBlast(new THREE.Vector3(0, 1.3 * k, 0.35), new THREE.Vector3(0, 0, 1));
  }
  _logWait(W, how) {
    const secs = this.awk?.waitSince ? (performance.now() - this.awk.waitSince) / 1000 : 0;
    const e = { section: W.section, move: W.move, secs: +secs.toFixed(1), how };
    this.awkLog.push(e);
    if (this.ctx.settings.dev.debug || secs > COACH_S) console.info('[game] awakening wait', JSON.stringify(e));
  }

  _startAct(act, startBeat) {
    const { ui, audio, visuals, bus } = this.ctx;
    // ?act= / setState('run', { act }) may hand a string or an out-of-range act ("1" + 1 = "11", act=3, act=boss):
    // a number in 0..ACTS.length-1, else straight to the boss (past the last act) or Act 1
    act = Number.parseInt(act, 10);
    if (!ACTS[act]) {
      if (act >= ACTS.length) { console.warn('[game] act out of range -> boss'); this.act = ACTS.length - 1; this.chart = null; this._startBreather(this.clock.frameBeat); return; }
      act = 0;
    }
    this.act = act;
    this.chart = new ActChart({ act, startBeat, settings: this.ctx.settings, seed: this.seed, out: this.notesAll });
    visuals.stage.setAct(act);
    audio.setIntensity(0.35 + act * 0.3);
    const A = ACTS[act];
    this._bannerAt = startBeat; this._bannerText = [A.name, A.sub];
    this._placeEcho('run');
    bus.emit('act', { act });
  }

  _updateRun(dt, beat) {
    if (this._bannerAt != null && beat >= this._bannerAt - 0.05) {
      this.ctx.ui.hud.banner(...this._bannerText); this._bannerAt = null;
    }
    if (this.awk) { this.fieldBeat = this._updateAwaken(beat); return; }
    this.fieldBeat = beat;
    if (this._breather) {                               // calm before the boss: banner, groove, a hero close-up
      if (beat >= this._breather.until) { this._breather = null; this.setState('boss'); }
      return;
    }
    const ch = this.chart;
    if (!ch) return;
    ch.update(beat, this.score.skill);
    this._drainNotes();
    const actOver = ch.done && beat > ch.lastBeat + 1.5 && !this.field.pending.length && !this.field.nextLive();
    if (actOver) {
      if (this.act < 2) this._startAct(this.act + 1, this.clock.nextBar(2));
      else this._startBreather(beat);
    }
  }

  /** QA r2 P1-4 / P2-9: BREATHER_BEATS of calm before the boss (no notes), a banner and a front glamour cut. */
  _startBreather(beat) {
    const { ui, audio, bus } = this.ctx;
    this._breather = { until: beat + BREATHER_BEATS };
    this.chart = null;
    audio.setIntensity(0.3);
    try { ui.hud.banner('BREATHE', 'The Warden is waking…'); } catch { /* */ }
    this.cameraCut('frontCut', Math.min(3, BREATHER_BEATS * this.clock.beatDur * 0.6), { variant: 1 });
    bus.emit('breather', { beats: BREATHER_BEATS });
  }

  _drainNotes() {
    while (this.notesAll.length) this.field.add(this.notesAll.shift());
  }

  // ======================================================================================== boss
  _startBoss() {
    const { ui, audio, visuals, bus } = this.ctx;
    this.act = 'boss';
    this.chart = null;
    visuals.stage.setAct('boss');
    visuals.boss.show?.();
    let start = this.clock.nextBar(2);
    const b0 = audio.playSong('boss', { startBeat: start });
    if (Number.isFinite(b0) && b0 >= start && b0 - start < 16) start = b0;
    audio.setIntensity(1);
    audio.sfx('bossRoar');
    ui.hud.banner('WARNING', 'ECLIPSE WARDEN');
    this.director.setMode('boss');
    this.cameraCut('bossIntro');
    this._placeEcho('boss');
    const S = this.ctx.settings;
    this.boss = new BossScript({
      view: visuals.boss, field: this.field, startBeat: start, upperBodyOnly: upperOnlyOf(S), seated: !!S.seated,
      canRetreat: this.score.mode === 'challenge', capS: 100, beatDur: this.clock.beatDur,
      cb: {
        onPhase: (phase, info) => {
          bus.emit('boss', { phase, hp: info?.hp, stage: info?.stage, name: info?.name, tries: info?.tries });
          if (phase === 'weak') { if (!info?.tries) ui.hud.banner('WEAK POINT!', 'Charge your Breaklight'); else ui.hud.banner('WEAK POINT!', 'Open longer: charge now!'); }
          else if (phase === 'phase') ui.hud.banner(`PHASE ${info.stage + 1}`, info.name);
          else if (phase === 'missed') ui.hud.banner('IT CLOSED…', 'The Warden attacks again');
        },
        onDefeat: () => {
          this.bloom(BLOOM.kill, 1.2); audio.sfx('victory'); ui.hud.banner('WARDEN DEFEATED');
          this.score.bossDefeated = true; this.score.addBonus(5000);
          this._bossKill = true;
          this.rec.pin(this.clock.frameNow, { before: 1.5, after: 1.4, label: 'WARDEN DEFEATED' });
        },
        onRetreat: () => { ui.hud.banner('THE WARDEN RETREATS'); },
      },
    });
    bus.emit('act', { act: 'boss' });
  }

  _updateBoss(dt, beat) {
    const b = this.boss;
    if (!b) return;
    b.update(dt, beat);
    this.fieldBeat = beat;
    if ((b.phase === 'defeat' && beat > b.endBeat) || b.phase === 'retreat') {
      if (!this._bossEndAt) this._bossEndAt = performance.now();
      if (performance.now() - this._bossEndAt > (b.phase === 'retreat' ? 1500 : 0)) { this._bossEndAt = 0; this.setState('results', { cleared: b.phase === 'defeat' || !this.score.failed }); }
    }
  }

  // ======================================================================================== results + replay
  // Results flow: (1) a full-screen letterboxed replay of the run's best moment (the boss kill when there was one),
  // announced on the bus ('replay' {phase:'start'|'progress'|'end'}), then (2) the stats screen. Esc / Enter / click
  // (game.skipReplay()) jumps straight to the stats.
  _startResults({ cleared = !this.score.failed } = {}) {
    const { ui, audio, visuals, settings } = this.ctx;
    this.field.clear();
    visuals.boss.hide?.();
    visuals.vfx.aura(false, {});
    visuals.stage.setAct('results');
    ui.hud.show(false);
    ui.screens.hide();
    audio.setOverdrive(false);
    audio.playSong('results', { startBeat: this.clock.nextBar(1) });
    audio.sfx(cleared ? 'victory' : 'defeat');
    this.score.setOverdrive(false);
    const stats = this.score.results({ cleared });
    const e = this.judge.errHist;
    if (e.length >= 6) { const m = e.reduce((x, y) => x + y, 0) / e.length; stats.body.timingSdMs = Math.sqrt(e.reduce((x, y) => x + (y - m) ** 2, 0) / e.length); }
    const best = submitBest(settings, stats.score);
    stats.newBest = best.isNew; stats.best = best.best; stats.previousBest = best.previous; stats.prevBest = best.previous;
    stats.todayBest = best.today; stats.newToday = best.newToday; stats.kiosk = !!settings.kiosk; stats.length = settings.length;
    stats.awakening = this.awkLog.length ? this.awkLog.slice() : null;
    this._resIdleT = 0;
    this.lastResults = stats;
    this.director.setMode('results');
    this._placeEcho('results');
    this.replayWin = this.rec.pick(this.score.events, REPLAY_WIN);
    stats.replay = this.replayWin ? { seconds: +(this.replayWin.t1 - this.replayWin.t0).toFixed(2), hits: this.replayWin.hits, speed: REPLAY_SPEED, label: this.replayWin.label, bossKill: !!this.replayWin.pinned } : null;
    this._resIntro = { shown: false };
    this._replayAt = 0;
    // the real UI's results screen runs its own letterboxed replay phase from the bus events: show it first; the
    // stand-in UI gets CORE's fallback letterbox and the stats after the replay
    if (!ui.stub) this._showResultsScreen();
    if (!this.replayWin || !this.hero || !this._playReplay({ intro: true })) { this._showResultsScreen(); this._armBooth(); }
    console.info('[game] results', JSON.stringify({ score: stats.score, rank: stats.rank, judgements: stats.judgements, maxCombo: stats.maxCombo, body: stats.body, newBest: stats.newBest, replay: stats.replay, knockdowns: stats.knockdowns, playTime: Math.round(stats.playTime), awakening: stats.awakening, kiosk: stats.kiosk, length: stats.length }));
  }

  _showResultsScreen() {
    const R = this._resIntro;
    if (!R || R.shown || this.state !== 'results') return;
    R.shown = true;
    const { ui, audio } = this.ctx;
    this._resHandle = ui.screens.results({
      stats: this.lastResults,
      onReplay: this.replayWin ? () => this._playReplay() : undefined,
      onAgain: () => { audio.unlock(); this.setState('run', { act: 0 }); },
      onTitle: () => (this.ctx.settings.kiosk ? this.newPlayer() : this.setState('title')),
      onSkipReplay: () => this.skipReplay(),
    });
  }

  /**
   * Photo Booth (QA r2 P1-5): armed only once the results replay is over (never over it), only after a cleared run,
   * and only with a real camera (skipped for autoplay / the demo player: there is nobody to photograph).
   */
  _armBooth() {
    if (this._boothArmed || this.state !== 'results' || this.replay.active) return;
    const booth = this.ctx.booth, h = this._resHandle;
    const T = this.tracking;
    const realCam = !!T.camera?.active && (T.kind === 'hmr' || T.kind === 'mediapipe');
    if (booth && h && this.lastResults?.cleared && !this.ctx.settings.dev.autoplay && realCam) {
      this._boothArmed = true;
      try {
        h?.setPhotoCard?.({ pending: true });
        Promise.resolve(booth.arm({ timeoutMs: 15000 })).then((r) => {
          if (this.state === 'results' && r && (r.dataURL || booth.card)) h?.setPhotoCard?.({ node: booth.card, caption: 'BREAKLIGHT · SAVE PNG' });
          else h?.setPhotoCard?.(null);
        }).catch(() => { try { h?.setPhotoCard?.(null); } catch { /* */ } });
      } catch (e) { console.warn('[game] photo booth', e); }
    }
  }

  /** Results: skip the intro replay (key / click) straight to the stats. */
  skipReplay() {
    if (this.state !== 'results' || !this.replay.active) return;
    this.replay.stop();
    this._replayDone();
  }

  _playReplay({ intro = false } = {}) {
    if (!this.replayWin || !this.hero) return false;
    const { bus } = this.ctx;
    const clip = this.replayWin;
    const ok = this.replay.start(clip, {
      speed: REPLAY_SPEED,
      onEnd: () => this._replayDone(),
      onProgress: (p) => {
        this._lbox?.progress(p);
        if (this._mirrorReplay) this._mirror('setReplayTime', this.clock.toPerf(this.replay.t));
        bus.emit('replay', { phase: 'progress', on: true, progress: p, intro });
      },
    });
    if (!ok) return false;
    if (this.motion) this.motion.options.apply = false;
    try { this.ctx.booth?.setBlocked?.(true); } catch { /* */ }          // a booth armed earlier never plays over a replay
    this.director.setMode('replay', { cut: true });
    // CORE owns the boss-kill replay framing (VISUAL's own call then only extends the same shot)
    if (clip.pinned) this.cameraCut('replayKill', ReplayPlayer.duration(clip, REPLAY_SPEED) + 0.5, { killAt: clip.pinT != null ? (clip.pinT - clip.t0) / Math.max(0.01, clip.t1 - clip.t0) : 0.52 });
    if (intro && !this._resIntro?.shown) this.ctx.ui.screens.hide();
    this._replayIntro = intro;
    this._lbox?.close(); this._lbox = null;
    // the player's own neon silhouette, locked to the 3D replay ("YOU · 0.35x"; the song->perf map is the live clock's)
    this._mirrorReplay = !!this._mirror('playReplay', { from: this.clock.toPerf(clip.t0), to: this.clock.toPerf(clip.t1), rate: REPLAY_SPEED });
    if (this._mirrorReplay && this.ctx.mirror?.canvas && !this.ctx.ui.replayOverlay) { try { this._inset?.close(); this._inset = mirrorInset(this.ctx.ui.root ?? document.body, this.ctx.mirror.canvas, `YOU · ${REPLAY_SPEED}×`); } catch { /* */ } }
    if (this.ctx.ui.stub && !this.ctx.ui.replayOverlay) { try { this._lbox = letterbox(this.ctx.ui.root ?? document.body, { label: clip.label || 'BEST MOMENT', speed: REPLAY_SPEED }); } catch { /* */ } }
    const kpR = this._kpRing;
    const skeleton = !this._mirrorReplay && !!kpR?.length && kpR[0].t <= clip.t1 && kpR[kpR.length - 1].t >= clip.t0;
    bus.emit('replay', {
      phase: 'start', on: true, intro, window: clip, label: clip.label || 'BEST MOMENT', speed: REPLAY_SPEED,
      seconds: ReplayPlayer.duration(clip, REPLAY_SPEED), bossKill: !!clip.pinned, letterbox: true,
      silhouette: !!this._mirrorReplay, skeleton,
    });
    this.replayCount = (this.replayCount || 0) + 1;
    return true;
  }
  _replayDone() {
    if (this.motion) this.motion.options.apply = true;
    if (this.director.shot === 'replayKill' || this.director.shot === 'bossKill') this.director.endShot();
    try { if (this.ctx.booth?.blocked) this.ctx.booth.setBlocked(false); } catch { /* */ }
    if (this.state === 'results') this.director.setMode('results');
    const intro = this._replayIntro; this._replayIntro = false;
    this._lbox?.close(); this._lbox = null;
    this._inset?.close(); this._inset = null;
    this.ctx.bus.emit('replay', { phase: 'end', on: false, intro });
    if (intro) { this._showResultsScreen(); this._armBooth(); }
  }

  // ======================================================================================== pause
  _startPause(prev, reason) {
    const { ui, audio } = this.ctx;
    const manual = reason === 'manual';
    this.paused = { from: prev, beat: this.clock.frameBeat, back: 0, countdown: -1, song: prev === 'boss' ? 'boss' : 'run', manual, reason, absent: 0, abandonShown: false };
    this.field.paused = true;
    audio.stopSong({ fadeMs: 400 });
    this._stopHum(); this.charge.reset();
    ui.hud.prompt(null); this._prompt = null; this._promptKey = null; this._promptWait = false;
    this._showPause();
    this.ctx.bus.emit('pause', {});
  }
  _showPause() {
    const p = this.paused;
    p.abandonShown = false;
    this._pauseHandle = this.ctx.ui.screens.pause({
      reason: p.manual ? 'Paused' : p.reason || 'tracking-lost',
      onResume: () => { if (this.paused && this.paused.countdown < 0) { this.paused.manual = false; this._startCountdown(); } },
      onQuit: () => this.quitPause(),
      onNewPlayer: this.kiosk ? () => this.newPlayer() : undefined,
    });
  }
  /** Leave a paused run for the title (the run's exit clean-up runs as if leaving 'run'). */
  quitPause() {
    if (this.state !== 'pause') return;
    this.paused = null; this.field.paused = false; this._pauseHandle = null;
    this.state = 'run'; this.setState('title');
  }
  _startCountdown() {
    const p = this.paused;
    p.countdown = 3; p.cdT = 0; this.ctx.ui.screens.countdown(3); this.ctx.audio.sfx('countdown', { pitch: 1 });
  }
  _updatePause(dt) {
    const p = this.paused;
    const present = this.tracking.lostFor < 0.25;
    // abandoned run (QA r3 design P1-1): nobody tracked for a while -> "Still there?" countdown -> quit (kiosk: the
    // next player gets a fresh start: notice, calibration, Awakening, clear-space)
    p.absent = present ? 0 : p.absent + dt;
    const AB = this.kiosk ? ABANDON.kiosk : ABANDON.home;
    const warn = p.countdown < 0 && p.absent >= AB.warn;
    if (warn || p.abandonShown) {
      p.abandonShown = warn;
      try { this._pauseHandle?.setAbandon?.(warn ? AB.quit - p.absent : null, { kiosk: this.kiosk }); } catch { /* */ }
    }
    if (p.countdown < 0 && p.absent >= AB.quit) {
      console.info('[game] abandoned run:', Math.round(p.absent), 's with nobody tracked ->', this.kiosk ? 'new player' : 'title');
      if (this.kiosk) this.newPlayer(); else this.quitPause();
      return;
    }
    if (p.countdown < 0) {
      if (p.manual) return;                                // waits for onResume (button / hand cursor)
      p.back = present ? p.back + dt : 0;
      if (p.back > 0.8) this._startCountdown();
      return;
    }
    if (!present && this.tracking.lostFor > LOST_PAUSE_S) { p.countdown = -1; p.back = 0; p.reason = 'tracking-lost'; this._showPause(); return; }
    p.cdT += dt;
    if (p.cdT >= 0.8) {
      p.cdT = 0; p.countdown--;
      this.ctx.ui.screens.countdown(p.countdown);
      this.ctx.audio.sfx(p.countdown > 0 ? 'countdown' : 'go');
      if (p.countdown <= 0) this._resume();
    }
  }
  _resume() {
    const p = this.paused;
    const { audio, ui } = this.ctx;
    let resumeBar = this.clock.nextBar(1);
    const b0 = audio.playSong(p.song, { startBeat: resumeBar });
    if (Number.isFinite(b0) && b0 >= resumeBar && b0 - resumeBar < 16) resumeBar = b0;
    const shift = Math.ceil((resumeBar + 2 - p.beat) / 4) * 4;
    this.field.shift(shift);
    if (this.chart) { this.chart.startBeat += shift; this.chart.endBeat += shift; this.chart.cursor += shift; if (this.chart.last) this.chart.last = { ...this.chart.last, beat: this.chart.last.beat + shift }; }
    if (this.boss) { if (this.boss.shift) this.boss.shift(shift); else { this.boss.start += shift; this.boss.endBeat += shift; } }
    if (this.awk) { this.awk.startBeat += shift; this.awk.endBeat += shift; if (this.awk.waiting) this.awk.waitSince = performance.now(); if (this.awk.doneAt != null) this.awk.doneAt += shift; }
    if (this._bannerAt != null) this._bannerAt += shift;
    if (this._breather) this._breather.until += shift;
    if (this._graceUntil) this._graceUntil += shift;
    this.field.paused = false;
    ui.screens.hide();
    const from = p.from;
    this.paused = null;
    this.state = from; this.prevState = 'pause';
    this.ctx.bus.emit('resume', {});
    this.ctx.bus.emit('state', { from: 'pause', to: from });
  }

  /**
   * Brief bloom bump (blast, perfects, boss defeat); decays back to the preset's base intensity. Capped (FLASH_CAP,
   * FLASH_CAP_REDUCED with settings.reduceFlashes) and clamped harder while a blast / kill / replay shot is on screen,
   * where the bloom threshold is also raised so the beam and the defeat never white the frame out.
   */
  bloom(amount, dur = 0.35) {
    const b = this.ctx.post?.effects?.bloom;
    if (!b) return;
    this._bloomBase ??= b.intensity;
    const cap = this.ctx.settings.reduceFlashes ? FLASH_CAP_REDUCED : FLASH_CAP;
    this._bloomAdd = Math.min(cap, Math.max(this._bloomAdd || 0, amount)); this._bloomDur = dur;
  }
  _updateBloom(dt) {
    const b = this.ctx.post?.effects?.bloom;
    if (!b) return;
    this._bloomBase ??= b.intensity;
    const cine = CINE_SHOTS.has(this.director.shot);
    const lm = b.luminanceMaterial;
    if (lm && 'threshold' in lm) {
      this._lumBase ??= lm.threshold;
      const want = cine || this.ctx.settings.reduceFlashes ? Math.max(this._lumBase, 0.97) : this._lumBase;
      if (Math.abs(lm.threshold - want) > 1e-3) lm.threshold += (want - lm.threshold) * Math.min(1, dt * 12);
    }
    if (this._bloomAdd) this._bloomAdd = Math.max(0, this._bloomAdd - dt * (this._bloomAdd / Math.max(0.05, this._bloomDur)) * 1.2 - dt * 0.05);
    const cap = this.ctx.settings.reduceFlashes ? FLASH_CAP_REDUCED : cine ? FLASH_CAP_CINE : FLASH_CAP;
    const want = this._bloomBase + Math.min(cap, this._bloomAdd || 0);
    if (Math.abs(b.intensity - want) > 1e-4) b.intensity = want;
    // exposure stays the pipeline's (nothing should pump it during cinematics)
    const r = this.ctx.renderer;
    this._expBase ??= r.toneMappingExposure;
    if (cine && r.toneMappingExposure !== this._expBase) r.toneMappingExposure = this._expBase;
  }

  /** Photosensitivity: cap flashes everywhere (bloom here; fx impact flashes; VISUAL / CV read settings.reduceFlashes). */
  setReduceFlashes(on) {
    const S = this.ctx.settings;
    S.reduceFlashes = !!on;
    S.save?.();
    this.applyFlashSetting();
    this.ctx.bus.emit('settings:change', { key: 'reduceFlashes', value: S.reduceFlashes });
  }
  applyFlashSetting() {
    const fx = this.ctx.fx, on = !!this.ctx.settings.reduceFlashes;
    if (fx?.options) { fx.options.flash = !on; this._shake0 ??= fx.options.shakeScale ?? 1; fx.options.shakeScale = on ? Math.min(this._shake0, 0.6) : this._shake0; }
    try { this.ctx.booth?.setReduceFlash?.(on); } catch { /* */ }
  }
  get kiosk() { return !!this.ctx.settings.kiosk; }

  /**
   * Photosensitivity / flash notice (first boot; every new player in kiosk mode): the UI's screens.flashNotice when it
   * exists, else CORE's stand-in card. Resolves when dismissed (OK / auto-continue). Skipped for autoplay / ?notice=0.
   */
  flashNotice() {
    const S = this.ctx.settings, ui = this.ctx.ui;
    if (flags.get('flashNotice') || S.dev.notice === '0' || S.dev.autoplay) return Promise.resolve(false);
    return new Promise((resolve) => {
      let close = () => {};
      const done = (r = {}) => {
        if (done.d) return; done.d = true;
        flags.set('flashNotice');
        if (r && typeof r.reduceFlashes === 'boolean' && r.reduceFlashes !== !!S.reduceFlashes) this.setReduceFlashes(r.reduceFlashes);
        try { close(); } catch { /* */ }
        this.ctx.bus.emit('notice', { phase: 'done', reduceFlashes: !!S.reduceFlashes });
        resolve(true);
      };
      // UI: screens.flashNotice({ onDone({ reduceFlashes }), onReduce(on), reduce }) (its toggle writes the setting and
      // emits settings:change); CORE's stand-in takes onToggle / reduceFlashes / autoContinueS
      const o = { reduce: !!S.reduceFlashes, reduceFlashes: !!S.reduceFlashes, onReduce: () => this.applyFlashSetting(), onToggle: (v) => this.setReduceFlashes(v), onDone: done, autoContinueS: 12 };
      try {
        if (typeof ui.screens.flashNotice === 'function' && !ui.stub) ui.screens.flashNotice(o);
        else { const h = flashNotice(ui.root ?? document.body, o); close = h.close; }
      } catch (e) { console.warn('[game] flash notice', e); done(); }
      this.ctx.bus.emit('notice', { phase: 'show' });
    });
  }

  /**
   * NEW PLAYER (shared machine, QA r2 P0-2): Showcase, standing, full body, the Awakening + clear-space check + flash
   * notice on again, this player's session best cleared; then the flash notice (kiosk) and a fresh calibration.
   */
  async newPlayer({ recalibrate = true } = {}) {
    const S = this.ctx.settings, { bus } = this.ctx;
    if (PLAY.has(this.state)) return;
    if (this.state === 'pause') this.quitPause();      // abandoned run / NEW PLAYER on the pause screen
    S.mode = 'showcase'; S.seated = false; S.upperBodyOnly = false;
    S.save?.();
    flags.resetPlayer(); resetPlayerBest();
    if (this.motion) this.motion.actions.seated = false;
    this.lastResults = null; this.replayCount = 0; this.awkLog = [];
    this._applyMode();
    this._fresh = true;
    bus.emit('newPlayer', { kiosk: !!S.kiosk });
    bus.emit('settings:change', { key: 'mode', value: 'showcase', newPlayer: true });
    if (!recalibrate) { if (this.state === 'title') this.setState('title'); return; }
    if (this.state !== 'title') this.setState('title');
    await this.flashNotice();                         // the notice is per player too
    if (this.state === 'title') this.setState('calibrate');
  }

  /** Echo placement per game state: CV's preset when it has one, else ECHO_PLACE (never over the Warden / rift). */
  _placeEcho(kind) {
    const m = this.ctx.mirror;
    if (!m) return;
    if (typeof m.setEchoPreset === 'function') { this._mirror('setEchoPreset', kind); return; }
    const e = m.echo, P = ECHO_PLACE[kind];
    if (!e?.setPlacement || !P) return;
    try { e.setPlacement({ position: new THREE.Vector3(...P.pos), height: P.h }); } catch { /* */ }
  }

  /**
   * Showcase knockdown (QA r2 P1-7): a slow-mo beat on the hero, a stagger + hurt face, the music ducked for a bar,
   * a red vignette (UI) and "GET BACK UP!", then one bar in which hazards cannot hurt.
   */
  _onKnockdown({ count } = {}) {
    if (!PLAY.has(this.state)) return;
    const { audio, ui, bus, fx } = this.ctx;
    const beat = this.clock.frameBeat;
    this._graceUntil = beat + 4;
    try { this.motion?.hitStop?.(420, 0.22); } catch { /* */ }
    try { this.motion?.accents?.trigger?.('land', this.motion._t ?? 0, { strength: 1.4 }); } catch { /* */ }
    this.motion?.requestExpression?.('hurt');
    if (fx) fx.trauma = Math.min(1, (fx.trauma || 0) + 0.8);
    audio.sfx('hurt', { pitch: 0.7, gain: 1.2 });
    audio.setIntensity(0.12);
    this._kdRestoreAt = beat + 4;
    // the real UI listens to bus 'knockdown' itself (red vignette, "GET BACK UP!" in the top lane, heart refill); the
    // stand-in UI gets CORE's vignette + banner + prompt
    if (!ui.stub && typeof ui.hud.knockdown === 'function') { try { ui.hud.knockdown({ health: this.score.health, max: this.score.maxHealth, count }); } catch { /* */ } }
    else {
      try { vignette(ui.root ?? document.body, { color: '255,40,70', ms: 1600 }); } catch { /* */ }
      try { ui.hud.banner('KNOCKED DOWN', 'Get back up!'); } catch { /* */ }
      this._flashPrompt('GET BACK UP!', 1800);
    }
    bus.emit('knockdown:fx', { count, graceBeats: 4 });
  }

  /**
   * Fastest punch (QA r2 P2-1): the hero-space wrist speed (m/s) at the punch, not the detector's arm-extension rate
   * (that one is body.punchSnap). Hand positions are sampled every frame; 160 ms after a punch fires, the peak speed
   * of that hand over the last ~0.35 s is the punch's speed.
   */
  _updateWrist() {
    const B = this.hero?.bones, root = this.hero?.root;
    if (!B?.leftHand || !B?.rightHand || !root) return;
    const W = this._wrist ??= { buf: [], inv: new THREE.Matrix4(), l: new THREE.Vector3(), r: new THREE.Vector3() };
    const now = performance.now();
    W.inv.copy(root.matrixWorld).invert();
    B.leftHand.getWorldPosition(W.l).applyMatrix4(W.inv); B.rightHand.getWorldPosition(W.r).applyMatrix4(W.inv);
    W.buf.push({ t: now, l: W.l.clone(), r: W.r.clone() });
    while (W.buf.length && now - W.buf[0].t > 400) W.buf.shift();
    const q = this._wristReq;
    if (q && now >= q.at) {
      this._wristReq = null;
      let best = 0;
      // speed over ~66 ms spans (2 tracker frames), so one-frame pose snaps / IK pops do not count as fist speed
      for (let i = 0, j = 0; j < W.buf.length; j++) {
        const b = W.buf[j];
        if (now - b.t > 350) { i = j + 1; continue; }
        while (i < j && b.t - W.buf[i + 1].t >= 66) i++;
        const a = W.buf[i], dt = (b.t - a.t) / 1000;
        if (i >= j || dt < 0.06) continue;
        best = Math.max(best, b[q.side[0]].distanceTo(a[q.side[0]]) / dt);
      }
      if (best > 0.5 && best < 15) this.score.punchSpeed(best);
    }
  }

  /** Knee strikes (settings.kneeStrikes) + the loose Awakening match: a knee driven up to ~hip height. Fires
   *  kickLeft / kickRight into _onAction (so crawlers accept it) unless the detector just fired that kick itself. */
  _updateKnee() {
    const K = this._knee, f = this.tracking.lastFrame, J = f?.joints;
    if (!J || f === K.f) return;
    K.f = f;
    if (this.ctx.settings.seated) { K.left.up = K.right.up = false; return; }
    const c = f.conf ?? {};
    const ok = (k) => J[k] && (c[k] == null || c[k] >= 0.4);
    if (!ok('leftHip') || !ok('rightHip') || !ok('leftShoulder') || !ok('rightShoulder')) return;
    const hipY = (J.leftHip.y + J.rightHip.y) * 0.5, torso = Math.max(0.25, (J.leftShoulder.y + J.rightShoulder.y) * 0.5 - hipY);
    const sunk = Number.isFinite(this._jump.base) && this._jump.base - hipY > 0.12;      // squatting: knees rise with the hips down
    const rel = {};
    for (const side of ['left', 'right']) rel[side] = ok(side + 'Knee') ? (J[side + 'Knee'].y - hipY) / torso : -1;
    const now = performance.now(), lf = this.motion?.actions?.lastFire ?? {};
    for (const side of ['left', 'right']) {
      const S = K[side], other = side === 'left' ? 'right' : 'left';
      const solo = rel[other] < -0.6 && !sunk;                                           // the support leg stays down
      S.up = solo && rel[side] > -0.55;
      if (rel[side] < -0.65) S.armed = true;
      if (solo && rel[side] > -0.35 && S.armed && now - S.last > 400) {
        S.armed = false; S.last = now;
        const name = side === 'left' ? 'kickLeft' : 'kickRight';
        // the detector fires knee strikes itself when it supports them (actions.kneeStrike); else CORE's fallback does
        const det = this.motion && 'kneeStrike' in this.motion.actions;
        if (!det && this.ctx.settings.kneeStrikes && PLAY.has(this.state) && now - (lf[name] ?? -1e9) > 400) this._onAction(name, { tCapture: f.tCapture ?? now, side, knee: true });
      }
    }
  }

  // ======================================================================================== per frame
  update(dt) {
    const t0 = performance.now();
    this._updateBloom(dt);
    this.stateT += dt;
    const beat = this.clock.frameBeat, songT = this.clock.frameNow;
    const { ui, visuals, audio, settings } = this.ctx;
    this.judge.sampleStates(this.motion);
    // beat pulse
    const bi = Math.floor(beat);
    if (bi !== this.lastBeatInt) {
      this.lastBeatInt = bi;
      if (PLAY.has(this.state) || this.state === 'title') visuals.stage.pulse(bi % 4 === 0 ? 0.6 : 0.3);
      this.ctx.bus.emit('beat', { beat: bi, bar: bi >> 2, downbeat: bi % 4 === 0 });
    }
    const playing = PLAY.has(this.state);
    if (playing) {
      if (this.tracking.lostFor > LOST_PAUSE_S && this.tracking.kind !== 'autoplay') { this.setState('pause', { reason: 'tracking-lost' }); return; }
      this.score.update(dt);
      if (this.state === 'run') this._updateRun(dt, beat); else this._updateBoss(dt, beat);
      if (this.state !== 'run' && this.state !== 'boss') { this.stats.coreMs = performance.now() - t0; return; }
      const fb = this.fieldBeat, fT = this.awk ? this.clock.timeAtBeat(fb) : songT;
      this.field.update(fT, fb, dt);
      this.charge.update(dt, this.motion, this.heroH);
      this._updateJump();
      this._updateKnee();
      this._updateWrist();
      if (this._kdRestoreAt && beat >= this._kdRestoreAt) { this._kdRestoreAt = 0; audio.setIntensity(this.act === 'boss' ? 1 : this.awk ? 0.3 : 0.35 + (+this.act || 0) * 0.3); }
      this._updatePrompt(fb);
      this._updateDistance(dt);
      this.rec.record(songT, fb);
      this._recordKp(songT);
      this.rec.scan(this.score.events, songT, { windowS: REPLAY_WIN });
      if (this.score.failed && this.state !== 'results') this.setState('results', { cleared: false });
    } else if (this.state === 'pause') {
      this._updatePause(dt);
    } else if (this.state === 'results') {
      if (this._replayAt && performance.now() > this._replayAt) this._playReplay();
      // kiosk: nobody touched the results -> the next player (booth countdowns finish first)
      // (QA r3 design P2-5): with a real tracker the clock only runs while nobody is in frame (someone reading their
      // stats or posing keeps the screen); the synthetic demo / autoplay players are always "present", so plain idle
      if (settings.kiosk && !this.replay.active && this._resIntro?.shown && !this.ctx.booth?.busy) {
        const synth = this.tracking.kind === 'demo' || this.tracking.kind === 'autoplay';
        const empty = synth || this.tracking.lostFor > 1.5;
        this._resIdleT = empty ? (this._resIdleT || 0) + dt : 0;
        if (this._resIdleT > KIOSK_RESULTS_IDLE_S) { this._resIdleT = 0; this.newPlayer(); }
      }
    } else if (this.state === 'title') {
      // kiosk: an empty title (nobody tracked) for a while -> reset for whoever walks up next
      if (settings.kiosk && !this._fresh) {
        this._idleT = this.tracking.lostFor > 3 ? (this._idleT || 0) + dt : 0;
        if (this._idleT > KIOSK_TITLE_IDLE_S) { this._idleT = 0; this.newPlayer(); }
      }
    } else if (this.state === 'tutorial') {
      this.charge.update(dt, this.motion, this.heroH);
    }
    // autoplay: walk through the menus by itself
    if (settings.dev.autoplay) {
      if (this.state === 'title' && this.stateT > 2.5) { audio.unlock(); this.play(); }
      if (this.state === 'calibrate' && this.stateT > 7) { this.motion?.calibrate(); this.setState('title'); }
    }
    this.stats.coreMs = performance.now() - t0;
  }

  /**
   * Distance guidance (HUD) without false alarms: never for the autoplay / demo players, nothing while a big move is
   * active or just ended (hands up / charge / jump / kick / duck: the body legitimately leaves the box), and a
   * problem must persist 1 s before it shows. Clearing is immediate.
   */
  _updateDistance(dt) {
    const { ui } = this.ctx;
    if ((this._distT = (this._distT || 0) + dt) < 0.1) return;
    this._distT = 0;
    const now = performance.now();
    const st = this.motion?.actions?.state ?? {}, lf = this.motion?.actions?.lastFire ?? {};
    const recent = (k, ms) => now - (lf[k] ?? -1e9) < ms;
    const big = st.handsUp || st.squat || st.jump || this.charge.handsUp || this.charge.level > 0 || this.charge.charged
      || recent('jump', 1200) || recent('kickLeft', 900) || recent('kickRight', 900) || now - (this.charge.lastBlastAt ?? -1e9) < 1200;
    if (big) this._bigUntil = now + 600;
    this.bigMove = now < this._bigUntil;
    let d = null;
    const kind = this.tracking.kind;
    if (kind !== 'autoplay' && kind !== 'demo' && !this.bigMove) { try { d = ui.measureDistance?.() ?? null; } catch { d = null; } }
    if (d !== this._distCand) { this._distCand = d; this._distCandT = now; }
    const show = d === null ? null : now - this._distCandT >= 1000 ? d : this._dist;
    if (show !== this._dist) { this._dist = show; ui.hud.distance(show); this.ctx.bus.emit('distance', { state: show, bigMove: this.bigMove }); }
  }

  /**
   * Tracked 2D keypoints of the last ~20 s (song time), for the replay's "YOU" inset when the CV mirror has no
   * recorded silhouette (no camera segmentation: demo / autoplay, or CV off): the skeleton the hero was rebuilt from.
   */
  _recordKp(songT) {
    const f = this.tracking.lastFrame;
    if (!f || f === this._kpLast || !f.kp2d?.length || !f.edges) return;
    this._kpLast = f;
    const R = this._kpRing ??= [];
    R.push({ t: songT, kp: f.kp2d.map((p) => (p ? { x: p.x, y: p.y, c: p.c ?? 1 } : null)), edges: f.edges, source: f.source });
    while (R.length && songT - R[0].t > 22) R.shift();
  }
  /** Recorded keypoint frame nearest song time t (or null). */
  replaySkeletonAt(t) {
    const R = this._kpRing;
    if (!R?.length) return null;
    let lo = 0, hi = R.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m].t < t) lo = m; else hi = m; }
    return Math.abs(R[lo].t - t) <= Math.abs(R[hi].t - t) ? R[lo] : R[hi];
  }

  /** Per frame, after motion.update() and before hero.update(): procedural pose accents over the tracked pose. */
  afterMotion(dt, hero) {
    if (this.replaying) { this.poseOverlay.cancel(); return; }
    this.poseOverlay.update(dt, hero ?? this.hero);
  }

  /** Hero pose for this frame: the replay drives it on the results screen, else the motion pipeline does. */
  get replaying() { return this.replay.active; }

  // ======================================================================================== inputs
  _onAction(name, info) {
    const s = this.state;
    if (!PLAY.has(s)) return;
    const sc = this.score;
    // body stats (all moves, judged or not)
    if (name.startsWith('punch')) { sc.move('punch'); sc.punchSnap(info.speed); this._wristReq = { side: name.endsWith('Left') ? 'left' : 'right', at: performance.now() + 160 }; }
    else if (name.startsWith('kick')) sc.move('kick');
    else if (name === 'jump') { sc.move('jump'); this._startJump(); }
    else if (name === 'squat') sc.move('squat');
    else if (/^(lean|step)/.test(name)) sc.move('dodge');
    if (!/^(punch|kick|jump)/.test(name)) return;
    if (name.startsWith('punch') && this.charge.busy) return;     // the blast push reads as a jab: ignore
    // knee strikes: the detector's own kick right after a knee event on that side is the same move
    if (name.startsWith('kick') && !info?.knee && performance.now() - this._knee[name === 'kickLeft' ? 'left' : 'right'].last < 400 && this.ctx.settings.kneeStrikes) return;
    const field = this.field;
    const A = this.awk, W = A?.waiting;
    if (W && !W.resolved && W.move !== 'guard') {
      if (Judge.actionFor(W) === name) { field.resolve(W, 'perfect', 0, 'hit'); return; }
      const loose = A.looseFor === W;
      if (loose && ((W.move === 'punch' && name.startsWith('punch')) || (W.move === 'kick' && name.startsWith('kick')))) { field.resolve(W, 'good', 0, 'loose'); return; }
      if (W.move === 'punch' && name.startsWith('punch')) { A.wrongTries = (A.wrongTries || 0) + 1; this._flashPrompt(W.side === 'left' ? 'OTHER HAND: ◀ LEFT' : 'OTHER HAND: RIGHT ▶'); return; }
      if (W.move === 'kick' && name.startsWith('kick')) { A.wrongTries = (A.wrongTries || 0) + 1; this._flashPrompt(W.side === 'left' ? 'OTHER LEG: ◀ LEFT' : 'OTHER LEG: RIGHT ▶'); return; }
    }
    if (W && !W.resolved && W.move === 'guard' && W.phase === 'fly' && A.looseFor === W && name.startsWith('punch')) { W.phase = 'punch'; W.blockKind = 'good'; W.blockErr = 0; this._onBlock(W, 'good', 0); return; }
    if (name.startsWith('punch')) {
      const brute = field.brutePunchTarget();
      if (brute) {
        brute.hits++;
        this.ctx.audio.sfx('punchHit', { pan: name.endsWith('Left') ? -0.4 : 0.4 });
        try { brute.view?.impact?.(brute.hits >= 3 ? 'perfect' : 'good', this._v.set(name.endsWith('Left') ? 0.3 : -0.3, 0.1, 1).normalize()); } catch { /* */ }
        if (!brute.view?.impact) this.ctx.visuals.vfx.shockwave?.(brute.pos);
        this.ctx.visuals.stage.pulse(0.4);
        // Awakening loose stage on the brute's punch phase: one punch finishes it (QA r3 design P2-1)
        const looseOne = !!(A && A.waiting === brute && A.looseFor === brute && brute.phase === 'punch');
        if (brute.hits >= 3 || looseOne) field.resolve(brute, brute.blockKind ?? 'good', brute.blockErr ?? 0, 'brute-finish');
        return;
      }
      const r = field.reactTarget();
      if (r) {
        const side = name.endsWith('Left') ? 'left' : 'right';
        const ms = (info.tCapture ?? info.t) - (r.cuePerf || performance.now());
        if (side === r.side || !this.ctx.settings.wrongMovePenalty) {
          const kind = ms <= 420 ? 'perfect' : ms <= 600 ? 'great' : ms <= 900 ? 'good' : 'miss';
          if (kind !== 'miss') this.score.reaction(ms);
          field.resolve(r, kind, ms, 'react');
          return;
        }
      }
    }
    const m = this.judge.matchAction(name, info, field.live);
    if (m) field.resolve(m.note, m.kind, m.errMs, 'hit');
  }
  _flashPrompt(text, ms = 900) { this._flash = { text, until: performance.now() + ms }; }

  _onResolve(n, kind, errMs, how) {
    const { audio, visuals, ui, bus } = this.ctx;
    const beat = this.clock.frameBeat, songT = this.clock.frameNow;
    this.rec.noteOutcome(n, kind, beat, this.clock);
    if (how === 'brute-escape') return;
    if (how === 'brute-finish') {
      this.score.addBonus(900);
      audio.sfx('shatter'); audio.sfx('kickHit');
      this._popup(n.pos, 'perfect');
      this.director.punchIn(0.8);
      return;
    }
    this.judge.record(n, kind, errMs);
    const hazard = HAZARD.has(n.move);
    // health economy: Showcase = only hazards that physically hit you (sweep / scythe / volley; the brute's strike is
    // handled in _onBlock); Challenge = every missed target; the Awakening never hurts
    const challenge = this.score.mode === 'challenge';
    const grace = this._graceUntil && this.clock.frameBeat < this._graceUntil;      // just got back up after a knockdown
    const hurt = kind === 'miss' && !grace && n.act !== 'awaken' && n.move !== 'blast' && !n.react && (challenge || hazard || n.move === 'guard');
    const pan = n.side === 'left' ? -0.5 : n.side === 'right' ? 0.5 : 0;
    if (kind === 'miss') {
      audio.sfx('miss');
      if (hurt) {
        audio.sfx('hurt');
        if (this.ctx.fx) this.ctx.fx.trauma = Math.min(1, (this.ctx.fx.trauma || 0) + 0.55);
        this.motion?.requestExpression?.('hurt');
      }
    } else {
      if (hazard) audio.sfx(n.move === 'jump' ? 'jumpOver' : n.move === 'squat' ? 'duckUnder' : 'dodge', { pan });
      else if (n.move === 'blast') { /* blast sfx played by _onBlast */ }
      else { audio.sfx(n.move === 'kick' ? 'kickHit' : 'punchHit', { pan }); audio.sfx('shatter', { pan, gain: 0.7 }); }
      audio.sfx(kind, { pan: 0 });
      if (kind === 'perfect') { this.director.punchIn(1); visuals.stage.pulse(0.7); if (!this.ctx.settings.reduceFlashes) this.bloom(BLOOM.perfect, 0.25); }
      if (n.boss && n.move === 'punch') this.boss?.chip();
    }
    const bonus = n.move === 'blast' && kind !== 'miss' ? 700 : 0;
    const prevCombo = this.score.combo;
    this.score.judge(kind, { songT, hurt, bonus });
    if (this.score.combo > 0 && this.score.combo % 10 === 0 && this.score.combo !== prevCombo) audio.sfx('combo');
    if ((this.score.combo === 25 || this.score.combo === 50) && this.score.combo !== prevCombo) this.cameraCut('frontCut');
    this._popup(n.hitPos ?? n.pos ?? n.to, kind, n.react || n.move === 'blast' ? undefined : errMs, kind === 'miss' && n.wrongTry ? 'miss' : kind, { wrong: !!n.wrongTry && kind === 'miss' });
    bus.emit('judge', { kind, errMs, note: n, pos: n.pos, how, hurt, wrong: !!n.wrongTry && kind === 'miss' });
  }

  _onBlock(n, kind, errMs) {
    const { audio, bus } = this.ctx;
    if (this.awk?.waiting === n) this.awk.blockedWait = true;
    this.judge.record(n, kind, errMs);
    this.score.move('guard');
    audio.sfx('block'); audio.sfx(kind);
    try { n.view?.block?.(); } catch { /* */ }
    this.score.judge(kind, { songT: this.clock.frameNow });
    this._popup(n.view?.hitPoint ?? n.pos, kind, errMs, kind === 'miss' ? 'miss' : 'block');
    if (kind === 'perfect') this.director.punchIn(0.7);
    bus.emit('judge', { kind, errMs, note: n, pos: n.pos, how: 'block' });
  }

  /**
   * Judgement pop-up. Millisecond readouts only with ?debug=1; otherwise Great / Good carry an EARLY / LATE tag
   * (opts.timing) and Perfect carries nothing.
   */
  _popup(pos, kind, errMs, label = kind, extra = {}) {
    const { ui, visuals, camera, renderer, settings } = this.ctx;
    if (!pos) return;
    try { visuals.vfx.judgement?.(pos, kind); } catch { /* */ }
    const v = this._v.copy(pos).project(camera);
    if (v.z > 1) return;
    const el = renderer.domElement;
    const ms = Number.isFinite(errMs) ? Math.round(errMs) : undefined;
    const timing = ms !== undefined && (kind === 'great' || kind === 'good') ? (ms < 0 ? 'early' : 'late') : undefined;
    ui.hud.judgement({ x: (v.x * 0.5 + 0.5) * el.clientWidth, y: (-v.y * 0.5 + 0.5) * el.clientHeight }, label,
      { errMs: settings.dev.debug ? ms : undefined, timing, ...extra });
  }

  _onBlast(origin, dir) {
    const { visuals, audio, bus } = this.ctx;
    const s = this.state;
    if (!PLAY.has(s) && s !== 'tutorial') return;
    this.score.move('blast');
    this.poseOverlay.push(PUSH_POSE);          // the beam leaves from the hero's palms, whatever the tracked pose
    const o = this._v.copy(origin);           // hero space == world (the hero root sits at the origin)
    if (this.hero) o.applyMatrix4(this.hero.root.matrixWorld);
    const target = PLAY.has(s) ? this.field.coreTarget(this.fieldBeat) : null;
    const d = new THREE.Vector3();
    if (target) d.copy(target.pos ?? target.to).sub(o).normalize(); else d.copy(dir);
    try { visuals.vfx.blast(o.clone(), d, { target: target ? (target.pos ?? target.to)?.clone() : undefined }); } catch (e) { console.warn('[game] vfx.blast', e); }
    audio.sfx('blast');
    this.bloom(BLOOM.blast, 0.45);            // a short, low flash: the beam itself carries the shot
    this._stopHum();
    if (visuals.stub && this.ctx.fx) this.ctx.fx.trauma = Math.min(1, (this.ctx.fx.trauma || 0) + 0.7);   // VISUAL shakes itself
    const killing = !!(target?.weak && this.boss && this.boss.blasts >= 2);
    if (!killing) this.cameraCut('blast', undefined, { target: target ? (target.pos ?? target.to) : undefined });
    bus.emit('blast', { origin: o, dir: d, target });
    if (!target) return;
    this.field.resolve(target, 'perfect', 0, 'blast');
    if (target.weak && this.boss) {
      audio.sfx('bossHit');
      const dead = this.boss.blastHit(this.clock.frameBeat);
      if (dead && !this.cameraCut('bossKill')) this.cameraCut('blast', 2.4);
    }
  }

  _onChargeLevel(lv, charged) {
    const { visuals, audio } = this.ctx;
    if (!PLAY.has(this.state) && this.state !== 'tutorial') return;
    if (Math.abs(lv - this._auraLv) < 0.05 && !(lv === 0 && this._auraLv !== 0)) return;
    this._auraLv = lv;
    if (lv > 0) {
      visuals.vfx.aura(true, { color: charged ? 0xfff1b0 : 0x9fdcff, strength: 0.3 + lv * 0.7 });
      if (!this._hum) this._hum = audio.sfxLoop('chargeHum');
      this._hum?.set?.(lv);
    } else if (!this.score.overdrive) visuals.vfx.aura(false, {});
    this.ctx.bus.emit('charge', { level: lv, charged });
  }
  _stopHum() { this._hum?.stop(); this._hum = null; this._auraLv = -1; if (!this.score.overdrive) this.ctx.visuals?.vfx?.aura(false, {}); }

  _onOverdrive(on) {
    const { audio, visuals, ui } = this.ctx;
    if (on && PLAY.has(this.state)) this._placeEcho(this.state === 'boss' ? 'boss' : 'run');
    if (PLAY.has(this.state) || !on) this._mirror('setMode', on ? 'echo' : 'off');
    audio.setOverdrive(on);
    visuals.vfx.aura(on, { color: 0xffc840, strength: 0.8, mode: 'overdrive' });
    if (on) { ui.hud.banner('OVERDRIVE!', 'Double points'); audio.sfx('overdrive'); }
  }

  // ======================================================================================== jump height (body stat)
  _startJump() { this._jump.active = true; this._jump.t0 = performance.now(); this._jump.peak = -Infinity; }
  _updateJump() {
    const f = this.tracking.lastFrame, J = this._jump;
    const L = f?.joints?.leftHip, R = f?.joints?.rightHip;
    if (!L || !R) return;
    const y = (L.y + R.y) * 0.5;
    if (J.active) {
      J.peak = Math.max(J.peak, y);
      if (performance.now() - J.t0 > 900) { J.active = false; if (Number.isFinite(J.base)) this.score.jumpHeight((J.peak - J.base) * 100); }
    } else if (!this.motion?.actions?.state?.squat) {
      J.base = Number.isFinite(J.base) ? J.base + (y - J.base) * 0.03 : y;
    }
  }

  // ======================================================================================== prompts
  /**
   * One prompt at a time in the UI's low lane (hud.prompt(text, { move, wait, kicker })) plus VISUAL's ground glyph
   * (vfx.groundCue(kind, t), t 0 -> 1 over the last 2 beats) for the slow full-body moves.
   */
  _updatePrompt(beat) {
    let text = null, opts = null, cue = null, cueT = 0;
    const br = this.field.brutePunchTarget();
    const A = this.awk, W = A?.waiting;
    const promptMove = (n) => n.type === 'striker' ? 'punch' + (n.side === 'left' ? 'Left' : 'Right') : n.type === 'crawler' ? 'kick' + (n.side === 'left' ? 'Left' : 'Right')
      : n.type === 'volley' ? (n.side === 'left' ? 'dodgeRight' : 'dodgeLeft') : n.type === 'core' ? (this.charge.charged ? 'blast' : 'charge') : n.type;
    if (this._flash && performance.now() < this._flash.until) text = this._flash.text;
    else if (br) {
      // the Awakening brute at its loose stage takes one punch: say so (not "×3")
      const looseBr = !!(A && A.waiting === br && A.looseFor === br);
      text = looseBr ? LOOSE_HEAD.brutePunch : 'PUNCH ×3!';
      opts = looseBr ? { move: 'punch', wait: true, sub: '', coach: 'loose' } : { move: 'punch' };
    }
    else if (this.charge.charged) { text = 'PUSH!'; opts = { move: 'blast', sub: 'Both palms at the screen' }; cue = 'blast'; cueT = 1; }
    else if (W && !W.resolved) {
      const knee = this.ctx.settings.kneeStrikes && W.type === 'crawler';
      const p = knee ? { left: '◀ LEFT KNEE', right: 'RIGHT KNEE ▶' } : AWAKEN_PROMPT[W.type];
      text = typeof p === 'string' ? p : p?.[W.side] ?? null;
      if (W.type === 'core' && this.charge.level > 0) text = 'HOLD IT…';
      if (W.type === 'brute' && W.phase === 'punch') text = 'PUNCH ×3!';
      const secs = [...new Set(AWAKEN.sections.filter((x) => !(x.lower && upperOnlyOf(this.ctx.settings)) && !(x.seated === false && this.ctx.settings.seated)).map((x) => x.id))];
      const i = secs.indexOf(W.section);
      const stage = A.looseFor === W ? 'loose' : A.coachFor === W ? 'coach' : null;
      // loose stage: the headline names what is accepted now; the hint lives once, in the coaching chip
      if (stage === 'loose' && !(W.type === 'core' && this.charge.level > 0)) text = LOOSE_HEAD[looseKey(W)] ?? text;
      const sub = stage === 'loose' ? '' : stage === 'coach' ? A.coach : (knee ? 'Knee the cyan crawlers: drive your knee up' : AWAKEN_HINT[W.section]);
      const pm = W.type === 'brute' && W.phase === 'punch' ? 'punch' : promptMove(W);
      opts = { move: pm, wait: true, sub, coach: stage, kicker: `AWAKENING · ${i + 1} / ${secs.length}` };
    } else {
      const r = this.field.reactTarget();
      if (r) { text = !this.ctx.settings.wrongMovePenalty ? 'PUNCH NOW!' : r.side === 'left' ? 'LEFT PUNCH NOW!' : 'RIGHT PUNCH NOW!'; opts = { move: promptMove(r), tone: 'warn' }; }
      else {
        const n = this.field.nextLive(this._promptable ??= (x) => (x.type !== 'striker' && x.type !== 'crawler') || (x.type === 'crawler' && (x.act === 0 || x.act === 'awaken')) || (x.waitFor && x.act === 'awaken'));
        if (n && n.beat - beat <= Math.max(SLOW.has(n.move) ? 2 : 1.5, n.teleBeats)) {
          const kw = this.ctx.settings.kneeStrikes ? 'KNEE' : 'KICK';
          text = n.type === 'volley' ? (n.side === 'left' ? 'LEAN RIGHT ▶' : '◀ LEAN LEFT') : n.type === 'crawler' ? (n.side === 'left' ? `LEFT ${kw}!` : `RIGHT ${kw}!`)
            : n.type === 'striker' ? (n.side === 'left' ? '◀ LEFT PUNCH' : 'RIGHT PUNCH ▶') : PROMPT[n.type] ?? null;
          opts = { move: promptMove(n) };
          if (n.act === 'awaken' && n.section) opts.sub = AWAKEN_HINT[n.section];
          else if (n.type === 'core') opts.sub = n.weak ? 'Charge, then push at the core' : 'Charge your Breaklight';
        }
      }
    }
    // ground glyph for the next slow move within 2 beats
    if (!cue) {
      const g = this.field.nextLive(this._cueable ??= (x) => x.type === 'sweep' || x.type === 'scythe' || x.type === 'volley' || (x.type === 'brute' && x.phase === 'fly') || x.type === 'core');
      if (g) {
        const left = g.beat - beat;
        if (left <= 2 || (W === g)) {
          cue = g.type === 'sweep' ? 'jump' : g.type === 'scythe' ? 'duck' : g.type === 'brute' ? 'guard' : g.type === 'core' ? 'blast' : g.side === 'left' ? 'dodgeR' : 'dodgeL';
          cueT = W === g ? 1 : Math.min(1, Math.max(0, 1 - left / 2));
        }
      }
    }
    if (cue) { try { this.ctx.visuals.vfx.groundCue?.(cue, cueT); } catch { /* */ } }
    // UI prompt (only on change); a waiting spirit that was just answered gets the success flourish
    const key = text || opts?.move ? JSON.stringify([text, opts]) : null;
    if (key !== this._promptKey) {
      const wasWait = this._promptWait;
      this._promptKey = key; this._prompt = text;
      this._promptWait = !!opts?.wait;
      if (!key && wasWait) this.ctx.ui.hud.prompt(null, { success: true });
      else this.ctx.ui.hud.prompt(text, opts ?? undefined);
    }
  }

  // ======================================================================================== debug / QA
  snapshot() {
    const sc = this.score, e = this.judge.errHist;
    const mean = e.length ? e.reduce((a, b) => a + b, 0) / e.length : 0;
    const sd = e.length ? Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / e.length) : 0;
    const r = this.ctx.renderer.info.render;
    return {
      fps: this.ctx.perf.fps, frameMs: this.ctx.perf.frameMs, frameMax: this.ctx.perf.frameMax, quality: this.ctx.quality?.preset?.id,
      state: this.state, act: this.act, beat: this.clock.frameBeat, fieldBeat: this.fieldBeat, clockLive: this.clock.live,
      mode: sc.mode, knockdowns: sc.knockdowns, awaken: this.awk ? { offset: this.awk.offset, waiting: this.awk.waiting?.type ?? null, coach: this.awk.coachFor === this.awk.waiting && !!this.awk.waiting, loose: this.awk.looseFor === this.awk.waiting && !!this.awk.waiting } : null,
      breather: !!this._breather, grace: !!(this._graceUntil && this.clock.frameBeat < this._graceUntil), shot: this.director.shot, bloom: this.ctx.post?.effects?.bloom?.intensity,
      boss: this.boss ? { stage: this.boss.stage, blasts: this.boss.blasts, tries: this.boss.tries, phase: this.boss.phase } : null,
      tracker: this.tracking.kind, trackFps: this.tracking.fps, trackLat: this.tracking.lat, lostFor: Math.min(99, this.tracking.lostFor),
      live: this.field.live.length, pending: this.field.pending.length, draws: r.calls, tris: r.triangles,
      score: Math.round(sc.score), combo: sc.combo, mult: sc.mult, health: sc.health, flow: sc.flow, overdrive: sc.overdrive,
      j: sc.judgements, meanErr: mean, sdErr: sd, coreMs: this.stats.coreMs, motionMs: this.ctx.perf.motionMs, charge: this.charge.level,
      bot: this.bot?.stats?.learned && Object.keys(this.bot.stats.learned).length ? this.bot.stats.learned : null,
    };
  }
  dispose() { for (const o of this._offs) o(); this._actOff?.(); }
}

export { BOSS_BEATS };
