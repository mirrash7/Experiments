"""Site Safety Photobooth — Roboflow edition.

Flow:
  1. SCAN    — guest holds up their conference pass; the booth OCR-reads the
               name (printed or handwritten, via Apple Vision) and matches it
               against the registrant list in attendees.json.
  2. GEAR    — the booth checks their PPE (hardhat, vest, gloves).
  3. READY   — fully geared: hold a hand in the corner target to arm.
  4. SHOOT   — countdown, three photos.
  5. RESULT  — Roboflow-branded strip on screen, saved, and emailed to the
               address associated with the guest (QR payload or attendees.json).

Voice narration exists but is OFF by default (enable with --speak).

Usage:
    ../.venv/bin/python photobooth.py [--camera 0] [--required hardhat,vest,gloves]
                                      [--countdown 3] [--speak] [--no-mirror]

Keys:  q = quit   f = fullscreen
"""

import argparse
import difflib
import json
import math
import os
import queue
import random
import re
import shutil
import smtplib
import subprocess
import threading
import time
from collections import deque
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

import cv2
import numpy as np
import supervision as sv
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env", override=True)
os.environ.setdefault("ONNXRUNTIME_EXECUTION_PROVIDERS", "CPUExecutionProvider")
os.environ.setdefault("MODEL_CACHE_DIR",
                      str(Path(__file__).resolve().parent.parent / ".model-cache"))
for _flag in ("CORE_MODEL_SAM_ENABLED", "CORE_MODEL_SAM3_ENABLED",
              "CORE_MODEL_YOLO_WORLD_ENABLED", "CORE_MODEL_GAZE_ENABLED"):
    os.environ.setdefault(_flag, "False")

MODEL_ID = "ppe-compliance-m8dqs-z8dcg/2"

PPE_CLASSES = {
    "hardhat": ({"head_helmet"}, {"head_nohelmet"}),
    "vest": ({"vest"}, set()),
    "gloves": ({"hand_glove"}, {"hand_noglove"}),
    "mask": ({"face_mask"}, {"face_nomask"}),
    "glasses": ({"glasses"}, set()),
    "boots": ({"boots"}, set()),
}
HAND_CLASSES = {"hand_glove", "hand_noglove"}
PERSON_CLASS = "person"
OK, MISSING, UNKNOWN = "OK", "MISSING", "UNKNOWN"

HOLD_TO_ARM_S = 1.2
SHOT_GAP_S = 2.6
RESULT_SHOW_S = 12.0
IDLE_RESET_S = 15.0      # nobody in frame this long -> back to pass scan

# Roboflow palette (BGR)
RF_PURPLE = (249, 21, 131)     # #8315F9
RF_NAVY = (51, 6, 16)          # #100633
RF_LILAC = (255, 244, 248)     # #F8F4FF
GREEN = (110, 200, 90)
RED = (70, 70, 235)
AMBER = (50, 170, 250)
WHITE = (245, 245, 245)
DIM = (190, 190, 190)
PANEL = (30, 26, 22)

FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_TITLE = cv2.FONT_HERSHEY_DUPLEX


# ---------------------------------------------------------------- voice (off by default)

LINES = {
    "scan": ["Mornin'! Scan that conference pass and we'll get you camera-ready."],
    "welcome": ["Well hey there, {name}! Let's see that safety gear."],
    "gear_missing": ["Still missing {items}, bud. Gear up!"],
    "gear_ok": ["Lookin' regulation handsome, {name}! Hand in the box when you're ready."],
    "countdown": ["Here we go!"],
    "between_shots": ["That's a keeper!", "Beautiful! Say 'safety'!"],
    "abort": ["Hey, keep that gear on mid-shoot!"],
    "done": ["Check your inbox, {name} — and stay safe out there."],
}


class Foreman(threading.Thread):
    """Async TTS. Muted unless --speak is passed."""

    def __init__(self, voice, rate=180, muted=True):
        super().__init__(daemon=True)
        self.voice = voice
        self.muted = muted
        self.rate = rate
        self.q = queue.Queue(maxsize=3)
        self.last_by_cat = {}
        self.running = True

    def say(self, category, min_gap=0.0, **fmt):
        if self.muted:
            return
        now = time.time()
        if now - self.last_by_cat.get(category, 0.0) < min_gap:
            return
        self.last_by_cat[category] = now
        try:
            self.q.put_nowait(random.choice(LINES[category]).format(**fmt))
        except queue.Full:
            pass

    def run(self):
        while self.running:
            try:
                text = self.q.get(timeout=0.2)
            except queue.Empty:
                continue
            cmd = ["say", "-r", str(self.rate)]
            if self.voice:
                cmd += ["-v", self.voice]
            subprocess.run(cmd + [text], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- guests & email

def match_registrant(texts, attendees):
    """Fuzzy-match OCR'd text against the registrant list.

    Every alphabetic token from every recognized line is compared against the
    registrant names (cutoff 0.8 tolerates OCR slips like 'Alcx'). Returns
    (canonical name, email) or (None, None) when nobody on the list matches.
    """
    for line in texts:
        for token in re.findall(r"[A-Za-z]+", line):
            t = token.lower()
            if len(t) < 3:
                continue
            best = difflib.get_close_matches(t, attendees.keys(), n=1, cutoff=0.8)
            if best:
                return best[0].capitalize(), attendees[best[0]]
    return None, None


class OCRWorker(threading.Thread):
    """Runs Apple Vision text recognition on the most recent frame."""

    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.frame = None
        self.texts = []
        self.running = True

    def submit(self, frame):
        with self.lock:
            self.frame = frame

    def latest(self):
        with self.lock:
            texts, self.texts = self.texts, []
            return texts

    def clear(self):
        with self.lock:
            self.frame, self.texts = None, []

    def run(self):
        from vision_ocr import recognize_text
        while self.running:
            with self.lock:
                frame, self.frame = self.frame, None
            if frame is None:
                time.sleep(0.02)
                continue
            texts = recognize_text(frame)
            if texts:
                with self.lock:
                    self.texts = texts


def mask_email(email):
    user, _, dom = email.partition("@")
    return (user[0] + "***" if user else "***") + "@" + dom


class EmailSender(threading.Thread):
    """Sends the strip via SMTP if configured in .env, else queues to outbox/."""

    def __init__(self, outbox):
        super().__init__(daemon=True)
        self.outbox = outbox
        self.q = queue.Queue()
        self.running = True
        self.host = os.environ.get("SMTP_HOST")
        self.port = int(os.environ.get("SMTP_PORT", "587"))
        self.user = os.environ.get("SMTP_USER")
        self.password = os.environ.get("SMTP_PASSWORD")
        self.sender = os.environ.get("SMTP_FROM", self.user)
        self.configured = bool(self.host and self.user and self.password)

    def send(self, to_addr, name, strip_path):
        self.q.put((to_addr, name, strip_path))

    def _smtp_send(self, to_addr, name, strip_path):
        msg = EmailMessage()
        msg["Subject"] = "Your Site Safety Photobooth strip"
        msg["From"] = self.sender
        msg["To"] = to_addr
        msg.set_content(
            f"Hey {name},\n\nYou passed the gear check — here's your photobooth "
            "strip. Stay safe out there!\n\n— The Site Safety Photobooth, "
            "powered by Roboflow"
        )
        with open(strip_path, "rb") as f:
            msg.add_attachment(f.read(), maintype="image", subtype="jpeg",
                               filename=Path(strip_path).name)
        with smtplib.SMTP(self.host, self.port, timeout=15) as s:
            s.starttls()
            s.login(self.user, self.password)
            s.send_message(msg)

    def run(self):
        while self.running:
            try:
                to_addr, name, strip_path = self.q.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                if self.configured:
                    self._smtp_send(to_addr, name, strip_path)
                    print(f"[EMAIL] sent {Path(strip_path).name} -> {to_addr}")
                else:
                    raise RuntimeError("SMTP not configured")
            except Exception as e:
                self.outbox.mkdir(exist_ok=True)
                dest = self.outbox / Path(strip_path).name
                shutil.copy2(strip_path, dest)
                meta = {"to": to_addr, "name": name, "file": dest.name,
                        "time": datetime.now().isoformat(timespec="seconds"),
                        "reason": str(e)}
                with open(self.outbox / "outbox.log", "a") as f:
                    f.write(json.dumps(meta) + "\n")
                print(f"[EMAIL] queued to outbox for {to_addr} ({e})")


# ---------------------------------------------------------------- inference

class InferenceWorker(threading.Thread):
    def __init__(self, model, confidence):
        super().__init__(daemon=True)
        self.model = model
        self.confidence = confidence
        self.lock = threading.Lock()
        self.frame = None
        self.result = None
        self.running = True

    def submit(self, frame):
        with self.lock:
            self.frame = frame

    def latest(self):
        with self.lock:
            return self.result

    def run(self):
        while self.running:
            with self.lock:
                frame, self.frame = self.frame, None
            if frame is None:
                time.sleep(0.005)
                continue
            res = self.model.infer(frame, confidence=self.confidence)
            res = res[0] if isinstance(res, list) else res
            with self.lock:
                self.result = sv.Detections.from_inference(res)


def overlap_ratio(item_xyxy, person_xyxy):
    ax1, ay1, ax2, ay2 = item_xyxy
    bx1, by1, bx2, by2 = person_xyxy
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    return inter / max(1.0, (ax2 - ax1) * (ay2 - ay1))


def gear_status(detections, required):
    if detections is None or len(detections) == 0:
        return None, {}
    names = detections.data["class_name"]
    people_idx = [i for i in range(len(detections)) if names[i] == PERSON_CLASS]
    if not people_idx:
        return None, {}
    areas = [(detections.xyxy[i][2] - detections.xyxy[i][0])
             * (detections.xyxy[i][3] - detections.xyxy[i][1]) for i in people_idx]
    pbox = detections.xyxy[people_idx[int(np.argmax(areas))]]
    assigned = [names[j] for j in range(len(detections))
                if names[j] != PERSON_CLASS and overlap_ratio(detections.xyxy[j], pbox) > 0.5]
    status = {}
    for item in required:
        pos, neg = PPE_CLASSES[item]
        if any(c in neg for c in assigned):
            status[item] = MISSING
        elif any(c in pos for c in assigned):
            status[item] = OK
        elif item == "vest":
            status[item] = MISSING
        else:
            status[item] = UNKNOWN
    return pbox, status


def hand_in_zone(detections, zone):
    if detections is None or len(detections) == 0:
        return False
    names = detections.data["class_name"]
    zx1, zy1, zx2, zy2 = zone
    for i in range(len(names)):
        if names[i] in HAND_CLASSES:
            x1, y1, x2, y2 = detections.xyxy[i]
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            if zx1 <= cx <= zx2 and zy1 <= cy <= zy2:
                return True
    return False


# ---------------------------------------------------------------- drawing

def text_w(text, scale, font=FONT, thick=1):
    return cv2.getTextSize(text, font, scale, thick)[0][0]


def fill(img, x1, y1, x2, y2, color, alpha):
    x1, y1 = max(0, int(x1)), max(0, int(y1))
    x2, y2 = min(img.shape[1], int(x2)), min(img.shape[0], int(y2))
    if x2 <= x1 or y2 <= y1:
        return
    roi = img[y1:y2, x1:x2]
    block = np.empty_like(roi)
    block[:] = color
    cv2.addWeighted(block, alpha, roi, 1 - alpha, 0, roi)


def draw_center_text(img, text, y, scale=1.1, color=WHITE, font=FONT_TITLE):
    x = (img.shape[1] - text_w(text, scale, font, 2)) // 2
    cv2.putText(img, text, (x, y), font, scale, (0, 0, 0), 5, cv2.LINE_AA)
    cv2.putText(img, text, (x, y), font, scale, color, 2, cv2.LINE_AA)


def draw_hotspot(img, zone, active, progress, t):
    x1, y1, x2, y2 = [int(v) for v in zone]
    color = GREEN if active else RF_PURPLE
    dash, gap = 14, 10
    perim = [((x, y1), (min(x + dash, x2), y1)) for x in range(x1, x2, dash + gap)]
    perim += [((x, y2), (min(x + dash, x2), y2)) for x in range(x1, x2, dash + gap)]
    perim += [((x1, y), (x1, min(y + dash, y2))) for y in range(y1, y2, dash + gap)]
    perim += [((x2, y), (x2, min(y + dash, y2))) for y in range(y1, y2, dash + gap)]
    for p1, p2 in perim:
        cv2.line(img, p1, p2, color, 2, cv2.LINE_AA)
    fill(img, x1, y1, x2, y2, color, 0.10 + (0.06 * math.sin(t * 4) if not active else 0.12))
    label = "HOLD HAND HERE"
    cv2.putText(img, label, (x1 + (x2 - x1 - text_w(label, 0.5)) // 2, y1 + 24),
                FONT, 0.5, WHITE, 1, cv2.LINE_AA)
    if progress > 0:
        cx, cy, r = (x1 + x2) // 2, (y1 + y2) // 2, min(x2 - x1, y2 - y1) // 2 - 14
        cv2.ellipse(img, (cx, cy), (r, r), -90, 0, int(progress * 360), GREEN, 4, cv2.LINE_AA)


def draw_gear_row(img, status, required, y):
    chips = []
    for item in required:
        v = status.get(item, UNKNOWN)
        chips.append((item.upper(), {OK: GREEN, MISSING: RED, UNKNOWN: (110, 110, 110)}[v]))
    total = sum(text_w(t, 0.55) + 34 for t, _ in chips) + 10 * (len(chips) - 1)
    x = (img.shape[1] - total) // 2
    for text, color in chips:
        w = text_w(text, 0.55) + 34
        fill(img, x, y, x + w, y + 30, PANEL, 0.75)
        cv2.circle(img, (x + 14, y + 15), 5, color, -1, cv2.LINE_AA)
        cv2.putText(img, text, (x + 26, y + 21), FONT, 0.55, WHITE, 1, cv2.LINE_AA)
        x += w + 10


def draw_header(img, t, guest=None):
    w = img.shape[1]
    fill(img, 0, 0, w, 52, PANEL, 0.85)
    fill(img, 0, 52, w, 55, RF_PURPLE, 0.9)
    cv2.putText(img, "SITE SAFETY PHOTOBOOTH", (18, 33), FONT_TITLE, 0.75, WHITE, 1, cv2.LINE_AA)
    lx = 24 + text_w("SITE SAFETY PHOTOBOOTH", 0.75, FONT_TITLE)
    cv2.putText(img, "powered by Roboflow", (lx + 10, 32), FONT, 0.45, (200, 150, 255), 1, cv2.LINE_AA)
    if guest:
        label = f"GUEST: {guest.upper()}"
        pw = text_w(label, 0.55) + 28
        fill(img, w - pw - 16, 12, w - 16, 40, RF_PURPLE, 0.9)
        cv2.putText(img, label, (w - pw - 2, 32), FONT, 0.55, WHITE, 1, cv2.LINE_AA)


def draw_scan_target(img, t):
    h, w = img.shape[:2]
    s = int(min(w, h) * 0.42)
    x1, y1 = (w - s) // 2, (h - s) // 2
    x2, y2 = x1 + s, y1 + s
    arm = int(s * 0.18)
    pulse = 2 + int(1.5 + 1.5 * math.sin(t * 3))
    for cx, cy, dx, dy in ((x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)):
        cv2.line(img, (cx, cy), (cx + dx * arm, cy), RF_PURPLE, pulse, cv2.LINE_AA)
        cv2.line(img, (cx, cy), (cx, cy + dy * arm), RF_PURPLE, pulse, cv2.LINE_AA)


# ---------------------------------------------------------------- strip (Roboflow branded)

def roboflow_logo(width):
    """Load photobooth/roboflow_logo.png if present, else draw a wordmark."""
    p = Path(__file__).parent / "roboflow_logo.png"
    if p.exists():
        logo = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
        if logo is not None:
            h = int(logo.shape[0] * width / logo.shape[1])
            logo = cv2.resize(logo, (width, h))
            if logo.shape[2] == 4:  # flatten alpha onto white
                alpha = logo[:, :, 3:4] / 255.0
                logo = (logo[:, :, :3] * alpha + 255 * (1 - alpha)).astype(np.uint8)
            return logo
    # drawn wordmark fallback: purple rounded square with 'rf' + 'roboflow'
    from PIL import Image, ImageDraw, ImageFont
    H = max(44, width // 6)
    img = Image.new("RGB", (width, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", int(H * 0.62))
        small = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", int(H * 0.42))
    except OSError:
        font = small = ImageFont.load_default()
    box = H - 8
    tw = d.textlength("roboflow", font=font)
    x0 = (width - (box + 12 + tw)) // 2
    d.rounded_rectangle([x0, 4, x0 + box, 4 + box], radius=box // 4, fill=(131, 21, 249))
    bb = d.textbbox((0, 0), "rf", font=small)
    d.text((x0 + (box - (bb[2] - bb[0])) // 2 - bb[0],
            4 + (box - (bb[3] - bb[1])) // 2 - bb[1]), "rf", font=small, fill=(255, 255, 255))
    bb = d.textbbox((0, 0), "roboflow", font=font)
    d.text((x0 + box + 12, 4 + (box - (bb[3] - bb[1])) // 2 - bb[1]),
           "roboflow", font=font, fill=(16, 6, 51))
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def vis_footer(width):
    """The VIS 2026 banner: official export if present, else the recreation."""
    p = Path(__file__).parent / "vis_banner.png"
    banner = cv2.imread(str(p)) if p.exists() else None
    if banner is None:
        from vis_banner import make_banner
        banner = make_banner()
    h = int(banner.shape[0] * width / banner.shape[1])
    return cv2.resize(banner, (width, h), interpolation=cv2.INTER_AREA)


def compose_strip(shots, guest_name, out_dir):
    """Clean Roboflow-branded strip: logo header, photos, blended VIS footer."""
    pw = 560
    margin, sep = 30, 22
    resized = []
    for s in shots:
        h = int(s.shape[0] * pw / s.shape[1])
        resized.append(cv2.resize(s, (pw, h)))

    top_logo = roboflow_logo(int(pw * 0.40))
    W = pw + 2 * margin
    banner = vis_footer(W)  # full-bleed
    header_h = top_logo.shape[0] + 106  # logo + rule + date line
    photos_h = sum(r.shape[0] for r in resized) + sep * (len(resized) - 1)
    total_h = margin + header_h + photos_h + banner.shape[0]
    strip = np.full((total_h, W, 3), 255, dtype=np.uint8)

    # background: one long white -> banner-black gradient behind the photos,
    # so the black climbs the side margins and gaps and dissolves near the top
    g0 = margin + header_h            # top of first photo
    g1 = margin + header_h + photos_h  # top of banner
    dark = banner[0, 0].astype(np.float64)
    t = np.linspace(0.0, 1.0, g1 - g0)[:, None, None] ** 1.35  # gentle start
    grad = ((1 - t) * np.array([255.0, 255.0, 255.0]) + t * dark).astype(np.uint8)
    strip[g0:g1] = np.repeat(grad, W, axis=1)

    def center(text, y, scale, color, font=FONT, thick=1):
        cv2.putText(strip, text, ((W - text_w(text, scale, font, thick)) // 2, y),
                    font, scale, color, thick, cv2.LINE_AA)

    # header: roboflow logo, thin purple rule, capture date
    lx = (W - top_logo.shape[1]) // 2
    strip[margin + 6:margin + 6 + top_logo.shape[0], lx:lx + top_logo.shape[1]] = top_logo
    ly = margin + 6 + top_logo.shape[0]
    fill(strip, margin, ly + 22, W - margin, ly + 25, RF_PURPLE, 1.0)
    center(datetime.now().strftime("%B %d, %Y").upper(), ly + 66, 0.75, RF_NAVY, FONT_TITLE, 2)

    y = margin + header_h
    for r in resized:
        strip[y:y + r.shape[0], margin:margin + pw] = r
        y += r.shape[0] + sep

    # banner sits directly below the last photo, full-bleed to the bottom edge
    strip[g1:g1 + banner.shape[0]] = banner

    path = out_dir / f"strip_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"
    cv2.imwrite(str(path), strip)
    return strip, path


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Roboflow PPE photobooth")
    ap.add_argument("--camera", default="0", help="camera index or video file")
    ap.add_argument("--confidence", type=float, default=0.4)
    ap.add_argument("--required", default="hardhat,vest,gloves")
    ap.add_argument("--countdown", type=float, default=3.0, help="seconds before the first shot")
    ap.add_argument("--speak", action="store_true", help="enable the foreman voice (off by default)")
    ap.add_argument("--voice", default="Ralph", help="macOS voice when --speak is on")
    ap.add_argument("--no-mirror", action="store_true")
    ap.add_argument("--max-frames", type=int, default=0, help="stop after N frames (testing)")
    ap.add_argument("--save-frame", default=None, help="write rendered view here periodically (testing)")
    args = ap.parse_args()

    required = [r.strip() for r in args.required.split(",") if r.strip()]
    for r in required:
        if r not in PPE_CLASSES:
            ap.error(f"unknown PPE item '{r}' (choose from {list(PPE_CLASSES)})")

    base = Path(__file__).parent
    photos_dir = base / "photos"
    photos_dir.mkdir(exist_ok=True)
    attendees = {}
    attendees_file = base / "attendees.json"
    if attendees_file.exists():
        attendees = {k.lower(): v for k, v in json.loads(attendees_file.read_text()).items()}

    print(f"Loading {MODEL_ID}...")
    from inference import get_model
    model = get_model(MODEL_ID, api_key=os.environ["ROBOFLOW_API_KEY"])

    source = int(args.camera) if args.camera.isdigit() else args.camera
    cap = cv2.VideoCapture(source)
    if isinstance(source, int):
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    worker = InferenceWorker(model, args.confidence)
    worker.start()
    foreman = Foreman(args.voice or None, muted=not args.speak)
    foreman.start()
    mailer = EmailSender(base / "outbox")
    mailer.start()
    if not mailer.configured:
        print("SMTP not configured in ../.env — strips will queue to photobooth/outbox/")
    ocr = OCRWorker()
    ocr.start()
    if not attendees:
        print("WARNING: attendees.json is empty — no name can match; add registrants")

    win = "Photobooth"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(win, 1280, 720)
    fullscreen = False
    mirror = not args.no_mirror

    state = "SCAN"        # SCAN -> GEAR -> READY -> COUNTDOWN -> CAPTURE -> RESULT
    state_since = time.time()
    guest_name, guest_email = None, None
    hand_since = None
    shots, next_shot_at = [], 0.0
    strip_img, email_note = None, ""
    flash_until = 0.0
    status_hist = deque(maxlen=5)
    last_person_at = time.time()
    frames_done = 0

    def goto(s):
        nonlocal state, state_since
        state, state_since = s, time.time()

    def reset_session():
        nonlocal guest_name, guest_email, hand_since, shots, strip_img
        guest_name, guest_email, hand_since = None, None, None
        shots, strip_img = [], None
        status_hist.clear()
        ocr.clear()  # drop stale text so the last guest doesn't re-trigger
        goto("SCAN")

    print("Running — q quits, f fullscreen")
    while True:
        ok, frame = cap.read()
        if not ok:
            if not isinstance(source, int):
                break
            time.sleep(0.02)
            continue
        frames_done += 1
        if args.max_frames and frames_done > args.max_frames:
            break
        raw = frame  # unmirrored — QR codes don't decode when flipped
        if mirror:
            frame = cv2.flip(frame, 1)
        worker.submit(frame.copy())
        detections = worker.latest()
        now = time.time()
        h, w = frame.shape[:2]
        zone = (w * 0.74, 66, w * 0.97, 66 + h * 0.30)
        if os.environ.get("BOOTH_TEST_ZONE") == "full":  # headless testing only
            zone = (0, 0, w, h)

        pbox, status = gear_status(detections, required)
        if pbox is not None:
            last_person_at = now
        status_hist.append(status)

        def smoothed():
            if len(status_hist) < 3:
                return False, set(required)
            missing = set()
            for item in required:
                votes = [s.get(item, UNKNOWN) for s in status_hist if s]
                if not votes or max(set(votes), key=votes.count) != OK:
                    missing.add(item)
            return not missing, missing

        display = frame.copy()

        if state == "SCAN":
            draw_scan_target(display, now)
            draw_center_text(display, "SCAN YOUR PASS TO BEGIN", h - 60, 1.0)
            draw_center_text(display, "hold your badge up so we can read your name", h - 26, 0.55, DIM, FONT)
            foreman.say("scan", min_gap=25)
            if frames_done % 8 == 0:  # OCR a few times per second
                ocr.submit(raw.copy())
            name, email = match_registrant(ocr.latest(), attendees)
            if name:
                guest_name, guest_email = name, email
                ocr.clear()
                foreman.say("welcome", name=name)
                goto("GEAR")

        elif state == "GEAR":
            all_ok, missing = smoothed()
            draw_gear_row(display, {i: (OK if i not in missing else
                                        status.get(i, MISSING)) for i in required}, required, h - 96)
            if pbox is None:
                draw_center_text(display, f"WELCOME {guest_name.upper()} - STEP INTO FRAME", h - 34, 0.8)
            elif all_ok:
                goto("READY")
            else:
                miss = ", ".join(sorted(missing)).upper()
                draw_center_text(display, f"PUT ON YOUR GEAR: {miss}", h - 34, 0.8, AMBER)
                foreman.say("gear_missing", min_gap=8, items=miss.lower())
            if now - last_person_at > IDLE_RESET_S:
                reset_session()

        elif state == "READY":
            all_ok, _ = smoothed()
            hand_here = hand_in_zone(detections, zone)
            if hand_here and hand_since is None:
                hand_since = now
            elif not hand_here:
                hand_since = None
            progress = min(1.0, (now - hand_since) / HOLD_TO_ARM_S) if hand_since else 0.0
            draw_hotspot(display, zone, hand_here, progress, now)
            draw_gear_row(display, {i: OK for i in required}, required, h - 96)
            draw_center_text(display, "GEAR CHECK PASSED - HAND IN THE BOX TO START", h - 34, 0.8, GREEN)
            foreman.say("gear_ok", min_gap=20, name=guest_name)
            if not all_ok:
                goto("GEAR")
            elif progress >= 1.0:
                foreman.say("countdown")
                goto("COUNTDOWN")
            if now - last_person_at > IDLE_RESET_S:
                reset_session()

        elif state == "COUNTDOWN":
            remaining = args.countdown - (now - state_since)
            if remaining <= 0:
                shots = []
                next_shot_at = now
                goto("CAPTURE")
            else:
                draw_center_text(display, str(int(remaining) + 1), h // 2 + 40, 4.0, RF_PURPLE)
                draw_gear_row(display, {i: OK for i in required}, required, h - 96)

        elif state == "CAPTURE":
            n = len(shots)
            if now >= next_shot_at:
                all_ok, _ = smoothed()
                if not all_ok:
                    foreman.say("abort")
                    goto("GEAR")
                else:
                    shots.append(frame.copy())
                    flash_until = now + 0.18
                    next_shot_at = now + SHOT_GAP_S
                    if len(shots) < 3:
                        foreman.say("between_shots", min_gap=1)
                    else:
                        strip_img, path = compose_strip(shots, guest_name, photos_dir)
                        print(f"saved {path}")
                        if guest_email:
                            mailer.send(guest_email, guest_name, str(path))
                            email_note = f"PHOTO BOOTH PICTURES SENT TO {guest_email}"
                        else:
                            email_note = "NO EMAIL ON FILE - STRIP SAVED"
                        foreman.say("done", name=guest_name)
                        goto("RESULT")
            if state == "CAPTURE":
                draw_center_text(display, f"SHOT {min(n + 1, 3)} OF 3", 100, 0.9, WHITE)
                tleft = max(0.0, next_shot_at - now)
                draw_center_text(display, f"{tleft:.1f}", h // 2 + 40, 2.2, WHITE)

        elif state == "RESULT":
            sh = int(h * 0.88)
            sw = int(strip_img.shape[1] * sh / strip_img.shape[0])
            small = cv2.resize(strip_img, (sw, sh))
            display[:] = (24, 12, 20)
            x0 = (w - sw) // 2
            display[(h - sh) // 2:(h - sh) // 2 + sh, x0:x0 + sw] = small
            draw_center_text(display, email_note, h - 18, 0.7, GREEN)
            if now - state_since > RESULT_SHOW_S:
                reset_session()

        if now < flash_until:
            fill(display, 0, 0, w, h, (255, 255, 255), 0.75)

        draw_header(display, now, guest_name)
        if args.save_frame and frames_done % 30 == 0:
            cv2.imwrite(args.save_frame, display)
        cv2.imshow(win, display)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        elif key == ord("f"):
            fullscreen = not fullscreen
            cv2.setWindowProperty(win, cv2.WND_PROP_FULLSCREEN,
                                  cv2.WINDOW_FULLSCREEN if fullscreen else cv2.WINDOW_NORMAL)

    worker.running = False
    foreman.running = False
    mailer.running = False
    ocr.running = False
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
