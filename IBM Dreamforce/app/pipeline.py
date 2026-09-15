"""Storm-response demo pipeline: simulated drone feed -> detections -> tracked
incidents with GPS + one screenshot per downed pole.
"""
import base64
import json
import math
import os
import queue
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from inference_sdk import InferenceHTTPClient

from app.assessment import assess, render_plan

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "app" / "runs"

MODEL_ID = os.environ.get("MODEL_ID", "alexei-alexandrovich/broken-powerlines-4-rfdetr-seg-small-t1")
INFERENCE_URL = os.environ.get("INFERENCE_URL", "https://serverless.roboflow.com")
INFER_WIDTH = int(os.environ.get("INFER_WIDTH", "1024"))   # downscale sent to model
DISPLAY_WIDTH = int(os.environ.get("DISPLAY_WIDTH", "1280"))
INFER_EVERY = int(os.environ.get("INFER_EVERY", "3"))        # frames between inferences
WORKERS = int(os.environ.get("INFER_WORKERS", "3"))
# A pole is reported as down only after MIN_HITS detections at >= INCIDENT_CONF
# on the same track (hits are inference frames, ~8/s, so 8 ≈ one second of
# consistent, confident evidence). Until then the feed shows "ASSESSING n/N".
MIN_HITS = int(os.environ.get("MIN_HITS", "8"))
INCIDENT_CONF = float(os.environ.get("INCIDENT_CONF", "0.70"))
# Identity decisions are made only from close-range fixes: beyond
# INCIDENT_MAX_RANGE_M the ground projection error is too large to tell one
# pole from its neighbour, so far poles are shown as TRACKING until the drone
# gets closer, and revisit merges use a tight radius.
DEDUPE_M = float(os.environ.get("DEDUPE_M", "20"))
INCIDENT_MAX_RANGE_M = float(os.environ.get("INCIDENT_MAX_RANGE_M", "30"))
# ...and only when looking down steeply enough: in a near-level view the
# projected range swings tens of metres per degree of tilt error.
MIN_DEPRESSION_DEG = float(os.environ.get("MIN_DEPRESSION_DEG", "25"))
SAME_POLE_M = float(os.environ.get("SAME_POLE_M", "15"))    # simultaneous detections closer than this = one pole
FAST = os.environ.get("FAST", "0") == "1"                    # no real-time pacing (testing)
# Display runs this far behind capture so masks land on the frame they were
# computed for (typical inference round-trip ~0.25s); residual motion between
# the inferred frame and the shown frame is corrected by phase correlation.
DISPLAY_DELAY_S = float(os.environ.get("DISPLAY_DELAY_S", "0.45"))
ALIGN_WIDTH = 320
ALERT_CLASS = "broken-powerlines"  # default; per-flight alert classes override (see flights.json)
ALERT_COLOR = (60, 60, 255)   # BGR red
POLE_COLOR = (206, 6, 103)    # BGR Roboflow purple
# other classes a model may emit (trees, signs, ...) get a stable colour by name
PALETTE = [(80, 200, 80), (0, 190, 255), (255, 170, 60), (200, 120, 255), (60, 220, 220), (160, 160, 160)]
# best-image selection: re-shoot a reported pole when a new sighting scores this
# much better (score = box area × confidence × edge penalty) — at most twice a second
BEST_GAIN = 1.15
BEST_MIN_INTERVAL_S = 0.5

# BGR: Roboflow purple for intact poles, alert red for damage
COLORS = {"broken-powerlines": (60, 60, 255), "pole": (206, 6, 103)}


def load_api_key(var="ROBOFLOW_API_KEY"):
    """Read an API key from the environment or the project .env (per-flight
    models can live in other workspaces and need that workspace's key)."""
    key = os.environ.get(var)
    if key:
        return key
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith(f"{var}="):
                return line.split("=", 1)[1].strip()
    if var != "ROBOFLOW_API_KEY":
        raise RuntimeError(f"{var} not set in .env — needed for this flight's model")
    raise SystemExit("ROBOFLOW_API_KEY not set")


def load_flights():
    """Flight catalog (clip + model + telemetry); falls back to the env defaults."""
    cfg = ROOT / "app" / "flights.json"
    if cfg.exists():
        flights = json.loads(cfg.read_text())["flights"]
    else:
        flights = [{"id": "default", "drone_id": "DRONE-01", "name": "Drone flight",
                    "video": os.environ.get("DRONE_VIDEO", ""), "model_id": MODEL_ID,
                    "telemetry": "app/telemetry.json"}]
    for f in flights:
        f["video_path"] = str((ROOT / f["video"]).resolve()) if not os.path.isabs(f["video"]) else f["video"]
        f["available"] = os.path.exists(f["video_path"])
        f["telemetry_path"] = str(ROOT / f.get("telemetry", "app/telemetry.json"))
        f.setdefault("alert_classes", None)
        f.setdefault("api_key_env", "ROBOFLOW_API_KEY")
    return flights


# --------------------------------------------------------------------------
# Telemetry: simulated flight track (waypoints) -> position at any time
# --------------------------------------------------------------------------
class Telemetry:
    def __init__(self, path=ROOT / "app" / "telemetry.json"):
        cfg = json.loads(Path(path).read_text())
        self.drone_id = cfg.get("drone_id", "DRONE-01")
        self.altitude_m = cfg.get("altitude_m", 60)
        self.fov_w_m = cfg.get("footprint_width_m", 110)
        self.fov_d_m = cfg.get("footprint_depth_m", 70)
        self.wps = [(w["lat"], w["lon"]) for w in cfg["waypoints"]]
        # optional per-waypoint video time (seconds) — lets the track double
        # back on itself at the right moments; otherwise constant ground speed
        self.times = [w.get("t") for w in cfg["waypoints"]]
        self.timed = all(t is not None for t in self.times) and len(self.wps) > 1
        # optional per-waypoint camera heading (deg) and altitude (m AGL)
        self.hdgs = [w.get("hdg") for w in cfg["waypoints"]]
        self.alts = [w.get("alt") for w in cfg["waypoints"]]
        self.tilts = [w.get("tilt") for w in cfg["waypoints"]]
        self.has_hdg = all(h is not None for h in self.hdgs)
        self.has_alt = all(a is not None for a in self.alts)
        self.has_tilt = all(x is not None for x in self.tilts) and self.has_alt
        self.ref_alt = cfg.get("footprint_ref_alt_m", self.altitude_m)
        self.hfov = math.radians(cfg.get("camera_hfov_deg", 61))
        self.vfov = math.radians(cfg.get("camera_vfov_deg", 36))
        self.max_range = cfg.get("max_range_m", 150)
        self.duration = None
        self._dist = [0.0]
        for a, b in zip(self.wps, self.wps[1:]):
            self._dist.append(self._dist[-1] + self.haversine(a, b))

    @staticmethod
    def haversine(a, b):
        R = 6371000.0
        la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
        h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
        return 2 * R * math.asin(math.sqrt(h))

    def set_duration(self, seconds):
        self.duration = max(seconds, 1.0)

    def _segment(self, t):
        """Index i and fraction f along segment wps[i-1] -> wps[i] at time t."""
        if self.timed:
            t = min(max(t, self.times[0]), self.times[-1])
            for i in range(1, len(self.times)):
                if t <= self.times[i] or i == len(self.times) - 1:
                    span = self.times[i] - self.times[i - 1] or 1e-9
                    return i, min(max((t - self.times[i - 1]) / span, 0.0), 1.0)
        total = self._dist[-1]
        d = total * min(max(t / self.duration, 0.0), 1.0)
        for i in range(1, len(self._dist)):
            if d <= self._dist[i] or i == len(self._dist) - 1:
                seg = self._dist[i] - self._dist[i - 1] or 1e-9
                return i, min(max((d - self._dist[i - 1]) / seg, 0.0), 1.0)
        return len(self.wps) - 1, 1.0

    def position(self, t):
        """(lat, lon, heading_deg) at video time t."""
        i, f = self._segment(t)
        a, b = self.wps[i - 1], self.wps[i]
        lat = a[0] + (b[0] - a[0]) * f
        lon = a[1] + (b[1] - a[1]) * f
        if self.has_hdg:
            h0, h1 = self.hdgs[i - 1], self.hdgs[i]
            d = ((h1 - h0 + 180) % 360) - 180  # shortest arc
            heading = (h0 + d * f) % 360
        else:
            heading = math.degrees(math.atan2(
                (b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])) % 360
        return lat, lon, heading

    def altitude(self, t):
        if not self.has_alt:
            return self.altitude_m
        i, f = self._segment(t)
        return self.alts[i - 1] + (self.alts[i] - self.alts[i - 1]) * f

    def tilt(self, t):
        i, f = self._segment(t)
        return self.tilts[i - 1] + (self.tilts[i] - self.tilts[i - 1]) * f

    def project(self, t, cx_norm, cy_norm):
        """Ground position of a detection at normalized frame coords.

        Returns (lat, lon, range_m, depression_deg). With camera tilt known,
        uses a pinhole model: rows near the bottom of the frame look steeply
        down (close), rows near the horizon look far (clamped to max_range).
        Without tilt, falls back to a flat footprint scaled by altitude.
        """
        lat, lon, heading = self.position(t)
        alt = max(self.altitude(t), 2.0)
        if self.has_tilt:
            dep = math.radians(self.tilt(t)) + (cy_norm - 0.5) * self.vfov  # depression angle
            if dep < math.radians(2.5):
                fwd = self.max_range
            else:
                fwd = min(alt / math.tan(dep), self.max_range)
            slant = math.hypot(fwd, alt)
            right = slant * math.tan((cx_norm - 0.5) * self.hfov)
        else:
            k = alt / self.ref_alt
            fwd = (0.5 - cy_norm) * self.fov_d_m * k
            right = (cx_norm - 0.5) * self.fov_w_m * k
            dep = math.atan2(alt, max(fwd, 1e-6))
        h = math.radians(heading)
        north = fwd * math.cos(h) - right * math.sin(h)
        east = fwd * math.sin(h) + right * math.cos(h)
        dlat = north / 111320.0
        dlon = east / (111320.0 * math.cos(math.radians(lat)))
        return lat + dlat, lon + dlon, math.hypot(fwd, right), math.degrees(dep)

    @property
    def speed_mps(self):
        if self.timed:
            span = self.times[-1] - self.times[0]
            return self._dist[-1] / span if span else 0.0
        return self._dist[-1] / self.duration if self.duration else 0.0


# --------------------------------------------------------------------------
# Tracker: greedy IoU association over sparse inference frames
# --------------------------------------------------------------------------
def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    iw = max(0, min(ax2, bx2) - max(ax1, bx1))
    ih = max(0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def _shift_box(b, dx, dy):
    return (b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy)


class Tracker:
    """Motion-compensated tracker for sparse inference frames.

    Every track is first *predicted* into the new frame: the global camera
    shift (phase correlation between consecutive inferred frames) plus the
    track's own residual velocity. Matching is IoU on the predicted box, with
    a centre-distance fallback for small/thin poles. Missed tracks keep being
    carried by the camera motion so a pole re-acquires its own ID after a
    brief dropout instead of spawning a new track.
    """

    def __init__(self, iou_thresh=0.25, max_misses=8):
        self.iou_thresh = iou_thresh
        self.max_misses = max_misses
        self.tracks = {}
        self._next = 1

    def update(self, dets, shift=(0.0, 0.0)):
        dx, dy = shift
        for tr in self.tracks.values():
            vx, vy = tr["vel"]
            tr["pred"] = _shift_box(tr["box"], dx + vx, dy + vy)

        pairs = []
        for di, d in enumerate(dets):
            for tid, tr in self.tracks.items():
                if tr["class"] != d["class"]:
                    continue
                s = iou(tr["pred"], d["box"])
                if s < self.iou_thresh:
                    # thin poles barely overlap after a pan; allow a centre match
                    px, py = (tr["pred"][0] + tr["pred"][2]) / 2, (tr["pred"][1] + tr["pred"][3]) / 2
                    cx, cy = (d["box"][0] + d["box"][2]) / 2, (d["box"][1] + d["box"][3]) / 2
                    size = max(tr["pred"][2] - tr["pred"][0], tr["pred"][3] - tr["pred"][1], 20)
                    dist = math.hypot(px - cx, py - cy)
                    if dist < 0.75 * size:
                        s = self.iou_thresh + 0.01 * (1 - dist / (0.75 * size))
                if s >= self.iou_thresh:
                    pairs.append((s, di, tid))
        pairs.sort(reverse=True)

        used_d, unmatched = set(), set(self.tracks)
        for s, di, tid in pairs:
            if di in used_d or tid not in unmatched:
                continue
            tr = self.tracks[tid]
            pb, nb = tr["pred"], dets[di]["box"]
            resid = ((nb[0] + nb[2] - pb[0] - pb[2]) / 2, (nb[1] + nb[3] - pb[1] - pb[3]) / 2)
            tr.update(box=nb, hits=tr["hits"] + 1, misses=0,
                      vel=(0.5 * tr["vel"][0] + 0.5 * resid[0], 0.5 * tr["vel"][1] + 0.5 * resid[1]))
            dets[di]["track"] = tr
            used_d.add(di)
            unmatched.discard(tid)
        for di, d in enumerate(dets):
            if di not in used_d:
                tr = {"id": self._next, "class": d["class"], "box": d["box"], "vel": (0.0, 0.0),
                      "hits": 1, "conf_hits": 0, "misses": 0, "incident": None}
                self.tracks[self._next] = tr
                d["track"] = tr
                self._next += 1
        for tid in unmatched:
            tr = self.tracks[tid]
            tr["misses"] += 1
            tr["box"] = tr["pred"]  # coast with the camera
            if tr["misses"] > self.max_misses:
                del self.tracks[tid]
        return dets


# --------------------------------------------------------------------------
# Session: one video run (drone-sim or upload)
# --------------------------------------------------------------------------
class Session:
    def __init__(self, video_path, mode="drone", telemetry=None, flight=None):
        self.id = time.strftime("%Y%m%d-%H%M%S")
        self.video_path = str(video_path)
        self.mode = mode
        self.flight = flight or {}
        self.model_id = self.flight.get("model_id") or MODEL_ID
        alert = self.flight.get("alert_classes")
        self.alert_classes = set(alert) if alert else None  # None -> any class containing "broken"
        det_cfg = self.flight.get("detection", {})
        self.min_hits = int(det_cfg.get("min_hits", MIN_HITS))
        self.incident_conf = float(det_cfg.get("incident_conf", INCIDENT_CONF))
        self.max_range_m = float(det_cfg.get("incident_max_range_m", INCIDENT_MAX_RANGE_M))
        self.min_depression = float(det_cfg.get("min_depression_deg", MIN_DEPRESSION_DEG))
        self.dedupe_m = float(det_cfg.get("dedupe_m", DEDUPE_M))
        self.same_pole_m = float(det_cfg.get("same_pole_m", SAME_POLE_M))
        # identity: "gps" suits an orbiting flight that revisits poles; "track" suits a
        # straight corridor pass, where each physical pole is seen once and the tracker
        # (not a synthetic GPS fix) is the reliable identity.
        self.identity = det_cfg.get("identity", "gps")
        self.reacquire_s = float(det_cfg.get("reacquire_s", 2.0))
        # curated scenes: exactly these incidents are reported, at these times, with this
        # wording — the detector still runs the feed, it just does not decide the report
        self.scenes, self.scenes_fired = [], set()
        sc = self.flight.get("scenes")
        if sc and (ROOT / sc).exists():
            self.scenes = json.loads((ROOT / sc).read_text())["scenes"]
        show = self.flight.get("show_classes")
        self.show_classes = set(show) if show else None    # default-visible classes (None -> all)
        self.hidden_classes = set()                        # toggled from the UI class filter bar
        self.classes_seen = {}                             # class -> total detections (for the filter bar)
        tel_path = self.flight.get("telemetry_path")
        self.tel = telemetry or (Telemetry(tel_path) if tel_path else Telemetry())
        if self.flight.get("drone_id"):
            self.tel.drone_id = self.flight["drone_id"]  # flights share a track file; the badge/HUD use the flight's name
        self.dir = RUNS / self.id
        (self.dir / "incidents").mkdir(parents=True, exist_ok=True)

        # pre-computed detections (scripts/precompute.py): replayed instead of
        # calling the API, so the demo is instant and network-independent
        self.cache = None
        cache_path = self.flight.get("cache")
        if cache_path and (ROOT / cache_path).exists() and mode == "drone":
            data = json.loads((ROOT / cache_path).read_text())
            self.cache = {int(k): v for k, v in data["frames"].items()}
        # a clip whose detections are already burned into the pixels: play it as
        # shot and draw nothing over the top, so the model's own render is what
        # the room sees. The report still comes from the curated scene list.
        self.annotated = bool(self.flight.get("annotated")) and mode == "drone"
        self.client = None
        if self.cache is None and not self.annotated:
            self.client = InferenceHTTPClient(
                api_url=INFERENCE_URL,
                api_key=load_api_key(self.flight.get("api_key_env", "ROBOFLOW_API_KEY")))
        self.pool = ThreadPoolExecutor(max_workers=WORKERS)
        self.in_flight = 0
        self.in_flight_frames = set()  # frame indices awaiting a result
        self.pending = {}              # finished results waiting for in-order apply
        self._seek = None              # review-mode scrub target (seconds)
        self.last_gray = None          # gray of the last *applied* inferred frame
        self.tracker = Tracker()

        self.running = False
        self.finished = False
        self.frame_idx = 0
        self.fps = 30.0
        self.duration = 0.0
        self.latest_jpeg = None
        self.latest_preds = []        # display-space predictions (newest inference)
        self.pred_history = []        # [{frame, dets, gray}] recent inferences
        self.buffer = []              # [(frame_idx, t, disp, gray)] awaiting display
        self.latency = 0.0
        self.stats = {"frames": 0, "inferences": 0, "detections": 0, "infer_fps": 0.0}
        self.incidents = {}
        self.assoc_log = []  # how each pole got its identity (debug/tuning)
        self.subscribers = []
        self.lock = threading.RLock()
        self.inc_lock = threading.Lock()  # serialize de-dup + create across workers
        self._infer_times = []

    # ---- classes ----
    def is_alert(self, cls):
        if self.alert_classes is not None:
            return cls in self.alert_classes
        return "broken" in cls.lower() or cls == ALERT_CLASS

    def color(self, cls):
        if self.is_alert(cls):
            return ALERT_COLOR
        if "pole" in cls.lower():
            return POLE_COLOR
        return PALETTE[sum(map(ord, cls)) % len(PALETTE)]

    def note_class(self, cls):
        """First sighting of a class: default it hidden unless the flight lists it."""
        if cls not in self.classes_seen:
            self.classes_seen[cls] = 0
            if self.show_classes is not None and cls not in self.show_classes and not self.is_alert(cls):
                self.hidden_classes.add(cls)
        self.classes_seen[cls] += 1

    def visible(self, cls):
        return cls not in self.hidden_classes

    # ---- pub/sub for SSE ----
    def subscribe(self):
        q = queue.Queue(maxsize=200)
        self.subscribers.append(q)
        return q

    def unsubscribe(self, q):
        if q in self.subscribers:
            self.subscribers.remove(q)

    def emit(self, event):
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    # ---- lifecycle ----
    def start(self):
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self.running = False

    def seek(self, t):
        """Scrub to `t` seconds (review mode, after the pass has finished)."""
        self._seek = max(0.0, min(float(t), self.duration or 0))

    def _loop(self):
        cap = cv2.VideoCapture(self.video_path)
        self.fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.duration = n / self.fps
        self.tel.set_duration(self.duration)
        self.emit({"type": "status", "state": "connected", "mode": self.mode,
                   "drone_id": self.tel.drone_id, "fps": self.fps,
                   "duration": self.duration, "model": self.model_id,
                   "flight": self.flight.get("id"), "flight_name": self.flight.get("name"),
                   "cached": self.cache is not None or self.annotated,
                   "annotated": self.annotated})
        t0 = time.time()
        last_tel = 0.0
        while self.running:
            ok, frame = cap.read()
            if not ok:
                break
            t = self.frame_idx / self.fps
            h, w = frame.shape[:2]
            scale = DISPLAY_WIDTH / w
            disp = cv2.resize(frame, (DISPLAY_WIDTH, int(h * scale)))

            if self.cache is not None and self.frame_idx in self.cache:
                # replay pre-computed detections through the same tracker/incident path
                dets = [{"class": d["class"], "confidence": d["confidence"], "box": tuple(d["box"]),
                         "points": [tuple(p) for p in d["points"]]} for d in self.cache[self.frame_idx]]
                for d in dets:
                    self.note_class(d["class"])
                with self.lock:
                    self.pending[self.frame_idx] = {"dets": dets, "gray": self._gray(disp), "frame": frame,
                                                    "dw": disp.shape[1], "dh": disp.shape[0], "t": t,
                                                    "t_sub": time.time()}
                    self._drain()
            elif (self.cache is None and not self.annotated and self.frame_idx % INFER_EVERY == 0
                  and self.in_flight < WORKERS and self.running):
                self.in_flight += 1
                with self.lock:
                    self.in_flight_frames.add(self.frame_idx)
                try:
                    self.pool.submit(self._infer, frame, disp.shape[1], disp.shape[0],
                                     self.frame_idx, t, time.time())
                except RuntimeError:  # pool shut down while stopping
                    self.in_flight -= 1
                    break

            for sc in self.scenes:
                if sc["id"] not in self.scenes_fired and t >= sc["t"]:
                    self.scenes_fired.add(sc["id"])
                    with self.inc_lock:
                        self._scene_incident(sc, frame, disp.shape[1], disp.shape[0], t)
            # hold frames briefly so detections can catch up, then show the
            # oldest one with the inference nearest to it
            self.buffer.append((self.frame_idx, t, disp, self._gray(disp)))
            delay_frames = max(1, int(DISPLAY_DELAY_S * self.fps))
            shown_t = t
            if len(self.buffer) > delay_frames:
                s_idx, shown_t, s_disp, s_gray = self.buffer.pop(0)
                preds, shift = self._preds_for(s_idx, s_gray)
                out = self._render(s_disp, shown_t, preds, shift)
                ok2, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok2:
                    self.latest_jpeg = buf.tobytes()
            self.stats["frames"] += 1

            if shown_t - last_tel >= 0.5:
                t = shown_t  # keep map + HUD in sync with what is on screen
                lat, lon, hd = self.tel.position(t)
                self.emit({"type": "telemetry", "t": round(t, 2), "lat": lat, "lon": lon,
                           "heading": hd, "alt_m": round(self.tel.altitude(t)),
                           "speed_mps": round(self.tel.speed_mps, 1),
                           "stats": dict(self.stats), "latency": round(self.latency, 2),
                           "active_detections": len(self.latest_preds),
                           "classes": {c: {"live": sum(1 for p in self.latest_preds if p["class"] == c),
                                           "total": n, "alert": self.is_alert(c),
                                           "hidden": c in self.hidden_classes,
                                           "color": "#%02x%02x%02x" % self.color(c)[::-1]}
                                       for c, n in self.classes_seen.items()}})
                last_tel = t

            # pace to native fps
            self.frame_idx += 1
            target = t0 + self.frame_idx / self.fps
            delay = target - time.time()
            if delay > 0 and not FAST:
                time.sleep(delay)
            elif FAST:
                while self.in_flight >= WORKERS:  # don't outrun inference
                    time.sleep(0.005)
        self.finished = True
        self.emit({"type": "status", "state": "ended", "incidents": len(self.incidents),
                   "duration": self.duration, "seekable": True})
        # review mode: keep the clip open so it can be scrubbed back through
        while self.running:
            if self._seek is None:
                time.sleep(0.05)
                continue
            t_seek, self._seek = self._seek, None
            idx = max(0, min(n - 1, int(t_seek * self.fps)))
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                continue
            h, w = frame.shape[:2]
            disp = cv2.resize(frame, (DISPLAY_WIDTH, int(h * DISPLAY_WIDTH / w)))
            preds, _ = self._preds_for(idx, self._gray(disp))
            out = self._render(disp, idx / self.fps, preds)
            ok2, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok2:
                self.latest_jpeg = buf.tobytes()
            lat, lon, hd = self.tel.position(idx / self.fps)
            self.emit({"type": "telemetry", "t": round(idx / self.fps, 2), "lat": lat, "lon": lon,
                       "heading": hd, "alt_m": round(self.tel.altitude(idx / self.fps)),
                       "speed_mps": 0, "stats": dict(self.stats), "latency": 0,
                       "active_detections": len(preds), "review": True,
                       "classes": {c: {"live": sum(1 for p in preds if p["class"] == c), "total": n2,
                                       "alert": self.is_alert(c), "hidden": c in self.hidden_classes,
                                       "color": "#%02x%02x%02x" % self.color(c)[::-1]}
                                   for c, n2 in self.classes_seen.items()}})
        cap.release()
        self.running = False

    # ---- inference worker ----
    def _infer(self, frame, dw, dh, frame_idx, t, t_sub):
        try:
            h, w = frame.shape[:2]
            s = INFER_WIDTH / w
            small = cv2.resize(frame, (INFER_WIDTH, int(h * s)))
            r = self.client.infer(small, model_id=self.model_id)
            preds = r.get("predictions", [])
            k = dw / INFER_WIDTH  # infer-space -> display-space
            dets = []
            for p in preds:
                self.note_class(p["class"])
                pts = [(q["x"] * k, q["y"] * k) for q in p.get("points", [])]
                x1 = (p["x"] - p["width"] / 2) * k
                y1 = (p["y"] - p["height"] / 2) * k
                x2 = (p["x"] + p["width"] / 2) * k
                y2 = (p["y"] + p["height"] / 2) * k
                dets.append({"class": p["class"], "confidence": p["confidence"],
                             "box": (x1, y1, x2, y2), "points": pts})
            with self.lock:
                self.pending[frame_idx] = {"dets": dets, "gray": self._gray(small), "frame": frame,
                                           "dw": dw, "dh": dh, "t": t, "t_sub": t_sub}
                self.in_flight_frames.discard(frame_idx)
                self._drain()
        except Exception as e:
            print("infer error:", e)
            with self.lock:
                self.in_flight_frames.discard(frame_idx)
        finally:
            self.in_flight -= 1

    def _drain(self):
        """Apply finished results to the tracker strictly in frame order —
        workers finish out of order, and a tracker fed frames 6, 3, 9 swaps IDs."""
        while self.pending:
            oldest = min(self.pending)
            if self.in_flight_frames and min(self.in_flight_frames) < oldest:
                return  # an earlier frame is still being inferred
            r = self.pending.pop(oldest)
            shift = (0.0, 0.0)
            if self.last_gray is not None and self.last_gray.shape == r["gray"].shape:
                (dx, dy), resp = cv2.phaseCorrelate(self.last_gray, r["gray"])
                if resp >= 0.05:
                    k = DISPLAY_WIDTH / ALIGN_WIDTH
                    shift = (dx * k, dy * k)
            self.last_gray = r["gray"]
            dets = self.tracker.update(r["dets"], shift)
            self.latest_preds = dets
            self.pred_history.append({"frame": oldest, "dets": dets, "gray": r["gray"]})
            self.pred_history = self.pred_history[-12:]
            self.latency = time.time() - r["t_sub"]
            self.stats["inferences"] += 1
            self.stats["detections"] += len(dets)
            self._infer_times.append(time.time())
            self._infer_times = self._infer_times[-20:]
            if len(self._infer_times) > 1:
                span = self._infer_times[-1] - self._infer_times[0]
                self.stats["infer_fps"] = round((len(self._infer_times) - 1) / span, 1) if span else 0
            for d in dets:
                tr = d["track"]
                if not self.is_alert(d["class"]):
                    continue
                if d["confidence"] >= self.incident_conf:
                    tr["conf_hits"] += 1
                else:
                    continue  # the frame that opens an incident must itself be confident
                if self.scenes:
                    continue      # curated flight: the scene list is the report
                if tr["conf_hits"] >= self.min_hits and tr["incident"] is None:
                    with self.inc_lock:
                        self._open_incident(d, dets, r["frame"], r["dw"], r["dh"], oldest, r["t"])
                elif tr["incident"] in self.incidents:
                    inc_seen = self.incidents[tr["incident"]]
                    inc_seen["last_box"], inc_seen["last_t"] = d["box"], r["t"]
                    # already reported: keep the best view of it (closest, fully in frame)
                    with self.inc_lock:
                        self._consider_best(self.incidents[tr["incident"]], d, dets, r["frame"], r["dw"], r["dh"], r["t"])

    def _open_incident(self, det, dets, frame, dw, dh, frame_idx, t):
        x1, y1, x2, y2 = det["box"]
        cx, cy = (x1 + x2) / 2 / dw, y2 / dh  # base of the box = where it meets the ground
        lat, lon, rng, dep = self.tel.project(t, cx, cy)
        log = lambda action: self.assoc_log.append(
            {"t": round(t, 1), "track": det["track"]["id"], "range": round(rng), "action": action})
        if rng > self.max_range_m or dep < self.min_depression:
            return  # too far / too shallow for a reliable fix; try again as we get closer
        # Other poles visible in this same frame share the drone pose, so their
        # *relative* ground distance is reliable: closer than SAME_POLE_M means
        # this is a fragment detection of an already-logged pole; farther means
        # a genuinely different pole that must never be merged with it.
        with self.lock:
            others = [(tr["incident"], tr["box"]) for tr in self.tracker.tracks.values()
                      if tr["misses"] == 0 and tr["id"] != det["track"]["id"] and tr["incident"]]
        different_poles = set()
        for inc_id, (ox1, oy1, ox2, oy2) in others:
            olat, olon, _, _ = self.tel.project(t, (ox1 + ox2) / 2 / dw, oy2 / dh)
            dd = Telemetry.haversine((lat, lon), (olat, olon))
            if dd < self.same_pole_m:
                det["track"]["incident"] = inc_id
                log(f"fragment of {inc_id} ({dd:.0f} m apart in-frame)")
                return
            different_poles.add(inc_id)
        if self.identity == "track":
            # a fresh track that appears where a recently-seen pole was is the same
            # pole re-acquired after a dropout, not a new one
            for inc in self.incidents.values():
                if inc["id"] in different_poles or "last_box" not in inc:
                    continue
                if t - inc.get("last_t", -99) > self.reacquire_s:
                    continue
                a, b = det["box"], inc["last_box"]
                ov = iou(a, b)
                near = math.hypot((a[0] + a[2] - b[0] - b[2]) / 2, (a[1] + a[3] - b[1] - b[3]) / 2) < 0.08 * dw
                if ov > 0.2 or near:
                    det["track"]["incident"] = inc["id"]
                    inc["last_box"], inc["last_t"] = det["box"], t
                    log(f"re-acquired {inc['id']} (IoU {ov:.2f})")
                    return
            iid = f"POLE-{len(self.incidents) + 1:03d}"
            det["track"]["incident"] = iid
            log(f"new {iid} [track identity]")
            self._create_incident(iid, det, dets, frame, dw, dh, frame_idx, t, lat, lon, rng)
            return

        # GPS de-dup for revisits: the drone circles and the same pole re-enters.
        # A fix logged from far away is imprecise, so its merge radius grows
        # with range; a closer re-observation refines the incident.
        for inc in self.incidents.values():
            if inc["id"] in different_poles:
                continue
            radius = self.dedupe_m + 0.25 * inc["range_m"]
            dist = Telemetry.haversine((lat, lon), (inc["lat"], inc["lon"]))
            if dist < radius:
                det["track"]["incident"] = inc["id"]
                log(f"revisit merge -> {inc['id']} ({dist:.0f} m, radius {radius:.0f} m)")
                if rng < inc["range_m"] * 0.5:
                    self._refine_incident(inc, det, frame, dw, lat, lon, rng, t)
                return
        iid = f"POLE-{len(self.incidents) + 1:03d}"
        det["track"]["incident"] = iid
        log(f"new {iid}")
        self._create_incident(iid, det, dets, frame, dw, dh, frame_idx, t, lat, lon, rng)

    def _create_incident(self, iid, det, dets, frame, dw, dh, frame_idx, t, lat, lon, rng):
        path = self._screenshot(iid, det, frame, dw)
        findings = assess(det, dets, dw, dh, self.is_alert)
        plan = self._plan(iid, findings, frame, dw)
        inc = {"id": iid, "findings": findings, "actions": list(dict.fromkeys(f["action"] for f in findings)),
               "plan": str(plan), "class": det["class"], "confidence": round(det["confidence"], 3),
               "t": round(t, 2), "frame": frame_idx, "lat": lat, "lon": lon, "range_m": round(rng),
               "best_score": self._view_score(det, dw, dh), "best_t": round(t, 2), "best_range_m": round(rng),
               "best_shot_at": time.time(),
               "first_seen": time.strftime("%H:%M:%S"), "screenshot": str(path),
               "last_box": det["box"], "last_t": t,
               "severity": "P1" if det["confidence"] > 0.75 else "P2",
               "status": "detected", "drone_id": self.tel.drone_id}
        self.incidents[iid] = inc
        self._persist()
        self.emit({"type": "incident", **self.public_incident(inc)})

    def _persist(self):
        """Write the run's incidents to disk so the UI can restore them later."""
        try:
            (self.dir / "incidents.json").write_text(json.dumps({
                "session": self.id, "flight": self.flight.get("id"), "model": self.model_id,
                "drone_id": self.tel.drone_id, "saved": time.strftime("%Y-%m-%d %H:%M:%S"),
                "incidents": list(self.incidents.values())}, default=str))
        except Exception as e:
            print("persist failed:", e)

    def _screenshot(self, iid, det, frame, dw):
        """Crop the pole from the full-res frame with its mask overlay."""
        h, w = frame.shape[:2]
        k = w / dw
        bx1, by1, bx2, by2 = [v * k for v in det["box"]]
        mx = max((bx2 - bx1) * 0.5, 250)
        my = max((by2 - by1) * 0.5, 250)
        cx1, cy1 = int(max(0, bx1 - mx)), int(max(0, by1 - my))
        cx2, cy2 = int(min(w, bx2 + mx)), int(min(h, by2 + my))
        crop = frame[cy1:cy2, cx1:cx2].copy()
        if det["points"]:
            arr = np.array([[int(px * k - cx1), int(py * k - cy1)] for px, py in det["points"]])
            overlay = crop.copy()
            cv2.fillPoly(overlay, [arr], ALERT_COLOR)
            cv2.addWeighted(overlay, 0.35, crop, 0.65, 0, crop)
            cv2.polylines(crop, [arr], True, ALERT_COLOR, 3)
        path = self.dir / "incidents" / f"{iid}.jpg"
        tmp = path.with_suffix(".tmp.jpg")  # atomic swap: the UI may be fetching the old file
        cv2.imwrite(str(tmp), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        os.replace(tmp, path)
        return path

    def _scene_incident(self, sc, frame, dw, dh, t):
        """Report one curated scene: its own wording, and its supplied plan image if it has one."""
        iid = sc["id"]
        if iid in self.incidents:
            return
        with self.lock:
            preds = [p for p in self.latest_preds if self.is_alert(p["class"])]
        det = max(preds, key=lambda p: (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1])) if preds else None
        findings = []
        for i, f in enumerate(sc.get("findings", []), 1):
            box = f.get("box") or (det["box"] if det else (0.15 * dw, 0.55 * dh, 0.85 * dw, 0.85 * dh))
            findings.append({"n": i, "title": f["title"], "action": f["action"],
                             "box": tuple(box), "evidence": f.get("evidence", "curated scene")})
        lat, lon, rng, _ = self.tel.project(t, 0.5, 0.8)
        path = self.dir / "incidents" / f"{iid}.jpg"
        supplied = sc.get("image")
        if supplied and (ROOT / supplied).exists():
            plan = str(ROOT / supplied)                      # serve the supplied render verbatim
            cv2.imwrite(str(path), cv2.resize(frame, (dw, dh)), [cv2.IMWRITE_JPEG_QUALITY, 88])
        else:
            if det:
                self._screenshot(iid, det, frame, dw)
            else:
                cv2.imwrite(str(path), cv2.resize(frame, (dw, dh)), [cv2.IMWRITE_JPEG_QUALITY, 88])
            plan = str(self._plan(iid, findings, frame, dw))
        conf = round(det["confidence"], 3) if det else 0.9
        inc = {"id": iid, "class": sc.get("title", "downed pole"), "confidence": conf,
               "t": round(t, 2), "frame": self.frame_idx, "lat": lat, "lon": lon, "range_m": round(rng),
               "best_score": 1e9, "best_t": round(t, 2), "best_range_m": round(rng), "best_shot_at": time.time(),
               "first_seen": time.strftime("%H:%M:%S"), "screenshot": str(path), "plan": plan,
               "findings": findings, "actions": list(dict.fromkeys(f["action"] for f in findings)),
               "title": sc.get("title"), "severity": sc.get("severity", "P1"), "status": "detected",
               "drone_id": self.tel.drone_id, "curated": True}
        self.incidents[iid] = inc
        self._persist()
        self.emit({"type": "incident", **self.public_incident(inc)})

    def _plan(self, iid, findings, frame, dw):
        """Branded repair-plan image for this pole (numbered findings + actions)."""
        path = self.dir / "incidents" / f"{iid}_plan.jpg"
        try:
            return render_plan(frame, findings, iid, dw, path)
        except Exception as e:
            print("plan render failed:", e)
            return path

    def _refine_incident(self, inc, det, frame, dw, lat, lon, rng, t):
        """A much closer look at a logged pole: better position fix."""
        if inc["status"] == "dispatched":
            return
        inc.update(lat=lat, lon=lon, range_m=round(rng),
                   confidence=max(inc["confidence"], round(det["confidence"], 3)),
                   severity="P1" if max(inc["confidence"], det["confidence"]) > 0.75 else "P2",
                   refined_t=round(t, 2))
        self.emit({"type": "incident_update", **self.public_incident(inc)})

    @staticmethod
    def _view_score(det, dw, dh):
        """How good a view of the pole this is: bigger (closer) × confident, penalised
        when the box is cut off by the frame edge."""
        x1, y1, x2, y2 = det["box"]
        area = max(0.0, (x2 - x1) * (y2 - y1)) / float(dw * dh)
        m = 0.02
        cut = x1 < m * dw or y1 < m * dh or x2 > (1 - m) * dw or y2 > (1 - m) * dh
        return area * det["confidence"] * (0.6 if cut else 1.0)

    def _consider_best(self, inc, det, dets, frame, dw, dh, t):
        """Swap in a better evidence screenshot as the drone gets closer."""
        if inc["status"] == "dispatched":
            return
        score = self._view_score(det, dw, dh)
        if score < inc["best_score"] * BEST_GAIN or time.time() - inc["best_shot_at"] < BEST_MIN_INTERVAL_S:
            return
        x1, y1, x2, y2 = det["box"]
        _, _, rng, _ = self.tel.project(t, (x1 + x2) / 2 / dw, y2 / dh)
        self._screenshot(inc["id"], det, frame, dw)
        findings = assess(det, dets, dw, dh, self.is_alert)
        self._persist()
        self._plan(inc["id"], findings, frame, dw)
        inc.update(best_score=score, best_t=round(t, 2), best_range_m=round(rng), best_shot_at=time.time(),
                   findings=findings, actions=list(dict.fromkeys(f["action"] for f in findings)),
                   confidence=max(inc["confidence"], round(det["confidence"], 3)))
        inc["severity"] = "P1" if inc["confidence"] > 0.75 else "P2"
        self.emit({"type": "incident_update", **self.public_incident(inc)})

    @staticmethod
    def public_incident(inc):
        return {k: v for k, v in inc.items() if k not in ("screenshot", "plan", "best_score", "best_shot_at", "last_box")}

    # ---- alignment ----
    @staticmethod
    def _gray(img):
        h, w = img.shape[:2]
        g = cv2.cvtColor(cv2.resize(img, (ALIGN_WIDTH, int(h * ALIGN_WIDTH / w))), cv2.COLOR_BGR2GRAY)
        return np.float32(g)

    def _preds_for(self, frame_idx, gray):
        """Inference nearest to frame_idx, plus the pixel shift (display space)
        from that inferred frame to this one."""
        with self.lock:
            hist = list(self.pred_history)
        if not hist:
            return [], (0.0, 0.0)
        best = min(hist, key=lambda h: abs(h["frame"] - frame_idx))
        if best["frame"] == frame_idx or best["gray"].shape != gray.shape:
            return best["dets"], (0.0, 0.0)
        (dx, dy), resp = cv2.phaseCorrelate(best["gray"], gray)
        if resp < 0.05:  # no reliable global motion (e.g. across an edit cut)
            return best["dets"], (0.0, 0.0)
        k = DISPLAY_WIDTH / ALIGN_WIDTH
        return best["dets"], (dx * k, dy * k)

    # ---- rendering ----
    def _render(self, disp, t, preds, shift=(0.0, 0.0)):
        sx, sy = shift
        preds = [p for p in preds if self.visible(p["class"])]
        out = disp.copy()
        overlay = disp.copy()
        for p in preds:
            color = self.color(p["class"])
            if p["points"]:
                arr = np.array([[int(x + sx), int(y + sy)] for x, y in p["points"]])
                cv2.fillPoly(overlay, [arr], color)
                cv2.polylines(out, [arr], True, color, 2)
        cv2.addWeighted(overlay, 0.35, out, 0.65, 0, out)
        for p in preds:
            if not self.is_alert(p["class"]):
                # small, low-key class tag so other classes can be identified
                x1, y1 = int(p["box"][0] + sx), int(p["box"][1] + sy)
                tag = f"{p['class']} {p['confidence']:.0%}"
                (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
                cv2.rectangle(out, (x1, max(0, y1 - th - 8)), (x1 + tw + 8, y1), self.color(p["class"]), -1)
                cv2.putText(out, tag, (x1 + 4, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (20, 20, 20), 1)
                continue
            x1, y1, x2, y2 = [int(v + o) for v, o in zip(p["box"], (sx, sy, sx, sy))]
            # the feed simply names what the model sees; the report is driven by the
            # curated scene list, so there is no assessment counter to show
            label, color = f"LINE DOWN  {p['confidence']:.0%}", ALERT_COLOR
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_DUPLEX, 0.6, 1)
            cv2.rectangle(out, (x1, max(0, y1 - th - 12)), (x1 + tw + 10, y1), color, -1)
            cv2.putText(out, label, (x1 + 5, y1 - 6), cv2.FONT_HERSHEY_DUPLEX, 0.6, (255, 255, 255), 1)
        # HUD
        lat, lon, hd = self.tel.position(t)
        hud = f"{self.tel.drone_id}  {lat:.5f}, {lon:.5f}  HDG {hd:03.0f}  ALT {self.tel.altitude(t):.0f}m  T+{t:05.1f}s"
        cv2.rectangle(out, (0, out.shape[0] - 30), (out.shape[1], out.shape[0]), (0, 0, 0), -1)
        cv2.putText(out, hud, (12, out.shape[0] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (230, 230, 230), 1)
        return out

    # ---- report ----
    def report(self, with_images=True):
        items = []
        for inc in self.incidents.values():
            d = dict(inc)
            if with_images:
                try:
                    d["screenshot_b64"] = base64.b64encode(Path(inc["screenshot"]).read_bytes()).decode()
                except OSError:
                    d["screenshot_b64"] = None
            del d["screenshot"]
            items.append(d)
        return {"session": self.id, "drone_id": self.tel.drone_id, "model": self.model_id,
                "flight": self.flight.get("name"),
                "source": os.path.basename(self.video_path), "mode": self.mode,
                "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
                "stats": dict(self.stats), "incidents": items}
