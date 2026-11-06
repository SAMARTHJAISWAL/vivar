import { describe, expect, it } from 'vitest';
import { B_CRIT, R_PHOTON, R_S } from '../src/physics/constants';
import {
  deflectionAngle,
  escapeDirection,
  firstEquatorCrossing,
  invariant,
  planePoint,
  rk4,
  setupRay,
  stepSize,
  trace,
} from '../src/physics/geodesic';
import { makeCamera, rayDirection, shadowAngularRadius } from '../src/physics/camera';
import { QUALITY_SETTINGS } from '../src/quality';
import { dot, length, type Vec3 } from '../src/physics/vec';

const fine = { gr: true, hBase: 0.01, eps: 0.01, maxSteps: 400000 };

/** Launch a ray from far away (r = 1e5) with impact parameter b, heading inward. */
function fromInfinity(b: number) {
  const u0 = 1e-5;
  const w0 = Math.sqrt(1 / (b * b) - u0 * u0 * (1 - u0));
  return trace(u0, w0, { ...fine, uEscape: u0, b });
}

describe('critical impact parameter', () => {
  it('b_c = (3√3/2) r_s ≈ 2.598', () => {
    expect(B_CRIT).toBeCloseTo(2.598076, 6);
  });

  it('rays just inside b_c are captured, just outside escape', () => {
    for (const d of [1e-2, 1e-3, 1e-4]) {
      expect(fromInfinity(B_CRIT * (1 - d)).fate).toBe('captured');
      expect(fromInfinity(B_CRIT * (1 + d)).fate).toBe('escaped');
    }
  });

  it('near-critical rays wind around the hole: Δφ grows like ln(1/δ)', () => {
    const a = fromInfinity(B_CRIT * (1 + 1e-3));
    const b = fromInfinity(B_CRIT * (1 + 1e-5));
    // Each factor of e closer to b_c adds about one radian of winding (Lyapunov exponent 1 in φ).
    const extra = b.phiInf - a.phiInf;
    expect(extra).toBeGreaterThan(0.8 * Math.log(100));
    expect(extra).toBeLessThan(1.2 * Math.log(100));
  });

  it('a camera at finite distance sees the shadow edge at sin α_c = (b_c/r)√(1 − r_s/r)', () => {
    const cam: Vec3 = [26, 0.3, 0];
    const alpha = shadowAngularRadius(length(cam));
    const inward: Vec3 = [-cam[0] / length(cam), -cam[1] / length(cam), -cam[2] / length(cam)];
    // Rotate the inward direction by angle a around an axis perpendicular to it.
    const dirAt = (a: number): Vec3 => {
      const perp: Vec3 = [0, 0, 1];
      return [
        inward[0] * Math.cos(a) + perp[0] * Math.sin(a),
        inward[1] * Math.cos(a) + perp[1] * Math.sin(a),
        inward[2] * Math.cos(a) + perp[2] * Math.sin(a),
      ];
    };
    for (const [a, fate] of [
      [alpha * 0.999, 'captured'],
      [alpha * 1.001, 'escaped'],
    ] as const) {
      const p = setupRay(cam, dirAt(a), true);
      expect(trace(p.u0, p.w0, { ...fine, b: p.b }).fate).toBe(fate);
    }
    const p = setupRay(cam, dirAt(alpha), true);
    expect(p.b).toBeCloseTo(B_CRIT, 6);
  });
});

describe('photon sphere', () => {
  it('a circular orbit at r = 1.5 r_s stays there for two full turns', () => {
    const u = 1 / R_PHOTON;
    // Exactly circular: u' = 0 and u'' = −u + 1.5 u² = 0 at u = 2/3.
    expect(-u + 1.5 * u * u).toBeCloseTo(0, 12);
    let state: [number, number] = [u, 0];
    let maxDev = 0;
    for (let phi = 0; phi < 4 * Math.PI; phi += 0.01) {
      state = rk4(state[0], state[1], 0.01, true);
      maxDev = Math.max(maxDev, Math.abs(1 / state[0] - R_PHOTON));
    }
    expect(maxDev).toBeLessThan(1e-6);
  });

  it('is unstable: a 1e-6 nudge grows by roughly e^φ', () => {
    const u0 = (1 / R_PHOTON) * (1 + 1e-6);
    let s: [number, number] = [u0, 0];
    for (let i = 0; i < 1000; i++) s = rk4(s[0], s[1], 0.01, true); // φ = 10
    const growth = Math.abs(s[0] - 1 / R_PHOTON) / (u0 - 1 / R_PHOTON);
    expect(growth).toBeGreaterThan(Math.exp(10) * 0.3);
    expect(growth).toBeLessThan(Math.exp(10) * 3);
  });
});

describe('weak-field deflection', () => {
  it.each([50, 100, 200, 500])('b = %i r_s bends light by ≈ 2 r_s/b (4GM/c²b)', (b) => {
    const delta = deflectionAngle(b);
    const leading = (2 * R_S) / b;
    // The next term, (15π/16) r_s²/b², is a 1.5% correction at b = 100.
    expect(Math.abs(delta - leading) / leading).toBeLessThan(0.05);
    const secondOrder = leading + ((15 * Math.PI) / 16) * (R_S / b) ** 2;
    expect(Math.abs(delta - secondOrder) / secondOrder).toBeLessThan(0.005);
  });

  it('straight rays are not bent at all', () => {
    const u0 = 1e-4;
    const b = 20;
    const w0 = Math.sqrt(1 / (b * b) - u0 * u0);
    const res = trace(u0, w0, { ...fine, gr: false, uEscape: u0, b });
    expect(res.fate).toBe('escaped');
    expect(res.phiInf + Math.asin(b * u0) - Math.PI).toBeCloseTo(0, 6);
  });
});

describe('conservation of the first integral (du/dφ)² + u²(1 − r_s u) = 1/b²', () => {
  for (const [name, q] of Object.entries(QUALITY_SETTINGS)) {
    it(`stays within tolerance at ${name} quality`, () => {
      const cam = makeCamera(30, 80, 26, 16 / 9);
      let worst = 0;
      for (let i = 0; i < 40; i++) {
        const dir = rayDirection(cam, -1 + (2 * i) / 39, 0.37 * Math.sin(i));
        const p = setupRay(cam.pos, dir, true);
        const res = trace(p.u0, p.w0, { gr: true, hBase: q.hBase, eps: q.eps, maxSteps: q.maxSteps, b: p.b });
        if (res.fate !== 'captured') worst = Math.max(worst, res.maxInvariantDrift);
        // Initial condition really has invariant 1/b².
        expect(invariant(p.u0, p.w0, true) * p.b * p.b).toBeCloseTo(1, 10);
      }
      expect(worst).toBeLessThan(name === 'low' ? 2e-3 : 2e-4);
    });
  }
});

describe('integrator details', () => {
  it('step size is capped by hBase and shrinks on radial legs', () => {
    expect(stepSize(0.05, 0, 0.08, 0.08)).toBe(0.08);
    expect(stepSize(0.05, 5, 0.08, 0.08)).toBeCloseTo(0.0008, 10);
    expect(stepSize(0.05, 1e9, 0.08, 0.08)).toBe(1e-4);
  });

  it('equatorial crossings are found exactly (y = 0 at every recorded crossing)', () => {
    const cam = makeCamera(10, 75, 20, 1.5);
    const dir = rayDirection(cam, 0.1, 0.25);
    const p = setupRay(cam.pos, dir, true);
    const res = trace(p.u0, p.w0, { ...fine, firstCross: firstEquatorCrossing(p), b: p.b });
    expect(res.crossings.length).toBeGreaterThan(0);
    for (const c of res.crossings) {
      const pt = planePoint(p, c.phi, c.u);
      expect(Math.abs(pt[1]) / length(pt)).toBeLessThan(1e-9);
    }
    // Consecutive crossings are π apart.
    for (let i = 1; i < res.crossings.length; i++) {
      expect(res.crossings[i]!.phi - res.crossings[i - 1]!.phi).toBeCloseTo(Math.PI, 9);
    }
  });

  it('an escaped ray with lensing off keeps its original direction', () => {
    const cam = makeCamera(0, 60, 20, 1);
    const dir = rayDirection(cam, 0.6, 0.2);
    const p = setupRay(cam.pos, dir, false);
    const res = trace(p.u0, p.w0, { gr: false, hBase: 0.05, eps: 0.05, maxSteps: 1000, b: p.b });
    expect(res.fate).toBe('escaped');
    expect(dot(escapeDirection(p, res.phiInf), dir)).toBeCloseTo(1, 6);
  });
});
