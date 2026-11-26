// BREAKLIGHT VISUAL module entry (owner: VISUAL). Contract: docs/game/CONTRACTS.md "VISUAL".
//
//   const visuals = await createVisuals(ctx);
//   ctx.worldScene.add(visuals.stage.object);           // boss, spirits and world FX live under it
//   per frame (after CORE moved spirits / the camera, before rendering):
//     visuals.stage.update(dt, { beat, act, intensity, overdrive });
//     visuals.spirits.update(dt); visuals.boss.update(dt); visuals.vfx.update(dt);
//
// Notes for CORE:
// - The stage owns worldScene.fog (colour tweens per act) and keeps the sky dome centred on ctx.camera.
// - spirits.create(type, { side, position?, target? }) parents the view under stage.object. view.object's local
//   position == world position. Optional `target` (Vector3) = where the hit happens; sweep/scythe draw their floor
//   warning stripe at target.z (default z = 0, the hero line).
// - After hit()/dodged()/strikeHero() drop the reference: the view plays its outro and returns to the pool itself
//   (release() during the outro is a no-op). Brute extras: view.impact(kind, dir) for the non-final punches,
//   view.block() for a guarded hit.
// - boss.show() closes the rift (the Warden stands behind it); boss.hide() reopens it.
// - Camera shake: VISUAL adds trauma to ctx.fx (CombatFx.trauma) on blasts / boss slams / the defeat boom.
//
// R1 additions (all additive; existing calls unchanged):
// - Combat layer (spirits, trails, warnings, shatters, burst sprites) now lives in heroScene, depth-tested against the
//   hero; hit / judgement bursts are depth-pulled 1 m toward the camera so they draw over the hero's body.
// - spirits.create(type, { react: true }) -> reaction-test pop-in (white flash, rings, elastic scale pop).
// - vfx.aura(on, { color, strength, mode?: 'charge'|'overdrive' }): mode is inferred from a saturated gold colour.
// - vfx.blast(origin, dir, { target?, length?, radius? }): the beam ends at `target`, else auto-detects the boss weak
//   point / an active core spirit on the ray (impact flare there), else 160 m. Default radius 0.62 (sheath ~0.45 m).
// - vfx.groundCue(kind, t): glyph at the hero's feet. kind 'jump'|'duck'|'guard'|'blast'|'dodgeL'|'dodgeR' (null
//   clears). Call every frame from ~2 beats ahead with t = 0..1 progress (ring closes + flashes at 1); it fades out
//   ~0.25 s after the last call.
// - stage.setCameraClear(pos, r) / setFocus(v) / setSightline(v): near props (platform trees, pillars, close
//   islands) dither out when near the camera, between the camera and the hero (auto focus: hero chest), inside the
//   boss weak-point sightline cone (auto while the boss stands), or inside the explicit clear sphere.
// - boss.head(out) (world head position), boss.introT (0..1 emergence), boss.shown. weakPoint is valid right after
//   show() (rest pose), so projectiles / blast targets built at boss start are correct.
// - Boss scale ~2x angular (BOSS_POS 0,-9.8,118, scale 19.3): chest core ~5 deg, head ~20 deg above the horizon from
//   the hero; the eclipse sits behind the head (palette 'boss' el 0.33).
//
// R2 additions (all additive; the createVisuals contract is unchanged):
// - settings.reduceFlashes: VISUAL reads ctx.settings.reduceFlashes live every frame. On: flash sprites / blast / defeat
//   flares are dimmed (x0.45), smaller and shorter, the beam is shorter (0.85 s) and VISUAL's camera shake drops to 35 %.
// - Flash budget (P1-5): GlowPool caps every sprite bigger than 2.5 m (intensity <= 1.5, white core <= 0.3); halo cores
//   saturate at 1.8x; blast beam / muzzle / impact and boss flashes are coloured, not white. No full-frame white-out
//   even with CORE's bloom bump (lab emulates game.bloom: blast +0.55, defeat +1.0).
// - Boss defeat: at 1.8 s the Warden shatters into ~44 large crystal chunks (one InstancedMesh, sampled from its own
//   torso / head / arm geometry) that hold shape for a beat, split along gold-glowing cracks and tumble into the cloud
//   sea with ember trails and cloud splashes; a ring spreads over the clouds (~4.4 s total; boss.state 'dying' ->
//   'defeated' unchanged). Eyes: two emissive slits under a brow (cyan idle, red flare on telegraphs, dark on defeat).
// - Stage: in the boss act the two platform sakura step aside to the platform rim (dissolve out/in), and tree islands
//   within 60 m + near props dither out where they overlap the Warden's body (any camera, fight and kill). Act 2 is a
//   moonlit blue night with magenta horizon accents; act 3 shifted violet. Painted toon canopies, toon waterfalls
//   (flow tones, foam lip, mist). The screen-left front pillar moved out (80 deg) with no crystal over the HUD column.
import * as THREE from 'three';
import { GlowPool, ShardPool, qualityId } from './common.js';
import { createStage, PALETTES, RIFT_POS } from './stage.js';
import { createSpirits, SPIRIT_STYLE } from './spirits.js';
import { createBoss, BOSS_POS } from './boss.js';
import { createVfx } from './vfx.js';

export { PALETTES, SPIRIT_STYLE, RIFT_POS, BOSS_POS };

export async function createVisuals(ctx) {
  const t0 = performance.now();
  const time = { value: 0 };
  const worldFx = new THREE.Group(); worldFx.name = 'worldFx';
  const worldGlow = new GlowPool(640);
  const burstGlow = new GlowPool(320, { pull: 1.0 });   // hit / judgement bursts: depth-pulled 1 m toward the camera
  const shards = new ShardPool(12, 32);
  worldFx.add(worldGlow.mesh, burstGlow.mesh, shards.group);

  const shared = {
    time, worldFx, worldGlow, burstGlow, shards, palette: null,
    // settings.reduceFlashes (read live): flashK scales flash intensity / size / duration, shake drops to 35 %
    flashK: 1, reduceFlashes: false,
    trauma(x) { const fx = ctx.fx; if (fx && typeof fx.trauma === 'number' && fx.options?.shake !== false) fx.trauma = Math.min(1, fx.trauma + x * (shared.reduceFlashes ? 0.35 : 1)); },
  };
  const syncFlash = () => {
    const r = !!ctx.settings?.reduceFlashes, f = r ? 0.45 : 1;
    shared.reduceFlashes = r; shared.flashK = f;
    worldGlow.flash = burstGlow.flash = f; vfxMod.glow.flash = f;   // only called from tick(), after vfxMod exists
  };
  const stage = createStage(ctx, shared);
  shared.palette = stage.palette;
  // combat layer (spirits, their trails / warnings, shatters, bursts) renders in heroScene: it is depth-tested against
  // the hero instead of being painted over by the hero pass, so hits in front of / beside the hero stay visible.
  (ctx.heroScene ?? stage.object).add(worldFx);
  const spirits = createSpirits(ctx, shared);
  spirits.sys.parent = worldFx;
  shared.spiritsActive = () => spirits.active;
  const boss = createBoss(ctx, shared);
  shared.bossView = boss;
  stage.object.add(boss.object);
  stage.setBoss?.(boss);
  const vfxMod = createVfx(ctx, shared);
  (ctx.heroScene ?? stage.object).add(vfxMod.group);

  // cross-module hooks
  shared.onBossShow = (on) => stage.setRiftOpen(on ? 0.0 : 1);
  shared.onSlam = (heroPos) => { vfxMod.api.shockwave(heroPos, { color: '#ff7050', size: 8, dur: 0.6 }); stage.pulse(2); };
  shared.onDefeatBoom = () => { stage.pulse(3); };
  spirits.sys.onHit = (view, kind) => { stage.pulse(kind === 'perfect' ? 0.9 : 0.5); };

  // results: the pinned boss-kill replay ("WARDEN DEFEATED") re-stages the Warden (CORE hides it on entering results)
  const offReplay = bindKillReplay(ctx, boss, vfxMod.api);

  let qid = qualityId(ctx.quality);
  stage.setQuality(qid);
  const clock0 = performance.now();
  const tick = () => { time.value = (performance.now() - clock0) / 1000; syncFlash(); };
  const checkQuality = () => { const q = qualityId(ctx.quality); if (q !== qid) { qid = q; stage.setQuality(q); } };

  // precompile every program once so the first spawn / blast doesn't hitch
  const unwarm = spirits.warm(1);
  if (ctx.renderer && ctx.camera) {
    try {
      boss.object.visible = true;
      const scene = new THREE.Scene(); scene.fog = ctx.worldScene?.fog ?? null; scene.add(stage.object); if (!ctx.heroScene) scene.add(vfxMod.group);
      ctx.renderer.compile(scene, ctx.camera);
      if (ctx.heroScene) { ctx.renderer.compile(vfxMod.group, ctx.camera); ctx.renderer.compile(worldFx, ctx.camera); }
      scene.remove(stage.object);
    } catch (e) { console.warn('[visual] precompile skipped', e); }
    boss.object.visible = false;
  }
  unwarm();

  const visuals = {
    stage: {
      object: stage.object,
      rift: stage.rift,
      update(dt, o = {}) {
        tick(); checkQuality();
        if (o.act !== undefined && o.act !== null && String(o.act) in PALETTES && String(o.act) !== stage.act) stage.setAct(o.act);
        stage.update(dt, o);
      },
      setAct: stage.setAct,
      pulse: stage.pulse,
      setRiftOpen: stage.setRiftOpen,
      setFocus: stage.setFocus, setSightline: stage.setSightline, setCameraClear: stage.setCameraClear,
      snap: stage.snap,
      get act() { return stage.act; },
      palette: stage.palette,
    },
    spirits: {
      create: spirits.create,
      update(dt) { tick(); spirits.update(dt); shards.update(dt); worldGlow.update(dt); burstGlow.update(dt); },
      releaseAll: spirits.releaseAll,
      types: spirits.types,
      get activeCount() { return spirits.active.size; },
    },
    boss,
    vfx: {
      aura: vfxMod.api.aura,
      blast: vfxMod.api.blast,
      judgement: vfxMod.api.judgement,
      shockwave: vfxMod.api.shockwave,
      groundCue: vfxMod.api.groundCue,
      update(dt) { tick(); vfxMod.api.update(dt); },
    },
    /** Debug: counts for the lab / perf overlay. */
    stats() { return { spirits: spirits.active.size, sprites: worldGlow.active + burstGlow.active + vfxMod.glow.active, shardBursts: shards.active, quality: qid, buildMs: Math.round(tBuild) }; },
    dispose() {
      offReplay?.();
      spirits.dispose(); boss.dispose(); vfxMod.dispose(); stage.dispose(); worldGlow.dispose(); burstGlow.dispose(); shards.dispose();
      vfxMod.group.parent?.remove(vfxMod.group); worldFx.parent?.remove(worldFx); stage.object.parent?.remove(stage.object);
    },
  };
  const tBuild = performance.now() - t0;
  return visuals;
}

/**
 * Boss-kill replay on the results screen. CORE emits bus 'replay' { phase: 'start', bossKill, window: clip, seconds,
 * speed } / { phase: 'progress', progress } / { phase: 'end' }. For a boss-kill clip the Warden is shown standing (chest
 * open), dies again when the replay reaches the kill (the Breaklight beam fires from the hero's hands into its core)
 * and is hidden when the replay ends. The kill time comes from CORE's BossScript (game.boss.defeatBeat mapped through
 * the clip's beat track), else the pin's 1.5 s lead-in. The replay clock is CORE's ReplayPlayer song time.
 * Camera: it asks CORE's director (game.cameraCut) for its 'bossKill' two-shot for the replay's length (the default
 * front 'replay' framing looks away from the Warden, which stands at +Z behind that camera) and releases it at the end.
 */
function bindKillReplay(ctx, boss, vfx) {
  if (!ctx.bus?.on || !boss.replayKill) return null;
  const st = { on: false, clip: null, p: 0, cut: false };
  const songT = () => {
    const R = ctx.game?.replay, c = st.clip;
    if (R?.active && R.win === c && Number.isFinite(R.t)) return R.t;
    return c ? c.t0 + st.p * (c.t1 - c.t0) : NaN;
  };
  const defeatTime = (c) => {
    const db = ctx.game?.boss?.defeatBeat;
    if (Number.isFinite(db) && c.beats && c.times && c.count > 1) {
      for (let i = 1; i < c.count; i++) {
        if (c.beats[i] >= db) { const b0 = c.beats[i - 1], b1 = c.beats[i], u = b1 > b0 ? (db - b0) / (b1 - b0) : 1; return c.times[i - 1] + (c.times[i] - c.times[i - 1]) * Math.min(1, Math.max(0, u)); }
      }
    }
    return Math.min(c.t1 - 0.2, c.t0 + 1.5);
  };
  const _o = new THREE.Vector3(), _a = new THREE.Vector3(), _d = new THREE.Vector3();
  const killBlast = () => {
    const B = ctx.hero?.bones;
    if (B?.leftHand && B?.rightHand) { B.leftHand.getWorldPosition(_o); B.rightHand.getWorldPosition(_a); _o.add(_a).multiplyScalar(0.5); }
    else _o.set(0, 1.25 * ((ctx.hero?.info?.height || 1.6) / 1.6), 0.35);
    const target = boss.weakPoint.clone();
    _d.subVectors(target, _o).normalize();
    vfx.blast(_o.clone(), _d.clone(), { target });
  };
  const start = (d) => {
    const c = d.window;
    if (!c || !Number.isFinite(c.t0) || !Number.isFinite(c.t1)) return;
    st.on = true; st.clip = c; st.p = 0;
    boss.replayKill({ clock: songT, tDefeat: defeatTime(c), tEnd: c.t1, onKill: killBlast });
    const dir = ctx.game?.director;
    st.cut = false;
    // (a cut to the same shot only extends it, so this is harmless once CORE frames the replay itself; it also
    // replaces the live kill shot that may still be running from the fight)
    if (dir && typeof ctx.game.cameraCut === 'function') st.cut = !!ctx.game.cameraCut('bossKill', (+d.seconds || (c.t1 - c.t0) / (d.speed || 0.35)) + 0.5);
  };
  const end = () => {
    if (!st.on) return;
    st.on = false; st.clip = null;
    boss.endReplay();
    const dir = ctx.game?.director;
    if (st.cut && dir?.shot === 'bossKill') dir.endShot?.();
    st.cut = false;
  };
  return ctx.bus.on('replay', (d = {}) => {
    try {
      const ty = d.phase || d.type || (d.on === true ? 'start' : d.on === false ? 'end' : null);
      const kill = !!(d.bossKill || /WARDEN|BOSS/i.test(String(d.label || '')));
      if (ty === 'start') { if (st.on) end(); if (kill) start(d); }
      else if (ty === 'progress' && st.on && Number.isFinite(d.progress)) st.p = d.progress;
      else if (ty === 'end') end();
    } catch (e) { console.warn('[visual] kill replay', e); }
  });
}
