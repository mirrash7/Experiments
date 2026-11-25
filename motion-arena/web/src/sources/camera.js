// Webcam capture with per-frame capture timestamps (requestVideoFrameCallback).
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.listeners = new Set();
    this.frameTimes = [];
    this.timestampKind = 'unknown';
    this._running = false;
  }

  async start(deviceId) {
    this.stop();
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 1280 }, height: { ideal: 720 },
        frameRate: { ideal: 60, max: 60 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this._running = true;
    this._loop();
    return this.stream.getVideoTracks()[0].getSettings();
  }

  stop() {
    this._running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get active() { return this._running && !!this.stream; }

  /** cb(video, tCapture) on every new camera frame. */
  onFrame(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  get fps() {
    const t = this.frameTimes;
    if (t.length < 2) return 0;
    return ((t.length - 1) * 1000) / (t[t.length - 1] - t[0]);
  }

  _loop() {
    const v = this.video;
    if (!this._running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      v.requestVideoFrameCallback((now, meta) => {
        // captureTime: when the sensor captured it (best). Fallback: when the frame was handed to the compositor.
        let t = meta.captureTime;
        if (t && t > 0 && t <= now + 5) this.timestampKind = 'sensor capture';
        else { t = meta.presentationTime || now; this.timestampKind = 'frame presented'; }
        this._emit(t);
        this._loop();
      });
    } else {
      let last = -1;
      const tick = () => {
        if (!this._running) return;
        if (v.currentTime !== last) { last = v.currentTime; this.timestampKind = 'rAF poll'; this._emit(performance.now()); }
        requestAnimationFrame(tick);
      };
      tick();
    }
  }

  _emit(t) {
    this.frameTimes.push(t);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    for (const cb of this.listeners) cb(this.video, t);
  }

  static async list() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'videoinput');
  }
}
