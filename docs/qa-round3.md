# Hero v2: QA Round 3

Reviewer: Character Art Direction / QA (author of `docs/character-art-spec.md`, `docs/qa-round1.md` and `docs/qa-round2.md`)
Build: live Vite build at review time. The build was stable for the whole session, with no hot reloads and no runtime errors.
Method:
- **Tooling.** A headless Chrome (CDP) against the running Vite, at 1440×900 and 1920×1080. Close-ups were captured at 1.4–3× clip scale.
- **Preview** (`character-preview.html`):
  - Every pose preset at 3/4, plus front, side and back turnarounds.
  - A face-cam yaw sweep (0/45/70/80/90°, both directions) for all 8 expressions.
  - A key-light sweep (0, ±30, ±60, ±90°).
  - Knot close-ups at 0/−60/−120° yaw.
- **Measurements** come from skinned vertex positions (`SkinnedMesh.getVertexPosition`), plus scripted dynamics probes:
  - pose-snap flare (5 transitions),
  - a 0.3 m / 0.5 s side step,
  - a ±30° head shake at 1.5 and 3 Hz,
  - a tail-versus-floor check in every preset.
- **Game** (`/`): Synthetic demo player in Front, Behind and Side, with `measureFraming()` at both sizes. All three modes run.

---

## Verdict

**Overall 8.0/10 (v1 3 → r1 6 → r2 7.5 → r3 8.0). Verdict: NOT YET. One contained P0 remains, a sash-tail floor collision fix of under a day. Once it is closed and re-verified, the build is SHIP WITH P1s at about 8.5.**

Round 2's whole hair package is closed, and so is almost every round-2 P1:
- **D1** passes. The width is 1.34× max skull (1.42× temple band), and the lead's volume compromise is accepted.
- **D3** passes. The angel ring reads as one broken band.
- The nape reaches y 1.480, so the occiput and "column neck" problem is gone.
- There is a nose point in profile.
- The cheek shadow is now one region.
- The chin is rounder and no longer has a muzzle.
- Expression swaps are clean.
- The knot is chunky.
- The tails cast a ground shadow again.
- Triangle headroom went from 175 to 5.8k.

The one blocker is a new finding, not a regression from a fix. In the **Deep squat** preset the dynamic sash tail drives **12 cm through the floor**: 160 of 872 tail vertices sit below y = 0, while the feet are at +0.016. On screen it reads as a yellow stake planted in the ground beside the heel (side and 3/4). G-squat requires "sash tail rests on the thigh without penetrating", so this fails an A–G item, and the ship bar is every A–G item passing.

The tail geometry is within 2.5 cm of round 2's, so this was very likely already present in round 2. I passed that pose on leg penetration only and missed the floor, so the miss is mine. The synthetic player's shallow squat (world height ≥1.45) never triggers it. A real player's deep squat in Pose Match will.

A publisher board will accept "ship with P1s" once the floor constraint lands. It will not accept cloth through the floor in a named QA pose.

---

## 1. Scored rubric (v1 → r1 → r2 → r3)

| Area | v1 | r1 | r2 | r3 | What changed / what still holds it back |
|---|---|---|---|---|---|
| Silhouette / readability | 4 | 6 | 7 | **8.5** | The hair outline is now a few big, bold locks instead of a hedgehog edge. The profile no longer reads as a column neck because the nape covers the skull base. Two crown "horn" clumps read long and thin from the front (P2-2). |
| Proportions vs reference | 4 | 6 | 8 | **8.5** | The visual head is 0.303, centred in its ±0.01 tolerance (r2 was 0.308, at the edge). Skull 0.255 × 0.198, h/w 1.29. Shoulders and pelvis unchanged and on spec. |
| Face appeal | 5 | 7 | 8 | **8.5** | A small nose point reads at 80–90°. The chin is rounder and shorter, with no forward muzzle at 70–90°. All 8 expressions are distinct front and at 70°. Swaps are hard, with no double image. There is no teeth ghost at 70°. Residual: a pale halo rings the brow when it is in shadow (P2-3), and the far brow floats just outside the cheek line at 70° (P2-4). |
| Hair | 3 | 4 (prov.) | 6 | **8** | 32 bold clumps, 5,960 tris. Width 0.265 m. A single broken ring band sits at bang/crown height. Nape y 1.480. Springs now respond to normal head motion. The tip count is about 10–12 against spec 7–9, which I accept against the reference (spec amendment P2-1). |
| Costume fidelity | 4 | 7 | 8 | **8** | The knot is now a chunky wrapped knot with a loop, in the right family as the reference bow. From the front the tail has a nice twist, curl and slanted cut. From 3/4 and side it still reads as a flat, constant-width board (P1-1). It impales the floor in deep squat (P0-1). Sandal strap paint reads as brown smudges in close-up (P2-6). |
| Shading / lighting | 3 | 6 | 8 | **8.5** | The face light sweep gives one clean shape at every angle, with the nose notch at ±60° and the nose-line split at ±90°. The profile cheek is one region at 80–90°: face-front shade plus the jaw underside, with no lit strip between them. The back shirt is clean. Residual: a small stepped notch where the jaw-underside shade meets the neck at 80° (P2-5). |
| Outlines | 5 | 7 | 8 | **8** | Unchanged and good. The hair outline is thinner on the bold clumps and still tapers. Not re-measured in px. |
| Deformation in motion | 2 | 7 | 8 | **8.5** | All presets hold at 3/4. The knot stays attached in high knee and kicks. No shelf at the jaw–neck junction in head turn. |
| Secondary motion | 4 | n/s | 7 | **7.5** | Fixed: there is no horizontal flare on snaps, the hair springs move at 1.5 Hz, and the side-step swing is about 16°, settling in about 0.7 s. Held back by the floor penetration in squat (P0-1) and the board-like tail (P1-1). |
| Overall shippability | 3 | 6 | 7.5 | **8.0** | Closing P0-1 makes it 8.5 and ship-with-P1s. |

---

## 2. Section 4 checklist: pass / fail

Legend: **PASS**, **FAIL**, **N/V** (not verifiable here), **N/A**.

### A. Contract and technical
| Item | Result | Note |
|---|---|---|
| A1 contract files, game runs, Pose Match parity | PASS (partial) | All three modes run with the synthetic player. There is no VCS, so I could not diff. The spec wording on `main.js` is still outstanding (P2-9). |
| A2 19 bones + 5 markers, identity rest, feet y=0, headTop 1.75 | PASS | `checkRig()`: 24 entries, max error 2.2e-16, no non-identity rest rotations. |
| A3 draws ≤14 (+≤4 shadow), tris ≤60k, update ≤0.4 ms, load ≤400 ms | PASS | Draws **11** (4 outline; was 13). Shadow **4/4**, and that now includes the tails. Tris **54,207** (5.8k headroom). `update()` HUD average 0.275–0.339 ms. Async build 259–344 ms total, longest block 132–149 ms (body). |
| A4 60 fps with webcam for 2 min | N/V | No camera in headless. The synthetic player renders at 60 fps (vsync-capped). |
| A5 no warnings; dispose frees all | PASS | The console is clean (only a favicon 404 from Vite). A second async build plus `dispose()` returns geometries and textures to 9/10. |

### B. Proportions and silhouette
| Item | Result | Note |
|---|---|---|
| B1 visual head 0.30±0.01; skull h/w ≥1.2 | PASS | Chin 1.490 to hair top 1.793 gives **0.303**. h/w 1.29. |
| B2 shoulders / chest:waist | PASS (carried) | Body and shirt are unchanged since r2. |
| B3 fingertips mid-thigh; hand 0.175 | PASS (carried) | |
| B4 bell sleeves; lean teen | PASS | |
| B5 same style family; no forbidden IP | PASS (provisional) | No scar, hat, name or logo. The likeness-risk note stands (P2-8). See section 5. |

### C. Face
| Item | Result | Note |
|---|---|---|
| C1 eye layout, iris, catch-lights | PASS | |
| C2 brows over bangs, all expressions | PASS | All 8 expressions checked front and at −70°. |
| C3 no nose ball; wedge flips with light | PASS | The wedge flips across the light sweep. **There is now a profile nose point** (r2 P1-2 closed). |
| C4 8 mouths / 7 eye states, blink, no gaps | PASS | `Swap` always shows one cell (mix 1). Eye-state changes go through a 0.03 s half-lid. No double image (r2 P2-1 closed). |
| C5 light sweep: one clean shape, never crosses an eye | PASS | 0/±30: minimal temple wedge. ±60: one shape with the nose notch, passing between the eyes. ±90: a clean nose-line split. Nothing crosses an eye and there is no forehead stripe. |
| C6 3/4 decals ≤10% stretch; ears visible | PASS | 45/70/80/90° in both directions for all 8 expressions: the mouth stays inside the cheek and jaw line. No white teeth ghost at 70° (r2 P2-2 closed). Ears visible. The far brow pokes past the cheek at 70° (P2-4). |
| C7 game cam face ≥80 px @1080p, readable <1 s | PASS (carried) | The head is about 115 px at 1080p. Expressions are distinct. |

### D. Hair
| Item | Result | Note |
|---|---|---|
| D1 7–9 tips, width 1.30±0.05 skull, aspect ≤2 | **PASS (waiver)** | Width **0.265 m**. That is 1.34× the max skull width (0.198), inside 1.30±0.05, and matches the spec's absolute 0.26. It is 1.42× the temple band (0.186). Judged against the reference, the extra volume helps appeal and the silhouette is bold and readable. **I accept the lead's compromise.** The tip count is about 10–12 bold tips. This is above 7–9 but in line with the reference's shaggy outline, so it is waived, and the spec is to be amended to 9–12 (P2-1). Two crown flick clumps read with about a 3:1 silhouette aspect from the front (P2-2). |
| D2 fringe 5 points, 2 gaps, side locks top third of ear, nape flicks | PASS | A fringe of about 5–6 points with 2 gaps. Nape y **1.480** (spec 1.48). Nape flicks are visible from the back. In profile the hair covers behind the ear down to the neck top (r2 P1-1 closed). |
| D3 one-mass shading, angel ring broken band, no backfaces | **PASS** | One band of broken dashes across the bangs and crown, read front, 3/4 and side, with nothing outside the band. Hair reads as two clean tones plus the band. No backface artifacts. The rim no longer lines the inner clumps. |
| D4 head shake ±30°: bangs lag ≤4°, never reveals forehead | PASS | 3 Hz: bangs 4.0°, sides 6.0°, back 4.9°. **1.5 Hz: bangs 3.7°, sides 2.9°, back 2.2°.** The dead-zone no longer eats normal motion (r2 P2-3 closed). The forehead is never revealed. |

### E. Costume
| Item | Result | Note |
|---|---|---|
| E1 shirt V, collar, placket, buttons, hem | PASS (carried) | |
| E2 sleeves, bell cuff, scallops, inner band | PASS | |
| E3 cloth edges thick + outlined | PASS | The tails now share the costume outline hull. |
| E4 sash band, knot ~50° left, tails 0.49/0.24 | PASS | Long tail tip y **0.436** at rest (spec about 0.49, within the drape tolerance I accepted in r2). The knot is chunky, with folds and a loop (r2 P1-4 knot half closed). The tail-as-plank read is P1-1. |
| E5 shorts | PASS (carried) | |
| E6 fur cuffs | PASS | |
| E7 sandals | PASS | Close-up paint smudge is P2-6. |

### F. Shading, outlines, colour
| Item | Result | Note |
|---|---|---|
| F1 swatch ΔE<3 | PASS (carried) | The pipeline is unchanged. |
| F2 two tones + crease; no blotches | PASS | Back view: one clean terminator per panel. The face-shadow and jaw-gating changes introduced no new islands. |
| F3 rim on lit silhouette, all three cams, not on face front | PASS | In the Behind cam the rim on the shirt back and hair edge is now about 2–3 px against the sea (r2 P2-5 closed). It is off the face front at every yaw I checked. |
| F4 outline width, tint, taper, no splits | PASS (carried) | Not re-measured. Visually unchanged. |
| F5 no inner-line shimmer | PASS (carried) | |

### G. Deformation pose set (front + side + 3/4 each)
| Pose | Result | Note |
|---|---|---|
| T-pose / arms down | PASS | |
| Arms overhead | PASS | Sleeves clear the head and the new hair. |
| Hands on head | PASS | No visible sinking into the 32-clump hair. |
| Punch L/R | PASS | Fists, and the cuff reads as a bell. |
| Goal post | PASS | |
| **Deep squat** | **FAIL** | The body is fine: no gap and a smooth crotch. **The sash tail hangs as a vertical post and goes 0.119 m below the floor** (160/872 tail vertices below y=0; feet at +0.016). It does not rest on the thigh. Visible in side and 3/4. **P0-1.** |
| High knee | PASS | The fur cuff is filled. The tail hangs clear with a slight curl, and the knot stays attached. |
| Front kick | PASS | The tail sits behind the leg. |
| Side kick / star jump | PASS | The tails swing clear. In star jump the tail hangs between the legs without contact. |
| Twist + lean | PASS | |
| Wrist twist ±90 | PASS (carried) | |
| Head turn ±70 / tilt ±30 | PASS | No jaw–neck shelf in the geometry. The collar is clear, and the hair clears the shoulders. |

### H. Secondary motion
| Item | Result | Note |
|---|---|---|
| H1 sash swing ≥10°, settles ≤1.2 s, ≤2 osc; no leg penetration | PASS | Side step: tail angle 13.1° rest → 28.8° peak (about 16° swing), settles about 0.7 s after the stop, 1 overshoot. `measurePenetration()` = 0 (legs). Snap transitions (punchL/highKnee/starJump → armsDown/squat, armsDown → kicks): the tail angle never exceeds the source or target envelope by more than 1.7°. **No horizontal flare** (r2 P1-4 flare closed). |
| H2 hem/cuffs trail; no idle jitter | PASS (carried) | |
| H3 dt spikes | PASS (carried) | Dynamics stats: 23 resets and 6 redrapes over about 11.8k frames, all on pose snaps; positions stay finite. |

### I. Presentation (game)
| Item | Result | Note |
|---|---|---|
| I1 front 58–65%, centred, clear of HUD | PASS (marginal) | 1440×900: 63.5–64.6% standing. 1920×1080: **65.0–65.3% standing**, sitting on or just over the 65% ceiling (r2: 59–61%) (P2-7). `overlaps: []` at both sizes. |
| I2 Behind/Side: camera-locked key, rim separates | PASS | Behind 60.6–61.1% standing, Side 61.5–63.8% standing. The rim reads and the profile face reads. |
| I3 contact blob, feet planted | PASS (carried) | |
| I4 post-fx | N/A | |

**Tally (A–G): 1 FAIL (G Deep squat). D1 passes under a documented waiver. H 3/3 and I 3/3 applicable pass.** By the ship bar, the build is not shippable until G-squat closes.

---

## 3. Fixed vs regressed since round 2

**Fixed (verified by measurement or capture):**
- r2 P0-1 hair silhouette: width 0.294 → 0.265, 57 → 32 clumps, bold tips.
- r2 P0-2 angel ring: now a single broken band.
- r2 P1-1 occiput and column neck: nape 1.511 → 1.480.
- r2 P1-2 profile nose point.
- r2 P1-3 profile cheek: one region at 80–90°.
- r2 P1-4: half closed. The knot is chunky and the snap flare is gone. The tail plank read remains (P1-1).
- r2 P1-5 triangle headroom: 175 → 5,793. Hair 9,220 → 5,960.
- r2 P1-6 chin: muzzle gone, rounder chin.
- r2 P2-1 expression cross-dissolve: now hard swaps.
- r2 P2-2 teeth ghost.
- r2 P2-3 hair dead-zone.
- r2 P2-4 tail ground shadow: back, with shadow draws still at 4.
- r2 P2-5 Behind-cam rim width.

**Not fixed / not re-checked:**
- r2 P2-6: the longest async block is still the body (132–149 ms; under budget).
- r2 P2-7: finger splay.
- r2 P2-8: IP read.
- r2 P2-9: spec A1 wording.

**New or regressed:**
- **New finding (likely pre-existing): the sash tail penetrates the floor in deep squat (P0-1).**
- The 1080p front framing rose from 59–61% to about 65.2%, at the ceiling (P2-7).
- Brow halo in shade, and the far brow floating at 70° (P2-3, P2-4). Both are minor and became visible now that the shading is cleaner.
- A stepped jaw-underside/neck shade notch at 80° (P2-5).

---

## 4. Prioritised remaining defects

### P0: blocks ship

| # | View / pose | What's wrong | Concrete fix | Owner |
|---|---|---|---|---|
| P0-1 | Deep squat preset; side, 3/4, game Side cam during a real deep squat or Pose Match squat | **The sash tail goes through the floor**: min y −0.119, 160/872 vertices below 0. It reads as a stiff post planted beside the heel instead of resting on or draping off the thigh. | 1. Add a ground-plane constraint to the verlet solve: after each substep, clamp particle `y ≥ 0.006` (root space, character floor y = 0), and when clamped apply tangential friction (scale the horizontal velocity by about 0.6) so the tail pools and bends on the floor rather than sliding. 2. Add a thigh-top rest collider for flexed hips (a capsule on the knot-side thigh, already in `colliders`), so that at hip flexion over 80° the upper tail drapes across the thigh as G requires. 3. Re-verify: every preset `min tail y ≥ 0`, G-squat side and 3/4 captures, and `measurePenetration()` still 0. | dynamics/verlet.js (constraint), dynamics/sashRibbon.js (floor and thigh hookup), dynamics/index.js (collider config) |

### P1: a publisher reviewer will flag these

| # | View / pose | What's wrong | Concrete fix | Owner |
|---|---|---|---|---|
| P1-1 | 3/4 (−60°) and Side cam, arms down / idle | **The long tail still reads as a flat, constant-width board** when seen face-on. The 3 folds read as faint lines, the taper (0.11 → 0.08) barely registers, and it hangs dead vertical. From the front the twist and curl look good. | Push the taper to 0.11 → 0.065. Make the folds geometric, with ±6–8 mm cross-section ripple instead of painted lines. Add a rest-pose S-bend (about 8–12° lateral offset at mid-length) so it never hangs plumb. Add a 30–40° twist over the lower third so the 3/4 view always sees an edge turn. | costume/accessories.js (tail profile and folds), dynamics/sashRibbon.js (rest shape and twist) |

### P2: polish

| # | View | What's wrong | Fix | Owner |
|---|---|---|---|---|
| P2-1 | Spec | D1 tip count is 10–12 against spec 7–9. Width is accepted at 1.34× max skull. | Amend spec 2.5 and checklist D1 to "9–12 bold tips; width 1.30–1.40 × max skull", to record the reference-matched compromise. | docs (art direction) |
| P2-2 | Front face cam | The two crown flick clumps (top-left and top-right "horns") read thin and long, with about a 3:1 silhouette aspect. | Widen their base by about 30% or shorten them by 15%. Keep the curl. | head/hair.js |
| P2-3 | Face, key ±35–60°, shaded side | A pale halo outlines the brow decal where it crosses the face shadow. The brow atlas edge padding is lit skin colour. | Pad the brow cells with transparent or brow colour and premultiply alpha, or shade the halo texels with the face shadow mask. | head/faceAtlas.js / head/faceRig.js |
| P2-4 | 70° yaw | The far brow floats a few px past the cheek silhouette, in front of the hair edge. | Apply the same far-side facing fade to the brows that the far eye uses. Start the fade at 60°. | head/faceRig.js |
| P2-5 | 80° yaw | Where the jaw-underside shade meets the neck there is a small stepped notch. | Smooth the jaw-gate transition (a wider smoothstep), or bias the neck-top normals toward the jaw proxy over the top 1 cm. | materials/faceShadow.js / body/body.js |
| P2-6 | Sandals close-up | The strap and toe paint reads as brown smudges and specks. | Repaint the sandal atlas with clean strap shapes, or remove the speckle. | costume/index.js (detail atlas) |
| P2-7 | Game Front cam, 1920×1080 | Standing hero at 65.0–65.3%, at or just over the 65% ceiling. | Pull the front cam back by about 2% at 16:9, targeting 62–63%. | render/framing.js / main.js camera preset |
| P2-8 | IP | The likeness is still very close (outfit + hair + face). Within the guardrail, but a publisher risk. | Legal read before external showing. Add one original signature element (sash pattern or a non-hat accessory). | art direction |
| P2-9 | Spec | Checklist A1 still says `main.js` is unchanged. Body+costume is 41k against the 30k sub-budget (total fine). | Amend the wording and rebalance `BUDGET.tris_by`. | docs / dims.BUDGET |
| P2-10 | Wrist twist close-up | Finger splay and knuckle breaks are still not re-checked. | Verify or implement. | body/hands.js |

---

## 5. Side-by-side with reference

At the same framing next to `docs/reference.jpg`, our hero is now plainly in the same style family:
- the red open shirt with bell sleeves,
- a chunky yellow sash knot on the left with a long hanging tail,
- blue rolled shorts with white fur cuffs, and sandals,
- a lean teen build with painted abs,
- a black mop over big round dark eyes and a wide grin.

**Hair, round 2's biggest gap, now matches.** It reads as the reference does: a handful of large, chunky, slightly shaggy locks with a lifted crown and a single highlight band. The extra width over my 1.30 target is what gives it the reference's volume, and it helps the read at game distance.

**Face.** It moved toward the reference's rounder, younger look. The chin is shorter and rounder, and the profile has a small nose and no muzzle.

**Sash.** The knot now has the reference's bulk. The tail is where we still diverge: the reference tail is soft, wide and gently twisting all the way down, while ours reads soft from the front but board-flat from 3/4 (P1-1) and turns into a floor stake in deep squat (P0-1).

**Guardrail.** There is no scar, no hat and no name. Overall likeness remains very close, so the legal read in P2-8 still stands before any external showing.

---

## 6. Evidence and measurements

- **Rig:** `checkRig()` → ok, 24 entries, max error 2.2e-16.
- **Triangles:** body 17,696 · costume 23,295 (tails included) · hair 5,960 · head 5,712 · face layers 1,544 (eyes 576, features 768, brows 200) · **total 54,207**. Draws 11 (4 outline); shadow 4 (body, costume+tails, hair, head).
- **Build:** async 259–344 ms total; longest block 132–149 ms (body); shell 10.7 ms. Second build plus dispose returns to baseline (9 geometries, 10 textures).
- **`update()`:** HUD average 0.275–0.339 ms. Max spikes of 1.9–2.3 ms occur only during the async build.
- **Rest / arms-down (m):**
  - hair x ±0.133 (0.265), y 1.480–1.793, z −0.168 to +0.113;
  - hair band widths by height: 1.60 → 0.229, 1.64 → 0.263, 1.68 → 0.247, 1.72 → 0.228;
  - head x ±0.099, y 1.490–1.745; skull at 1.60 is 0.198 wide; temple band (1.62–1.68) 0.186.
- **Sash:** rest tip y 0.436, tail angle 12.6°.
  - Snap maxima during transition: punchL → armsDown 13.5° (from 13.5); highKnee → armsDown 13.9° (settled 12.2); armsDown → frontKick 17.6° (from 13.5, decaying); armsDown → sideKick 10.9°; starJump → squat 20.7° (from 6.5; target-pose drape).
  - Side step: 28.8° peak, settled at about 1.17 s from motion start (0.67 s after the stop).
  - **Deep squat: tail min y −0.119, 160/872 vertices below the floor; feet min y +0.016.**
- **Hair springs (max angle):** 1.5 Hz ±30° shake: bangs 3.7°, sides 2.9°, back 2.2°. 3 Hz: bangs 4.0°, sides 6.0°, back 4.9°.
- **Game `measureFraming()`:**
  - 1440×900: Front 63.5–64.6%, Behind about 61% standing (50–56% during synthetic squats), Side 63%.
  - 1920×1080: Front 65.0–65.3% standing, Behind 60.6% standing, Side 61.5–63.8% (70.9% for one transient frame on the view switch).
  - No HUD overlaps.
- **Captures** (scratch, not committed): face yaw sweeps, expression sheets front and −70°, light sweep, body turnaround, knot close-ups, pose sheets, squat floor close-up, game Front/Behind/Side at both sizes.
