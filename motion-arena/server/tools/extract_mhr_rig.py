#!/usr/bin/env python3
"""Extract the MHR skeleton constants the browser needs for forward kinematics into a small JSON asset.

Reads Meta's TorchScript rig `mhr_model.pt` (MHR release `mhr_assets.zip`, Apache-2.0; also shipped in the
facebook/sam-3d-body-dinov3 snapshot) and writes `web/public/motion/mhr-rig.json`:

  joints        127 joint names                parents     parent index (-1 for the root)
  offsets       (127, 3) joint translation offsets, MHR units (cm, y up)
  prerot        (127, 4) joint pre-rotations, quaternion xyzw
  params        the 204 model-parameter names (136 pose + 68 skeleton scale)
  transform     sparse parameter transform [row, col, value]: joint_params[row] += value * model_params[col],
                joint_params is (127 x 7) flattened: tx ty tz rx ry rz s (Euler XYZ radians, log2 scale)
  limits        [param_index, min, max] (MHR's min/max parameter limits)

Needs torch (run with any venv that has it, e.g. the MHR package venv):
  python server/tools/extract_mhr_rig.py --rig /path/to/mhr_model.pt
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
N = 204


def main():
    ap = argparse.ArgumentParser()
    default = (glob.glob(str(Path.home() / ".cache/huggingface/hub/models--facebook--sam-3d-body-dinov3/snapshots/*/assets/mhr_model.pt")) or [None])[0]
    ap.add_argument("--rig", default=default)
    ap.add_argument("--out", default=str(ROOT / "web/public/motion/mhr-rig.json"))
    a = ap.parse_args()
    rig = torch.jit.load(a.rig, map_location="cpu").eval()
    ct = rig.character_torch
    sk, pt, pl = ct.skeleton, ct.parameter_transform, ct.parameter_limits
    T = pt.parameter_transform.numpy()
    assert not T[:, N:].any(), "transform uses identity (blend) columns"
    rows, cols = np.nonzero(T[:, :N])
    lim = [[int(i), round(float(lo), 5), round(float(hi), 5)]
           for i, lo, hi in zip(pl.minmax_parameter_index.tolist(), pl.minmax_min.tolist(), pl.minmax_max.tolist())]
    out = dict(
        source="MHR mhr_model.pt (facebookresearch/MHR, Apache-2.0)",
        units="cm, y up, z toward the character's front; quaternions xyzw",
        joints=list(sk.joint_names), parents=sk.joint_parents.tolist(),
        offsets=np.round(sk.joint_translation_offsets.numpy().astype(np.float64), 5).tolist(),
        prerot=np.round(sk.joint_prerotations.numpy().astype(np.float64), 7).tolist(),
        params=list(ct.parameter_names)[:N] if hasattr(ct, "parameter_names") else list(pt.parameter_names)[:N],
        transform=[[int(r), int(c), round(float(T[r, c]), 6)] for r, c in zip(rows, cols)],
        limits=lim,
    )
    Path(a.out).write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {a.out}: {len(out['joints'])} joints, {len(out['transform'])} transform entries, "
          f"{len(lim)} limits, {Path(a.out).stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
