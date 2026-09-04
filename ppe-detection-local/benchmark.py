"""Quick check: download the RF-DETR PPE model, run it locally, measure latency."""
import os
import time

import cv2
import numpy as np
from dotenv import load_dotenv

load_dotenv()

from inference import get_model

MODEL_ID = "ppe-compliance-m8dqs/1"

t0 = time.time()
model = get_model(MODEL_ID, api_key=os.environ["ROBOFLOW_API_KEY"])
print(f"model loaded in {time.time() - t0:.1f}s: {type(model).__name__}")

frame = np.random.randint(0, 255, (720, 1280, 3), dtype=np.uint8)

# warmup
for _ in range(3):
    model.infer(frame, confidence=0.4)

times = []
for _ in range(10):
    t = time.time()
    model.infer(frame, confidence=0.4)
    times.append(time.time() - t)

avg = sum(times) / len(times)
print(f"avg inference: {avg * 1000:.0f} ms  ({1 / avg:.1f} FPS)")
