"""Recreate the VIS 2026 social banner (1584x396) for the strip footer.

If an official export exists at photobooth/vis_banner.png it is used verbatim
by the strip compositor; this module just regenerates the approximation.
"""

from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BLACK = (20, 18, 17)
LAVENDER = (196, 169, 244)
LAV_DIM = (120, 100, 160)
WHITE = (240, 240, 240)

HEAVY = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
MONO = "/System/Library/Fonts/Menlo.ttc"
SANS = "/System/Library/Fonts/HelveticaNeue.ttc"


def _font(path, size, fallback=SANS):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(fallback, size)


def _dots(d, x0, y0, cols, rows, step, r, color):
    for i in range(cols):
        for j in range(rows):
            x, y = x0 + i * step, y0 + j * step
            d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def _plus_grid(d, x0, y0, cols, rows, step, s, color):
    for i in range(cols):
        for j in range(rows):
            x, y = x0 + i * step, y0 + j * step
            d.line([x - s, y, x + s, y], fill=color, width=2)
            d.line([x, y - s, x, y + s], fill=color, width=2)


def make_banner(W=1584, H=396):
    img = Image.new("RGB", (W, H), BLACK)
    d = ImageDraw.Draw(img)

    _dots(d, 22, 22, 4, 4, 26, 4, LAV_DIM)
    _dots(d, W - 100, 22, 4, 4, 26, 4, LAV_DIM)
    _plus_grid(d, W - 560, H - 78, 8, 3, 26, 5, (70, 58, 92))

    mono_s = _font(MONO, 26)
    text = "SAN FRANCISCO"
    tw = d.textlength(text, font=mono_s)
    d.text((610 - tw / 2, 32), text, font=mono_s, fill=WHITE)

    vis_font = _font(HEAVY, 240)
    d.text((450, 50), "VIS", font=vis_font, fill=LAVENDER)

    # circular mark: lavender disc with a dark s-swirl
    cx, cy, r = 985, 120, 34
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=LAVENDER)
    d.arc([cx - r * 0.62, cy - r * 0.66, cx + r * 0.30, cy + r * 0.28],
          150, 400, fill=BLACK, width=9)
    d.arc([cx - r * 0.30, cy - r * 0.28, cx + r * 0.62, cy + r * 0.66],
          330, 220, fill=BLACK, width=9)

    date_f = _font(MONO, 30)
    text = "10.22.2026"
    tw = d.textlength(text, font=date_f)
    d.text((690 - tw / 2, H - 62), text, font=date_f, fill=LAVENDER)

    title_f = _font(SANS, 42)
    d.text((1128, 158), "Visual Intelligence", font=title_f, fill=WHITE)
    d.text((1128, 206), "Summit", font=title_f, fill=WHITE)
    by_f = _font(SANS, 26)
    d.text((1128 + d.textlength("Summit ", font=title_f), 218), "by ",
           font=by_f, fill=(150, 150, 150))
    rf_f = _font(HEAVY, 28)
    d.text((1128 + d.textlength("Summit ", font=title_f) + d.textlength("by ", font=by_f), 214),
           "roboflow", font=rf_f, fill=WHITE)

    url_f = _font(MONO, 26)
    d.text((W - 60 - d.textlength("summit.roboflow.com", font=url_f), H - 62),
           "summit.roboflow.com", font=url_f, fill=(150, 120, 220))

    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


if __name__ == "__main__":
    out = Path(__file__).parent / "vis_banner_generated.png"
    cv2.imwrite(str(out), make_banner())
    print(f"wrote {out}")
