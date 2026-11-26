// Spirit field: spawns notes as SpiritViews at the rift, flies them along paths that reach their hit point exactly on
// the target beat, drives the telegraph, and resolves outcomes (hit / dodged / struck the hero) through the game's
// callbacks. Positions are pure functions of the beat (no integration), so pauses, hit-stops and replays stay exact.
import * as THREE from 'three';

const TELE_EPS = 1e-6;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const _v = new THREE.Vector3();

/**
 * Hit point of a note in world space (hero at the origin facing +Z, its left = +X), scaled to the hero height h.
 * Staging for the 3/4 rear gameplay camera, which sits ~28 deg off axis on the hero's RIGHT (-X): strikes land at
 * arm's / leg's reach in front of the hero, the left ones pushed wider so they clear the torso from that camera and
 * read beside the left fist; volleys pass beside the shoulder; the brute stops at striking distance; reaction
 * strikers pop up farther out where they can't hide behind the hero.
 */
export function hitPointFor(note, h, out) {
  const k = h / 1.6, sx = note.side === 'left' ? 1 : note.side === 'right' ? -1 : 0;
  const lat = (r, l) => (sx > 0 ? l : sx < 0 ? -r : 0) * k;     // right-side / left-side lateral offset
  if (note.react && note.type === 'striker') return out.set(lat(0.72, 0.82), 0.84 * h, 1.15 * k);
  switch (note.type) {
    case 'striker': return out.set(lat(0.44, 0.62), 0.78 * h, 0.72 * k);
    case 'crawler': return out.set(lat(0.3, 0.38), 0.2, 0.82 * k);
    case 'sweep': return out.set(0, 0.12, 0);
    case 'scythe': return out.set(0, 0.9 * h, 0);
    case 'volley': return out.set(lat(0.5, 0.55), 0.8 * h, 0.12 * k);
    case 'brute': return out.set(0, 0, 2.05 * k);
    case 'core': return out.set(0, 0.86 * h, 2.1 * k);
    default: return out.set(0, h * 0.7, 0.7 * k);
  }
}

/** Where an unanswered strike lunges after its beat (the hero's chest / shins). */
const LUNGE_BEATS = 0.45;
function lungePoint(n, out) {
  return out.set(n.to.x * 0.25, n.type === 'crawler' ? n.to.y : n.to.y * 0.92, 0.12);
}

/**
 * Path position of a note at a beat (pure function of the note's path params; also used by the replay).
 * Flyers curve in from the rift and reach `to` exactly on n.beat: a lateral hook (`swirl`) that peaks late (~70 % of
 * the flight) so the curve reads from the rear camera, plus a vertical arc. Strikes not answered by their beat lunge
 * at the hero; hazards keep going past; the brute walks in and arrives a beat early; cores and reaction strikers
 * hold their spot.
 */
export function pathPos(n, beat, p) {
  const arriveBeat = n.type === 'brute' ? n.beat - 1 : n.beat;
  const span = Math.max(1e-3, arriveBeat - n.spawnBeat);
  const s = (beat - n.spawnBeat) / span;
  if (s <= 1) {
    const u = clamp01(s);
    const e = n.type === 'brute' ? u : u * (0.85 + 0.15 * u);   // slight acceleration into the strike
    p.lerpVectors(n.from, n.to, e);
    if (n.arc) p.y += n.arc * Math.sin(Math.PI * Math.pow(u, 1.25)) * (1 - u * 0.4);
    if (n.swirl) p.x += n.swirl * Math.sin(Math.PI * u * u);
  } else if (n.type === 'brute' || n.type === 'core' || n.react) {
    p.copy(n.to);
    if (n.type === 'core') p.y += Math.sin(beat * 1.3) * 0.08;
  } else if (n.type === 'striker' || n.type === 'crawler') {
    const u = clamp01((beat - n.beat) / LUNGE_BEATS);
    p.lerpVectors(n.to, lungePoint(n, _l), u * u);
  } else {
    p.copy(n.to).addScaledVector(n.dir, (beat - n.beat) * n.speed);
  }
  return p;
}
const _l = new THREE.Vector3();

export class SpiritField {
  /**
   * @param {object} o
   * @param {object} o.ctx       shared ctx (visuals via o.getVisuals)
   * @param {function} o.getVisuals  () => Visuals
   * @param {object} o.clock     game clock
   * @param {object} o.judge
   * @param {object} o.cb        { onResolve(note, kind, errMs, how), onSpawn(note) }
   */
  constructor({ getVisuals, clock, judge, cb, heroHeight = () => 1.6 }) {
    this.getVisuals = getVisuals;
    this.clock = clock;
    this.judge = judge;
    this.cb = cb;
    this.heroHeight = heroHeight;
    this.pending = [];       // generated, not spawned yet (sorted by spawnBeat on insert)
    this.live = [];          // spawned (view exists), unresolved or finishing
    this.nextId = 1;
    this.paused = false;
  }

  add(note) {
    note.id = this.nextId++;
    note.live = false; note.resolved = false; note.view = null;
    let i = this.pending.length;
    while (i > 0 && this.pending[i - 1].spawnBeat > note.spawnBeat) i--;
    this.pending.splice(i, 0, note);
  }

  /** Remove everything (state change). */
  clear() {
    for (const n of this.live) if (!n.resolved) n.view?.release?.();
    this.live.length = 0; this.pending.length = 0;
  }

  /** Pause: views released, unresolved notes go back to pending shifted by `beats` (whole bars) on resume. */
  shift(beats) {
    const back = [];
    for (const n of this.live) {
      if (!n.resolved) { n.view?.release?.(); n.view = null; n.live = false; back.push(n); }
    }
    this.live.length = 0;
    for (const n of [...back, ...this.pending]) { n.beat += beats; n.spawnBeat += beats; }
    this.pending = [...back, ...this.pending].sort((a, b) => a.spawnBeat - b.spawnBeat);
  }

  /** Earliest unresolved live note (for prompts), or null. */
  nextLive(filter) {
    let best = null;
    for (const n of this.live) if (!n.resolved && (!filter || filter(n)) && (!best || n.beat < best.beat)) best = n;
    return best;
  }

  _spawn(n) {
    const V = this.getVisuals();
    const h = this.heroHeight();
    n.to = hitPointFor(n, h, new THREE.Vector3());
    if (n.target) n.to.copy(n.target);
    n.pos = new THREE.Vector3();
    n.from = new THREE.Vector3();
    n.dir = new THREE.Vector3();
    const rift = n.origin ?? V.stage.rift ?? _v.set(0, 3.5, 34);
    const sx = n.side === 'left' ? 1 : n.side === 'right' ? -1 : 0;
    switch (n.type) {
      case 'crawler': n.from.set(sx * 1.6, n.to.y, Math.min(rift.z, 26)); break;
      case 'sweep': case 'scythe': n.from.set(0, n.to.y, Math.min(rift.z, 30)); break;
      case 'brute': n.from.set(0, 0, Math.min(rift.z, 22)); break;
      default: n.from.copy(rift).add(_v.set(sx * 1.2, 0, 0));
    }
    if (n.origin) n.from.copy(n.origin);
    if (n.react) n.from.copy(n.to);
    n.dir.copy(n.to).sub(n.from);
    n.speed = n.dir.length() / Math.max(0.5, n.beat - n.spawnBeat);   // world units per beat
    n.dir.normalize();
    // curves: strikers hook in from outside their lane, crawlers skitter wide, volleys swing in from their side
    n.arc = n.type === 'striker' || n.type === 'core' ? 1.2 : n.type === 'volley' ? 0.7 : 0;
    n.swirl = n.type === 'striker' ? sx * 2.2 : n.type === 'crawler' ? sx * 1.1 : n.type === 'volley' ? sx * 1.8 : 0;
    n.phase = 'fly'; n.hits = 0; n.cuePerf = 0; n.endBeat = n.beat;
    try {
      n.view = n.makeView ? n.makeView(n) : V.spirits.create(n.type, { side: n.side, position: n.from, target: n.to, react: !!n.react, boss: !!n.boss, beat: n.beat, act: n.act });
    } catch (e) { console.warn('[spirits] create failed', e); n.view = null; }
    n.live = true;
    this.live.push(n);
    this._place(n, n.spawnBeat);
    this.cb.onSpawn?.(n);
  }

  _place(n, beat) {
    pathPos(n, beat, n.pos);
    if (n.view?.object && !n.resolved) n.view.object.position.copy(n.pos);
  }

  /**
   * Advance: spawn due notes, move live ones, judge held moves, expire missed windows.
   * @param {number} songNow  clock seconds (frame)
   * @param {number} beatNow  clock beat (frame)
   */
  update(songNow, beatNow, dt) {
    if (this.paused) return;
    while (this.pending.length && this.pending[0].spawnBeat <= beatNow) this._spawn(this.pending.shift());
    const goodS = this.judge.win.good / 1000;
    const beatDur = this.clock.beatDur;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const n = this.live[i];
      this._place(n, beatNow);
      // the view belongs to CORE only until its outcome (hit / dodged / strikeHero auto-release it to VISUAL's pool)
      if (n.view) n.view.setTelegraph?.(n.react ? 1 : clamp01(1 - (n.beat - beatNow) / Math.max(TELE_EPS, n.teleBeats)));
      if (!n.resolved) this._resolveTimeouts(n, songNow, beatNow, goodS, beatDur);
      if (n.resolved && beatNow > n.endBeat + 2) this.live.splice(i, 1);
    }
  }

  _resolveTimeouts(n, songNow, beatNow, goodS, beatDur) {
    const tNote = this.clock.timeAtBeat(n.beat);
    switch (n.move) {
      case 'punch': case 'kick': case 'jump': {
        if (n.react) {
          if (!n.cuePerf) n.cuePerf = performance.now();
          if (performance.now() - n.cuePerf > 1600) this.resolve(n, 'miss', NaN, 'timeout');
        } else if (songNow > tNote + goodS + 0.05) this.resolve(n, 'miss', NaN, 'timeout');
        break;
      }
      case 'squat': case 'dodge': {
        const r = this.judge.evalState(n, songNow);
        if (r) this.resolve(n, r.kind, r.errMs, 'state');
        break;
      }
      case 'guard': {
        if (n.phase === 'fly') {
          const r = this.judge.evalState(n, songNow);
          if (r) {
            if (r.kind === 'miss') this.resolve(n, 'miss', r.errMs, 'state');
            else { n.phase = 'punch'; n.blockKind = r.kind; n.blockErr = r.errMs; this.cb.onBlock?.(n, r.kind, r.errMs); }
          }
        } else if (n.phase === 'punch' && beatNow > n.beat + 3.5) {
          // the brute recovers before the 3 punches landed: the block still counts, no finisher
          n.resolved = true; n.endBeat = beatNow; n.view?.dodged?.(); n.view = null;
          this.cb.onResolve(n, n.blockKind, n.blockErr, 'brute-escape');
        }
        break;
      }
      case 'blast':
        if (beatNow > n.beat + (n.hover ?? 8)) this.resolve(n, 'miss', NaN, 'timeout');
        break;
      default: break;
    }
  }

  /** Brute in its punch phase (after a successful guard), or null. */
  brutePunchTarget() {
    for (const n of this.live) if (!n.resolved && n.type === 'brute' && n.phase === 'punch') return n;
    return null;
  }
  /** A core spirit currently hovering (blast target), or null. */
  coreTarget(beatNow) {
    for (const n of this.live) if (!n.resolved && n.move === 'blast' && beatNow >= n.beat - 0.5) return n;
    return null;
  }
  /** Unresolved reaction note on screen, or null. */
  reactTarget() {
    for (const n of this.live) if (!n.resolved && n.react) return n;
    return null;
  }

  /** Resolve a note and play its outcome on the view. how: 'hit' | 'timeout' | 'state' | 'wrong' | 'blast' | ... */
  resolve(n, kind, errMs, how) {
    if (n.resolved) return;
    n.resolved = true;
    n.endBeat = Math.max(n.beat, this.clock.frameBeat);
    n.kind = kind;
    const v = n.view;
    n.hitPos ??= new THREE.Vector3();
    n.hitPos.copy(v?.hitPoint ?? n.pos);   // judge pop-up anchor (the view is dropped below)
    const hazard = n.move === 'jump' || n.move === 'squat' || n.move === 'dodge';
    try {
      if (kind === 'miss') {
        if (n.move === 'blast') v?.dodged?.(); else v?.strikeHero?.();
      } else if (hazard) v?.dodged?.();
      else v?.hit?.(kind, _v.set(0, 0.2, 1).normalize());
    } catch (e) { console.warn('[spirits] view outcome failed', e); }
    n.view = null;   // VISUAL owns (and auto-releases) the view from here on
    this.cb.onResolve(n, kind, errMs, how);
  }
}
