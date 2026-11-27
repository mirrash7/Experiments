// Camera director (owner: CORE). It owns the camera transform; FX shake is added on top afterwards (fx.update).
//
// Base modes (setMode): 'title' | 'gameplay' | 'boss' | 'calibrate' | 'results' | 'tutorial' | 'replay'.
//   gameplay / boss: 3/4 over-the-shoulder rear, ~28 deg off the rear axis on the hero's RIGHT (screen left stays the
//   player's left: no mirroring), a little high, softly following the hero's hips (x/z, and y with jump headroom).
//
// Cinematic cuts (cut(name, dur?, opts?)), each authored as a function of the shot time and of live anchors
// (hero hips/head, the blast target, the boss weak point), so they frame what matters even if the stage changes:
//   'blast'     front 3/4 two-shot of the hero firing + the beam / target, camera kept ~2.5 m off the beam axis.
//               For a far target (the boss weak point) it cuts at ~45 % to a low rear 3/4 two-shot of the hero and
//               the beam converging on the weak point.
//   'bossKill'  low rear 3/4 two-shot: hero foreground left, Warden + defeat flash centre/right, sky clear at the top
//               for the banner, slow push. Triggered automatically when a blast takes the boss to hp 0 (bus 'boss').
//   'replayKill' the results replay of the boss kill (QA r2 P1-8 / art P2-6, r3 P2-2): first a level rear-side 3/4
//               from the hero's left composed on thirds (Warden core left third, the whole hero right third), slow push,
//               then just before the kill a close rear 3/4 two-shot from the hero's left: hero large in the foreground,
//               the Warden behind taking the beam. opts.killAt = kill time as a fraction of the clip (default 0.52).
//               While the director is in 'replay' mode a 'bossKill' request is the same shot (VISUAL asks for it).
//   'bossIntro' crane-up from the cloud sea over the hero's shoulder while the Warden rises, then a telephoto hold
//               on its face.
//   'frontCut'  short front glamour shot of the hero's face (3 variants, rotated). The director also schedules these
//               itself every ~20-30 s of gameplay, only in calm stretches: never within one beat of a required hit
//               or in a dense phrase (see setUpcoming / canFrontCut).
//   'replay', any SHOTS key: static framings.
//
// Wiring: bind(ctx) subscribes to ctx.bus ('blast', 'boss', 'judge', 'charge') and reads ctx.game / ctx.clock /
// ctx.visuals for the defaults. Without an explicit bind it binds itself to window.ctx on the first update.
// setUpcoming(fn): fn(aheadSec) -> seconds until the next required hit (Infinity if none within aheadSec).
import * as THREE from 'three';

// Framings in units of a 1.6 m hero (scaled by the loaded hero's height). pos / look are world positions.
export const SHOTS = {
  gameplay: { pos: [-1.6, 2.2, -3.0], look: [1.25, 0.95, 5.0], fov: 50 },
  boss: { pos: [-1.55, 2.05, -3.3], look: [1.6, 2.4, 12.0], fov: 54 },
  calibrate: { pos: [0, 1.3, 4.3], look: [0, 0.95, 0], fov: 36 },
  results: { pos: [0.75, 1.3, 3.5], look: [0.15, 1.0, 0], fov: 34 },
  tutorial: { pos: [-1.3, 2.0, -3.0], look: [0.75, 0.95, 3.5], fov: 48 },
  // static fallbacks of the dynamic shots (used when no anchors are known)
  blast: { pos: [3.3, 1.2, 2.5], look: [-0.2, 1.25, 1.4], fov: 38 },
  blastFar: { pos: [-1.75, 0.95, -2.3], look: [0.3, 1.8, 20], fov: 44 },
  bossKill: { pos: [-1.3, 1.0, -2.7], look: [0.2, 2.6, 30], fov: 46 },
  bossIntro: { pos: [-1.45, 1.55, -3.4], look: [0, 3, 30], fov: 40 },
  frontCut: { pos: [0.95, 1.52, 2.05], look: [0.04, 1.4, 0], fov: 30 },
  replay: { pos: [0.6, 1.25, 3.0], look: [0, 1.0, 0.2], fov: 36 },
  replayKill: { pos: [1.25, 1.2, 2.25], look: [0, 1.15, 0], fov: 34 },
};

// front glamour variants: camera offset from the hero's hips (x/z) / ground (y), aimed at the face; drift per second
const FRONT = [
  { pos: [0.95, 1.5, 2.0], fov: 29, drift: [-0.22, 0.02, -0.05], aimY: -0.02 },   // 3/4 from the hero's left, eye level
  { pos: [-1.1, 1.05, 2.15], fov: 34, drift: [0.16, 0.06, -0.08], aimY: 0.02 },   // low heroic 3/4 from the right
  { pos: [0.2, 1.4, 2.7], fov: 27, drift: [0.0, 0.0, -0.35], aimY: -0.05 },       // straight front, slow push
];
const FRONT_GAP = [20, 30];          // seconds between automatic front cuts
const FRONT_DUR = 1.5;

const DEFAULT_DUR = { blast: 1.7, bossKill: 5.2, bossIntro: 4.2, frontCut: FRONT_DUR, replayKill: 8.8 };
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'title';
    this.shot = null; this.shotLeft = 0; this.shotT = 0; this.shotDur = 0; this.shotOpts = {};
    this.heroH = 1.6;
    this.pos = new THREE.Vector3(0, 1.6, 4); this.look = new THREE.Vector3(0, 1, 0);
    this.goalPos = new THREE.Vector3(); this.goalLook = new THREE.Vector3();
    this.fov = 40; this.goalFov = 40;
    this.kick = 0;                  // punch-in envelope 0..1 (read-only for callers)
    this._kickAmp = 0; this._kickT = 9;
    this.t = 0;
    this.follow = new THREE.Vector3();
    this._hips = new THREE.Vector3(); this._head = new THREE.Vector3(); this._haveHero = false;
    this._hipsRest = NaN;
    this._snap = true;
    this.blend = 3.2;               // 1/s
    this._phase = null;
    this._blastTarget = null; this._blastOrigin = new THREE.Vector3();
    this._bossFocus = new THREE.Vector3(); this._bossFocusOk = false;
    this.blastFrontFirst = false;
    this._frontI = -1; this._frontBase = new THREE.Vector3();
    this._sinceFront = 0; this._frontGap = FRONT_GAP[0] * 0.6; this.autoFrontCuts = true;
    this._judgeTimes = []; this._charge = 0;
    this.upcomingHit = null;
    this.ctx = null; this._offs = [];
  }
  setHeroHeight(h) { this.heroH = h || 1.6; }
  /** True for every name cut() understands (dynamic shots + SHOTS framings). */
  hasShot(name) { return name === 'title' || name in SHOTS; }

  /** Bind to the game ctx (bus events + defaults for upcomingHit / boss anchors). Safe to call twice. */
  bind(ctx) {
    if (!ctx || this.ctx === ctx) return this;
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.ctx = ctx;
    const bus = ctx.bus;
    if (bus?.on) {
      this._offs.push(bus.on('blast', (e) => {
        const tp = e?.target?.pos ?? e?.target?.to ?? null;
        this._blastTarget = tp ? (this._blastTarget ?? new THREE.Vector3()).copy(tp) : null;
        if (e?.origin) this._blastOrigin.copy(e.origin);
      }));
      this._offs.push(bus.on('boss', (e) => {
        if (e && e.phase === 'stagger' && e.hp != null && e.hp <= 0) this.cut('bossKill');
      }));
      this._offs.push(bus.on('judge', () => { this._judgeTimes.push(this.t); if (this._judgeTimes.length > 16) this._judgeTimes.shift(); }));
      this._offs.push(bus.on('charge', (e) => { this._charge = e?.level ?? 0; }));
      this._offs.push(bus.on('state', (e) => { if (e?.to === 'run') { this._sinceFront = 0; this._frontGap = 12 + Math.random() * 6; } }));
    }
    return this;
  }
  /** fn(aheadSec) -> seconds until the next required hit, Infinity if none within aheadSec. */
  setUpcoming(fn) { this.upcomingHit = typeof fn === 'function' ? fn : null; }

  /** Base mode: 'title' | 'gameplay' | 'boss' | 'calibrate' | 'results' | 'tutorial' | 'replay'. */
  setMode(mode, { cut = false } = {}) {
    if (mode !== this.mode && this._crosses(mode)) cut = true;
    this.mode = mode;
    if (cut) this._snap = true;
  }

  /**
   * Cinematic shot for `dur` seconds, then back to the base mode.
   * name: 'blast' | 'bossKill' | 'bossIntro' | 'frontCut' | 'replay' | any SHOTS key.
   * opts: { target?: Vector3 (blast target), variant?: 0..2 (frontCut) }
   */
  cut(shot, dur, opts = {}) {
    if (shot === 'bossKill' && (this.mode === 'replay' || this.shot === 'replayKill')) shot = 'replayKill';
    dur = dur ?? DEFAULT_DUR[shot] ?? 1.6;
    // the same shot requested again (e.g. auto bossKill + an explicit call): keep it running, extend
    if (shot === this.shot && this.shotT < 1) { this.shotLeft = Math.max(this.shotLeft, dur - this.shotT); this.shotDur = Math.max(this.shotDur, dur); return true; }
    if ((this.shot === 'bossKill' || this.shot === 'replayKill') && shot === 'blast') return false;   // never interrupt the kill shot
    if (shot === 'frontCut') {
      // never cover a required hit: shorten to end one beat before it, skip if that leaves too little
      const room = this._roomBeforeHit();
      if (room < dur) { if (room < 0.7) return false; dur = room; }
      this._frontI = opts.variant ?? (this._frontI + 1) % FRONT.length;
      this._frontBase.copy(this._haveHero ? this._hips : _a.set(0, 0, 0)).setY(0);
      this._sinceFront = 0; this._frontGap = FRONT_GAP[0] + Math.random() * (FRONT_GAP[1] - FRONT_GAP[0]);
    }
    if (shot === 'blast' && opts.target) this._blastTarget = (this._blastTarget ?? new THREE.Vector3()).copy(opts.target);
    if (shot === 'bossIntro') this._bossFocusOk = false;
    this.shot = shot; this.shotLeft = dur; this.shotT = 0; this.shotDur = dur; this.shotOpts = opts; this._rkOpen = null;
    this._phase = null;
    this._snap = true;
    return true;
  }
  endShot({ cut = true } = {}) {
    if (!this.shot) return;
    if (this.shot === 'blast') this._blastTarget = null;
    this.shot = null; this._phase = null;
    if (cut || this._crosses(this.mode)) this._snap = true;
  }
  /** Perfect-hit punch-in: ~5 deg FOV + ~8 % dolly toward the hero, 50 ms attack, fast recovery. */
  punchIn(strength = 1) {
    const cur = this._kickEnv();
    this._kickAmp = Math.min(1, Math.max(cur, 0.55 + 0.45 * strength));
    this._kickT = cur > 0.05 ? 0.05 : 0;
  }
  /** True when an automatic / requested front cut would not cover a required hit. */
  canFrontCut(dur = FRONT_DUR) { return this._roomBeforeHit() >= dur && this._calm(); }

  // ------------------------------------------------------------------------------------------ internals
  _kickEnv() {
    const t = this._kickT;
    if (t < 0.05) return this._kickAmp * (t / 0.05);
    return this._kickAmp * Math.exp(-(t - 0.05) / 0.14);
  }
  _beat() { return this.ctx?.clock?.beatDur || 60 / 128; }
  _upcoming(ahead) {
    try {
      if (this.upcomingHit) { const v = this.upcomingHit(ahead); return Number.isFinite(v) ? v : Infinity; }
      const g = this.ctx?.game, clk = this.ctx?.clock;
      if (!g?.field || !clk) return Infinity;
      const now = clk.frameNow;
      let best = Infinity;
      for (const arr of [g.field.live, g.field.pending]) {
        for (const n of arr) {
          if (n.resolved || n.cancelled) continue;
          if (n.react && n.live) return 0;                     // a reaction spirit is up: busy now
          const dt = clk.timeAtBeat(n.beat) - now;
          if (dt > -0.35 && dt < best) best = dt;
        }
      }
      if (g.charge?.busy || g.charge?.level > 0) best = Math.min(best, 0);
      return best <= ahead ? Math.max(0, best) : Infinity;
    } catch { return 0; }
  }
  /** Seconds a front cut may last and still leave one beat (+ margin) of gameplay view before the next hit. */
  _roomBeforeHit() {
    const up = this._upcoming(6);
    return up === Infinity ? 99 : up - this._beat() - 0.15;
  }
  _calm() {
    if (this._charge > 0.02) return false;
    let recent = 0;
    for (const t of this._judgeTimes) { const ago = this.t - t; if (ago < 1.2) return false; if (ago < 6) recent++; }
    return recent <= 3;
  }

  // blending from one side of the hero to the other would fly through it: cut instead
  _crosses(mode) {
    const S = SHOTS[mode]; if (!S) return false;
    return Math.sign(S.pos[2]) !== Math.sign(this.pos.z) && Math.abs(this.pos.z) > 0.5;
  }

  _static(name) {
    const k = this.heroH / 1.6;
    const S = SHOTS[name] ?? SHOTS.gameplay;
    this.goalPos.set(S.pos[0] * k, S.pos[1] * k, S.pos[2] * k);
    this.goalLook.set(S.look[0] * k, S.look[1] * k, S.look[2] * (Math.abs(S.look[2]) > 4 ? 1 : k));
    this.goalFov = S.fov;
  }

  /** Aim goalLook from goalPos so every point fits (with padding); weights steer the composition. */
  _frame(points, weights, { minFov = 30, maxFov = 62, pad = 1.25, bias = null } = {}) {
    const p0 = this.goalPos;
    _f.set(0, 0, 0);
    for (let i = 0; i < points.length; i++) _f.addScaledVector(_q.copy(points[i]).sub(p0).normalize(), weights[i] ?? 1);
    if (bias) _f.add(bias);
    _f.normalize();
    _r.crossVectors(_f, _up).normalize(); _u.crossVectors(_r, _f);
    let ax = 0, ay = 0;
    for (const p of points) {
      _q.copy(p).sub(p0);
      const z = Math.max(1e-3, _q.dot(_f));
      ax = Math.max(ax, Math.abs(Math.atan2(_q.dot(_r), z)));
      ay = Math.max(ay, Math.abs(Math.atan2(_q.dot(_u), z)));
    }
    const aspect = this.camera.aspect || 1.6;
    const vHalf = Math.max(ay, Math.atan(Math.tan(ax) / aspect)) * pad;
    this.goalFov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * vHalf), minFov, maxFov);
    this.goalLook.copy(p0).addScaledVector(_f, 10);
  }

  /**
   * replayKill opening: azimuth a (from straight behind the hero toward its left), distance d, fov and look direction
   * so that the hero's body centre sits at +1/3 of the screen width and the weak point at -1/3, with the whole hero
   * (feet to raised hands, ~1.15 x its height) inside the letterboxed picture (~76 % of the frame height).
   */
  _solveReplayOpen(hips, wp, k) {
    const aspect = this.camera.aspect || 1.78, vis = 0.76;
    const camY = 1.12 * k, heroC = new THREE.Vector3(hips.x, 0.88 * k, hips.z), heroSpan = 1.15 * this.heroH;
    let best = null;
    for (let deg = 70; deg >= 20; deg -= 5) {
      const a = THREE.MathUtils.degToRad(deg), ux = Math.sin(a), uz = -Math.cos(a);
      let d = 3.2 * k, sol = null;
      for (let it = 0; it < 4; it++) {
        const C = new THREE.Vector3(heroC.x + ux * d, camY, heroC.z + uz * d);
        const dh = heroC.clone().sub(C), dw = wp.clone().sub(C);
        const yh = Math.atan2(dh.x, dh.z), yw = Math.atan2(dw.x, dw.z);
        let dy = yw - yh; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const alpha = Math.abs(dy) / 2;
        const hHalf = Math.atan(3 * Math.tan(Math.max(alpha, THREE.MathUtils.degToRad(6))));
        const vHalf = Math.atan(Math.tan(hHalf) / aspect);
        // hero span must fill <= 62 % of the visible (letterboxed) height
        const need = heroSpan / (0.62 * vis * 2 * Math.tan(vHalf));
        const yawF = yh + dy / 2;
        // tilt up just enough that the hero's centre sits 20 % of the half-height below the middle: feet and raised
        // hands stay inside the letterbox, the Warden's core rises into the upper-left third
        const pitch = Math.atan2(heroC.y - camY, Math.hypot(dh.x, dh.z)) + vHalf * 0.2;
        sol = { a, ux, uz, d, alpha, fov: THREE.MathUtils.radToDeg(2 * vHalf), yawF, pitch };
        if (Math.abs(need - d) < 0.02) break;
        d = THREE.MathUtils.clamp(need, 2.2 * k, 9 * k);
      }
      const fovOk = sol.fov >= 28 && sol.fov <= 60;
      if (fovOk) { best = sol; break; }          // the most side-on azimuth whose composition fits
      if (!best || Math.abs(sol.fov - 44) < Math.abs(best.fov - 44)) best = sol;
    }
    const f = new THREE.Vector3(Math.sin(best.yawF) * Math.cos(best.pitch), Math.sin(best.pitch), Math.cos(best.yawF) * Math.cos(best.pitch));
    return { ux: best.ux, uz: best.uz, d: best.d, y: camY, fov: THREE.MathUtils.clamp(best.fov, 28, 60), fx: f.x, fy: f.y, fz: f.z, deg: THREE.MathUtils.radToDeg(best.a) };
  }

  _heroPoints() {
    const k = this.heroH / 1.6;
    if (this._haveHero) { _b.copy(this._head); _c.copy(this._hips); }
    else { _b.set(0, 1.45 * k, 0); _c.set(0, 0.95 * k, 0); }
    return [_b, _c];
  }
  _bossAnchors() {
    const V = this.ctx?.visuals;
    const wp = V?.boss?.weakPoint;
    const w = wp && wp.lengthSq() > 1 ? _c.copy(wp) : _c.set(0, -2, 126);
    // the Warden's face: VISUAL's boss.head(out) / boss.headPoint (fn, Vector3 or Object3D), else estimated from the weak point
    const head = V?.boss?.headPoint ?? V?.boss?.head;
    if (typeof head === 'function') { try { head(_d); } catch { _d.set(0, 0, 0); } }
    else if (head?.isObject3D) head.getWorldPosition(_d);
    else if (head?.isVector3 && head.lengthSq() > 1) _d.copy(head);
    else { const dist = Math.hypot(w.x, w.z); _d.set(w.x, w.y + dist * 0.3, w.z); }
    if (_d.y < w.y + 1) _d.y = w.y + Math.hypot(w.x, w.z) * 0.3;
    return [w, _d];
  }

  _goal(name, t) {
    const k = this.heroH / 1.6;
    const dur = Math.max(0.1, this.shotDur);
    switch (name) {
      case 'title': {
        // orbit limited to +-60 deg around the front
        const a = Math.sin(t * 0.12) * 1.0, r = 4.3 * k;
        this.goalPos.set(Math.sin(a) * r, 1.55 * k, Math.cos(a) * r);
        this.goalLook.set(0, 0.95 * k, 0);
        this.goalFov = 36;
        return;
      }
      case 'frontCut': {
        const F = FRONT[Math.max(0, this._frontI) % FRONT.length];
        const b = this._frontBase;
        this.goalPos.set(b.x + (F.pos[0] + F.drift[0] * t) * k, (F.pos[1] + F.drift[1] * t) * k, b.z + (F.pos[2] + F.drift[2] * t) * k);
        if (this._haveHero) this.goalLook.copy(this._head).add(_a.set(0, F.aimY * k - 0.04 * k, 0));
        else this.goalLook.set(0, 1.4 * k, 0);
        this.goalFov = F.fov;
        this._phase = 'front';
        return;
      }
      case 'blast': {
        // two beats: a low rear 3/4 two-shot (hero foreground, the beam receding into the target: the beam is
        // ~3 m thick at full power, so only a view down its length doesn't blow out), then, as the beam thins, a
        // front 3/4 two-shot from the hero's left (face + follow-through + the target), ~3.5 m off the beam axis.
        // blastFrontFirst = true swaps the order (for a thinner beam).
        const tgt = this._blastTarget;
        const [head, hips] = this._heroPoints();
        const split = dur * 0.48;
        const rear = this.blastFrontFirst ? t >= split : t < split;
        const u = rear === !this.blastFrontFirst ? Math.min(1, t / split) : Math.min(1, (t - split) / Math.max(0.1, dur - split));
        const aim = _d;
        if (rear) {
          this.goalPos.set((-1.75 + 0.2 * u) * k + hips.x * 0.5, (0.95 + 0.12 * u) * k, (-2.3 + 0.3 * u) * k + hips.z * 0.5);
          if (tgt) aim.copy(tgt); else aim.set(hips.x, 1.6 * k, 14);
          this._frame([head, hips, aim], [1.0, 0.5, 1.6], { minFov: 36, maxFov: 58, pad: 1.18 });
          this._setPhase('rear');
          return;
        }
        this.goalPos.set((3.3 - 0.35 * u) * k + hips.x, (1.2 + 0.05 * u) * k, (2.5 - 0.2 * u) * k + hips.z);
        if (tgt && tgt.z < 12) aim.copy(tgt);
        else aim.set(hips.x * 0.5, 1.3 * k, 4.0 * k);           // a stretch of the beam heading out of frame
        this._frame([head, hips, aim], [1.3, 0.7, 1.0], { minFov: 26, maxFov: 48, pad: 1.15 });
        this._setPhase('front');
        return;
      }
      case 'bossKill': {
        const u = Math.min(1, t / dur);
        const [head, hips] = this._heroPoints();
        const hp = _a.copy(head);
        const hh = _b.copy(hips);
        const [wp, bh] = this._bossAnchors();
        this.goalPos.set((-1.15 + 0.2 * u) * k + hh.x * 0.5, (1.0 + 0.2 * smooth(u)) * k, (-2.35 + 0.4 * smooth(u)) * k + hh.z * 0.5);
        this._frame([hp, hh, wp, bh], [1.2, 0.55, 1.3, 0.7], { minFov: 38, maxFov: 60, pad: 1.12 });
        return;
      }
      case 'replayKill': {
        const [head, hips] = this._heroPoints();
        const hp = _a.copy(head), hh = _b.copy(hips);
        const killAt = Number.isFinite(this.shotOpts?.killAt) ? Math.min(0.9, Math.max(0.2, this.shotOpts.killAt)) : 0.52;
        const split = Math.max(1.2, killAt * Math.max(0.5, dur - 0.5) - 0.7);
        if (t < split) {
          // opening (QA r3 art P2-2): a level rear-side 3/4 from the hero's left, composed on thirds: the Warden's core
          // on the left third, the hero's whole body (head clear of the raised arms) on the right third, slow push in.
          // The camera azimuth / distance are solved once at the shot start (no swimming), from the real anchors.
          const u = smooth(t / split);
          const [wp] = this._bossAnchors();
          const R = this._rkOpen ??= this._solveReplayOpen(hh, wp, k);
          this.goalPos.set(hh.x + R.ux * R.d * (1 - 0.07 * u), R.y, hh.z + R.uz * R.d * (1 - 0.07 * u));
          this.goalLook.copy(this.goalPos).addScaledVector(_q.set(R.fx, R.fy, R.fz), 10);
          this.goalFov = R.fov * (1 - 0.04 * u);
          this._setPhase('side');
          return;
        }
        // close rear 3/4 two-shot: hero large in the foreground (left), the Warden behind taking the beam
        const u = smooth((t - split) / Math.max(0.1, dur - split));
        const [wp, bh] = this._bossAnchors();
        this.goalPos.set(hh.x + (1.35 - 0.1 * u) * k, (1.0 + 0.18 * u) * k, hh.z + (-1.95 + 0.3 * u) * k);
        this._frame([hp, hh, wp, bh], [1.5, 0.8, 1.0, 0.45], { minFov: 40, maxFov: 60, pad: 1.1 });
        this._setPhase('two');
        return;
      }
      case 'bossIntro': {
        const split = dur * 0.66;
        const [wp, bh] = this._bossAnchors();
        if (t < split) {
          // crane up over the hero's right shoulder from cloud-sea level, tracking the rising Warden
          const u = smooth(t / split);
          this.goalPos.set((-1.45 + 0.35 * u) * k, (1.45 + 0.95 * u) * k, (-3.4 - 2.2 * u) * k);
          const mid = _a.lerpVectors(wp, bh, 0.4);
          if (!this._bossFocusOk) { this._bossFocus.copy(mid); this._bossFocusOk = true; }
          else this._bossFocus.lerp(mid, 0.15);
          const [head, hips] = this._heroPoints();
          this._frame([head, hips, this._bossFocus], [0.7, 0.35, 1.3], { minFov: 40, maxFov: 60, pad: 1.1 });
          this._setPhase('crane');
          return;
        }
        // telephoto hold on the face (eyes light up)
        const u = (t - split) / Math.max(0.1, dur - split);
        this.goalPos.set(-0.5 * k, 1.7 * k, -2.0 * k);
        this.goalLook.copy(bh);
        this.goalFov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan2((bh.y - wp.y) * 0.62, Math.hypot(bh.x, bh.z))), 8, 40) * (1 - 0.12 * smooth(u));
        this._setPhase('face');
        return;
      }
      default: break;
    }
    this._static(name);
    if (name === 'replay' || name === 'results') {         // slow drift around the front
      const a = Math.sin(t * 0.18) * 0.32;
      const x = this.goalPos.x, z = this.goalPos.z;
      this.goalPos.x = x * Math.cos(a) + z * Math.sin(a); this.goalPos.z = -x * Math.sin(a) + z * Math.cos(a);
    }
  }
  _setPhase(p) { if (this._phase !== null && this._phase !== p) this._snap = true; this._phase = p; }

  _autoFront(dt) {
    if (!this.autoFrontCuts || this.mode !== 'gameplay' || this.shot || !this.ctx) return;
    if (this.ctx.game && this.ctx.game.state !== 'run') return;
    this._sinceFront += dt;
    if (this._sinceFront < this._frontGap) return;
    if (this._calm() && this._roomBeforeHit() >= FRONT_DUR) this.cut('frontCut', FRONT_DUR);
  }

  update(dt, hero) {
    if (!this.ctx && typeof window !== 'undefined' && window.ctx?.bus) this.bind(window.ctx);
    this.t += dt;
    // hero anchors
    this._haveHero = false;
    if (hero?.bones?.hips) {
      hero.bones.hips.getWorldPosition(this._hips);
      const hb = hero.bones.head ?? hero.bones.neck;
      if (hb) hb.getWorldPosition(this._head); else this._head.copy(this._hips).setY(this._hips.y + this.heroH * 0.35);
      this._haveHero = true;
      if (!Number.isFinite(this._hipsRest)) this._hipsRest = this._hips.y;
      else if (this._hips.y < this._hipsRest + 0.06) this._hipsRest += (this._hips.y - this._hipsRest) * Math.min(1, dt * 0.5);
    }
    this._autoFront(dt);
    if (this.shot) {
      this.shotT += dt;
      // a front cut gives way as soon as a hit comes within a beat
      if (this.shot === 'frontCut' && this.shotT > 0.3 && this._roomBeforeHit() < 0) this.endShot();
      else if ((this.shotLeft -= dt) <= 0) this.endShot();
    }
    this._goal(this.shot ?? this.mode, this.shot ? this.shotT : this.t);
    // gameplay: soft follow of the hero's hips (step dodges, leans, jump headroom)
    if (this._haveHero && !this.shot && (this.mode === 'gameplay' || this.mode === 'boss' || this.mode === 'tutorial')) {
      const a = 1 - Math.exp(-dt * 2.5);
      const rise = Math.max(0, this._hips.y - this._hipsRest);
      this.follow.x += (this._hips.x * 0.5 - this.follow.x) * a;
      this.follow.z += (this._hips.z * 0.4 - this.follow.z) * a;
      this.follow.y += (rise * 0.55 - this.follow.y) * (1 - Math.exp(-dt * 4));
      this.goalPos.x += this.follow.x; this.goalLook.x += this.follow.x * 0.6;
      this.goalPos.z += this.follow.z; this.goalLook.z += this.follow.z;
      this.goalPos.y += this.follow.y * 0.8; this.goalLook.y += this.follow.y;
    }
    if (this._snap || this.shot) {
      // authored shots are exact (no lag); FOV still eases a little within a shot
      const snapFov = this._snap;
      this.pos.copy(this.goalPos); this.look.copy(this.goalLook);
      if (snapFov) this.fov = this.goalFov; else this.fov += (this.goalFov - this.fov) * (1 - Math.exp(-dt * 10));
      this._snap = false;
    } else {
      const a = 1 - Math.exp(-dt * this.blend);
      this.pos.lerp(this.goalPos, a); this.look.lerp(this.goalLook, a); this.fov += (this.goalFov - this.fov) * a;
    }
    // punch-in: 50 ms in, ~0.3 s out: ~5 deg FOV + ~8 % dolly toward the hero (gameplay framings only)
    this._kickT += dt;
    const kk = this.shot ? 0 : this._kickEnv();
    this.kick = kk;
    const cam = this.camera;
    cam.position.copy(this.pos);
    if (kk > 1e-4) {
      const toHero = this._haveHero ? _a.copy(this._hips).sub(this.pos) : _a.copy(this.look).sub(this.pos).setLength(3.2);
      cam.position.addScaledVector(toHero, 0.08 * kk);
    }
    cam.lookAt(this.look);
    const fov = this.fov - 5 * kk;
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
}
