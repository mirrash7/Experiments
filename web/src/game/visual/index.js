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
  const shards = new ShardPool(12, 32);
  worldFx.add(worldGlow.mesh, shards.group);

  const shared = {
    time, worldFx, worldGlow, shards, palette: null,
    trauma(x) { const fx = ctx.fx; if (fx && typeof fx.trauma === 'number' && fx.options?.shake !== false) fx.trauma = Math.min(1, fx.trauma + x); },
  };
  const stage = createStage(ctx, shared);
  shared.palette = stage.palette;
  stage.object.add(worldFx);
  const spirits = createSpirits(ctx, shared);
  spirits.sys.parent = stage.object;
  const boss = createBoss(ctx, shared);
  stage.object.add(boss.object);
  const vfxMod = createVfx(ctx, shared);
  (ctx.heroScene ?? stage.object).add(vfxMod.group);

  // cross-module hooks
  shared.onBossShow = (on) => stage.setRiftOpen(on ? 0.0 : 1);
  shared.onSlam = (heroPos) => { vfxMod.api.shockwave(heroPos, { color: '#ff7050', size: 8, dur: 0.6 }); stage.pulse(2); };
  shared.onDefeatBoom = () => { stage.pulse(3); };
  spirits.sys.onHit = (view, kind) => { stage.pulse(kind === 'perfect' ? 0.9 : 0.5); };

  let qid = qualityId(ctx.quality);
  stage.setQuality(qid);
  const clock0 = performance.now();
  const tick = () => { time.value = (performance.now() - clock0) / 1000; };
  const checkQuality = () => { const q = qualityId(ctx.quality); if (q !== qid) { qid = q; stage.setQuality(q); } };

  // precompile every program once so the first spawn / blast doesn't hitch
  const unwarm = spirits.warm(1);
  if (ctx.renderer && ctx.camera) {
    try {
      boss.object.visible = true;
      const scene = new THREE.Scene(); scene.fog = ctx.worldScene?.fog ?? null; scene.add(stage.object); if (!ctx.heroScene) scene.add(vfxMod.group);
      ctx.renderer.compile(scene, ctx.camera);
      if (ctx.heroScene) ctx.renderer.compile(vfxMod.group, ctx.camera);
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
      snap: stage.snap,
      get act() { return stage.act; },
      palette: stage.palette,
    },
    spirits: {
      create: spirits.create,
      update(dt) { tick(); spirits.update(dt); shards.update(dt); worldGlow.update(dt); },
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
      update(dt) { tick(); vfxMod.api.update(dt); },
    },
    /** Debug: counts for the lab / perf overlay. */
    stats() { return { spirits: spirits.active.size, sprites: worldGlow.active + vfxMod.glow.active, shardBursts: shards.active, quality: qid, buildMs: Math.round(tBuild) }; },
    dispose() {
      spirits.dispose(); boss.dispose(); vfxMod.dispose(); stage.dispose(); worldGlow.dispose(); shards.dispose();
      vfxMod.group.parent?.remove(vfxMod.group); stage.object.parent?.remove(stage.object);
    },
  };
  const tBuild = performance.now() - t0;
  return visuals;
}
