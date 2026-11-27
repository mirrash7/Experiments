# BREAKLIGHT: design QA, round 2

Reviewer's lens: the same motion-controlled games designer who wrote `qa-design-r1.md` (Kinect, VR, rhythm and fitness titles).
Build reviewed: `06b5bb5` ("BREAKLIGHT fix round 1"). Round 1 reviewed `cf49ca1`.

## Method

**Read:**
- `docs/game/qa-design-r1.md`, `docs/game/GDD.md`, `git log -3`;
- `web/src/game/core/*`, `web/src/game/ui/*`, `web/src/game/cv/*`;
- `web/src/actions.js`, `web/src/motion/triggerTest.js`, `web/src/motion/moveBench.js`.

**Ran.** Everything ran on my own Vite (port 5242, HMR off) and headless Chrome (CDP port 9442) with a fresh profile. Both are shut down.

| Probe | Result |
|---|---|
| `node web/src/motion/triggerTest.js` | PASS. 4824 moves, **0.37 phantoms per 100 moves**, 0 between moves. Punch hit rate 99.2–100 %, median detection delay 88–97 ms. Kick 100 % (167 ms), jump 100 % (341 ms), duck 100 % (230 ms), head-only duck 100 % (254 ms), dodge 100 % (165 ms), charge 100 %, clipped charge 100 %. Phantoms: guard raise → punch 9/360, kick → punch 3/432. |
| First run on a fresh profile, `?autoplay=1&botSkill=0.85&seed=7` | Awakening ~60 s → Acts 1–3 → boss → results. **Cleared and the Warden was defeated with 0 knockdowns.** Hearts never dropped below 3. 152 P / 2 G / 0 Good / 28 M, rank A, NEW BEST set. **5 min 9 s of play** before results. 26 kicks in the run. Boss: 4 cycles (one weak point missed). |
| `?mode=challenge&awaken=0`, same bot | **Dead at 70 s** (start of Act 2), 35 P / 5 M. That is the same curve as round 1. |
| `?skip=boss&botSkill=0.6` | Defeated in **117 s** with 3 knockdowns, 5 cycles and 2 missed weak points. The boss never soft-locks. |
| Offline chart census (`ActChart`, 20 seeds × skill 0.5 / 0.75 / 0.95, full / upper / seated) | See the table below. |

**Limits.** There is still no real webcam here. Every detector number comes from `moveBench.js`, a synthetic generator written alongside the detector it tests. Human-experience claims are reasoned from:
- the code;
- 40–75 ms camera latency, MediaPipe and InstantHMR noise;
- 350–450 ms choice reaction time;
- a 2–2.5 m room, and fatigue over a 5–7 minute session.

### Chart census (notes per act, 20 seeds)

| Mode, skill | Act 1 | Act 2 | Act 3 | Striker share | Notes |
|---|---|---|---|---|---|
| Full, 0.5 | 23 (29/min) | 23 (28/min) | 37 (46/min) | 25–35 % | crawlers 7.0 in Act 1 |
| Full, 0.95 | 29 (36/min) | 28 (34/min) | 47 (58/min) | 32–38 % | **crawlers 10.6 in Act 1 (36 %)** |
| Upper body, 0.95 | 27 | 27 | 48 | 36–40 % | volleys 43 % in Act 3 |
| Seated, 0.95 | 27 | 27 | 48 | 36–40 % | **volleys 52 % in Act 3**, no duck |

- Every act has 1 Spirit Core, and Acts 2 and 3 have 1.6–3 brutes.
- Awakening: 18 notes with 8 waits, 53 s nominal (39 s in upper-body mode, 33 s seated).

---

## Scored rubric: round 1 → round 2

| Area | R1 | R2 | One-line why |
|---|---|---|---|
| Onboarding (first 60 s) | 5 | **7** | Act 0 Awakening is the right design: real spirits that wait for you, on the music, using the gameplay detectors. But a waiting spirit never gives up or offers help, it runs once per browser profile, and the clear-space screen continues by itself. |
| CV "wow" | 6 | **8** | The Mirror Moment silhouette that pours into the hero, the Overdrive sky echo (visible in run frames), the "YOU 0.35×" replay inset and the Photo Booth together turn the CV into the show. The booth fires on top of the replay, and the replay frames the hero small and from behind. |
| Controls reliability | 6 | **7** | The 2-of-3-cue punch, head-drop duck and elbows-up hands-up are real improvements, and the bench is excellent. But it is synthetic only, the lean gate can eat dodge→counter punches, and kicks are now a third of Act 1. |
| Cue readability | 6 | **7.5** | Prompts sit in a low lane beside the hero, there are ground cues and a 2-beat minimum for slow moves, and only one message shows per lane. Still missing: the audio hazard call and a hand glyph on strikers (they get no prompt after Act 0). |
| Fairness | 5 | **7.5** | The no-fail economy, the deferred and same-limb wrong-move rule, the held-move Perfect window and a boss that loops with longer windows are all fixed. Challenge is still round 1's economy. |
| Fun / core loop | 6 | **7** | Teaching phrases, "phrases with intent" (dodge→counter, duck→double jab, jump→kicks) and a Breaklight every act make it a fuller body game. Acts 1–2 are now sparse at ~30 notes/min. |
| Pacing / difficulty | 4 | **6.5** | Mechanics arrive in order and the signature blast lands by ~0:50 of Act 1. But Act 2 is no denser than Act 1, there is no breather before the boss, and a session is 6–7 minutes per stranger. |
| Boss | 5 | **7.5** | Three distinct phases (measured ~29 → 34 → 52 notes/min), the Warden's fist used as a brute, longer windows after a miss, never binary. The beam-struggle finale (round 1 P1-7) is still missing. |
| Juice / feedback | 7 | **7.5** | Clamped judgements, EARLY/LATE tags and lanes declutter peak moments. A knockdown is completely silent. |
| Replayability | 4 | **5.5** | Persistent bests per mode, NEW BEST, Showcase/Challenge, seated/upper keys and a whole-run best replay. Still one song and one stage, and nothing to unlock. |
| Accessibility / safety | 4 | **6** | A seated mode, an upper-body mode that also drops ducks for seated play, and a clear-space screen. Still missing: a flash warning or reduce-flash option, a pause pose, and knee strikes. Kicks toward the screen *increased*. |

**Overall: 5.3 → 7.0 / 10.**

---

## Round 1 issues: verified fixed, partial or regressed

| R1 item | Status | Evidence |
|---|---|---|
| P0-1 Health economy | **Fixed** | `score.js` `ECONOMY.showcase`: hazards only, +1 heart per 8 hits, a knockdown instead of death. Bot at 85 %: 0 knockdowns, cleared. Bot at 60 % on the boss: 3 knockdowns, won. |
| P0-2 Wrong-move penalty | **Fixed** | `wrongMovePenalty: false` by default. When enabled it only *flags* a note (`wrongTry`), and only within the same limb class. |
| P0-3 Binary boss | **Fixed** | `boss.js` repeats a phase variant until 3 blasts. Weak-point windows are 6/7/8 beats, +2 per miss, capped at 14. Showcase never retreats; Challenge retreats at 100 s. Hands-up also works from raised elbows with clipped wrists (`handsUpAlt`, `actions.js handConf`). The bench's clipped-charge case is 100 %. |
| P0-4 Guided first minute | **Fixed, with a new P0** | `_updateAwaken` freezes the virtual beat at the hit point and resolves with the gameplay detectors. Upper-body and seated mode drop sections. Bot: 60 s. See R2 P0-1 for the soft-lock. |
| P1-1 Punch on the depth axis | **Fixed (synthetic only)** | Elbow extension + 2D foreshortening + weak depth vote, with noise normalisation and one-frame confirmation. Bench: 99–100 %, ~90 ms median. |
| P1-2 Duck from the hips only | **Fixed** | Head or shoulder drop > 0.3 torso with a fast-drop gate. Head-only duck is 100 % on the bench. |
| P1-3 Pre-held Perfect, ms readouts | **Fixed** | `HELD_EARLY_MS = 250` (an earlier entry scores Great; the judge log shows a "great brute −1991 ms"). ms only appear with `?debug=1`; otherwise EARLY/LATE tags. |
| P1-4 Distance warnings during big moves | **Mostly fixed** | Suppressed for hands-up, charge, jump, kick and duck, plus 600 ms afterwards, with a 1 s persistence rule and priority lanes in the HUD. `body.js measureDistance` still boxes *all* keypoints, wrists included (see P2). |
| P1-5 Cue placement and lead time | **Partial** | Low lane beside the hero, a 2-beat minimum for jump/duck/guard/blast, `vfx.groundCue`. **No audio call stab, no striker hand glyph.** |
| P1-6 Chart variety | **Fixed, two regressions** | Teaching phrases open every act, there is a finale core every act, and strikers are 25–40 %. But the cap turns strikers into **crawlers** (R2 P1-2), and density fell (R2 P1-3). |
| P1-7 Copy-paste boss | **Mostly fixed** | Three phases, two variants each. No beam struggle. |
| P1-8 Safety and space | **Partial** | Clear-space screen and seated toggle added. Knee or side kicks, the flash warning, the reduce-flash toggle and the pause pose are **not done**. |
| P1-9 Seated mode | **Fixed** | Seated calibration, no legs, scythe → volley, head-drop duck rules in the detector. |
| P1-10 Replay and stats | **Fixed** | Whole-run best window plus a pinned boss kill, reaction tiers re-scaled (317 ms = "Lightning"), timing ±SD and move-mix bar. The "fastest punch" metric is wrong (see P2). |
| P2-1 Calibration silhouette | **Fixed** | The live segmented neon silhouette sits inside the guide and pours into the hero. |
| P2-3 Volume object | **Fixed** | `audioVolume()`, steppers per channel. |
| P2-4 NEW BEST | **Fixed** | `submitBest` per mode, difficulty and seated/upper. Verified on screen. |
| P2-6 Results hand cursor | **Fixed** | `data-ui-nopunch` plus 1.0–1.2 s dwell on REPLAY / PLAY AGAIN / TITLE. |
| P2-5 Overdrive pose, P2-8 act breather, P2-9 pre-boss groove | **Not done** | Act 3's finale core runs straight into the boss intro. |
| P2-2 Tracker auto-pick, P2-7 reaction flash | Not verified | Not exercised by the headless runs. |

### Regressions introduced by round 1

1. **Kicks went up, not down.** `chart.js _emit` turns over-cap strikers into crawlers.
   - Act 1 is now 30–36 % front kicks (7–10.6 per act), and the bot run threw **26 kicks**.
   - Round 1 asked for fewer screen-directed kicks and for knee strikes.
2. **Acts 1–2 got thin.**
   - Round 1 measured 42–68 notes/min. Now Act 1 is 29–36/min and **Act 2 is 28–34/min, lower than Act 1**.
   - Teaching phrases, recoveries and the reaction rest eat the 26-bar act.
3. **The session got long.** Awakening (53 s nominal, ~75–90 s for a real first-timer), 3 × 49 s acts with transitions, a 60–120 s boss, then the replay and results. That is **6–7 minutes per stranger**, about 5:10 of play for the bot.
4. **Persisted flags now hide the best part.** `flags.awakened` and `flags.spaceChecked` live in localStorage, so at a meetup only the *first* stranger gets the Awakening and the safety screen (R2 P0-2).
5. **The Photo Booth collides with the replay.** It is armed the moment results start and draws over the boss-kill replay (R2 P1-5).

---

## Remaining issues

### P0: must happen before a public demo

**P0-1. An Awakening wait can soft-lock the game.**
- **Evidence:**
  - `_updateAwaken` holds the field until the move is detected.
  - `A.waitSince` is set and **never read**, and nothing in `ui/`, `visual/` or `audio/` listens to the `awaken` bus events.
  - The only exits are the mouse-only SKIP button and the Enter/S keys.
- **What a real player hits:**
  - A first-timer whose kick doesn't register (ankles at confidence < 0.4 near the frame edge, a low "polite" kick under the 0.45-torso lift, socks on a slippery floor) stands there with the music ducked to 0.12 and the same prompt, forever.
  - The same goes for a duck that is too slow for the `duckSpeed` gate, or a charge with the elbows not high enough.
  - At 2.5 m they can't reach the mouse.
- **Fix: escalate on `performance.now() − waitSince`:**
  - **At 5 s,** move-specific coaching in the prompt `sub`, driven by live detector state:
    - kick: "lift your knee higher", from `kickLeft` lift vs threshold;
    - duck: "drop faster, bend your knees";
    - charge: "elbows above your shoulders", from `handsUpConfidence`;
    - punch: from `stats.punchNearMiss`.
  - **At 10 s,** accept a looser version: any punch for a striker, any kick or knee-up (`legUp`) for a crawler, `squat` from the hip drop alone, half-charge plus push.
  - **At 15 s,** resolve as Good with "Let's keep going!" and record it, so the spirit does not appear in that act's teach phrase.
  - Add a hand-cursor "SKIP" that appears after 15 s, dwell 1.5 s, `data-ui-nopunch`.
- **Owner:** CORE (`core/game.js` `_updateAwaken`, `_updatePrompt`); UI (`ui/hud.js` coaching sub-line); lead (`actions.js`, expose near-miss reasons per move).

**P0-2. There is no "new player" flow for a shared machine.**
- **Evidence.** These all persist in localStorage:
  - `flags.awakened` (set even when skipped or quit, via `_endAwaken` in `_exit`);
  - `flags.spaceChecked`;
  - `settings.mode`;
  - `settings.seated` and `upperBodyOnly`;
  - bests.
- **Consequences:**
  - The second stranger at a meetup skips the Awakening and the safety screen.
  - If the previous player chose Challenge, the next one dies at ~70 s (bot run 2).
  - If the previous player sat down, the next one plays seated.
- **Fix:**
  - (a) Add `?kiosk=1`. After results, or 45 s idle on title with nobody tracked, reset the flags, mode = Showcase, seated = off, and recalibrate.
  - (b) Add a **NEW PLAYER** button on the title (hand dwell 1.2 s) that does the same.
  - (c) Show "Today's best" on the title from a session leaderboard instead of only the personal best.
  - (d) Keep `awakened` per session, not forever, in kiosk mode.
- **Owner:** CORE (`core/settings.js` `flags`, `loadSettings`; `core/game.js` title idle); UI (`ui/screens.js` title).

**P0-3. There is no real-webcam evidence yet.**
- **Evidence:**
  - 0.37 phantoms per 100 moves and ~100 % hit rates come from `moveBench.js`. Its synthetic moves, noise model and guard poses were written next to the thresholds they validate.
  - The bot plays with learned per-move delays and SD ≈ 25 ms timing, so its runs are almost all Perfect. A human's real spread will be 60–100 ms.
  - Nothing has measured:
    - how real MediaPipe wrists behave in a cross punch;
    - how InstantHMR depth behaves on a hook;
    - how a tall player in a 2.2 m room is framed.
- **Fix:** before any public demo, run a **5–10 person hallway playtest** (laptop webcam, 2–2.5 m, mixed heights, one seated) with `?debug=1` logging. Use `motion-lab` to record their raw tracker streams with move labels, and replay the recordings through `moveBench`-style metrics as a regression set. Pass bar:
  - ≥ 90 % of intended punches register;
  - ≤ 1 phantom per minute;
  - median Awakening ≤ 90 s with no wait over 15 s;
  - every tester reaches the boss.
- **Owner:** lead (`web/src/motion/*` recording plus replay bench); CORE (debug logging of Awakening waits, near-misses and knockdowns).

### P1: strongly affects quality or fairness

**P1-1. The lean gate can swallow the dodge→counter punches the chart now teaches.**
- **Evidence:**
  - `actions.js` drops punch candidates while `tiltSpeed > 1.6 rad/s`.
  - Returning from a 0.3–0.5 rad lean in ~250 ms is 1.2–2.0 rad/s.
  - The chart asks for exactly that punch:
    - Act 2 opening phrases `VL . . .` / `SR . . .`;
    - Act 3 `VR . SL SR VL . SR SL?`, a punch 1 beat (470 ms) after a dodge;
    - boss phases 2 and 3.
  - Bot run 1 already logged `suppressed.lean: 3`.
  - The bench never tests a lean followed by a punch.
- **Fix:**
  - Gate only while |tilt| is *increasing* (leaning out), or raise the gate to ~2.5 rad/s when tilt is heading back toward vertical.
  - Add `dodgeCounter` and `duckJab` sequences to `moveBench.js`.
- **Owner:** lead (`web/src/actions.js`, `web/src/motion/moveBench.js`).

**P1-2. Front kicks are a third of Act 1 because of the striker cap.**
- **Evidence:**
  - `_emit` converts over-cap fixed strikers into `crawler` in full-body mode.
  - The census shows 7–10.6 crawlers in Act 1 (30–36 %), and the bot threw 26 kicks per run.
  - Kicks are aimed at the screen, are the most tiring move, and have the lowest detector margin for short or polite kicks.
- **Fix:**
  - Convert over-cap strikers to a rest, a volley with the opposite side, or (Act 1) a duck.
  - Cap crawlers at ~20 %.
  - Ship the round 1 knee strike: accept `legUp` with the knee above hip −0.1 torso as a crawler hit, and re-skin the crawler hit as a stomp or knee.
- **Owner:** CORE (`core/chart.js` `_emit`, `STRIKER_CAP` logic); lead (`actions.js` knee strike).

**P1-3. The density curve dips in Act 2.**
- **Evidence:** Act 1 runs 29–36/min, Act 2 28–34/min, Act 3 46–58/min. Act 2 has the most new mechanics but feels like a lull, and the jump to Act 3 is steep (+60 %).
- **Fix:**
  - Act 2: shorten the teaching block to 6 bars and add two d2/d3 phrases with off-beat jabs (still quarter-snapped), aiming for ~40/min.
  - Act 1: keep ~32/min.
  - Act 3: trim the d3 phrases so it lands at ~50/min.
- **Owner:** CORE (`core/chart.js` `ACTS`).

**P1-4. The session is too long for a demo queue.**
- **Evidence:** a first run is Awakening (~75–90 s for a human) + 3 × ~50 s acts + transitions + a 60–120 s boss + ~15 s of replay = **6–7 min**. Fatigue peaks exactly when the boss starts, because there is no pre-boss breather (round 1 P2-9 is open).
- **Fix:**
  - A Showcase "demo cut": Awakening → Act 1 (18 bars) → Act 3 (18 bars) → boss. About 4 min, every mechanic and every CV moment kept.
  - Add a 4-bar guard-and-lean groove plus the hero taunt before the boss.
  - Keep the full run in Challenge.
- **Owner:** CORE (`core/game.js` `_updateRun`, `core/chart.js` per-mode `bars`).

**P1-5. The Photo Booth fires over the replay, the best CV moment.**
- **Evidence:**
  - `_showResultsScreen` runs immediately on results (real UI path) and calls `booth.arm({ timeoutMs: 15000 })`.
  - The booth's full-screen overlay (z-index 80: "STRIKE YOUR VICTORY POSE", the hold ring, a 3-2-1, then a **full-screen white flash**) plays during the 8.3 s letterboxed boss-kill replay.
  - Meanwhile the results panel's photo slot is hidden by `inert` during the replay.
  - Players naturally raise their arms right after the kill, so the booth may trigger mid-replay without the player seeing the prompt.
- **Fix:**
  - Either (a) arm the booth on the replay `end` / `showStats`;
  - or, better, (b) make the victory pose the *beat between the kill and the replay*: "WARDEN DEFEATED – STRIKE YOUR VICTORY POSE", the hero turns to face the camera, capture, then the replay.
  - Replace the white flash with a soft gold vignette, respecting the reduce-flash setting.
- **Owner:** CORE (`core/game.js` `_startResults` / `_showResultsScreen`); CV (`cv/photobooth.js`).

**P1-6. Safety gaps that a public demo has to close.**
- **Evidence:**
  - No photosensitivity notice and no reduce-flash option: grep finds nothing. The blast bloom, Perfect blooms, boss-kill bloom 1.0 and booth white flash are always on.
  - `clearSpaceScreen` auto-continues after 2.5 s framed, so nobody reads it, and it shows once per profile.
  - There is no pause pose: pausing needs Esc or leaving the frame.
- **Fix:**
  - A one-line flash notice on boot or space.
  - A `reduceFlashes` setting that caps `game.bloom()` adds at 0.2 and swaps the booth flash.
  - Clear-space continues only on "I'M CLEAR" (dwell) the first time per session, and auto-continues on later runs.
  - An X-arms pause pose held 1 s.
- **Owner:** UI (`ui/screens.js`); CORE (`core/game.js` `bloom`, settings); lead (`actions.js` X-pose).

**P1-7. Knockdowns are silent.**
- **Evidence:** `Score._knockdown` emits `knockdown`, and nobody listens to it. Combo, multiplier, Flow and Overdrive vanish while the hearts jump back to half, with no explanation (3 knockdowns in the 60 % boss run).
- **Fix:**
  - "KNOCKED DOWN – shake it off!" in the top lane, a hero stagger plus `requestExpression('hurt')`, a muffled-music beat, and 1 bar with no hazards.
  - In Showcase, consider showing hearts as a "shield" so it is clear they never end the run.
- **Owner:** UI (`ui/hud.js`); VISUAL; AUDIO; CORE (a short grace window in `game.js`).

**P1-8. The boss-kill replay doesn't show *you*.**
- **Evidence:** the replay frame (`run1/results_a`) shows the hero small at the left edge, back to camera, with the boss filling the frame. The caption says "Rebuilt from your tracked poses", but the poses are barely visible. The weak-point gameplay camera also crops the charging hero at the bottom-left of the frame.
- **Fix:**
  - The `bossKill` replay shot: a front 3/4 on the hero at chest height with the boss as backdrop, and a slow dolly, so arms and push are readable.
  - Weak-point gameplay: pull the hero into the lower-third centre while charging.
- **Owner:** CAMERA (`core/camera.js` `SHOTS.bossKill`, the boss weak-point framing).

### P2: polish

- **P2-1. "Fastest punch" is not punch speed.**
  - `info.speed = dExt × armLen / dt` is the *elbow-extension rate*. Players see 1.6–1.8 m/s and "Warming up", while a real fist travels at 3–7 m/s.
  - Use the lifted wrist velocity (2D plus lifted depth) over the punch window, or rename it "Arm snap" with re-tiered labels.
  - Owner: lead (`actions.js`); UI (`ui/screens.js` tiers).
- **P2-2. `measureDistance` still boxes every keypoint, wrists included.** The move gating covers most cases, but a wide hook or a T-pose in the boss intro can still flag "off-left / too close". Use shoulders, hips and ankles only, as round 1 suggested. Owner: UI (`ui/body.js`).
- **P2-3. Seated mode is 50 % leans in Act 3 and has no duck,** although the detector supports a seated head-drop duck. Restore scythe as a "head bob" in seated mode and add more guards. Owner: CORE (`core/chart.js` `upperOnly`, `boss.js _note`).
- **P2-4. The reaction-test prompt names a hand,** "LEFT PUNCH NOW!", but either hand scores (`wrongMovePenalty` off). Either say "PUNCH NOW!" or require the side. Owner: CORE (`game.js` `_updatePrompt`, `_onAction`).
- **P2-5. Challenge is round 1's economy unchanged** (dead at 70 s at 85 % skill). Fine as a hard mode, but add the planned middle ground: regen every 12 hits, fail on. The toggle text "Hearts can run out" undersells it. Owner: CORE (`score.js ECONOMY`); UI (`screens.js MODES`).
- **P2-6. Showcase rank after a win.** Defeating the Warden at 56 % accuracy shows a C stamp. In Showcase, rank the clear (e.g. "WARDEN BREAKER") alongside the letter. Owner: CORE (`score.js rank`); UI (results).
- **P2-7. Round 1 ideas still open:**
  - the audio hazard call stab one beat before jump/duck/volley;
  - a striker L/R fist glyph;
  - the Overdrive power pose;
  - the post-calibration latency badge ("52 ms camera→screen, compensated");
  - a 1-bar act-transition breather.
- **P2-8. Photo Booth sharing.** A PNG saved to the demo machine's Downloads does nothing for a stranger. Show a QR code for a LAN or `blob` hand-off (still local, nothing uploaded) or a "scan to keep" page. Owner: CV (`cv/photobooth.js`, `cv/card.js`).

---

## Top 5 remaining improvements

1. **Make the Awakening un-stuckable** (P0-1). Escalate coaching at 5 s, a looser match at 10 s, auto-advance at 15 s, a hand-cursor skip. This is now the single highest-risk moment, because every new player passes through it.
2. **Kiosk / "new player" mode** (P0-2). Reset the Awakening, safety, mode and seated flags per player, and show "today's best". Without it, the round 1 onboarding work reaches only the first person at the event.
3. **A real-human playtest plus a recorded regression set** (P0-3), including the dodge→counter and duck→jab sequences (P1-1). Turn the synthetic 0.37/100 into a real number before strangers see it.
4. **A demo-length Showcase run with a fuller middle** (P1-3, P1-4, P1-2). About 4 minutes, Act 2 at ~40 notes/min, kicks under 20 % with a knee-strike option, and a breather before the boss.
5. **Choreograph the ending around the player** (P1-5, P1-8, P1-7):
   - kill → "strike your victory pose" with the hero facing you → photo → a hero-centric replay with the YOU inset → stats;
   - in Showcase, knockdowns are announced, not silent.

## Verdict

**Not yet ready for an unattended public demo; ready for a hosted one (a developer at the keyboard) once P0-1 and P0-2 land.**

Round 1 fixed what it set out to fix:
- nobody dies in Showcase;
- the boss always ends in a kill;
- the first minute teaches with real spirits;
- the CV layer is now the star (Mirror Moment, echo, YOU inset, Photo Booth).

The rubric moves from 5.3 to 7.0, and the game now has a beginning, middle and end a stranger can finish.

**Before a public demo, three things must happen:**
1. The Awakening must be unable to soft-lock (P0-1).
2. The game must reset itself for each new player (P0-2).
3. Five to ten real people must play it on a laptop webcam, with the detector numbers re-measured on their recorded streams (P0-3).

Then do P1-5 (booth vs replay) and P1-6 (flash notice, readable safety screen), because they are visible to every player and cheap to fix. The rest of the P1s are what take it from "good demo" to "the demo people film".
