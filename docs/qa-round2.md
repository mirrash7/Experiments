# Hero v2: QA Round 2

Reviewer: Character Art Direction / QA (author of `docs/character-art-spec.md` and `docs/qa-round1.md`)
Build: live Vite build at review time. It hot-reloaded about 10 times during the review because the sash-knot dynamics follow-up was landing. For roughly 5 minutes `verlet.js` threw `ReferenceError: tw is not defined` in `VerletChain.step`, which crashed every frame; it was fixed upstream before any of the evidence below was captured.
Method: `character-preview.html` at 1440×900. Full-resolution 2880×1800 canvas crops were saved to contact sheets. I checked every pose preset front, side and 3/4, ran a light sweep, a decal yaw sweep (45/55/70/80/90°) for all 8 expressions, and the head turn 70 and tilt 30 presets. Measurements come from skinned vertex positions, scripted dynamics probes (head shake, side step, tracking noise, dt hitch) and frame-diff tests for the light lag. Then I ran the game (`/`) with the Synthetic demo player: the Front, Behind and Side cameras, the Free Move, Reaction Test and Pose Match modes, and `measureFraming()` at both 1440×900 and 1920×1080.

---

## Verdict

**Overall 7.5/10 (v1 3, r1 6). Verdict: not yet. The remaining P0s are confined to the hair package. With those closed, this is ship-with-P1s.**

The fix pass is real and broad. Every round-1 P0 outside the hair passes on re-measure:
- The build is inside budget on triangles, shadow draws, update time and load time.
- The shirt "Rorschach" shading islands are gone.
- The head is on spec, with h/w 1.29.
- Decals stay inside the face silhouette to 90°.
- The face shadow is one coherent shape and no longer lags a frame.
- The fur cuff donut is fixed.
- Garment widths are in tolerance.
- The rim light reads.

What still blocks the ship bar: the redesigned hair fails D1 (silhouette width and tip count) and D3 (the highlight reads as scattered per-clump dashes, not a band). Both are contained `head/hair.js` and `materials/hair.js` work. The P1 list is mostly profile-view appeal: exposed occiput and a "column" neck, no nose point, a blotchy cheek shadow, and a stiff sash tail.

---

## 1. Scored rubric (v1 → r1 → r2)

| Area | v1 | r1 | r2 | What changed / what still holds it back |
|---|---|---|---|---|
| Silhouette / readability | 4 | 6 | 7 | Shoulders and pelvis are in tolerance, the head has narrowed, and the pose set reads at game cam. Held back by a busy, hedgehog-edged hair outline (≈15 small tips instead of 7–9 bold ones) and by the 70–90° profile, where bare skin behind the ear plus the neck reads as one thick column. |
| Proportions vs reference | 4 | 6 | 8 | All measured values are on spec: skull 0.255 × 0.198 (h/w 1.29); visual head 0.308; skin shoulders 0.429; shirt shoulders 0.465; shorts pelvis 0.338. Visual head sits at the top of its ±0.01 tolerance. |
| Face appeal | 5 | 7 | 8 | Front and 3/4 are genuinely appealing: big eyes, crisp catch-lights, all 8 expressions distinct, and the neutral mouth is now near-flat. In profile there is no nose point, the face front is a flat plane, the cheek shadow breaks into 3 zones, and the chin and lower face project forward ("muzzle") at 70–90°. |
| Hair | 3 | 4 (prov.) | 6 | The mass, volume, back sweep, nape flicks and fringe gaps are right. It fails on silhouette width (1.58× temples vs 1.30), tip count, scattered dash highlights in place of a ring band, 57 clumps (spec 26) and 9.2k tris (sub-budget 8k). Nape lowest y is 1.511 (spec 1.48). |
| Costume fidelity | 4 | 7 | 8 | Shorts pelvis fixed, crotch blob gone, rolled cuff reads, fur fills the opening, shirt shoulder fixed, fists on punches. The knot is small compared with the reference's bow, and the dynamic tail reads as a flat, stiff plank. |
| Shading / lighting | 3 | 6 | 8 | No shirt islands at ±35° key, front or back, including arms overhead and squat. The face shadow is one connected shape across the 0/±30/±60/±90 sweep with a clean nose-line split at 90°. The face-light lag is gone (0 px diff with dt = 0 after a 60° root snap). The rim is visible. The profile cheek still blotches at 80–90° yaw. |
| Outlines | 5 | 7 | 8 | The face silhouette line now exists: measured 5 device px (≈2.5 CSS px) on the profile cheek. The close-up floor is active and lines are tinted per material. |
| Deformation in motion | 2 | 7 | 8 | Fur ring fixed in high knee and front kick. No jaw shelf step on the 70° turn. Fists on punches and kicks. All 12 presets hold front, side and 3/4. |
| Secondary motion | 4 | n/s | 7 | Sash swing 18.5° on a 0.5 s side step, settling 0.7 s after the stop with 1 overshoot. Hem trails 18° and cuffs 15°. The dt hitch is stable. But the tail is a stiff board and flares horizontally for 3–6 frames on fast pose changes, and the hair springs don't move at all on a normal-speed head shake. |
| Overall shippability | 3 | 6 | 7.5 | Vertical-slice-plus. Close the hair P0s; the P1s are polish a publisher will flag in profile shots. |

---

## 2. Section 4 checklist: pass / fail

Legend: **PASS**, **FAIL**, **N/V** (not verifiable here), **N/A**.

### A. Contract and technical
| Item | Result | Note |
|---|---|---|
| A1 contract files, game runs, Pose Match parity | PASS (partial) | Free Move, Reaction Test and Pose Match all run with the synthetic player and the ghost overlay. No VCS, so nothing can be diffed. The spec wording on `main.js` is still outstanding (P2-9). |
| A2 19 bones + 5 markers, identity rest, feet y=0, headTop 1.75 | PASS | `checkRig()`: 24 entries, max error 2.2e-16, no non-identity rest rotations. |
| A3 draws ≤14 (+≤4 shadow), tris ≤60k, update ≤0.4 ms, load ≤400 ms | PASS | Draws 13 (5 outline); **shadow 4/4**; **tris 59,825/60k** (175 tris of headroom: P1-5); update 0.22 ms avg / 0.50 max. Async build is 279–358 ms total over 10 runs, with the longest block 133–172 ms (budget 250). The body builder is now the long pole. A synchronous `createCharacter` takes 213 ms. |
| A4 60 fps with webcam for 2 min | N/V | The camera is blocked in this browser. The synthetic player renders at 120 fps. |
| A5 no warnings; dispose frees all | PASS | Console is clean apart from my own tooling. A second hero takes geometries 10→15→10 and textures 10→15→10. |

### B. Proportions and silhouette
| Item | Result | Note |
|---|---|---|
| B1 visual head 0.30±0.01; skull h/w ≥1.2 | PASS | Skull 0.255 tall × 0.198 max wide (0.196 at temples): h/w 1.29. Chin 1.490 to hair top 1.798 gives **0.308** (at the tolerance edge). |
| B2 shoulders 0.42 skin / 0.45 shirt ±0.02; chest:waist 1.2±0.05 | PASS | Skin 0.429, shirt 0.465. Chest:waist 0.292/0.245 = 1.19. |
| B3 fingertips mid-thigh; hand 0.175 | PASS | Visually at mid-thigh. The joint moved 0.01 medially; not re-measured. |
| B4 bell sleeves; lean teen | PASS | |
| B5 side-by-side same family; no forbidden IP | PASS (provisional) | No scar, hat, name or logo. The IP-likeness note from r1 stands (P2-8). See section 5. |

### C. Face
| Item | Result | Note |
|---|---|---|
| C1 eye layout, iris, catch-lights | PASS | |
| C2 brows over bangs in all expressions | PASS | All 8 expressions checked at full resolution. The brows draw over the fringe (the view-ray pull works), including the raised brows in `surprised`. |
| C3 no nose ball; wedge flips with light | PASS (partial) | Painted wedge. There is no profile nose point (P1-2). |
| C4 8 mouths / 7 eye states, blink, no gaps | PASS | Expression changes cross-dissolve for 3–5 frames with a visible double mouth and eyes (P2-1). |
| C5 light sweep: one clean shape, never crosses an eye | PASS | 35° temple wedge; 60° one connected temple-to-cheek shape; 90° nose-line split; −30° minimal. The one-frame lag is fixed. Profile-yaw blotching is tracked as P1-3; it isn't part of the front sweep. |
| C6 3/4 decals ≤10% stretch, on curvature; ears visible | PASS | The mouth stays inside the cheek and jaw silhouette at 45/55/70/80/90° for happy, shout, laugh, wince and determined. The near eye keeps more than 60% width at 70° thanks to the cheat. Ears visible. A faint white teeth ghost shows at the mouth corner at 70° (P2-2). |
| C7 game cam face ≥80 px @1080p, readable <1 s | PASS | The visual head is about 110 px at 1080p. Grin, determined and surprised are distinct. |

### D. Hair
| Item | Result | Note |
|---|---|---|
| D1 7–9 tips, width 1.30±0.05 skull, aspect ≤2 | **FAIL** | Width 0.294 m = **1.58× temple width** (1.50× the max skull width). The front silhouette shows about 15 small jagged tips, not 7–9 bold ones. The cause is 57 clumps against the spec's 26. |
| D2 fringe 5 points, 2 gaps, side locks top third of ear, nape flicks | PASS (partial) | Fringe of about 6 points ending at the brows, with 2 forehead gaps. Ears are clear below the side hair. Nape flicks are visible from the back, but the lowest nape tip is y 1.511 against spec 1.48. That exposes the occiput in profile (P1-1). |
| D3 one-mass shading, angel ring broken band, no backfaces | **FAIL** | It does read as one mass, and there are no backface artifacts. But the "broken dash" highlight is scattered over the whole mop at 3+ heights and reads as per-clump scratches. It is not a ring band at crown height. |
| D4 head shake ±30°: bangs lag ≤4°, never reveals forehead | PASS | 3 Hz shake: bangs 4.0° (at the clamp), sides 6°, back 4.9°. The forehead is never revealed. Note that a 1.5 Hz ±30° shake produces **0°**: the dead-zone eats normal head motion (P2-3). |

### E. Costume
| Item | Result | Note |
|---|---|---|
| E1 shirt V, collar, placket, buttons, hem tuck/flare | PASS | Hem flare at the sides measures 0.39 W at y 0.86, as intended. |
| E2 sleeve length, bell cuff, 6 scallops, inner band | PASS | |
| E3 every cloth edge thick + outlined | PASS | The ribbon tails have their own outline hull. |
| E4 sash band, knot ~50° left, tails 0.49/0.24 | PASS | Long tail tip y 0.46. The knot is very small next to the reference bow (P1-4). |
| E5 shorts baggy, hem, rolled cuff, pockets/fly | PASS | Shorts pelvis **0.338** (matId 7 band). The rolled cuff band reads above the fur. No crotch blob in the front close-up. |
| E6 fur cloud lobes, cool shade, thin outline | PASS | |
| E7 sandals | PASS | |

### F. Shading, outlines, colour
| Item | Result | Note |
|---|---|---|
| F1 swatch ΔE<3 | PASS (carried) | Pipeline unchanged since r1's pixel-exact sample; not re-sampled. |
| F2 two tones + crease; no blotches (back view) | PASS | Back view at ±35° key, arms overhead (back) and squat (back) each show one smooth terminator shape per panel. The round-1 islands are fixed. |
| F3 rim on lit silhouette Front/Behind/Side, not face front | PASS | Visible on the shoulder, arm and hair edges against the sea in the Behind cam. Thin, at about 1–2 px (P2-5). |
| F4 outline width, tint, taper, no splits | PASS | Profile cheek silhouette line measured at 5 device px. |
| F5 no inner-line shimmer | PASS | |

### G. Deformation pose set (front + side + 3/4 each)
| Pose | Result | Note |
|---|---|---|
| T-pose | PASS | |
| Arms overhead | PASS | Sleeves clear the head and hair. Back shading is clean. |
| Hands on head | PASS | The hands rest on the hair with no visible sinking. |
| Punch L/R | PASS | **Both hands are now fists** (r1 P1-5 fixed). The cuff reads as a bell. |
| Goal post | PASS | |
| Deep squat | PASS | No gap and smooth crotch. The tail hangs outboard of the thigh without penetrating. |
| High knee | PASS | **The fur cuff is filled**: no lifesaver hole. The tail hangs clear. |
| Front kick | PASS | Seat smooth. The tail sits behind the leg. |
| Side kick / star jump | PASS | The tails swing clear. |
| Twist + lean | PASS | |
| Wrist twist ±90 | PASS | |
| Head turn ±70 / tilt ±30 | PASS | No shade step or shelf at the jaw–neck junction, and the collar is clear. The thick-neck read in profile comes from hair coverage, not deformation (P1-1). |

### H. Secondary motion
| Item | Result | Note |
|---|---|---|
| H1 sash ≥10° swing on a 0.5 s step, settles ≤1.2 s, ≤2 osc; no leg penetration | PASS (partial) | 18.5° swing, settles 0.7 s after the stop, 1 zero crossing. No penetration in the settled pose set. The 0.25× slow-motion kick check was not run. |
| H2 hem/cuffs trail on punches and turns; no idle jitter | PASS | Side step: hem 18°, cuff 15°. Punch alternation: cuff 15°, hem 7°. Synthetic 30 Hz tracking noise (±0.6° rot, ±3 mm) gives bangs ≤1.2°, hem ≤0.66° and cuff ≤2.9°, which is visually still. |
| H3 stable under dt spikes | PASS | 100 ms + 250 ms hitches: all positions finite, settles within 1 s. |

Pending in-flight knot follow-up: I saw no detachment between the tails and the sliding knot in the settled high knee, squat and front kick poses, or in the knot close-ups. On instant pose snaps (preset changes), the tail flares out horizontally for 3–6 frames and its root is hidden by the thigh or hand, so attachment there couldn't be confirmed. Re-check after the follow-up lands (P1-4).

### I. Presentation (game)
| Item | Result | Note |
|---|---|---|
| I1 front 58–65%, centred, clear of HUD at 1440×900 and 1920×1080 | PASS | 1440×900: 61.4–64.1% standing. 1920×1080: 59–61% standing (52.5% mid-squat). `overlaps: []` at both sizes. |
| I2 Behind/Side: camera-locked key, rim separates | PASS | Behind 62.7%, Side 64.9%. The rim is visible. The profile face is readable in Side (eye and mouth present). |
| I3 contact blob, feet planted | PASS (carried) | Blob present. Plant not re-measured. |
| I4 post-fx | N/A | No post chain. |

**Tally (A–G): 2 FAIL (D1, D3). H: 3/3 PASS. I: 3/3 applicable PASS.** By the ship bar (every A–G item passes), the build is not shippable until D1 and D3 close.

---

## 3. Fixed vs regressed since round 1

**Fixed (verified):**
- r1 P0-1: triangles (80.2k → 59.8k).
- r1 P0-2: async build with longest block ≤172 ms.
- r1 P0-3: shadow draws now 4.
- r1 P0-4: shirt shade islands.
- r1 P0-5: skull width.
- r1 P0-6: shoulders.
- r1 P0-7: shorts pelvis.
- r1 P0-8: decals inside the silhouette, near eye ≥60% at 70°.
- r1 P0-9: face shadow is one shape, light lag removed.
- r1 P0-10: fur donut.
- r1 P0-11: neck–jaw shelf.
- r1 P0-12: rim.
- r1 P1-2: face silhouette outline.
- r1 P1-3: crotch blob.
- r1 P1-4: rolled cuff.
- r1 P1-5: guard fist.
- r1 P1-6: update 0.22 ms avg.
- r1 P1-7: tail–leg collision in the settled pose set.
- r1 P1-8: 1080p framing.
- r1 P2-1: close-up outline floor.
- r1 P2-2: neutral mouth.
- r1 C2: brows over bangs, now without backing patches.

**Not fixed / partial:**
- r1 P1-1: there is a profile eye now, but still no nose point (P1-2 below).
- r1 P2-3: finger splay not re-checked.
- r1 P2-4: spec A1 wording.
- r1 P2-5: IP read.

**New or regressed:**
- Hair redesign: silhouette width and tip count (D1), scattered highlights (D3), 9.2k tris over its 8k sub-budget, and the nape sits too high, exposing the occiput in profile.
- The sash tail no longer casts a ground shadow (`castShadow=false`, the trade-off for P0-3).
- The tail reads as a stiff flat plank and flares horizontally on fast pose changes.
- Expression changes cross-dissolve with a visible double image.
- The hair spring dead-zone suppresses normal head motion.
- Triangle headroom is down to 175.

---

## 4. Prioritised remaining defects

### P0: blocks ship (fails an A–G item)

| # | View / pose | What's wrong | Concrete fix | Owner |
|---|---|---|---|---|
| P0-1 | Front, 3/4, face cam; any pose | **Hair silhouette out of spec (D1).** Width 0.294 (1.58× temples, target 1.30 → about 0.24–0.25). About 15 small jagged tips rather than 7–9 bold spikes. 57 clumps against spec 26 makes the outline busy and hedgehog-like, unlike the reference's few large locks. | Consolidate to the spec layout (`dims.HAIR.clumps`: 7 bangs, 3 per side, 7 crown, 6 back = 26). Raise per-clump width so each tip is a bold wedge (aspect 1.2–1.8). Pull the side-clump roots in so the max width is 1.30 × 0.196 ≈ 0.255 at the temple band (y 1.62–1.68). Keep 7–9 tips breaking the front silhouette. This also recovers about 2k tris (P1-5). Verify with a front silhouette tip count and the `band(hair, 1.62, 1.68)` width. | head/hair.js |
| P0-2 | Front, side, game cams | **Angel ring reads as scattered per-clump dashes (D3)**, at 3+ heights over the whole mop, with no band. | Drive the highlight from a single head-space band: a crown-height elevation window of about 55–65° from the head pivot, a projected V coordinate in `hairUV`, not per-clump UV. Break it into 5–7 dashes by clump ID only *within* that band. Kill the highlight outside the band. Check front and side at key ±35°. | materials/hair.js (+ `hairUV` generation in head/hair.js) |

### P1: a publisher reviewer will flag these

| # | View / pose | What's wrong | Concrete fix | Owner |
|---|---|---|---|---|
| P1-1 | Profile and 70–90° yaw, head turn 70, Side game cam | **Bare occiput behind the ear plus the neck reads as one thick "column" neck.** The hair stops at y ≈ 1.51–1.60 behind the ear (spec nape 1.48), so the skull base looks like neck. Neck geometry itself is near spec (0.08 × 0.072 at y 1.50). | Extend the back and side-back clumps down to nape y 1.48, covering behind the ear down to h 0.28. Add 2 nape flicks that overlap the neck top. Re-check the profile at 90° and the Side cam. Do this together with P0-1. | head/hair.js |
| P1-2 | Profile (90°), Side cam, punch side | **No nose point**: the face front is a flat vertical plane from brow to mouth, so the profile reads as a board. | Add the spec 2.3 nose ridge (0.007 triangular, on the head displacement). Or, if geometry is undesirable, add a profile nose-tip cheat in the features layer that fades in past 60° yaw. | head/head.js, head/faceRig.js |
| P1-3 | 80–90° yaw with the default camera-locked key | **The cheek shadow splits into 3 zones** (cheek block, lit strip, jaw shade) with a stepped edge near the mouth. | In the face-shadow lookup, clamp to a single region once \|view yaw\| > 60°: lerp the threshold toward the plain N·L terminator, and smooth the threshold texture's edge band (1-texel blur in the 0.4–0.6 range). | materials/faceShadow.js |
| P1-4 | Armsdown front (knot); any fast movement | **Knot is tiny next to the reference bow; the tail is a flat, stiff plank** that flares horizontally for 3–6 frames on fast pose changes. Detachment on fast transitions is unverified (the follow-up is in flight). | Knot: add 2 loop lobes (about 0.05 each) and a wrap fold. Tail: add a 15–25° twist along its length, a 20% taper and lower bending stiffness. Raise tip mass / air drag so it whips rather than flags. Cap knot-delta velocity transfer. After the knot-follow fix lands, run the 0.25× slow-motion kick check and the snap-transition knot check from section 2 H. | costume/accessories.js (knot); dynamics/sashRibbon.js, dynamics/verlet.js |
| P1-5 | Perf HUD | **Tri headroom is 175 (59,825 / 60k).** Hair is 9,220 (sub-budget 8k) and body+cloth is 42.1k (sub-budget 30k). Any addition, such as the P1-2 nose or the P1-4 knot, breaks A3. | P0-1 recovers about 2k from hair. Decimate the inner thickness shell of the shirt and shorts by a further 20%. Formally rebalance the `BUDGET.tris_by` sub-budgets in the spec. | head/hair.js, costume/ (sdf.js), art direction (dims.BUDGET) |
| P1-6 | 70–90° yaw, 3/4 | **Lower face projects forward ("muzzle") and the chin is long and pointed.** This moves away from the reference's rounder, younger face. | Pull the chin and mouth region back by about 4–5 mm in z below the eye line. Round the chin, wider at chin+0.012 (0.05 → 0.06). Keep h/w ≥ 1.2. | head/head.js |

### P2: polish

| # | View | What's wrong | Fix | Owner |
|---|---|---|---|---|
| P2-1 | Face cam, expression change | 3–5 frame cross-dissolve shows a double mouth and eyes. | Hard-swap the atlas cell at the midpoint, masked by a 2-frame squash or blink. Or dissolve only the eyes during a blink. | head/faceRig.js |
| P2-2 | 70° yaw, open mouths | Faint white teeth smear at the mouth corner from the grazing fade. | Fade the teeth layer earlier (start 55°), or clip the mouth interior by N·V before the lips. | head/head.js |
| P2-3 | Head shake 1.5 Hz ±30° | Hair springs don't move at all (dead-zone too high), yet tracking noise excites them. | Lower hair `deadAlpha` 25 → about 10. Lengthen the input EMA for hair only (60 → 90 ms) so noise is filtered by smoothing rather than by the dead-zone. | dynamics/index.js (GAINS) |
| P2-4 | All cams | The sash tail casts no ground shadow. | Include the tails in the costume shadow-only draw (merge) so shadow draws stay at 4. | dynamics/sashRibbon.js, costume/index.js |
| P2-5 | Behind cam | Rim is thin (≈1–2 px) on the shirt back against the sea. | Widen `rim.backEdge` 0.6 → 0.55, or raise `backStrength` slightly. Target 2–3 px. | materials/toon.js (dims.SHADING.rim) |
| P2-6 | Load | Longest async block is now the body builder (133–172 ms; one run 172). | Yield inside body loft generation (per limb). | body/body.js + hero/index.js |
| P2-7 | Wrist twist close-up | Finger splay and knuckle breaks not re-checked (r1 P2-3). | Verify or implement. | body/hands.js |
| P2-8 | IP | Likeness to the reference remains very close (outfit + hair + face). Within the guardrail, but a publisher risk. | Legal read before external showing. Add one original signature element (sash pattern or a non-hat accessory). | art direction |
| P2-9 | Spec | Checklist A1 still says `main.js` is unchanged. | Amend the wording (r1 P2-4). | docs (art direction) |

---

## 5. Side-by-side with reference

At the same framing, the read is unmistakably "the same style family": red open shirt with bell sleeves, a yellow sash knotted on the left with a long tail, blue rolled shorts with white fur cuffs, sandals, a lean teen with visible abs, and a black mop with big round dark eyes and a wide grin. The palette and gesture land, and front and 3/4 appeal is now high.

Where it diverges:
- **Face:** the reference has a rounder, broader-cheeked, younger face. Ours has a longer, pointed chin that projects in profile (P1-6).
- **Hair:** the reference's hair is a few large, chunky spiky locks with a shaggy but bold outline. Ours is a dense mass of many thin clumps with a noisy edge and scattered highlights (P0-1, P0-2).
- **Sash:** the reference sash has a big floppy knot and a soft, twisting tail. Ours has a small knot and a flat, rigid tail (P1-4).

Fixing those three moves likeness and appeal up while staying original. The no-scar, no-hat, no-name guardrail holds. The very close overall likeness still warrants the legal read in P2-8.

---

## 6. Evidence and measurements

- Rig: `checkRig()` → ok, max error 2.2e-16, 24 entries.
- Triangles: body 17,696 · costume 24,405 · hair 9,220 · head 5,712 · sashTails 1,248 · face layers 1,544 · **total 59,825**. Draws 13 (5 outline); shadow 4.
- Build: async total 279–358 ms; longest block 133–172 ms (body); shell 1–10 ms; sync `createCharacter` 213 ms. Dispose returns to baseline.
- `update()`: 0.218–0.238 ms avg, 0.50 ms max (live HUD).
- Rest / arms-down (m): skull band y 1.60 0.196 W × 0.214 D; head extent x ±0.099, y 1.490–1.745; hair x ±0.147 (0.294), y 1.511–1.798, back z −0.173; neck y 1.50 0.080 × 0.072; skin shoulders 0.429; shirt shoulders 0.465; shorts (matId 7) 0.338 at y 0.82–0.92; shirt hem flare 0.39 at y 0.86; sash tail tip y 0.46.
- Light lag: after a 60° root snap with dt = 0, the frame-1 vs frame-2 diff is 0 px. With dt > 0 the residual diff is hair-spring motion only.
- Dynamics probes:
  - Side step 0.3 m / 0.5 s: tail offset 0.151 m (18.5°), settles 0.7 s, 1 zero crossing.
  - Hem 18°, cuff 15°.
  - Head shake 3 Hz: bangs 4.0°; at 1.5 Hz: 0°.
  - Noise: bangs 1.2°, cuff 2.9°.
  - Hitch 100 + 250 ms: stable.
- Profile outline: 5 device px brown (#6B3428) band on the cheek silhouette at 2880×1800.
- Game: `measureFraming()` Front 61.4–64.1% (1440×900) and 59–61% (1920×1080), Behind 62.7%, Side 64.9%, no HUD overlaps. All three modes run, with no console errors.
