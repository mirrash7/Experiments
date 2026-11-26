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
import { ACTS, ActChart, awakeningNotes, AWAKEN, AWAKEN_PROMPT, AWAKEN_HINT } from './chart.js';
import { SpiritField } from './spirits.js';
import { Judge } from './judge.js';
import { Score } from './score.js';
import { BossScript, BOSS_BEATS } from './boss.js';
import { ChargeDetector } from './charge.js';
import { ReplayRecorder, ReplayPlayer } from './replay.js';
import { flags, submitBest, bestFor, heartsFor, audioVolume, upperOnlyOf } from './settings.js';
import { spaceCheck, skipButton, letterbox, mirrorInset } from './space.js';
import * as cameraMod from './camera.js';

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
  sweep: 'JUMP!', scythe: 'DUCK!', brute: 'GUARD!', core: 'HANDS UP — CHARGE!',
};
/** Notes whose prompt shows at least 2 beats ahead whatever the act's travel (slow full-body moves). */
const SLOW = new Set(['jump', 'squat', 'guard', 'blast']);
const HAZARD = new Set(['jump', 'squat', 'dodge']);
/** Replay: seconds of game time in the results highlight, and its playback speed. */
const REPLAY_WIN = 2.6, REPLAY_SPEED = 0.35;

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
    // the UI's title / settings screens write settings.mode / seated / difficulty and announce it
    this._offs.push(bus.on('tutorial', (d) => { this._tutDrill = d?.phase === 'done' ? null : d?.drill ?? null; }));
    this._offs.push(bus.on('settings:change', ({ key, value } = {}) => {
      if (key === 'mode' || key === 'difficulty') this._applyMode();
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
    if (s === 'results') { this.replay.stop(); this._replayDone(); this._resIntro = null; this.ctx.booth?.disarm?.(); this._mirror('setMode', 'off'); }
    if (s === 'space') { this._space?.close(); this._space = null; }
    if (s === 'calibrate') setTimeout(() => { if (this.ctx.mirror?.mode === 'calibrate' && this.state !== 'calibrate') this._mirror('setMode', 'off'); }, 1600);
    if (PLAY.has(s) && next !== 'pause') {
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
        ui.screens.title({
          onPlay: () => { audio.unlock(); this.play(); },
          onTutorial: () => { audio.unlock(); this.setState('tutorial'); },
          onSettings: () => this.setState('settings'),
          mode: settings.mode,
          onMode: (m) => { settings.mode = m === 'challenge' ? 'challenge' : 'showcase'; settings.save?.(); this._applyMode(); },
          best: bestFor(settings),
          tutorialLabel: flags.get('awakened') ? 'TRAINING' : 'TUTORIAL',
        });
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
        if (uiSpace && !ui.stub) this._space = { close() {}, handle: uiSpace({ seated: settings.seated, onDone: (r = {}) => done({ seated: r.seated ?? settings.seated }) }) };
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
    this.rec.clear();
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
    this.awk = { startBeat, endBeat, offset: 0, waiting: null, waitSince: 0, sections: new Set(), lastNote: notes[notes.length - 1] };
    this.judge.beatOffset = 0;
    this._bannerAt = startBeat; this._bannerText = [AWAKEN.name, AWAKEN.sub];
    try { this._skipBtn = skipButton(ui.root ?? document.body, () => this.skipAwaken()); } catch { /* */ }
    bus.emit('act', { act: 'awaken' });
    bus.emit('awaken', { phase: 'start' });
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
      const rem = A.offset % 4;                         // answered at tempo (tiny lag): snap back instead of losing a bar
      A.offset = rem < 0.75 ? A.offset - rem : Math.ceil(A.offset / 4 - 1e-6) * 4;
      A.waiting = null;
      audio.setIntensity(0.3);
    }
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
    // section hints (once per section, when its first spirit appears)
    for (const n of this.field.live) {
      if (n.section && !A.sections.has(n.section)) { A.sections.add(n.section); this.ctx.bus.emit('awaken', { phase: 'section', section: n.section, hint: AWAKEN_HINT[n.section] }); }
    }
    // done: every note resolved and past the end
    if (!A.waiting && A.lastNote.resolved && vb > Math.max(A.lastNote.beat + 2, A.endBeat - 4)) {
      this._endAwaken(true);
      this._startAct(0, this.clock.nextBar(2));
      return beat;
    }
    return vb;
  }

  _startAct(act, startBeat) {
    const { ui, audio, visuals, bus } = this.ctx;
    this.act = act;
    this.chart = new ActChart({ act, startBeat, settings: this.ctx.settings, seed: this.seed, out: this.notesAll });
    visuals.stage.setAct(act);
    audio.setIntensity(0.35 + act * 0.3);
    const A = ACTS[act];
    this._bannerAt = startBeat; this._bannerText = [A.name, A.sub];
    bus.emit('act', { act });
  }

  _updateRun(dt, beat) {
    if (this._bannerAt != null && beat >= this._bannerAt - 0.05) {
      this.ctx.ui.hud.banner(...this._bannerText); this._bannerAt = null;
    }
    if (this.awk) { this.fieldBeat = this._updateAwaken(beat); return; }
    this.fieldBeat = beat;
    const ch = this.chart;
    if (!ch) return;
    ch.update(beat, this.score.skill);
    this._drainNotes();
    const actOver = ch.done && beat > ch.lastBeat + 1.5 && !this.field.pending.length && !this.field.nextLive();
    if (actOver) {
      if (this.act < 2) this._startAct(this.act + 1, this.clock.nextBar(2));
      else this.setState('boss');
    }
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
          this.bloom(1.0, 1.8); audio.sfx('victory'); ui.hud.banner('WARDEN DEFEATED');
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
    this.lastResults = stats;
    this.director.setMode('results');
    this.replayWin = this.rec.pick(this.score.events, REPLAY_WIN);
    stats.replay = this.replayWin ? { seconds: +(this.replayWin.t1 - this.replayWin.t0).toFixed(2), hits: this.replayWin.hits, speed: REPLAY_SPEED, label: this.replayWin.label, bossKill: !!this.replayWin.pinned } : null;
    this._resIntro = { shown: false };
    this._replayAt = 0;
    // the real UI's results screen runs its own letterboxed replay phase from the bus events: show it first; the
    // stand-in UI gets CORE's fallback letterbox and the stats after the replay
    if (!ui.stub) this._showResultsScreen();
    if (!this.replayWin || !this.hero || !this._playReplay({ intro: true })) this._showResultsScreen();
    console.info('[game] results', JSON.stringify({ score: stats.score, rank: stats.rank, judgements: stats.judgements, maxCombo: stats.maxCombo, body: stats.body, newBest: stats.newBest, replay: stats.replay, knockdowns: stats.knockdowns }));
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
      onTitle: () => this.setState('title'),
      onSkipReplay: () => this.skipReplay(),
    });
    // Photo Booth after a cleared run: strike a victory pose -> shareable card in the results panel
    const booth = this.ctx.booth, h = this._resHandle;
    if (booth && this.lastResults?.cleared && !this.ctx.settings.dev.autoplay) {
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
    this.director.setMode('replay', { cut: true });
    // CORE owns the boss-kill replay framing (VISUAL's own call then only extends the same shot)
    if (clip.pinned) this.cameraCut('bossKill', ReplayPlayer.duration(clip, REPLAY_SPEED) + 0.5);
    if (intro && !this._resIntro?.shown) this.ctx.ui.screens.hide();
    this._replayIntro = intro;
    this._lbox?.close(); this._lbox = null;
    // the player's own neon silhouette, locked to the 3D replay ("YOU · 0.35x"; the song->perf map is the live clock's)
    this._mirrorReplay = !!this._mirror('playReplay', { from: this.clock.toPerf(clip.t0), to: this.clock.toPerf(clip.t1), rate: REPLAY_SPEED });
    if (this._mirrorReplay && this.ctx.mirror?.canvas && !this.ctx.ui.replayOverlay) { try { this._inset?.close(); this._inset = mirrorInset(this.ctx.ui.root ?? document.body, this.ctx.mirror.canvas, `YOU · ${REPLAY_SPEED}×`); } catch { /* */ } }
    if (this.ctx.ui.stub && !this.ctx.ui.replayOverlay) { try { this._lbox = letterbox(this.ctx.ui.root ?? document.body, { label: clip.label || 'BEST MOMENT', speed: REPLAY_SPEED }); } catch { /* */ } }
    bus.emit('replay', {
      phase: 'start', on: true, intro, window: clip, label: clip.label || 'BEST MOMENT', speed: REPLAY_SPEED,
      seconds: ReplayPlayer.duration(clip, REPLAY_SPEED), bossKill: !!clip.pinned, letterbox: true,
    });
    this.replayCount = (this.replayCount || 0) + 1;
    return true;
  }
  _replayDone() {
    if (this.motion) this.motion.options.apply = true;
    if (this.state === 'results') this.director.setMode('results');
    const intro = this._replayIntro; this._replayIntro = false;
    this._lbox?.close(); this._lbox = null;
    this._inset?.close(); this._inset = null;
    this.ctx.bus.emit('replay', { phase: 'end', on: false, intro });
    if (intro) this._showResultsScreen();
  }

  // ======================================================================================== pause
  _startPause(prev, reason) {
    const { ui, audio } = this.ctx;
    const manual = reason === 'manual';
    this.paused = { from: prev, beat: this.clock.frameBeat, back: 0, countdown: -1, song: prev === 'boss' ? 'boss' : 'run', manual, reason };
    this.field.paused = true;
    audio.stopSong({ fadeMs: 400 });
    this._stopHum(); this.charge.reset();
    ui.hud.prompt(null); this._prompt = null; this._promptKey = null; this._promptWait = false;
    this._showPause();
    this.ctx.bus.emit('pause', {});
  }
  _showPause() {
    const p = this.paused;
    this.ctx.ui.screens.pause({
      reason: p.manual ? 'Paused' : p.reason || 'tracking-lost',
      onResume: () => { if (this.paused && this.paused.countdown < 0) { this.paused.manual = false; this._startCountdown(); } },
      onQuit: () => { this.paused = null; this.field.paused = false; this.state = 'run'; this.setState('title'); },
    });
  }
  _startCountdown() {
    const p = this.paused;
    p.countdown = 3; p.cdT = 0; this.ctx.ui.screens.countdown(3); this.ctx.audio.sfx('countdown', { pitch: 1 });
  }
  _updatePause(dt) {
    const p = this.paused;
    const present = this.tracking.lostFor < 0.25;
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
    if (this.awk) { this.awk.startBeat += shift; this.awk.endBeat += shift; }
    if (this._bannerAt != null) this._bannerAt += shift;
    this.field.paused = false;
    ui.screens.hide();
    const from = p.from;
    this.paused = null;
    this.state = from; this.prevState = 'pause';
    this.ctx.bus.emit('resume', {});
    this.ctx.bus.emit('state', { from: 'pause', to: from });
  }

  /** Brief bloom bump (blast, perfects, boss defeat); decays back to the preset's base intensity. */
  bloom(amount, dur = 0.35) {
    const b = this.ctx.post?.effects?.bloom;
    if (!b) return;
    this._bloomBase ??= b.intensity;
    this._bloomAdd = Math.max(this._bloomAdd || 0, amount); this._bloomDur = dur;
  }
  _updateBloom(dt) {
    const b = this.ctx.post?.effects?.bloom;
    if (!b || !this._bloomAdd) return;
    this._bloomAdd = Math.max(0, this._bloomAdd - dt * (this._bloomAdd / Math.max(0.05, this._bloomDur)) * 1.2 - dt * 0.05);
    b.intensity = this._bloomBase + this._bloomAdd;
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
      this._updatePrompt(fb);
      this._updateDistance(dt);
      this.rec.record(songT, fb);
      this.rec.scan(this.score.events, songT, { windowS: REPLAY_WIN });
      if (this.score.failed && this.state !== 'results') this.setState('results', { cleared: false });
    } else if (this.state === 'pause') {
      this._updatePause(dt);
    } else if (this.state === 'results') {
      if (this._replayAt && performance.now() > this._replayAt) this._playReplay();
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

  /** Hero pose for this frame: the replay drives it on the results screen, else the motion pipeline does. */
  get replaying() { return this.replay.active; }

  // ======================================================================================== inputs
  _onAction(name, info) {
    const s = this.state;
    if (!PLAY.has(s)) return;
    const sc = this.score;
    // body stats (all moves, judged or not)
    if (name.startsWith('punch')) { sc.move('punch'); sc.punchSpeed(info.speed); }
    else if (name.startsWith('kick')) sc.move('kick');
    else if (name === 'jump') { sc.move('jump'); this._startJump(); }
    else if (name === 'squat') sc.move('squat');
    else if (/^(lean|step)/.test(name)) sc.move('dodge');
    if (!/^(punch|kick|jump)/.test(name)) return;
    if (name.startsWith('punch') && this.charge.busy) return;     // the blast push reads as a jab: ignore
    const field = this.field;
    const W = this.awk?.waiting;
    if (W && !W.resolved && W.move !== 'guard') {
      if (Judge.actionFor(W) === name) { field.resolve(W, 'perfect', 0, 'hit'); return; }
      if (W.move === 'punch' && name.startsWith('punch')) { this._flashPrompt(W.side === 'left' ? 'OTHER HAND: ◀ LEFT' : 'OTHER HAND: RIGHT ▶'); return; }
      if (W.move === 'kick' && name.startsWith('kick')) { this._flashPrompt(W.side === 'left' ? 'OTHER LEG: ◀ LEFT' : 'OTHER LEG: RIGHT ▶'); return; }
    }
    if (name.startsWith('punch')) {
      const brute = field.brutePunchTarget();
      if (brute) {
        brute.hits++;
        this.ctx.audio.sfx('punchHit', { pan: name.endsWith('Left') ? -0.4 : 0.4 });
        try { brute.view?.impact?.(brute.hits >= 3 ? 'perfect' : 'good', this._v.set(name.endsWith('Left') ? 0.3 : -0.3, 0.1, 1).normalize()); } catch { /* */ }
        if (!brute.view?.impact) this.ctx.visuals.vfx.shockwave?.(brute.pos);
        this.ctx.visuals.stage.pulse(0.4);
        if (brute.hits >= 3) field.resolve(brute, brute.blockKind ?? 'good', brute.blockErr ?? 0, 'brute-finish');
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
    const hurt = kind === 'miss' && n.act !== 'awaken' && n.move !== 'blast' && !n.react && (challenge || hazard || n.move === 'guard');
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
      if (kind === 'perfect') { this.director.punchIn(1); visuals.stage.pulse(0.7); this.bloom(0.25, 0.25); }
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
    const o = this._v.copy(origin);           // hero space == world (the hero root sits at the origin)
    if (this.hero) o.applyMatrix4(this.hero.root.matrixWorld);
    const target = PLAY.has(s) ? this.field.coreTarget(this.fieldBeat) : null;
    const d = new THREE.Vector3();
    if (target) d.copy(target.pos ?? target.to).sub(o).normalize(); else d.copy(dir);
    try { visuals.vfx.blast(o.clone(), d, { target: target ? (target.pos ?? target.to)?.clone() : undefined }); } catch (e) { console.warn('[game] vfx.blast', e); }
    audio.sfx('blast');
    this.bloom(0.55, 0.45);                   // a short flash: the beam itself carries the shot
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
    else if (br) { text = 'PUNCH ×3!'; opts = { move: 'punch' }; }
    else if (this.charge.charged) { text = 'PUSH!'; opts = { move: 'blast' }; cue = 'blast'; cueT = 1; }
    else if (W && !W.resolved) {
      const p = AWAKEN_PROMPT[W.type];
      text = typeof p === 'string' ? p : p?.[W.side] ?? null;
      if (W.type === 'core' && this.charge.level > 0) text = 'KEEP THEM UP…';
      if (W.type === 'brute' && W.phase === 'punch') text = 'PUNCH ×3!';
      const secs = [...new Set(AWAKEN.sections.filter((x) => !(x.lower && upperOnlyOf(this.ctx.settings)) && !(x.seated === false && this.ctx.settings.seated)).map((x) => x.id))];
      const i = secs.indexOf(W.section);
      opts = { move: promptMove(W), wait: true, sub: AWAKEN_HINT[W.section], kicker: `AWAKENING · ${i + 1} / ${secs.length}` };
    } else {
      const r = this.field.reactTarget();
      if (r) { text = r.side === 'left' ? 'LEFT PUNCH NOW!' : 'RIGHT PUNCH NOW!'; opts = { move: promptMove(r), tone: 'warn' }; }
      else {
        const n = this.field.nextLive(this._promptable ??= (x) => (x.type !== 'striker' && x.type !== 'crawler') || (x.type === 'crawler' && (x.act === 0 || x.act === 'awaken')) || (x.waitFor && x.act === 'awaken'));
        if (n && n.beat - beat <= Math.max(SLOW.has(n.move) ? 2 : 1.5, n.teleBeats)) {
          text = n.type === 'volley' ? (n.side === 'left' ? 'LEAN RIGHT ▶' : '◀ LEAN LEFT') : n.type === 'crawler' ? (n.side === 'left' ? 'LEFT KICK!' : 'RIGHT KICK!')
            : n.type === 'striker' ? (n.side === 'left' ? '◀ LEFT PUNCH' : 'RIGHT PUNCH ▶') : PROMPT[n.type] ?? null;
          opts = { move: promptMove(n) };
          if (n.act === 'awaken' && n.section) opts.sub = AWAKEN_HINT[n.section];
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
      mode: sc.mode, knockdowns: sc.knockdowns, awaken: this.awk ? { offset: this.awk.offset, waiting: this.awk.waiting?.type ?? null } : null,
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
