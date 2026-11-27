# BREAKLIGHT: art direction QA, round 1

Reviewer role: art director (premium stylised anime action). Build: `cf49ca1`, served by Vite at `127.0.0.1:5173/game.html`.
Method: headless Chrome over CDP (own port and profile), 1440×900 and 1920×1080, quality preset High. Runs captured: boot, calibrate (demo tracker), title, tutorial, and `?autoplay=1` with `botSkill=0.93` / `1`, `seed=7`, across act 0, act 1 (1080p), act 2 into the boss, a boss run that ends in a retreat, a full-skill boss run that ends in a defeat, and results with the replay. Bursts were taken every 100–400 ms so motion, hits, shatters, blasts and transitions could be judged. `?debug=1` was left off.
Evidence is in `docs/game/qa-art-r1/`. The images are numbered, and the `*_sheet.jpg` files are bursts with the frame index in the top-left corner.

Performance on High was 60 fps throughout (16.7 ms frames, 91–114 draws, about 198k triangles, 6 long frames at load). Rendering speed is not the bottleneck. The problems are in direction.

---

## 1. Scored rubric

| # | Area | Score | One-line verdict |
|---|---|---:|---|
| 1 | First impression / wow | **5** | The title shot is charming and clean. Two seconds into gameplay you are looking at a small figure's back with an empty sky for long stretches. Nothing makes your jaw drop. |
| 2 | Stage and environment | **6** | The rune floor is the hero asset and looks good. Sun, cloud sea and floating islands set the mood. The trees are untextured sphere clusters and the waterfalls are flat white strips. The props read as greybox. |
| 3 | Spirits (readability + shape/colour) | **5** | Colour coding works: orange, cyan, red, violet, yellow, gold. Shapes are bare octahedra with no face, core or trail, so they read as "gems". They arrive *inside* the hero (striker, volley, brute), so the payoff happens behind the hero's body. |
| 4 | Boss (Eclipse Warden) | **4** | A dark silhouette on a dark sky, sitting low behind the trees at roughly 20% of screen height. It does not tower, there is no "half-emerged from the cloud sea", and its attacks are the run hazards reskinned. The defeat flash plus the eclipse ring is the best boss beat, but the camera misses it (see P0-1). |
| 5 | VFX (hits, shatters, blast, aura, trails) | **6** | Hit rings, shard bursts and kick trails are crisp and on-beat (07, 22). The Overdrive/charge aura is a hard-edged translucent tube (10, 12). The blast is a flat over-bloomed slab. Shatters are often hidden by the hero's body. |
| 6 | Hero presentation in gameplay | **5** | Size is right: the hero is 40–45% of frame height and kicks and jumps read clearly in silhouette. The face is **never** visible in gameplay. Punches go away from camera and are mostly occluded by the torso. Jump/charge pillars and hazard glow wash the hero out (18). |
| 7 | Camera direction and cinematics | **3** | Gameplay is one locked rear shot for about 5 minutes. The punch-in on perfects can't be seen at 1.6°. The blast cinematic **frames empty scenery with no hero and no target**, every time including the boss kill (14, 15, 19, 24). The boss intro is a low shot of the hero's legs with a small boss in the distance (16). Act changes have no camera beat. |
| 8 | UI/HUD art and typography | **6** | A strong type system (wide display face, chamfered panels, anime-arcade palette). Problems in execution: cream prompts on an orange/pink sky have low contrast, banners collide with prompts (17), judgement pop-ups sit on the hero's legs or off-screen (09), and act banners are small and sit on top of the portal. |
| 9 | Title / calibration / tutorial / results | **5** | The title is the best screen (03). The calibration guide is a crude stick figure with a dashed *ellipse* standing in for the arms (02). The tutorial shows the hero frozen in a T-pose under the demo tracker (05). Results look tidy, but the slow-motion replay is squeezed into a 30% strip between two big half-empty panels, with no "REPLAY" framing (20, 21). |
| 10 | Colour/lighting per act | **5** | The progression is there: amber, magenta, violet, boss night with an eclipse. Inside each act the whole frame drifts towards one hue (act 1 is pink sky, pink trees and pink floor), and value contrast between hero, threat and background collapses (11, 23). Act 2 "Violet Night" still has the sun up and almost no stars. |
| 11 | Performance feel | **8** | A locked 60 fps, hit-stop lands, and hits sync to the beat. Long gaps with no spirits in act 0 (22, frames 8–20) make it feel slower than it is. |

**Overall: 5.3 / 10.**

### Verdict against "would wow at a tech demo / publisher showcase"
**Not yet.** The CV showcase loop is impressive: tracker choice, a live skeleton PiP, judgement to the millisecond, measured body stats, and a replay rebuilt from your poses. The core look (cel hero, rune floor, dusk palette) is a credible base. But the build lets its own big moments go to waste:
- the blast and the boss kill are filmed with the hero out of frame;
- the gameplay camera never shows the hero's face or front;
- spirits shatter behind the hero's back;
- the boss is too small and dark to read as a "giant".

A publisher would see a competent prototype with placeholder props. The good news is that the top fixes are mostly camera and placement data, not new art. After P0 and P1 this could reach a 7.

---

## 2. Defects

### P0: breaks the showcase

| ID | View / moment | Problem | Concrete fix | Owner / files |
|---|---|---|---|---|
| P0-1 | Every Breaklight blast, including the **boss-kill blast** (14, 15, 19 frames 6–12, 24 frames 3–8) | The `blast` shot (`pos [4.2,1.7,1.2]`, `look [0,1.6,6]`) looks along +Z from the hero's left, so the hero at the origin sits behind the camera's view axis and is out of frame. The foreground fills with a blurred tree canopy (stage prop at about x=4) and an empty waterfall vista. "WARDEN DEFEATED" plays over empty scenery. | Re-author it as a front 3/4 shot that holds both the hero and the beam. Two options: pos ≈ `[2.4, 1.35, 2.6]` looking at ≈ `[-0.3, 1.3, 1.2]` with fov 40, then whip-pan to the target over about 0.5 s; or a two-shot from behind the shoulder with a low angle. Hide or fade stage props within 2.5 m of the camera during cuts (a stage API `setCameraClear(pos, r)`). For the boss, add a dedicated `bossKill` shot that frames the hero in the foreground and the Warden's weak point, and hold it until the defeat flash. | CORE `core/camera.js` (SHOTS.blast, new bossKill), `core/game.js:547`; VISUAL `visual/stage.js` (prop fade near camera) |
| P0-2 | Strikers, volleys and the brute at the hit moment (08, 11, 12, 21) | Spirits converge onto the hero's body. The striker octahedron intersects the hero's arm, volley stars pass through the torso, and the brute stands *on* the hero's position. The shatter, the most satisfying moment, is occluded by the hero and the clipping looks broken. | Move the hit points out to arm's/leg's reach plus margin, and offset them laterally away from the body axis as seen from the camera: about 0.75 m in front and 0.45 m to the side for strikers, the brute at about 1.6 m. Stop paths at the hit point and do the shatter there; on a miss, make the spirit lunge at the hero. Keep hit VFX sorted in front of the hero (heroScene overlay or `depthTest:false` for the burst sprite). | CORE `core/spirits.js` (paths/hitPoint), VISUAL `visual/spirits.js` (`hitPoint`, shatter draw order) |
| P0-3 | Calibration (02) | The T-pose guide is a stick figure whose arms are drawn as a dashed horizontal ellipse, so it reads as a halo or ring rather than "arms out". It shows "0 %" with a stray "%" below it. With the demo tracker it never fills, then times out after 7 s. This is the first CV wow moment and it looks unfinished. | Draw a filled, glowing humanoid silhouette with arms extended (an SVG path) that fills from the feet up as the pose matches. Put the percentage inline in one ring gauge. Make the demo/autoplay tracker strike the T-pose so calibration completes on stage demos. | UI `ui/calibrate.js`, `game.css`; CORE `core/stubs.js` / demo source (T-pose script) |

### P1: hurts the wow

| ID | View / moment | Problem | Fix | Owner / files |
|---|---|---|---|---|
| P1-1 | Gameplay camera, whole run (06, 22) | One locked rear shot for 5 minutes. The face is never seen, punches go into the back, and the punch-in (1.6° FOV, 4% dolly) can't be seen. | Bring the camera round to a 3/4 rear about 25–30° off axis, enough to see the cheek and the punching arm in profile: pos ≈ `[-1.25, 1.85, -2.9]`. Make the punch-in about 5° FOV plus 10% dolly, and add a small roll on kicks. Every 8 bars, or on Overdrive, do a 1.5 s "hero glamour" swing to a front 3/4, framed between waves. Add a quick front cut on combo milestones (25, 50). | CORE `core/camera.js`, `core/game.js` |
| P1-2 | Overdrive/charge aura (10, 12, 13) | A straight-walled translucent cylinder with hard top and bottom edges. It reads as a glass tube, not anime ki, and it washes out the hero's dark uniform. | Use a vertical flame card ring with noise-scrolled alpha, fresnel falloff and a soft top fade, plus rising ember particles and a ground ring. Keep the hero's silhouette dark inside it: additive at the edges only, and keep it off the hero's pixels. | VISUAL `visual/vfx.js` (aura) |
| P1-3 | Boss presence (16, 17) | The Warden is about 20% of screen height, low on the horizon, dark violet on dark violet, and partly behind the trees. The intro is framed from knee height behind the hero, so the hero's legs fill half the screen. | Scale it ×2–2.5 and raise it so the head clears the horizon at about 70% screen height. Add a rim light or emissive crack pass in cyan/white against the violet sky, and clear the trees from the boss sightline in the boss act. Reshoot the intro: a crane-up from the cloud sea showing the Warden rising, a hold on the face with the eyes lighting, then a cut back to the hero. Give attacks boss-specific animation (an arm slam on `slam`, an orb launch from the chest on `barrage`). | VISUAL `visual/boss.js`, `visual/stage.js` (boss act props); CORE `core/camera.js` (bossIntro) |
| P1-4 | False "STEP BACK" during autoplay jumps and charges (09, 18, 24) | The distance guidance fires while the bot jumps or raises its hands. That is a mistake shown on screen during a demo, right at the top-centre. | Suppress it for the autoplay/demo trackers, and debounce it for real trackers: about 1 s sustained, ignoring frames inside jump/handsUp/charge states. | CORE `core/game.js:407`; UI `ui/hud.js` (`distance`), `ui/body.js` (`measureDistance`) |
| P1-5 | Text collisions (17, 13, 24) | "HANDS UP – CHARGE!" overlaps "WEAK POINT!"; "DUCK!" stacks on "OVERDRIVE!"; act banners sit on the portal. | Give each element a fixed lane: prompts centred at 22% height, banners at 40% as a full-width slash band with an act-colour wipe, and toasts at the top. Queue banners while a prompt is live. | UI `ui/hud.js`, `game.css` |
| P1-6 | Judgement pop-ups (07, 09, 13) | Placed at the strike point, which is often on the hero's legs, behind the body, or below the frame (a cut-off "PERFECT" at the bottom). | Project the strike point, then clamp it to a safe ellipse and push it outward away from the hero's screen bounding box. Add a stroke or plate behind it for contrast. | UI `ui/hud.js` (judgement) |
| P1-7 | Results and replay (20, 21) | The replay plays in a narrow gap between two tall panels whose lower halves are empty. There is no "REPLAY · 0.35×" framing, and replayed spirits fill the frame at point-blank range. The stats count up from zero while the replay starts, so the eye has nowhere to go. | Phase it: (1) a full-screen cinematic replay with letterbox bars and a "BEST MOMENT · 0.35×" tag, about 6 s; (2) panels slide in. Compact the panels to their content height. Pull the replay camera back (fov 40, z 3.6) so spirits stay out of the hero's face. | UI `ui/screens.js`, `game.css`; CORE `core/replay.js`, `core/camera.js` (SHOTS.replay) |
| P1-8 | Act colour (11, 23) | Each act pushes everything towards one hue, so the hero, spirits and background lose value separation. Act 2 still has a full sun and almost no stars (`stars: 0.35`). | Keep the floor and props mid-to-low value and desaturated, so only the sky and the emissives carry the act hue. Act 2 needs a lower sun, stars at about 0.8, and darker clouds. Give the spirits a thin dark outline and a white core so they pop on any sky. | VISUAL `visual/stage.js` (palettes), `visual/spirits.js` |
| P1-9 | Tutorial with the demo tracker (05) | The hero stands in a T-pose for the whole drill. The rift portal sits behind the drill card, and the hand cursor covers the drill list. | Have the demo player perform each drill. Move the portal out of the card area for the tutorial camera, and give the drill list a reserved area the cursor avoids. | CORE `core/stubs.js` / autoplay; UI `ui/tutorial.js`, `ui/cursor.js` |

### P2: polish

| ID | Moment | Problem → fix | Owner |
|---|---|---|---|
| P2-1 | Title (03, 04) | The tagline "STRIKE TO THE BEAT · SHATTER THE GLITCH" is unreadable under the logo: move it 24 px lower and raise opacity to about 0.85. The hand cursor parks on the logo: start it near the buttons. The orbit spends half its time behind the hero: limit it to ±60° around the front. | UI `ui/screens.js`, `game.css`; CORE `core/camera.js` (title) |
| P2-2 | Stage props (03, 15) | The trees are untextured sphere clusters and the waterfalls are white quads. Add toon gradient ramps and painted leaf-cluster normals to the canopies, scrolling noise and a foam base to the falls, and a few rim-lit rock silhouettes in the mid-ground. | VISUAL `visual/stage.js` |
| P2-3 | Spirit shapes | Give each type a silhouette beyond its colour: striker with comet trail and fins, crawler with legs and a low skitter, volley as spiked stars (good already), brute with a real face plate rather than boxes (12). Add an emissive core and a 0.3 s trail ribbon to all of them. | VISUAL `visual/spirits.js` |
| P2-4 | Sweep beam (08) | Reads as a floating line at mid-height from the rear camera. Add ground scorch, a floor glow decal, and a ground-hugging shockwave along its path. | VISUAL `visual/spirits.js` |
| P2-5 | Prompt contrast | Cream "JUMP!"/"LEAN" on an orange or pink sky. Add a dark plate or a 3 px dark stroke plus outer glow, and colour-key prompts to the hazard colour. | UI `game.css` |
| P2-6 | Overdrive in the portal (10) | The portal turns muddy brown in Overdrive. Lerp it towards gold or white instead. | VISUAL `visual/stage.js` |
| P2-7 | Act transitions (23) | Only a small "ACT 3" banner. Add a 1 s sky-wipe flash, a stage pulse, a camera push and a banner slash. | VISUAL `visual/stage.js`; UI `ui/hud.js`; CORE `core/camera.js` |
| P2-8 | Results stats | "BEST REACTION — not measured" shows as a dead row in the hero panel. Hide it, or replace it with another measured stat. | UI `ui/screens.js`; CORE `core/score.js` |
| P2-9 | Act 0 pacing (22) | Gaps of 1–2 s with nothing on screen early in act 0 feel empty on a showcase floor. Add ambient "wisp" spirits drifting from the rift on the off-beats. | CORE `core/chart.js`; VISUAL `visual/spirits.js` |

---

## 3. Top 5 highest-leverage visual improvements

1. **Fix the cinematic camera language (P0-1, P1-1, P1-3).** Re-author `blast` and `bossIntro`, add `bossKill`, clear props near the camera, use a 25–30° off-axis gameplay camera, and add periodic front "glamour" cuts. This is mostly numbers in `core/camera.js`, and it turns the two biggest moments (blast, boss kill) from empty scenery into the money shot.
2. **Move the strike points out of the hero's body (P0-2).** The shatter is the core reward. Put it in front of and beside the hero, where the camera can see it. It costs almost nothing and every hit in the game improves.
3. **Make the boss a giant (P1-3).** Scale it ×2.5, rim-light it against the sky, clear its sightline, and give it a crane-up intro plus attack animations. A boss that fills the sky is what people film on their phones.
4. **Replace the aura tube with anime ki, and finish the blast beam (P1-2).** Flame cards, embers, a fresnel edge, and a beam with a hot core, outer swirl and impact flare. Charge and Overdrive appear many times per run, so this pays off over and over.
5. **Clean up the UI layout and CV-moment polish (P0-3, P1-4/5/6/7).** A proper silhouette calibration, no false "STEP BACK", lane-separated prompts and banners, and a full-screen letterboxed replay before the stats. The tech showcase deserves the same polish as the art.

---

## Evidence index (`docs/game/qa-art-r1/`)

| Topic | Images |
|---|---|
| Boot, calibration, title, tutorial | 01 boot · 02 calibrate (stuck, ellipse arms) · 03/04 title · 05 tutorial T-pose |
| Act 0 | 06 gameplay idle · 07 kick perfect (good VFX) · 08 striker clipping the hero · 09 false STEP BACK and clipped judgement · 22 burst |
| Overdrive | 10 aura tube |
| Act 1 (1080p) | 11 volley through the hero · 12 brute washout |
| Act 2 into act 3 | 13 act 2 sheet · 23 act transition sheet |
| Blast cinematic (no hero) | 14, 15, 24 |
| Boss | 16 intro sheet · 17 weak point text collision · 18 jump washout · 19 defeat sheet (the kill happens off-camera) |
| Results | 20 results · 21 replay sheet |
