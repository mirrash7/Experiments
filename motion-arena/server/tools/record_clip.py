#!/usr/bin/env python3
"""Record a replayable motion clip: send the frames of a GIF/video to the running hmr_server (protocol 2) at the
source frame rate and save the raw replies as a `hmr-raw` clip for web/src/sources/recordedSource.js.

  .venv/bin/python tools/record_clip.py                       # demo GIF -> web/public/motion/clips/demo-hmr.json
  .venv/bin/python tools/record_clip.py --src clip.mp4 --crop 0,0,1280,720 --out ../web/public/motion/clips/x.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import struct
import time
from pathlib import Path

import cv2
import numpy as np
import websockets
from PIL import Image, ImageSequence

ROOT = Path(__file__).resolve().parents[2]


def frames_of(src: Path, crop):
    x, y, w, h = crop
    if src.suffix.lower() == ".gif":
        with Image.open(src) as g:
            dur = g.info.get("duration", 40)
            for fr in ImageSequence.Iterator(g):
                rgb = np.array(fr.convert("RGB"))[y:y + h, x:x + w]
                yield rgb, dur
    else:
        cap = cv2.VideoCapture(str(src))
        dur = 1000 / (cap.get(cv2.CAP_PROP_FPS) or 30)
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            yield cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)[y:y + h, x:x + w], dur


async def main(a):
    crop = [int(v) for v in a.crop.split(",")]
    out = {"kind": "hmr-raw", "source": str(a.src.name), "latencyMs": a.latency, "frames": []}
    async with websockets.connect(a.url, max_size=8 * 2**20) as ws:
        hello = json.loads(await ws.recv())
        assert hello.get("protocol", 1) >= 2, f"server speaks protocol {hello.get('protocol', 1)}: restart it"
        t = 0.0
        for i, (rgb, dur) in enumerate(frames_of(a.src, crop)):
            img = cv2.resize(rgb, (a.width, round(rgb.shape[0] * a.width / rgb.shape[1])))
            ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 80])
            await ws.send(struct.pack("<I", i) + jpg.tobytes())
            msg = json.loads(await ws.recv())
            msg.pop("t_server", None)
            out["frames"].append({"t": round(t, 1), "msg": msg})
            t += dur
        out["fps"] = round(1000 * len(out["frames"]) / t, 2)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, separators=(",", ":")))
    n = sum(1 for f in out["frames"] if f["msg"]["persons"])
    print(f"wrote {a.out}: {len(out['frames'])} frames ({n} with a person), {out['fps']} fps, "
          f"{Path(a.out).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=ROOT / "web/public/test/demo_desktop.gif")
    ap.add_argument("--crop", default="0,52,320,200", help="x,y,w,h of the camera region")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--latency", type=float, default=60, help="capture->arrival latency to simulate on replay (ms)")
    ap.add_argument("--url", default="ws://127.0.0.1:8791")
    ap.add_argument("--out", default=str(ROOT / "web/public/motion/clips/demo-hmr.json"))
    asyncio.run(main(ap.parse_args()))
