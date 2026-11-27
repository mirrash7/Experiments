# BREAKLIGHT: design QA, round 1

Reviewer's lens: a motion-controlled games designer (Kinect, VR, rhythm and fitness titles).
Build reviewed: `cf49ca1` ("BREAKLIGHT: playable webcam rhythm-combat game, first build").

## Method

**Read:**
- `docs/game/GDD.md` and `docs/game/CONTRACTS.md`;
- `web/src/game/core/*`, `web/src/game/ui/*`;
- `web/src/actions.js`, `web/src/motion/*`;
- the audio clock.

**Ran, in headless Chrome on CDP port 9412:**
- `?tracker=demo&debug=1`: boot and calibration.
- `?autoplay=1&botSkill=0.93&debug=1&skip=title`: a full run; it failed in Act 2.
- `?skip=boss&autoplay=1&botSkill=0.93` with 99 hearts set in this profile's localStorage only: the boss, results and replay.
- An offline chart census (`ActChart` at skill 0.4 / 0.7 / 0.95, full body and upper body only).
- A detector probe: `ActionDetector` driven by `SyntheticSource` with **anisotropic** noise. Depth noise was 3–8 cm and x/y noise 1–2 cm, which is realistic for monocular trackers. The built-in `triggerTest.js` only uses isotropic noise of 1 cm or less.

**Limits.** There is no real webcam here. Statements about human experience are reasoned from:
- the code;
- the judge logs;
- typical numbers: 40–75 ms camera-to-screen latency, 350–450 ms choice reaction time, and 250–400 ms to execute a gross movement.

### Key measurements

| Probe | Result |
|---|---|
| Full run, bot at 93 % skill | 43 Perfect / 0 Great / 0 Good / **5 Miss → dead in Act 2** (beat ~160, ~75 s into the run). A heart never came back: regen needs a 30-combo, and every miss broke the combo. |
| Boss, bot at 93 % skill | 29 P / 3 M in ~60 s: only **~32 notes/min**. Three identical cycles. 3/3 weak-point blasts landed, so it was defeated. |
| Chart census, Acts 1–3 | 29–49 notes per act at 42–68 notes/min. **Strikers are 55–80 %** of the notes, and up to 90 % in upper-body mode. Brutes and volleys in Act 2 depend on the RNG and skill (missing in some seeds). The Spirit Core (the signature blast) appears **once**, at the end of Act 3, about 2:10 into the run. |
| Detector, depth noise 3 cm | Punches: 30 of 32 expected (~6 % false negatives). |
| Detector, depth noise 6–8 cm, 25–30 Hz | Punches: 28 of 32 (~12 % false negatives). **2–4 phantom `punchLeft` per 8 kicks** (balance arm swing). 1–2 phantom punches in guard and T-pose. |
| Held moves | The scythe, volley and guard log Perfect with errors of −110 to −150 ms. Being in the pose early always scores Perfect, and the popup still prints "−120 ms". |
| Charge in the boss | Raising the hands triggers the HUD warning **"STEP BACK – your whole body needs to fit"** over "HANDS UP – CHARGE!" and "WEAK POINT!" (three stacked messages). |

## Scored rubric

| Area | Score | One-line why |
|---|---|---|
| Onboarding (first 60 s) | **5** | The T-pose calibration and the hand-cursor title are strong ideas. But: the tracker pick needs the mouse, the tutorial is optional and separate from gameplay, and the first Play drops you into a full act. |
| CV "wow" | **6** | The hand cursor, live PiP skeleton, measured body stats and avatar replay are all good. The player's actual image is never celebrated, and there is no sharing moment. |
| Controls reliability | **6** | The detector is carefully engineered (forward-cone punches, kick re-arming, capture-time stamps). But the punch, the core move, lives on the depth axis, the worst axis for monocular trackers. The wrong-move penalty turns stray arm swings into Misses. |
| Cue readability | **6** | The colour plus shape language is good, and the telegraph is 0.94 s → 0.70 s. Problems: prompts appear top-centre, far from the action; there is no cue for which hand on strikers beyond the lane; stacked banners at key moments. |
| Fairness | **5** | Capture-time compensation and ±250 ms windows are excellent. On the other side: 5 misses = death, wrong-move Misses, pre-held states always Perfect, and a binary boss. |
| Fun / core loop | **6** | Punching crystals to a beat with hit-stop is satisfying. The loop is mostly "jab left / jab right"; the rarer moves arrive too rarely to build rhythm patterns. |
| Pacing / difficulty | **4** | The death curve is far too steep for a showcase. Mechanics are introduced at random. "Easy" only widens windows. The signature move first appears after 2 minutes. |
| Boss | **5** | A gorgeous silhouette and weak-point idea. Three copy-paste cycles, low density, and missing one blast makes victory impossible (the Warden "retreats"). |
| Juice / feedback | **7** | Hit-stop, shatter, bloom, punch-in, layered SFX, Overdrive aura and good hit sounds. The weak spots are clutter at peak moments and confusing ms readouts. |
| Replayability | **4** | One song and one stage. "NEW BEST" is never set, and there is no persistence, leaderboard or unlock. The chart varies only by seed. |
| Accessibility / safety | **4** | Upper-body mode exists but still demands squats, and there is no seated mode. No clear-space or safety prompt, kicks aim toward the screen, and there is no flash warning. The pause gesture is "leave the frame". |

**Overall: 5.3 / 10.**

## Verdict

**A beautiful, technically serious vertical slice that a first-time player will most likely fail in its first 75 seconds, which is exactly the slot where it has to wow them.**

The engineering underneath is better than most webcam games:
- moves are judged at camera capture time, with per-move detector leads;
- the clock is latency-compensated;
- the detector has real false-positive defences.

The design layer has not caught up yet:
- the health economy is from a gamepad rhythm game, not a 2–3 m webcam game;
- onboarding is a menu option rather than the first minute of play;
- the moves that make it a full-body game (dodge, duck, guard, blast) are rare guests in a punch-the-lanes loop;
- the showcase moments never show the player themselves.

**Fix the P0s below and this goes from "impressive tech demo" to "hand it to a stranger at a meetup".**

---

## Prioritised issues

### P0: blocks the showcase

**P0-1. The health economy kills normal players in Act 1 or 2.**
- **Evidence:**
  - Any miss on a striker or crawler costs a heart (`hurt = miss && !blast && !react`).
  - There are 5 hearts, and the only regen is +1 per 30-combo.
  - A bot with 90 % hits, every hit Perfect, died at ~75 s.
  - A real player on MediaPipe also faces ~6–12 % detector false negatives on top of their own errors. Realistically 75–85 % of notes land, which means death around note 25–35, mid Act 1.
  - Most people will never see Act 3, the Spirit Core, or the boss.
- **Fix:**
  - (a) Default to a **no-fail "Showcase" mode**. Health still drains for drama, but at 0 you lose combo, score multiplier and Overdrive, never the run. Keep failure on Normal/Hard.
  - (b) Missing an *attacking* target (striker, crawler, a brute's punches) should cost score and combo, not a heart. Only hazards that physically "hit" you (sweep, scythe, volley, brute slam) should hurt.
  - (c) Regen +1 heart per 12–15 hits, not per 30-combo.
  - (d) "Easy" should mean 8 hearts, and the opt-ins `?` should drop out at hit rates below 0.8 (the current density floor is 0.15–0.2 + skill×0.9 on optional notes only; fixed notes stay).
- **Owner:** CORE (`core/score.js` `HEART_REGEN` and `judge()`; `core/game.js` `_onResolve` hurt rule; `core/settings.js` difficulty table).

**P0-2. The wrong-move penalty punishes tracker noise and natural movement.**
- **Evidence:**
  - `Judge.matchAction`: any punch or kick of the *other* name inside a strike note's Great window resolves that note as a Miss, immediately.
  - The probe with depth noise of 6–8 cm produced 2–4 phantom punches per 8 kicks (the balance arm swing).
  - A phantom punch during a crawler therefore kills the crawler and costs a heart *before* the real kick is detected.
  - Cross-body punches (a right hand into the left lane) are also instinctive for boxers.
- **Fix:**
  - Default `wrongMovePenalty` to false.
  - If kept, defer it: only resolve as wrong when the window closes **without** the correct move.
  - Only penalise the same limb class on the wrong side; never a punch on a kick note.
- **Owner:** CORE (`core/judge.js` `matchAction`; `core/settings.js` `DEFAULTS`).

**P0-3. The boss is binary: one missed blast means no victory, ever.**
- **Evidence:**
  - `BossScript` gives exactly three weak-point windows, one per cycle, each 6 beats long.
  - Three blasts are needed. Otherwise "THE WARDEN RETREATS", with no defeat sequence and no 5000 bonus.
  - The charge depends on wrists above the nose staying in frame. Overhead hands often leave the top of a laptop webcam's view at 2–2.5 m, so the confidence drops below 0.4 and `handsUp` goes false.
- **Fix:**
  - Loop the cycle until 3 blasts land, with a hard cap of ~90 s. After a missed weak point, the next window is longer, and the HUD shows a charge meter around the hero.
  - Let blast damage scale with the charge (a full charge = 1 HP bar).
  - Accept a "hands up" alternative: elbows above the shoulders with the wrists near or above the head, *or* the wrists missing from the top edge while the elbows are high.
- **Owner:** CORE (`core/boss.js`, `core/charge.js`); shared detector change via the lead (`web/src/actions.js` `handsUp`).

**P0-4. A first-time player never gets a guided first minute.**
- **Evidence:**
  - Boot → calibrate → title. **PLAY** is the primary button, and **TUTORIAL** is optional.
  - The tutorial drills moves in isolation: no spirits, no lanes, no timing, no brute guard-then-3-punches sequence.
  - Act 1 has kicks and jumps from phrase 2 onward with no introduction.
  - The tutorial's blast check (`tutorial.js`: wrist speed > 1.3, extension > 0.72) differs from the game's `ChargeDetector` (hero-FK speed > 1.25, hands < 0.75 apart, not handsUp). Passing the drill does not guarantee the move works in the game.
- **Fix:**
  - On the first Play, or when no `tutorialDone` flag is saved, run **"Act 0: Awakening"**: a 45–60 s in-engine scripted intro on the real music.
    - Each mechanic appears as its real spirit with the music ducked.
    - Each spirit freezes at its hit point until the move is done once ("wait mode", as in Fit Boxing and Beat Saber tutorials).
    - Then it repeats twice at tempo.
    - Order: punch L/R → guard and brute → dodge → duck → jump → kick → charge-blast. Lower-body moves are dropped in upper-body mode.
  - Keep the drills as "Training" in the menu.
  - Make the tutorial use `ChargeDetector` itself.
- **Owner:** CORE (`core/game.js` new `intro` state; `core/chart.js` scripted phrase list with a `waitFor` flag; `core/spirits.js` hold-at-hit-point behaviour); UI (`ui/tutorial.js` reusing the charge detector, plus prompts).

### P1: strongly affects quality or fairness

**P1-1. Punch detection lives on the weakest axis.**
- **Evidence:** `actions.js` punch rules need forward (depth) speed > 2.0 m/s and a forward reach above 0.45. Monocular depth is the noisiest axis: the probe shows 6–12 % false negatives at 3–8 cm depth noise.
- **Fix:**
  - Add a 2D cue in the same rule: the **image-plane wrist-to-shoulder distance shrinking or holding while the wrist's 2D size or confidence grows**, or, simpler, elbow-angle extension speed (a 3D angle is more robust than absolute z).
  - Fire when 2 of 3 cues agree.
  - Log per-session punch false-negative candidates (fast elbow extension with no event) in `?debug=1`.
- **Owner:** lead (`web/src/actions.js`); CORE debug overlay.

**P1-2. Duck is detected only as a hip drop.**
- **Evidence:** squat = hip drop > 0.32 × torso (~16 cm). People duck a head-height beam by bending at the waist or bobbing, and tall players in small rooms do too.
- **Fix:**
  - Accept the **head (nose) dropping below calibrated shoulder height minus a margin**, or the nose dropping > 0.35 × torso.
  - Make the scythe's hit volume the head.
  - Re-label the move "DUCK" everywhere (the code calls it squat).
- **Owner:** lead (`actions.js`); CORE (`judge.js` `maskFor`).

**P1-3. Pre-holding a held move always scores Perfect, and the popup prints negative ms.**
- **Evidence:** `evalState` returns Perfect whenever the state is on at the target, and reports the entry error. The bot got "PERFECT −141 ms".
- **Fix:**
  - Give Perfect only when the entry falls within −250…+90 ms of the target. An earlier entry is Great, so camping is allowed but not rewarded.
  - Hide ms readouts outside debug, or show only EARLY or LATE tags (a coloured tick) for Great and Good.
- **Owner:** CORE (`core/judge.js`, `core/game.js` `_popup`); UI (`ui/hud.js` judgement).

**P1-4. Distance warnings fire during legitimate big moves.**
- **Evidence:** "STEP BACK" appears when the hands go up for the charge, stacked on top of the prompt and banner.
- **Fix:**
  - Compute distance from torso and legs only (shoulders, hips, ankles), with a 0.6 s hysteresis.
  - Suppress it while `handsUp`, `jump`, a kick or a charge is active.
  - Give the HUD a single message slot with priority (prompt > banner > distance) instead of three overlapping layers.
- **Owner:** UI (`ui/body.js` `measureDistance`, `ui/hud.js`); CORE (`game.js` passes the move state).

**P1-5. Cue placement and lead time for slow moves.**
- **Evidence:**
  - Text prompts appear at top-centre, while the eye is on the incoming spirit near the hero.
  - They appear `max(1.5, teleBeats)` beats before the hit: 703 ms in Act 3.
  - A jump has to be *detected* after take-off (LEAD −70 ms). Choice reaction (~400 ms) plus the dip-and-push (~350 ms) leaves no margin. A duck is similar.
  - Strikers have no hand cue except the lane.
- **Fix:**
  - Give jump, duck, guard and blast notes a **2-beat minimum prompt** whatever the act's travel time.
  - Show prompts as a ground or ring glyph **on the spirit's path, near the hero's feet**, with the top text only as a backup.
  - Add a small L/R fist glyph on each striker for Act 1.
  - Add an audio "call" (a short vocal-style synth stab) one beat before each hazard, so players can react without looking. Rhythm games teach by ear.
- **Owner:** CORE (`game.js` `_updatePrompt`, `chart.js` per-type tele); VISUAL (`visual/*` ground glyphs, striker hand glyph); AUDIO (`audio/sfx.js` cue stabs).

**P1-6. Chart variety and teaching order are left to the RNG.**
- **Evidence:**
  - Act 2 is meant to introduce duck, dodge and brute, but in the census some seeds and skills have no brute and no volley in Act 2.
  - Strikers are 55–80 % of all notes.
  - The blast appears once before the boss.
- **Fix:**
  - Give each act fixed **"introduction phrases"** that always play in the act's first 8 bars, e.g. Act 2: `D . . .`, `VL . . .`, `VR . . .`, `B . . .`.
  - Cap strikers at ~55 % per act.
  - Add a Spirit Core finale to Act 1 and Act 2 too (the signature move should be earned by 0:45, not 2:10).
  - Author 2–3 **move-sequence "phrases with intent"**: dodge-left then punch-right (a counter), duck then double-jab, jump then a kick on landing.
- **Owner:** CORE (`core/chart.js` `ACTS`, `_pick`).

**P1-7. The boss is three copy-pasted cycles at low density.**
- **Evidence:** 32 notes/min against 50–68/min in Act 3; the same attack order three times; no phase change except faster jabs in cycle 3.
- **Fix:**
  - **Phase 1** as now.
  - **Phase 2** "Eclipse": both arms attack, with mirrored volleys (dodge L then R) and a brute-style guard-and-counter where the Warden's fist itself is the brute.
  - **Phase 3** "Breaklight duel": a sustained **beam struggle**. The player holds the push pose and pumps the arms on the beat to win the clash. It is a great CV moment, because the body's forward lean and the arm extension visibly push the beam.
  - Raise the density to ~50/min.
- **Owner:** CORE (`core/boss.js`); VISUAL (`visual/*` boss attacks, beam clash).

**P1-8. Safety and space are never addressed.**
- **Evidence:**
  - Kicks are front kicks **toward the screen**, often a laptop on a desk.
  - There are jumps on hard floors, and punches toward the monitor.
  - There is no clear-space check, no hydration or rest prompt, and the bloom flashes have no warning.
- **Fix:**
  - **Calibration:** "Clear a 2 × 2 m space", plus a check that the player stands at least 1.8 m from the camera (the feet's 2D y-position and the body height in frame).
  - **Kicks:** detect knee-up height and leg extension laterally and accept **side or knee strikes** ("knee up to break the crawler"). Re-skin the crawler hit as a stomp or knee so nobody kicks the laptop.
  - Show a one-time flash and motion warning, and add a "Reduce flashes" toggle that caps the `bloom()` adds.
  - Add a pause pose (crossed arms or an X for 1 s) so pausing does not need leaving the frame.
- **Owner:** UI (`ui/calibrate.js`, `ui/screens.js` settings); CORE (`game.js` bloom cap and pause pose); lead (`actions.js` knee strike and X-pose).

**P1-9. Upper-body mode is not seated-friendly.**
- **Evidence:** upper mode keeps the scythe (squat). Calibration fits a full T-pose silhouette. There is no seated option.
- **Fix:**
  - Add **Seated mode**:
    - the scythe becomes a head bob or lean-forward (nose drop);
    - the sweep becomes "both hands up" (a raised block);
    - the volley becomes a lean;
    - the brute stays guard;
    - calibration uses the upper silhouette.
  - Upper mode should also turn scythe into lean-down.
- **Owner:** CORE (`chart.js` `upperOnly`, `boss.js`); UI (`ui/calibrate.js`, settings); lead (`actions.js` nose-drop state).

**P1-10. The results replay and stats undersell the CV.**
- **Evidence:**
  - The replay's "best moment" is only picked from the recorder's last ~20 s ring (`ReplayRecorder`), so in practice it is the boss ending, or the death.
  - "Best reaction" is "not measured" after any boss-only or failed run.
  - The reaction tiers (≤ 180 ms = "Lightning") are physiologically unreachable for a cue → punch-extension measure (~320–450 ms realistic). Everyone sees "Steady".
  - The stats panel has a large empty top area at 1440×900.
- **Fix:**
  - Keep a run-long sparse event index and a 20 s full-rate ring *around the best window* (store keyframes for windows that score above the current best).
  - Re-tier reaction: ≤ 330 Lightning, ≤ 400 Quick, ≤ 480 Alert.
  - Add more measured stats, all derivable from data already present:
    - "punches per minute peak";
    - "deepest duck (cm)";
    - "max lean (deg)";
    - "timing consistency ±ms" from `judge.errHist` SD;
    - "left vs right power".
  - Fill the panel top with the replay viewport.
- **Owner:** CORE (`core/replay.js`, `core/score.js`); UI (`ui/screens.js` results).

### P2: polish

- **P2-1. The calibration silhouette's arms read as a dashed halo ring, not arms.** Draw the arms as solid limbs, and show the **webcam image (stylised)** behind the skeleton so people instantly understand "that's me". Owner: UI (`ui/calibrate.js`, `game.css`).
- **P2-2. The boot tracker choice is mouse-only, and the player is then expected to walk 2.5 m back.**
  - Auto-pick (HMR if reachable, else MediaPipe) after 5 s.
  - Show "Walk back until your feet appear" as a full-screen live camera view before the T-pose.
  - Owner: UI (`ui/screens.js` boot); CORE (`main.js`).
- **P2-3. The Settings volume row edits `settings.volume` as a number, but the default is an object `{master, music, sfx}`.** `onClose` then calls `audio.setVolume(number)`. Owner: UI (`ui/screens.js`) with CORE (`core/settings.js`).
- **P2-4. "NEW BEST!" is never set: Score does not persist a best.** Store the best per difficulty and mode in localStorage. Owner: CORE (`core/score.js`, `game.js` `_startResults`).
- **P2-5. Overdrive is fully automatic.** Make it a player act: flow full → "STRIKE A POSE!" (any held power pose: both fists up over the head, or a flex) → activate. It is cheap, readable and photo-worthy. Owner: CORE (`score.js`, `game.js`); lead (`actions.js` pose).
- **P2-6. Hand-cursor details.**
  - On the results screen the player is still sweaty and moving: `data-ui-nopunch` and a 1.2 s dwell on PLAY AGAIN would stop accidental replays.
  - Add an audio tick at 50 % and 100 % dwell.
  - Owner: UI (`ui/cursor.js`, `ui/screens.js`).
- **P2-7. The reaction-test striker "appears on the spot" with no tell.** A 150 ms white flash plus a sting makes it read as a deliberate "reflex check" and not a bug. Owner: VISUAL and AUDIO.
- **P2-8. Act transitions.** Between acts there is only a banner. A 1-bar "breather" with the hero's pose taunt and a beat-synced camera swoop would sell the progression and give a 2–3 s rest. Owner: CORE (`camera.js`, `game.js`).
- **P2-9. Fatigue.** The run is ~3.5 min of play with ~110–150 punches, which is fine. But the arms-up charge plus eighth-note jabs at the end of Act 3 straight into the boss is the most tiring stretch. Insert a 4-bar low-intensity groove before the boss (guard plus leans only). Owner: CORE (`chart.js`, `boss.js` intro).

---

## Top 5 highest-leverage improvements

1. **The no-fail Showcase economy, plus fixed teaching phrases** (P0-1, P0-2, P1-6).
   - It is the single biggest change to how many players reach the "wow".
   - Misses cost combo and score, not the run.
   - Each act guarantees its new mechanic in its first 8 bars, and every act ends in a Breaklight.
   - Expected effect: almost every player sees the boss, and the blast becomes the recurring payoff.
2. **"Act 0: Awakening", a wait-mode in-engine intro** (P0-4).
   - The first 60 seconds become the tutorial, set to music, with real spirits that freeze until you do the move.
   - It is also the perfect place to show the live camera feed shrinking into the PiP as the hero "takes over" your body.
3. **Signature CV feature A: "Mirror Moment", a stylised live camera feed of the player.**
   - **Calibration.** Show the actual webcam image, segmented with the MediaPipe selfie-segmentation or pose mask, rendered as a neon cel-shaded silhouette (posterised, edge-glow, palette-mapped to the act colours) inside the T-pose guide. When it locks, the silhouette "pours" into the VRM hero.
   - **During Overdrive.** The player's stylised silhouette appears as a giant spectral echo behind the hero on the sky (a billboard in `worldScene`), striking in sync. This is the moment onlookers gasp, because it is *them*.
   - **Results.** A **side-by-side replay**, the player's stylised video next to the hero re-performing the same 5 s at 0.35×, sells "the AI understood my body" better than any number.
   - Scope: segmentation is one extra MediaPipe task, and the ring buffer of low-res (256×144) mask frames is ~20 s × 30 fps of small textures.
4. **Signature CV feature B: "Breaklight Photo Booth" plus a shareable card.**
   - After the boss, the game asks for a victory pose ("STRIKE YOUR VICTORY POSE"), detected as any held pose for 1 s with the arms above the shoulders.
   - It captures:
     - a stylised still of the player, from the segmentation above;
     - the hero mirroring that pose in a front cinematic, with Breaklight particles;
     - a card: rank, score, fastest punch, highest jump, timing ±ms.
   - It is saved as a PNG and offered as a QR code for the local download. Hand-cursor "SAVE" uses a punch to confirm.
   - The game also learns your pose. Optional: on-device face-expression detection (MediaPipe FaceLandmarker blendshapes) makes the hero's face copy a shout or grin in the photo, and during the blast (`hero.setExpression`).
   - This is the "tell your friends" loop the game currently lacks.
5. **Detection robustness pass with 2D cues and gesture alternatives** (P1-1, P1-2, P0-3, P1-8).
   - Punches confirmed by elbow-extension speed and the 2D image cue, not depth alone.
   - Duck accepted from the head drop.
   - Hands-up accepted from the elbows when the wrists leave the frame.
   - Knee strikes instead of front kicks at the screen.
   - The HUD distance warning gated by the move.
   - Each change removes a category of "I did it and it didn't count", the #1 complaint in camera games.
   - Back it with a regression variant of `triggerTest.js` using **anisotropic noise** (depth noise at 3–4× the x/y noise) and a lean / step / duck phase. Today's test passes at 1 cm isotropic noise, which hides the depth problem.

### Also worth considering (in scope, lower priority)

- **Two-player co-op ("tag team").** MediaPipe Pose supports multiple people. A second player standing behind can tag in by raising a hand (the hero changes aura colour), or both play split-lane: left lanes for P1, right lanes for P2. It is a great party showcase, but it doubles the tracking cost; prototype it in `motion-lab` first.
- **Hand states.** An open palm versus a fist (MediaPipe Hands, already partly wired in `web/src/motion/hands.js`) would allow a "palm strike" variant for the blast and better cursor clicks (pinch or fist to select instead of dwell).
- **Live latency badge.** The PiP already shows fps and ms. A one-time "Your setup: 52 ms camera→screen, compensated" toast after calibration makes the millisecond judging credible to tech audiences.

## Notes on what's already right (keep it)

- Moves are judged at **camera capture time**, with per-move `LEAD_MS` and an audio clock that subtracts `baseLatency + outputLatency`. This is the correct architecture; most webcam games get it wrong. The bot's timing SD was 17–27 ms, so the pipeline is not adding jitter.
- The ±250 ms Good window, ×1.15 for MediaPipe, is appropriately generous for full-body moves.
- The fairness rules in `chart.js` (recovery beats per move, no jump right after a duck, eighth notes only for alternating jabs in Act 3) are sound.
- The detector's false-positive defences (forward cone, `PUNCH_PAIR_MS`, jump and hands-up suppression, one kick per foot lift) hold up in the probe for guard, squat, jump and wave.
- Hand-cursor design choices: the interaction box is relative to the shoulders, there is a magnet, a punch selects using the target from ~120 ms before, `data-ui-mouseonly` is set on the calibration SKIP, and tutorial nav needs a long dwell. All are thoughtful.
