# BREAKLIGHT: module contracts and ownership

Four engineers build in parallel. Code against these interfaces and only edit files you own. Ask for changes in your report with `REQUEST(<owner>): ...`. The design is in `docs/game/GDD.md`.

Coordinates: metres, three.js. The hero stands at the origin facing +Z; its left is +X. The gameplay camera is behind the hero (at −Z, looking +Z). Spirits come from far +Z toward the hero. The player's left is the hero's left, and both are on screen-left in the gameplay camera.

## Ownership

| Owner | Files |
|---|---|
| **CORE** (gameplay + bootstrap) | `web/game.html`, `web/src/game/main.js`, `web/src/game/core/*` (state machine, chart/waves, spirits logic, judge, score, replay, camera director, settings) |
| **VISUAL** (stage, spirits, boss, VFX) | `web/src/game/visual/*` |
| **AUDIO** | `web/src/game/audio/*` |
| **UI** (CV interaction + HUD + screens) | `web/src/game/ui/*`, `web/src/game/game.css` |

Shared, read-only for all four (bug fixes go through the lead): `web/src/vrm/*`, `web/src/motion/*`, `web/src/fx/*`, `web/src/render/*`, `web/src/sources/*`, `web/src/actions.js`.

Each module ships a stub-friendly default, so others can run before it lands. CORE builds against simple stand-ins (boxes, beeps, plain DOM) while the real modules come in.

## Shared runtime context (`ctx`), created by CORE

```js
ctx = {
  THREE, renderer, camera,            // PerspectiveCamera (CORE's camera director moves it)
  worldScene, heroScene,              // render/post.js composites heroScene over worldScene
  hero,                               // loadVRMHero() result: root, bones, vrm, setExpression, info…
  motion,                             // createMotionPipeline() result: events, actions, state, metrics, hitStop
  fx,                                 // createFx() result
  audio,                              // AUDIO's API (below)
  quality,                            // QualityManager: .preset ('low'|'medium'|'high')
  settings,                           // { tracker, upperBodyOnly, difficulty, volume, judgeOffsetMs, … }
  bus,                                // tiny event emitter: bus.on(type, cb) → off, bus.emit(type, data)
  time: { now, dt, beat, act },       // updated each frame by CORE
}
```

## AUDIO: `web/src/game/audio/index.js`

```js
export function createAudio(): Audio
Audio = {
  unlock(): Promise<void>,            // resume AudioContext on the first user gesture (or the first detected move)
  clock: {                            // THE beat clock: CORE spawns/judges from it
    bpm: number, beatDur: number,     // seconds per beat
    now(): number,                    // song time in seconds (AudioContext-based, monotonic, latency-compensated)
    beat(): number,                   // fractional beat index
    toPerf(songTime): number,         // song time → performance.now() ms (to compare with camera capture times)
    fromPerf(perfMs): number,
    onBeat(cb(beatIndex)) → off,      // fires on the main thread close to each beat (lookahead scheduled)
  },
  playSong(id: 'title'|'run'|'boss'|'results', { startBeat }?): void,   // seamless loops; scheduled on bar lines
  setIntensity(0..1): void,           // layers in/out (act progress)
  setOverdrive(on: boolean): void,    // extra layer + filter sweep
  stopSong({ fadeMs }?): void,
  sfx(name, { pan?: -1..1, gain?, pitch? }?): void,
  // names: 'whoosh','punchHit','kickHit','perfect','great','good','miss','shatter','block','dodge','jumpOver',
  //        'duckUnder','chargeHum'(start/stop via sfxLoop),'blast','hurt','combo','overdrive','uiHover','uiSelect',
  //        'countdown','go','bossRoar','bossHit','victory','defeat'
  sfxLoop(name): { stop() },
  setVolume({ master, music, sfx }): void,
  latencyMs: number,                  // output latency estimate (baseLatency + outputLatency)
}
```

All music and SFX are procedural or synthesized (original, no samples from other works). The engine must stay stable for 10+ minutes (no drift, no leaks) and use ≤ 2 ms of the main thread per frame.

## VISUAL: `web/src/game/visual/index.js`

```js
export async function createVisuals(ctx): Visuals
Visuals = {
  stage: {
    object: THREE.Object3D,           // added to worldScene by CORE
    update(dt, { beat, act, intensity, overdrive }),
    setAct(act: 0|1|2|'boss'|'title'|'results'),   // sky / colour / props transitions (tweened)
    pulse(strength),                  // beat or impact pulse on rune circles / lights
    rift: THREE.Vector3,              // world position spirits spawn from
  },
  spirits: {
    create(type, opts): SpiritView,   // pooled; type ∈ 'striker'|'crawler'|'sweep'|'scythe'|'volley'|'brute'|'core'
    update(dt),
  },
  boss: BossView,                     // created hidden; show() for the boss state
  vfx: {
    aura(on, { color, strength }),    // around the hero (charge / overdrive)
    blast(origin, dir),               // Breaklight beam from the hero's hands
    judgement(pos, kind),             // optional 3D flourish at the hit point ('perfect'|'great'|'good'|'miss')
    shockwave(pos), update(dt),
  },
  dispose(),
}

SpiritView = {
  object: THREE.Object3D,             // CORE positions it each frame (path is CORE's job); view animates itself
  side: 'left'|'right'|'center',
  setTelegraph(t: 0..1),              // 0 = just spawned … 1 = hit moment (rings close in, glow ramps)
  update(dt),
  hit(kind: 'perfect'|'great'|'good', dir: THREE.Vector3),  // shatter + light burst, then auto-release to the pool
  dodged(),                           // missed hazard passes harmlessly / fizzles
  strikeHero(),                       // it hits the player (miss): flash + dissipate
  release(),
  hitPoint: THREE.Vector3,            // world-space point to judge a strike against (fist/foot target)
}

BossView = {
  object, show(), hide(), update(dt),
  telegraph(attack: 'slam'|'sweep'|'barrage', t: 0..1),
  attack(attack), stagger(), openWeakPoint(on), hit(kind), defeat(), // big death sequence
  weakPoint: THREE.Vector3,
}
```

Budget: the stage is ≤ 60 draws and ≤ 250k triangles on High (half on Low), with emissive or bloom-friendly materials. Spirits are pooled and instanced where possible; a shatter is ≤ 1 draw per spirit. Everything reads clearly from the 3/4 rear gameplay camera at 1440×900 and 1920×1080.

## UI: `web/src/game/ui/index.js`

```js
export function createUI(ctx): UI
UI = {
  root: HTMLElement,                  // full-screen overlay (pointer-events managed)
  cursor: {                           // hand cursor (CV menu control)
    enable(on), update(dt),           // uses hero/motion wrist positions projected to screen + camera
    // hover a [data-ui-button] for 0.8 s (radial fill) OR punch toward it → click; mouse also works
  },
  screens: {
    boot({ onTracker(name) }), calibrate({ onDone }), title({ onPlay, onTutorial, onSettings }),
    tutorial({ steps, onDone }), settings({ settings, onClose }), pause({ reason }), countdown(n),
    results({ stats, onReplay, onAgain, onTitle }), hide(),
  },
  hud: {
    show(on), setScore(n), setCombo(n, mult), setHealth(h, max), setFlow(0..1, overdrive),
    banner(text, sub?),               // "ACT 2", "WARNING: ECLIPSE WARDEN", …
    judgement(screenPos, kind),       // pop-up text at the strike point
    prompt(text|null),                // contextual hint ("DUCK!")
    pip: { setVideo(video), setSkeleton(kp2d, edges) },   // webcam preview with glowing skeleton
    distance(state|null),             // 'too-close'|'too-far'|'off-left'|'off-right'|null
  },
  update(dt),
}
```

UI owns **calibration and tutorial content**: the T-pose silhouette guide, distance guidance, per-drill instructions and live verification. It reads `ctx.motion.actions.state`, `ctx.motion.events` and keypoints from the source frames. CORE owns the transitions between screens.

## CORE: `web/src/game/main.js` + `core/*`

- **Bootstrap:** renderer, `render/pipeline.js` config, post chain, hero lights, QualityManager, the VRM hero, the motion pipeline with mirror **off** (rear camera), FX, sources (InstantHMR → MediaPipe → synthetic demo player fallback; `?tracker=`), AUDIO, VISUAL and UI.
- **State machine:** `boot → calibrate → title → (tutorial) → run(act 0..2) → boss → results → title`, plus `pause` from any play state.
- **Chart generator:** `core/chart.js`. Per-act patterns are authored as data (beat-quantized spawns with type, side, beat). Variety with fairness rules: minimum gap between required moves, no impossible combos, upper-body-only filter, adaptive density.
- **Spirits logic:** spawn at `stage.rift`, follow paths so they arrive at their hit point exactly on the target beat, judge windows, and outcomes calling the SpiritView methods.
- **Judge:** `core/judge.js`. Maps `motion.events`/`actions` to the required moves, corrects by capture timestamps and the clock (`audio.clock.fromPerf(info.tCapture)`), and returns the judgement plus error in ms.
- **Score:** combo, multiplier, Flow/Overdrive, health, stats.
- **Body stats:** fastest punch speed (wrist speed from hero space), max jump height (hips rise), best reaction, move counts, kcal estimate.
- **Replay:** `core/replay.js`. Records the last ~20 s of applied poses (`hero.getHumanoidPose()`), spirit events and camera. Picks the best combo window and plays it back on the hero at 0.35× with the front cinematic camera.
- **Camera director:** `core/camera.js`. Gameplay 3/4 rear, title orbit, cinematic cuts, shake via FX.
- **Boss:** `core/boss.js`. The attack script drives BossView and the required moves.
- **Dev:** `?debug=1` overlay (fps, judge log), `?skip=run|boss|results`, a synthetic demo player that actually plays the chart (autoplay bot for QA, `?autoplay=1`).
