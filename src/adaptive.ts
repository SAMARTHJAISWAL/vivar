/**
 * Adaptive render-resolution controller.
 *
 * The signal is the interval between requestAnimationFrame callbacks, i.e.
 * whether frames are actually arriving on time. When the smoothed interval
 * goes above ~18.2 ms (below ~55 fps) the scale drops in proportion to the
 * overrun (cost ∝ pixels ∝ scale²). While frames are on time it probes
 * upwards by 5% every 1.5 s, but stays just below the last scale that was too
 * slow until that memory expires after 15 s, so it does not oscillate.
 *
 * GPU timer queries (EXT_disjoint_timer_query_webgl2) are shown in the HUD but
 * not used here: on ANGLE/Metal they reported 2–3× the real per-frame cost,
 * which made the controller far too conservative.
 *
 * The output is quantised to steps of 0.05 so render targets are not
 * reallocated every frame.
 */
export interface AdaptiveOptions {
  min: number;
  max: number;
  initial?: number;
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
  private warmUntil = -Infinity;

  constructor(opts: AdaptiveOptions) {
    this.min = opts.min;
    this.max = opts.max;
    this.raw = Math.min(opts.max, Math.max(opts.min, opts.initial ?? opts.max));
  }

  setBounds(min: number, max: number): void {
    this.min = min;
    this.max = max;
    this.raw = Math.min(max, Math.max(min, this.raw));
    this.ceiling = Infinity;
  }

  /** Ignore frame timing for a moment, e.g. after start-up or returning to the tab (shader compiles, hitches). */
  warmUp(nowMs: number, ms = 1000): void {
    this.warmUntil = nowMs + ms;
    this.frameEma = 16.7;
    this.goodSince = -1;
  }

  /** Current scale, quantised. */
  get scale(): number {
    return Math.min(this.max, Math.max(this.min, Math.round(this.raw * 20) / 20));
  }

  /** Feed one rendered frame: `frameMs` is the interval since the previous one, `nowMs` a clock. */
  update(frameMs: number, nowMs: number): number {
    const clamp = (x: number) => Math.min(this.max, Math.max(this.min, x));
    if (nowMs < this.warmUntil) return this.scale;
    // A single hitch (GC, compositor) should not cost resolution: cap each sample's pull.
    if (frameMs > 0) this.frameEma += (Math.min(frameMs, 30) - this.frameEma) * 0.1;
    if (nowMs - this.ceilingSetAt > 15000) this.ceiling = Infinity;
    if (this.frameEma > 18.2) {
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
    } else if (this.frameEma < 17.4) {
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
