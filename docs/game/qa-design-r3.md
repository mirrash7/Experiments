# BREAKLIGHT: design QA, round 3

Reviewer: the same motion-game designer who wrote `qa-design-r1.md` and `qa-design-r2.md`.
Build reviewed: `24e55fd` ("BREAKLIGHT fix round 2"). Round 2 reviewed `06b5bb5`.

## Method

**Read:** `qa-design-r2.md`, the `24e55fd` diff, `core/game.js` (Awakening escalation, kiosk, new player, knockdown, results/booth/replay, pause), `core/chart.js`, `core/settings.js`, `core/score.js`, `ui/screens.js`, `ui/hud.js`, `ui/body.js`, `actions.js`.

**Ran:** my own Vite (5262, HMR off) and headless Chrome (CDP 9462, fresh profiles). Both are shut down. No code was edited.

| Probe | Result |
|---|---|
| `node web/src/motion/triggerTest.js` | All PASS. Robustness 0.19 phantoms per 100 moves (r2: 0.37), 0 between moves. **New sequence bench:** dodge→counter 100 %, duck→jab 98.6 %, guard→3 punches 95.8 % (full sequence), 8 alternating punches 97.2 %. **Knee mode:** knees 99–100 %, 0.56 phantoms per 100 moves. |
| **Frozen-player Awakening** (`autoplay`, bot switched to idle at the first wait) | **Coach at 5.0 s, loose at 10.0 s, auto ("LET'S KEEP GOING!") at 15.0 s**, exactly on time for both the striker and the brute waits. The run continued normally once the bot was un-frozen. Waits are logged (`awkLog`, console). |
| **Kiosk, demo length** (`?kiosk=1&autoplay=1&botSkill=0.85&seed=7`) | Awakening 58 s → Acts 1–3 (~30 s each) → **5.7 s breather** → boss 77 s (3 cycles) → replay → results at **3 min 59 s**. 0 knockdowns, A rank, **12 kicks** (r2 full run: 26). The results replay played for 8.3 s; then stats. **40 s idle on results → new player → calibrate**; the title shows TODAY'S BEST 70,900, NEW PLAYER and a KIOSK MODE chip. No console errors. |
| `?skip=boss&botSkill=0.6` | Defeated in **76 s**, 1 knockdown (r2: 117 s, 3 knockdowns). The knockdown shows "GET BACK UP! – KNOCKED DOWN · HEARTS REFILLED", a red vignette, then a grace bar. |
| `?mode=challenge&awaken=0&botSkill=0.85` | **Dead at 74 s** (start of Act 2). Unchanged from rounds 1 and 2. |
| Offline chart census (20 seeds) | See the table below. |

**Limits.** There is still **no real webcam** here. The booth, Mirror Moment, YOU inset, flash notice and clear-space screen are all skipped or degraded under autoplay, so I judged those from the code and from `qa-art-r2` frames.

### Chart census (notes per act, 20 seeds, skill 0.5–0.95)

| Mode | Act 1 | Act 2 | Act 3 | Crawlers (kicks) |
|---|---|---|---|---|
| Full | 27–32/min | **37–40/min** | 41–44/min | **2.5–3.8 per act (8–15 %)**; r2: 7–10.6 (30–36 %) |
| Demo length | 28–30/min (14–15 notes) | 34–39/min | 43–47/min | 0.8–1.9 per act |
| Upper body | 25–28 | 37–40 | 41–44 | none |
| Seated | 23–25 | 31–36 | 39–44 | none. **Act 3 is still 50 % volleys, no duck.** |

The density curve now rises from act to act, the Act 3 cliff is gone, and kicks are under the 20 % cap everywhere.

---

## Scored rubric: r1 → r2 → r3

| Area | R1 | R2 | R3 | Why (r3) |
|---|---|---|---|---|
| Onboarding (first 60 s) | 5 | 7 | **8.5** | Escalation is verified on time and the coaching is driven by the detector (e.g. "Step back so your feet are in view" when ankles are unseen). The "LIKE THIS" glyph chip and the hand-dwell SKIP INTRO work, and a per-player reset exists. Small copy faults remain at the loose stage (P2-1). |
| CV "wow" | 6 | 8 | **8** | The booth now arms only after the replay (r2 P1-5 fixed). Echo placement avoids the boss and the portal. The replay keeps the hero larger but still shows the back of the head (P2-4). None of this has been seen through a real camera. |
| Controls reliability | 6 | 7 | **7.5** | The lean gate only fires on lean-out, so dodge→counter is 100 % on the bench. There are combo benches and a knee-strike mode. It is still **synthetic only**. |
| Cue readability | 6 | 7.5 | **8** | The coaching chip, the animated glyph and "PUNCH NOW!" on reaction notes all help. The audio hazard call is still missing. |
| Fairness | 5 | 7.5 | **8** | Kicks are capped. Nobody soft-locks (frozen worst case: auto after 15 s per wait). Knockdowns are explained and followed by a grace bar. |
| Fun / core loop | 6 | 7 | **7.5** | Act 2 now has the intent phrases at ~40/min. Act 1 is still a little sparse (~30/min) for an experienced player. |
| Pacing / difficulty | 4 | 6.5 | **8** | The demo cut lands at 4:00 with the bot (~4:30 for a human), with a breather before the boss and a rising curve. |
| Boss | 5 | 7.5 | **8** | The crystal-shatter defeat and boss eyes. A weak player wins faster (76 s vs 117 s). There is still no beam-struggle finale. |
| Juice / feedback | 7 | 7.5 | **8** | Knockdown feedback, capped bloom and the kill shot. |
| Replayability | 4 | 5.5 | **6** | Today's best and per-length bests. It is still one song and one stage, with no unlocks. |
| Accessibility / safety | 4 | 6 | **7.5** | A flash notice per player, `reduceFlashes` (bloom cap 0.08, no booth white flash, less shake) and knee strikes. Still missing: a pause pose, a better seated mix, and the clear-space screen still auto-continues. |

**Overall: 5.3 → 7.0 → 7.9 / 10.**

---

## Round 2 issues: verified fixed, partial or regressed

| R2 item | Status | Evidence |
|---|---|---|
| **P0-1** Awakening soft-lock | **Fixed** | `_escalateWait`: COACH_S 5, LOOSE_S 10, AUTO_S 15, measured at 5.0, 10.0 and 15.0 s. Each move has a loose match (`_looseCheck`, plus punch/kick in `_onAction`). The blast assist fires the real blast. The wait clock is reset after a pause. SKIP INTRO is a hand-dwell button. |
| **P0-2** No new-player flow | **Fixed (one hole)** | `?kiosk=1` keeps flags volatile, forces Showcase/standing/demo length, and resets after 40 s of results idle or 45 s of empty title. NEW PLAYER sits on the title (dwell 1.2 s, N key) and today's best persists. **Hole:** an abandoned run is never reset (R3 P1-1). |
| **P0-3** No real-webcam evidence | **Open** | Nothing new. Still the only P0. |
| P1-1 Lean gate eats counters | **Fixed (synthetic)** | `leanSpeed` 1.6 applies only when \|tilt\| grows; coming back the gate is 3.2. Bench dodgeCounter 100 %. |
| P1-2 Kicks a third of Act 1 | **Fixed** | `cfg.convert` pools; crawlers at 8–15 %; 12 kicks in a full demo run; `?knee=1` knee strikes. |
| P1-3 Act 2 density dip | **Fixed** | Measured 27–32 → 37–40 → 41–44/min. |
| P1-4 Session too long | **Fixed** | `length=demo` (default in kiosk): 3:59 total with the bot. Breather before the boss. |
| P1-5 Booth over replay | **Fixed** | `_armBooth` runs only after `_replayDone`, and `setBlocked(true)` during any replay. Cleared runs and real cameras only. Not exercised headless. |
| P1-6 Safety gaps | **Mostly fixed** | Flash notice (per player in kiosk, auto-continues after 12 s), `reduceFlashes`, and flash caps (`FLASH_CAP` 0.3, cinematic 0.18). **Clear-space still auto-continues** after 4 s framed (`holdS = 4`), and **there is no pause pose.** |
| P1-7 Silent knockdowns | **Fixed** | `_onKnockdown`: hit-stop, stagger, hurt face, music duck, "GET BACK UP!", vignette, 4-beat grace. Verified on screen. |
| P1-8 Replay doesn't show you | **Partial** | `replayKill` shot: a low side 3/4 with the hero large in frame, but still from behind (face not visible). The YOU inset needs a real camera. |
| P2-1 "Fastest punch" metric | **Fixed** | Now the hero hand's world speed over 66 ms spans (5.4 m/s, "Sharp"). The old metric is kept as `punchSnap`. |
| P2-2 measureDistance boxes the wrists | **Fixed** | `kpBounds(frame, 0.45, coreOnly = true)`. |
| P2-3 Seated mix | **Open** | Act 3 is 50 % volleys, and there is still no seated duck. |
| P2-4 Reaction prompt names a hand | **Fixed** | "PUNCH NOW!" unless `wrongMovePenalty` is on. |
| P2-5 Challenge economy | **Open** | Dead at 74 s at 85 % skill. There is no middle tier. |
| P2-6 Showcase rank after a win | **Partial** | "STAGE CLEAR" kicker; the rank is still the plain letter. |
| P2-7 Audio call, fist glyph, Overdrive pose, latency badge | **Open** | Glyphs are in the prompts; the rest is not done. |
| P2-8 Booth sharing (QR) | **Open** | |

**Regressions found:** none. The bench improved (phantoms 0.37 → 0.19 per 100 moves). Punch-right single-move hit rate is 98.9 %, inside the noise. Full-sequence guard→3 punches is the weakest at 95.8 %, worth watching on real data.

---

## Remaining issues

### P0: before any public demo

**P0-1 (carried over from r2 P0-3). There is no real-webcam evidence.**
- **Evidence:** every detector number, the Awakening timings and the session length come from the synthetic bench or the chart-reading bot (SD ≈ 25–31 ms timing, learned per-move delays).
- **What is still unknown:**
  - real MediaPipe/InstantHMR wrist behaviour on cross punches and hooks;
  - polite kicks and knees;
  - tall players in a 2–2.5 m room;
  - how often real people hit coach/loose/auto in the Awakening.
- **Fix:** run the playtest plan below. Build the tooling in R3 P1-2 first so the session produces a regression set and not just impressions.
- **Owner:** lead (`web/src/motion/*`, `web/src/actions.js`); CORE (logging).

### P1

**P1-1. Kiosk: an abandoned run never resets. This blocks an *unattended* demo.**
- **Evidence:**
  - Leaving the frame mid-run → `pause` (`LOST_PAUSE_S` 1.5 s).
  - `_updatePause` has no timeout.
  - `newPlayer()` returns early when `state === 'pause'`.
  - The kiosk idle timers only run on `title` and `results`.
- **What a real player hits:** a stranger who walks off at Act 2 leaves the game paused forever. The next person who steps in gets a 3-2-1 and someone else's half-finished run, with no Awakening, no safety screen and no flash notice.
- **Fix:** in kiosk, pause with nobody tracked for more than 20 s → quit to `newPlayer()`. Allow `newPlayer` from pause. Optionally, in any mode, offer a "NEW PLAYER?" hand button on the pause screen.
- **Owner:** CORE (`core/game.js` `_updatePause`, `newPlayer`); UI (`ui/screens.js` pause).

**P1-2. There is no capture path for the playtest.**
- **Evidence:**
  - `motion-lab` can record and download a raw clip (`Recorder`), but it has no move labels, it is not inside the game, and nothing replays a clip through `actions.js` to score it.
  - The game logs only `[game] results` and Awakening waits to the console.
- **Fix:**
  - `game.html?debug=1&record=1`: record tracker frames, detector events (with `punchNearMiss` and suppressed reasons), judge events (note, expected move, result, error ms) and Awakening waits. Download the JSON on results, plus a one-line summary.
  - Add a `node web/src/motion/replayBench.js clip.json` that re-runs the detector and judge offline, so threshold changes can be regression-tested on real people.
- **Owner:** lead (`web/src/motion/`, `web/src/sources/recordedSource.js`); CORE (`core/debug.js`, `core/game.js`).

### P2

- **P2-1. Awakening loose-stage copy contradicts itself.**
  - At the loose stage the headline still says "RIGHT PUNCH ▶", while the sub-line *and* the chip both say "Any punch will do: either hand!" (the same text twice).
  - For a brute already in the punch phase, the loose hint is "Raise your hands!" (wrong), and nothing looser is accepted, so it waits for the 15 s auto.
  - **Fix:** headline "PUNCH!" at the loose stage; one copy of the hint; a phase-aware guard hint that also accepts 1 punch as the loose match.
  - Owner: CORE (`game.js` `LOOSE_HINT`, `_updatePrompt`, `_looseCheck`); UI (`hud.js` coach chip).
- **P2-2. Frozen-player worst case.** 8 waits × 15 s adds about 2 min to the Awakening for someone who doesn't get it.
  - After 2 consecutive auto-resolves, shorten AUTO_S to 8 s for the rest of the intro, or offer the hand SKIP more prominently.
  - Owner: CORE (`game.js` `_escalateWait`).
- **P2-3. Clear-space still auto-continues after 4 s framed.** Use "I'M CLEAR" dwell only, for the first run of each player (kiosk) or session. Owner: UI (`ui/screens.js clearSpaceScreen`, `autoContinue`).
- **P2-4. The boss-kill replay is still a back 3/4.**
  - Swing the `replayKill` dolly to a front 3/4 for its second half, so the face and the push read.
  - Verify the YOU inset with a real camera.
  - Owner: CAMERA (`core/camera.js SHOTS.replayKill`).
- **P2-5. Kiosk results idle is 40 s whatever happens.** It ignores presence, so a player reading their stats, or posing for a second photo, gets reset. Count only while nobody is tracked, or reset the timer on any hand-cursor hover. Owner: CORE (`game.js` results idle).
- **P2-6. Seated: 50 % volleys in Act 3, no duck.** Add a seated head-bob scythe (the detector supports it) and more guards. Owner: CORE (`chart.js` `upperOnly`, `convert`).
- **P2-7. Challenge: dead at 74 s at 85 % skill.** Add a "Normal" tier (regen every 12 hits, can fail). Owner: CORE (`score.js ECONOMY`); UI (`screens.js MODES`).
- **P2-8. Still open from round 1:**
  - the audio hazard call one beat before jump/duck/volley;
  - an X-arms pause pose;
  - the Overdrive power pose;
  - the latency badge;
  - booth sharing by QR code;
  - the beam-struggle finale;
  - a Showcase clear title.

---

## Verdict

**Ready for a *hosted* public demo (a developer nearby) once the real-webcam playtest passes. Not yet ready for an *unattended* kiosk.**

Round 2 closed both design P0s:
- The Awakening cannot soft-lock (verified to the second).
- A shared machine resets itself per player: kiosk mode, NEW PLAYER, today's best, the flash notice per player.
- The run is a tight ~4-minute demo with a rising curve, few kicks, a breather and an explained knockdown.

The design is in good shape. **What remains is evidence, not features.**

**Before a hosted demo:**
1. Run the playtest below (P0-1). Ideally build the capture path (P1-2) first, so its numbers are reusable.

**Before an unattended kiosk, additionally:**
1. Fix the abandoned-run reset (P1-1).
2. Make clear-space need a confirmation (P2-3).
3. Do a 30-minute soak in `?kiosk=1` with people walking in and out, with no developer touching the keyboard.

---

## Real-player playtest plan (for the owner)

**Setup**
- The target laptop with its own webcam at chest height. The screen is the only light source in a normally lit room.
- 2–2.5 m floor, marked with tape.
- `game.html?kiosk=1&debug=1`. If P1-2 lands, add `&record=1`.
- Phone video on a tripod behind and to the side, so both the player and the screen are in frame.

**Players**
- 6–10 people who have never seen the game.
- Mix of heights (under 160 cm and over 185 cm), at least one in loose or dark clothes, one seated (use the clear-space "PLAY SEATED" option), and one with glasses or long hair.
- Do not coach them. Answer only safety questions.

**Script for each player (~6 min)**
1. Walk up to the title. Note whether they find NEW PLAYER / PLAY with the hand cursor without help.
2. Flash notice, then calibrate, then clear-space, then the Awakening, then the demo run, then the results. Note whether they notice the booth.
3. Ask one question: "What did you think the game measured about you?"
4. For 2 of the players: walk out of frame mid-Act 2 for 30 s, then let someone else step in. This checks P1-1.

**What to record (on the sheet and from the debug console or JSON)**
- **Awakening:** every wait with its seconds and how it resolved (hit/loose/assist). Total Awakening time.
- **Judgements per move type:** misses with what the player *actually did* (from the video), split into "did the move, not detected" and "didn't do the move".
- **Phantoms:** a hit or judgement while the player was doing something else (guard, a lean, waving).
- **Distance and framing warnings,** and pauses from lost tracking.
- **Session time,** the knockdown count, and whether they reached and beat the boss.
- **Booth:** did it trigger, was the photo good.
- **Discomfort:** fatigue, dizziness, a flash complaint, bumping into anything.
- **FPS and latency** from the debug overlay (`snapshot().fps`, `trackLat`).

**Pass criteria (all must hold)**

| Metric | Bar |
|---|---|
| Intended punches registered (video-verified) | ≥ 90 % |
| Intended kicks, knees, ducks, jumps and dodges registered | ≥ 85 % each |
| Phantom hits | ≤ 1 per minute of play |
| Awakening median | ≤ 90 s |
| Awakening waits reaching *auto* (15 s) | ≤ 1 per player |
| Players who reach the boss | 100 % |
| Players who beat the Warden | ≥ 90 % |
| Unprompted title → run without touching the keyboard | ≥ 80 % |
| Demo session time | ≤ 5 min median |
| Frame rate during the boss | ≥ 45 fps |
| Safety incidents (bumps, flash complaints) | 0 |
| "What did it measure?" answer mentions the body, skeleton or pose | ≥ 70 % |

**After the session**
- Any move under its bar: retune with the recorded clips, then re-run `triggerTest.js` plus the clip replay.
- Any Awakening wait that repeatedly reaches loose: rewrite that section's coaching.
- Then repeat with 3 new people.
