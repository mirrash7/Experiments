# Storm Response Command Center — IBM × Roboflow (Dreamforce)

Simulated live drone feed → Roboflow detection → map + repair plans → Salesforce dispatch.

Two flights over the same stretch of **N Farm Road 159 / N Summit Road, Springfield MO**:

| | | |
|---|---|---|
| **Drone 1** | Pre-storm survey | 15 s baseline pass — reports two preventative-maintenance jobs |
| **Drone 2** | Post-storm damage assessment | 45 s pass — reports five downed poles with repair plans |

## Setup

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

**No API key is needed to run the demo.** Detections for both flights are pre-computed into
`app/cache/*.json`, so playing a flight never calls Roboflow. A key (`cp .env.example .env`) is
only needed to use the **Upload** button on your own footage, or to re-run `precompute.py`
after changing a model or clip.

Add the one missing video: `Outputs/REFERENCE-ONLY_instagram-reel_45s_2k_equalized.mp4`
(see `Outputs/README.md` — it is third-party footage and too large for GitHub, so ask Alexei
for it). Everything else ships in this repo.

```bash
./.venv/bin/python3 -m uvicorn app.server:app --port 8000
# open http://localhost:8000 in a normal browser window (1080p+)
```

Docker works too: `ROBOFLOW_API_KEY_JENNIFER=... docker compose up --build`.

## What happens in the demo

1. Click a drone in the header. A short handshake, then the clip plays at native speed as if it
   were the drone's RTMP feed, with the detections drawn on it. The map stays a spinning globe
   until the drone reports its first position, then follows it down the road.
2. **Report events** fire at fixed points in the clip, each using its pre-made render. Drone 2
   reports five downed poles (1.5 s, 20 s, 29 s, 34 s, 42 s); Drone 1 reports two maintenance
   jobs — vegetation into the span (4.1 s) and a pole out of plumb (10.7 s). Open them with
   **Repair plans** in the header; they overlay the map. Click a plan image to enlarge it.
3. **Dispatch** on a card (or **Dispatch all**) creates a Salesforce work order. With no
   `SF_WEBHOOK_URL` set it goes to a built-in inbox (`GET /api/salesforce/inbox`) and mints
   `WO-0000n` numbers, so the flow works with no external dependency.
4. When the pass ends the clip stays open: drag the **scrub bar** under the feed, or click a
   card's timestamp, to re-render any frame with its detections. Rewinding never adds or
   removes report events.

Neither flight calls the API. Drone 2's detections are **pre-computed** into `app/cache/*.json`
and replayed; Drone 1's clip is **already annotated** (the model's masks, labels and counter panel
are burned into `footage/final/springfield_pre-storm_annotated.mp4`), so the app plays it untouched
and draws nothing over it. Playback is instant and identical every time. Map tiles come from
OpenStreetMap and do need internet.

## Why it always reports exactly those scenes

Report events are **curated**, not detector-driven: `app/scenes/post-storm.json` and
`app/scenes/pre-storm.json` map each timestamp to a render in
`footage/final/stills/repair_plans/` / `footage/final/stills/maintenance_plans/`, served
byte-for-byte. The detector still drives everything you see on the video; it just doesn't decide
what gets reported. That makes the demo deterministic on stage.

To change a plan: edit its spec (`plan_*.json` — boxes are in source pixels, 2560×1440) and
re-render:

```bash
./.venv/bin/python3 scripts/repair_plan_still.py footage/final/stills/repair_plans/plan_03.json
```

To change which scene fires when, edit `t` in the flight's scenes file. Drop the `scenes` key
from a flight in `app/flights.json` to go back to detector-driven incidents.

## File map

```
app/server.py            FastAPI app: flights, stream, SSE, seek, Salesforce, report
app/pipeline.py          playback, detection replay, tracking, scene firing, review mode
app/assessment.py        findings rules + branded repair-plan renderer
app/static/index.html    the whole UI
app/flights.json         the two drones: clip + model + telemetry + detection settings
app/scenes/*.json        the curated report events (5 post-storm, 2 pre-storm)
app/cache/*.json         pre-computed detections (one per flight)
app/telemetry_springfield*.json   flight tracks along the road centreline
footage/final/springfield_pre-storm_annotated.mp4  Drone 1 clip (annotations burned in)
footage/final/stills/repair_plans/               the five post-storm renders + specs + sources
footage/final/stills/maintenance_plans/          the two pre-storm renders + specs + sources
scripts/precompute.py            re-run detections into a cache (after a model or clip change)
scripts/repair_plan_still.py     render a repair-plan still from a spec
scripts/calibrate_track.py       hand-place the flight track on satellite imagery (port 8010)
scripts/headless_run.py          run a flight unpaced and print the incidents (fast check)
scripts/tune_flight.py           sweep detection settings against a cache
```

## Models

Both flights call models in the **jenniferworkspace** Roboflow workspace:

- post-storm: `jenniferworkspace/fallen-poles-ibm-2-rfdetr-seg-small-t1`
  (classes: `broken-wooden-pole`, `leaning-wooden-pole`, `wooden-pole`, `metal-pole`,
  `transformer`, `hit-transformer`, `tree`, `dense-vegetation`, `fallen-branch`, `street-sign`)
- pre-storm: `jenniferworkspace/dreamforce-ibm-3-rfdetr-seg-medium-t2`

Because detections are cached, the demo runs without hitting the API at all — verified by
running it from a clean clone with no `.env` present. A key is only needed to re-run
`precompute.py` or to drop in a new video via the Upload button.

## Known caveats

- The flight tracks are straight-line approximations of the road centreline (from OpenStreetMap),
  not the drone's real GPS. Pins sit along the corridor, not on surveyed pole positions. Refine
  with `scripts/calibrate_track.py` if you need exact placement.
- The post-storm clip is third-party reference footage; don't publish it or the demo recording
  externally without sorting out rights.
- Run the UI in a real browser window — the layout targets 1080p and up.
