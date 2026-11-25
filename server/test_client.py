#!/usr/bin/env python3
"""End-to-end test for hmr_server.py: sends ~30 JPEG frames of a person (cut from the InstantHMR demo GIF) and
checks the replies. Usage: .venv/bin/python test_client.py [--url ws://127.0.0.1:8791] [--frames 30]"""
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
from PIL import Image

GIF = Path(__file__).resolve().parent.parent / "vendor" / "InstantHMR" / "assets" / "demo_desktop.gif"


def make_frames(n: int) -> list[bytes]:
    """640x480 JPEGs: the camera panel of the demo GIF (a person in a kitchen), letterboxed."""
    g = Image.open(GIF)
    out = []
    for i in range(n):
        g.seek((i * 2) % g.n_frames)
        panel = np.array(g.convert("RGB"))[55:252, 0:320]
        canvas = np.zeros((480, 640, 3), np.uint8)
        canvas[43:437] = cv2.resize(panel, (640, 394))
        ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(canvas, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 80])
        out.append(jpg.tobytes())
    return out


async def main(url: str, n: int):
    frames = make_frames(n)
    print(f"{len(frames)} frames, ~{sum(map(len, frames)) // len(frames) // 1024} KB each")
    async with websockets.connect(url, max_size=8 * 2**20) as ws:
        hello = json.loads(await ws.recv())
        print("hello:", hello)
        assert hello["type"] == "hello" and hello["joints"] == 70
        await ws.send(json.dumps({"type": "config", "foo": 1}))
        t = time.time() * 1000
        await ws.send(json.dumps({"type": "ping", "t": t}))
        pong = json.loads(await ws.recv())
        assert pong == {"type": "pong", "t": t}, pong
        print("pong ok")

        rtts, timings, npers, sizes = [], [], [], []
        for i, jpg in enumerate(frames):          # one frame in flight, like the browser client
            t0 = time.perf_counter()
            await ws.send(struct.pack("<I", 1000 + i) + jpg)
            raw = await ws.recv()
            rtts.append((time.perf_counter() - t0) * 1000)
            msg = json.loads(raw)
            assert msg["type"] == "pose" and msg["id"] == 1000 + i, msg.get("id")
            sizes.append(len(raw))
            timings.append(msg["timing"])
            npers.append(len(msg["persons"]))
            if i == 0:
                print("first reply keys:", list(msg), "w/h:", msg["w"], msg["h"], "model:", msg["model"])
            if msg["persons"]:
                p = msg["persons"][0]
                j3, j2 = np.array(p["j3d"]), np.array(p["j2d"])
                assert j3.shape == (70, 3) and j2.shape == (70, 2), (j3.shape, j2.shape)
                if i in (0, n - 1):
                    print(f"frame {i}: conf {p['conf']} box {p['box']}")
                    print(f"  j3d x[{j3[:,0].min():.2f},{j3[:,0].max():.2f}] y[{j3[:,1].min():.2f},{j3[:,1].max():.2f}]"
                          f" z[{j3[:,2].min():.2f},{j3[:,2].max():.2f}] m; height(y-extent) {np.ptp(j3[:,1]):.2f} m")
                    print(f"  j2d u[{j2[:,0].min():.0f},{j2[:,0].max():.0f}] v[{j2[:,1].min():.0f},{j2[:,1].max():.0f}] px")
                    print(f"  nose j3d {j3[0].tolist()}  j2d {j2[0].tolist()}")

        # burst: 10 frames back to back without waiting -> the server should drop stale ones
        for k in range(10):
            await ws.send(struct.pack("<I", 5000 + k) + frames[k])
        got = []
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), 5))
            got.append(m["id"])
            if m["id"] == 5009:
                break
        print(f"burst of 10 -> {len(got)} replies, ids {got}")

    T = lambda k: np.mean([x[k] for x in timings[3:]])  # noqa: E731
    print(f"\npersons/frame: {np.mean(npers):.2f} (frames with a person: {sum(1 for x in npers if x)}/{n})")
    print(f"server timing ms (mean, skipping 3 warm frames): decode {T('decode'):.1f}  detect {T('detect'):.1f}  "
          f"hmr {T('hmr'):.1f}  total {T('total'):.1f}")
    print(f"client round trip ms: mean {np.mean(rtts[3:]):.1f}  p50 {np.median(rtts[3:]):.1f}  max {np.max(rtts[3:]):.1f}")
    print(f"reply size: {np.mean(sizes) / 1024:.1f} KB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8791")
    ap.add_argument("--frames", type=int, default=30)
    a = ap.parse_args()
    asyncio.run(main(a.url, a.frames))
