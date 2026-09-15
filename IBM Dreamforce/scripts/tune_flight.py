"""Sweep per-flight detection settings against a cached flight and report the
incidents each configuration would produce.

  tune_flight.py --flight post-storm --target 5
"""
import argparse
import itertools
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("FAST", "1")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.pipeline import Session, load_flights  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--flight", required=True)
ap.add_argument("--target", type=int, default=5)
args = ap.parse_args()

base = next(f for f in load_flights() if f["id"] == args.flight)


def run(cfg):
    f = dict(base, detection=cfg)
    s = Session(f["video_path"], mode="drone", flight=f)
    s.start()
    while s.running:
        time.sleep(0.05)
    return [(i["id"], round(i["t"], 1), round(i["confidence"], 2), i["range_m"]) for i in s.incidents.values()]


grid = {
    "min_depression_deg": [5, 12],
    "incident_max_range_m": [45, 70],
    "dedupe_m": [8, 14],
    "same_pole_m": [6, 10],
    "min_hits": [5, 8],
}
keys = list(grid)
print(f"target {args.target} incidents; sweeping {len(list(itertools.product(*grid.values())))} configs\n")
best = []
for combo in itertools.product(*grid.values()):
    cfg = dict(zip(keys, combo))
    inc = run(cfg)
    mark = "  <<<" if len(inc) == args.target else ""
    print(f"{cfg}  -> {len(inc)} incidents at {[i[1] for i in inc]}{mark}", flush=True)
    best.append((abs(len(inc) - args.target), cfg, inc))
best.sort(key=lambda x: x[0])
print("\nclosest:", best[0][1], "->", best[0][2])
