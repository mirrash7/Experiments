"""Per-pole repair assessment: findings + a branded "repair plan" image.

Findings are RULES over the model's own detections around an incident (how many
fragments the pole broke into, whether a stump is left standing, whether the
span is down across the roadway, vegetation on the line). They are inferences,
not separate trained classes — each one names the detections it came from.

Visual language matches scripts/pole_explainer.py: navy header bar, purple rule,
numbered purple chips, white corner accents on each region.
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = "/System/Library/Fonts/Helvetica.ttc"
LOGO = ROOT / "assets" / "roboflow_logo.png"

PURPLE = (0x83, 0x15, 0xF9)
NAVY = (0x10, 0x06, 0x33)
LAVENDER = (0xC4, 0xA9, 0xF4)
WHITE = (255, 255, 255)


def _bgr(c):
    return (c[2], c[1], c[0])


# class-name helpers (models differ; match loosely)
def _is_pole(cls):
    return "pole" in cls.lower()


def _is_transformer(cls):
    return "transformer" in cls.lower()


def _is_damaged_transformer(cls):
    c = cls.lower()
    return "transformer" in c and ("hit" in c or "down" in c or "damag" in c)


def _is_leaning(cls):
    return "lean" in cls.lower()


def _is_veg(cls):
    c = cls.lower()
    return "tree" in c or "branch" in c or "vegit" in c or "veget" in c


def _union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def _overlaps(a, b, pad=0.0):
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])


def _near(a, b, frac, dw):
    """Boxes within `frac` of the frame width of each other."""
    return _overlaps(a, b, pad=frac * dw)


def assess(det, dets, dw, dh, is_alert):
    """Findings for one reported pole.

    det   – the alert detection that opened/refreshed the incident
    dets  – every detection in that same frame (display space)
    Returns [{n, title, action, box, evidence}] ordered for display.
    """
    alerts = [d for d in dets if is_alert(d["class"])]
    cluster = [d for d in alerts if _near(d["box"], det["box"], 0.06, dw)] or [det]
    others = [d for d in dets if d not in alerts]
    findings = []

    # 1. stump left in the ground: a short vertical pole-class box beside the fallen span
    poles = [d for d in others if _is_pole(d["class"]) and not _is_leaning(d["class"])]
    tall = max([d["box"][3] - d["box"][1] for d in poles], default=0)
    cl_box = _union([d["box"] for d in cluster])
    for d in sorted(poles, key=lambda d: -(d["box"][2] - d["box"][0]) * (d["box"][3] - d["box"][1])):
        x1, y1, x2, y2 = d["box"]
        h, w = y2 - y1, x2 - x1
        if h > w and (tall == 0 or h < 0.6 * tall) and _near(d["box"], cl_box, 0.05, dw):
            findings.append({"title": "Stump still in the ground", "action": "Ground crew to extract stump",
                             "box": d["box"], "evidence": f"{d['class']} {d['confidence']:.0%}"})
            break

    # 2. how many pieces the pole broke into
    if len(cluster) >= 2:
        findings.append({"title": f"Pole snapped in {'two' if len(cluster) == 2 else str(len(cluster))}",
                         "action": "Replacement pole required", "box": cl_box,
                         "evidence": f"{len(cluster)} fallen-pole segments"})
    else:
        findings.append({"title": "Pole down", "action": "Replacement pole required", "box": cl_box,
                         "evidence": f"{det['class']} {det['confidence']:.0%}"})

    # 3. transformer brought down with the span (needs a transformer class in the model)
    tx = [d for d in others if _is_transformer(d["class"])
          and (_is_damaged_transformer(d["class"]) or _overlaps(d["box"], cl_box))
          and _near(d["box"], cl_box, 0.04, dw)]
    if tx:
        t0 = max(tx, key=lambda d: d["confidence"])
        findings.append({"title": "Transformer down", "action": "Replacement transformer likely",
                         "box": t0["box"], "evidence": f"{t0['class']} {t0['confidence']:.0%}"})

    # 4. neighbouring pole pulled out of plumb
    lean = [d for d in others if _is_leaning(d["class"]) and _near(d["box"], cl_box, 0.05, dw)]
    if lean:
        l0 = max(lean, key=lambda d: d["confidence"])
        findings.append({"title": "Adjacent pole leaning", "action": "Inspect and re-tension span",
                         "box": l0["box"], "evidence": f"{l0['class']} {l0['confidence']:.0%}"})

    # 5. span lying across the roadway: wide, low in frame (the road runs through frame centre)
    span_w = (cl_box[2] - cl_box[0]) / dw
    if span_w > 0.35 and (cl_box[1] + cl_box[3]) / 2 > 0.45 * dh:
        findings.append({"title": "Conductors down across roadway", "action": "Traffic control + line crew",
                         "box": cl_box, "evidence": f"span crosses {span_w:.0%} of the frame"})

    # 6. vegetation fouling the span
    veg = [d for d in others if _is_veg(d["class"]) and _overlaps(d["box"], cl_box)]
    if veg:
        vb = _union([d["box"] for d in veg])
        pad = 0.04 * dw           # clip to the span's neighbourhood, not the whole treeline
        box = (max(vb[0], cl_box[0] - pad), max(vb[1], cl_box[1] - 4 * pad),
               min(vb[2], cl_box[2] + pad), min(vb[3], cl_box[3] + pad))
        if box[2] - box[0] > 0.02 * dw and box[3] - box[1] > 0.02 * dh:
            findings.append({"title": "Vegetation on the span", "action": "Vegetation crew to clear",
                             "box": box, "evidence": f"{len(veg)} × {veg[0]['class']}"})

    for i, f in enumerate(findings, 1):
        f["n"] = i
    return findings


_logo_cache = {}


def _logo(width):
    if width not in _logo_cache:
        im = Image.open(LOGO).convert("RGBA")
        if im.getextrema()[3][0] == 255:          # no alpha channel: key out white
            arr = np.array(im)
            arr[..., 3] = 255 - arr[..., :3].min(axis=2)
            im = Image.fromarray(arr)
        arr = np.array(im)
        arr[..., :3] = 255                        # tint white for the navy bar
        im = Image.fromarray(arr)
        _logo_cache[width] = im.resize((width, int(im.height * width / im.width)), Image.LANCZOS)
    return _logo_cache[width]


def render_plan(frame, findings, incident_id, scale_from_dw, out_path, width=1600):
    """Branded repair-plan image: the full frame, numbered regions, actions in the header."""
    h, w = frame.shape[:2]
    k = w / scale_from_dw                                  # display space -> source pixels
    out_h = int(width * h / w)
    img = cv2.resize(frame, (width, out_h), interpolation=cv2.INTER_AREA)
    s = width / w

    regions = {}
    for f in findings:
        key = tuple(round(v / 12) for v in f["box"])   # same region within ~12px
        regions.setdefault(key, {"box": f["box"], "ns": []})["ns"].append(str(f["n"]))
    for reg in regions.values():
        x0, y0, x1, y1 = [v * k * s for v in reg["box"]]
        p0 = (int(max(2, x0)), int(max(2, y0)))
        p1 = (int(min(width - 2, x1)), int(min(out_h - 2, y1)))
        cv2.rectangle(img, p0, p1, _bgr(PURPLE), 3)
        L = max(18, int(0.02 * width))                     # white corner accents
        for cx, cy, dx, dy in ((p0[0], p0[1], 1, 1), (p1[0], p0[1], -1, 1),
                               (p0[0], p1[1], 1, -1), (p1[0], p1[1], -1, -1)):
            cv2.line(img, (cx, cy), (cx + dx * L, cy), _bgr(WHITE), 3)
            cv2.line(img, (cx, cy), (cx, cy + dy * L), _bgr(WHITE), 3)
        lab = ",".join(reg["ns"])   # cv2 Hershey fonts are ASCII-only                           # numbered chip
        bw, bh = 12 + 20 * len(lab), 38
        by = max(bh, p0[1])
        cv2.rectangle(img, (p0[0], by - bh), (p0[0] + bw, by), _bgr(PURPLE), -1)
        cv2.putText(img, lab, (p0[0] + 9, by - 11), cv2.FONT_HERSHEY_SIMPLEX, 0.75, _bgr(WHITE), 2)

    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)).convert("RGBA")
    bar_h = int(out_h * 0.15)
    ov = Image.new("RGBA", pil.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.rectangle((0, 0, width, bar_h), fill=(*NAVY, 220))
    d.rectangle((0, bar_h - 4, width, bar_h), fill=(*PURPLE, 255))
    f_title = ImageFont.truetype(FONT, int(bar_h * 0.36))
    f_body = ImageFont.truetype(FONT, int(bar_h * 0.22))
    d.text((34, bar_h * 0.20), f"Repair plan · {incident_id}", font=f_title, fill=(*WHITE, 255))
    actions = "   ·   ".join(dict.fromkeys(f["action"] for f in findings))
    d.text((34, bar_h * 0.62), actions, font=f_body, fill=(*LAVENDER, 255))
    lg = _logo(int(width * 0.14))
    ov.alpha_composite(lg, (width - lg.width - 34, (bar_h - lg.height) // 2))
    out = cv2.cvtColor(np.array(Image.alpha_composite(pil, ov).convert("RGB")), cv2.COLOR_RGB2BGR)

    tmp = Path(str(out_path) + ".tmp.jpg")
    cv2.imwrite(str(tmp), out, [cv2.IMWRITE_JPEG_QUALITY, 88])
    import os
    os.replace(tmp, out_path)
    return out_path
