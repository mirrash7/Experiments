"""Run the demo pipeline headless (FAST mode) to inspect incident logic.

  headless_run.py [--until FRAME] [--watch FRAME] [--video PATH]

Saves the rendered frame nearest --watch to footage/headless/, prints every
incident, and prints which incident labels were on screen around --watch.
"""
import argparse
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("FAST", "1")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.pipeline import Session  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--until", type=int, default=3700)
ap.add_argument("--watch", type=int, default=3440)
ap.add_argument("--video", default=None, help="defaults to the flight's clip")
ap.add_argument("--flight", default=None, help="flight id from app/flights.json (default: first)")
args = ap.parse_args()

from app.pipeline import load_flights  # noqa: E402
flights = load_flights()
flight = next((f for f in flights if f["id"] == args.flight), flights[0])
video = args.video or flight["video_path"]
print(f"flight {flight['id']} · model {flight['model_id']} · {os.path.basename(video)}")

out = ROOT / "footage" / "headless"
out.mkdir(exist_ok=True)
s = Session(video, mode="drone", flight=flight)
s.start()
seen_labels = {}
saved = False
t0 = time.time()
while s.running and not s.finished and s.frame_idx < args.until:
    if abs(s.frame_idx - args.watch) <= 40:
        with s.lock:
            for p in s.latest_preds:
                inc = p.get("track", {}).get("incident")
                if s.is_alert(p["class"]):
                    seen_labels[inc or "unlabeled"] = seen_labels.get(inc or "unlabeled", 0) + 1
        if not saved and s.frame_idx >= args.watch and s.latest_jpeg:
            (out / f"frame_{args.watch}.jpg").write_bytes(s.latest_jpeg)
            saved = True
    time.sleep(0.02)
s.stop()
print(f"processed {s.frame_idx} frames in {time.time() - t0:.0f}s, "
      f"{s.stats['inferences']} inferences")
print("\nincidents:")
for inc in s.incidents.values():
    print(f"  {inc['id']} t={inc['t']:6.1f}s conf={inc['confidence']:.2f} "
          f"range={inc['range_m']:3d}m  {inc['lat']:.5f},{inc['lon']:.5f}")
print(f"\nbroken-pole labels on screen around frame {args.watch}: {seen_labels}")
print("\nidentity decisions (t, track id, range, action):")
for e in s.assoc_log:
    print(f"  t={e['t']:6.1f}  track {e['track']:3d}  {e['range']:3d}m  {e['action']}")
# which track carried each label near --watch (tracker continuity vs association)
with s.lock:
    live = [(tr['id'], tr['incident'], tr['hits'], tr['misses']) for tr in s.tracker.tracks.values() if s.is_alert(tr['class'])]
print(f"\nlive broken-pole tracks at frame {s.frame_idx}: {live}")
