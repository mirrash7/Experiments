"""Render a 'Repair plan' still in the explainer style (Roboflow palette, top panel, logo,
numbered purple boxes). Spec: JSON with {"src", "out", "title", "plan", "items": [[num, x0,y0,x1,y1], ...]}
coordinates in source-frame pixels (2560x1440); output is 1920x1080.

  .venv/bin/python scripts/repair_plan_still.py spec.json
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pole_explainer import logo_rgba, PURPLE, NAVY, LAVENDER, WHITE, bgr, FONT, W, H  # noqa: E402


def render(spec):
    src = cv2.imread(spec["src"]); sh, sw = src.shape[:2]
    frame = cv2.resize(src, (W, H), interpolation=cv2.INTER_AREA); sx, sy = W / sw, H / sh
    for num, x0, y0, x1, y1 in spec["items"]:
        p0 = (int(x0 * sx), int(y0 * sy)); p1 = (int(x1 * sx), int(y1 * sy))
        cv2.rectangle(frame, p0, p1, bgr(PURPLE), 6)
        L = 40
        for (cx, cy, dx, dy) in ((p0[0], p0[1], 1, 1), (p1[0], p0[1], -1, 1), (p0[0], p1[1], 1, -1), (p1[0], p1[1], -1, -1)):
            cv2.line(frame, (cx, cy), (cx + dx * L, cy), bgr(WHITE), 6); cv2.line(frame, (cx, cy), (cx, cy + dy * L), bgr(WHITE), 6)
        cv2.rectangle(frame, (p0[0], p0[1] - 64), (p0[0] + 70, p0[1]), bgr(PURPLE), -1)
        cv2.putText(frame, str(num), (p0[0] + 16, p0[1] - 14), cv2.FONT_HERSHEY_SIMPLEX, 1.6, bgr(WHITE), 4)
    img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).convert("RGBA")
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    f_title = ImageFont.truetype(FONT, 88); f_body = ImageFont.truetype(FONT, 56)
    panel_h = 230
    d.rectangle((0, 0, W, panel_h), fill=(*NAVY, 215)); d.rectangle((0, panel_h - 6, W, panel_h), fill=(*PURPLE, 255))
    d.text((60, 38), spec.get("title", "Repair plan"), font=f_title, fill=(*WHITE, 255))
    d.text((60, 140), spec["plan"], font=f_body, fill=(*LAVENDER, 255))
    lg = logo_rgba(360); ov.alpha_composite(lg, (W - lg.width - 60, (panel_h - lg.height) // 2))
    out = Image.alpha_composite(img, ov).convert("RGB")
    out.save(spec["out"], quality=95); print("->", spec["out"])


if __name__ == "__main__":
    for spec_path in sys.argv[1:]:
        render(json.loads(Path(spec_path).read_text()))
