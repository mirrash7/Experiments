// Quality presets + automatic down-tuning by frame time (anime-rendering.md 5.2).
// Rolling frame time (EMA of rAF intervals). Above 17.5 ms for 2 s: step the pixel ratio down 0.1, and once at the
// tier's floor drop a tier (Auto mode only). Under 13 ms for 10 s: step back up (never above the chosen tier/cap).
// Hidden tabs and hitches > 100 ms are ignored so a background pane doesn't tank the settings.
export const PRESETS = {
  low: { id: 'low', label: 'Low', dprCap: 1.0, dprMin: 0.75, aa: 'fxaa', bloom: false, bloomHalf: true, grade: false, vignette: false, shadows: false, shadowMap: 1024, outlines: 'low' },
  medium: { id: 'medium', label: 'Medium', dprCap: 1.5, dprMin: 1.0, aa: 'smaa', bloom: true, bloomHalf: true, grade: true, vignette: true, shadows: true, shadowMap: 1024, outlines: 'medium' },
  high: { id: 'high', label: 'High', dprCap: 2.0, dprMin: 1.3, aa: 'smaa', bloom: true, bloomHalf: false, grade: true, vignette: true, shadows: true, shadowMap: 2048, outlines: 'high' },
};
const ORDER = ['low', 'medium', 'high'];

export class QualityManager {
  /**
   * @param {object} o
   * @param {(preset:object, dpr:number, reason:string)=>void} o.apply  called whenever the tier or pixel ratio changes
   * @param {'auto'|'low'|'medium'|'high'} [o.mode='auto']
   */
  constructor({ apply, mode = 'auto' }) {
    this.applyFn = apply;
    this.ema = 1000 / 60;
    this.slowFor = 0; this.fastFor = 0;
    this.log = [];
    this.setMode(mode);
  }
  get preset() { return PRESETS[this.tier]; }
  setMode(mode) {
    this.mode = mode;
    this.maxTier = mode === 'auto' ? 'high' : mode;
    this.tier = this.maxTier;
    this.dpr = Math.min(devicePixelRatio || 1, this.preset.dprCap);
    this.slowFor = this.fastFor = 0;
    this._apply('mode ' + mode);
  }
  _apply(reason) {
    this.log.push({ t: Math.round(performance.now()), tier: this.tier, dpr: +this.dpr.toFixed(2), reason });
    if (this.log.length > 20) this.log.shift();
    this.applyFn(this.preset, this.dpr, reason);
  }
  /** @param {number} dtMs  rAF interval in ms */
  frame(dtMs) {
    if (document.hidden || !(dtMs > 0) || dtMs > 100) return;
    this.ema += (dtMs - this.ema) * 0.05;
    const dt = dtMs / 1000;
    if (this.ema > 17.5) { this.slowFor += dt; this.fastFor = 0; } else if (this.ema < 13) { this.fastFor += dt; this.slowFor = 0; } else { this.slowFor = 0; this.fastFor = 0; }
    if (this.slowFor > 2) { this.slowFor = 0; this.stepDown(); }
    if (this.fastFor > 10) { this.fastFor = 0; this.stepUp(); }
  }
  stepDown() {
    const p = this.preset;
    if (this.dpr - 0.1 >= p.dprMin - 1e-3) { this.dpr -= 0.1; this._apply(`slow ${this.ema.toFixed(1)} ms: dpr down`); return; }
    const i = ORDER.indexOf(this.tier);
    if (this.mode === 'auto' && i > 0) {
      this.tier = ORDER[i - 1];
      this.dpr = Math.min(this.dpr, this.preset.dprCap);
      this._apply(`slow ${this.ema.toFixed(1)} ms: tier down`);
    }
  }
  stepUp() {
    const p = this.preset, cap = Math.min(devicePixelRatio || 1, p.dprCap);
    if (this.dpr + 0.1 <= cap + 1e-3) { this.dpr += 0.1; this._apply('fast: dpr up'); return; }
    const i = ORDER.indexOf(this.tier);
    if (this.mode === 'auto' && i < ORDER.indexOf(this.maxTier)) {
      this.tier = ORDER[i + 1];
      this.dpr = Math.max(this.dpr, this.preset.dprMin);
      this._apply('fast: tier up');
    }
  }
}
