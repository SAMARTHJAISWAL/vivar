/**
 * Adaptive render-resolution controller.
 *
 * Shading cost is proportional to the number of pixels, i.e. to scale². With
 * a GPU timer the controller steers scale directly towards a frame-time
 * budget: scale_new = scale · √(budget / gpuTime), smoothed. Without one it
 * falls back to requestAnimationFrame intervals, which saturate at the display
 * refresh, so it backs off when frames are slow and probes upwards slowly
 * when they are consistently on time, remembering the scale that last failed.
 *
 * The output is quantised to steps of 0.05 so render targets are not
 * reallocated every frame.
 */
export interface AdaptiveOptions {
  min: number;
  max: number;
  initial?: number;
  /** GPU time budget per frame, ms. */
  budgetMs?: number;
}

export class AdaptiveScale {
  min: number;
  max: number;
  private raw: number;
  private frameEma = 16.7;
  private goodSince = -1;
  private lastDrop = -1e9;
  private ceiling = Infinity;
  private ceilingSetAt = 0;
  private readonly budgetMs: number;

  constructor(opts: AdaptiveOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.raw = Math.min(opts.max, Math.max(opts.min, opts.initial ?? opts.max));
    this.budgetMs = opts.budgetMs ?? 12;
  }

  setBounds(min: number, max: number): void {
    this.min = min;
    this.max = max;
    this.raw = Math.min(max, Math.max(min, this.raw));
    this.ceiling = Infinity;
  }

  /** Current scale, quantised. */
  get scale(): number {
    return Math.min(this.max, Math.max(this.min, Math.round(this.raw * 20) / 20));
  }

  /**
   * Feed one frame. `frameMs` is the interval between animation frames,
   * `gpuMs` the measured GPU time for a recent frame (or null), `nowMs` a clock.
   */
  update(frameMs: number, gpuMs: number | null, nowMs: number): number {
    const clamp = (x: number) => Math.min(this.max, Math.max(this.min, x));
    if (gpuMs !== null && gpuMs > 0) {
      const target = this.raw * Math.sqrt(this.budgetMs / gpuMs);
      this.raw = clamp(this.raw + (target - this.raw) * 0.15);
      return this.scale;
    }
    if (frameMs > 0 && frameMs < 250) this.frameEma += (frameMs - this.frameEma) * 0.1;
    if (nowMs - this.ceilingSetAt > 15000) this.ceiling = Infinity;
    if (this.frameEma > 19.5) {
      this.goodSince = -1;
      if (nowMs - this.lastDrop > 400) {
        this.ceiling = this.raw;
        this.ceilingSetAt = nowMs;
        // Scale down in proportion to how far over budget we are.
        const factor = Math.max(0.7, Math.min(0.95, Math.sqrt(16.7 / this.frameEma)));
        this.raw = clamp(this.raw * factor);
        this.lastDrop = nowMs;
        this.frameEma = 16.7 + (this.frameEma - 16.7) * 0.5;
      }
    } else if (this.frameEma < 17.6) {
      if (this.goodSince < 0) this.goodSince = nowMs;
      if (nowMs - this.goodSince > 1500 && this.raw < this.max) {
        // Probe upwards, but stay just under the last scale that was too slow
        // until that memory expires.
        const cap = this.ceiling * 0.97;
        if (this.raw < cap) this.raw = clamp(Math.min(this.raw * 1.05, cap));
        this.goodSince = nowMs;
      }
    } else {
      this.goodSince = -1;
    }
    return this.scale;
  }
}
