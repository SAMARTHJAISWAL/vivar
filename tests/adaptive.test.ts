import { describe, expect, it } from 'vitest';
import { AdaptiveScale } from '../src/adaptive';

/** Simulated device: frame time grows with pixel count (scale²), floored at the 60 Hz vsync. */
function run(a: AdaptiveScale, msAtFullRes: number, frames: number, start = 0): number {
  let now = start;
  for (let i = 0; i < frames; i++) {
    const ms = Math.max(16.7, msAtFullRes * a.scale * a.scale);
    now += ms;
    a.update(ms, now);
  }
  return now;
}

describe('adaptive resolution', () => {
  it('drops resolution on a slow device until frames are on time', () => {
    const a = new AdaptiveScale({ min: 0.3, max: 1, initial: 1 });
    run(a, 40, 600); // 40 ms per frame at full resolution
    // On time requires scale ≤ √(18.2/40) ≈ 0.67.
    expect(a.scale).toBeLessThanOrEqual(0.7);
    expect(a.scale).toBeGreaterThan(0.45);
  });

  it('climbs back to full resolution when there is headroom', () => {
    const a = new AdaptiveScale({ min: 0.3, max: 1, initial: 0.5 });
    run(a, 10, 2000);
    expect(a.scale).toBe(1);
  });

  it('respects its bounds', () => {
    const a = new AdaptiveScale({ min: 0.4, max: 0.8, initial: 0.6 });
    run(a, 200, 400);
    expect(a.scale).toBe(0.4);
    run(a, 1, 4000, 1e6);
    expect(a.scale).toBe(0.8);
  });

  it('ignores a one-off hitch and the warm-up period', () => {
    const a = new AdaptiveScale({ min: 0.3, max: 1, initial: 1 });
    a.warmUp(0);
    a.update(300, 300); // shader compile during warm-up
    let now = 1000;
    for (let i = 0; i < 100; i++) a.update(16.7, (now += 16.7));
    a.update(120, (now += 120)); // one long GC pause
    for (let i = 0; i < 100; i++) a.update(16.7, (now += 16.7));
    expect(a.scale).toBe(1);
  });

  it('does not oscillate wildly at the limit', () => {
    const a = new AdaptiveScale({ min: 0.3, max: 1, initial: 1 });
    let now = run(a, 30, 600);
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const ms = Math.max(16.7, 30 * a.scale * a.scale);
      now += ms;
      seen.add(a.update(ms, now));
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeLessThanOrEqual(0.15);
  });
});
