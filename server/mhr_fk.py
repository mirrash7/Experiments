"""NumPy forward kinematics of the MHR skeleton, from the JSON rig the browser also uses
(`web/public/motion/mhr-rig.json`, written by `tools/extract_mhr_rig.py`).

This is the reference the JS port (`web/src/motion/mhrFK.js`) is checked against, and the server tests use it
to check the rig against InstantHMR's `mhr-body.onnx`. Per joint: local = (offset + t, prerot * eulerXYZ(r),
2**s); global = parent o local. MHR units (cm, y up); `to_camera` converts to InstantHMR's camera axes.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

RIG = Path(__file__).resolve().parent.parent / "web" / "public" / "motion" / "mhr-rig.json"

# MHR70 keypoints that are a pure readout of one skeleton joint (W_vert = 0), as (keypoint, [(joint, w)])
KP_FROM_JOINT = {5: [(75, 1)], 6: [(39, 1)], 9: [(2, 1)], 10: [(18, 1)], 11: [(3, 1)], 12: [(19, 1)],
                 41: [(42, 1)], 62: [(78, 1)], 69: [(110, .5), (111, .5)]}


def qmul(a, b):
    x1, y1, z1, w1 = np.moveaxis(a, -1, 0)
    x2, y2, z2, w2 = np.moveaxis(b, -1, 0)
    return np.stack((w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
                     w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2), -1)


def qrot(q, v):
    u, w = q[..., :3], q[..., 3:]
    t = 2 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def euler_xyz(e):
    cr, sr = np.cos(e[..., 0] / 2), np.sin(e[..., 0] / 2)
    cp, sp = np.cos(e[..., 1] / 2), np.sin(e[..., 1] / 2)
    cy, sy = np.cos(e[..., 2] / 2), np.sin(e[..., 2] / 2)
    return np.stack((sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy,
                     cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy), -1)


class MHRSkeleton:
    def __init__(self, path: Path | str = RIG):
        r = json.loads(Path(path).read_text())
        self.names, self.parents = r["joints"], np.array(r["parents"])
        self.offsets, self.prerot = np.array(r["offsets"]), np.array(r["prerot"])
        n = len(self.names)
        self.T = np.zeros((n * 7, len(r["params"])))
        for row, col, v in r["transform"]:
            self.T[row, col] = v

    def forward(self, params: np.ndarray):
        """params (204,) -> (positions (127,3) cm, global quats (127,4) xyzw, scales (127,))"""
        jp = (self.T @ np.asarray(params, np.float64)).reshape(-1, 7)
        lt, lq, ls = jp[:, :3] + self.offsets, qmul(self.prerot, euler_xyz(jp[:, 3:6])), 2.0 ** jp[:, 6]
        n = len(self.names)
        gt, gq, gs = np.zeros((n, 3)), np.zeros((n, 4)), np.zeros(n)
        for j in range(n):
            p = self.parents[j]
            if p < 0:
                gt[j], gq[j], gs[j] = lt[j], lq[j], ls[j]
            else:
                gt[j] = gt[p] + gs[p] * qrot(gq[p], lt[j])
                gq[j], gs[j] = qmul(gq[p], lq[j]), gs[p] * ls[j]
        return gt, gq, gs


def to_camera(xyz_cm: np.ndarray) -> np.ndarray:
    """MHR (cm, y up, z back) -> InstantHMR camera axes (m, y down, z forward)."""
    return xyz_cm * np.array([0.01, -0.01, -0.01])


def keypoints_from_joints(pos_cm: np.ndarray) -> dict:
    cam = to_camera(pos_cm)
    return {k: sum(w * cam[j] for j, w in js) for k, js in KP_FROM_JOINT.items()}
