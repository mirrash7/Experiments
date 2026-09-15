# Storm Response Command Center (Dreamforce demo)

Simulated live drone feed → Roboflow detection → map + live damage report → Salesforce dispatch.

## Run locally

```bash
# from the project root (uses .venv and .env with ROBOFLOW_API_KEY)
./.venv/bin/python3 -m uvicorn app.server:app --port 8000
# open http://localhost:8000
```

**Connect to live stream** plays the 2K flyover as if it were the drone's RTMP feed.
**Drop drone footage** processes any uploaded video the same way.

## Run with Docker

```bash
ROBOFLOW_API_KEY=... docker compose up --build
# offline stage mode (model served locally, no internet for inference):
ROBOFLOW_API_KEY=... docker compose --profile local-inference up --build
#   ...and set INFERENCE_URL=http://inference:9001 for the command-center service
```

Map tiles come from OpenStreetMap and need internet; everything else can run offline
with the local inference profile.

## Flights (clip + model + telemetry)

`app/flights.json` lists the drones shown in the fleet panel. Each entry pairs a clip with
the model that runs on it, its telemetry file, and optionally `api_key_env` (the `.env`
variable holding the API key for that model's workspace) and `alert_classes` (class names
that count as "line down"; by default any class containing `broken`). Dropped videos run
with the currently selected flight's model. Calibrate a flight's track with
`scripts/calibrate_track.py --video <clip> --telemetry <that flight's telemetry file>`.

## Pre-computed detections (stage mode)

`./.venv/bin/python3 scripts/precompute.py --flight <id>` runs the flight's model over the clip
once (same cadence/resolution as live) and stores the detections in the flight's `cache` file.
When that file exists, "Connect" replays it through the identical tracker/incident/screenshot
path — instant, deterministic, and with no network dependency for detection (map tiles still
need internet). Delete the cache file, or drop a video, to go back to live inference. Re-run
precompute after changing the model or the clip.

## Per-flight detection settings

`flights.json` entries take a `detection` block overriding the global gates for that clip:
`identity` ("gps" for an orbiting flight that revisits poles, "track" for a straight corridor
pass where the tracker — not a synthetic GPS fix — is the identity), `min_hits`,
`incident_conf`, `reacquire_s` (track mode: a new track appearing where a pole was seen this
recently is the same pole re-acquired), `incident_max_range_m`, `min_depression_deg`,
`dedupe_m`, `same_pole_m`. `scripts/tune_flight.py --flight <id> --target <n>` sweeps them
against the cached flight and prints what each combination would report.

## Curated scenes (what gets reported)

**Both flights report entirely off supplied renders.** `app/scenes/post-storm.json` lists the
five post-storm scenes and `app/scenes/pre-storm.json` the two pre-storm ones, with their
timestamps and `image` paths — `footage/final/stills/repair_plans/repair_plan_0*.png`,
rendered by `scripts/repair_plan_still.py` from the matching `plan_0*.json` specs. When playback
reaches a scene's `t` that report event fires and the supplied PNG is served byte-for-byte as its
repair plan; rewinding never adds or removes events. The detector still drives the feed (masks,
LINE DOWN labels, class filters) — it just does not decide the report. Rebuild the scene list after
editing a spec, or drop the `scenes` key from the flight to go back to detector-driven incidents.

## Pre-annotated clips

A flight with `"annotated": true` plays its clip untouched: no cache replay, no API call, and
nothing drawn over the video except the HUD line. Drone 1 uses it, because
`footage/final/springfield_pre-storm_annotated.mp4` already carries the model's own masks,
labels and counter panel in the pixels. The class filter bar hides itself for these flights
(the clip carries its own legend); the report still comes from the curated scene list.

The two pre-storm report events are maintenance, not storm damage: vegetation encroaching the
span (4.1 s) and a pole out of plumb (10.7 s), both `P2`. Their renders live in
`footage/final/stills/maintenance_plans/` — same renderer as the repair plans, titled
"Maintenance plan":

```bash
./.venv/bin/python3 scripts/repair_plan_still.py footage/final/stills/maintenance_plans/plan_pre_01.json
```

## Review / scrubbing

When the pass finishes the clip stays open in review mode: a scrub bar appears under the
feed, dragging it re-renders that frame (with its detections) and moves the map, and each
repair-plan card's timestamp is a link that jumps the playhead there. `POST /api/seek {"t": 12.5}`.

## Repair plans

Every reported pole gets a branded **repair plan** image: its best frame with each finding
boxed and numbered, the actions in the header bar (rendered by `app/assessment.py`, same
visual language as `scripts/pole_explainer.py`). Findings are RULES over the model's own
detections — how many fragments the pole broke into, a short pole-class box beside the span
(stump), a wide low span (conductors across the roadway), vegetation overlapping the span —
so each one names the detections it came from. They are inferences, not trained classes;
a model without e.g. a transformer class cannot produce a transformer finding.

The UI lists those actions beside the plan image; clicking the image opens a full-size view.
`GET /api/incidents/{id}/plan` serves the image, and the Salesforce payload carries
`findings` + `actions`.

## Restoring after a restart

Each run writes `app/runs/<session>/incidents.json`. On startup the server loads the most
recent one, so the repair plans (and their images) come back after a page refresh or a
server restart; `/api/state` reports `state: "archived"` until a new flight connects.

## Evidence and class filters

Each reported pole keeps its **best view**: every later sighting is scored (box area ×
confidence, penalised if cut off by the frame edge) and the screenshot is replaced when a
sighting scores ≥15% better — so the evidence ends up being the closest, cleanest look,
typically as the drone passes over. (Curated flights use the supplied render instead.)

The bar under the feed lists the classes the current model has emitted (with live counts);
click a class to hide/show it on the feed. Flights can preset the visible set with
`show_classes`; alert classes are always tracked for incidents even when hidden.

## Configuration (env vars)

| var | default | meaning |
|---|---|---|
| `MODEL_ID` | `alexei-alexandrovich/broken-powerlines-4-rfdetr-seg-small-t1` | Roboflow model |
| `INFERENCE_URL` | `https://serverless.roboflow.com` | or a local inference server |
| `DRONE_VIDEO` | the 2K flyover | video played by "Connect to live stream" |
| `INFER_EVERY` | 3 | run the model every Nth frame |
| `INFER_WORKERS` | 3 | parallel inference calls |
| `MIN_HITS` | 8 | confident detections (≥ `INCIDENT_CONF`) on one tracked pole before it is reported (detector-driven flights only; inference runs ~8×/s so 8 ≈ 1s of evidence) |
| `INCIDENT_CONF` | 0.70 | detections below this never count toward reporting |
| `DEDUPE_M` | 20 | merge a new fix into an existing incident within this many metres (+0.25× the incident's logged range); a closer re-observation refines the incident's position and screenshot |
| `INCIDENT_MAX_RANGE_M` | 30 | identity decisions only from fixes within this range; farther poles wait until the drone is closer |
| `MIN_DEPRESSION_DEG` | 25 | ...and only when the camera looks down at the pole by at least this angle (near-level views make projected range swing tens of metres per degree of tilt error) |
| `SAME_POLE_M` | 15 | two detections in the same frame closer than this are fragments of one pole; farther apart they are different poles and never merged |
| `FAST` | 0 | `1` disables real-time pacing (used by `scripts/headless_run.py`) |
| `DISPLAY_DELAY_S` | 0.45 | display lags capture by this much so masks land on the frame they were computed for (plus phase-correlation motion compensation); raise if masks trail, lower for snappier feed |
| `SF_WEBHOOK_URL` | (empty) | POST work orders here; empty = local inbox |

Flight track (GPS simulation) lives in `app/telemetry.json` — edit the waypoints to
relocate the demo. By default the video's duration is spread evenly along the path
(constant ground speed). Add `"t": <video seconds>` to every waypoint to pin the drone
to specific positions at specific times — that's how a track that doubles back on
itself is expressed (repeat earlier coordinates with later times). Each detection is
projected to the ground using the camera footprint.

## Calibrating the flight track (one-time, not part of the app)

```bash
./.venv/bin/python3 scripts/calibrate_track.py        # http://localhost:8010
```

Steps through the flyover every 5s (`--step`) on satellite imagery, pre-filled from
the current `telemetry.json`. Click the map to place the drone, Shift+click where the
camera is looking (sets heading), sliders for altitude / tilt, `[` `]` rotate 5°, `C`
copies the previous keyframe. **Save** writes `app/telemetry.json` (previous file is
backed up alongside it). The demo app picks the new track up on the next "Connect".

## Pole identity

Detections are tracked between inference frames by a motion-compensated tracker: the
global camera shift (phase correlation) plus each track's residual velocity predicts
where a pole will be, matching is IoU on that prediction with a centre-distance
fallback for thin poles, and missed tracks coast with the camera for up to 8 inference
frames. Worker results are applied strictly in frame order. A pole is reported after
`MIN_HITS` confident detections; revisits merge only within `DEDUPE_M` (+0.25× the
logged range) and never with a pole that is visible simultaneously as another track.

## Endpoints

- `POST /api/connect`, `POST /api/upload`, `POST /api/stop`
- `GET /stream.mjpg` annotated live video, `GET /events` server-sent events
- `GET /api/state`, `GET /api/report.json`, `GET /api/report.html`
- `GET /api/incidents/{id}/screenshot`
- `POST /api/salesforce/send` `{ids: [...]}` (all when omitted), `GET /api/salesforce/inbox`

Every run is saved under `app/runs/<session>/incidents/POLE-xxx.jpg`.

## Salesforce payload (per incident)

```json
{"event_type": "powerline_damage", "source": "DRONE-01", "incident_id": "POLE-003",
 "priority": "P1", "confidence": 0.79, "latitude": 26.98788, "longitude": -82.09596,
 "detected_at": "13:52:31", "video_time_s": 8.88,
 "required_crew": "line crew + bucket truck", "evidence_url": "/api/incidents/POLE-003/screenshot"}
```
