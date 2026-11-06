import { describe, expect, it } from 'vitest';
import { DISK_INNER, DISK_OUTER } from '../src/physics/constants';
import { FIT_HALF_DEG, FOV_DEG, framing, makeCamera, rayDirection } from '../src/physics/camera';
import { firstEquatorCrossing, setupRay, trace } from '../src/physics/geodesic';

const DEG = Math.PI / 180;

/** Widest |NDC x| at which a traced ray from the default view lands on the disk. */
function diskHalfWidth(aspect: number): number {
  const cam = makeCamera(30, 84, 24, aspect);
  let widest = 0;
  for (let j = 0; j <= 60; j++) {
    // Rows spanning ±0.35 rad vertically: the disk and its lensed images live in there.
    const ndcY = ((j / 30 - 1) * Math.tan(0.35)) / cam.tanY;
    if (Math.abs(ndcY) > 1) continue;
    for (let i = 0; i <= 200; i++) {
      const ndcX = i / 100 - 1;
      if (Math.abs(ndcX) <= widest) continue;
      const p = setupRay(cam.pos, rayDirection(cam, ndcX, ndcY), true);
      const res = trace(p.u0, p.w0, { gr: true, hBase: 0.08, eps: 0.08, maxSteps: 300, firstCross: firstEquatorCrossing(p), b: p.b });
      // The outer 15% of the disk fades out (smoothstep from 14 to ~10 r_s), so count hits inside 13 r_s.
      if (res.crossings.some((c) => 1 / c.u > DISK_INNER && 1 / c.u < 0.93 * DISK_OUTER)) widest = Math.abs(ndcX);
    }
  }
  return widest;
}

describe('framing', () => {
  it('16:9 and wider keep the 52° vertical field of view', () => {
    for (const aspect of [16 / 9, 2, 21 / 9]) {
      expect(framing(aspect).tanY).toBeCloseTo(Math.tan((FOV_DEG / 2) * DEG), 12);
      expect(framing(aspect).tanX / framing(aspect).tanY).toBeCloseTo(aspect, 12);
    }
  });

  it('narrower screens keep a horizontal half-angle of at least FIT_HALF_DEG', () => {
    for (const aspect of [4 / 3, 1, 9 / 16, 390 / 844, 784 / 1666, 9 / 19.5]) {
      expect(framing(aspect).tanX).toBeCloseTo(Math.tan(FIT_HALF_DEG * DEG), 12);
      expect(framing(aspect).tanY).toBeGreaterThanOrEqual(Math.tan((FOV_DEG / 2) * DEG));
    }
  });

  it('the whole disk fits across the screen with a margin, from 21:9 to 9:19.5', () => {
    for (const aspect of [21 / 9, 16 / 9, 4 / 3, 1, 9 / 16, 390 / 844, 9 / 19.5]) {
      const w = diskHalfWidth(aspect);
      expect(w, `aspect ${aspect.toFixed(3)}`).toBeLessThan(0.95);
      // ...and it is not lost in the middle either.
      expect(w, `aspect ${aspect.toFixed(3)}`).toBeGreaterThan(aspect >= 16 / 9 ? 0.5 : 0.7);
    }
  });
});
