"""Pre-compute detections for a flight so the demo plays instantly.

Runs the flight's model on every INFER_EVERY-th frame (same cadence and
resolution the live pipeline uses) and stores display-space detections in the
flight's `cache` file. At demo time the Session replays these instead of
calling the API — same tracker, incidents, screenshots — with zero network
dependency for detection.

  precompute.py --flight pre-storm [--workers 4]
"""
import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.pipeline import DISPLAY_WIDTH, INFER_EVERY, INFER_WIDTH, INFERENCE_URL, load_api_key, load_flights  # noqa: E402
from inference_sdk import InferenceHTTPClient  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--flight", required=True)
ap.add_argument("--workers", type=int, default=4)
args = ap.parse_args()

flight = next((f for f in load_flights() if f["id"] == args.flight), None)
if not flight:
    sys.exit(f"unknown flight {args.flight}")
if not flight.get("cache"):
    sys.exit("flight has no 'cache' path in flights.json")
client = InferenceHTTPClient(api_url=INFERENCE_URL, api_key=load_api_key(flight.get("api_key_env", "ROBOFLOW_API_KEY")))

cap = cv2.VideoCapture(flight["video_path"])
fps = cap.get(cv2.CAP_PROP_FPS)
w, h = int(cap.get(3)), int(cap.get(4))
dw = DISPLAY_WIDTH
frames = []
i = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    if i % INFER_EVERY == 0:
        s = INFER_WIDTH / w
        frames.append((i, cv2.resize(frame, (INFER_WIDTH, int(h * s)))))
    i += 1
cap.release()
print(f"{flight['id']}: {len(frames)} frames to infer ({flight['model_id']})", flush=True)


def infer(item):
    idx, small = item
    for attempt in range(3):
        try:
            r = client.infer(small, model_id=flight["model_id"])
            k = dw / INFER_WIDTH
            dets = []
            for p in r.get("predictions", []):
                dets.append({"class": p["class"], "confidence": round(p["confidence"], 4),
                             "box": [round((p["x"] - p["width"] / 2) * k, 1), round((p["y"] - p["height"] / 2) * k, 1),
                                     round((p["x"] + p["width"] / 2) * k, 1), round((p["y"] + p["height"] / 2) * k, 1)],
                             "points": [[round(q["x"] * k, 1), round(q["y"] * k, 1)] for q in p.get("points", [])]})
            return idx, dets
        except Exception as e:
            if attempt == 2:
                print(f"  frame {idx} failed: {str(e)[:120]}", flush=True)
                return idx, []
            time.sleep(1)


t0 = time.time()
results = {}
with ThreadPoolExecutor(max_workers=args.workers) as ex:
    for n, (idx, dets) in enumerate(ex.map(infer, frames), 1):
        results[idx] = dets
        if n % 50 == 0:
            print(f"  {n}/{len(frames)}", flush=True)

out = ROOT / flight["cache"]
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"flight": flight["id"], "model_id": flight["model_id"], "video": flight["video"],
                           "fps": fps, "infer_every": INFER_EVERY, "display_width": dw,
                           "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "frames": {str(k): v for k, v in sorted(results.items())}}))
n_dets = sum(len(v) for v in results.values())
print(f"done in {time.time() - t0:.0f}s: {len(results)} frames, {n_dets} detections -> {out.relative_to(ROOT)} "
      f"({out.stat().st_size / 1e6:.1f} MB)")
