# BREAKLIGHT: game design document

A webcam-only, full-body rhythm-combat game in the browser. Your body is the controller: you punch, kick, jump, duck, dodge, block and charge a two-hand energy blast. The anime hero (VRM, `Sakurada_Fumiriya.vrm`) mirrors you in real time on a floating sky-island at dusk, while waves of crystalline **Glitch Spirits** surge in on the beat of a procedural soundtrack.

**Goals.** Make people say "wow" twice:
1. **Visually.** A polished cel-shaded hero, a glowing dusk sky-island, neon spirits that shatter into light, cinematic camera cuts.
2. **Technically.** Real-time computer vision doing things people don't expect from a webcam:
   - menus you drive with your hand;
   - a calibration you do by striking a pose;
   - moves judged to the millisecond;
   - a results screen that measures you (punch speed, jump height, reaction time);
   - an instant slow-motion replay of your best moment, re-rendered from your captured motion.

**Original IP.** All characters, creatures, names, music and art are ours or are licence-clear models (see `web/public/vrm/CREDITS.md`). It is not a recreation of any existing game.

## 1. Session flow (about 5 minutes)

| State | What happens | CV showcase |
|---|---|---|
| `boot` | Loading screen. Choose a tracker (InstantHMR server, MediaPipe in-browser, or a "demo player" for no camera); falls back automatically. | |
| `calibrate` | "Strike the pose": hold a T-pose for 1 s inside a glowing silhouette guide. Distance guidance ("step back", "move left"). | The pose-matched silhouette fills as you match it. |
| `title` | The hero stands in idle stance on the island. Buttons: **Play**, **Tutorial**, **Settings**. | A **hand cursor**: hover your palm over a button and hold 0.8 s, or punch it. |
| `tutorial` | Six short drills: punch, kick, jump, duck, dodge, guard, then the charge-blast. Each passes after 3 good reps. | Live move verification with feedback ("punch faster", "jump higher"). |
| `run` | Three acts of about 50 s each. Waves spawn on the beat; difficulty and music intensity rise per act. | |
| `boss` | A giant spirit, the **Eclipse Warden** (~60 s). Telegraphed attacks; a weak-point phase finished by a charge blast. | |
| `results` | Score, rank (S/A/B/C), and judgement breakdown. Body stats: fastest punch (m/s), highest jump (cm), best reaction (ms), moves performed, approx. kcal. Then a slow-motion **highlight replay** of your best combo from a cinematic front camera, then **Play again** / **Title** with the hand cursor. | Measured stats; the replay is rebuilt from recorded poses. |
| `pause` | Automatic when the player leaves the frame or tracking is lost for more than 1.5 s. "Step back into view." Resumes with a 3-2-1 countdown. | |

## 2. Moves → mechanics

The player's left is the hero's left. The gameplay camera sits behind and above the hero (3/4 rear), with no mirroring, so screen left = player left. It cuts to the front for cinematics.

| Spirit / hazard | Look (colour language) | Approach | Required move | Detection |
|---|---|---|---|---|
| **Striker** (L / R) | Orange crystal wisp, chest height | Flies in on the left or right lane | Punch with the matching hand | `impact` kind `punch`, side matches lane, fist within the hit volume |
| **Crawler** (L / R) | Cyan crystal beetle, ground | Scuttles in, low left or right | Kick with the matching leg | `impact` kind `kick`, side matches |
| **Sweep** | Red low energy beam across the floor | Sweeps across | Jump | `jump` action (feet leave the floor) inside the window |
| **Scythe** | Violet high beam at head height | Swings across | Duck / squat | `squat` state active inside the window |
| **Volley** | Yellow orbs aimed at the left or right side | Shot at you | Dodge: lean or step the other way | `leanLeft/Right` or `stepLeft/Right` away from the incoming side |
| **Brute** | Gold armoured spirit | Walks in, telegraphs a hit | Guard to block the hit, then punch 3× | `guard` state at the hit moment, then 3 punches |
| **Spirit Core** | White-gold orb (after combos / in the boss phase) | Floats in front | Charge: hands up for 1 s (an aura builds), then a two-hand push forward = **Breaklight blast** | `handsUp` held, then both wrists forward fast, extended |

**Timing judgement.** Each spirit has a target beat time. The error is measured from the move's capture timestamp (capture → detection latency is already compensated using frame capture times).

| Judgement | Error | Points |
|---|---|---|
| Perfect | ≤ 90 ms | 300 |
| Great | ≤ 160 ms | 200 |
| Good | ≤ 250 ms | 100 |
| Miss | > 250 ms, or the wrong move | 0 |

These windows are tunable per tracker (MediaPipe vs InstantHMR) in settings.

**Combo and Flow.**
- Combo multiplies score: ×1 to ×4 at 10 / 25 / 50 hits.
- Hits fill the **Flow** meter. When it is full the game goes into **Overdrive** for 10 s: double points, an extra music layer, a gold aura and stage colour shift.
- A Miss breaks the combo and costs health (5 hearts).
- Health 0 → results screen, with a "Try again" option.

**Accessibility and fairness.**
- Lead-in visual telegraphs of 1.5–2 beats before every hit.
- Readable colour plus shape language, so colour isn't the only cue.
- Optional "upper body only" mode (no kicks or jumps, for small rooms).
- Adaptive difficulty: spawn density follows the hit rate.

## 3. Presentation

- **Stage:** a floating sky-island at dusk.
  - Stone platform with glowing rune circles that pulse on the beat.
  - Floating rocks and waterfalls into a cloud sea, distant islands.
  - A huge setting sun, god-rays, drifting petals or embers.
  - The sky gradient shifts per act: amber → magenta → violet night with stars for the boss.
  - Spirits enter from a rift portal on the horizon.
- **Spirits:** faceted crystal bodies with emissive cores, glowing trails and telegraph rings. On hit they shatter into tumbling shards plus a light burst, hit-stop and a camera kick.
- **Boss:** a towering crystalline guardian half-emerged from the cloud sea, with glowing cracks; weak points open as glowing seams.
- **Camera director:**
  - gameplay: 3/4 rear;
  - punch-in on perfects (subtle);
  - front cinematic for the charge blast, boss intro and replay;
  - orbit on the title screen.
- **Hero:** the existing VRM render stack (MToon tuning, SDF face shadow, rim lights) and combat FX (trails, sparks, hit-stop, shake). Aura during charge and Overdrive.
- **UI:** bold anime-game typography; judgement pop-ups at the strike point; combo counter; Flow meter; hearts; act/boss banners. The webcam picture-in-picture shows your glowing skeleton overlay. All menus are hand-cursor driven, with mouse/keyboard as fallback.
- **Audio:** a procedural WebAudio soundtrack (original, about 128 BPM, synthwave/drum-and-bass hybrid) with layers that rise with act and Overdrive, plus synthesized SFX (whoosh, impact, shatter, perfect chime, charge hum, blast). The beat clock is the single source of truth for spawning and judging.
- **Performance:**
  - 60 fps on a typical laptop with tracking running;
  - quality presets from `web/src/render/quality.js`;
  - pooled spirits, shards and particles;
  - no per-frame allocations in hot paths.

## 4. Tech reuse

- **Hero:** `web/src/vrm/hero.js` (`loadVRMHero`).
- **Motion:** `web/src/motion` (`createMotionPipeline`, `events`: action/impact/land; `actions.state`; `hitStop`).
- **Sources:** `web/src/sources/*`.
- **Combat FX:** `web/src/fx` (`createFx`).
- **Rendering:** `web/src/render/post.js`, `heroLights.js`, `quality.js`, `pipeline.js`.

The test bed (`index.html`) stays as the dev arena. The game is a new page, `web/game.html`.
