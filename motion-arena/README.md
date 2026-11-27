# Motion Arena — webcam body tracking → 3D game character

## BREAKLIGHT (the game)

A webcam-only, full-body rhythm-combat game. An anime hero mirrors you on a floating sky-island while crystal
spirits surge in on the beat of a procedural soundtrack. You punch, kick, jump, duck, dodge, guard, and charge a
two-hand Breaklight blast. There are three acts and a boss, the Eclipse Warden.

The computer-vision showcase includes:
- **Hand-cursor menus.**
- **T-pose calibration** with a live neon silhouette of you that pours into the hero.
- **A sky echo** of you during Overdrive.
- **Body stats measured by AI:** wrist speed, jump height, reaction time.
- **A slow-motion replay** rebuilt from your captured motion.
- **A victory-pose Photo Booth.** Photos stay local.

Open **http://127.0.0.1:5173/game.html** in Chrome (with the dev server and, optionally, the InstantHMR server running; see below).

Useful flags:

| Flag | What it does |
|---|---|
| `?autoplay=1` | The bot plays the whole game, no camera needed |
| `?tracker=hmr\|mediapipe\|demo` | Picks the tracker |
| `?kiosk=1` | Shared-machine mode with a ~4 min demo and a NEW PLAYER reset |
| `?mode=challenge` | Strict hearts |
| `?seated=1` | Seated mode |
| `?upper=1` | Upper body only |
| `?knee=1` | Knee strikes instead of front kicks |
| `?reduceFlashes=1` | Dims flashes and shake |
| `?record=1` | Saves playtest sessions locally |
| `?debug=1` | Debug overlay |

Playtests: see [docs/game/PLAYTEST.md](docs/game/PLAYTEST.md). The design and QA history is in [docs/game/](docs/game/).

---

## Motion Arena (dev test bed)

`index.html` is a test bed for the character and tracking: your webcam tracks your body, the hero copies your
movements in real time, and a HUD shows how responsive and accurate the tracking is.

## Run it

Two terminals:

```bash
./server/run.sh
```

```bash
cd web && npm run dev
```

Open http://127.0.0.1:5173 in Chrome. Pick **InstantHMR**, press **Start** and allow the camera. Then stand
2–3 m back with your whole body in frame and hold still for a second while it calibrates.

The other sources need no Python server: **MediaPipe (in-browser)** runs on the GPU in the page, and
**Synthetic demo player** is a fake player for testing without a camera.

## Modes

| Mode | What it tests |
|---|---|
| **Free Move** (key `1`) | Free control. Triggers light up on the right and impulse moves pop up over the hero. |
| **Reaction Test** (key `2`) | 8 random prompts. Measures prompt → detected time, and splits out the system's own capture → detection latency. |
| **Pose Match** (key `3`) | 8 target poses shown as a ghost. You score by average limb-angle error and have to hold ≥75% for 1 s. |

Keys: `space` start/stop · `c` recalibrate · `v` cycle camera view (Front / Behind / Side / Orbit).
**Behind** turns mirror mode off, giving a third-person view where your left is the hero's left.

## HUD

- **Latency (big number):** time from the camera capturing a frame to the avatar showing that pose on screen.
  It uses `requestVideoFrameCallback` timestamps, so it covers JPEG encode, transport, detector, HMR, the
  wait for the next render, and half a vsync. The camera sensor's own exposure/readout (~1 frame) comes before
  the timestamp and isn't included.
- **Pipeline breakdown:** encode · transport · decode · detect · hmr · display wait, per frame.
- **Jitter:** RMS frame-to-frame acceleration of the wrists, head and shoulders, measured relative to the hips,
  in mm. Stand still to read the noise floor.
- **Smoothing / Interpolation sliders:** trade lag against jitter live. Set both to "off" for the rawest, fastest response.

## Measured on this Mac (M5 Max)

| Source | Tracker | Capture → on screen |
|---|---|---|
| InstantHMR small, fit 1, CoreML | ~23 fps | p50 ≈ 30–36 ms, p95 ≈ 65–80 ms (spikes are the frames where the RF-DETR detector runs, every 3rd frame) |
| MediaPipe Pose full (GPU) | ~30 fps | p50 ≈ 27 ms, p95 ≈ 30 ms |

These figures come from replaying the InstantHMR demo footage as a fake camera. A real webcam adds its own
exposure time on top.

## Layout

```
server/            InstantHMR WebSocket server (Python 3.11 venv, CoreML). See server/README.md for timings and flags.
vendor/InstantHMR  the upstream repo (Apache-2.0 code; weights are under the SAM License, non-commercial for small/medium)
web/src/
  main.js          scene, game loop, HUD, modes
  character.js     the procedurally-built, rigged toon hero (character-preview.html to inspect it)
  retarget.js      tracked joints → rig rotations, root motion, floor planting
  actions.js       gesture triggers  ← hook a game in here
  tests.js         Reaction test, Pose match, target ghost
  pose.js          shared pose format + one-euro filter
  sources/         camera, InstantHMR client, MediaPipe, synthetic player
```

### Hooking a game into the triggers

```js
actions.on((name, info) => {
  // name: 'jump' | 'squat' | 'punchLeft' | 'punchRight' | 'kickLeft' | 'kickRight' | 'handsUp' | 'tPose' |
  //       'leftHandUp' | 'rightHandUp' | 'leanLeft' | 'leanRight' | 'stepLeft' | 'stepRight'
  // info.tCapture: camera timestamp of the frame that triggered it (for latency-fair scoring)
});
// held states: actions.state.squat, actions.state.leanLeft, ...
// continuous control: retarget.rootOffset (player position), character.bones.* (limb transforms)
```

Trigger names describe the player's own body: `punchLeft` means your left hand, whatever the mirror setting.

## Notes

- InstantHMR server port is **8791**, because 8765 is used by another project on this machine.
- The hero is an original design that borrows the reference image's outfit style: messy black hair, open red
  shirt with bell sleeves, yellow sash, blue shorts with fur cuffs, sandals. It deliberately leaves out the
  copyrighted character's signature features (the X scar, the name).

## Setup after cloning

```bash
cd web && npm install && mkdir -p public/models public/mediapipe && cp -R node_modules/@mediapipe/tasks-vision/wasm public/mediapipe/ && curl -sSL -o public/models/pose_landmarker_full.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task && curl -sSL -o public/models/pose_landmarker_lite.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task
```

The InstantHMR server venv is created with `uv` (Python 3.11) from `server/requirements.txt`. Model weights download from Hugging Face on first run.
