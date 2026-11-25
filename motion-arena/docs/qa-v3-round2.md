# QA v3, round 2: re-score after the round-1 fix pass

Reviewed 2026-11-25 by the art director / QA lead. Same setup as round 1: headless Chrome over CDP at 1440×900, DSF 1, Metal ANGLE, with Vite on :5173 and InstantHMR on :8791. Code reviewed at `0635ff4`. Every team claim was checked in the running game, not in the diff. Evidence images are in `docs/qa-v3-round2/`. Punch, kick and jump frames come from back-to-back bursts at about 133 ms per frame, with the synthetic move locked (`sources.synthetic.phase`) and its clock reset so the frame timing is known.

Bar (unchanged): Genshin / Star Rail-level character appeal, adapted to a webcam Kinect-style browser game.

## Verdict

**Overall 6.0 / 10, up from 4.6. Better, but still not at the publisher bar.**

The rendering fixes landed:

- Authored colours are back: ash-pink hair, no orange streak, no neon nape, neutral lights and grade.
- Outlines are thin and tinted, with no pale halo on dark cloth.
- Fists read clearly, with the thumb wrapped and the wrist straight.
- The kick now has a real chamber → snap → retract.
- Combat FX are live in the game.

The hero now looks like what it is: a well-rendered stock VRoid avatar.

What still blocks a vertical slice:

1. **New, gameplay-breaking: phantom punches.** Raising both arms (hands up, jump take-off, T-pose, wave) fires `punchLeft` and `punchRight` together. Each one gets hit-stop, sparks, floaters and an arm-flung accent pose.
2. **Strikes still don't read as a fighter's.** Every punch travels about 45° across the body. From the Front camera it reads as a sideways swipe, not a jab. Every kick fires twice, so a second low "kick" lands at floor level.
3. **The model itself** (unchanged since round 1, see the gap split below).

## Scored rubric (round 1 → round 2)

| Area | R1 | R2 | Notes |
|---|---|---|---|
| Character appeal | 4 | **4.5** | The fists-up guard and authored colours help. It is still a 1.91 m generic VRoid schoolboy with no silhouette hook, signature colour or costume story. |
| Face | 6 | **6.5** | Clean, blotch-free shading at 3/4 and in profile (`mont_face.png`). The SDF face shadow is built (`faceSDF: true`) but is almost never visible, because the key light is locked to the camera (from the front). The action expressions are wired, but "determined" reads as a half-lidded smirk or wince with bared teeth, not focus (`mont_expressions.png`). A white lip highlight sits under the mouth like a dot. |
| Hair | 3 | **6** | Ash-pink is restored and the coral and orange streak are gone (`hair_34_back.png` vs round-1 `cmp_face.png`). The nape is now a dark plum under-layer. That's much better than neon violet, but it reads as a separate dark cap under the pink top. The 30 % tame turns the authored lavender tip shade grey-brown. The angel ring exists (`hair_ring_ab.png`) but is a soft milky smear broken across the strand cards, not a crisp band. |
| Costume | 4 | **4.5** | The trousers now show folds and the inner forms read (`body_close.png`). There is still no design intent for a fighter. The short-sleeve interior glows lavender when the arm is raised (back rim on backfaces). |
| Shading / colour fidelity | 3 | **7** | Authored shade colours and textures are kept. Toony is 0.6–0.75 from the authored values, matcap is 0, and the grade is at saturation/contrast 1.0. Lights are neutral (key #fffcf8, ground #d9d3cc). The result matches the authored reference closely. |
| Outlines / rim | 5 | **7** | Body line 0.0045 / face 0.0035, tinted (authored maroon on skin, hue-tinted on hair). No pale halo on the vest or trousers. The lit-side rim is subtle and correct. The only remaining issue is the sleeve-interior glow above. |
| Lighting | 5 | **6.5** | Neutral key and fill, and the cool back rim (#bcd4ff, 0.85) separates the hero from the warm deck. The camera-locked frontal key still flattens the face and hides the SDF work: there is no modelling light. |
| Secondary motion | 5 | **5** | No change. The short hair and tie give little secondary motion, and there was no clipping in the bursts. |
| Motion quality | 5 | **6** | See the breakdown below. |
| – responsiveness | 7 | 7.5 | Synthetic p50 39 / p95 46 ms. Motion lag 48 ms over the loop and 60 ms on jumps (was 100 ms hands-up). HMR p50 44 / p95 74. MediaPipe 39 / 42. |
| – smoothness | 6 | 7.5 | `jitter.ok` on every source. Loop out/raw 1.63/1.92, jumps 1.18/1.34 (was 4.27/1.97), HMR 0.22/0.95, MediaPipe 0.04/0.11. **Caveat:** standing guard is out 0.088 vs raw 0.038, which is 2.3× raw. It passes only because of the new +0.05 tolerance. |
| – foot contact | 7 | 7.5 | Skate after the lock is 0 on every source. The squat knees now go forward (side view, `mont_poses.png`). The front guard is still near-straight legs with parallel feet. |
| – punch / kick / jump readability | 3 | 5.5 | Fists are fixed (`mont_fists.png`). The kick chamber/snap/retract is good (`mont_kick_side.png` frames 02–07). But every punch is a cross-body diagonal (`mont_punch_top.png`). Each kick fires twice. Phantom double punches appear on arm raises. Jumps have stiff straight legs and open flat hands. |
| Combat FX (new row) | – (not in game) | **6.5** | Wired. Hit-stop 60/80 ms through `pipeline.hitStop`, sparks, star flash, shock ring, trails and landing dust all show in the captures. Shake at punch trauma 0.32 works out to about 3 mm and 0.1° (barely perceptible). The kick flash and ring fill the face at head-height kicks (`mont_kick_front.png` frame 03). The kick trail reads as a straight blue blade (frame 02). |
| Game presentation | 5 | **6.5** | The compact play HUD is the default on Start, with H for the full HUD. Hero at 65.7 % of viewport height with no HUD overlap (`g_play_compact.png`). Floaters sit by the shoulders, but they cross the face in Side view and on cross punches (`mont_punch_side.png`). The camera crops the head at the top of a jump (`mont_jump.png` frame 03). |
| Performance | 8 | **8** | 60 fps on High at DPR 1. 112 draws, 169.8k triangles, hero 0.40 ms, motion solve about 0.16 ms and update 0.35 ms. |

## Round-1 items: verified fixed / partial / regressed

| R1 ID | Status | Evidence |
|---|---|---|
| P0-1 hair colour | **Fixed** | Ash-pink top, no orange shade band (`hair_34_back.png`). The authored shade is kept and tamed 30 %. Side effect: the tips go grey-brown instead of lavender (P2-1). |
| P0-2 warm stack | **Fixed** | Key #fffcf8, hemisphere ground #d9d3cc, grade saturation/contrast 1.0 with a white highlight tint. Skin and hair no longer go orange. |
| P0-3 open palms / bent wrists | **Fixed** | Closed fists with the thumb wrapped on the guard and the punch. The wrist is straight at full extension (`mont_fists.png`, frames p4/p5). Relaxed hands are curled toward the thighs (`body_close.png`). |
| P1-1 neon nape | **Partial** | Now a dark plum, which is no longer neon. But it is too dark and disconnected from the pink top (P2-2). |
| P1-2 pale halo | **Fixed** | No halo on dark cloth at 1×. A new minor artefact: the sleeve-interior glow (P2-6). |
| P1-3 toony/shift | **Fixed** | 0.6–0.75 from the authored values. No blotchy cheek bands at 3/4. |
| P1-4 outlines | **Fixed** | Thin and tinted. |
| P1-5 plank legs / sideways knees | **Fixed (squat)** | The squat knees point forward with a correct bend from the side. The guard legs are still nearly straight (a P2 polish item). |
| P1-6 predictor amplifies noise | **Fixed** | Hands-up out 1.18 < raw 1.34. The still-pose ratio of 2.3× is hidden by the tolerance (P2-4). |
| P1-7 prayer guard / knee-raise kick | **Fixed / regressed** | The guard has separated fists at the chin, and the kick has a real chamber → snap. **But every kick now triggers twice** (P1-1 below). |
| P1-8 generic model | **Open** | Model unchanged. |
| P2-1 HUD | **Fixed** | The compact HUD is the default in play. |
| P2-2 floaters | **Partial** | Anchored by the shoulder and clamped. They still cross the face in Side view and on cross punches. |
| P2-3 cool back light | **Fixed** | — |
| P2-4 flat skin | **Fixed** | Warm lit-side rim, subtle. |
| P2-5 tray hands | **Fixed** | Synthetic, MediaPipe and the base pose are fixed. With InstantHMR in the T-ish rest, palms still face forward/up (`hmr_fake` capture). |
| Improvement 2: SDF face + angel ring | **Partial** | Both are implemented. The SDF is hidden by the frontal key. The ring is soft and smeared (`hair_ring_ab.png`). |
| Improvement 3: combat juice | **Done, tuning needed** | See the Combat FX row. |
| Improvement 4: stance / expressions | **Partial** | Guard, breathing and weight shift are present. The determined expression reads wrong. |

## Remaining defects

### P0: blocks showing the game

| ID | Where | What's wrong | Fix | Owner |
|---|---|---|---|---|
| P0-1 | Any source. Synthetic: hands up, jump take-off, T-pose, wave | **Phantom double punches.** A fast arm raise or arm spread fires `punchLeft` and `punchRight` together. Event log: `handsUp, punchLeft, punchRight`, then `tPose, punchLeft, punchRight`, then `rightHandUp, punchLeft, punchRight`. Each fires the punch accent (arms flung sideways, `mont_jump.png` frames 00–01 and `mont_poses.png` ft_00), plus hit-stop, sparks and floaters, and it would score in the Reaction Test. | Gate punches on direction. The wrist velocity must point forward (toward the camera or depth axis, relative to the torso's facing), the wrist must stay between hip+0.2 and head height, and the elbow must stay below the shoulder line. Never fire both punches in the same 120 ms window. Suppress punches while `handsUp`, `tPose`, `*HandUp` or `jump` are entering. Add a synthetic regression test: phases 4, 5 and 6 must produce 0 punches. | `web/src/actions.js` (punch block, about l.138–152) and the pipeline's action wiring in `web/src/motion/pipeline.js` |

### P1: must fix before the next review

| ID | Where | What's wrong | Fix | Owner |
|---|---|---|---|---|
| P1-1 | Kicks, any view | **Every kick fires twice**, about 630 ms apart: `kickLeft` at 13197 and 13827 ms, each with an impact. A second low kick with floor-level sparks plays during the lowering (`mont_kick_side.png` frames 08–09, `mont_kick_front.png` frames 07–08). | The kick condition uses ankle-speed *magnitude*, so it re-arms on the way down after the 600 ms cooldown. Require an upward/forward ankle velocity, and re-arm only after the foot is back within 0.08 × ruler of the floor (hysteresis), or use a cooldown ≥ the accent length (0.95 s). | `web/src/actions.js` (kick block, about l.162–168) |
| P1-2 | Punches, Front / Top | **Cross-body swipe instead of a straight punch.** Measured in hero space: shoulder (−0.05, 1.48, 0.16) → fist (0.34, 1.58, 0.39). That is 0.39 m lateral against 0.23 m forward, about 59° off the forward axis. The synthetic target is about 11° inward. From Front it reads as a sideways arm sweep (`mont_punch_front.png`, `mont_punch_top.png`). Cause: the accent chain adds about 0.76 rad of yaw (hips 0.09 + spine 0.08 + chest 0.13 + upperChest 0.16 + shoulder 0.30, with 12 % overshoot) on top of the tracked torso twist, and it carries the tracked arm with it. | Cap the total accent yaw at about 0.3 rad. Then re-aim the punching arm with the reach IK at the *world-space* target (the tracked wrist direction pushed along shoulder→target), so the torso turns under a fist that keeps travelling straight. Accept when the fist path is within 20° of shoulder→target. | `web/src/motion/layers.js` (punch accent, l.205–225), `web/src/motion/ik.js` |
| P1-3 | Jump, Front | The camera crops the head and raised hands at the top of the jump (`mont_jump.png` frame 03). The 65.7 % framing leaves no headroom. | Keep the 65 % framing for standing, but follow the hips vertically (y follow 0.5) or ease the camera back during `jump` / `handsUp`. Measure that the top of the head plus hands stays ≥ 4 % below the top edge on synthetic phase 4. | `web/src/main.js` (camera follow, about l.812–818; `VIEWS.front`) |
| P1-4 | Character appeal | The stock VRoid schoolboy limits every other score (see the gap split below). | PLAN path A: a custom hero with a signature silhouette, one accent colour and a game costume at 1.6–1.7 m stylised proportions. | `docs/character-art-spec.md`, `web/src/vrm/models.js` |
| P1-5 | Face, actions | The "determined" preset reads as a pained squint or smirk with bared teeth (`mont_expressions.png`, round-2 closeups). It is the face players see on every strike. | Build "determined" from brow-down + eyes ~0.15 squint + mouth closed or slight "angry". No teeth and no >0.3 blink. Save teeth for a kiai on the kick snap only. Ramp in over 80 ms and hold 400 ms. | `web/src/vrm/hero.js` (expression presets) |

### P2: polish

| ID | Where | Issue | Fix | Owner |
|---|---|---|---|---|
| P2-1 | Hair shade | The 30 % tame turns the authored lavender tip shade grey-brown. The milk-tea + lavender signature is lost. | Tame toward a darker version of the *authored shade hue* (keep the hue, reduce saturation and lightness). Use 15–20 %, not 30 %. | `web/src/vrm/mtoonTuning.js` (hair branch) |
| P2-2 | Nape (Behind) | The dark plum under-layer reads as a separate cap under the pink top (`hair_34_back.png`). | Raise its lightness to about 0.6× the main hair (now `max(l, mainL*0.55)` on a dark base). Keep saturation ≤ 0.15 and hue 35 % toward the main hair. | `mtoonTuning.js` (offHue branch) |
| P2-3 | Angel ring | Present but a soft milky smear, broken across strand cards (`hair_ring_ab.png`). | Narrow the band and raise its intensity on High. Shift it per strand with a noise jitter, tint it toward a light lavender, and mask it to the crown (head-space up · N). | `web/src/vrm/mtoonPatch.js` |
| P2-4 | Jitter, still poses | Guard out 0.088 vs raw 0.038 rad/s (2.3×). The +0.05 tolerance hides it. | Add a ratio check (out ≤ 1.2 × raw when raw > 0.02) next to the absolute tolerance. Find which stage adds the micro-motion (base breathing leaking into "out", or predictor overshoot). | `web/src/motion/metrics.js`, `web/src/motion/track.js` |
| P2-5 | Face light | The camera-locked frontal key hides the SDF face shadow and flattens the face. | Offset the key azimuth about 30–40° from the camera, so 15–25 % of the face falls in SDF shadow at Front. | `web/src/render/heroLights.js` |
| P2-6 | Sleeves | The short-sleeve interior glows lavender when the arm is raised or extended (`mont_fists.png`). | Mask the back rim and lit-side rim by `gl_FrontFacing`, or zero them on backfaces. | `web/src/vrm/mtoonPatch.js` |
| P2-7 | FX | The kick flash and ring cover the face on head-height kicks. The kick trail is a straight blade. Punch shake is about 3 mm, which is imperceptible. | Offset impact sprites forward along the strike direction and cap the ring size where it crosses the head's screen rect. Add a curved arc to the kick trail. Punch trauma 0.45 to give noticeable but small shake. | `web/src/fx/index.js`, `web/src/fx/trails.js` |
| P2-8 | Floaters | They cross the face in Side view and on cross punches (`mont_punch_side.png`). | Exclude the head's screen rect when placing floaters (push them to the outer side of the shoulder). | `web/src/main.js` (floater) |
| P2-9 | Stance / jump | The guard has near-straight legs with parallel feet from the Front. The jump has straight legs and open flat hands. | Bend the knees a minimum of 8–12° in the guard base. Tuck the knees about 30° at the jump apex. Use a loose-fist hand pose on the jump. | `web/src/motion/layers.js`, `web/src/motion/hands.js` |
| P2-10 | Wave | The waving hand points one finger up and reads as "pointing". | Open hand with spread fingers on `rightHandUp` / wave. | `web/src/motion/hands.js` |

## How much of the remaining gap is the model vs us

Of the roughly 2.5 points between 6.0 and the bar (about 8.5), I'd attribute **about 60 % to the stock model** and **about 40 % to our rendering and motion**.

**The model (stock VRoid schoolboy):** appeal, costume, silhouette and secondary motion are capped at about 4.5–5 whatever we do. Those are the four lowest rows. The causes:

- Lanky 1.91 m proportions.
- A navy-and-black uniform mass with no accent shape.
- Short hair with almost no spring chains.
- A tie as the only moving costume element.
- No prop and no signature colour.

The face and eyes are professional and are not the problem. A custom hero (PLAN path A) is the only way past about 6.5 overall.

**Our rendering and motion:** nearly all of the remaining readability and presentation loss is ours:

- Phantom punches, double kicks and the cross-body punch path.
- Jump framing.
- The expression tuning.
- The frontal key hiding the SDF.
- Ring and nape polish.

These are cheap: about 2–3 days in total. Fixing them should take the current model to about 6.8–7.0.

## Top 5 highest-leverage improvements remaining

1. **Make the triggers trustworthy (P0-1, P1-1).** Direction-gated punches, kick re-arm on foot-down, and synthetic regression tests (phases 4–6 give 0 punches, each kick fires exactly once). It's a motion game: false triggers and doubled hits undermine both scoring and the juice.
2. **Straight, snappy punches (P1-2).** Cap the accent yaw and re-aim the fist at the world target with reach IK. That plus the fists that already landed turns the punch from the weakest pose into the strongest one.
3. **The custom hero (P1-4).** Signature silhouette, accent colour, game costume, 1.6–1.7 m, layered hair with real spring chains. This is the single biggest remaining appeal lever, and no shader work substitutes for it.
4. **Face and expression pass (P1-5, P2-5).** Offset the key so the SDF face shadow models the face, and rebuild "determined", a scoring grin and a hit-react expression. The face is the model's best asset, so make it act.
5. **Presentation finish (P1-3, P2-7, P2-8).** Jump headroom, FX that never covers the face, floaters that never cross the head, and slightly stronger punch shake.

## Reproduction

- Bursts: game `/`, Source "Synthetic demo player" → Start. Then `sources.synthetic.phase = N; sources.synthetic._t0 = performance.now() - u0*1000` and take back-to-back CDP screenshots.
- Event log: `motion.events.on('impact', …)`, `motion.events.on('land', …)` and `actions.on(…)` over the 28 s loop. Phantom punches appear at the start of phases 4, 5 and 6, and kicks fire twice per kick.
- Punch path: per rAF, read `character.bones.{left,right}{UpperArm,Hand}` world positions → `character.root.worldToLocal`.
- Metrics: `T.run(kind, warm, ms)` from `integ/helper.js` with `?fakecam=1`. Synthetic over the full loop (3 s warm, 28 s), plus phases 4, 5 and 0 locked (8 s), HMR (7 s warm) and MediaPipe (9 s warm). With the fake camera the e2e lag for HMR and MediaPipe is unreliable, because the GIF barely moves.
- Angel ring A/B: set `uHairSpec` on the hair entries of `character.materials.entries` to 0 and then to 0.42.
