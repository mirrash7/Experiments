# Live PPE Detection Demo (RF-DETR)

Real-time PPE compliance monitoring from a stationary MacBook or iPhone camera.
Detects **hardhat, safety vest, gloves, and mask** on every person in view,
shows a per-worker compliance checklist, and fires alerts when items are missing.

## Model

- **RF-DETR-small**, fine-tuned on the [PPE COMPLIANCE dataset](https://universe.roboflow.com/ifeanyis-workspace-edmca/ppe-compliance-m8dqs)
  from Roboflow Universe (9,888 images) — model ID `ppe-compliance-m8dqs/1`.
- Classes used: `person`, `vest`, `head_helmet` / `head_nohelmet`,
  `face_mask` / `face_nomask`, `hand_glove` / `hand_noglove`.
- Runs **fully on-device** via the `inference` package (ONNX Runtime + CoreML).
  ~134 ms/frame on an M5 Max; video renders at 30 FPS with detections updating ~7×/s.

## Run

```bash
.venv/bin/python ppe_monitor.py
```

First run downloads ~115 MB of weights, and macOS will ask for camera
permission for your terminal — grant it and rerun if the window stays black.

Options:

- `--camera 1` — pick another camera. An iPhone via **Continuity Camera**
  (mounted on a stand, unlocked, near the Mac) shows up as an extra index — try 0/1/2.
  A path to a video file also works for rehearsal: `--camera clip.mp4`
- `--required hardhat,vest` — which items to enforce. Default: `hardhat,vest,gloves`.
  Available: `hardhat`, `vest`, `gloves`, `mask`, `glasses`, `boots`, `shoes`
  (mask/glasses/boots/shoes are off by default)
- `--confidence 0.4`, `--mirror`
- Keys while running: `q` quit · `f` fullscreen · `m` mirror

## How missing items are decided

Detections are matched to each tracked person by box overlap, then smoothed
over the last 7 inference frames (majority vote) so statuses don't flicker:

- an explicit negative detection (`head_nohelmet`, `face_nomask`, `hand_noglove`) → **MISSING**
- a positive detection (`head_helmet`, `vest`, ...) → **OK**
- vest has no negative class, so a person with no vest box → **MISSING**
- hands/face not visible → **?** (unknown; never alerts)

## Alerts

A violation must persist **2 s** to fire (15 s per-worker cooldown). Each alert:

- appends a JSON line to `alerts/alerts.log`
- saves an annotated snapshot to `alerts/`
- posts a macOS notification with sound

## Setup from scratch

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python inference supervision opencv-python python-dotenv
```

`.env` must contain `ROBOFLOW_API_KEY=...` (scoped key, used once to download
weights; inference itself is local).

## For teammates

1. `uv venv --python 3.12 .venv` then `uv pip install --python .venv/bin/python inference supervision opencv-python python-dotenv pyobjc-framework-Vision pyobjc-framework-Quartz`
2. Copy `.env.example` to `.env` and add an API key from the team Roboflow workspace — the model is private to it, so ask the repo owner for access.
3. `.venv/bin/python ppe_monitor.py` or `cd photobooth && ../.venv/bin/python photobooth.py`

First run downloads ~110 MB of model weights into `.model-cache/`. macOS only (OCR uses Apple Vision; alerts/voice use macOS tools).

## Example output

The photobooth prints a Roboflow/VIS-branded strip like this:

<img src="photobooth/example_strip.jpg" width="360" alt="Example photobooth strip">
