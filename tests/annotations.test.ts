import { describe, expect, it } from 'vitest';
import { locateFeatures } from '../src/annotations';
import { makeCamera } from '../src/physics/camera';

describe('feature locator for the explainer overlay', () => {
  const cam = makeCamera(30, 84, 24, 16 / 9);
  const f = locateFeatures(cam, true);

  it('finds every feature at the default view', () => {
    for (const k of ['shadow', 'ring', 'over', 'under', 'doppler', 'isco'] as const) expect(f[k], k).toBeDefined();
  });

  it('puts the lensed far side above the centre and the secondary image below', () => {
    expect(f.over![1]).toBeGreaterThan(0);
    expect(f.under![1]).toBeLessThan(0);
  });

  it('the brighter (approaching) side is on the left for every camera position', () => {
    // Gas orbits anticlockwise seen from +y (v = Ω ŷ × r), and the camera keeps +y
    // pointing up on screen. Seen from in front, the left half then moves towards the
    // camera, whatever the azimuth, and whether the camera is above or below the disk.
    for (const [az, inc] of [
      [30, 84],
      [210, 84],
      [120, 70],
      [30, 96],
    ] as const) {
      const g = locateFeatures(makeCamera(az, inc, 24, 16 / 9), true);
      expect(g.doppler![0], `az ${az} inc ${inc}`).toBeLessThan(0);
    }
  });
});
