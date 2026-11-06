import { describe, expect, it } from 'vitest';
import { B_CRIT, MASS, R_S } from '../src/physics/constants';
import { makeCamera, rayDirection, shadowAngularRadius } from '../src/physics/camera';
import { firstEquatorCrossing, setupRay, trace } from '../src/physics/geodesic';
import {
  bardeenCurve,
  blAzimuthOffset,
  circularOrbit,
  horizonRadius,
  initialMomentum,
  iscoRadius,
  kerrCamera,
  kerrHamiltonian,
  kerrRedshift,
  localDirection,
  photonOrbitRadii,
  shadowCurveScreen,
  shadowPointScreen,
  sphericalPhotonOrbit,
  spinLength,
  traceKerr,
  traceKerrPixel,
  type KerrCamera,
} from '../src/physics/kerr';
import { dopplerFactor, gravFactor, redshiftFactor } from '../src/physics/redshift';
import { QUALITY_SETTINGS } from '../src/quality';
import { dot, type Vec3 } from '../src/physics/vec';

const DEG = Math.PI / 180;
const fine = { h: 0.05, maxSteps: 40000 };

/** Fate of the ray through tangent-plane screen point (x, y) of a Kerr camera. */
function fateAt(cam: KerrCamera, x: number, y: number, h = fine.h) {
  return traceKerrPixel(cam, x, y, 1, 1, { h, maxSteps: fine.maxSteps }).fate;
}

function centroid(pts: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

describe('Kerr constants', () => {
  it('horizon r₊ = M + √(M² − a²)', () => {
    expect(horizonRadius(0)).toBe(R_S);
    expect(horizonRadius(spinLength(0.998))).toBeCloseTo(MASS * (1 + Math.sqrt(1 - 0.998 ** 2)), 12);
  });

  it('prograde ISCO (Bardeen–Press–Teukolsky): 6M at a = 0, ≈ 1.237M at a = 0.998', () => {
    expect(iscoRadius(0) / MASS).toBeCloseTo(6, 12);
    expect(iscoRadius(spinLength(0.998)) / MASS).toBeCloseTo(1.237, 3);
    // Moves monotonically inward with spin, and stays outside the horizon.
    let prev = Infinity;
    for (let chi = 0; chi <= 0.998; chi += 0.05) {
      const r = iscoRadius(spinLength(chi));
      expect(r).toBeLessThan(prev);
      expect(r).toBeGreaterThan(horizonRadius(spinLength(chi)));
      prev = r;
    }
  });

  it('the ISCO is where the circular orbit stops being stable (E(r) has its minimum)', () => {
    // Specific energy of the prograde circular orbit, Bardeen–Press–Teukolsky eq. 2.12, M = 1 units.
    const energy = (r: number, chi: number) =>
      (Math.pow(r, 1.5) - 2 * Math.sqrt(r) + chi) / (Math.pow(r, 0.75) * Math.sqrt(Math.pow(r, 1.5) - 3 * Math.sqrt(r) + 2 * chi));
    for (const chi of [0, 0.5, 0.9]) {
      const rI = iscoRadius(spinLength(chi)) / MASS;
      const d = 1e-3;
      expect(energy(rI + d, chi)).toBeGreaterThan(energy(rI, chi) - 1e-12);
      expect(energy(rI - d, chi)).toBeGreaterThan(energy(rI, chi) - 1e-12);
    }
  });

  it('equatorial photon orbits: 3M for a = 0, prograde inside retrograde for a > 0', () => {
    const p0 = photonOrbitRadii(0);
    expect(p0.prograde / MASS).toBeCloseTo(3, 12);
    expect(p0.retrograde / MASS).toBeCloseTo(3, 12);
    const p = photonOrbitRadii(spinLength(0.99));
    expect(p.prograde).toBeLessThan(1.5 * R_S);
    expect(p.retrograde).toBeGreaterThan(1.5 * R_S);
    // At those radii the spherical-orbit constants have η = 0 (equatorial).
    for (const r of [p.prograde, p.retrograde]) expect(sphericalPhotonOrbit(r, spinLength(0.99)).eta).toBeCloseTo(0, 6);
  });
});

describe('Kerr tracer, a = 0 reproduces Schwarzschild', () => {
  it('the static-observer frame equals the Schwarzschild camera', () => {
    const k = kerrCamera(30, 84, 24, 0);
    const s = makeCamera(30, 84, 24, 16 / 9);
    for (const [u, v] of [
      [k.right, s.right],
      [k.up, s.up],
      [k.forward, s.forward],
      [k.pos, s.pos],
    ] as const)
      u.forEach((x, i) => expect(x).toBeCloseTo(v[i]!, 12));
  });

  it('shadow edge from 24 r_s matches sin α_c = (b_c/r)√(1 − r_s/r)', () => {
    const cam = kerrCamera(30, 84, 24, 0);
    const edge = Math.tan(shadowAngularRadius(24));
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [-0.6, 0.8],
    ] as const) {
      expect(fateAt(cam, dx * edge * 0.999, dy * edge * 0.999)).toBe('captured');
      expect(fateAt(cam, dx * edge * 1.001, dy * edge * 1.001)).toBe('escaped');
    }
  });

  it('from far away the shadow radius is b_c', () => {
    const r = 1e4;
    const cam = kerrCamera(0, 90, r, 0);
    const edge = Math.tan(Math.asin((B_CRIT / r) * Math.sqrt(1 - R_S / r)));
    expect(fateAt(cam, edge * (1 - 1e-3), 0)).toBe('captured');
    expect(fateAt(cam, edge * (1 + 1e-3), 0)).toBe('escaped');
  });

  it('disk crossings land where the planar Binet tracer puts them', () => {
    const cam = kerrCamera(30, 84, 24, 0);
    const sc = makeCamera(30, 84, 24, 16 / 9);
    for (const [x, y] of [
      [0.1, 0.12],
      [-0.4, -0.05],
      [0.05, -0.2],
    ] as const) {
      const k = traceKerrPixel(cam, x, y, sc.tanX, sc.tanY, { h: 0.05, maxSteps: 4000 });
      const p = setupRay(sc.pos, rayDirection(sc, x, y), true);
      const s = trace(p.u0, p.w0, { gr: true, hBase: 0.01, eps: 0.01, maxSteps: 100000, firstCross: firstEquatorCrossing(p), b: p.b });
      expect(k.fate).toBe(s.fate);
      const n = Math.min(k.crossings.length, s.crossings.length, 2);
      expect(n).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) expect(k.crossings[i]!.r).toBeCloseTo(1 / s.crossings[i]!.u, 4);
      // Photon angular momentum about the axis: ℓ = −b (e1 × e2)·ŷ in the planar tracer.
      const e1 = p.e1;
      const e2 = p.e2;
      const ell = -p.b * (e1[2] * e2[0] - e1[0] * e2[2]);
      expect(k.ell).toBeCloseTo(ell, 9);
    }
  });
});

describe('Kerr shadow boundary (Bardeen 1973)', () => {
  // The analytic curve on the observer's sky in units of r_s; scale by 1/r for angles.
  for (const chi of [0.5, 0.9, 0.99]) {
    for (const incDeg of [90, 60]) {
      it(`a/M = ${chi}, inclination ${incDeg}°: just inside captured, just outside escapes`, () => {
        const a = spinLength(chi);
        const r = 1000;
        const cam = kerrCamera(0, incDeg, r, a);
        const curve = bardeenCurve(a, incDeg * DEG, 400).map(([x, y]) => [x / r, y / r] as [number, number]);
        const c = centroid(curve);
        // 24 points spread around the curve.
        const picks = Array.from({ length: 24 }, (_, i) => curve[Math.floor((i * curve.length) / 24)]!);
        for (const [x, y] of picks) {
          for (const [d, want] of [
            [-0.01, 'captured'],
            [0.01, 'escaped'],
          ] as const) {
            expect(fateAt(cam, c[0] + (x - c[0]) * (1 + d), c[1] + (y - c[1]) * (1 + d)), `(${x}, ${y}) ${d}`).toBe(want);
          }
        }
      });
    }
  }

  it('the finite-distance edge tends to Bardeen’s curve scaled by 1/r', () => {
    const r = 1e6;
    for (const chi of [0.5, 0.9, 0.99]) {
      const a = spinLength(chi);
      const { prograde, retrograde } = photonOrbitRadii(a);
      for (const inc of [90, 60]) {
        const th = inc * DEG;
        let n = 0;
        for (let i = 0; i <= 40; i++) {
          const rp = prograde + ((retrograde - prograde) * i) / 40;
          const pt = shadowPointScreen(a, r, th, rp);
          const { xi, eta } = sphericalPhotonOrbit(rp, a);
          const b2 = eta + a * a * Math.cos(th) ** 2 - xi * xi / Math.tan(th) ** 2;
          if (!pt || b2 < 0) continue;
          n++;
          // α = −ξ / sin θ, β = √(…): Bardeen 1973.
          expect(pt[0] * r).toBeCloseTo(-xi / Math.sin(th), 4);
          expect(pt[1] * r).toBeCloseTo(Math.sqrt(b2), 4);
        }
        expect(n).toBeGreaterThan(10);
      }
    }
  });

  it('the exact edge seen from the default distance also separates captured from escaping rays', () => {
    const a = spinLength(0.99);
    for (const inc of [84, 89.5, 30]) {
      const cam = kerrCamera(30, inc, 24, a);
      const curve = shadowCurveScreen(a, 24, inc * DEG, 300);
      const c = centroid(curve);
      for (let i = 0; i < curve.length; i += Math.floor(curve.length / 16)) {
        const [x, y] = curve[i]!;
        expect(fateAt(cam, c[0] + (x - c[0]) * 0.99, c[1] + (y - c[1]) * 0.99)).toBe('captured');
        expect(fateAt(cam, c[0] + (x - c[0]) * 1.01, c[1] + (y - c[1]) * 1.01)).toBe('escaped');
      }
    }
  });

  it('is D-shaped: shifted away from, and flattened on, the side rotating towards the camera', () => {
    const a = spinLength(0.99);
    const curve = shadowCurveScreen(a, 24, 90 * DEG, 400);
    const xs = curve.map((p) => p[0]);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    // Shifted right (towards the receding side), so the left edge is closer to the centre.
    expect(right + left).toBeGreaterThan(0.2 * (right - left));
    // Flat on the left: near the left edge the curve stays close to x = left over a tall range of y.
    const nearLeft = curve.filter((p) => p[0] < left + 0.03 * (right - left));
    const nearRight = curve.filter((p) => p[0] > right - 0.03 * (right - left));
    const span = (pts: [number, number][]) => Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    expect(span(nearLeft)).toBeGreaterThan(1.3 * span(nearRight));
    // And the left (flat) side is the approaching side of the prograde disk.
    const cam = kerrCamera(30, 84, 24, a);
    const tan = makeCamera(30, 84, 24, 16 / 9);
    const g = (x: number) => {
      const res = traceKerrPixel(cam, x, -0.02, tan.tanX, tan.tanY, { h: 0.05, maxSteps: 4000 });
      return kerrRedshift(res.crossings[0]!.r, a, res.ell, cam.lapse2).g;
    };
    expect(g(-0.3)).toBeGreaterThan(g(0.3));
  });
});

describe('constants of motion along Kerr rays', () => {
  const a = spinLength(0.99);
  const cam = kerrCamera(30, 70, 24, a);
  const rays: Vec3[] = [];
  for (let j = -2; j <= 2; j++) for (let i = -3; i <= 3; i++) rays.push(localDirection(i * 0.05, j * 0.05, 1, 1));
  // (H and Q are monitored outside 1.05 r₊; a captured ray deeper in no longer affects the image.)

  it('H = 0 at the camera for every pixel direction (null initial data)', () => {
    for (const n of rays) expect(Math.abs(kerrHamiltonian(cam.pos, initialMomentum(cam, n), a))).toBeLessThan(1e-12);
  });

  it('H stays ≈ 0 and the Carter constant Q is conserved, at every quality level', () => {
    for (const q of Object.values(QUALITY_SETTINGS)) {
      let maxH = 0;
      let maxQ = 0;
      for (const n of rays) {
        const res = traceKerr(cam.pos, initialMomentum(cam, n), a, { h: q.kerrH, maxSteps: 4000, monitor: true });
        maxH = Math.max(maxH, res.maxHamiltonian);
        maxQ = Math.max(maxQ, res.maxCarterDrift);
      }
      // RK4: the drift scales as h⁴, from Ultra (h = 0.06: Q to ~2e-6) to Low (h = 0.22: ~5e-4).
      const s4 = (q.kerrH / 0.22) ** 4;
      expect(maxH, `quality h=${q.kerrH}`).toBeLessThan(1.6e-2 * s4);
      expect(maxQ, `quality h=${q.kerrH}`).toBeLessThan(6e-4 * s4);
    }
  });
});

describe('Kerr redshift', () => {
  it('a = 0 gives exactly the Schwarzschild g and its two factors', () => {
    for (const r of [3, 5, 12]) {
      for (const ell of [-4, 0, 3]) {
        const lapse2 = 1 - R_S / 24;
        const k = kerrRedshift(r, 0, ell, lapse2);
        expect(k.g).toBeCloseTo(redshiftFactor(r, ell, 24), 12);
        expect(k.grav).toBeCloseTo(gravFactor(r, 24), 12);
        expect(k.doppler).toBeCloseTo(dopplerFactor(r, ell), 12);
      }
    }
  });

  it('a circular equatorial emitter far out has the Schwarzschild redshift for any spin', () => {
    for (const chi of [0.5, 0.998]) {
      for (const ell of [-50, 0, 50]) {
        const r = 2000;
        const k = kerrRedshift(r, spinLength(chi), ell);
        expect(Math.abs(k.g / redshiftFactor(r, ell, Infinity) - 1)).toBeLessThan(2e-5);
      }
    }
  });

  it('face-on (ℓ = 0) light from the ISCO is more redshifted the faster the hole spins', () => {
    let prev = Infinity;
    for (const chi of [0, 0.5, 0.9, 0.998]) {
      const a = spinLength(chi);
      const g = kerrRedshift(iscoRadius(a), a, 0).g;
      expect(g).toBeLessThan(prev);
      prev = g;
    }
    expect(kerrRedshift(iscoRadius(0), 0, 0).g).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('Ω and u^t of the circular orbit reduce to Kepler at a = 0', () => {
    const o = circularOrbit(4, 0);
    expect(o.omega).toBeCloseTo(Math.sqrt(MASS / 64), 12);
    expect(o.ut).toBeCloseTo(1 / Math.sqrt(1 - (1.5 * R_S) / 4), 12);
  });

  it('the Boyer–Lindquist azimuth offset vanishes for a = 0 and far from the hole', () => {
    expect(blAzimuthOffset(5, 0)).toBe(0);
    expect(Math.abs(blAzimuthOffset(1e5, spinLength(0.99)))).toBeLessThan(1e-4);
  });
});

describe('Kerr disk crossings', () => {
  it('a ray just above the shadow lands on the far side of the disk, bent over the top', () => {
    const a = spinLength(0.9);
    const cam = kerrCamera(30, 84, 24, a);
    const tan = makeCamera(30, 84, 24, 16 / 9);
    const res = traceKerrPixel(cam, 0, 0.3, tan.tanX, tan.tanY, { h: 0.05, maxSteps: 4000 });
    expect(res.crossings.length).toBeGreaterThanOrEqual(1);
    const c = res.crossings[0]!;
    // The far side of the disk, bent over the top: crossing behind the hole.
    expect(dot(c.pos, cam.pos)).toBeLessThan(0);
    expect(c.r).toBeGreaterThan(iscoRadius(a));
  });
});
