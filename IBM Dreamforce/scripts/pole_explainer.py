"""Evidence-first explainer video from one still: slow camera moves into each region of the
fallen pole, one callout at a time, then a summary pull-back. No generation, no API cost.

  .venv/bin/python scripts/pole_explainer.py --preview      # one frame per shot -> contact sheet
  .venv/bin/python scripts/pole_explainer.py --render       # full 1080p30 render
"""
import argparse
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "footage" / "final" / "stills" / "reel_30s_fallen-pole_2K_full.png"   # 2560x1440
OUT_DIR = ROOT / "footage" / "final" / "stills"
W, H, FPS = 1920, 1080, 30
FONT = "/System/Library/Fonts/Helvetica.ttc"

# regions in source-frame pixels (x0, y0, x1, y1)
REG = {
    "stump":       (60, 720, 150, 1225),
    "pole":        (600, 1110, 1610, 1225),
    "pole_lower":  (110, 1168, 618, 1246),
    "transformer": (1320, 1118, 1465, 1230),
    "crossarm":    (1550, 970, 1670, 1262),
    "pole2":       (1035, 672, 1400, 738),
}
FULL = (0, 0, 2560, 1440)


def window(cx, cy, w):
    """16:9 window of width w centred on (cx, cy), clamped to the frame."""
    h = w * 9 / 16
    x0 = min(max(0, cx - w / 2), 2560 - w); y0 = min(max(0, cy - h / 2), 1440 - h)
    return (x0, y0, x0 + w, y0 + h)


# shots: (seconds, window_from, window_to, hold_seconds_at_end, callout)
# callout = (number, title, implication, region_key, colour)
SHOTS = [
    (3.5, FULL, FULL, 0, ("", "Fallen pole assessment", "3 findings from one drone frame", None)),
    (6.8, FULL, window(200, 1060, 640), 4.8, ("1", "Stump still in the ground", "Ground crew needed", "stump")),
    (6.0, window(200, 1060, 640), window(860, 1170, 1600), 3.5, ("2", "Pole snapped in two", "New pole needed", "pole")),
    (6.0, window(860, 1170, 1600), window(1392, 1174, 560), 4.0, ("3", "Transformer down", "Replacement likely", "transformer")),
    (7.0, window(1392, 1174, 560), FULL, 5.0, ("", "Repair plan", "Ground crew  ·  New pole  ·  New transformer", "all")),
]
# Roboflow palette (BGR for OpenCV, RGB for PIL)
PURPLE = (0x83, 0x15, 0xF9); PURPLE_DK = (0x67, 0x06, 0xCE); NAVY = (0x10, 0x06, 0x33); LAVENDER = (0xC4, 0xA9, 0xF4); WHITE = (255, 255, 255)
def bgr(c): return (c[2], c[1], c[0])
LOGO = ROOT / "assets" / "roboflow_logo.png"


def ease(t):
    return t * t * (3 - 2 * t)


def lerp_win(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(4))


_logo_cache = {}


def logo_rgba(width):
    if width not in _logo_cache:
        im = Image.open(LOGO).convert("RGBA")
        if im.getextrema()[3][0] == 255:  # no transparency: key out white
            arr = np.array(im); a = 255 - (arr[..., :3].min(axis=2)); arr[..., 3] = a; im = Image.fromarray(arr)
        # tint to white (keep alpha) so it reads on the navy backdrop
        arr = np.array(im); arr[..., :3] = 255; im = Image.fromarray(arr)
        h = int(im.height * width / im.width); _logo_cache[width] = im.resize((width, h), Image.LANCZOS)
    return _logo_cache[width]


def render_frame(src, win, callout, alpha):
    x0, y0, x1, y1 = win
    crop = src[int(y0):int(y1), int(x0):int(x1)]
    frame = cv2.resize(crop, (W, H), interpolation=cv2.INTER_LANCZOS4 if (x1 - x0) < 2560 else cv2.INTER_AREA)
    if (x1 - x0) < 1400:
        blur = cv2.GaussianBlur(frame, (0, 0), 1.5); frame = cv2.addWeighted(frame, 1.3, blur, -0.3, 0)
    sx, sy = W / (x1 - x0), H / (y1 - y0)
    num, title, impl, key = callout
    keys = ["stump", "pole", "pole_lower", "transformer"] if key == "all" else (["pole", "pole_lower"] if key == "pole" else ([key] if key else []))
    for kk in keys:
        rx0, ry0, rx1, ry1 = REG[kk]
        p0 = (int((rx0 - x0) * sx), int((ry0 - y0) * sy)); p1 = (int((rx1 - x0) * sx), int((ry1 - y0) * sy))
        ov = frame.copy()
        cv2.rectangle(ov, p0, p1, bgr(PURPLE), 6)
        # corner accents
        L = 40
        for (cx, cy, dx, dy) in ((p0[0], p0[1], 1, 1), (p1[0], p0[1], -1, 1), (p0[0], p1[1], 1, -1), (p1[0], p1[1], -1, -1)):
            cv2.line(ov, (cx, cy), (cx + dx * L, cy), bgr(WHITE), 6); cv2.line(ov, (cx, cy), (cx, cy + dy * L), bgr(WHITE), 6)
        frame = cv2.addWeighted(ov, alpha, frame, 1 - alpha, 0)
        if key == "all" and kk != "pole_lower":
            lab = {"stump": "1", "pole": "2", "transformer": "3"}[kk]
            cv2.rectangle(frame, (p0[0], p0[1] - 64), (p0[0] + 70, p0[1]), bgr(PURPLE), -1)
            cv2.putText(frame, lab, (p0[0] + 16, p0[1] - 14), cv2.FONT_HERSHEY_SIMPLEX, 1.6, bgr(WHITE), 4)
    img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).convert("RGBA")
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    f_title = ImageFont.truetype(FONT, 88); f_body = ImageFont.truetype(FONT, 56); f_num = ImageFont.truetype(FONT, 84)
    panel_h = 230
    top = True  # all text at the top
    py = 0 if top else H - panel_h
    d.rectangle((0, py, W, py + panel_h), fill=(*NAVY, int(215 * alpha)))
    d.rectangle((0, py + panel_h - 6, W, py + panel_h), fill=(*PURPLE, int(255 * alpha)))  # purple rule
    tx = 60
    if num:
        d.rounded_rectangle((tx, py + 52, tx + 110, py + 162), 18, fill=(*PURPLE, int(255 * alpha)))
        d.text((tx + 55, py + 107), num, font=f_num, fill=(*WHITE, int(255 * alpha)), anchor="mm")
        tx += 150
    d.text((tx, py + 38), title, font=f_title, fill=(*WHITE, int(255 * alpha)))
    d.text((tx, py + 140), impl, font=f_body, fill=(*LAVENDER, int(255 * alpha)))
    # logo, always on, right side of the panel
    lg = logo_rgba(360)
    lx, ly = W - lg.width - 60, py + (panel_h - lg.height) // 2
    la = lg.copy(); la.putalpha(la.getchannel("A").point(lambda v: int(v * max(alpha, 0.001))))
    ov.alpha_composite(la, (lx, ly))
    out = Image.alpha_composite(img, ov).convert("RGB")
    return cv2.cvtColor(np.array(out), cv2.COLOR_RGB2BGR)


def frames():
    src = cv2.imread(str(SRC))
    for dur, wa, wb, hold, callout in SHOTS:
        n = int(dur * FPS); move = n - int(hold * FPS)
        for i in range(n):
            t = ease(min(1.0, i / max(1, move - 1))) if move > 0 else 1.0
            win = lerp_win(wa, wb, t)
            # callout fades in over the last part of the move / start of the hold
            alpha = min(1.0, max(0.0, (i - move * 0.25) / (FPS * 0.5))) if move > 0 else min(1.0, i / (FPS * 0.6))
            yield render_frame(src, win, callout, alpha)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--preview", action="store_true"); ap.add_argument("--render", action="store_true")
    a = ap.parse_args()
    if a.preview:
        src = cv2.imread(str(SRC)); tiles = []
        for dur, wa, wb, hold, callout in SHOTS:
            f = render_frame(src, wb, callout, 1.0); t = cv2.resize(f, (960, 540)); tiles.append(t)
        tiles.append(np.zeros_like(tiles[0]))
        rows = [np.hstack(tiles[i:i + 2]) for i in range(0, 6, 2)]
        p = OUT_DIR / "pole_explainer_preview.jpg"; cv2.imwrite(str(p), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88]); print("->", p)
    if a.render:
        import imageio_ffmpeg
        out = OUT_DIR / "pole_assessment_explainer.mp4"
        enc = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
                                "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                                "-movflags", "+faststart", str(out)], stdin=subprocess.PIPE)
        n = 0
        for f in frames():
            enc.stdin.write(f.tobytes()); n += 1
        enc.stdin.close(); enc.wait(); print(f"-> {out} ({n / FPS:.1f}s, {n} frames)")


if __name__ == "__main__":
    main()
