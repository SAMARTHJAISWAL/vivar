import { describe, expect, it } from 'vitest';
import { DISK_INNER, DISK_PEAK_RADIUS, R_ISCO } from '../src/physics/constants';
import {
  diskFluxShape,
  diskTemperature,
  dopplerFactor,
  gravFactor,
  omegaKepler,
  orbitalSpeed,
  redshiftFactor,
} from '../src/physics/redshift';
import { firstEquatorCrossing, planePoint, setupRay, trace } from '../src/physics/geodesic';
import { cross, normalize, type Vec3 } from '../src/physics/vec';

describe('redshift of a circular-orbit emitter', () => {
  it('face-on at the ISCO, observed from infinity: g = √(1 − 3/(2·3)) = 1/√2', () => {
    expect(redshiftFactor(R_ISCO, 0, Infinity)).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('face-on in general: g = √(1 − 3/(2r)) (time dilation of the orbit, no Doppler term)', () => {
    for (const r of [3, 4, 6, 10, 14]) expect(redshiftFactor(r, 0, Infinity)).toBeCloseTo(Math.sqrt(1 - 1.5 / r), 12);
  });

  it('factors exactly into gravitational × Doppler parts', () => {
    for (const r of [3, 5, 9]) {
      for (const ell of [-6, -1, 0, 2, 5]) {
        expect(gravFactor(r, 30) * dopplerFactor(r, ell)).toBeCloseTo(redshiftFactor(r, ell, 30), 12);
      }
    }
  });

  it('ISCO orbital speed is c/2 and Ω = √(M/r³)', () => {
    expect(orbitalSpeed(R_ISCO)).toBeCloseTo(0.5, 12);
    expect(omegaKepler(R_ISCO)).toBeCloseTo(Math.sqrt(0.5 / 27), 12);
  });

  it('approaching gas (ℓ > 0) is blueshifted relative to receding gas', () => {
    const b = 6;
    expect(redshiftFactor(6, b, Infinity)).toBeGreaterThan(1);
    expect(redshiftFactor(6, -b, Infinity)).toBeLessThan(redshiftFactor(6, 0, Infinity));
  });

  it('a ray traced from a face-on camera to the disk reproduces the analytic g', () => {
    // Camera far up the axis looking down at a point on the disk.
    const rCam = 1e4;
    const cam: Vec3 = [0, rCam, 0];
    for (const target of [3.2, 6, 11]) {
      // Aim roughly; we only need *some* disk hit with ℓ = 0, which holds for any ray from the axis.
      const dir = normalize([target / rCam, -1, 0]);
      const p = setupRay(cam, dir, true);
      const res = trace(p.u0, p.w0, { gr: true, hBase: 0.002, eps: 0.002, maxSteps: 200000, firstCross: firstEquatorCrossing(p), b: p.b });
      const hit = res.crossings[0]!;
      const r = 1 / hit.u;
      const n = cross(p.e1, p.e2);
      const ell = -p.b * n[1];
      expect(Math.abs(ell)).toBeLessThan(1e-9);
      expect(redshiftFactor(r, ell, rCam)).toBeCloseTo(Math.sqrt(1 - 1.5 / r) / Math.sqrt(1 - 1 / rCam), 9);
      expect(planePoint(p, hit.phi, hit.u)[1]).toBeCloseTo(0, 6);
    }
  });
});

describe('disk temperature profile', () => {
  it('flux vanishes at the inner edge and peaks at (49/36) r_in', () => {
    expect(diskFluxShape(DISK_INNER)).toBe(0);
    const f = diskFluxShape(DISK_PEAK_RADIUS);
    expect(diskFluxShape(DISK_PEAK_RADIUS * 0.98)).toBeLessThan(f);
    expect(diskFluxShape(DISK_PEAK_RADIUS * 1.02)).toBeLessThan(f);
  });

  it('T ∝ r^(−3/4) far out and equals tPeak at the peak', () => {
    expect(diskTemperature(DISK_PEAK_RADIUS, 6500)).toBeCloseTo(6500, 6);
    const ratio = diskTemperature(400, 1) / diskTemperature(200, 1);
    expect(ratio).toBeCloseTo(Math.pow(2, -0.75), 1);
  });
});
