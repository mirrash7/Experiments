# BREAKLIGHT: art direction QA, round 3

Reviewer role: art director (premium stylised anime action), the same reviewer as rounds 1 and 2. Build: `24e55fd` ("fix round 2"), served by Vite at `127.0.0.1:5173`.

Method: headless Chrome over CDP on its own port (9461) and profile, at 1440×900 and 1920×1080, quality preset High, `?debug=1` off. Runs captured:
- **A** (1440): a fresh profile, `?kiosk=1&autoplay=1&botSkill=0.93&seed=7`, through boot, calibration, the pour onto the title hero, the Awakening and acts 1 and 2 into act 3.
- **B** (1080p): `skip=run&act=1&awaken=0`, through acts 2 and 3, the boss intro and boss phases 1 and 2.
- **C** (1080p): `skip=boss&botSkill=1`, through the kill, the WARDEN DEFEATED replay and results.
- **D** (1440): `tracker=demo&kiosk=1` on a fresh profile, covering the flash notice, title, clear-space check, tutorial (also re-run from a clean title path) and results.
- **RF** (1440): the boss kill again with `reduceFlashes=1`.
- **CV**: `/cv-lab.html?src=fake`, covering calibration, the pour, the sky echo (act and boss presets), the replay inset, the booth countdown and the card.

Bursts were taken every 400–450 ms. Evidence is in `docs/game/qa-art-r3/`, and the `*_sheet.jpg` files carry the frame index in the top-left corner.

Performance on High is a locked 60 fps in all gameplay (B: 330/330 samples at 60). It dips only on load and at the title→run swap (8–50 fps for 1–2 samples).

---

## 1. Rubric: R1 → R2 → R3

| # | Area | R1 | R2 | **R3** | Verdict |
|---|---|---:|---:|---:|---|
| 1 | First impression / wow | 5 | 7.5 | **8.5** | The calibration hologram now dissolves into cyan particles that pour onto the title hero (03), the best "your body is in the game" moment in the build. Kiosk boot is clean: flash notice → calibrate → title. The first front glamour cut comes within about 20 s. |
| 2 | Stage and environment | 6 | 6.5 | **7** | Act 2 is now a moonlit teal and magenta night (11, 15) and the acts finally feel like different places. The trees are still sphere clusters and the waterfalls are still flat white strips. |
| 3 | Spirits | 5 | 7 | **7** | Unchanged and still good: strikers, the gold brute golem, and hits beside the fist. |
| 4 | Boss (Eclipse Warden) | 4 | 8 | **8.5** | It now has glowing visor eyes that flare red on telegraphs (18, 19 frame 318). The crane-up intro includes a head close-up (17 frame 232). The kill is a real crystal shatter (21). Its idle pose is static between attacks. |
| 5 | VFX | 6 | 7 | **8** | **The white-out is gone.** The blast stays readable, and the kill breaks the Warden into tumbling shards with an eclipse orb rising (09, 21, 25). The new pour arrival glow is a flat translucent overlay with a hard band at the chest (27). The barrage stars are still flat. |
| 6 | Hero in gameplay | 5 | 7 | **7.5** | Prompts mostly sit beside the hero at chest height, so jumps, ducks and kicks read clearly (07, 15, 16). The hero holds a guard stance while the Breaklight beam fires (09, 13, 14), so pose and VFX are disconnected. |
| 7 | Camera / cinematics | 3 | 7.5 | **8** | The kill holds on the hero in the foreground with the shatter behind. The replay opens on a new side shot (`replayKill`) and the shatter replays well (23 frames 198–207). The opening replay frame is weak (22). |
| 8 | UI/HUD | 6 | 6.5 | **7** | The prompt lane is fixed for most moves. New: HANDS UP → PUSH swaps double-expose on the hero's torso at **every** blast (10). The echo's raised arms sit over the Overdrive meter (11, 12). PERFECT draws across the prompt plate (12). |
| 9 | Title / calibration / tutorial / results | 5 | 8 | **8.5** | The title tagline is now a readable plate (04). The flash notice (01) and clear-space check (02) look like shipped product. Results are premium (24). One frame at title→run shows the title, the HUD and SKIP INTRO stacked on top of each other (05). |
| 10 | Colour/lighting per act | 5 | 7 | **8** | Amber dusk → moonlit teal/magenta → violet night → boss eclipse is now a clear progression (13, 14). The act-change front cuts hide the re-grade well. |
| 11 | Performance feel | 8 | 8.5 | **9** | The dead air after the Awakening finale is gone: the ACT 1 banner lands on the blast tail (09 frames 134→135). 60 fps throughout. |
| 12 | Signature CV features | — | 6.5 | **8** | Echo: from a 4 to an **8**, a neon contour hologram with scanlines and a rising sweep in, placed as a "spirit ally" left of the Warden (18; lab boss preset overlap = 0). Mirror pour: from a 5 to an **8**, no grey panel, particles stream into the hero, and a ground ring lands on arrival (26). Booth: the countdown is beside the hero now and the card is still a 9 (28). Open: the echo over the HUD, and the flat arrival glow. |

**Overall: 5.3 → 7.3 → 7.9 / 10.**

---

## 2. Round-2 items: fixed vs open

| R2 ID | Item | Status | Evidence |
|---|---|---|---|
| P0-1 | Echo pasted over the Warden | **Fixed.** In the boss state the echo stands left of the Warden as an ally and never touches the head or chest. The lab reports a `boss` preset with `overlap: 0` and keep-outs for the rift and the hero. | 18, 19, 28 |
| P1-1 | Prompts on the hero's legs | **Mostly fixed.** Plates sit beside the hero at chest height and swap sides away from threats. **Still broken for the wide HANDS UP – CHARGE / KEEP THEM UP plate.** It does not fit beside the hero, lands on the torso, and double-exposes with PUSH! (see new P1-1). | 07, 15, 16 vs 10 |
| P1-2 | Echo looked like a flat mannequin, cropped, over the portal | **Fixed** in look and portal clearance. **New:** in acts 2 and 3 its raised arms cover the Overdrive meter and "SHOWCASE · NO-FAIL", and its hands touch the top edge (new P1-2). | 08, 11, 12 |
| P1-3 | Mirror pour in a grey panel | **Fixed.** The silhouette streams along a curve into the hero, then a rim glow and a ground ring. The lab and the game now agree (title pour 03). The arrival glow is flat (P2). | 03, 26, 27 |
| P1-4 | Booth "null", headline, toast, countdown on the chest | **(a)** Fixed in code (`ui/screens.js:627` now filters falsy children). **(d)** Fixed: the countdown sits beside the hero (28). **(b)(c)** not verifiable headless, because the in-game booth now arms only with a real camera (`core/game.js:689`). Check them on the showcase rig. | 28 |
| P1-5 | Blast and kill white-out | **Fixed.** No frame exceeds a readable exposure. The Warden shatters into shards and an eclipse orb (21). `reduceFlashes=1` looks the same minus the hit flashes (25). | 09, 21, 25 |
| P2-1 | Prompt entrance ghost | **Fixed** for single prompts. **New** cross-swap double exposure (P1-1). | 10 |
| P2-2 | HUD crystal over the combo | **Fixed.** Not seen. | 19 |
| P2-3 | Boss has no face | **Fixed.** Visor eyes, red on telegraphs. | 18, 19 |
| P2-4 | Trees in the boss sightline | **Partly fixed.** Trees are dithered or pushed out. Floating islands still cross the echo's legs and the Warden's left arm. | 18 |
| P2-5 | Act 2 mono-pink | **Fixed.** Moonlit teal canopies against a magenta horizon. | 11, 13, 15 |
| P2-6 | Replay camera | **Partly fixed.** The new side kill shot is good from mid-replay onwards. Open: the opening frame crops the Warden and hides the hero's head behind his own arm, and there is no "YOU · 0.35×" skeleton inset in the game replay. The reticle in the letterbox is gone. | 22, 23 |
| P2-7 | Dead air after the Awakening | **Fixed.** | 09 |
| P2-8 | Title tagline | **Fixed.** A pill plate with a sub-line. | 04 |
| P2-9 | Greybox trees and waterfalls | **Open.** Polished slightly, still primitive. | 15, 16 |
| P2-10 | Boss barrage stars | **Partly fixed.** Impacts now land off the hero. They are still large flat yellow 4-point stars. | 20 |

Not counted as defects (debug-path artefacts):
- Entering the tutorial via `bl.setState('tutorial')` from a running game leaves the gameplay HUD over the drill list. The clean title → tutorial path is correct (29).
- Forcing `results` with no run produces a "REPLAY · REPLAY" tag.

---

## 3. Remaining defects

### P0: breaks the showcase
None.

### P1: hurts the wow

| ID | Moment | Problem | Concrete fix | Owner / files |
|---|---|---|---|---|
| P1-1 | **Every Breaklight blast**: the Awakening finale, each act-end blast and each boss WEAK POINT. Reproduced in 3 of 3 runs (10; 09 frame 132; 21 frame 176; 25 frame 54). | (a) When HANDS UP – CHARGE / KEEP THEM UP… turns into PUSH!, the outgoing plate is still fully visible under the new one, giving "KE·PUSH!·M UP…" and "HAND·PUSH!·HARGE!". (b) The charge plate carries a long sub-line ("Your Breaklight: both hands up, then push!"), so it is wider than the room beside the hero. `placePrompt` picks the lowest cost, which is centred on the hero's torso, right where the arms-up charge pose should read. This is the signature move, at the climax of every act. | (a) On a low-lane swap, remove the outgoing node immediately, or fade it within 80 ms before the new plate enters; never stack two plates in `lanes.low`. (b) If no beside-hero candidate is clean (`p.clean === false`), drop the sub-line, or use the above-head candidate. Better still, make the charge prompt glyph-only ("✋✋ CHARGE"). (c) Add the judgement pop rect to `keepOuts()` so PERFECT never crosses the plate (12, 07 frame 99). | UI `ui/hud.js` (`placePrompt`, `placeLowLane`, low-lane swap in `prompt()`), `game.css` (`.bl-prompt` exit); CORE `core/game.js` (charge prompt copy) |
| P1-2 | Overdrive echo in acts 2 and 3 (11, 12; 16 frames 126, 198) | The echo slot is upper-left, the same column as the hearts, Overdrive meter and mode tag. When the player raises their arms (jump or charge) the hologram's hands cross the meter and "SHOWCASE · NO-FAIL", and touch the frame top at 1440. The audience loses the Overdrive ×2 readout exactly while Overdrive is on. | Add the HUD rects (vitals, combo) to the echo preset's `keepOut` list, as is already done for the rift and hero, and reserve vertical headroom for raised arms. Cap the figure so the bounding box with arms up stays below about 14% from the top, or anchor the slot to the right of the HUD column (x ≈ 0.18–0.40). The boss preset already does this well (18), so match it. | CV `cv/echo.js` (preset slots, keep-outs, arms-up height); CORE `core/game.js` (`ECHO_PLACE` fallback) |

### P2: polish

| ID | Moment | Problem → fix | Owner |
|---|---|---|---|
| P2-1 | Blast cinematic (09 frame 134, 13 frame 194, 14 frame 260) | The hero stands in guard while the beam fires past his chest, so the beam has no source. Under the autoplay or demo tracker (any showcase stand without a camera) this is what everyone sees. Blend a "push" arm override on the hero (palms forward, beam origin at the hands) for the 1.2 s cinematic, whatever the tracked pose. | CORE `core/game.js` (blast cinematic); VISUAL hero pose override; autoplay bot in `main.js` |
| P2-2 | Replay opening (22) | A low Dutch side shot: the Warden is half off frame-left, and the hero's head is hidden behind his raised arm and cut at frame-right. Frame on thirds, with the Warden's core at the left third and the hero's full body at the right third. Add the "YOU · 0.35×" skeleton inset (the cv-lab version, 28) so the "rebuilt from your poses" claim is visible. | CORE `core/camera.js` (`SHOTS.replayKill`), `core/game.js` replay |
| P2-3 | Title → run, clear-space → run (05; 02 sheet frame 3) | For one frame the title logo, menu, hearts, score and SKIP INTRO all sit on top of each other (SKIP INTRO over PLAY). The "CLEAR 2×2 m" headline ghosts over the sky for about 0.5 s. Fade screens out before the HUD fades in (a 150 ms gap), or hard-hide on state exit. | UI `ui/screens.js`, `ui/index.js` |
| P2-4 | Pour arrival (27) | The hero turns into a flat translucent yellow body with a hard horizontal band across the chest, which reads as a shader bug. Use a fresnel rim plus emissive pulse on the hero material, and drop the band, or feather it into a scanline sweep. | CV `cv/pour.js` |
| P2-5 | Tutorial feedback (30) | SHARP! / GREAT!, its sub-line ("1.8 m/s left · snap it faster") and DRILL CLEAR all print over each other above the hero's head. Same in R2. Queue DRILL CLEAR 400 ms after the grade, or stack it below. | UI `ui/screens.js` / tutorial HUD, `game.css` |
| P2-6 | Boss barrage (20) | Still large flat yellow 4-point stars. Shrink by about 30%, add a hot core and trail (R2 P2-10). | VISUAL `visual/boss.js` |
| P2-7 | Props (15, 16) | Trees are sphere clusters and waterfalls are flat strips. This is the main 8 → 9 gap since R1: a toon ramp plus painted canopy normals, and scrolling noise plus foam for the falls. | VISUAL `visual/stage.js` |
| P2-8 | Boss staging (18, 19) | The idle pose is static between attacks; add a slow breathing or shoulder heave. Foreground floating islands cut across the echo's legs and the Warden's left arm, so push them below the horizon in the boss act. | VISUAL `visual/boss.js`, `visual/stage.js` |
| P2-9 | Tracker inset (11, 05) | Under autoplay the "DEMO PLAYER" inset shows "24 fps · 45 ms" (and "0 fps" on the first frame). The arms-up skeleton crosses the label. Hide the stats for the synthetic source, and pad the skeleton box. | UI `ui/hud.js` (pip) |

---

## 4. Top improvements (by leverage)

1. **Fix the charge → push prompt (P1-1).** It is a few lines in the low lane, and it shows at the climax of every act and the boss weak point. Right now the signature Breaklight looks buggy for about 0.5 s every time.
2. **Keep the echo out of the HUD column (P1-2).** The hologram itself is now good. Give it the same keep-out treatment the boss preset already has.
3. **Make the hero push on the blast (P2-1).** Beam from the palms. It completes the best two-shot in the game.
4. **Re-frame the replay opening and add the YOU inset (P2-2).** This is the "rebuilt from your tracked poses" proof shot.
5. **Do a props pass (P2-7).** This is what moves the score from 8 to 9.

---

## 5. Verdict against "wows at a tech demo / publisher showcase"

**Yes. This is ready to show at a tech demo and at a publisher showcase.** Fix P1-1 before a publisher meeting; it is about a day of UI work. P1-2 is strongly recommended.

Round 3 closes everything that read as prototype in round 2:
- The echo is now a neon spirit ally beside the Warden instead of a sticker on it.
- The pour visibly flows into the hero, and the calibration → title pour is a genuine wow beat.
- The climax no longer burns to white: the Warden shatters into crystal with the hero silhouetted in front.
- Act 2 has its own palette, and the kiosk flow (flash notice → calibrate → title → safety check) looks like a shipped product.

There are no P0s left. The remaining P1s are both composition collisions at specific beats, not missing art.

---

## Evidence index (`docs/game/qa-art-r3/`)

| Topic | Images |
|---|---|
| Kiosk / screens | 01 flash notice · 02 clear-space · 03 calibrate → title pour sheet · 04 title (kiosk) · 05 title → run overlap frame · 29 tutorial (clean path) · 30 tutorial feedback stack |
| Awakening / act 0 | 06, 07 Awakening sheets · 08 Overdrive echo + front cut · 09 finale blast sheet (no white-out, no dead air) · 10 prompt double exposure on the hero |
| Acts | 11 act 2 echo over the HUD · 12 act 3 echo over the HUD + PERFECT on the prompt (1080p) · 13 act 1 → 2 transition · 14 act 2 → 3 transition · 15 act 2 sheet (1080p) · 16 act 3 sheet (1080p) |
| Boss | 17 intro sheet · 18 echo as ally + visor eyes · 19 fight sheet · 20 barrage stars · 21 kill shatter sheet · 25 kill with reduce-flashes |
| Replay / results | 22 replay opening frame · 23 replay → results sheet · 24 results (1080p) |
| CV lab | 26 pour sheet · 27 pour arrival glow · 28 echo (act + boss preset), replay inset, booth countdown, card |
