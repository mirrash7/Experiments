"""Storm Response Command Center — local demo server.

  uvicorn app.server:app --port 8000
"""
import json
import os
import shutil
import time
from pathlib import Path
from typing import Optional

import requests
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.pipeline import MODEL_ID, ROOT, RUNS, Session, Telemetry, load_flights

SF_WEBHOOK_URL = os.environ.get("SF_WEBHOOK_URL", "")  # empty -> local inbox


def flight_by_id(flight_id: Optional[str]):
    flights = load_flights()
    if not flight_id:
        return flights[0]
    for f in flights:
        if f["id"] == flight_id:
            return f
    raise HTTPException(404, f"unknown flight '{flight_id}'")


def public_flight(f):
    return {k: f[k] for k in ("id", "drone_id", "name", "description", "model_id", "available",
                             "plans_label") if k in f} | \
        {"video": os.path.basename(f["video_path"]),
         "cached": bool(f.get("cache")) and (ROOT / f["cache"]).exists()}

app = FastAPI(title="Storm Response Command Center")
app.mount("/static", StaticFiles(directory=ROOT / "app" / "static"), name="static")

session: Optional[Session] = None


def load_archive():
    """Most recent finished run, so repair plans survive a server restart."""
    runs = sorted([d for d in RUNS.glob("*/incidents.json")], key=lambda p: p.stat().st_mtime)
    if not runs:
        return None
    try:
        data = json.loads(runs[-1].read_text())
        data["incidents"] = {i["id"]: i for i in data.get("incidents", [])}
        return data if data["incidents"] else None
    except Exception:
        return None


ARCHIVE = load_archive()


def incident_record(iid):
    """Incident from the live session, else from the archived run."""
    if session and iid in session.incidents:
        return session.incidents[iid]
    if ARCHIVE and iid in ARCHIVE["incidents"]:
        return ARCHIVE["incidents"][iid]
    raise HTTPException(404)
sf_inbox: list = []  # simulated Salesforce work orders when no webhook is configured


def current():
    if session is None:
        raise HTTPException(404, "no active session")
    return session


@app.get("/", response_class=HTMLResponse)
def index():
    return (ROOT / "app" / "static" / "index.html").read_text()


@app.get("/api/config")
def config():
    # nothing about position is known until a drone is streaming telemetry;
    # the fleet list carries each flight's clip + model
    return {"flights": [public_flight(f) for f in load_flights()],
            "sf_webhook": SF_WEBHOOK_URL or "local inbox"}


def start_session(video_path, mode, flight):
    global session
    if session and session.running:
        session.stop()
        time.sleep(0.3)
    try:
        session = Session(video_path, mode=mode, flight=flight)
    except RuntimeError as e:  # e.g. missing API key for this flight's workspace
        raise HTTPException(400, str(e))
    session.start()
    global ARCHIVE
    ARCHIVE = None      # the live session is now the source of truth
    return session


@app.post("/api/connect")
def connect(body: Optional[dict] = None):
    """Simulate connecting to a drone's live stream. Body: {"flight": "<id>"}."""
    flight = flight_by_id((body or {}).get("flight"))
    if not flight["available"]:
        raise HTTPException(400, f"drone video missing: {flight['video_path']}")
    s = start_session(flight["video_path"], "drone", flight)
    return {"session": s.id, "mode": "drone", "flight": flight["id"], "model": flight["model_id"]}


@app.post("/api/upload")
async def upload(file: UploadFile, flight: Optional[str] = None):
    """Process a dropped video file with the given flight's model (query ?flight=<id>)."""
    f_cfg = flight_by_id(flight)
    dest = RUNS / "uploads"
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / f"{int(time.time())}_{file.filename}"
    with open(path, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    s = start_session(path, "upload", f_cfg)
    return {"session": s.id, "mode": "upload", "file": file.filename, "model": f_cfg["model_id"]}


@app.post("/api/filters")
def filters(body: dict):
    """Toggle which classes are drawn on the feed: {"hidden": ["tree", ...]}."""
    s = current()
    s.hidden_classes = set(body.get("hidden", []))
    return {"hidden": sorted(s.hidden_classes)}


@app.post("/api/seek")
def seek(body: dict):
    """Scrub the finished pass to a time (seconds)."""
    s = current()
    s.seek(float(body.get("t", 0)))
    return {"t": body.get("t"), "duration": s.duration}


@app.post("/api/stop")
def stop():
    global ARCHIVE
    if session:
        session.stop()
        ARCHIVE = load_archive()
    return {"ok": True}


@app.get("/api/state")
def state():
    if session is None:
        if ARCHIVE:
            return {"state": "archived", "session": ARCHIVE["session"], "mode": "archive", "stats": {},
                    "incidents": [{k: v for k, v in i.items()
                                   if k not in ("screenshot", "plan", "best_score", "best_shot_at", "last_box")}
                                  for i in ARCHIVE["incidents"].values()]}
        return {"state": "idle"}
    return {"state": "running" if (session.running and not session.finished) else
                     ("review" if session.running else "ended"),
            "session": session.id, "mode": session.mode, "stats": session.stats,
            "duration": session.duration, "seekable": session.finished and session.running,
            "incidents": [Session.public_incident(i) for i in session.incidents.values()]}


@app.get("/stream.mjpg")
def stream():
    def gen():
        boundary = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
        last = None
        while True:
            s = session
            if s is None or s.latest_jpeg is None:
                time.sleep(0.1)
                continue
            if s.latest_jpeg is not last:
                last = s.latest_jpeg
                yield boundary + last + b"\r\n"
            time.sleep(1 / 30)
    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/events")
async def events(request: Request):
    """Server-sent events: telemetry, incidents, status."""
    def gen():
        s = None
        q = None
        while True:
            if session is not s:
                if s is not None and q is not None:
                    s.unsubscribe(q)
                s = session
                q = s.subscribe() if s else None
                if s:
                    # late joiners missed the initial status event — resend it
                    if s.running or s.finished:
                        yield "data: " + json.dumps({
                            "type": "status", "state": "ended" if s.finished else "connected",
                            "mode": s.mode, "drone_id": s.tel.drone_id, "fps": s.fps,
                            "duration": s.duration, "model": s.model_id,
                            "flight": s.flight.get("id"), "flight_name": s.flight.get("name"),
                            "cached": s.cache is not None,
                            "seekable": s.finished and s.running,
                            "incidents": len(s.incidents)}) + "\n\n"
                    # replay existing incidents for late joiners
                    for inc in s.incidents.values():
                        yield f"data: {json.dumps({'type': 'incident', **Session.public_incident(inc)})}\n\n"
            if q is None:
                if ARCHIVE and not getattr(gen, "_sent_archive", False):
                    gen._sent_archive = True
                    yield "data: " + json.dumps({"type": "status", "state": "archived",
                                                 "mode": "archive", "drone_id": ARCHIVE.get("drone_id", ""),
                                                 "flight": ARCHIVE.get("flight"), "model": ARCHIVE.get("model"),
                                                 "incidents": len(ARCHIVE["incidents"])}) + "\n\n"
                    for inc in ARCHIVE["incidents"].values():
                        pub = {k: v for k, v in inc.items()
                               if k not in ("screenshot", "plan", "best_score", "best_shot_at", "last_box")}
                        yield f"data: {json.dumps({'type': 'incident', **pub})}\n\n"
                yield ": idle\n\n"
                time.sleep(1)
                continue
            try:
                ev = q.get(timeout=1)
                yield f"data: {json.dumps(ev)}\n\n"
            except Exception:
                yield ": keepalive\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/incidents/{iid}/screenshot")
def screenshot(iid: str):
    inc = incident_record(iid)
    if not os.path.exists(inc.get("screenshot", "")):
        raise HTTPException(404)
    return FileResponse(inc["screenshot"], media_type="image/jpeg")


@app.get("/api/incidents/{iid}/plan")
def plan(iid: str):
    inc = incident_record(iid)
    if not os.path.exists(inc.get("plan", "")):
        raise HTTPException(404)
    return FileResponse(inc["plan"], media_type="image/jpeg")


@app.get("/api/report.json")
def report_json():
    return JSONResponse(current().report(with_images=False))


@app.get("/api/report.html", response_class=HTMLResponse)
def report_html():
    r = current().report(with_images=True)
    rows = "".join(f"""
      <tr><td><b>{i['id']}</b></td><td>{i['severity']}</td><td>{i['confidence']:.0%}</td>
      <td>{i['lat']:.5f}, {i['lon']:.5f}</td><td>T+{i['t']}s ({i['first_seen']})</td>
      <td>{'<img src="data:image/jpeg;base64,' + i['screenshot_b64'] + '" style="max-width:320px;border-radius:6px">' if i.get('screenshot_b64') else ''}</td></tr>"""
        for i in r["incidents"])
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Storm Damage Report {r['session']}</title>
<style>body{{font-family:-apple-system,Segoe UI,sans-serif;margin:32px;color:#111}}table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid #ddd;padding:10px;text-align:left;vertical-align:top}}th{{background:#f3f4f6}}
.meta{{color:#555;margin-bottom:20px}}</style></head><body>
<h1>Storm Damage Assessment — {r['drone_id']}</h1>
<div class="meta">Session {r['session']} · Source: {r['source']} ({r['mode']}) · Model: {r['model']} · Generated {r['generated']}<br>
Frames {r['stats']['frames']} · Inferences {r['stats']['inferences']} · <b>{len(r['incidents'])} downed-line incidents</b></div>
<table><tr><th>Incident</th><th>Priority</th><th>Confidence</th><th>Location</th><th>First seen</th><th>Evidence</th></tr>{rows}</table>
</body></html>"""


@app.post("/api/salesforce/send")
def salesforce_send(body: dict):
    """Dispatch one or all incidents as work orders (webhook or local inbox)."""
    s = current()
    ids = body.get("ids") or list(s.incidents)
    sent = []
    for iid in ids:
        inc = s.incidents.get(iid)
        if not inc or inc["status"] == "dispatched":
            continue
        payload = {
            "event_type": "powerline_damage", "source": inc["drone_id"], "incident_id": iid,
            "priority": inc["severity"], "confidence": inc["confidence"],
            "latitude": inc["lat"], "longitude": inc["lon"],
            "detected_at": inc["first_seen"], "video_time_s": inc["t"],
            "required_crew": "line crew + bucket truck",
            "actions": inc.get("actions", []),
            "findings": [f["title"] for f in inc.get("findings", [])],
            "evidence_url": f"/api/incidents/{iid}/screenshot",
        }
        if SF_WEBHOOK_URL:
            try:
                requests.post(SF_WEBHOOK_URL, json=payload, timeout=5)
            except Exception as e:
                raise HTTPException(502, f"webhook failed: {e}")
        else:
            payload["work_order"] = f"WO-{len(sf_inbox) + 1:05d}"
            sf_inbox.append(payload)
        inc["status"] = "dispatched"
        inc["work_order"] = payload.get("work_order")
        sent.append(payload)
        s.emit({"type": "dispatched", "id": iid, "work_order": payload.get("work_order")})
    return {"sent": sent}


@app.get("/api/salesforce/inbox")
def salesforce_inbox():
    return sf_inbox
