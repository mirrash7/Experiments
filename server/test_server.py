#!/usr/bin/env python3
"""Offline tests (no running server, no camera): `.venv/bin/python -m unittest test_server -v`

1. The JSON MHR rig + NumPy FK (mhr_fk.py, the reference for the browser port) reproduce the joint-readout
   keypoints of InstantHMR's own body graph `mhr-body.onnx` on real InstantHMR predictions of the demo GIF.
2. The protocol-2 person message carries every field, with the right sizes, and stays JSON-serialisable.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "vendor" / "InstantHMR"))

import mhr_fk  # noqa: E402


def _body_session():
    import onnxruntime as ort
    from instanthmr.models import BODY, _download
    return ort.InferenceSession(str(_download(BODY)), providers=["CPUExecutionProvider"])


def _demo_params(n=12):
    """mhr/shape params from InstantHMR run on frames of the demo GIF (nano, no fit: fast, CPU)."""
    from PIL import Image
    from instanthmr.inference import InstantHMR
    from instanthmr.models import resolve_model
    hmr = InstantHMR(resolve_model("nano", 0), device="cpu")
    out = []
    with Image.open(HERE.parent / "vendor" / "InstantHMR" / "assets" / "demo_desktop.gif") as g:
        for i in range(n):
            g.seek((i * 7) % g.n_frames)
            img = np.ascontiguousarray(np.array(g.convert("RGB"))[52:252, 0:320])
            preds = hmr.predict(img, [[60, 5, 260, 200]])
            out.append((preds[0].mhr_params, preds[0].shape_params, preds[0].joints_3d_local))
    return out


class TestMHRFK(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sk = mhr_fk.MHRSkeleton()
        cls.body = _body_session()

    def _check(self, mhr, shape):
        kp, _ = self.body.run(["joints_3d", "vertices"], {"mhr_params": mhr[None].astype(np.float32),
                                                           "shape_params": shape[None].astype(np.float32)})
        pos, _, _ = self.sk.forward(mhr)
        ref = mhr_fk.keypoints_from_joints(pos)
        return max(np.linalg.norm(ref[k] - kp[0][k]) for k in ref)

    def test_zero_and_random_params(self):
        rng = np.random.default_rng(0)
        errs = [self._check(np.zeros(204), np.zeros(45))]
        for _ in range(5):
            p = np.zeros(204)
            p[3:136] = rng.normal(0, 0.3, 133)
            p[136:] = rng.normal(0, 0.1, 68)
            errs.append(self._check(p, rng.normal(0, 0.5, 45)))
        print(f"\n  FK vs mhr-body.onnx (synthetic params): max {max(errs) * 1000:.5f} mm")
        self.assertLess(max(errs), 1e-3)

    def test_demo_predictions(self):
        errs = [self._check(m.astype(np.float64), s) for m, s, _ in _demo_params()]
        print(f"\n  FK vs mhr-body.onnx (InstantHMR on demo GIF, 12 frames): max {max(errs) * 1000:.5f} mm,"
              f" mean {np.mean(errs) * 1000:.5f} mm")
        self.assertLess(max(errs), 1e-3)


class TestProtocol(unittest.TestCase):
    def test_person_json(self):
        import hmr_server
        p = SimpleNamespace(joints_3d_cam=np.zeros((70, 3)), joints_2d=np.zeros((70, 2)), confidence=0.9,
                            bbox=np.zeros(4), mhr_params=np.ones(204) * 0.123456, shape_params=np.zeros(45),
                            cam_trans=np.array([0, 0, 3.0]), focal_length=812.345)
        d = hmr_server.person_json(p)
        self.assertEqual(sorted(d), sorted(hmr_server.PERSON_FIELDS))
        self.assertEqual((len(d["j3d"]), len(d["mhr"]), len(d["shape"]), len(d["cam_t"])), (70, 204, 45, 3))
        self.assertAlmostEqual(d["mhr"][0], 0.12346)
        n = len(json.dumps({"persons": [d]}, separators=(",", ":")))
        print(f"\n  person payload {n / 1024:.1f} KB")
        self.assertLess(n, 8000)


if __name__ == "__main__":
    unittest.main()
