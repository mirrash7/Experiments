"""Real-time PPE compliance monitor.

Runs an RF-DETR model (Roboflow Universe: ppe-compliance-m8dqs/1) locally on a
webcam feed, tracks each person, and flags missing PPE. Fires an alert
(log line + snapshot + macOS notification) when a violation persists.

Usage:
    python ppe_monitor.py [--camera 0] [--confidence 0.4] [--required hardhat,vest,gloves]

Keys:  q = quit   f = fullscreen   m = mirror
"""

import argparse
import json
import math
import os
import subprocess
import threading
import time
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import supervision as sv
from dotenv import load_dotenv

# override=True: the project .env key must win over any ROBOFLOW_API_KEY
# exported in the user's shell (a stale key there can't access the private model)
load_dotenv(override=True)

# Benchmarked on M5 Max: pure CPU (104 ms) beats the fragmented CoreML
# partitioning (134 ms) for this RF-DETR ONNX graph.
os.environ.setdefault("ONNXRUNTIME_EXECUTION_PROVIDERS", "CPUExecutionProvider")
# Keep model weights next to the project — the default /tmp cache is wiped on
# reboot, which would force a >100 MB re-download on demo day.
os.environ.setdefault("MODEL_CACHE_DIR", str(Path(__file__).resolve().parent / ".model-cache"))
# Silence warnings about model types this demo doesn't use.
for _flag in ("CORE_MODEL_SAM_ENABLED", "CORE_MODEL_SAM3_ENABLED",
              "CORE_MODEL_YOLO_WORLD_ENABLED", "CORE_MODEL_GAZE_ENABLED"):
    os.environ.setdefault(_flag, "False")

MODEL_ID = "ppe-compliance-m8dqs-z8dcg/2"

# PPE item -> (classes that prove it's worn, classes that prove it's missing).
# Items without a negative class read UNKNOWN when not seen — except vest,
# which is treated as missing (the torso is visible whenever a person is boxed).
PPE_CLASSES = {
    "hardhat": ({"head_helmet"}, {"head_nohelmet"}),
    "vest": ({"vest"}, set()),
    "gloves": ({"hand_glove"}, {"hand_noglove"}),
    "mask": ({"face_mask"}, {"face_nomask"}),
    "glasses": ({"glasses"}, set()),
    "boots": ({"boots"}, set()),
    "shoes": ({"shoes"}, set()),
}
DEFAULT_REQUIRED = "hardhat,vest,gloves"
PERSON_CLASS = "person"

OK, MISSING, UNKNOWN = "OK", "MISSING", "UNKNOWN"

SMOOTH_WINDOW = 7        # inference frames used for majority vote
MIN_SAMPLES = 3          # samples needed before a status is trusted
ALERT_AFTER_S = 2.0      # violation must persist this long before alerting
ALERT_COOLDOWN_S = 15.0  # per-person cooldown between alerts

# BGR palette
GREEN = (110, 200, 90)
RED = (70, 70, 235)
AMBER = (50, 170, 250)
GREY = (150, 150, 150)
WHITE = (245, 245, 245)
DIM = (190, 190, 190)
PANEL = (30, 26, 22)

FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_TITLE = cv2.FONT_HERSHEY_DUPLEX

STATUS_COLOR = {OK: GREEN, MISSING: RED, UNKNOWN: GREY}
STATUS_TEXT = {OK: "OK", MISSING: "MISSING", UNKNOWN: "--"}


def overlap_ratio(item_xyxy, person_xyxy):
    """Fraction of the item box that lies inside the person box."""
    ax1, ay1, ax2, ay2 = item_xyxy
    bx1, by1, bx2, by2 = person_xyxy
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area = max(1.0, (ax2 - ax1) * (ay2 - ay1))
    return inter / area


class InferenceWorker(threading.Thread):
    """Runs the model on the most recent frame in a background thread."""

    def __init__(self, model, confidence):
        super().__init__(daemon=True)
        self.model = model
        self.confidence = confidence
        self.lock = threading.Lock()
        self.frame = None
        self.result = None  # (sv.Detections, latency_s)
        self.running = True

    def submit(self, frame):
        with self.lock:
            self.frame = frame

    def latest(self):
        with self.lock:
            return self.result

    def run(self):
        while self.running:
            with self.lock:
                frame, self.frame = self.frame, None
            if frame is None:
                time.sleep(0.005)
                continue
            t0 = time.time()
            res = self.model.infer(frame, confidence=self.confidence)
            res = res[0] if isinstance(res, list) else res
            detections = sv.Detections.from_inference(res)
            with self.lock:
                self.result = (detections, time.time() - t0)


class PersonState:
    """Smoothed PPE status + alert bookkeeping for one tracked person."""

    def __init__(self):
        self.history = defaultdict(lambda: deque(maxlen=SMOOTH_WINDOW))
        self.violation_since = None
        self.last_alert_at = 0.0
        self.last_seen = time.time()

    def update(self, raw_status):
        self.last_seen = time.time()
        for item, status in raw_status.items():
            self.history[item].append(status)

    def smoothed(self, required):
        out = {}
        for item in required:
            votes = self.history[item]
            if len(votes) < MIN_SAMPLES:
                out[item] = UNKNOWN
            else:
                out[item] = max(set(votes), key=list(votes).count)
        return out


def assess_people(detections, required):
    """Split detections into people and PPE items, return per-person raw status."""
    if len(detections) == 0:
        return [], detections
    names = detections.data["class_name"]
    person_mask = names == PERSON_CLASS
    people = detections[person_mask]
    items = detections[~person_mask]

    results = []
    for i in range(len(people)):
        pbox = people.xyxy[i]
        assigned = []
        for j in range(len(items)):
            if overlap_ratio(items.xyxy[j], pbox) > 0.5:
                assigned.append(items.data["class_name"][j])
        status = {}
        for item in required:
            pos, neg = PPE_CLASSES[item]
            if any(c in neg for c in assigned):
                status[item] = MISSING
            elif any(c in pos for c in assigned):
                status[item] = OK
            elif item == "vest":
                status[item] = MISSING
            else:
                status[item] = UNKNOWN
        results.append((pbox, status))
    return results, items


def fire_alert(worker_id, missing, frame, alerts_dir):
    ts = datetime.now()
    stamp = ts.strftime("%Y%m%d_%H%M%S")
    snap = alerts_dir / f"violation_{stamp}_worker{worker_id}.jpg"
    cv2.imwrite(str(snap), frame)
    entry = {
        "time": ts.isoformat(timespec="seconds"),
        "worker": int(worker_id),
        "missing": sorted(missing),
        "snapshot": snap.name,
    }
    with open(alerts_dir / "alerts.log", "a") as f:
        f.write(json.dumps(entry) + "\n")
    msg = f"Worker #{worker_id} missing: {', '.join(sorted(missing)).upper()}"
    subprocess.Popen(
        ["osascript", "-e",
         f'display notification "{msg}" with title "PPE VIOLATION" sound name "Basso"'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    print(f"[ALERT] {entry['time']}  {msg}")
    return entry


# ---------------------------------------------------------------- drawing

def text_w(text, scale, font=FONT, thick=1):
    return cv2.getTextSize(text, font, scale, thick)[0][0]


def fill(img, x1, y1, x2, y2, color, alpha):
    """Alpha-blend a filled rectangle onto img in place."""
    x1, y1 = max(0, int(x1)), max(0, int(y1))
    x2, y2 = min(img.shape[1], int(x2)), min(img.shape[0], int(y2))
    if x2 <= x1 or y2 <= y1:
        return
    roi = img[y1:y2, x1:x2]
    block = np.empty_like(roi)
    block[:] = color
    cv2.addWeighted(block, alpha, roi, 1 - alpha, 0, roi)


def draw_corner_box(img, box, color, thickness=2):
    """Bracket-style bounding box (corners only) with a faint full outline."""
    x1, y1, x2, y2 = box.astype(int)
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 1, cv2.LINE_AA)
    arm = max(14, int(0.14 * min(x2 - x1, y2 - y1)))
    for cx, cy, dx, dy in ((x1, y1, 1, 1), (x2, y1, -1, 1),
                           (x1, y2, 1, -1), (x2, y2, -1, -1)):
        cv2.line(img, (cx, cy), (cx + dx * arm, cy), color, thickness + 1, cv2.LINE_AA)
        cv2.line(img, (cx, cy), (cx, cy + dy * arm), color, thickness + 1, cv2.LINE_AA)


def draw_chip(img, text, x, y, fg, bg, scale=0.42):
    """Small filled label chip anchored at (x, y) = top-left. Returns height."""
    w = text_w(text, scale) + 12
    h = 18
    fill(img, x, y, x + w, y + h, bg, 0.85)
    cv2.putText(img, text, (int(x) + 6, int(y) + 13), FONT, scale, fg, 1, cv2.LINE_AA)
    return h


def draw_person_card(img, x, y, worker_id, smoothed, required, accent):
    """Status card for one worker. Returns (w, h)."""
    row_h, head_h, w = 24, 28, 190
    h = head_h + row_h * len(required) + 8
    x = int(np.clip(x, 0, img.shape[1] - w))
    y = int(np.clip(y, 56, img.shape[0] - h))
    fill(img, x, y, x + w, y + h, PANEL, 0.78)
    fill(img, x, y, x + 4, y + h, accent, 0.95)  # accent spine
    cv2.putText(img, f"WORKER #{worker_id}", (x + 14, y + 19),
                FONT_TITLE, 0.5, WHITE, 1, cv2.LINE_AA)
    cy = y + head_h
    for item in required:
        v = smoothed[item]
        c = STATUS_COLOR[v]
        cv2.circle(img, (x + 20, cy + 11), 5, c, -1, cv2.LINE_AA)
        cv2.putText(img, item.upper(), (x + 34, cy + 16), FONT, 0.45, DIM, 1, cv2.LINE_AA)
        label = STATUS_TEXT[v]
        cv2.putText(img, label, (x + w - 12 - text_w(label, 0.45), cy + 16),
                    FONT, 0.45, c, 1, cv2.LINE_AA)
        cy += row_h
    return w, h


def draw_header(img, n_workers, violations, t):
    h, w = img.shape[:2]
    fill(img, 0, 0, w, 52, PANEL, 0.82)
    cv2.putText(img, "PPE COMPLIANCE MONITOR", (18, 33), FONT_TITLE, 0.75,
                WHITE, 1, cv2.LINE_AA)
    lx = 24 + text_w("PPE COMPLIANCE MONITOR", 0.75, FONT_TITLE)
    cv2.circle(img, (lx + 12, 26), 5, RED if int(t * 2) % 2 == 0 else (40, 40, 140), -1)
    cv2.putText(img, "LIVE", (lx + 24, 32), FONT, 0.5, DIM, 1, cv2.LINE_AA)

    if violations:
        names = ", ".join(f"#{tid}" for tid, _ in violations)
        pill, ptxt = RED, f"VIOLATION  {names}"
    elif n_workers:
        pill, ptxt = GREEN, f"{n_workers} COMPLIANT"
    else:
        pill, ptxt = (90, 90, 90), "NO PERSONNEL"
    pw = text_w(ptxt, 0.55) + 28
    fill(img, w - pw - 16, 12, w - 16, 40, pill, 0.9)
    cv2.putText(img, ptxt, (w - pw - 2, 32), FONT, 0.55, WHITE, 1, cv2.LINE_AA)


def draw_footer(img, fps, latency):
    h, w = img.shape[:2]
    fill(img, 0, h - 32, w, h, PANEL, 0.82)
    lat = f"{latency * 1000:.0f} ms" if latency else "--"
    ups = f"{1 / latency:.0f}/s" if latency else "--"
    txt = (f"RF-DETR  {MODEL_ID}     inference {lat} ({ups} updates)"
           f"     video {fps:.0f} FPS     {datetime.now().strftime('%H:%M:%S')}")
    cv2.putText(img, txt, (18, h - 11), FONT, 0.45, DIM, 1, cv2.LINE_AA)


def draw_alert_feed(img, feed):
    h, w = img.shape[:2]
    y = h - 44
    for entry in reversed(feed):
        txt = f"{entry['time'][11:]}  Worker #{entry['worker']}  {', '.join(entry['missing']).upper()}"
        tw = text_w(txt, 0.45) + 20
        fill(img, w - tw - 16, y - 22, w - 16, y, (30, 30, 120), 0.8)
        cv2.putText(img, txt, (w - tw - 6, y - 7), FONT, 0.45, WHITE, 1, cv2.LINE_AA)
        y -= 28


def draw_pulse_border(img, t):
    a = 0.35 + 0.3 * math.sin(t * 6)
    h, w = img.shape[:2]
    for x1, y1, x2, y2 in ((0, 0, w, 6), (0, h - 6, w, h), (0, 0, 6, h), (w - 6, 0, w, h)):
        fill(img, x1, y1, x2, y2, RED, a)


# ---------------------------------------------------------------- startup

def probe_cameras(max_index=4):
    """Return indices that actually deliver frames."""
    good = []
    for i in range(max_index):
        cap = cv2.VideoCapture(i, cv2.CAP_AVFOUNDATION)
        ok, _ = cap.read()
        cap.release()
        if ok:
            good.append(i)
    return good


PERMISSION_HELP = [
    "NO CAMERA SIGNAL - macOS camera permission is likely missing.",
    "",
    "1. Open System Settings > Privacy & Security > Camera",
    "2. Enable it for the terminal app you ran this from",
    "   (Terminal / iTerm / Claude).",
    "3. Fully quit and reopen that app, then rerun this script.",
    "",
    "If permission is already granted, try another index:",
    "   python ppe_monitor.py --camera 1   (or 2)",
]


def status_frame(lines):
    img = np.full((720, 1280, 3), 30, dtype=np.uint8)
    for k, line in enumerate(lines):
        cv2.putText(img, line, (60, 120 + 44 * k), FONT,
                    0.85, RED if k == 0 else (230, 230, 230), 2, cv2.LINE_AA)
    return img


def main():
    ap = argparse.ArgumentParser(description="Real-time PPE monitor (RF-DETR)")
    ap.add_argument("--camera", default="0",
                    help="camera index (iPhone Continuity Camera usually shows up as 0 or 1), or a path to a video file")
    ap.add_argument("--max-frames", type=int, default=0, help="stop after N frames (0 = run forever)")
    ap.add_argument("--confidence", type=float, default=0.4)
    ap.add_argument("--required", default=DEFAULT_REQUIRED,
                    help=f"comma-separated subset of: {','.join(PPE_CLASSES)} (default: {DEFAULT_REQUIRED})")
    ap.add_argument("--mirror", action="store_true", help="mirror the video (selfie view)")
    ap.add_argument("--save-frame", default=None, help="also write the rendered view to this image path periodically")
    args = ap.parse_args()

    required = [r.strip() for r in args.required.split(",") if r.strip()]
    for r in required:
        if r not in PPE_CLASSES:
            ap.error(f"unknown PPE item '{r}' (choose from {list(PPE_CLASSES)})")

    alerts_dir = Path(__file__).parent / "alerts"
    alerts_dir.mkdir(exist_ok=True)

    print(f"Loading {MODEL_ID} (first run downloads ~115 MB of weights)...")
    from inference import get_model
    model = get_model(MODEL_ID, api_key=os.environ["ROBOFLOW_API_KEY"])

    source = int(args.camera) if args.camera.isdigit() else args.camera
    if isinstance(source, int):
        available = probe_cameras()
        print(f"Cameras delivering frames: {available or 'NONE'}")
        if not available:
            print("\n".join(PERMISSION_HELP))
        elif source not in available:
            source = available[0]
            print(f"Camera {args.camera} gave no frames — using camera {source} instead")
    cap = cv2.VideoCapture(source)
    if isinstance(source, int):
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    if not cap.isOpened() and not isinstance(source, int):
        raise SystemExit(f"Could not open video file {source}")

    worker = InferenceWorker(model, args.confidence)
    worker.start()
    tracker = sv.ByteTrack()
    states = defaultdict(PersonState)
    alert_feed = deque(maxlen=3)

    win = "PPE Monitor"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win, 1280, 720)
    mirror, fullscreen = args.mirror, False
    fps_t, fps = time.time(), 0.0
    latency = None
    last_processed = None

    print(f"Watching for: {', '.join(required)}")
    print("Running — q quits, f fullscreen, m mirror")
    frames_done = 0
    last_frame_at = time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            if not isinstance(source, int):
                break  # video file ended
            waited = time.time() - last_frame_at
            lines = PERMISSION_HELP if waited > 4 else [
                "Waiting for camera...", "", f"camera index {source}"]
            cv2.imshow(win, status_frame(lines))
            if (cv2.waitKey(200) & 0xFF) == ord("q"):
                break
            continue
        last_frame_at = time.time()
        frames_done += 1
        if args.max_frames and frames_done > args.max_frames:
            break
        if mirror:
            frame = cv2.flip(frame, 1)
        worker.submit(frame.copy())

        result = worker.latest()
        if result is not None and result is not last_processed:
            last_processed = result
            detections, latency = result
            people_status, items = assess_people(detections, required)

            names = detections.data["class_name"] if len(detections) else np.array([])
            people_det = detections[names == PERSON_CLASS] if len(detections) else detections
            tracked = tracker.update_with_detections(people_det)

            frame_people = []
            for i in range(len(tracked)):
                tbox, tid = tracked.xyxy[i], tracked.tracker_id[i]
                best, best_ov = None, 0.0
                for pbox, status in people_status:
                    ov = overlap_ratio(pbox, tbox)
                    if ov > best_ov:
                        best, best_ov = status, ov
                if best is None:
                    continue
                states[tid].update(best)
                frame_people.append((tid, tbox))
            worker.people = (frame_people, items)

        display = frame.copy()
        frame_people, items = getattr(worker, "people", ([], None))
        now = time.time()
        violations = []

        # PPE item boxes (only classes relevant to the required items)
        relevant = set().union(*(PPE_CLASSES[i][0] | PPE_CLASSES[i][1] for i in required))
        if items is not None:
            for j in range(len(items)):
                name = items.data["class_name"][j]
                if name not in relevant:
                    continue
                is_neg = any(name in neg for _, neg in PPE_CLASSES.values())
                c = RED if is_neg else GREEN
                x1, y1, x2, y2 = items.xyxy[j].astype(int)
                cv2.rectangle(display, (x1, y1), (x2, y2), c, 1, cv2.LINE_AA)
                draw_chip(display, name.replace("_", " "), x1, max(52, y1 - 18), WHITE, c)

        for tid, tbox in frame_people:
            st = states[tid]
            if now - st.last_seen > 1.5:
                continue
            smoothed = st.smoothed(required)
            missing = {k for k, v in smoothed.items() if v == MISSING}
            accent = RED if missing else (GREEN if all(v == OK for v in smoothed.values()) else AMBER)
            draw_corner_box(display, tbox, accent)
            x1, y1, x2, y2 = tbox.astype(int)
            draw_person_card(display, x2 + 10, y1, tid, smoothed, required, accent)

            if missing:
                if st.violation_since is None:
                    st.violation_since = now
                elif (now - st.violation_since >= ALERT_AFTER_S
                      and now - st.last_alert_at >= ALERT_COOLDOWN_S):
                    st.last_alert_at = now
                    alert_feed.append(fire_alert(tid, missing, display, alerts_dir))
                violations.append((tid, missing))
            else:
                st.violation_since = None

        if violations:
            draw_pulse_border(display, now)
        draw_header(display, len(frame_people), violations, now)
        draw_footer(display, fps, latency)
        draw_alert_feed(display, alert_feed)

        fps = 0.9 * fps + 0.1 * (1.0 / max(1e-3, time.time() - fps_t))
        fps_t = time.time()

        if args.save_frame and frames_done % 30 == 0:
            cv2.imwrite(args.save_frame, display)
        cv2.imshow(win, display)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        elif key == ord("f"):
            fullscreen = not fullscreen
            cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN,
                                  cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL)
        elif key == ord("m"):
            mirror = not mirror

    worker.running = False
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
