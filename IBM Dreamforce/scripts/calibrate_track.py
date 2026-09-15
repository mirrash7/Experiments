"""One-time flight-track calibrator (not part of the demo app).

Steps through the flyover every N seconds on a satellite map: click to place
the drone, set heading/altitude/tilt, save -> app/telemetry.json.

  ./.venv/bin/python3 scripts/calibrate_track.py          # http://localhost:8010
  ./.venv/bin/python3 scripts/calibrate_track.py --step 5 --video <path>
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import cv2
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.pipeline import Telemetry  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--video", default=str(ROOT / "footage/upscale/powerline-demo-1080/powerline-demo-1080_2k_full.mp4"))
ap.add_argument("--step", type=int, default=5, help="seconds between keyframes")
ap.add_argument("--port", type=int, default=8010)
ap.add_argument("--telemetry", default=str(ROOT / "app" / "telemetry.json"),
                help="telemetry file to read/write (one per flight, see app/flights.json)")
args = ap.parse_args()

FRAMES = ROOT / "footage" / "calib" / f"{Path(args.video).stem}_step{args.step}"
TELEMETRY = Path(args.telemetry)


def extract_frames():
    FRAMES.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(args.video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    times = list(range(0, int(n / fps) + 1, args.step))
    if len(list(FRAMES.glob("*.jpg"))) >= len(times):
        return times
    for t in times:
        dest = FRAMES / f"{t:04d}.jpg"
        if dest.exists():
            continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, f = cap.read()
        if ok:
            cv2.imwrite(str(dest), cv2.resize(f, (1280, 720)), [cv2.IMWRITE_JPEG_QUALITY, 88])
    cap.release()
    return times


TIMES = extract_frames()
app = FastAPI(title="Track calibrator")
app.mount("/frames", StaticFiles(directory=FRAMES), name="frames")


@app.get("/", response_class=HTMLResponse)
def index():
    return (ROOT / "scripts" / "calibrate.html").read_text()


@app.get("/api/keyframes")
def keyframes():
    """Current track sampled at the keyframe times (so you adjust, not restart)."""
    tel = Telemetry(TELEMETRY)
    tel.set_duration(TIMES[-1] or 1)
    out = []
    for t in TIMES:
        lat, lon, hdg = tel.position(t)
        out.append({"t": t, "lat": round(lat, 6), "lon": round(lon, 6), "hdg": round(hdg),
                    "alt": round(tel.altitude(t)), "tilt": round(tel.tilt(t)) if tel.has_tilt else 45})
    cfg = json.loads(TELEMETRY.read_text())
    meta = {k: v for k, v in cfg.items() if k != "waypoints"}
    return {"keyframes": out, "meta": meta, "step": args.step}


@app.post("/api/save")
def save(body: dict):
    cfg = json.loads(TELEMETRY.read_text())
    backup = TELEMETRY.with_name(f"telemetry.backup-{time.strftime('%Y%m%d-%H%M%S')}.json")
    shutil.copy(TELEMETRY, backup)
    cfg["waypoints"] = [{"t": k["t"], "lat": k["lat"], "lon": k["lon"], "hdg": k["hdg"],
                         "alt": k["alt"], "tilt": k["tilt"]} for k in body["keyframes"]]
    cfg["_note"] = f"Hand-calibrated with scripts/calibrate_track.py ({len(cfg['waypoints'])} keyframes, {args.step}s cadence)."
    TELEMETRY.write_text(json.dumps(cfg, indent=1))
    return JSONResponse({"saved": str(TELEMETRY.relative_to(ROOT)), "backup": backup.name,
                         "waypoints": len(cfg["waypoints"])})


@app.get("/api/export")
def export():
    return FileResponse(TELEMETRY, filename="telemetry.json")


if __name__ == "__main__":
    print(f"{len(TIMES)} keyframes every {args.step}s from {Path(args.video).name} -> {TELEMETRY.relative_to(ROOT) if TELEMETRY.is_relative_to(ROOT) else TELEMETRY}")
    print(f"open http://localhost:{args.port}")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
