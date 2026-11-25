# InstantHMR WebSocket server

Local inference server for the webcam body-tracking game. It runs RF-DETR (person detector) and InstantHMR
(70 3D/2D keypoints) from `../vendor/InstantHMR` and serves results over `ws://127.0.0.1:8791`.

## Run

```bash
./run.sh                                  # defaults: --model small --fit 1 --device auto --detector nano --detector-stride 3 --pose-filter one-euro
./run.sh --model nano --fit 1 --port 8766 # any option can be overridden
.venv/bin/python test_client.py           # end-to-end test (30 frames from the demo GIF, ping, drop-on-burst)
```

Startup takes about 15 s (model load plus a short CPU vs CoreML benchmark). Weights download from Hugging Face
(`momolesang/InstantHMR`) and Roboflow (RF-DETR) on the first run and are cached in `~/.cache/huggingface` and
`~/.roboflow`. If port 8791 is taken, the server exits with a message saying how to find the process holding it.

Setup (already done): `uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements.txt`.
The vendor repo has no `setup.py`, so `hmr_server.py` imports `instanthmr` by adding `../vendor/InstantHMR` to `sys.path`.

## Protocol

- Client -> server, binary: 4-byte little-endian uint32 `id` followed by the JPEG bytes.
- Client -> server, text: `{"type":"ping","t":n}` gets the reply `{"type":"pong","t":n}`. The server ignores `{"type":"config",...}` and any other text.
- Server -> client on connect: `{"type":"hello","model":"small fit1 coreml-mlprogram","joints":70,"protocol":2,"fields":[...]}`.
- Server -> client for each processed frame:
  `{"type":"pose","id","w","h","persons":[{"j3d":[[x,y,z]x70],"j2d":[[u,v]x70],"conf","box":[x1,y1,x2,y2]}],"timing":{"decode","detect","hmr","total"},"model"}`.
  `j3d` is in metres in the camera frame (x right, y down, z forward), rounded to 4 decimals. `j2d` and `box` are in pixels, rounded to 1 decimal.
  Protocol 2 adds per person (old fields unchanged, about 3.5 KB per person in total) and `t_server` (ms epoch) per message:
  - `mhr` [204]: MHR model parameters after the server pose filter (5 decimals): 0:3 root translation (x10 cm),
    3:6 root rotation, 6:136 joint angles (rad, Euler XYZ per joint through the rig's parameter transform), 136:204 skeleton scales.
  - `shape` [45]: MHR identity coefficients. `cam_t` [3]: camera translation (m, camera frame). `focal`: focal length (px).
  - MHR forward kinematics of `mhr` (`mhr_fk.py`, rig constants in `web/public/motion/mhr-rig.json`) converted to camera
    axes plus `cam_t` reproduces the joint-readout keypoints of `j3d` (shoulders, hips, knees, wrists, all finger joints,
    neck) to the 0.1 mm rounding; `test_server.py` checks the rig against `mhr-body.onnx`.
  Persons are sorted by box area, largest first (`--max-persons 1` by default). `timing.total` is the worker's time for
  decode + detect + HMR + JSON. If a frame cannot be processed, the reply has an empty `persons` list and an extra
  `"error"` field.
- Only the newest frame is processed. Frames that arrive while the worker is busy replace the pending one, and the
  older frames never get a reply. Inference runs in a single worker thread, so the event loop is never blocked.
- Each new connection resets the detector-stride tracking and the pose filter. The server holds no other client state,
  so after a restart clients simply reconnect (`HMRSource` retries every 1-5 s by itself).

## Tests and tools

```bash
.venv/bin/python -m unittest test_server -v     # offline: MHR FK rig vs mhr-body.onnx, protocol-2 person message
.venv/bin/python tools/record_clip.py           # demo GIF -> web/public/motion/clips/demo-hmr.json (server must run)
python tools/extract_mhr_rig.py --rig mhr_model.pt   # needs torch; regenerates web/public/motion/mhr-rig.json
```

## Devices

`--device auto` (the default) benchmarks the InstantHMR graph on the CPU and on CoreML at startup and keeps the
faster one. The vendor's own `coreml` option uses CoreML's older NeuralNetwork format, which was slower than the CPU
here. The server instead builds the CoreML session with `ModelFormat=MLProgram, MLComputeUnits=CPUAndGPU`. This works
for the **fit graphs** (`--fit 1/2`) and is about 2x faster than the CPU for the network itself (5-6 ms vs 12 ms for
small-fit1). Outputs match the CPU within fp16 noise (2D within 0.08 px). The network-only graphs (`--fit 0`) fail to
build as an MLProgram, so they fall back to NeuralNetwork CoreML (about 2x slower than the CPU), and `auto` then picks
the CPU. The MHR body graph (3D joints and mesh, about 3.5 ms) always runs on the CPU. RF-DETR runs on PyTorch MPS.

## Measured timings (Apple M5 Max, 640x480 JPEG, 1 person, test_client.py, one frame in flight)

Server-side means in ms. With stride 3, `detect` is averaged over all frames: a frame that runs the detector costs about
17-21 ms of detection, and the other frames cost 0. RTT is the client's round trip (mean / p50).

| Config | device | detect | hmr | total | RTT mean / p50 |
|---|---|---|---|---|---|
| **small fit1, det nano, stride 3 (default)** | **coreml-mlprogram** | 5.9-8.6 | 10.2 | **17-19** | 17-20 / 12 |
| small fit1, det nano, stride 3 | cpu | 6.9 | 17.0 | 24.5 | 25 / 20 |
| small fit1, det nano, stride 1 | coreml-mlprogram | 16.8 | 9.4 | 26.9 | 27 / 27 |
| nano fit1, det nano, stride 3 | coreml-mlprogram | 6.8 | 9.9 | 17.3 | 18 / 11.5 |
| nano fit0, det nano, stride 3 | cpu (auto; coreml-nn 27.5 ms) | 8.2 | 13.9 | 22.8 | 24 / 17 |
| medium fit2, det nano, stride 3 | coreml-mlprogram (cpu 114 ms) | 7.6 | 13.1 | 21.3 | 22 / 15 |

JPEG decode takes about 0.6 ms and a reply is about 2.8 KB. With the defaults, a client that keeps one frame in flight gets
about 30-50 results per second. The 30 fps from a webcam is therefore the limit, not inference.
