"""Generate a demo conference pass the photobooth can OCR-read.

    ../.venv/bin/python make_pass.py --name Alex [--handwritten]

Writes pass_<name>.png — print it or show it on a phone. --handwritten renders
the name in a handwriting-style font to demo OCR on non-printed badges.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

RF_PURPLE_RGB = (131, 21, 249)
RF_NAVY_RGB = (16, 6, 51)

PRINT_FONT = "/System/Library/Fonts/HelveticaNeue.ttc"
HAND_FONT = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--handwritten", action="store_true",
                    help="render the name in a handwriting-style font")
    args = ap.parse_args()

    W, H = 560, 800
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W, 150], fill=RF_PURPLE_RGB)
    d.rectangle([0, 150, W, 158], fill=RF_NAVY_RGB)
    title = ImageFont.truetype(PRINT_FONT, 46)
    sub = ImageFont.truetype(PRINT_FONT, 26)
    for text, font, y in (("SAFETY SUMMIT", title, 40), ("SITE ACCESS PASS", sub, 96)):
        tw = d.textlength(text, font=font)
        d.text(((W - tw) // 2, y), text, font=font, fill=(255, 255, 255))

    label = ImageFont.truetype(PRINT_FONT, 28)
    tw = d.textlength("NAME", font=label)
    d.text(((W - tw) // 2, 240), "NAME", font=label, fill=(150, 145, 160))

    name_font_path = HAND_FONT if args.handwritten else PRINT_FONT
    size = 130 if len(args.name) <= 6 else 90
    try:
        name_font = ImageFont.truetype(name_font_path, size)
    except OSError:
        name_font = ImageFont.truetype(PRINT_FONT, size)
    name = args.name if args.handwritten else args.name.upper()
    tw = d.textlength(name, font=name_font)
    d.text(((W - tw) // 2, 320), name, font=name_font, fill=RF_NAVY_RGB)
    d.line([(W // 2 - 200, 500), (W // 2 + 200, 500)], fill=RF_NAVY_RGB, width=3)

    hint = ImageFont.truetype(PRINT_FONT, 24)
    text = "SHOW THIS PASS AT THE SAFETY PHOTOBOOTH"
    tw = d.textlength(text, font=hint)
    d.text(((W - tw) // 2, 560), text, font=hint, fill=(120, 110, 100))
    brand = ImageFont.truetype(PRINT_FONT, 30)
    text = "powered by roboflow"
    tw = d.textlength(text, font=brand)
    d.text(((W - tw) // 2, H - 70), text, font=brand, fill=RF_PURPLE_RGB)

    out = Path(__file__).parent / f"pass_{args.name.lower()}.png"
    cv2.imwrite(str(out), cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
