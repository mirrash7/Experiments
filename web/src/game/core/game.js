// BREAKLIGHT gameplay core: the state machine and everything that happens between the tracker, the beat clock and
// the AUDIO / VISUAL / UI modules.
//
//   boot -> calibrate -> title -> (tutorial | settings) -> run (acts 0..2) -> boss -> results -> title
//   pause (from run / boss when the player is lost for > 1.5 s; resumes with a 3-2-1 countdown on a bar line)
import * as THREE from 'three';
import { ACTS, ActChart } from './chart.js';
import { SpiritField } from './spirits.js';
import { Judge } from './judge.js';
import { Score } from './score.js';
import { BossScript, BOSS_BEATS } from './boss.js';
import { ChargeDetector } from './charge.js';
import { ReplayRecorder, ReplayPlayer } from './replay.js';

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

export class Game {
  constructor(ctx, { clock, tracking, director, debug = null }) {
    this.ctx = ctx;
    this.clock = clock;
    this.tracking = tracking;
    this.director = director;
    this.debug = debug;
    const { bus, settings } = ctx;
    this.judge = new Judge({ clock, settings });
    this.score = new Score({ bus, hearts: settings.hearts ?? 5 });
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
    this.seed = settings.dev.seed ?? ((Math.random() * 1e6) | 0);
    this._offs = [];
    this._offs.push(bus.on('overdrive', ({ on }) => this._onOverdrive(on)));
  }

  /** Bind the motion pipeline (after the hero loads). */
  setMotion(motion) {
    this._actOff?.();
    this.motion = motion;
    this._actOff = motion.actions.on((name, info) => this._onAction(name, info));
  }
  setHero(hero) {
    this.hero = hero;
    this.heroH = hero.info?.height || 1.6;
    this.director.setHeroHeight(this.heroH);
    this.rec.setHero(hero);
  }
  setTrackerKind(kind) { this.judge.setTracker(kind); }

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
    if (s === 'results') { this.replay.stop(); this._replayDone(); }
    if (PLAY.has(s) && next !== 'pause') { this._stopHum(); this.charge.reset(); ui.hud.prompt(null); this._prompt = null; }
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
        ui.screens.calibrate({ recalibrate: true, onDone: () => { if (this.state === 'calibrate') this.setState('title'); } });   // the UI re-calibrates the pipeline on success
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
          onPlay: () => { audio.unlock(); this.setState('run'); },
          onTutorial: () => { audio.unlock(); this.setState('tutorial'); },
          onSettings: () => this.setState('settings'),
        });
        break;
      case 'settings':
        ui.screens.settings({
          settings,
          onChange: () => { try { audio.setVolume(settings.volume); if (settings.quality && this.ctx.quality.mode !== settings.quality) this.ctx.quality.setMode(settings.quality); } catch { /* */ } },
          onClose: () => { settings.save?.(); audio.setVolume(settings.volume); this.setState('title'); },
        });
        break;
      case 'tutorial': {
        this.director.setMode('tutorial');
        const steps = TUTORIAL_STEPS.filter((x) => !(settings.upperBodyOnly && x.lower));
        ui.screens.tutorial({ steps, onDone: () => this.setState('title') });
        break;
      }
      case 'run':
        if (prev === 'pause') break;
        this._startRun(opts.act ?? settings.dev.act ?? 0);
        break;
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
    const { ui } = this.ctx;
    this.score.reset(); this.score.emit();
    this.field.clear(); this.notesAll.length = 0;
    this.rec.clear();
    this.judge.log.length = 0; this.judge.errHist.length = 0;
    ui.screens.hide();
    ui.hud.show(true);
    ui.hud.setHealth(this.score.health, this.score.maxHealth);
    ui.hud.setScore(0); ui.hud.setCombo(0, 1); ui.hud.setFlow(0, false);
    this.charge.reset();
    this.boss = null;
    this.runStartPerf = performance.now();
  }

  _startRun(act) {
    const { audio } = this.ctx;
    this._resetRun();
    this.director.setMode('gameplay');
    let start = this.clock.nextBar(2);
    const b0 = audio.playSong('run', { startBeat: start });     // AUDIO returns the transport beat of the song's beat 0
    if (Number.isFinite(b0) && b0 >= start && b0 - start < 16) start = b0;
    this._startAct(act, start);
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
    const ch = this.chart;
    if (!ch) return;
    if (this._bannerAt != null && beat >= this._bannerAt - 0.05) {
      this.ctx.ui.hud.banner(...this._bannerText); this._bannerAt = null;
    }
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
    this.director.cut('bossIntro', 4.2);
    this.boss = new BossScript({
      view: visuals.boss, field: this.field, startBeat: start, upperBodyOnly: this.ctx.settings.upperBodyOnly,
      cb: {
        onPhase: (phase, info) => {
          bus.emit('boss', { phase, hp: info?.hp });
          if (phase === 'weak') ui.hud.banner('WEAK POINT!', 'Charge your Breaklight');
        },
        onDefeat: () => { this.bloom(1.6, 2.5); audio.sfx('victory'); ui.hud.banner('WARDEN DEFEATED'); this.score.bossDefeated = true; this.score.addBonus(5000); },
        onRetreat: () => { ui.hud.banner('THE WARDEN RETREATS'); },
      },
    });
    bus.emit('act', { act: 'boss' });
  }

  _updateBoss(dt, beat) {
    const b = this.boss;
    if (!b) return;
    b.update(dt, beat);
    if ((b.phase === 'defeat' && beat > b.endBeat) || b.phase === 'retreat') {
      if (!this._bossEndAt) this._bossEndAt = performance.now();
      if (performance.now() - this._bossEndAt > (b.phase === 'retreat' ? 1500 : 0)) { this._bossEndAt = 0; this.setState('results', { cleared: true }); }
    }
  }

  // ======================================================================================== results + replay
  _startResults({ cleared = !this.score.failed } = {}) {
    const { ui, audio, visuals } = this.ctx;
    this.field.clear();
    visuals.boss.hide?.();
    visuals.vfx.aura(false, {});
    visuals.stage.setAct('results');
    ui.hud.show(false);
    audio.setOverdrive(false);
    audio.playSong('results', { startBeat: this.clock.nextBar(1) });
    audio.sfx(cleared ? 'victory' : 'defeat');
    this.score.setOverdrive(false);
    const stats = this.score.results({ cleared });
    this.lastResults = stats;
    this.director.setMode('results');
    this.replayWin = this.rec.pickBest(this.score.events, 5);
    stats.replay = this.replayWin ? { seconds: +(this.replayWin.t1 - this.replayWin.t0).toFixed(2), hits: this.replayWin.hits, speed: 0.35 } : null;
    ui.screens.results({
      stats,
      onReplay: () => this._playReplay(),
      onAgain: () => { audio.unlock(); this.setState('run', { act: 0 }); },
      onTitle: () => this.setState('title'),
    });
    this._replayAt = performance.now() + 1200;
    console.info('[game] results', JSON.stringify({ score: stats.score, rank: stats.rank, judgements: stats.judgements, maxCombo: stats.maxCombo, body: stats.body }));
  }

  _playReplay() {
    if (!this.replayWin || !this.hero) return false;
    this._replayAt = 0;
    const ok = this.replay.start(this.replayWin, { speed: 0.35, onEnd: () => this._replayDone() });
    if (!ok) return false;
    if (this.motion) this.motion.options.apply = false;
    this.director.setMode('replay', { cut: true });
    this.ctx.bus.emit('replay', { on: true, window: this.replayWin });
    this.replayCount = (this.replayCount || 0) + 1;
    return true;
  }
  _replayDone() {
    if (this.motion) this.motion.options.apply = true;
    if (this.state === 'results') this.director.setMode('results');
    this.ctx.bus.emit('replay', { on: false });
  }

  // ======================================================================================== pause
  _startPause(prev, reason) {
    const { ui, audio } = this.ctx;
    const manual = reason === 'manual';
    this.paused = { from: prev, beat: this.clock.frameBeat, back: 0, countdown: -1, song: prev === 'boss' ? 'boss' : 'run', manual, reason };
    this.field.paused = true;
    audio.stopSong({ fadeMs: 400 });
    this._stopHum(); this.charge.reset();
    ui.hud.prompt(null); this._prompt = null;
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
    if (this.boss) { this.boss.start += shift; this.boss.endBeat += shift; }
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
      this.field.update(songT, beat, dt);
      this.charge.update(dt, this.motion, this.heroH);
      this._updateJump();
      this._updatePrompt(beat);
      if ((this._distT = (this._distT || 0) + dt) > 0.1) {
        this._distT = 0;
        try { const d = ui.measureDistance?.() ?? null; if (d !== this._dist) { this._dist = d; ui.hud.distance(d); } } catch { /* */ }
      }
      this.rec.record(songT, beat);
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
      if (this.state === 'title' && this.stateT > 2.5) { audio.unlock(); this.setState('run'); }
      if (this.state === 'calibrate' && this.stateT > 7) { this.motion?.calibrate(); this.setState('title'); }
    }
    this.stats.coreMs = performance.now() - t0;
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
    if (m) field.resolve(m.note, m.kind, m.errMs, m.wrong ? 'wrong' : 'hit');
  }

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
    const hazard = n.move === 'jump' || n.move === 'squat' || n.move === 'dodge';
    const hurt = kind === 'miss' && n.move !== 'blast' && !n.react;
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
    this._popup(n.hitPos ?? n.pos ?? n.to, kind, n.react || n.move === 'blast' ? undefined : errMs);
    bus.emit('judge', { kind, errMs, note: n, pos: n.pos, how });
  }

  _onBlock(n, kind, errMs) {
    const { audio, bus } = this.ctx;
    this.judge.record(n, kind, errMs);
    this.score.move('guard');
    audio.sfx('block'); audio.sfx(kind);
    try { n.view?.block?.(); } catch { /* */ }
    this.score.judge(kind, { songT: this.clock.frameNow });
    this._popup(n.view?.hitPoint ?? n.pos, kind, errMs, kind === 'miss' ? 'miss' : 'block');
    if (kind === 'perfect') this.director.punchIn(0.7);
    this.ctx.ui.hud.prompt('PUNCH ×3!'); this._prompt = 'PUNCH ×3!';
    bus.emit('judge', { kind, errMs, note: n, pos: n.pos, how: 'block' });
  }

  _popup(pos, kind, errMs, label = kind) {
    const { ui, visuals, camera, renderer } = this.ctx;
    if (!pos) return;
    try { visuals.vfx.judgement?.(pos, kind); } catch { /* */ }
    const v = this._v.copy(pos).project(camera);
    if (v.z > 1) return;
    const el = renderer.domElement;
    ui.hud.judgement({ x: (v.x * 0.5 + 0.5) * el.clientWidth, y: (-v.y * 0.5 + 0.5) * el.clientHeight }, label, { errMs: Number.isFinite(errMs) ? Math.round(errMs) : undefined });
  }

  _onBlast(origin, dir) {
    const { visuals, audio, bus } = this.ctx;
    const s = this.state;
    if (!PLAY.has(s) && s !== 'tutorial') return;
    this.score.move('blast');
    const o = this._v.copy(origin);           // hero space == world (the hero root sits at the origin)
    if (this.hero) o.applyMatrix4(this.hero.root.matrixWorld);
    const target = PLAY.has(s) ? this.field.coreTarget(this.clock.frameBeat) : null;
    const d = new THREE.Vector3();
    if (target) d.copy(target.pos ?? target.to).sub(o).normalize(); else d.copy(dir);
    try { visuals.vfx.blast(o.clone(), d); } catch (e) { console.warn('[game] vfx.blast', e); }
    audio.sfx('blast');
    this.bloom(1.1, 0.9);
    this._stopHum();
    if (visuals.stub && this.ctx.fx) this.ctx.fx.trauma = Math.min(1, (this.ctx.fx.trauma || 0) + 0.7);   // VISUAL shakes itself
    this.director.cut('blast', 1.7);
    bus.emit('blast', { origin: o, dir: d, target });
    if (!target) return;
    this.field.resolve(target, 'perfect', 0, 'blast');
    if (target.weak && this.boss) { audio.sfx('bossHit'); this.boss.blastHit(this.clock.frameBeat); }
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
    audio.setOverdrive(on);
    visuals.vfx.aura(on, { color: 0xffc840, strength: 0.8 });
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
  _updatePrompt(beat) {
    let text = null;
    const br = this.field.brutePunchTarget();
    if (br) text = 'PUNCH ×3!';
    else if (this.charge.charged) text = 'PUSH!';
    else {
      const r = this.field.reactTarget();
      if (r) text = r.side === 'left' ? 'LEFT PUNCH NOW!' : 'RIGHT PUNCH NOW!';
      else {
        const n = this.field.nextLive(this._promptable ??= (x) => (x.type !== 'striker' && x.type !== 'crawler') || (x.type === 'crawler' && x.act === 0));
        if (n && n.beat - beat <= Math.max(1.5, n.teleBeats)) {
          text = n.type === 'volley' ? (n.side === 'left' ? 'LEAN RIGHT ▶' : '◀ LEAN LEFT') : n.type === 'crawler' ? (n.side === 'left' ? 'LEFT KICK!' : 'RIGHT KICK!') : PROMPT[n.type] ?? null;
        }
      }
    }
    if (text !== this._prompt) { this._prompt = text; this.ctx.ui.hud.prompt(text); }
  }

  // ======================================================================================== debug / QA
  snapshot() {
    const sc = this.score, e = this.judge.errHist;
    const mean = e.length ? e.reduce((a, b) => a + b, 0) / e.length : 0;
    const sd = e.length ? Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / e.length) : 0;
    const r = this.ctx.renderer.info.render;
    return {
      fps: this.ctx.perf.fps, frameMs: this.ctx.perf.frameMs, frameMax: this.ctx.perf.frameMax, quality: this.ctx.quality?.preset?.id,
      state: this.state, act: this.act, beat: this.clock.frameBeat, clockLive: this.clock.live,
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
