#!/usr/bin/env python3
"""InstantHMR WebSocket inference server for the webcam body-tracking game.

Protocol (ws://127.0.0.1:8791):
  client -> server  binary: 4-byte little-endian uint32 frame id + JPEG bytes
  client -> server  text:   {"type":"ping","t":n} -> {"type":"pong","t":n}; {"type":"config",...} is ignored
  server -> client  text:   {"type":"hello","model":..,"joints":70,"protocol":2,"fields":[..]} on connect
                            {"type":"pose","id","w","h","persons":[PERSON],"timing":{..},"model","t_server"}
  PERSON (protocol 2; the protocol-1 fields j3d/j2d/conf/box are unchanged):
    j3d    [[x,y,z]]x70  keypoints, metres, camera frame (x right, y down, z forward) = j3d_local + cam_t
    j2d    [[u,v]]x70    pixels                 conf  detector score 0..1        box  [x1,y1,x2,y2] px
    mhr    [204]         MHR model parameters after the server pose filter: 0:3 root translation (x10 cm),
                         3:6 root rotation, 6:136 joint angles (rad), 136:204 skeleton scales (log2)
    shape  [45]          MHR identity (blend-shape) coefficients
    cam_t  [x,y,z]       camera translation of the body-centred MHR output, metres, camera frame
    focal  f             focal length in pixels the 3D is expressed in
  Joint positions from MHR forward kinematics of `mhr` (web/public/motion/mhr-rig.json, see mhr_fk.py) in camera
  axes plus cam_t reproduce the joint-readout keypoints of j3d exactly (shoulders, hips, knees, wrists, fingers).
Inference runs in one worker thread; only the newest pending frame of a connection is processed (older ones are
dropped). The server keeps no per-client state beyond tracking, so clients can reconnect after a restart.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import struct
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT.parent / "vendor" / "InstantHMR"
sys.path.insert(0, str(VENDOR))           # the vendor repo has no setup.py: import `instanthmr` from source

warnings.filterwarnings("ignore")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import websockets  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402

log = logging.getLogger("hmr")

COREML_MLPROGRAM = {"ModelFormat": "MLProgram", "MLComputeUnits": "CPUAndGPU"}


def r4(a: np.ndarray) -> list:
    return np.round(np.asarray(a, np.float64), 4).tolist()


def r5(a: np.ndarray) -> list:
    return np.round(np.asarray(a, np.float64), 5).tolist()


PROTOCOL = 2
PERSON_FIELDS = ["j3d", "j2d", "conf", "box", "mhr", "shape", "cam_t", "focal"]


def person_json(p) -> dict:
    """One tracked person as sent to the client (see the module docstring)."""
    return {"j3d": r4(p.joints_3d_cam), "j2d": r1(p.joints_2d), "conf": round(float(p.confidence), 4),
            "box": r1(p.bbox), "mhr": r5(p.mhr_params), "shape": r4(p.shape_params), "cam_t": r4(p.cam_trans),
            "focal": round(float(p.focal_length), 2)}


def r1(a: np.ndarray) -> list:
    return np.round(np.asarray(a, np.float64), 1).tolist()


# --------------------------------------------------------------------------------------------- pipeline setup
def _coreml_session(model_path: Path):
    """CoreML session for an InstantHMR graph: MLProgram first (much faster on Apple GPUs, works for the fit
    graphs), then the older NeuralNetwork format. Raises if neither builds."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    errors = []
    for opts in (COREML_MLPROGRAM, {}):
        try:
            sess = ort.InferenceSession(str(model_path), sess_options=options,
                                        providers=[("CoreMLExecutionProvider", opts), "CPUExecutionProvider"])
            return sess, ("coreml-mlprogram" if opts else "coreml-nn")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{'MLProgram' if opts else 'NeuralNetwork'}: {str(e).splitlines()[0][:160]}")
    raise RuntimeError("; ".join(errors))


def _time_hmr(hmr, n: int = 20) -> float:
    img = np.random.default_rng(0).integers(0, 255, (480, 640, 3), np.uint8)
    box = [[220, 60, 420, 460]]
    filt, hmr.pose_filter = hmr.pose_filter, None
    try:
        for _ in range(3):
            hmr.predict(img, box)
        t = time.perf_counter()
        for _ in range(n):
            hmr.predict(img, box)
        return (time.perf_counter() - t) / n * 1000
    finally:
        hmr.pose_filter = filt


def build_pipeline(args):
    """PosePipeline on the CPU, then (device coreml/auto) its InstantHMR network swapped for a CoreML session.
    `auto` keeps whichever of CPU and CoreML is faster on a short benchmark."""
    import onnxruntime as ort

    from instanthmr import PosePipeline
    from instanthmr.models import resolve_model

    ort.set_default_logger_severity(3)
    t0 = time.perf_counter()
    log.info("loading InstantHMR %s fit%d + RF-DETR %s (weights download from Hugging Face on first run)...",
             args.model, args.fit, args.detector)
    pipe = PosePipeline(args.model, fit=args.fit, device="cpu", detector=args.detector,
                        det_confidence=args.det_confidence, max_persons=args.max_persons,
                        detector_stride=args.detector_stride, focal=args.focal,
                        pose_filter=None if args.pose_filter == "none" else args.pose_filter)
    log.info("pipeline loaded in %.1fs", time.perf_counter() - t0)
    device = "cpu"
    if args.device in ("coreml", "auto"):
        cpu_net = pipe.hmr.network
        cpu_ms = _time_hmr(pipe.hmr) if args.device == "auto" else None
        try:
            sess, kind = _coreml_session(resolve_model(args.model, args.fit))
            pipe.hmr.network, pipe.hmr.provider = sess, sess.get_providers()[0]
            cm_ms = _time_hmr(pipe.hmr)
            if args.device == "auto":
                log.info("device benchmark (InstantHMR stage, 1 person): cpu %.1f ms, %s %.1f ms", cpu_ms, kind, cm_ms)
            if args.device == "auto" and cm_ms >= cpu_ms:
                pipe.hmr.network, pipe.hmr.provider = cpu_net, "CPUExecutionProvider"
                log.info("-> using cpu (CoreML not faster)")
            else:
                device = kind
                log.info("-> using %s", kind)
        except Exception as e:  # noqa: BLE001
            pipe.hmr.network, pipe.hmr.provider = cpu_net, "CPUExecutionProvider"
            log.warning("CoreML failed (%s); falling back to cpu", e)
    det_dev = getattr(getattr(pipe.detector.model, "model", None), "device", "?")
    log.info("InstantHMR on %s, body graph on %s, RF-DETR on %s", pipe.hmr.provider,
             pipe.hmr.body.get_providers()[0], det_dev)
    return pipe, device


# --------------------------------------------------------------------------------------------- server
class Stats:
    def __init__(self):
        self.reset()

    def reset(self):
        self.frames = self.dropped = self.persons = 0
        self.decode = self.detect = self.hmr = self.total = self.e2e = 0.0
        self.t0 = time.perf_counter()

    def add(self, timing: dict, n_persons: int, e2e_ms: float):
        self.frames += 1
        self.persons += n_persons
        self.decode += timing["decode"]
        self.detect += timing["detect"]
        self.hmr += timing["hmr"]
        self.total += timing["total"]
        self.e2e += e2e_ms


class HMRServer:
    def __init__(self, pipe, model_name: str, pose_filter: str):
        self.pipe = pipe
        self.model_name = model_name
        self.pose_filter = pose_filter
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hmr")
        self.stats = Stats()
        self.clients = 0

    # runs in the worker thread
    def _infer(self, fid: int, jpeg: bytes) -> tuple:
        t0 = time.perf_counter()
        arr = np.frombuffer(jpeg, np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR) if arr.size else None
        if bgr is None:
            return json.dumps({"type": "pose", "id": fid, "w": 0, "h": 0, "persons": [],
                               "timing": {"decode": 0, "detect": 0, "hmr": 0, "total": 0},
                               "model": self.model_name, "error": "jpeg decode failed"}), 0, None
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        t1 = time.perf_counter()
        res = self.pipe(rgb, timestamp=t1)
        h, w = rgb.shape[:2]
        persons = sorted(res.persons, key=lambda p: float((p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1])),
                         reverse=True)
        out = [person_json(p) for p in persons]
        t2 = time.perf_counter()
        timing = {"decode": round((t1 - t0) * 1000, 2), "detect": round(res.detector_ms, 2),
                  "hmr": round(res.hmr_ms, 2), "total": round((t2 - t0) * 1000, 2)}
        msg = json.dumps({"type": "pose", "id": fid, "w": w, "h": h, "persons": out, "timing": timing,
                          "model": self.model_name, "t_server": round(time.time() * 1000, 1)},
                         separators=(",", ":"))
        return msg, len(out), timing

    def _reset_tracking(self):
        from instanthmr.smoothing import PoseFilter

        self.pipe._frame = 0
        self.pipe._boxes = np.zeros((0, 4), np.float32)
        self.pipe._scores = np.zeros(0, np.float32)
        if self.pipe.hmr.pose_filter is not None:
            self.pipe.hmr.pose_filter = PoseFilter(self.pose_filter)

    async def handler(self, ws):
        peer = ws.remote_address
        self.clients += 1
        if self.clients > 1:
            log.warning("%d clients connected: they share one pipeline (tracking state is mixed)", self.clients)
        log.info("client connected %s", peer)
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self.executor, self._reset_tracking)
        await ws.send(json.dumps({"type": "hello", "model": self.model_name, "joints": 70,
                                  "protocol": PROTOCOL, "fields": PERSON_FIELDS}))

        latest: list = [None]          # (id, jpeg, t_received), overwritten by newer frames
        wake = asyncio.Event()

        async def worker():
            while True:
                await wake.wait()
                wake.clear()
                item, latest[0] = latest[0], None
                if item is None:
                    continue
                fid, jpeg, t_rx = item
                try:
                    msg, n, timing = await loop.run_in_executor(self.executor, self._infer, fid, jpeg)
                except Exception as e:  # noqa: BLE001
                    log.exception("inference failed on frame %d", fid)
                    msg, n, timing = json.dumps({"type": "pose", "id": fid, "w": 0, "h": 0, "persons": [],
                                                 "timing": {"decode": 0, "detect": 0, "hmr": 0, "total": 0},
                                                 "model": self.model_name, "error": str(e)}), 0, None
                try:
                    await ws.send(msg)
                except websockets.ConnectionClosed:
                    return
                if timing:
                    self.stats.add(timing, n, (time.perf_counter() - t_rx) * 1000)
                if latest[0] is not None:
                    wake.set()

        task = asyncio.create_task(worker())
        try:
            async for message in ws:
                if isinstance(message, (bytes, bytearray, memoryview)):
                    message = bytes(message)
                    if len(message) < 4:
                        continue
                    fid = struct.unpack_from("<I", message, 0)[0]
                    if latest[0] is not None:
                        self.stats.dropped += 1
                    latest[0] = (fid, message[4:], time.perf_counter())
                    wake.set()
                else:
                    try:
                        data = json.loads(message)
                    except ValueError:
                        continue
                    if isinstance(data, dict) and data.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong", "t": data.get("t")}))
        except websockets.ConnectionClosed:
            pass
        finally:
            task.cancel()
            self.clients -= 1
            log.info("client disconnected %s", peer)

    async def report(self):
        while True:
            await asyncio.sleep(1.0)
            s = self.stats
            dt = time.perf_counter() - s.t0
            if s.frames:
                n = s.frames
                log.info("%5.1f fps | decode %4.1f detect %5.1f hmr %5.1f total %5.1f ms | rx->tx %5.1f ms | "
                         "persons/frame %.2f | dropped %d", n / dt, s.decode / n, s.detect / n, s.hmr / n,
                         s.total / n, s.e2e / n, s.persons / n, s.dropped)
            s.reset()


async def amain(args):
    pipe, device = build_pipeline(args)
    model_name = f"{args.model} fit{args.fit} {device}"
    srv = HMRServer(pipe, model_name, args.pose_filter)
    async with serve(srv.handler, args.host, args.port, max_size=8 * 2**20, compression=None):
        log.info("ready: ws://%s:%d  model=%s detector=%s stride=%d pose_filter=%s max_persons=%d",
                 args.host, args.port, model_name, args.detector, args.detector_stride, args.pose_filter,
                 args.max_persons)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        reporter = asyncio.create_task(srv.report())
        await stop.wait()
        reporter.cancel()
        log.info("shutting down")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="small", help="nano, tiny, small, medium, medium-commercial or .onnx path")
    ap.add_argument("--fit", type=int, default=1, choices=(0, 1, 2))
    ap.add_argument("--device", default="auto", choices=("auto", "cpu", "coreml"),
                    help="auto (default): benchmark cpu vs CoreML at startup and keep the faster")
    ap.add_argument("--detector", default="nano", choices=("nano", "small", "medium", "base", "large"))
    ap.add_argument("--detector-stride", type=int, default=3)
    ap.add_argument("--det-confidence", type=float, default=0.5)
    ap.add_argument("--max-persons", type=int, default=1)
    ap.add_argument("--pose-filter", default="one-euro", choices=("one-euro", "alpha-beta", "none"))
    ap.add_argument("--focal", type=float, default=None, help="camera focal length in pixels, if known")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8791)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    for name in ("rf-detr", "websockets", "httpx", "huggingface_hub"):
        logging.getLogger(name).setLevel(logging.WARNING)
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass
    except OSError as e:
        if e.errno == 48:  # EADDRINUSE on macOS
            log.error("port %d is already in use (find it: lsof -nP -iTCP:%d -sTCP:LISTEN), or use --port",
                      args.port, args.port)
            sys.exit(1)
        raise
    logging.shutdown()
    os._exit(0)


if __name__ == "__main__":
    main()
