import { describe, expect, it } from 'vitest';
import { AdaptiveScale } from '../src/adaptive';

describe('adaptive resolution', () => {
  it('with a GPU timer, converges towards the frame budget', () => {
    const a = new AdaptiveScale({ min: 0.3, max: 1, initial: 1, budgetMs: 12 });
    // Cost ∝ scale²: 30 ms at scale 1.
    for (let t = 0; t < 200; t++) a.update(16.7, 30 * a.scale * a.scale, t * 16.7);
    expect(a.scale).toBeGreaterThan(0.55);
    expect(a.scale).toBeLessThan(0.7); // √(12/30) ≈ 0.63
  });

  it('respects its bounds', () => {
    const a = new AdaptiveScale({ min: 0.4, max: 0.8, initial: 0.6 });
    for (let t = 0; t < 200; t++) a.update(16.7, 200, t * 16.7);
    expect(a.scale).toBe(0.4);
    for (let t = 200; t < 400; t++) a.update(16.7, 1, t * 16.7);
    expect(a.scale).toBe(0.8);
  });

  it('without a timer, backs off on slow frames and probes up when on time', () => {
    const a = new AdaptiveScale({ min: 0.3, max: 1, initial: 1 });
    let now = 0;
    for (let i = 0; i < 120; i++) a.update(33, null, (now += 33));
    const low = a.scale;
    expect(low).toBeLessThan(0.8);
    for (let i = 0; i < 2000; i++) a.update(16.7, null, (now += 16.7));
    expect(a.scale).toBeGreaterThan(low);
  });
});
