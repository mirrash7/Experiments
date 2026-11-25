# Hero Character v2: Art Spec and Implementation Plan

Owner: Character Art Direction / QA
Target: `web/src/character.js` (v1) is replaced by a v2 hero built entirely in code (three.js r170)
Reference: `docs/reference.jpg` (style, proportions, outfit design language, palette and attitude only)

> **IP guardrail (non-negotiable).** The hero is an ORIGINAL character in the reference's style. Do not ship: an X-shaped chest scar, the small scar under the left eye, a straw hat, any name, logo or text. Everything else in this doc (messy black hair, big round dark eyes, wide grin, open red short-sleeved shirt with bell cuffs and gold buttons, yellow sash with a long tail, rolled blue shorts with white fur cuffs, sandals) is a style target. The chest is clean, with painted muscle lines only.

---

## 1. Verdict on v1

**Verdict: not shippable. Prototype quality, about 3/10 against a AAA anime-game bar.** The colour blocking is right, so it reads as "red shirt, yellow sash, blue shorts" from across the room. Everything else gives away that it is built from primitives. It is rigid parented spheres, cones and lathes, so it falls apart in exactly the poses this game exists for: squats, kicks, punches and arms overhead. The hair reads as a hedgehog, not a mop. The sleeves read as megaphones. Shading is grey-ramp MeshToon with dirty realistic shadow maps on top. A publisher would bounce this at the first art review.

Scene facts measured in the preview: 198 meshes, 70 of them outline hulls, about 99k triangles, about 200 draw calls before the shadow pass. Height 1.75. Head (chin to skull top) about 0.236, which is about 7.4 heads tall. Shoulder joints 0.38 apart.

### Scored rubric

| Area | Score | Concrete defects observed (view) |
|---|---|---|
| Silhouette / readability | 4 | Front T-pose: the bell sleeves are huge rigid cones and dominate the silhouette. Game cam / in-game idle (arms down): the sleeves turn into stiff triangular "cape flaps" standing off the shoulders. Hair spikes radiate in every direction, porcupine-style, so the head silhouette is noisy. Side view: the sleeve is a flat disc ("satellite dish") facing the camera. |
| Proportions vs reference | 4 | Head too small: about 7.4 heads vs about 6 visual heads (hair included) in the reference. Arms are thin sticks (forearm radius 0.031 to 0.044 with no taper or muscle shape). Hands are mittens. The shirt ends too high and too tight. The shorts are straight tubes, not baggy. The legs are slightly long. The skull is wider than it is tall (lathe radius 0.121 vs height 0.236), giving a balloon head. |
| Face appeal | 5 | Face close-up: the eyes are the best part (round, outlined, double highlight). But the brows are floating black capsules ("sausages") stuck on top of the bangs. The nose is a 3D ball with a visible terminator. A hard diagonal cast-shadow band from the hair crosses the whole face (forehead to cheek). The ears sit low and look like flat discs. The head is a perfect lathe, so there is no cheekbone or jaw and no chin point. |
| Hair | 3 | Face, front and side views: about 25 thin open cones on a sphere cap, so it reads as a spiky "super-saiyan" urchin, not messy chunky clumps. The bangs are thin cones that don't form a fringe. With DoubleSide cones and their own outlines you get jagged inner lines. No highlight band. The hair moves as one rigid mass. |
| Costume fidelity | 4 | The shirt has no proper collar shape (a dark ring). Sleeves are elbow-length megaphones with no ruffle (the reference has softly waved bell cuffs just below the elbow). The trim is a torus. The sash is a torus tube with matchbox tails. The fur cuff is a ring of spheres. The sandals are capsules with half-torus straps. The shorts have no roll, pockets or stitching. |
| Shading / lighting | 3 | MeshToon gradient `[100,180,255]` darkens toward grey with no hue shift, so the shade tones look muddy, not anime. PCF soft shadow maps on the character: blotchy dark stains on the shirt back and shorts (back view), an arm shadow blob on the abs (punch pose), and the hair band across the face. In the game, ACES Filmic tone mapping desaturates and shifts the authored colours (red goes orange, skin goes grey). No rim light, no hair specular, no face-shadow control. |
| Outlines | 5 | Present and fairly consistent, which is good. But: pure black everywhere. Normals are not smoothed, so hulls split on hard edges (cones, sleeve rims). The DoubleSide open shells (shirt edges, sleeves) get no edge line. The fur cuff is over-outlined into a black lumpy band. The thigh skin has no outline. Muscle lines are 3D TubeGeometry, which aliases and swims at the game camera. |
| Deformation in motion | 2 | Squat (front and side): the shorts leg tubes rotate rigidly away from the pelvis and open a crotch gap. The fur cuffs become donuts floating on the knees. Kick (front): the fur ring faces the camera like a lifesaver. Arms overhead: the sleeve cones swallow the head, and the shoulder cap sphere separates from the torso. Elbows and knees are visible spheres. The shirt never follows the arms. This is the single biggest problem for a body-tracked game. |
| Secondary motion | 4 | The sash tail spring exists and is the right idea. But the tails are rigid boxes that clip through the thigh on a knee raise (test pose). The hair bounces as one solid lump. No shirt-hem, sleeve-cuff or fur response. |
| Overall shippability | 3 | Rebuild. Keep the rig contract, the expression API and the spring idea. Discard all geometry and materials. |

What to keep from v1: the bone names and rest layout, the `createCharacter()` API (`root, bones, setExpression, blink, setMouthOpen, update, dispose, info`), expression smoothing, auto-blink timing (2 to 5 s, 0.16 s duration), the tail-spring concept, and the deterministic seeded RNG.

---

## 2. v2 Target Spec

All numbers are in metres in rest T-pose (character faces +Z, Y up, feet on y=0). "Left" means the character's left (+X).

### 2.1 Rig (contract, unchanged externally)

- Bones are `THREE.Bone` (they extend Object3D, so `retarget.js` and `tests.js` keep working). Names: `hips, spine, chest, neck, head, left/rightShoulder, left/rightUpperArm, left/rightForeArm, left/rightHand, left/rightThigh, left/rightShin, left/rightFoot`. Markers: `leftHandTip, rightHandTip, leftToe, rightToe, headTop` (Bones or Object3D children). Identity rest rotations, unit scale.
- One `THREE.Skeleton` shared by every skinned mesh. Bind with `bindMode = 'attached'` and bind at rest.
- **Helper bones** (not in `hero.bones` and never written by the retargeter, but driven inside `hero.update()` after the retargeter runs):
  - `*ForeArmTwist` at 50% along the forearm. It takes 50% of the hand's twist about the forearm axis.
  - `*UpperArmTwist` at 40% along the upper arm. It cancels 50% of the upper-arm roll.
  - `*ElbowHelper` and `*KneeHelper` at the joint pivot. Each takes a 50% slerp of the child rotation and carries the joint-cap ring weights (volume preservation).
  - `*HipHelper` at the thigh joint. It takes a 50% slerp of the thigh rotation and carries the crotch and buttock rings.
  - Cloth bones: `shirtHemL/R` and `shirtHemBack`, `sleeveCuffL/R`, and hair groups `hairBangs, hairL, hairR, hairBack`.
  - Sash: rendered as a CPU-updated ribbon, not bones (see 2.10).
- Joint positions (world, rest). Shared lengths change slightly so the proportions below work.

| Joint | Position |
|---|---|
| hips | (0, 0.920, 0) |
| spine | hips + (0, 0.10, 0), so y 1.020 |
| chest | spine + (0, 0.21, 0), so y 1.230 |
| neck | chest + (0, 0.19, 0), so y 1.420 (base of neck, at the clavicle line) |
| head | neck + (0, 0.075, 0), so y 1.495 (jaw/skull pivot, just behind the ear-lobe line) |
| headTop | head + (0, 0.255, 0), so y 1.750 (skull top; hair rises to about 1.79) |
| Shoulder | chest + (±0.045, 0.125, 0) |
| UpperArm | Shoulder + (±0.130, 0, 0), so x ±0.175, y 1.355 |
| ForeArm | + (±0.275, 0, 0) |
| Hand | + (±0.250, 0, 0) |
| HandTip | + (±0.175, 0, 0) |
| Thigh | hips + (±0.088, −0.055, 0), so y 0.865 |
| Shin | + (0, −0.400, 0), so y 0.465 |
| Foot | + (0, −0.395, 0), so y 0.070 (ankle) |
| Toe | Foot + (0, −0.055, 0.170) |

`info.height` = 1.75. `info.shoulderWidth` = 0.35. `info.hipWidth` = 0.176.

### 2.2 Body proportions

| Measure | Target | Notes |
|---|---|---|
| Visual head (chin to top of hair) | 0.30 | Gives about 5.95 visual heads: matches the reference (measured about 5.9 to 6.2) |
| Skull (chin y 1.490 to skull top 1.745) | 0.255 | 6.9 skull heads |
| Skull width at temples / cheeks / jaw | 0.200 / 0.188 / 0.150 | Taller than wide (h:w = 1.27) |
| Skull depth (brow to back) | 0.215 | |
| Neck visible length (chin to collar) | 0.05 front, 0.09 back | |
| Neck radius | 0.044 wide × 0.040 deep | Sternocleidomastoid lines painted on |
| Shoulder width (deltoid outer, skin) | 0.42 | 1.4 visual heads |
| Shoulder width with shirt | 0.45 | |
| Chest at nipple line (y 1.27) | 0.30 W × 0.19 D | Lean athletic, defined pecs |
| Waist (y 1.03, narrowest) | 0.245 W × 0.165 D | Clear V-taper, chest:waist about 1.22 |
| Pelvis skin (y 0.90) | 0.29 W × 0.19 D | |
| Pelvis with shorts | 0.34 W × 0.23 D | Baggy |
| Crotch height | 0.80 | |
| Knee center | 0.465 | |
| Fingertips at rest (arms down) | about 0.74 | Mid-thigh, as in the reference |

**Limb radius profiles.** Elliptical: (width × depth) at normalized position t along the bone, t=0 at the parent joint. Interpolate with Catmull-Rom. Muscle offsets move the ellipse centre.

Upper arm (0.275):

| t | 0.0 | 0.12 | 0.35 | 0.55 | 0.80 | 1.0 |
|---|---|---|---|---|---|---|
| r (w×d) | .052×.050 (deltoid) | .049×.047 | .044×.046 (bicep, centre +Z .004) | .041×.042 | .036×.037 | .034×.034 |

Forearm (0.250):

| t | 0.0 | 0.18 | 0.40 | 0.70 | 0.92 | 1.0 |
|---|---|---|---|---|---|---|
| r | .035×.034 | .041×.036 (brachioradialis, centre +Y .004 in palm-down) | .037×.032 | .030×.025 | .025×.019 | .024×.018 (wrist, flat) |

Hand (0.175 from wrist to fingertip):
- Palm 0.085 L × 0.078 W × 0.026 T.
- Fingers 0.090 long. Index is separate. Middle, ring and pinky are separate digits too, each 0.016 to 0.018 thick, three segments, with the pinky 20% shorter.
- Thumb 0.060, rooted at 0.025 from the wrist on the +Z side (palm down), angled 40° forward.
- Rest shape is "relaxed": fingers curled 15°/25°/15° per segment, thumb slightly in.
- Hand length = 0.69 × skull height. Never smaller (small hands read childish).
- `fist` morph target required (P1). Use it during the `punch` action.

Thigh (0.400, mostly hidden by shorts):

| t | 0.0 | 0.25 | 0.55 | 0.80 | 1.0 |
|---|---|---|---|---|---|
| r | .085×.085 | .078×.080 | .068×.068 | .056×.058 | .050×.052 |

Shin (0.395):

| t | 0.0 (knee) | 0.08 | 0.28 | 0.55 | 0.85 | 1.0 |
|---|---|---|---|---|---|---|
| r | .050×.052 (patella bump +Z .006) | .046×.048 | .051×.055 (calf, centre −Z .010) | .041×.042 | .030×.031 | .029×.030 |

Foot: heel to toe 0.235, width 0.090 at the ball, 0.060 at the heel, instep height 0.060. Five toe bumps as geometry ridges, big toe 0.022 wide. Toenails are painted on.

### 2.3 Head shape

- Build the head from a deformed UV sphere (64×48) with an analytic displacement. Do not use a lathe. Required features:
  - Flat face plane: front z clamp with a 0.02 soft knee.
  - Cheekbone width at the eye line.
  - Jaw tapering to a soft rounded point: chin width 0.050 at y = chin + 0.012.
  - Chin 0.008 forward of the mouth plane.
  - Back-of-skull bulge 0.11 behind the ear line.
- Side view: near-vertical forehead (hidden by bangs). A subtle nose ridge, 0.007 protrusion, triangular in profile, sharp shadow-casting edge. Mouth area flat, chin rounded.
- **Face normals.** Transfer normals for the front 60% of the face from a smooth ellipsoid proxy (0.10 × 0.13 × 0.11): 80% proxy, 20% real. This stops the nose, mouth and cheek geometry from creating noisy terminators. Mandatory.

### 2.4 Face layout

Fractions are of the skull height H = 0.255, measured up from the chin, and of the skull width W = 0.20 at the eye line. Features are 2D, drawn into canvas-generated atlases (see WP3), not 3D blobs.

| Feature | Spec |
|---|---|
| Eye centre height | 0.40 H (0.102 above chin). Anime-low: the brow and forehead take up the top half |
| Eye spacing (centre to centre) | 0.43 W (0.086). The gap between eyes is about 0.9 eye widths |
| Eye size | 0.040 W × 0.046 H in metres (round, slightly taller than wide). Upper lid line arched, lower line flatter |
| Iris | 0.80 of eye height, nearly fills the eye, sclera visible on all sides only when surprised. Colour: vertical gradient from #1A1418 (top 60%) to #3B2A26 (bottom), with a thin darker ring #0C0A0E |
| Pupil | Not separate: a slightly darker centre (#07060A) at 0.45 iris size. Shrinks to 0.30 on surprised |
| Highlights | 1. Main catch-light: ellipse 0.30 iris width, upper outer quadrant (towards the key light), pure #FFFFFF, crisp. 2. Secondary dot: 0.12 iris, lower inner. 3. Optional bottom-rim crescent #6E5A6A at 40% opacity. Highlights stay screen-stable and only shift ±10% with gaze (they do not rotate with the head) |
| Upper lash line | Weight 0.0045 at the outer third, tapering to 0.0015 at the inner corner. Colour #16101A. Small outer flick (0.006 long, 35° up-outward) |
| Lower line | Outer 45% only, 0.0012, #5A3A3A (not black) |
| Sclera | #FFFFFF with an upper lid shadow band (top 22%) #CCD6EA. Hard edge, follows the lid arc |
| Brows | Short, thick-to-thin, slight arch. Length 0.75 eye width, 0.0040 thick inner, 0.0015 outer. Centre 0.62 H (0.158), inner end 0.01 closer to centre than the eye centre. Colour #1E1C26. **Brows render over the bangs**: a separate brow layer drawn after hair, with depthTest against a head-only depth or a stencil mask. Hair never hides brows; they read through the fringe as in anime |
| Nose | 2D only. A small shade wedge (#E3A285, 0.008 tall) on the shaded side plus a 1-px highlight tick at 0.30 H. In profile, the geometric ridge from 2.3. No sphere |
| Mouth | Centre at 0.17 H (0.043), on a 0.95 W-radius cylindrical patch. Shapes below |
| Ears | Top at 0.50 H (eye-top level), bottom at 0.28 H. Size 0.062 tall × 0.032 wide × 0.020 deep. C-shaped helix, rendered with painted inner line #C77D66. Placed at x ±0.098, z −0.012, tilted back 12°. They must poke out under the side hair |
| Cheeks | Happy and laugh only: soft blush oval #F29C8C at 35% under each eye, 0.03 × 0.012, with 3 short diagonal hatch lines #E07A70 (P1) |
| Forbidden | No scar under the eye, no chest X scar |

**Mouth shapes** (atlas cells; width as a fraction of W):

| Name | Use | Shape |
|---|---|---|
| `neutral` | Idle | Closed line, 0.20 W, corners up 0.002, 1.2 px line #3A1A1E |
| `smile` | Default idle (the hero is always half-grinning) | Closed curve, 0.28 W, corners up 0.006, short dimple ticks at the corners |
| `grin` | Happy, success | Wide open D: 0.46 W × 0.030. Top edge slightly arched, upper teeth as one white band 0.008 tall with no tooth separations, interior #7A1E2A, tongue #E5707A bottom 30%. Corners pull up into the cheeks with crease ticks |
| `laugh` | Big success / jump | 0.52 W × 0.045 open, teeth top band, eyes switch to the `happyClosed` arcs |
| `surprised` | Missed trigger, start | Small open oval 0.12 W × 0.030, no teeth |
| `determined` | Punch, kick, plank | Clenched grin 0.38 W × 0.018, both teeth rows visible with a dark centre line, corners slightly down at the outer 10% |
| `effort` | Squat hold, heavy | Open trapezoid 0.30 W × 0.026, top teeth, brows angled 20° down-in |
| `shout` | Combo | Open 0.34 W × 0.050 rounded, tongue visible |

**Eye states**: `open`, `half` (lid at 45%), `closed` (flat curved lash line), `happyClosed` (∩ arcs, 0.0035 thick), `surprised` (scaled 1.1, iris 0.65 with sclera all around, brows +0.012), `determined` (top lid flat at 25% cover, slanted 8° down-in, brows 22° down-in), `wince` (> < chevrons). Blink sequence: open → half → closed → half → open over 0.16 s, using atlas swap (no geometry ribbons).

### 2.5 Hair

Target read: a **rounded, messy, chunky black mop.** It is a soft cloud silhouette with 7 to 9 shallow points, not long spikes.

- **Silhouette rules**
  - Front view: total hair width 1.30 × skull width (0.26) at temple height. Hair top 0.045 above the skull.
  - The outline is a rounded "cloud" with 7 to 9 tips. The tallest tips are at the crown, about 10 to 20° off centre.
  - Side view: the mass sweeps back. Back of hair 0.05 behind the skull, with nape tips down to the neck top (y about 1.48).
  - Spike aspect ratio (length : base width) between 1.2 and 1.8. Never above 2.0 (v1 was over 3).
- **Clump count and placement** (26 clumps total, each a tapered, curved, flattened leaf; base buried 0.01 into the cap):
  - **Cap**: a single closed shell, the skull offset by 0.012, covering from the hairline (0.70 H at front, temples at 0.55 H) to the nape.
  - **Bangs, 7 clumps.** Fall from the hairline down over the forehead. Tips end at brow height (0.60 to 0.66 H). The longest is centre-left (length 0.075), which breaks symmetry. Arrange as 5 visible points across the forehead with 2 overlapping behind. Two narrow gaps show the forehead. Tips curve slightly forward (0.006) off the forehead so there is a readable fringe shadow, and slightly outward at the sides.
  - **Sides, 3 per side (6).** Over the temples, in front of the upper ear. Tips at mid-ear height, curving toward the cheek. They cover the top third of the ear only.
  - **Crown, 7 clumps.** Radiate from a whorl at yaw 180°, elevation 65°. Pointing outward and up 20 to 40°, lengths 0.05 to 0.08. These make the bumpy top silhouette.
  - **Back, 6 clumps.** Point down and out. Two nape flicks turn outward at the tips.
- **Clump construction.** Sweep an elliptical cross-section (1 : 0.45, tapering to 0 at the tip with a pow 1.6 profile) along a quadratic Bezier, with ±15° twist, 6 rings × 8 sides. Merge into one geometry.
- **Normals.** Blend 65% from a smooth hair-proxy ellipsoid and 35% real, so the toon terminator reads as one big mass with clean bands, not per-spike stripes.
- **Material**: hair toon (see 2.8) plus an anisotropic "angel ring" highlight band (2.9). FrontSide only. Clumps are closed meshes, so DoubleSide is banned.

### 2.6 Costume construction

**Shirt (open, red, short-sleeved, bell cuffs)**
- One continuous skinned mesh: torso tube plus two sleeves, welded at the armholes, no seams. Build it as an SDF shell: smooth-min union of a torso ellipsoid-capsule and two arm capsules, k = 0.04. Extract with Surface Nets at 1.2 cm voxels over the upper-body bounds only. Then:
  - Cut the front opening.
  - Cut the sleeve ends.
  - Cut the hem.
  - Laplacian-smooth (3 passes).
  - Retopologize to quads where possible.
  - Add thickness: inner shell offset −0.006, plus a rim strip on every cut edge. Cloth must have visible thickness at the edges; open DoubleSide shells are banned.
- **Fit**: 0.018 off the skin at the chest, 0.030 at the waist, 0.040 at the hem. Shoulder seam drops 0.02 down the arm.
- **Front opening**: a V from the collar point to the hem. Half-gap from centre: 0.035 at the collar, 0.090 at the nipple line, 0.120 at the hem. The panels hang slightly outward, showing collarbones, pecs and abs. The opening edges have a 0.012 placket band in shade colour #B01A2C.
- **Length**: the hem tucks 0.02 under the sash at the front, then flares outward at the sides and back into a short 0.04 skirt below the sash. The back hem is 0.03 longer.
- **Collar**: small stand-and-fall collar. Stand 0.022, fall 0.028, rolled outward, ending in soft points at the first button. Use the inner colour (shade) on the underside.
- **Sleeves**: 3/4 length. The sleeve body ends 0.06 below the elbow (forearm t = 0.24).
  - **Bell cuff**: flares from radius 0.050 to 0.085 over the last 0.085 of length, with 6 soft scallop waves on the hem (amplitude 0.010 radial, 0.006 axial).
  - Cuff hem gets a 0.010 inner band in the shade colour.
  - NOT the v1 megaphone. Max cuff radius 0.085.
  - The cuff is weighted 70% forearm / 30% `sleeveCuff` jiggle bone, so it trails the arm.
- **Buttons**: 4 gold domed buttons, Ø 0.016, height 0.005, on the wearer's right panel edge, 0.012 in from the edge.
  - First button 0.05 below the collar point, last 0.05 above the sash, evenly spaced (about 0.065 apart).
  - The left panel gets 4 matching small thread loops (painted).
  - Buttons are merged into the shirt geometry and copy the skin weights of the nearest shirt vertex, so they never swim.
- **Painted detail** (canvas texture, about 512²): shoulder seam, armhole seam, 2 to 3 soft fold lines at the inner elbow and under the arm, and hem stitching. Draw lines in #8E1428, not black.

**Sash (yellow)**
- Band 0.075 wide, wrapped twice. The visible overlap fold is 0.012 offset with a painted crease line.
- Sits on the hips: front centre y 0.935, back y 0.950, tilted. Offset 0.008 off the shorts.
- **Knot**: on the wearer's left at yaw 50° from front. A flat square knot 0.070 W × 0.060 H × 0.030 D with two short loop "wings" 0.045 long angled ±35°. Soft rounded edges, not spheres.
- **Long tail**: 0.44 from the knot to the tip. Tip at y about 0.49 (just above the knee, past the fur cuff). Width 0.072 at the top tapering to 0.060, with a 12° diagonal cut end. Two longitudinal soft folds via normals.
- **Short tail**: 0.24 long, 0.058 wide, behind and outboard of the long tail.
- Tails are double-sided ribbons with real thickness (0.006) and rim faces.

**Shorts (blue, rolled, with fur cuffs)**
- One continuous skinned mesh: waist plus two legs plus crotch gusset, built by the same SDF/Surface Nets method (pelvis ellipsoid ∪ two thigh capsules, k = 0.05). No rigid leg tubes.
- **Fit**: baggy. Leg opening radius 0.105 vs thigh 0.056 at the hem.
- **Hem height**: thigh t = 0.78 (y about 0.555), about 0.09 above the knee centre.
- **Rolled cuff**: a 0.035-tall double-roll band just above the fur, 0.008 proud of the leg, with a painted fold line.
- **Detail** (painted): fly J-stitch, two slanted front pocket openings, back yoke seam, and two back patch pockets. Stitching #8FA6E8 dashed. Fold lines at the crotch and behind the knee area in shade colour.
- **Weights**: crotch and buttocks rings blend hips/thigh with `HipHelper` so a 100° hip flexion (high knee) keeps the volume. No gap or pinch is acceptable.

**Fur cuffs**
- A single torus-based mesh per leg, around the shorts opening, with a 3-octave noise "cloud" displacement: 16 lobes around, 2 rows. Lobe silhouette radius 0.018 to 0.026, overall tube radius 0.022, ring radius 0.112. Not a ring of spheres.
- Rigid on the thigh bone at the hem position, flaring 8° outward at the bottom edge.
- Must not intersect the knee or shin at 120° knee flexion. Squash 10% on the back side via a vertex-shader pinch driven by the knee angle.
- Outline 60% of the standard width, in a lavender outline colour.

**Sandals**
- Sole: 0.016 thick, foot outline offset +0.010, 6° toe spring, slight rounded edge bevel.
- Straps: two flat bands 0.018 wide, 0.004 thick. One across the toes' base, one diagonal across the instep to the ankle, plus a heel strap.
- Rigid on the foot bone. The toes are visible in front of the toe strap.

### 2.7 Colour palette

All hex values are sRGB as authored. Character materials must render them **exactly**: `toneMapped: false` on character materials, or switch the game to `THREE.NeutralToneMapping`; see 2.11. Shade colours are hue-shifted (warmer or more saturated toward red/violet), never grey.

| Material | Base | Shade (1st) | Deep (crease/AO) | Highlight / rim | Outline |
|---|---|---|---|---|---|
| Skin | #F7D2B2 | #E39C7F | #C2705F | #FFEBDA | #6B3428 |
| Skin lines (muscle, painted) | #CF8A6E | | | | |
| Hair | #24232F | #13121D | #0A0A12 | band #555C7C, rim #6E7BA6 | #07070C |
| Shirt red | #D9262F | #A0152F | #6F0E2B | #F2604F | #3F0814 |
| Shirt placket/inner | #B01A2C | #7E1029 | | | |
| Buttons gold | #F4C84C | #B87D22 | #7E5214 | spec #FFF6C8 | #4A2E08 |
| Sash yellow | #F6D244 | #D99B2B | #AE6D22 | #FFF1A6 | #6B4410 |
| Shorts blue | #3552B3 | #22307C | #18205A | #5E7CD8 | #101840 |
| Stitching | #8FA6E8 | | | | |
| Fur white | #F8F6F0 | #C3CAE0 | #98A2C4 | #FFFFFF | #6E7692 |
| Sandal sole | #7B4B2B | #4F2D19 | #36200F | #A4704A | #24130A |
| Sandal strap | #9C6B3B | #6A4322 | | #C8955F | #2C1A0C |
| Iris | #1A1418 to #3B2A26 | | | catch-light #FFFFFF | |
| Sclera | #FFFFFF | #CCD6EA (lid band) | | | lash #16101A |
| Mouth interior / tongue / teeth | #7A1E2A / #E5707A / #FFFFFF | teeth shade #D9DEEA | | | line #3A1A1E |
| Blush | #F29C8C at 35% | | | | |

### 2.8 Shading model

A single custom toon shader (`ShaderMaterial`, or `MeshToonMaterial` patched with `onBeforeCompile`). It has skinning, shadow and fog chunks, and a palette-texture lookup.

- **Palette texture**: 32 × 4 RGBA (rows: base, shade, deep, highlight; columns: material ID). Each vertex carries `matId` (float). One material and one draw call covers body, shirt, shorts, sash, fur and sandals. Painted detail lives in a shared 1024² atlas: line art, multiplied, R = line mask, G = extra shade mask, B = highlight mask.
- **Light**: one "character key" direction **locked relative to the camera**: 35° to the camera's left, 40° above horizontal, slightly behind the camera. The character lights consistently in every arena view (front, behind, side). Ambient comes from the palette, not from scene lights. Scene `HemisphereLight` and `DirectionalLight` affect the arena only, except for cast-shadow reception (below).
- **Diffuse ramp, 2-tone + crease tone**:
  - `NdotL' = dot(N, L) * 0.5 + 0.5 + shadeBias`, where `shadeBias` is a vertex attribute in [−0.5, 0.5] painted procedurally: −0.3 in armpits, under the chin, under the sash and collar, inner thighs and inside the sleeves; +0.15 on the forehead and nose bridge.
  - Shade boundary: `smoothstep(0.50 − f, 0.50 + f, NdotL')` with feather f = 0.012 (crisp, but anti-aliased).
  - Deep tone only where `shadeBias < −0.2` and in shade: `mix(shade, deep, 0.6)`.
  - No third gradient band anywhere else. Gradients are banned on large surfaces.
- **Cast shadows on the character**: the character receives shadows from the arena only (props), thresholded: `shadow < 0.5 → shade colour`. **Self-shadowing is disabled on the face and hair, and on skin under the hair.** Shadow-map self shadows on the body are replaced by the `shadeBias` crease painting. The character still casts onto the ground (real shadow), plus a soft contact blob under each foot.
- **Face shading (SDF face shadow)**:
  - The face skin (front 60%) ignores N·L.
  - A canvas-generated 512² threshold map encodes, per texel, the light angle at which the texel enters shade. The shade boundary sweeps from the face's outer edge to the nose line as the light rotates 0 to 90°.
  - The shape is clean: it hooks around the eye socket and the nose wedge. It never splits an eye and never forms a band across the forehead.
  - Sample with the light direction projected onto the head's local XZ plane. Mirror U for the other side. This is the standard anime-game technique and is mandatory.
- **Rim light**: `rim = smoothstep(0.62, 0.68, 1 − dot(N, V))`, multiplied by `saturate(dot(N_screen, L_screen) + 0.3)` (lit side only), multiplied by intensity 0.45, coloured with the material's highlight colour. Suppressed on the face (mask) except at the jaw edge. This separates the silhouette from the busy beach background.
- **Specular**: none on skin or cloth. Buttons get one hard spec dot (`pow(NdotH, 80) > 0.5`). Hair uses the angel ring below.
- **Fog**: the character is exempt from fog, or uses a fog factor ≤ 0.15.

### 2.9 Hair highlight band ("angel ring")

- A view-dependent band computed in the hair shader from `dot(T, H)`, where T is the clump tangent (per-vertex attribute, the root→tip direction).
- Keep only a band where `|dot(T,H)|` falls in [0.0, 0.12], further gated by a height window (head-local y between 0.62 H and 0.82 H).
- Break it with a per-clump jitter (vertex attribute) so it reads as zigzag broken strips, not a smooth ring. Hard edged, colour #555C7C.
- Plus a thin rim (2.8) in #6E7BA6.

### 2.10 Outlines

- **Method**: an inverted hull per skinned mesh, sharing the skinning (same Skeleton), drawn as a second material pass (geometry groups or a duplicated SkinnedMesh sharing the geometry).
  - Extrude along a **smoothed outline normal** attribute: average the normals of all vertices that share a position, store it in `outlineNormal`, and use it instead of `normal`. This fixes split hulls on hard edges.
  - Push back in view space by 0.0015 so the hull never bleeds over inner creases.
- **Screen-space width**: convert to clip space and offset by `width_px * 2 / resolution * clip.w`.
  - Base width 2.2 px at 1080p for the silhouette. Scale with `min(resolution.y / 1080, 2)`.
  - Clamp so the outline never exceeds 0.004 m world width at close-up (the face cam must not get cartoon-fat lines). Close-up target: 2.5 to 3.5 px.
- **Per-vertex width multiplier** (`outlineWidth` attribute): hair tips 0.4, fingers 0.6, fur 0.6, sash tail 0.8, face front 0.0 (the face uses painted lines; only the jaw and chin silhouette get the hull), sclera/eyes 0.
- **Colour**: per-material tinted outline from the palette table (2.7), never #000. Eye lines stay near-black (#16101A).
- **Inner lines** (muscle, folds, seams, pockets) are painted into the detail atlas with soft-edged strokes. TubeGeometry lines are banned. Optional P2: a 1-px depth/normal Sobel pass for crease lines if budget allows.

### 2.11 Post-processing and colour pipeline

- **Tone mapping**: character materials use `toneMapped = false` (authored sRGB palette is final). If the arena needs tone mapping, keep it on arena materials only. Alternative: switch globally to `NeutralToneMapping` and validate the palette (ΔE < 3 on the swatch test). ACES on toon colours is banned.
- **Anti-aliasing**: render to a `WebGLRenderTarget` with `samples: 4` (MSAA) through `EffectComposer` → `OutputPass`. Fallback FXAA on low tier. No TAA (ghosting on fast tracked limbs).
- **Bloom (P2)**: `UnrealBloomPass` at half resolution: strength 0.18, radius 0.35, threshold 0.92. Affects only the catch-lights, button spec, rim and VFX. Must not haze the skin.
- **Colour grade (P2)**: one tiny ShaderPass: saturation 1.06, contrast 1.04, shadows tinted 3% toward #2A3A7A, highlights 2% toward #FFF0D8. Optional vignette 0.15.
- **Budget**: whole post chain ≤ 1.5 ms at 1080p on an M1-class integrated GPU.

### 2.12 Secondary motion

Run all of it in `hero.update(dt)` with fixed 120 Hz substeps (maximum 4 per frame). Every input is clamped. Tracker jitter must not excite it: low-pass the hips and chest velocity with a 60 ms EMA before feeding.

| Element | Model | Parameters | Colliders / limits |
|---|---|---|---|
| Sash long tail | Verlet chain, 8 particles, distance + bend constraints, ribbon mesh rebuilt on CPU (16 rings) | gravity 9.8, damping 0.08, stiffness 0.9, wind 0.15 sine | thigh capsules (r 0.075/0.060), shin capsules, hip ellipsoid. Never penetrates the leg; never rises above the knot |
| Sash short tail | Same, 5 particles | | same |
| Knot | Rigid on hips | | |
| Shirt hem L/R/back | 3 jiggle bones (damped spring on rotation) | k 120, d 12, max 18° | driven by hips velocity, chest yaw velocity |
| Sleeve cuffs | 1 jiggle bone each | k 160, d 14, max 15° | lags forearm angular velocity |
| Hair groups | 4 spring bones (bangs, L, R, back) | k 220, d 16, max 6° (bangs 4°) | Bangs must never reveal the whole forehead or cover the eyes |
| Fur cuffs | Scale squash only | ±6% from knee velocity | |

Acceptance for feel: a 0.5 s side step makes the tail swing visibly (≥ 10° peak) and settle within 1.2 s with no more than 2 oscillations. A punch makes the sleeve cuff trail by 2 to 4 frames.

### 2.13 Deformation rules

- **Continuous skinned surfaces (required)**:
  - Shirt (torso + sleeves).
  - Shorts (pelvis + legs).
  - Neck (chest → neck → head blend).
  - Visible torso skin (chest/abs, spine → chest blend).
  - Forearm + hand (wrist blend + twist bone).
  - Shin + knee region (the knee is visible below the shorts: thigh/shin/`KneeHelper`).
  - Foot (ankle blend).
- **Hidden-junction trick (allowed)**: the costume covers the shoulders, the upper arms to below the elbow, the hips and thighs, and the base of the neck. Underlying skin pieces may overlap without welding there, provided they share the same skeleton and weights at the overlap and **never poke through the cloth** in the QA pose set. Cloth gets +0.006 extra offset in the high-bend zones (armpit, crotch).
- **Rigid (allowed)**: skull/face/ears (head bone), hair base (head bone plus hair spring bones), eyes/mouth decals, sash knot, fur cuffs (thigh), sandals (foot), buttons (baked into the shirt with copied weights).
- **Skin weights**: generated from distance to bone segments along the limb parameter.
  - Blend window at each joint = ±1.2 × joint radius, smoothstep. Then 2 passes of Laplacian weight smoothing. Maximum 4 influences, normalized.
  - Joint-cap rings (the ring at the joint ±0.3 radius) get 40% on the helper bone.
- **Volume preservation targets**:
  - Elbow and knee at 130° flexion: the joint's outer cross-section stays ≥ 85% of rest radius; no inner interpenetration beyond 0.01; no candy-wrapper at a 90° wrist twist (thanks to the twist bone).
  - Shoulder at arms-overhead (upper arm 160° abduction): the shirt shoulder must not collapse below 75% of rest thickness, and the sleeve must not intersect the head or hair. Sleeve cuff radius and length from 2.6 guarantee this.
  - Hip at 110° flexion (high knee) and in deep squat: no gap between the shorts and the body; the fur cuff stays outside the shin.
  - Corrective blendshapes (optional P2): `elbowBend`, `kneeBend` and `hipFlex` morph targets driven by joint angle, to add an inner-crease bulge.

### 2.14 In-game presentation

- **Front view** (default): camera at (0, 1.30, 4.9), look at (0, 0.98, 0), FOV 34. Less perspective distortion than the current 42°, which made the head small. The character should occupy 58 to 65% of the viewport height and stay clear of the HUD side panels at 1440 × 900 and 1920 × 1080.
- **Readability floor**: at the game cam, the face (chin to skull top) must be ≥ 80 px at 1080p. At that size the eyes must still read as "big round eyes with a highlight". Lines on the face atlas must be ≥ 1.5 px at that size, so draw the atlas features bold.
- **Behind and side views**: same key light (camera-locked). The rim light must outline the back silhouette against the sea.
- **Ground contact**: real shadow plus a contact blob (radial gradient decal, 0.35 opacity) under the hips' ground projection. Feet must not visibly float more than 0.01.
- **Idle overlays when tracking is lost**: breathing (chest scale ±1.2%, 3.5 s), weight shift. These are additive, so they never fight the tracked pose.

### 2.15 Performance budget (character only)

| Item | Budget |
|---|---|
| Draw calls (incl. outlines, excl. shadow pass) | ≤ 14 (body/cloth 1 + outline 1, head 1 + outline 1, hair 1 + outline 1, face decal layers ≤ 4, sash 2, misc ≤ 2) |
| Shadow-pass draw calls | ≤ 4 (body, hair, head, sash) |
| Triangles | ≤ 60k total (body+cloth 30k, head 6k, hair 8k, hands 6k, fur 4k, misc 6k) |
| Bones | ≤ 48 |
| CPU `update()` | ≤ 0.4 ms (verlet + springs + atlas UV swaps; no canvas redraw per frame) |
| GPU character shading | ≤ 1.2 ms at 1080p |
| Load-time generation (SDF + Surface Nets, atlases) | ≤ 400 ms; it must not block the first frame for more than 250 ms (chunk or idle-callback it) |

---

## 3. Implementation plan

### File layout (new). `web/src/character.js` becomes a thin re-export.

```
web/src/hero/
  index.js              createCharacter() facade, public API, update() orchestration    [WP0]
  dims.js               all numeric proportions from section 2                          [WP0]
  rig.js                Bone hierarchy, helper bones, Skeleton, markers, helper drivers [WP0]
  palette.js            palette table (2.7) + matId enum                                [WP0]
  geo/attributes.js     attribute conventions + helpers (outlineNormal, matId, ...)     [WP0]
  materials/toon.js     toon ShaderMaterial (skinning, palette, ramp, rim, shadow)      [WP1]
  materials/outline.js  screen-space inverted hull material                             [WP1]
  materials/hair.js     hair toon + angel ring                                          [WP1]
  materials/faceShadow.js  canvas SDF face-shadow threshold map + face shader variant   [WP1]
  materials/characterLight.js  camera-locked key light uniforms                         [WP1]
  body/loft.js          ring-loft generator (elliptic profiles, muscle offsets)         [WP2]
  body/body.js          torso/neck/arms/legs/feet skin meshes                           [WP2]
  body/hands.js         hand mesh + fist morph                                          [WP2]
  body/weights.js       skin-weight generation + smoothing                              [WP2]
  body/detailAtlas.js   painted muscle lines, toenails (canvas)                         [WP2]
  head/head.js          head shape, ears, normal transfer                               [WP3]
  head/faceAtlas.js     canvas eye/mouth/brow atlases                                   [WP3]
  head/faceRig.js       expression table, blink, gaze, mouth API, atlas UV control      [WP3]
  head/hair.js          cap + 26 clumps, proxy normals, tangents                        [WP3]
  costume/sdf.js        SDF primitives + Surface Nets + cut/smooth/thicken utilities    [WP4]
  costume/shirt.js      shirt, collar, cuffs, buttons, shirt detail texture             [WP4]
  costume/shorts.js     shorts, rolled cuff, painted denim detail                       [WP4]
  costume/accessories.js  sash band + knot, fur cuffs, sandals                          [WP4]
  dynamics/verlet.js    rope/ribbon verlet with capsule colliders                       [WP5]
  dynamics/springs.js   jiggle-bone springs, velocity filters                           [WP5]
  dynamics/sashRibbon.js  CPU ribbon mesh for the tails                                 [WP5]
web/src/render/postfx.js      composer, MSAA RT, bloom, grade, output                   [WP6]
web/src/main.js, character-preview.*  integration, camera, QA tooling                   [WP6]
```

**Shared contracts** (WP0 publishes these on day 1; everyone codes against them):
- Geometry attributes: `position, normal, uv, outlineNormal (vec3), matId (float), shadeBias (float), outlineWidth (float), skinIndex, skinWeight`. Hair adds `tangent (vec3), clumpJitter (float)`.
- `createToonMaterial({ skinned, palette, detailAtlas, variant: 'body'|'face'|'hair' })` and `createOutlineMaterial({ skinned, palette })`. WP1 implements them. Until then WP0 ships stubs (MeshToonMaterial / black hull) so the other packages can render.
- Every builder returns `{ meshes: SkinnedMesh[]|Mesh[], update?(dt, ctx), dispose() }` and receives `{ rig, dims, palette, materials }`.

### P0: makes it shippable (must all land)

**WP0: Rig, facade and integration skeleton** (1 engineer, lands first, about 1 day)
- Bones as `THREE.Bone` with the joint table from 2.1, plus helper bones and their drivers in `rig.updateHelpers()`.
- `createCharacter(options)` keeps the v1 API, plus new methods: `setGaze(x, y)`, `setHandPose('relaxed'|'fist', side)` and `setAction(name)`, which picks the expression preset.
- Remove v1 geometry. `character.js` re-exports from `hero/index.js`.
- *Acceptance*:
  - `retarget.js`, `tests.js` and `main.js` run unmodified.
  - All 19 contract bones plus 5 markers exist with identity rest rotations.
  - Feet at y = 0 ± 0.002, `headTop` at 1.75 ± 0.01, `info.height` 1.75.
  - A joint-marker overlay in the preview matches the 2.1 table within 2 mm.

**WP1: Materials and shader module** (1 engineer)
- Toon shader with skinning, palette lookup, 2-tone ramp + `shadeBias` deep tone, camera-locked key light, thresholded arena shadows, rim, `toneMapped: false`.
- Screen-space outline with `outlineNormal`, per-vertex width, tinted colours.
- Hair shader with the angel ring.
- SDF face-shadow map generator and face variant.
- *Acceptance*:
  - Swatch test page (or preview toggle) shows every palette entry's base and shade exactly (ΔE < 2 sampled from a screenshot) in the game renderer.
  - Turning the key light 0 to 90° around the head produces a clean face shadow that never crosses an eye and never shows banding.
  - Outline is 2.2 ± 0.4 px at 1080p at the game cam, and ≤ 3.5 px in the face cam.
  - No split hulls on any hard edge.
  - No grey-ramp shading anywhere.

**WP2: Body and skinning module** (1 engineer)
- Ring lofts per the 2.2 profiles (16 to 24 segments around, ring spacing ≤ 0.02 near joints).
- Hands with 5 digits (relaxed rest) and feet with toe ridges.
- Weight generation, smoothing and helper-bone caps.
- Detail atlas: pecs, sternum, 6-pack, obliques, serratus hints, clavicles, knee and elbow lines, nails.
- *Acceptance*:
  - In the QA pose set (section 4), elbow and knee at 130° keep ≥ 85% outer radius.
  - No candy-wrapper at a 90° forearm twist.
  - No visible seam on the visible skin (forearm to hand, neck, knee, ankle).
  - Hand length 0.175 ± 0.005; limb radii within ±10% of the table.
  - Body ≤ 22k tris.

**WP3: Head, face and hair module** (1 engineer; the most art-critical, so assign the strongest TA)
- Head shape and normal transfer, ears.
- Canvas atlases for eyes (7 states + iris layer with gaze), mouth (8 shapes) and brows (5 shapes), all to the 2.4 dimensions.
- Brows over the bangs; blink via the atlas; expressions table.
- Hair to 2.5: 26 clumps, proxy normals, tangents for the angel ring.
- *Acceptance*:
  - Face close-up side-by-side with the reference: big round dark eyes with a crisp top-outer catch-light, wide grin reaching 0.46 W, brows visible over the fringe, no 3D nose ball, no shadow band across the face in any of the 8 light angles.
  - Front silhouette of the hair is 1.30 ± 0.05 skull widths with 7 to 9 tips; no spike above aspect 2.0.
  - Face reads at 80 px tall.
  - No scar.

**WP4: Costume module** (1 to 2 engineers: shirt+shorts / accessories)
- SDF + Surface Nets toolkit, with thickness and rims.
- Skinned shirt (opening, collar, bell cuffs, buttons baked in), skinned shorts (roll, crotch), sash band + knot, fur cuffs, sandals.
- Painted cloth detail textures.
- *Acceptance*:
  - Every 2.6 measurement within ±10%.
  - In every QA pose: no cloth gap, no body poke-through, no sleeve-head intersection with arms overhead, no fur donut (the cuff never faces the camera as a ring in a kick).
  - The sleeve cuff max radius is 0.085.
  - The shirt edges show thickness and an outline.
  - Exactly 4 buttons that never swim relative to the placket.

**WP6a: Colour pipeline and presentation** (part of WP6; P0 portion)
- `toneMapped: false` on character materials, or a global switch to Neutral. Camera to 2.14. Contact blob.
- Preview page QA tooling: pose presets (T, arms-overhead, squat, punch L/R, kick front, side kick, high knee, star jump, hands-on-head), a 30 s turntable, light-angle slider, wireframe and weight-heatmap toggles, outline toggle, perf HUD (draw calls, tris, update ms).
- *Acceptance*:
  - Front game view shows the hero at 58 to 65% of viewport height, unobstructed by the HUD at 1440 × 900.
  - Pose presets are reachable by button and by `window.setPose(name)`.

### P1: makes it feel AAA

**WP5: Secondary motion** (1 engineer, after WP0; it needs WP4's colliders and attachment points)
- Verlet sash tails with leg capsule colliders and CPU ribbon. Shirt hem, sleeve cuff and hair spring bones. Velocity filtering. Fixed-step integration.
- *Acceptance*:
  - 2.12 feel tests pass.
  - The tail never penetrates the legs in a high knee or kick (checked frame by frame at 0.25× in the preview).
  - Stable at 30 to 144 fps (no explosion with dt spikes up to 100 ms).
  - Update ≤ 0.25 ms.

Other P1 items, assigned by owner:
- WP3: expression polish: blush, `laugh`, `wince`; gaze follows the camera when idle.
- WP2: `fist` morph tied to the punch action.
- WP1: rim tuning and button spec.
- WP6: idle breathing overlay when tracking is lost.

### P2: polish (only after the P0/P1 QA pass)

- **WP6b post-fx**: MSAA render target via the composer, low bloom, colour grade pass, FXAA fallback. *Acceptance*: ≤ 1.5 ms; no skin haze; 60 fps held with webcam + HMR tracking running on the reference laptop.
- WP2/WP4: corrective morphs (elbow, knee, hip), normal-map ab and pec relief from the canvas height map.
- WP1: optional 1-px Sobel crease pass.
- WP3: hair strand-break detail lines in the atlas, extra mouth visemes.
- LOD: below 120 px character height, drop fingers (use mitten LOD) and hair clump detail.

### Parallelism and sequencing

Day 1: WP0 contracts and stubs. Then WP1, WP2, WP3 and WP4 proceed in parallel against the stubs. Each package can be QA'd in the preview with stub materials. WP5 starts once the WP4 attachment points (knot transform, hem bones) exist. WP6a can start on day 1. Integration review happens after each P-tier.

---

## 4. QA checklist (final review)

Run in `character-preview.html` at 1440 × 900 and 1920 × 1080, then in the game (`/`) in Front, Behind and Side views. Every item is pass/fail. Screenshot evidence is attached per item.

### A. Contract and technical
- [ ] `retarget.js`, `tests.js`, `actions.js` and `main.js` are unchanged and the game runs; the Pose Match test scores identically to v1 for the T-pose ghost.
- [ ] 19 contract bones + 5 markers present; rest rotations are identity; feet at y = 0 ± 2 mm; `headTop` at 1.75 ± 1 cm; faces +Z.
- [ ] Character draw calls ≤ 14 (+ ≤ 4 shadow); tris ≤ 60k; `update()` ≤ 0.4 ms average over 600 frames; load-time generation ≤ 400 ms.
- [ ] 60 fps held in the game with webcam + tracking active (Render FPS readout) for 2 minutes of free movement.
- [ ] No console warnings or errors; `dispose()` frees all geometries, textures and materials (renderer.info returns to baseline).

### B. Proportions and silhouette (front, side, back turntable, T-pose and arms-down)
- [ ] Visual head 0.30 ± 0.01 (about 6 heads total); skull taller than wide (h/w ≥ 1.2).
- [ ] Shoulders 0.42 skin / 0.45 shirt ± 0.02; chest:waist ratio 1.2 ± 0.05.
- [ ] Fingertips at mid-thigh in arms-down pose; hand length 0.175 ± 0.005.
- [ ] Arms-down front view: sleeves hang as bell sleeves, not flaps or capes; overall silhouette matches the reference's lean teen.
- [ ] Side-by-side with `docs/reference.jpg` at the same framing: overall gesture, palette and proportions read as "the same style family" to three reviewers; no forbidden IP elements (scar, hat, logos).

### C. Face (face cam; plus a 3/4 left and 3/4 right orbit)
- [ ] Eye centre at 0.40 H, spacing 0.43 W, size within ±8%; iris fills 80% of eye height; crisp catch-light upper-outer + secondary dot.
- [ ] Brows visible over the bangs in all expressions; never floating capsules.
- [ ] No 3D nose ball; nose wedge flips side with the light.
- [ ] All 8 mouth shapes and 7 eye states render without gaps or z-fighting; blink completes in 0.16 s; auto-blink every 2 to 5 s.
- [ ] Light-angle sweep (0, ±30, ±60, ±90°): the face shadow is one clean shape, never crosses an eye, no stripe across the forehead, no hair cast-shadow on the face.
- [ ] 3/4 views: eye and mouth decals don't stretch more than 10% and stay on the face curvature; ears visible under the side hair.
- [ ] Game cam: face ≥ 80 px tall at 1080p and the expression is identifiable (grin vs determined vs surprised) by a reviewer in under 1 s.

### D. Hair (front, side, back, top-down orbit)
- [ ] 7 to 9 silhouette tips from the front; width 1.30 ± 0.05 skull widths; no spike aspect > 2.0.
- [ ] Fringe of 5 visible points ending at brow height, 2 forehead gaps; side locks cover only the top third of the ears; nape flicks visible from the back.
- [ ] Shading reads as one mass with clean bands (no per-spike stripes); angel ring visible from front and side as a broken band; no backface artifacts.
- [ ] Hair springs: head shake ±30° produces lag of 4° or less on the bangs and never reveals the full forehead.

### E. Costume (front, side, back, close-ups)
- [ ] Shirt: open V to measurements; collar stand and fall with points at the first button; placket bands; 4 gold buttons on the wearer's right panel with loops on the left; hem tucked under the sash at the front and flared at the sides and back.
- [ ] Sleeves end 0.06 below the elbow; bell cuff max radius 0.085 with 6 scallops; cuff inner band visible.
- [ ] Every cloth edge shows thickness and an outline; no single-sided shells visible from any orbit angle.
- [ ] Sash: 0.075 band with double-wrap fold, tilted; knot on the wearer's left at about 50° yaw; long tail tip about 0.49 high, short tail 0.24.
- [ ] Shorts: baggy legs (opening r 0.105), hem 0.09 above the knee, rolled cuff band, painted pockets, fly and stitching.
- [ ] Fur cuffs: cloud-lobed (not spheres), cool shade, thinner outline.
- [ ] Sandals: sole, toe strap, instep strap, heel strap; toes visible.

### F. Shading, outlines and colour (in-game, all three views + preview)
- [ ] Sample 10 swatch points from the in-game screenshot: base and shade within ΔE < 3 of the 2.7 table (proves no ACES shift).
- [ ] Two tones only on large surfaces, plus a deep tone in creases; no grey shading; no PCF self-shadow blotches on shirt, shorts or face (back view especially).
- [ ] Rim light visible on the lit-side silhouette in Front, Behind and Side views; not on the face front.
- [ ] Outline 2.2 ± 0.4 px at the game cam; ≤ 3.5 px in the face cam; tinted per material; tapering at hair tips and fingers; no hull splits; no outline bleeding inside creases.
- [ ] No aliasing shimmer on inner lines while the turntable rotates (painted lines, MSAA on).

### G. Deformation: pose set (preview presets, each checked front + side + 3/4 orbit)
| Pose | Must hold |
|---|---|
| T-pose | baseline: no gaps, cloth evenly offset |
| Arms overhead (upper arm 160° abduction, elbows slightly bent) | shoulder cloth ≥ 75% thickness, sleeves don't intersect head or hair, no armpit tear, buttons stay on placket |
| Hands on head | forearm and hand don't sink into the hair more than 1 cm, elbows ≥ 85% volume |
| Punch L/R (forearm forward, elbow 0° to 90°) | sleeve cuff reads as a bell, not a dish facing the camera; fist morph active; shoulder rolls without collapse |
| Goal post (elbows 90°) | elbow volume ≥ 85%, sleeve covers the elbow joint |
| Deep squat (thighs 110° flexion, knees 130°) | no shorts-pelvis gap, crotch smooth, fur cuffs stay on the thigh and off the shin, knee volume ≥ 85%, sash tail rests on the thigh without penetrating |
| High knee (thigh 100°) | shorts leg follows, fur cuff doesn't face the camera as a donut, shirt hem doesn't clip the thigh |
| Front kick (thigh 90°, knee straight) | hamstring and buttock region smooth, no gap at the back of the shorts |
| Side kick / star jump (thigh 45° abduction) | inner-thigh cloth stretches without tearing, sash tails swing clear |
| Torso twist ±40° + side lean ±25° | abdomen skin and shirt panels twist smoothly, sash stays on hips, no shirt-sash gap |
| Wrist twist ±90° | no candy-wrapper |
| Head turn ±70°, tilt ±30° | neck blends, collar doesn't intersect the jaw, hair doesn't clip the shoulders |

### H. Secondary motion (Animate mode + free movement in-game)
- [ ] Sash tail: ≥ 10° swing on a 0.5 s side step, settles in ≤ 1.2 s, ≤ 2 oscillations; never penetrates the legs (0.25× slow-mo check during kicks).
- [ ] Shirt hem and sleeve cuffs visibly trail on punches and turns (2 to 4 frames); no jitter while standing still with live tracking noise.
- [ ] Stable under dt spikes (tab switch, 100 ms hitch): no explosion, settles within 1 s.

### I. Presentation (game `/`)
- [ ] Front view: hero is 58 to 65% of viewport height, centred, clear of HUD panels at 1440 × 900 and 1920 × 1080.
- [ ] Behind and Side views: key light consistent (camera-locked); rim separates the silhouette from the sea and sand.
- [ ] Contact blob present; feet planted (≤ 1 cm float) in the idle and squat poses.
- [ ] Post-fx (if enabled): no skin haze, bloom only on highlights, total post ≤ 1.5 ms.

Ship bar: every item in A to G passes, H and I pass at ≥ 90%, and the side-by-side review in B gets a unanimous "same style family, original character".

---

## 5. Amendments (decisions recorded during QA rounds 1–3)

These override the numbers above where they differ. Each was accepted by art direction in the QA round named.

| Area | Spec said | Decision | Where |
|---|---|---|---|
| Hair width (2.5, D1) | 1.30 ± 0.05 × skull | **1.34 × max skull width** (0.265 m over 0.198) = **1.42 × temple band** (0.186). Lead's volume compromise, accepted against the reference. Checklist D1 now reads "width 1.30–1.40 × max skull". | QA r3 D1 / P2-1 |
| Hair clumps / tips (2.5, D1) | 7–9 tips | **32 bold clumps**, about 10–12 readable tips. D1 now reads "9–12 bold tips". Hair 5,960 tris (sub-budget 8k, cap 6.5k). The two high crown clumps are wider and shorter so they read as messy crown locks, not horns (r3 P2-2). | QA r3 P2-1 / P2-2 |
| Chin (2.3) | — | Chin point **0.06 U**, sitting **2.5 mm ahead of the mouth** plane: rounder and shorter, with no forward muzzle at 70–90°. | QA r2 P1-6 / r3 |
| Shoulder joint (2.2, rig) | upper arm x 0.175 | Upper-arm joint **x 0.165**, skin shoulder width **0.435** (shirt 0.45) (`dims.SHOULDER_DECISION`). | QA r1 |
| Sash tails (2.6, E4) | tail width 0.11 | Long tail tapers **0.11 → ~0.065** at the tip; knot about **0.115** wide (chunky wrapped knot with a loop). | QA r3 P1-1 |
| Shirt buttons (2.6, E1) | — | Button spacing about **0.088** along the placket. | QA r1/r2 |
| Shorts and fur cuffs (2.6, E5/E6) | symmetric radii | **Asymmetric** shorts-leg and fur-cuff radii (front/back and inner/outer differ) so the cuffs follow the real thigh section and never show skin gaps. | QA r1/r2 |
| Front camera (2.14, I1) | (0, 1.30, 4.9) → (0, 0.98, 0) | Pulled back 4.5 % along the same ray: **(0, 1.314, 5.12)**. Synthetic standing moves now measure about 61–62 % (max 63.3 %) at both 1440 × 900 and 1920 × 1080; idle 59 %. | QA r3 P2-7 |
| Brows (2.4, C2/C6) | — | The brow decal takes the face shade field (its thin skin rim is tinted shade/base in shadow, no halo), and the far brow fades out between 60° and 72° camera yaw. | QA r3 P2-3 / P2-4 |
| Checklist A1 | `main.js` unchanged | `main.js` is WP6-owned and may change for camera presets and QA hooks (`measureFraming`, `renderOnce`). | QA r3 P2-9 |

**Triangle budget, actuals (QA r3; cap 60k, draws 11 + 4 shadow):** body 17,696 · costume 23,295 (tails included) · hair 5,960 · head 5,712 · face layers 1,544 (eyes 576, features 768, brows 200) · **total 54,207**, so about 5.8k of headroom. Body + costume together are 41k against the 30k sub-budget, which is accepted because the total is within the cap. `BUDGET.tris_by` should be rebalanced to match.
