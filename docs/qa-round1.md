# Hero v2: QA Round 1

Reviewer: Character Art Direction / QA (author of `docs/character-art-spec.md`)
Build: live Vite build at review time (it hot-reloaded several times during review; the hair and dynamics packages landed partway through)
Method: `character-preview.html` at 1440×900, with every pose preset seen front, side and 3/4. Light sweep run with the light-angle hook. Measurements were taken from skinned vertex positions (`SkinnedMesh.getVertexPosition`) and palette values from `readPixels` on the rendered frame. Then the game (`/`) with the Synthetic demo player: Front, Behind and Side cameras, and the Free Move, Reaction Test and Pose Match modes.
In flight, so noted but not critiqued in detail: (a) the hair redesign and the brow backing patches, (b) secondary motion (sash tails, hem, sleeve and hair springs).

---

## Verdict

**Not shippable yet. Overall 6/10, up from 3/10.** This is a real character now, no longer a primitive prototype. The body, the continuous skinning, the costume construction, the face atlases and the toon pipeline are the right architecture, and most of the pose set holds. The colour pipeline is pixel-exact. What blocks shipping is a short list of concrete problems:
- The build is over the triangle, shadow-draw and load-time budgets.
- Shading on the back of the shirt breaks into irregular dark islands. This is the same "blotch" complaint as v1, now caused by lumpy normals rather than shadow maps.
- The head is about 11% too wide, so the face reads as a moon face.
- The mouth and eye decals leave the face silhouette in 3/4 and profile views.
- The fur cuff still reads as a donut in high knee.
- Garment widths at the shoulders and pelvis are out of tolerance.
- The rim light does not separate the silhouette in-game.

None of these needs a re-architecture.

---

## 1. Scored rubric (v1 → v2)

| Area | v1 | v2 | What changed / what still holds it back (view) |
|---|---|---|---|
| Silhouette / readability | 4 | 6 | Arms-down front: sleeves now hang as real bell sleeves, with no flaps or capes. The pose set reads cleanly at game cam. Held back by: boxy shirt shoulders (0.52 vs 0.45); a wide skull and jaw that makes the head heavy; and the Side game view, where the face reads blank (the eyes vanish edge-on). |
| Proportions vs reference | 4 | 6 | The torso is on spec: chest 0.292×0.181, waist 0.236×0.160, chest:waist 1.24, pelvis 0.279×0.186. Hands are 0.175 with five digits. Off: skull width 0.222 vs 0.200 (h/w 1.15 < 1.2); shirt shoulder width 0.52 (+15%); shorts pelvis 0.40 W vs 0.34 (+18%). Visual head is 0.324 with the in-flight hair, vs 0.30. |
| Face appeal | 5 | 7 | Face cam: big round dark eyes with a crisp double catch-light. All 8 expressions are strong and distinct (grin, determined clenched teeth, surprised O, wince > <, laugh ∩∩ with blush). No nose ball. Held back by: a wide flat "moon" face; the mouth and tongue protruding past the cheek silhouette at 3/4 to 70°; the eye squashed to a sliver at 70° and invisible in profile; and a shelf under the jaw on head turns. |
| Hair | 3 | 4 (provisional) | In flight; not scored for ship. The version that landed mid-review is a chunky mop with highlight strips, which is the right direction. It currently measures 1.45× skull width and the top sits at 1.814, so the visual head is 0.324. |
| Costume fidelity | 4 | 7 | Big step up. One welded shirt with an open V, a stand-and-fall collar, a placket band, 4 gold buttons on the wearer's right, a hem tucked at the front and flared at the back, and bell cuffs with 6 scallops, inner band and visible thickness. Sash band with knot on the wearer's left, cloud-lobe fur, strapped sandals, fly stitching. Off: the shorts are hip-heavy; the rolled cuff band doesn't read; the fur ring faces the camera in high knee. |
| Shading / lighting | 3 | 6 | `readPixels` gives exactly #F7D2B2 (skin base) and #E39C7F (skin shade). No grey ramp. The arena shadow is correctly thresholded with self-shadow suppressed. The SDF face shadow behaves across the sweep. Off: the back and side of the shirt show irregular "Rorschach" shade islands from noisy Surface Nets normals (proven: they persist with arena shadows off and the head hidden). The face shadow at the default 35° splits into two islands. The rim is too weak to read in-game. |
| Outlines | 5 | 7 | Screen-space, tinted per material (brown skin, maroon shirt, lavender fur). Smoothed normals, so no hull splits seen. Painted inner lines, so no tube lines. Off: the face front has width 0, so in 3/4 and profile the forehead-to-cheek silhouette has no line and looks unfinished. Face-cam width is about 1.8 px at 900p (target 2.5 to 3.5). |
| Deformation in motion | 2 | 7 | The biggest win. No crotch gap in squat, star jump or side kick. Elbows and knees hold volume. No candy-wrapper at a 90° wrist twist. Sleeves clear the head with arms overhead. The abdomen twists smoothly. Off: the fur donut in high knee and front kick (front view), and a neck–jaw shelf at a 70° head turn. |
| Secondary motion | 4 | n/s | In flight (WP5). Observed during review: sash tails now hang and swing but pass through the thigh and calf in high knee, front kick, squat, side kick and star jump. The tail adds a 5th shadow-pass draw. |
| Overall shippability | 3 | 6 | Solid vertical-slice quality. Fix the P0 list below and this can go to a round-2 ship review. |

---

## 2. Section 4 checklist: pass / fail

Legend: **PASS**, **FAIL**, **DEFER** (owned by an in-flight package), **N/V** (not verifiable in this environment).

### A. Contract and technical
| Item | Result | Note |
|---|---|---|
| A1 retarget/tests/actions/main unchanged, game runs, Pose Match parity | PASS (partial) | The game runs in Free Move, Reaction Test and Pose Match with the synthetic player. No VCS, so "unchanged" can't be diffed. `main.js` is edited by WP6, as the plan intends; this conflicts with the checklist wording, so fix the spec text. T-pose ghost score parity with v1 not measured. |
| A2 19 bones + 5 markers, identity rest, feet y=0, headTop 1.75, faces +Z | PASS | `checkRig()`: 24 entries, max error 2e-16, no non-identity rest rotations. Body min y 0.016 is the sole. |
| A3 draws ≤14 (+≤4 shadow), tris ≤60k, update ≤0.4 ms, load ≤400 ms | **FAIL** | Draws 13/14 OK. **Shadow draws 5/4.** **Tris 80,199/60k** (costume 41.5k, body 17.9k, hair 10.7k, head 7.2k, face 1.7k, sash tails 1.2k). update(): 0.06 ms avg / 0.30 max over 600 static frames; the HUD showed 0.2 to 0.55 ms (one 1.55 spike) once dynamics landed, so re-measure after WP5. **Build 522 ms, synchronous, and it blocks the first frame.** |
| A4 60 fps with webcam for 2 min | N/V | The Browser pane blocks the camera. The synthetic player renders at 120 fps. |
| A5 no console warnings; dispose frees all | PASS | Clean console apart from my own bad pose name. A second hero created, rendered and disposed takes renderer geometries 10→18→10 and textures 10→17→10. |

### B. Proportions and silhouette
| Item | Result | Note |
|---|---|---|
| B1 visual head 0.30±0.01; skull h/w ≥1.2 | **FAIL** | Skull 0.255 tall × **0.222 wide → h/w 1.15**. Visual head 0.324 with the in-flight hair. |
| B2 shoulders 0.42 skin / 0.45 shirt ±0.02; chest:waist 1.2±0.05 | **FAIL** | Chest:waist 1.24 OK. **Shirt shoulders 0.52.** Skin deltoids about 0.47 (note: the spec's joint x 0.175 + deltoid r 0.052 already gives 0.454, so WP0 has to resolve that arithmetic). |
| B3 fingertips mid-thigh; hand 0.175±0.005 | PASS | Fingertips y 0.674, at mid-thigh (0.665). Hand 0.175. |
| B4 arms-down sleeves hang as bell sleeves; lean teen | PASS | Bell sleeves hang correctly. Lean athletic torso. |
| B5 side-by-side: same style family; no forbidden IP | PASS (provisional) | Palette, outfit language and attitude match. No scar, hat, name or logo. Note: the likeness to the reference is very close; recommend a legal/IP read before external showing. Re-review once the head is narrowed and the hair lands. |

### C. Face
| Item | Result | Note |
|---|---|---|
| C1 eye placement/size, iris 80%, catch-light + dot | PASS | Reads correctly in the face cam (built from `dims.FACE`). Main catch-light upper-outer plus a secondary dot. |
| C2 brows over bangs in all expressions | PASS (provisional) | In the build that landed mid-review, the brows read over the fringe in every expression, with no backing patches. Owned by the hair package. |
| C3 no nose ball; wedge flips with light | PASS (partial) | Small 2D nose mark, no sphere. The flip with light angle was not isolated. |
| C4 8 mouths, 7 eye states, blink 0.16 s, auto-blink | PASS | All expressions render with no gaps or z-fighting. Half and closed blink correct. (`neutral` reads as a soft smile, not a near-flat line: P2.) |
| C5 light sweep 0/±30/±60/±90: one clean shape, never crosses an eye | **FAIL** | Never splits an eye, and ±90 gives a clean nose-line split. But at the default 35° the shade forms **two islands** (temple, and a separate jaw wedge with lit cheek between). The face light also **lags one frame** behind the body key light: in rendered frames the face is shaded on the opposite side to the body after a light or camera change. |
| C6 3/4 views: decals stretch ≤10%, stay on curvature; ears visible | **FAIL** | Ears visible. But the **mouth (lip and tongue) protrudes past the cheek silhouette** from 45° to 70° yaw and on 70° head turns, and the near eye squashes far beyond 10% at 70°. |
| C7 game cam face ≥80 px @1080p, expression readable <1 s | PASS | About 96 px at 1080p (80 px at 900p). Grin, determined and surprised are clearly distinct. |

### D. Hair (DEFER: in-flight package)
| Item | Result | Note |
|---|---|---|
| D1 7–9 tips, width 1.30±0.05 skull, aspect ≤2 | DEFER | Current: 1.45× skull width. |
| D2 fringe of 5 points, side locks top third of ear, nape flicks | DEFER | |
| D3 one-mass shading, angel ring broken band, no backfaces | DEFER | The new build has highlight strips. |
| D4 head shake: bangs lag ≤4° | DEFER | Springs not active. |

### E. Costume
| Item | Result | Note |
|---|---|---|
| E1 shirt V, collar, placket, 4 buttons + loops, hem tuck/flare | PASS | All present. The collar reads as a generous lapel, which is acceptable. Loops on the left panel weren't checked closely. |
| E2 sleeve ends 0.06 below elbow; cuff r 0.085, 6 scallops, inner band | PASS | Scallops and inner band clearly visible. Thickness rim visible (T-pose close-up). |
| E3 every cloth edge has thickness + outline | PASS | Shirt and cuffs pass. Re-check the new dynamic sash ribbon once WP5 lands. |
| E4 sash band, double wrap, knot ~50° left, long tail 0.49, short 0.24 | PASS (provisional) | Knot on the wearer's left. Long tail tip y 0.467 (−5%). The short tail did not read distinctly. Tails are now owned by WP5. |
| E5 shorts baggy (r 0.105), hem 0.09 above knee, rolled cuff, pockets/fly | **FAIL** | Hem y 0.550 OK; leg opening r about 0.095 OK. **Pelvis 0.40 W vs 0.34 (+18%)**: hip-heavy. The **rolled double-roll band does not read**. Fly J-stitch visible; pocket lines faint. |
| E6 fur: cloud lobes, cool shade, thinner lavender outline | PASS | |
| E7 sandals: sole, toe/instep/heel straps, toes visible | PASS | Heel strap not inspected closely. |

### F. Shading, outlines, colour
| Item | Result | Note |
|---|---|---|
| F1 swatch ΔE<3 in-game | PASS (preview) | Pixel-exact skin base and shade in the preview, which uses the same `configureRenderer` (Neutral) with `toneMapped:false` character materials. Not re-sampled in the game scene. |
| F2 two tones + crease deep; no grey; no self-shadow blotches (back view) | **FAIL** | Back view (preview and the Behind cam): **large irregular dark islands on the shirt back and right side**, which move with key angle and persist with arena shadows off and head/hair hidden. They come from Surface Nets normals, not shadow maps. Also a dark deep-tone blob at the shorts crotch in the front view. |
| F3 rim on lit silhouette in Front/Behind/Side; not on face front | **FAIL** | Implemented, but at intensity 0.45 and width 0.62–0.68 it doesn't visibly separate the silhouette from the sea or sky in any game view. |
| F4 outline 2.2±0.4 px game cam, ≤3.5 face cam, tinted, tapered, no splits/bleed | PASS | Implementation matches the spec. Tinted, no splits seen. (P1: no line on the face silhouette in 3/4/profile. P2: face-cam width about 1.8 px at 900p.) |
| F5 no inner-line shimmer on turntable | PASS | Painted atlas lines with MSAA (`antialias:true`). |

### G. Deformation pose set
| Pose | Result | Note |
|---|---|---|
| T-pose | PASS | Even cloth offset, no gaps. |
| Arms overhead | PASS | No sleeve–head or hair intersection (front, side, 3/4, back). Buttons stay on the placket. The back shows the F2 shade islands. |
| Hands on head | PASS | Elbows hold. Hands rest on the hair without obvious sinking. |
| Punch L/R | PASS | Cuff reads as a bell from the side. Fist morph active on the punching hand. (P1: guard hand stays open even though the preset says `fist:'both'`.) |
| Goal post | PASS | Sleeve covers the elbow; elbow volume good. |
| Deep squat | PASS (sash DEFER) | No shorts–pelvis gap, smooth crotch, fur stays on the thigh, knee volume good. Sash tail passes through the calf (WP5). |
| High knee | **FAIL** | Shorts leg follows the thigh. But **the fur cuff faces the camera as a ring with the knee poking through the hole ("lifesaver")** in the front view. Sash tail crosses the thigh (WP5). |
| Front kick | PASS (fur note) | Hamstring and seat smooth with no back gap (side view). The front view shows the same fur ring (covered by the high-knee defect). |
| Side kick / star jump | PASS (sash DEFER) | Inner-thigh cloth stretches cleanly. Tails clip the left thigh (WP5). |
| Twist + lean | PASS | Abdomen and shirt panels twist smoothly; no shirt–sash gap. |
| Wrist twist ±90 | PASS | No candy-wrapper. |
| Head turn ±70 / tilt ±30 | **FAIL** | Collar clears the jaw and hair clears the shoulders. But at 70° a hard shade step and shelf shows where the neck tube enters the jaw, and the mouth decal protrudes (see C6). |

### H. Secondary motion: DEFER (WP5 in flight)
Noted for the WP5 acceptance pass: the tails currently penetrate the legs in 5 of the 12 poses, and the tail mesh adds a 5th shadow draw.

### I. Presentation (game)
| Item | Result | Note |
|---|---|---|
| I1 front view 58–65% height, centred, clear of HUD | PASS (1440×900) | About 61% at 1440×900 and clear of both panels and the camera inset. 1920×1080 not checked. |
| I2 Behind/Side: camera-locked key, rim separates from sea/sand | **FAIL** | The key light is camera-locked and consistent. The rim doesn't read (F3). In the Side view the face reads blank (eyes edge-on). |
| I3 contact blob, feet planted ≤1 cm | PASS | Blob present. Feet planted in idle and squat. |
| I4 post-fx no haze, ≤1.5 ms | N/A | No post chain enabled (P2 package not started). |

Tally for A–G (excluding DEFER and N/V): **9 FAIL** (A3, B1, B2, C5, C6, E5, F2, F3, G-high-knee) plus G-head-turn. The ship bar requires all A–G to pass.

---

## 3. Prioritised defect list

P0 = fails an A–G ship-bar item, or a visible artifact in a default game view. P1 = an H/I item or a quality issue a publisher reviewer will flag. P2 = polish.

### P0: must fix for shipping

| # | View / pose | What's wrong | Concrete fix | Owner |
|---|---|---|---|---|
| P0-1 | Perf HUD, any | **80.2k tris vs 60k.** Costume alone is 41.5k (budget for body+cloth together is 30k); head 7.2k vs 6k; hair 10.7k vs 8k. | Costume: raise `VOXEL_SCALE` from 1.35 to about 1.7 on the torso and leg interiors and keep cut-edge resolution. Decimate the inner thickness shell to 50% (it's mostly hidden). Run quadric decimation (target 22k) after smoothing. Head: drop to 48×36 outside the face front. Hair: hold the 8k budget in the redesign. | costume/ (shirt.js, shorts.js, sdf.js); head/head.js; head/hair.js |
| P0-2 | Load | **Generation takes 522 ms synchronously** and blocks the first frame (budget 400 ms, ≤250 ms per block). | Split Surface Nets and smoothing into per-garment tasks behind `requestIdleCallback`/`await` yields. Cache the generated costume geometry (IndexedDB or a build-time JSON bake keyed by a hash of `dims`). Show a placeholder hero on frame 1. | costume/sdf.js + render+main+preview (index async build hook via WP0) |
| P0-3 | Perf HUD | **5 shadow-pass draws vs 4.** The new `sashTails` mesh casts shadow. | Set `castShadow=false` on the sash tail mesh and let the costume shadow proxy cover it, or merge tails into the costume shadow-only draw. | dynamics/ (sashRibbon.js) |
| P0-4 | Back view, Behind cam, side view, arms overhead and squat (back) | **Irregular "Rorschach" shade islands on the shirt back and sides.** The terminator follows lumpy Surface Nets normals and moves with the key angle. Same reading as the v1 PCF blotches. | Blend shirt normals 70/30 toward a smooth proxy (the un-cut torso SDF sampled at 3 cm blur, or an analytic torso ellipsoid-capsule), as on the face and hair. Add 2 extra normal-only smoothing passes (normals, not positions). Optionally nudge back `shadeBias` +0.05 so the default key light at the back sits fully lit except near the side terminator. Verify with the key-angle slider at 35° and −35° in the back view. | costume/shirt.js (normals); materials/toon.js (optional) |
| P0-5 | Front, face cam, 3/4 | **Skull 0.222 wide vs 0.200 (h/w 1.15 < 1.2).** Wide jaw, so the face reads as a moon face; it is the main appeal gap vs the reference. | Scale the head displacement field laterally ×0.90 above the jaw. Taper the jaw to the spec chin (0.050 wide at chin+0.012; currently about 0.09 at y 1.51). Re-check the ear x (0.098) and hair cap offset afterwards. | head/head.js (+ hair cap follow-up in head/hair.js) |
| P0-6 | Arms-down front | **Shirt shoulders 0.52 vs 0.45; skin deltoids about 0.47 vs 0.42.** Boxy upper silhouette. | Shirt: cut the shoulder fit offset to 0.018 at the deltoid and reduce the arm capsule radius at the sleeve head; drop the shoulder seam 0.02 down the arm per spec. Body: WP0 to resolve the spec arithmetic (joint x 0.175 + r 0.052 = 0.454): either deltoid r 0.040 or upper-arm x 0.165. | costume/shirt.js; body/ (profiles) + WP0 dims |
| P0-7 | Front, 3/4 | **Shorts pelvis 0.40 W vs 0.34 (+18%).** Hip-heavy, reads as a skirt from the front. | Reduce the pelvis ellipsoid in the shorts SDF to 0.34 W × 0.23 D. Keep leg bagginess with the thigh capsules (opening r 0.105). | costume/shorts.js |
| P0-8 | 3/4 (45°–70°), head turn 70°, Side cam | **The mouth decal (lip and tongue) hangs past the cheek silhouette**, and the eye squashes to a sliver at 70°. The decal isn't conforming to the head surface. | Build the mouth and eye decal meshes by projecting the atlas quads onto the actual head surface (raycast or closest-point onto the head mesh, offset 0.0008 along the normal) instead of a 0.95 W cylinder. Clip to the face mask. Fade the mouth interior with a soft N·V term past 65°. For eyes, wrap the eye patch slightly further round the cheek (anime cheat) so the near eye keeps ≥60% width at 70°. | head/faceRig.js, head/faceAtlas.js, head/head.js |
| P0-9 | Face cam, default light 35°; any light or camera change | **Face shadow forms two islands** (temple, and a jaw wedge with lit cheek between). **The face light lags one frame:** `uHeadLight` is computed in `update()` from the previous frame's `uKeyDir`, so after a camera cut or light change the face is shaded on the opposite side to the body. | Repaint the threshold map so the 20°–50° band is a single connected shape from temple to jaw around the cheekbone (no lit gap at ear level). In `characterLight.onRender`, recompute `uHeadLight` right after `uKeyDir` (keep the head world quaternion from `update`), so both use the same frame's direction. | materials/faceShadow.js, materials/characterLight.js |
| P0-10 | High knee (front view); front kick (front view) | **Fur cuff faces the camera as a ring ("lifesaver")** with the knee poking through the hole. The spec calls this out by name. | Close the hole: add an inner shorts-coloured lining disc or cone inside the cuff (the shorts inner shell continued 0.03 into the ring). Flatten the fur toward the thigh axis (ring tube 0.022 → 0.016 radial, extend lobes axially). Drive the knee-angle pinch (spec 10% back squash) so that at >80° hip flex the far side tucks behind the thigh. | costume/accessories.js (+ costume/shorts.js lining) |
| P0-11 | Head turn ±70° (3/4, face cam) | **Neck–jaw shelf:** a hard shade step and visible tube where the neck loft enters the jaw underside. | Extend the neck loft blend into the jaw, with 2 rings weighted 50/50 neck/head under the jaw. Paint jaw-underside `shadeBias` as a soft gradient −0.3→0 over 0.02 instead of a step. Head: soften the jaw underside curvature so the neck enters a rounded surface. | body/body.js (neck), head/head.js (jaw underside) |
| P0-12 | Behind and Side game cams; preview back | **Rim light doesn't read**, so the silhouette doesn't separate from sea and sky. | Widen the rim to smoothstep(0.55, 0.63) and raise intensity to 0.65 on cloth and skin (keep 0.45 on hair). Bias lit-side gating so the rim shows on the camera-facing edge in the Behind cam. Verify a visible 2–3 px band on the shirt back edge against the sea. | materials/toon.js (dims.SHADING.rim via WP0) |

### P1: required for an AAA feel / H–I items

| # | View / pose | What's wrong | Concrete fix | Owner |
|---|---|---|---|---|
| P1-1 | Side game cam, side preview, punch side | Face reads **blank in profile**: both eye decals are edge-on and disappear; no nose ridge visible. | Combined with P0-8: wrap the eye patch round the cheek and add the 0.007 triangular nose ridge from spec 2.3 so the profile has a readable nose point. Consider an eye "billboard bias" (rotate the eye UV frame up to 25° toward the camera). | head/head.js, head/faceRig.js |
| P1-2 | 3/4, profile | **No outline on the face silhouette** (face-front `outlineWidth` 0), so forehead and cheek edges look unfinished against the sky. | In the outline vertex shader, scale face-front width by `smoothstep(0.35, 0.15, abs(dot(N_view, V)))` so it's 0 head-on and 0.7 at silhouette. | materials/outline.js (+ head/ attribute flag) |
| P1-3 | Front arms-down, close-up | Dark deep-tone **blob at the shorts crotch**. | Halve the crotch `shadeBias` radius and cap it at −0.22 so it gives a crease line, not a stain. | costume/shorts.js |
| P1-4 | Front, close-up | **Rolled cuff band doesn't read** above the fur. | Make the roll 0.010 proud (from 0.008) with a painted fold line in shade colour and a 1-px highlight on the top edge. | costume/shorts.js |
| P1-5 | Punch L/R | **Guard hand stays open** although the preset requests `fist:'both'`. | Check `applyPose` → `hero.setHandPose('fist','both')` routing. Drive the guard hand to the half-fist morph. | render+main+preview (posePresets.js) / body/ (setHandPose) |
| P1-6 | Perf HUD after WP5 | `update()` rose to 0.2–0.55 ms avg (1.55 spike) once dynamics landed (budget 0.4; WP5 own target 0.25). | Profile the verlet/ribbon rebuild: reuse buffers, update only positions/normals, cap substeps. | dynamics/ |
| P1-7 | High knee, front kick, squat, side kick, star jump | Sash tails pass through thigh and calf. | WP5 acceptance: thigh and shin capsules (spec 2.12) active, checked at 0.25×. | dynamics/ |
| P1-8 | Game 1920×1080 | Framing at 1920×1080 not verified in this round. | WP6 to attach a 1920×1080 screenshot with `measureFraming` output for round 2. | render+main+preview |

### P2: polish

| # | View | What's wrong | Fix | Owner |
|---|---|---|---|---|
| P2-1 | Face cam | Outline about 1.8 px at 900p (close-up target 2.5–3.5). | Apply a close-up floor: when the head fills >25% of the viewport height, raise the width to 2.6 px. | materials/outline.js |
| P2-2 | Face cam, neutral | `neutral` mouth reads as a soft smile, not the spec's near-flat line (corners +0.002). | Redraw the neutral cell: 0.20 W, almost straight. | head/faceAtlas.js |
| P2-3 | Wrist twist close-up | Open-hand fingers are parallel straight tubes; no knuckle breaks visible. | Add a 4°–8° splay and a slight knuckle bulge ring per segment. | body/hands.js |
| P2-4 | Spec/contract | Checklist A1 says `main.js` unchanged, but WP6 owns and edits it. | Amend the spec A1 wording to "game integration via WP6 only; retarget/tests/actions unchanged". | docs (art direction) |
| P2-5 | IP | Likeness to the reference is very close (outfit + hair + face). Within the guardrail, but risky for a publisher. | Before external showing, add one original signature element (e.g. a distinctive sash pattern or a hair accessory that is not a hat) after a legal read. | art direction |

---

## 4. Evidence and measurements (for round 2 re-test)

- Rig: `checkRig()` → ok, max error 2.2e-16, no non-identity rest rotations.
- Mesh triangle counts: body 17,888 · head 7,168 · hair 10,704 (in flight; 6,760 at review start) · costume 41,527 · sashTails 1,248 · face layers 1,664 · **total 80,199**. Draws 13 (outlines 5) · shadow draws 5.
- Build time: `createCharacter()` 522 ms, synchronous. Dispose: geometries and textures return to baseline.
- update(): 0.059 ms avg / 0.30 ms max over 600 synthetic frames (static pose); live HUD 0.2–0.55 ms with dynamics.
- Rest measurements (m): skull 0.255 × 0.222 × 0.216; jaw at y 1.51 0.092 wide; chest y 1.27 0.292×0.181; waist 0.236×0.160; pelvis skin 0.279×0.186; shorts pelvis 0.404×0.240; shorts hem y 0.550; fur y 0.516–0.592; sash tail tip y 0.467; buttons y 1.015–1.293 on −X (wearer's right).
- Arms-down (skinned): shirt shoulders 0.522; skin at shoulder band 0.474; fingertips y 0.674; hair top 1.814; hair width 0.323.
- Palette: rendered skin base #F7D2B2 and shade #E39C7F (exact). Renderer: NeutralToneMapping, sRGB output, character `toneMapped:false`.
- Light sweep (synchronous renders, cheek samples at ±0.06/±0.03): symmetric. Shade starts at about 45°, nose-line split at ±90°, never inside an eye. The asymmetry seen in presented frames is the one-frame `uHeadLight` lag (P0-9).
- Game: Front cam hero about 61% of height at 1440×900, clear of HUD. The Free Move, Reaction Test and Pose Match modes run with the synthetic player at 120 render fps.
