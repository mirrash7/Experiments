# PPE Demo Runbook

Two demos, one local RF-DETR nano model (`ppe-compliance-m8dqs-z8dcg/2`,
~55 ms/frame, ~18 detection updates/sec, fully on-device — no internet needed
once running).

## Launch

Double-click in Finder (or run from a terminal):

- **`Start PPE Monitor.command`** — live compliance monitoring with alerts
- **`Start Photobooth.command`** — the foreman-narrated photobooth

Press `f` for fullscreen once the window opens. `q` quits.

## Pre-show checklist (5 min before)

1. **Power + display**: plug in the MacBook; if projecting, mirror the display
   *before* launching so the window lands on the right screen.
2. **Camera**: built-in works out of the box. For the iPhone on a stand
   (Continuity Camera): plug in via USB, unlock it once — the apps auto-pick
   the first working camera; force one with `--camera 1`.
3. **Do Not Disturb OFF** for the monitor demo — its alerts arrive as macOS
   notifications with sound.
4. **Volume up** for the photobooth (the foreman speaks).
5. **Dry run**: step in front of the camera with no gear — the monitor should
   flag you within ~1 s and fire an alert after 2 s.

## Demo 1 — PPE Monitor (`ppe_monitor.py`)

Story: stationary camera watches a work zone; every person is tracked and
checked for hardhat, vest, gloves in real time.

- Walk in with no gear → red brackets, MISSING statuses, pulsing border.
- After 2 s → alert: macOS notification + JSON line in `alerts/alerts.log`
  + annotated snapshot in `alerts/` (show the folder — "this is the audit
  trail / what we'd push to Salesforce as a Platform Event").
- Don the vest + hardhat → statuses flip to OK in ~0.5 s, header goes green.
- Point at the footer: model, 55 ms inference, on-device.
- Keys: `m` mirror, `f` fullscreen. Flags: `--required hardhat,vest`,
  `--confidence 0.4`, `--camera N`.

## Demo 2 — Photobooth (`photobooth/photobooth.py`)

Story: positive-reinforcement version — gear up correctly and the booth
rewards you.

1. Foreman invites you when you step in frame.
2. Hold a hand in the top-right dashed box 1.2 s (ring fills).
3. Wrong gear → he roasts you and sends you back. Right gear → countdown,
   3 photos, flash between shots.
4. Strip appears on screen and saves to `photobooth/photos/`.
- Flags: `--voice Grandpa` (comedy), `--mute`, `--required hardhat,vest`.

## If something goes wrong

| Symptom | Fix |
|---|---|
| Window says NO CAMERA SIGNAL | System Settings > Privacy & Security > Camera > enable your terminal, then fully quit + reopen it |
| Wrong camera picked | relaunch with `--camera 1` (or 2) |
| Gloves flicker at distance | drop to `--required hardhat,vest` |
| Someone asks "is this cloud?" | No — weights live in `.model-cache/`, inference is on-device; Wi-Fi can die mid-demo and nothing changes |
| Rehearse without a camera | `--camera somevideo.mp4` plays a file through the full pipeline |

## Talking points

- RF-DETR nano, fine-tuned on 9,888 images (Roboflow), 89.7 mAP@50.
- Explicit negative classes (`head_nohelmet`, `hand_noglove`) mean the model
  *sees* missing gear, not just absence of it.
- Same feed can publish Salesforce Platform Events per violation — Case
  creation, Agentforce, field-safety queues.
