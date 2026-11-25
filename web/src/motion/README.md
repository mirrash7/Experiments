# Motion pipeline (webcam → VRM hero)

Turns tracker frames (InstantHMR server, MediaPipe, synthetic player, recorded clips) into a VRM humanoid
pose, following `docs/research/motion-quality.md`. Test bed: `/motion-lab.html`.

## Wiring it into the game (a few lines)

```js
import { createMotionPipeline } from './motion/index.js';

const motion = await createMotionPipeline({ hero, source, options: { mirror: true } });
// per render frame:
motion.update(dt, performance.now());      // computes the pose and calls hero.applyHumanoidPose(pose)
// UI:
calibBtn.onclick = () => motion.calibrate();
motion.actions.on((name, info) => { /* 'punchLeft', 'jump', ... same API as before */ });
hud.textContent = JSON.stringify(motion.metrics.snapshot());
```

- `source` is any of `web/src/sources/*` (`HMRSource`, `MediaPipeSource`, `SyntheticSource`, `RecordedSource`).
  The pipeline chains itself onto `source.onPose`; set your own `onPose` *before* passing the source (or call
  `motion.push(frame)` yourself from your handler and pass no source). Switch with `motion.setSource(src)`.
- `hero` must provide `applyHumanoidPose(pose)` and, ideally, `vrm` (the three-vrm VRM) or `info.restPose`
  (= `vrm.humanoid.normalizedRestPose`, plus `info.vrm0` for 0.x models) so IK uses the exact rest skeleton.
  Without either it falls back to canonical proportions scaled by `info.height / hipHeight / upperArm /
  lowerArm / upperLeg / lowerLeg`.
- `motion.update()` returns the pose too; pass `options.apply: false` to apply it yourself.

### Output pose (exactly the hero contract)

```js
{ hips: THREE.Vector3,                       // metres, hero root space
  rotations: { [VRMHumanBoneName]: THREE.Quaternion } }   // normalized-bone LOCAL rotation, identity = T-pose
```

Convention: **VRM 1.0 frame — the character faces +Z, its left is +X, y up.** For a VRM 0.x model turned by
`VRMUtils.rotateVRM0`, the normalized bones live in a frame rotated 180° about Y: convert with
`toVRM0Pose(pose)` (negates x/z of every quaternion and of hips, as pixiv's Mixamo loader does) or set
`options.convention: 'vrm0'`. The motion lab does this in its `applyHumanoidPose` for Sakurada (VRM0).
Bones the model lacks (e.g. `upperChest`) are skipped and the rotations of their children are re-expressed
relative to the nearest present parent, so world orientations stay right.

### API

| member | |
|---|---|
| `createMotionPipeline({hero, source, options, vrm, mhr, actions})` | async (loads `/motion/mhr-rig.json` once; pass `mhr` to reuse a loaded `MHRSkeleton`) |
| `.update(dt, renderTime)` | advance to `renderTime` (performance.now timebase), return + apply the pose |
| `.push(frame)` | feed a tracker frame manually |
| `.calibrate()` | re-run the standing calibration (floor plane, facing, player size); auto on start |
| `.metrics.snapshot()` | latency / jitter / foot skate / FK error / cost (see below) |
| `.actions` | the `ActionDetector` (`on(cb(name, info))`, `state`, `lastFire`), fed from a lightly filtered stream; names are the *player's* sides |
| `.options` | live toggles (table below) |
| `.state` | `calibrated, solver, contacts, locked, weights, hands, legsTracked, heroFK` for HUD/debug |
| `.options.lookAt` | `THREE.Vector3` in hero root space (head 70 % / neck 30 %, ≤ 1 rad) or `null` |
| `.events.on(type, cb)` | `'action'` {name (avatar side), playerName, accent}, `'impact'` {kind 'punch'/'kick', side, pos, dir (hero space), strength} on the frame the fist/foot reaches full extension, `'land'` {feet: [l, r] hero space, strength}, `'expression'` {name}; returns `off()` |
| `.requestExpression(name)` | emits `'expression'` and, with `options.expressions` (default on), calls `hero.setExpression(name)` |
| `.hitStop(ms, scale)` | freeze the displayed tracking time / slow internal time for `ms` (called by `web/src/fx` on impacts) |
| `.predictTuning` | live predictor constants (`track.js` `PREDICT`) for experiments |

Options (defaults in `pipeline.js` `DEFAULTS`): `mirror`, `solver` (`auto`/`mhr`/`keypoints`), `limits`
(elbow/knee hinge), `wristLimits` (±45° flexion/extension, ±30° deviation), `twistSplit` (0.5 of the wrist twist
into the forearm, unwrapped for continuity), `predict`, `predictMs` (50), `maxHorizonMs` (110), `noiseAware`,
`spring`, `springScale`, `confidence`, `base`, `baseStyle` (`stance` (default) / `guard` / `relaxed`),
`accents`, `hands` (`pose`/`tracked`/`off`), `handOverride`, `ikArms`, `reachRemap`, `ikLegs`, `kneePole`,
`footLock`, `pelvis`, `expressions`, `root: {scale, zDeadzone, zCutoff, follow}`, `autoCalibrate`,
`calibrateYaw`, `convention`, `apply`.

### Combat round (QA v3 round 1 fixes)

- **Hands** (`hands.js`): relaxed curls 0.35-0.7 rad rising toward the little finger; the thumb is posed by
  segment *direction* in the hand frame (opposed when relaxed, wrapped across index + middle in a fist), so it
  fits any VRM's thumb rest. Fist blends in with tau 35 ms. Hand goal per side: accent override (both fists for
  the whole punch/kick + 150 ms tail) > tracked classification (InstantHMR hand keypoints, or `frame.handState`)
  > base stance (untracked arm: fists in `stance`/`guard`) > guard heuristic (wrist near the face) > relaxed.
- **Wrists**: arm reach IK keeps the hand's *local* rotation (keeping its world rotation bent the wrist back
  ~90° whenever the punch boost straightened the arm); then `clampWrist` (swing-twist about the forearm) limits
  flexion/extension ±45° and deviation ±30°, and the punch accent straightens the wrist (fist in line).
- **Punch accent**: ease-out-back snap (~12 % overshoot), kinetic chain hips → spine → chest → shoulder leading
  the fist by 25 ms, opposite shoulder pulls back, head counter-turns; strength from the detector's wrist speed.
- **Kick accent**: chamber (0.11 s) → snap extension (ease-out-back, 0.09 s) → hold → retract → lower; on
  tracked legs it extends the tracked knee (`kneeExt`) instead of replacing the leg; torso leans back, hips pivot
  over the support foot, support knee bends; the kicking foot is released from the foot lock.
- **Legs**: `poleIK` (ik.js) builds thigh and shin frames from (bone direction, knee facing) in the plane of
  hip→ankle and a pole = tracked knee direction when the leg is visibly bent, else foot-forward + hips-forward,
  never behind the hips — the knee can only bend about its hinge (no sideways knees). The pelvis drops to keep
  ≥ 3 % knee bend on planted feet (no straight "plank" legs on a lean or weight shift).
- **Base stance** (`layers.js` `ProceduralBase`, `'stance'`): fists at chin height ~24 cm apart, elbows tucked
  (pole-vector arm IK relative to the chest), orthodox stagger with toes out, soft knees, breathing in chest and
  shoulders, slow weight shift of the pelvis over planted feet. Used for anything untracked.
- **Expressions**: punch → `determined`, kick → `angry`, jump / hands up / 3-hit combo → `happy`, squat / guard
  → `determined`, T-pose → `relaxed` (`ACTION_EXPRESSION` in pipeline.js).
- **Predictor** (track.js, see the class comment): noise gain from innovation power, turn-around cuts (reversal,
  peak gate), saturating per-group horizon (arms/hands ≤ 70 ms), noise-adaptive spring half-life and an output
  speed limiter (≤ 0.85 × tracked speed + 0.1 rad/s). `noiseAware: false` restores the v1 predictor for A/B.
- **Jitter metric**: every stream is slerp-resampled onto one 30 Hz grid before differencing (the old per-frame
  60 Hz output vs per-sample raw comparison read a sample-and-hold output √2 faster than its input).
  `jitter.outSpeed` = filter stage (prediction + spring), `finalSpeed` = displayed pose incl. authored layers,
  `jitter.ok` = out ≤ raw.
- **Combat VFX**: see `web/src/fx/index.js` (`createFx({scene, camera, hero, motion})`).

### Combat VFX in the game (for main.js; not wired yet)

```js
import { createFx } from './fx/index.js';
let fx = null;
// in installMotion(m, h), after the pipeline is live:
fx ??= createFx({ scene: heroScene, camera: camera3, hero: h, motion: m });   // heroScene: depth-tested vs the hero
fx.setHero(h); fx.setMotion(m);
// in frameLoop, after stepHero() and the camera follow / lookAt, before renderFrame():
const ts = fx.update(dt);           // hit-stop time scale (1 normally, 0.05 for 60-80 ms on an impact)
// optional: pass dt * ts to character.update (spring bones) - the pipeline already freezes itself (motion.hitStop)
// remove: the onAction setExpression(...) calls (the pipeline requests expressions itself; harmless if kept)
```
Toggles: `fx.setEnabled(bool)`, `fx.options.{hitStop, shake, trails, sparks, flash, dust, shakeScale}`.
Cost: one draw for all sprites + one per visible trail, no per-frame allocation, ~0.02-0.1 ms/frame.

## Stages

```
tracker frame (push)
  ├─ ActionDetector.pushFrame: light one-euro (5 Hz min cutoff, beta 3) → triggers (earlier punch rule)
  ├─ solve WORLD bone rotations
  │    MHRSolver (frame.mhr): MHR FK in JS (mhrFK.js) → W = R_j · R0_j⁻¹ · A_bone
  │        A_bone = F(MHR rest dirs) · F(VRM rest dirs)⁻¹  (two-axis frames: bone dir + elbow plane / palm / side)
  │        MHR joints: root, c_spine1-3, c_neck, c_head, clavicle, uparm, lowarm, wrist, upleg, lowleg,
  │        transversetarsal, ball, finger 1-3 (thumb 1-3)
  │    KeypointSolver (MediaPipe / synthetic): two-axis limb frames, palm index/pinky for wrist twist,
  │        knee/foot forward for thigh twist, ear+nose head, spine split 0.30/0.35/0.35, last-good bend axes
  ├─ calibration: up = ankles→neck, floor = lowest heel/toe, yaw from hip line; floor refined while planted
  ├─ mirror (reflect x, swap sides) → local rotations over the hero's hierarchy
  ├─ forearm twist split, elbow/knee hinge limits
  ├─ per-bone predictor sample (capture time), root sample (hip-height ratio, depth dead-zone + 0.8 Hz one-euro)
  ├─ per-bone confidence, foot contacts (height < 7 cm, speed < 0.35 m/s over 150 ms, majority of 5)
  └─ hand state (fist / open / point / relaxed) from InstantHMR hand keypoints
render frame (update)
  1 predict: target = exp(ω·h·g)·q_k, h = t_display − t_k (≤ maxHorizon), t_display = now − max(0, latency − predictMs),
    ω speed-clamped per bone group, g = noise-adaptive gain |ω|²/(|ω|²+var) so a still player is not extrapolated
  2 tracking spring (critically damped, goal velocity ω·g, half-life hands 22 / arms 28 / legs 35 / head 40 / spine 50 ms)
  3 confidence layer: visible → tracked; lost → hold last good 0.3 s → fade to procedural base over 0.35 s
  4 accents: punch snap (chest/shoulder twist + full reach + fist), kick, jump stretch + hang time, landing squash
  5 hand poses (blended authored poses; 'tracked' uses MHR finger rotations)
  6 foot lock (plant where the foot is displayed, inertialized switch, release on drift / out of reach)
    → pelvis drop → two-bone leg IK → planted foot flattened
  7 arm reach IK: extension remapped (≥ 0.95 → straight) + punch boost, direction from the tracked pose
  8 look-at → pose → hero.applyHumanoidPose
```

### Why FK runs in the browser (not on the server)

The rig is a 20 KB JSON (127 joints, 368 non-zero parameter-transform entries); JS FK costs ~0.1 ms. Keeping
the server thin keeps its protocol raw (parameters, not one game's skeleton), lets the client mirror, choose
joints/fingers, validate against `j3d` live, and change retargeting without restarting Python.

### MHR facts verified here

- Rig constants from MHR's `mhr_model.pt` (Apache-2.0 assets, MHR release; also in the SAM-3D-Body snapshot)
  via `server/tools/extract_mhr_rig.py`. The 204 params: 0:3 root translation, 3:6 root rotation, 6:136 joint
  angles, 136:204 skeleton scales. Rest pose = A-pose facing +Z, left = +X; MHR's frame in metres is exactly the
  three.js frame our sources use (camera y/z flipped), so no axis conversion is needed for rotations.
- MHR70 keypoints 5, 6, 9-12, 21-62, 69 are pure joint readouts; elbows, ankles, toes, face are mesh points.
- MHR's min/max parameter limits are fitting priors: InstantHMR violates them on every frame (flexible
  spine/foot/scale params), so clamping (`mhrParamLimits`) is off by default; limits are applied as VRM hinges.

## Metrics (`metrics.snapshot()`)

`latency.track` capture→arrival; `latency.lead` prediction horizon; `latency.e2e` motion→avatar lag measured by
cross-correlating the tracked wrists (relative to hips, by capture time) with the avatar's (by render time);
`jitter.rawSpeed/outSpeed` RMS angular speed of hips/head/hands (raw solver vs final; accel values are per
stream rate and not comparable); `footSkate.raw/out` horizontal ankle speed while planted, before IK vs after
the lock, plus `lockMiss` (IK miss on locked feet); `fkError` JS FK vs `joints_3d` (mm); `cost` ms.

Measured (headless Chrome, M-series, Sakurada VRM0, `lab.measure()`):

| test | result |
|---|---|
| FK vs InstantHMR `joints_3d` (51 joint keypoints, live server and clip) | 0.066 mm mean, 0.15 mm max (= the 0.1 mm JSON rounding); Python FK vs `mhr-body.onnx` 0.0005 mm |
| Live InstantHMR (fake camera, small fit1 CoreML) | capture→arrival 34 ms; out jitter 0.60 vs raw 1.35 rad/s; feet planted 100 %, skate 13.5 → 0 cm/s |
| Recorded clip (12.5 fps, 61 ms latency) | e2e lag: hold 96 ms, spring only 140, predict + spring 112; skate 70 → 0.4 cm/s |
| Synthetic punches (30 fps, 80 ms latency) | e2e lag: hold 104 ms, predict + spring 88, predict only 64 |
| Synthetic standing still + 1 cm noise | angular speed raw 8.6 → out 5.0 rad/s (spring only 3.8, raw hold 12.9) |
| Cost | solve 0.1-0.25 ms per tracker frame, update 0.2-0.35 ms per render frame |

## Files

`pipeline.js` orchestration · `mhrFK.js` MHR FK + validation · `solvers.js` MHR / keypoint solvers ·
`heroRig.js` VRM hierarchy + hero rest skeleton + hero FK · `track.js` predictor + springs · `ik.js` two-bone IK,
contacts, foot lock, hinge limits · `layers.js` procedural base, confidence, accents · `hands.js` hand
classification + authored poses · `metrics.js` · `math.js` · `lab.js` motion lab page.
Sources: `../sources/recordedSource.js` (replay + `Recorder`); clip `public/motion/clips/demo-hmr.json`
recorded with `server/tools/record_clip.py`.
