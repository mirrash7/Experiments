# BREAKLIGHT: art direction QA, round 2

Reviewer role: art director (premium stylised anime action), the same reviewer as round 1. Build: `06b5bb5` ("fix round 1"), served by Vite at `127.0.0.1:5173`.
Method: headless Chrome over CDP on its own port (9441) and profile, at 1440×900 and 1920×1080, quality preset High, `?debug=1` off. Runs captured:
- A fresh profile through boot, calibration (autoplay tracker), title and the Act 0 **Awakening** intro into Act 1 (`autoplay=1&botSkill=0.93&seed=7`).
- 1080p: `skip=run&act=1` through act 2, act 3 and the boss intro into boss phase 2.
- `skip=boss&botSkill=1` through phase 3, the kill, the replay and results.
- `tracker=demo`: title, tutorial, and results with the Photo Booth armed.
- `/cv-lab.html?src=fake`: Mirror calibration, pour, sky echo, replay inset and the Photo Booth card.

Bursts were taken every 150–500 ms. Evidence is in `docs/game/qa-art-r2/`, and the `*_sheet.jpg` files carry the frame index in the top-left corner.

Performance on High is a locked 60 fps throughout, 58–60 during the boss intro.

---

## 1. Rubric: round 1 → round 2

| # | Area | R1 | **R2** | Verdict |
|---|---|---:|---:|---|
| 1 | First impression / wow | 5 | **7.5** | Calibration is now a real CV moment (a cyan hologram with a ring gauge). The Awakening gives you a front glamour cut within 20 s. The boss now fills the sky. People will film this. |
| 2 | Stage and environment | 6 | **6.5** | The floor and props are now desaturated stone, so the act hue lives in the sky and the runes. The trees are still untextured sphere clusters and the waterfalls are still white strips (P2-2 not done). |
| 3 | Spirits | 5 | **7** | Strikers have a core, fins and a telegraph ring. The brute reads as a gold armoured golem. Hits land at arm's reach beside the hero, where you can see them (08). |
| 4 | Boss (Eclipse Warden) | 4 | **8** | A giant crystalline guardian, rim-lit in cyan and half-sunk in glowing fog, with an eclipse halo, a WARNING banner, phase banners and a chest weak point (13, 14, 15). The head still reads as a dark orb with no eyes or expression, and trees still cut across its lower body. |
| 5 | VFX | 6 | **7** | The aura is no longer a glass tube: it is now flame streaks and light pillars. Shatter bursts, star impacts and the beam are good. Blasts and the kill end in a full-frame white-out that lasts about 1 s (10, 18). The Warden vanishes into the flash with no debris. |
| 6 | Hero in gameplay | 5 | **7** | Front cuts on combos and act ends finally show the face (06). The over-the-shoulder framing shows the punching arm. Most of the run is still the back of the head, and every prompt plate sits on the hero's legs (08, 09). |
| 7 | Camera / cinematics | 3 | **7.5** | **Fixed:** the blast is a side two-shot with the hero and the beam (10). The boss kill frames the hero in the foreground with the Warden cracking open (19). The boss intro cranes up, then cuts to a front hero shot. Remaining: the replay is a rear shot, not the front shot the GDD calls for. |
| 8 | UI/HUD | 6 | **6.5** | Lanes work: banners at the top, prompts at the bottom, no false STEP BACK seen in about 12 minutes of footage. New problems: prompts sit on the hero's legs, the prompt entrance double-exposes (07), a world crystal sits on top of the combo counter (15), and the in-game Photo Booth panel prints a literal "null" with its headline colliding into the stats panel (25). |
| 9 | Title / calibration / tutorial / results | 5 | **8** | Calibration (01, 02) and results (21) are premium. The tutorial demo player now performs every drill (04). The replay is full-screen, letterboxed and tagged "REPLAY · WARDEN DEFEATED · 0.35× · Rebuilt from your tracked poses" (20), which is exactly right. The title tagline is still faint. |
| 10 | Colour/lighting per act | 5 | **7** | Act 3 "Violet Night" now has stars and a cold palette, and the boss night has an eclipse. Act 2 is still a single pink wash across sky, trees and clouds (11). |
| 11 | Performance feel | 8 | **8.5** | 60 fps and hits on the beat. Remaining dead air: about 4 s of nothing after the Awakening finale blast (10, frames 139–147). |
| 12 | **Signature CV features** (new) | — | **6.5** | The **Photo Booth card is a 9**: a synthwave 4:5 card with the real player, the hero in the same pose, rank and measured stats, and a clear privacy line (24). The in-game calibration hologram is an 8. The **Mirror pour is a 5**: it plays inside a grey translucent rectangle that reads like a debug window, and the silhouette burns into a white flame beside the hero rather than flowing into it (23). The **Overdrive sky echo in the game is a 4**: a flat yellow dithered mannequin that is cut off at the top of frame in act 3 (09), sits over the rift portal, and in the boss fight is pasted **directly over the Warden's body** (16). |

**Overall: 5.3 → 7.3 / 10.**

---

## 2. Round-1 items: fixed vs open

| R1 ID | Item | Status | Evidence |
|---|---|---|---|
| P0-1 | The blast and boss kill filmed with no hero | **Fixed.** The side two-shot shows the hero and the beam; the kill frames the hero with the Warden cracking. | 10 (135–137), 18, 19 |
| P0-2 | Spirits shatter inside the hero | **Fixed.** Strikes land in front of and beside the fist, and the burst is visible. | 08, 12 |
| P0-3 | Calibration stick figure / ellipse arms / stuck at 0% | **Fixed.** A filled hologram silhouette with arms out and an inline ring gauge; demo and autoplay complete it, ending on "CALIBRATED!". | 01, 02 |
| P1-1 | Locked rear camera, face never seen | **Mostly fixed.** Over-the-shoulder framing plus front glamour cuts. The back of the head is still about 85% of screen time. | 06, 11 |
| P1-2 | Aura glass tube | **Fixed.** Flame streaks and pillars. The hero's dark vest stays readable. | 09, 12 |
| P1-3 | Boss too small and dark | **Fixed.** Giant, rim-lit, with a crane-up intro and attack animations. Open: trees in the sightline, and the face has no eyes. | 13–17 |
| P1-4 | False STEP BACK | **Fixed.** Not seen once. | all |
| P1-5 | Text collisions | **Fixed** between banners and prompts. **New** collisions: prompt on the hero, Photo Booth headline into the stats panel. | 08, 25 |
| P1-6 | Judgement pop-ups clipped or on the legs | **Fixed.** Clamped and readable; PERFECT now sits beside the fist. | 08, 17 |
| P1-7 | Results / replay strip | **Fixed.** Full-screen letterboxed replay first, then compact panels with the hero centred. | 20, 21 |
| P1-8 | Act colour washout | **Partly fixed.** Props are desaturated and act 3 has stars. Act 2 is still a mono-pink wash. | 11, 12 |
| P1-9 | Tutorial T-pose | **Fixed.** The demo player performs the drills. The portal still peeks out beside the drill card. | 04 |
| P2-1 | Title tagline, cursor, orbit | **Partly fixed.** The orbit holds the front now. The tagline is still about 9 px at low contrast, and the cursor still parks on the logo. | 03 |
| P2-2 | Tree and waterfall props | **Open** | 11, 14 |
| P2-3 | Spirit silhouettes | **Fixed** for strikers and the brute. | 07, 11 |
| P2-4 | Sweep beam ground read | **Fixed.** There is a floor chevron decal. | 09, 11 (frame 42) |
| P2-5 | Prompt contrast | **Fixed.** Dark plate with an icon. | 08 |
| P2-6 | Portal muddy in Overdrive | **Partly fixed.** It is now pale. The echo now covers it. | 09 |
| P2-7 | Act transitions | **Partly fixed.** A front cut plus a banner. There is no sky-wipe flash. | 11 (90–96) |
| P2-8 | Dead "not measured" row | **Fixed.** Replaced by timing consistency. | 21 |
| P2-9 | Act 0 gaps | **Partly fixed.** The Awakening is dense, but there are about 4 s of dead air after its finale. | 10 |

---

## 3. Remaining defects

### P0: breaks the showcase

| ID | Moment | Problem | Concrete fix | Owner / files |
|---|---|---|---|---|
| P0-1 | **Overdrive during the boss fight** (16; 17 frames 234–250). Overdrive triggers in every boss run. | The sky echo spawns at its default world placement `(0, 11, 74)`, which is exactly where the Warden stands. The camera's big money shot (the giant boss) gets a flat yellow mannequin pasted over its torso for 10 s, and at the end of Overdrive the mannequin flashes red. It also flattens the boss's depth: the echo draws over the boss's crystal. | In the boss state, either (a) call `echo.setPlacement({ position: (−22, 20, 60), height: 24 })` so it stands beside the Warden as a "spirit ally" facing it, or (b) render it *behind* the boss: put it at z ≈ 110, scale it so the head clears the Warden's halo, and drop its opacity to about 0.35 with additive edges only. In acts 1–3, place it so the whole figure fits in frame (see P1-2). Never let it overlap the portal or the boss's head or chest bounding box (project and test it as the hero rect does). | CV `cv/echo.js` (placement, opacity), `cv/mirror.js`; CORE `core/game.js:900` (pass a per-state placement when echo mode turns on) |

### P1: hurts the wow

| ID | Moment | Problem | Fix | Owner / files |
|---|---|---|---|---|
| P1-1 | Every gameplay prompt (08, 09, 12, 17) | The prompt lane is bottom-centre, and the hero stands bottom-centre, so every "JUMP! / RIGHT PUNCH NOW!" plate covers the hero's hips and legs. A jump or kick, the body move you want people to watch, is hidden behind a label. | Move the prompt lane to about 30% from the top (between the score and the horizon), or keep it low but offset it to the side opposite the hero's screen rect (the hero sits at 40–50% x). Shrink the plate to the icon plus the verb. The judgement already projects and clamps, so reuse that clamp with the hero rect as a keep-out. | UI `ui/hud.js` (prompt lane), `game.css` |
| P1-2 | Overdrive echo in acts 1–3 (09, 11 frames 48–60, 12 frames 105–170) | A flat, dithered, saturated yellow mannequin with no internal shape. In 1080p act 3 the head and arms are cut off by the top of the frame. It sits on the rift portal, and it reads as a sticker rather than "my body as a giant spirit". With the demo tracker it is a skeleton blob, but showcase stands without a camera will show exactly this. | Render it as neon contour lines (the cv-lab hologram look: cyan or white edge, act-coloured fresnel, scanlines) rather than a filled body. Fit its height to the camera frustum (head at about 85% of screen height) and position it left of the portal. Fade it in with a rising sweep on the Overdrive start beat. For the skeleton fallback, use the same capsule hologram as calibration (01), which already looks great. | CV `cv/echo.js`, `cv/neon.js`, `cv/skeleton.js` |
| P1-3 | Mirror pour at calibration (23, cv-lab sheet 22) | The live silhouette sits inside a grey, 60%-opaque rounded rectangle that dims a third of the screen and reads like a debug window. During the pour the silhouette turns into a white flame column and drips down where it stands, *beside* the hero. It never visibly travels into the hero. | Drop the panel, or make it a thin neon frame with no fill. Animate the pour as a path: the silhouette's particles stream along a curve into the hero's screen rect (which you already compute), and the hero gets a 0.3 s rim-light flash and a ground ring when they arrive. Match the in-game calibration hologram style (01) so the lab and the game agree. | CV `cv/mirror.js` (`pourInto`), `cv/stylizer.js`; UI `ui/calibrate.js` |
| P1-4 | Photo Booth in results (25) | (a) A literal **"null"** prints under the booth panel. `setPhotoCard` appends `media && o.caption ? … : null` straight into `photoSlot.append(...)`, and DOM `append(null)` inserts the text "null". (b) The large "STRIKE YOUR VICTORY POSE" headline is orange on an orange sky and runs into the "YOUR BODY" panel. (c) The privacy toast sits on top of PLAY AGAIN / TITLE. (d) The countdown digit is drawn over the hero's chest. | (a) Filter the falsy children: `photoSlot.append(...[…].filter(Boolean))`. (b) Put the headline in the centre lane at about 22% height with a dark plate, constrained between the two panels, or drop it, because the panel already says it. (c) Raise the toast above the button row, or show it inside the booth panel. (d) Offset the countdown to the side of the hero, or draw it at the hero's feet. | UI `ui/screens.js:526-541`, `game.css`; CV `cv/photobooth.js` (headline, countdown) |
| P1-5 | Blast and kill white-out (10 frames 135–137, 18 frames 60–63) | Every blast and the kill end in roughly 1 s of near-white frame. The Warden simply vanishes inside the flash, with no shatter or falling crystal, and then the sky is empty. The best-framed shot in the game burns out at its climax. | Clamp bloom and exposure during cinematics (keep the peak below about 0.9 luminance outside the beam core). For the kill, spawn 30–60 large crystal shards from the Warden mesh that tumble down into the cloud sea over 2 s, plus the eclipse ring reveal. Hold the camera on the hero's silhouette against the falling debris. | VISUAL `visual/boss.js` (death shatter), `visual/vfx.js`; render `render/post.js` (cinematic bloom clamp); CORE `core/camera.js` (bossKill hold) |

### P2: polish

| ID | Moment | Problem → fix | Owner |
|---|---|---|---|
| P2-1 | Prompt entrance (07) | The prompt scales in with a large ghost copy over the real one, so for about 250 ms it reads as a double exposure or rendering bug ("RIGHT PUNCH" with a second "…CH ▶" behind it). Fade the ghost faster (≤120 ms), or make it a single chromatic offset. | UI `ui/hud.js`, `game.css` |
| P2-2 | HUD vs world (15, 14) | The floating cyan or gold crystal on top of the obelisk renders right over the combo counter and hearts. Lower the obelisk, move it to x ≈ −5, or give the HUD column a soft dark vignette. | VISUAL `visual/stage.js` |
| P2-3 | Boss face (14, 20) | The head is a dark sphere with a small gem, so at gameplay distance it has no expression. Add two emissive eye slits that flare on telegraphs and go dark on defeat. | VISUAL `visual/boss.js` |
| P2-4 | Boss sightline (14, 15) | Trees at both sides cut across the Warden's lower body and arms. In the boss act, scale the near trees down or push them out (x > 7). | VISUAL `visual/stage.js` |
| P2-5 | Act 2 palette (11) | The sky, canopies, clouds and portal are all pink. Make the canopies a cool teal or dusk-blue complement, and give the clouds more value contrast. | VISUAL `visual/stage.js` |
| P2-6 | Replay camera (20) | Good composition, but it is a rear shot. The GDD says a front cinematic. Alternate: the first half from the front 3/4, the second half from the rear two-shot. With demo or autoplay, show the skeleton "YOU · 0.35×" inset (the cv-lab version, 22) so the CV claim is visible without a camera. The hand-cursor reticle also sits in the top letterbox. Hide it during the replay. | CORE `core/camera.js` (SHOTS.replay), `core/game.js:568` |
| P2-7 | After the Awakening finale (10 frames 139–147) | About 4 s of nothing before the "ACT 1" banner. Overlap the banner with the blast tail, or drift ambient wisps. | CORE `core/chart.js`, `core/game.js` |
| P2-8 | Title (03) | The tagline is still tiny and faint under the logo. Use about 14 px at 0.85 opacity. The cursor still parks on the logo. | UI `ui/screens.js`, `game.css` |
| P2-9 | Props (11, 14) | The trees and waterfalls are still greybox. Same fix as round 1 (toon ramp and painted canopy normals; scrolling noise and a foam base for the falls). | VISUAL `visual/stage.js` |
| P2-10 | Boss barrage (15) | The yellow 4-point star projectiles are big, flat and cross the hero's head. Shrink them by about 30%, add a hot white core and a trail, and keep them off the hero rect at the moment of impact (same rule as P0-2 in round 1). | VISUAL `visual/boss.js` / `visual/spirits.js` |

---

## 4. Top 5 remaining improvements (by leverage)

1. **Fix the Overdrive echo (P0-1 + P1-2).** Re-place it per state, never over the boss or the portal, fit it in frame, and give it the neon-contour hologram look you already have in calibration. It is the signature CV feature, and right now it is the weakest-looking element on screen.
2. **Get prompts off the hero (P1-1).** The hero's body is the thing the webcam is driving. Move the prompt lane up or to the side and let every jump, kick and duck be seen.
3. **Land the climax: no white-out, and a real boss shatter (P1-5).** Clamp cinematic bloom, then have the Warden fall apart as tumbling crystal with the hero silhouetted in front. This is the frame that ends the trailer.
4. **Make the Mirror pour flow into the hero (P1-3).** Remove the grey panel and stream the silhouette along a curve into the hero's rect, ending in a rim-light flash. "Your body poured into the hero" is the line the demo host will say, so the visual has to deliver it.
5. **Clean up the Photo Booth results flow (P1-4).** Remove the "null", fix the headline lane and the toast over the buttons. The card itself is the best-looking CV asset in the build. Make the path to it as clean as the card.

---

## 5. Verdict against "wows at a tech demo / publisher showcase"

**Yes, conditionally. It is now showcase-grade on the core loop. Fix P0-1 and P1-1 to P1-4 before putting it in front of a publisher.**

Round 2 is a different game from round 1:
- The camera now films its own big moments: a blast two-shot, a kill two-shot, a boss crane-up and front glamour cuts.
- The Warden is a genuine sky-filling giant.
- Hits land where you can see them.
- Calibration, the letterboxed replay ("rebuilt from your tracked poses, not a video") and the results screen look like a shipped product.
- The Photo Booth card is a take-home artefact people will post.

What still reads as prototype is concentrated in the *new* CV layer:
- the echo is pasted over the boss and cut off by the frame;
- the pour sits inside a grey debug-looking panel;
- the booth panel prints "null";
- the prompt lane hides the body the webcam is tracking.

All of these are placement and composition fixes rather than new art. With them done this lands around 8/10 and would hold a publisher booth. The remaining greybox trees and the pink act 2 are the gap from 8 to 9.

---

## Evidence index (`docs/game/qa-art-r2/`)

| Topic | Images |
|---|---|
| Calibration, title, tutorial | 01 calibrate hologram · 02 calibrated · 03 title · 04 tutorial demo drills sheet |
| Awakening / act 0 | 05 Awakening sheet · 06 front glamour cut · 07 prompt double exposure · 10 blast sequence sheet (two-shot, white-out, dead air) |
| Gameplay, 1080p | 08 hit at reach + prompt on the legs · 09 Overdrive echo cropped over the portal · 11 act 2 sheet · 12 act 3 sheet |
| Boss, 1080p | 13 intro sheet · 14 WARNING / boss scale · 15 barrage + HUD crystal · 16 echo covering the Warden · 17 fight sheet |
| Kill / results | 18 kill sheet (white-out, boss vanishes) · 19 kill two-shot · 20 letterboxed replay · 21 results |
| CV features | 22 cv-lab sheet (calibrate, pour, echo, replay inset, booth) · 23 pour in the grey panel · 24 photo card · 25 in-game booth panel ("null", headline overlap) · 26 sky echo in the lab |
