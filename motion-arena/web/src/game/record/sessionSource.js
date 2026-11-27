// SessionSource: plays a recorded playtest session (recorder.js / format.js) back as a live tracker source, so the
// game (`/game.html?play=<url>`) or the motion lab (`/motion-lab.html?source=session&session=<url>`) shows what the
// player did. Frames are decoded lazily and re-stamped onto the live clock with their recorded latency
// (tCapture = now - (push - capture)), exactly like sources/recordedSource.js does for clips.
//
//   const src = await SessionSource.load('/recordings/breaklight-session-....json.gz', { loop: false, from: 30 });
//   src.onPose = (f) => ...; src.start();
// `from` / `to` (s, session time) trim the playback; `speed` scales it. `src.kind` is the recorded tracker kind
// (hmr / mediapipe / demo / autoplay) so the game can use the same judgement windows. Visual only: the game you
// watch is a fresh run, its chart is not synchronised with the recorded one (use motion/replayBench.js for numbers).
import { parseSessionBytes, undeltaRows, rowToFrame, FORMAT } from './format.js';

export class SessionSource {
  constructor(json, { loop = false, speed = 1, from = 0, to = Infinity } = {}) {
    if (json?.format !== FORMAT) throw new Error('not a BREAKLIGHT session file');
    this.json = json;
    this.rows = undeltaRows(json.frames);
    this.layout = json.layout;
    this.loop = loop; this.speed = speed;
    const t0 = this.rows[0]?.t ?? 0;
    this._lo = this.rows.findIndex((r) => (r.t - t0) / 10000 >= from);
    if (this._lo < 0) this._lo = 0;
    let hi = this.rows.length;
    if (Number.isFinite(to)) { const k = this.rows.findIndex((r) => (r.t - t0) / 10000 > to); if (k > 0) hi = k; }
    this._hi = hi;
    const m = { ...(json.meta?.start ?? {}), ...Object.fromEntries(Object.entries(json.meta?.end ?? {}).filter(([, v]) => v != null)) };
    this.kind = m.tracker ?? 'demo';
    this.model = `Recorded session (${this.kind}${m.model ? ', ' + m.model : ''}, ${hi - this._lo} frames)`;
    this.onPose = () => {}; this.onStatus = () => {};
    this._timer = null;
    // shapes (MHR identity) come from 'shape' events (absolute frame index f)
    const f0 = json.f0 ?? 0;
    this._shapes = json.events.filter((e) => e[2] === 'shape').map((e) => ({ i: e[1] - f0, v: Float32Array.from(e[3].v, (x) => x / 1e4) }));
  }
  static async load(src, opts) {
    let bytes;
    if (typeof Blob !== 'undefined' && src instanceof Blob) bytes = new Uint8Array(await src.arrayBuffer());
    else {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`session ${src}: HTTP ${r.status}`);
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    return new SessionSource(await parseSessionBytes(bytes), opts);
  }
  /** Playback length (s). */
  get duration() {
    const a = this.rows[this._lo], b = this.rows[this._hi - 1];
    return a && b ? (b.t + b.p - a.t - a.p) / 10000 : 0;
  }
  _shapeAt(i) { let s = null; for (const x of this._shapes) { if (x.i <= i) s = x.v; else break; } return s; }
  start() {
    this.stop();
    if (!this.rows.length) { this.onStatus('error', 'empty session'); return; }
    this._i = this._lo; this._t0 = performance.now();
    this._base = this.rows[this._lo].t + this.rows[this._lo].p;      // push time of the first frame (0.1 ms)
    this.onStatus('ready', this.model);
    this._timer = setInterval(() => this._tick(), 4);
  }
  stop() { clearInterval(this._timer); this._timer = null; }
  _tick() {
    const now = performance.now();
    const clipT = (now - this._t0) * this.speed * 10 + this._base;     // session push time reached (0.1 ms)
    while (this._i < this._hi && this.rows[this._i].t + this.rows[this._i].p <= clipT) {
      const r = this.rows[this._i];
      const f = rowToFrame(r, this.layout, r.m ? this._shapeAt(this._i) : null);
      const lat = r.p / 10;
      f.tCapture = now - lat; f.tArrive = now; delete f.tPush;
      f.sessionIndex = this._i++;
      this.onPose(f);
    }
    if (this._i >= this._hi) {
      if (!this.loop) { this.stop(); this.onStatus('done', 'session finished'); return; }
      this._i = this._lo; this._t0 = now;
    }
  }
}
