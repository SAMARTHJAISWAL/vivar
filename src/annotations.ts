/**
 * Locate the features explained in the "What am I looking at?" overlay by
 * tracing a coarse grid of the same rays the shader traces, on the CPU.
 */
import { DISK_INNER, DISK_OUTER } from './physics/constants';
import { directionToNdc, rayDirection, shadowAngularRadius, type Camera } from './physics/camera';
import { firstEquatorCrossing, planePoint, setupRay, trace } from './physics/geodesic';
import { redshiftFactor } from './physics/redshift';
import { add, cross, dot, length, normalize, scale, type Vec3 } from './physics/vec';

export type FeatureId = 'shadow' | 'ring' | 'over' | 'under' | 'doppler' | 'isco';

export type FeaturePositions = Partial<Record<FeatureId, [number, number]>>;

interface Hit {
  ndc: [number, number];
  k: number;
  r: number;
  g: number;
  far: boolean;
}

export function locateFeatures(cam: Camera, lensing: boolean, cols = 56, rows = 34): FeaturePositions {
  const out: FeaturePositions = { shadow: [0, 0] };
  const dist = length(cam.pos);

  // Photon ring: the critical curve, drawn at 45° up and to the right.
  const alpha = lensing ? shadowAngularRadius(dist) : Math.asin(1 / dist);
  const diag = normalize(add(cam.right, cam.up));
  const ringDir = normalize(add(scale(cam.forward, Math.cos(alpha)), scale(diag, Math.sin(alpha))));
  const ring = directionToNdc(cam, ringDir);
  if (ring) out.ring = ring;

  const toCam = normalize(cam.pos);
  const hits: Hit[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const ndc: [number, number] = [-0.95 + (1.9 * i) / (cols - 1), -0.95 + (1.9 * j) / (rows - 1)];
      const dir = rayDirection(cam, ndc[0], ndc[1]);
      const p = setupRay(cam.pos, dir, lensing);
      const res = trace(p.u0, p.w0, {
        gr: lensing,
        hBase: 0.08,
        eps: 0.08,
        maxSteps: 240,
        firstCross: firstEquatorCrossing(p),
        b: p.b,
      });
      const c = res.crossings.find((x) => 1 / x.u > DISK_INNER && 1 / x.u < DISK_OUTER);
      if (!c) continue;
      const r = 1 / c.u;
      const pt: Vec3 = planePoint(p, c.phi, c.u);
      const ell = -p.b * cross(p.e1, p.e2)[1];
      hits.push({ ndc, k: c.k, r, g: redshiftFactor(r, ell, dist), far: dot(pt, toCam) < 0 });
    }
  }
  if (hits.length === 0) return out;

  // Far side of the disk, bent up over the top of the shadow.
  const over = hits.filter((h) => h.k === 0 && h.far && h.ndc[1] > 0 && Math.abs(h.ndc[0]) < 0.12);
  if (over.length > 0) {
    over.sort((a, b) => a.ndc[1] - b.ndc[1]);
    out.over = over[Math.floor(over.length / 2)]!.ndc;
  }
  // Secondary image: rays that cross the plane once before hitting the disk.
  const under = hits.filter((h) => h.k === 1 && Math.abs(h.ndc[0]) < 0.12 && h.ndc[1] < 0);
  if (under.length > 0) {
    under.sort((a, b) => b.ndc[1] - a.ndc[1]);
    out.under = under[0]!.ndc;
  }
  // Brightest (most blueshifted) direct image of the disk.
  const direct = hits.filter((h) => h.k === 0);
  if (direct.length > 0) {
    out.doppler = direct.reduce((a, b) => (b.g > a.g ? b : a)).ndc;
    // ISCO: the inner edge of the direct image, nearest the bottom centre.
    const inner = direct.filter((h) => h.r < DISK_INNER * 1.25 && !h.far);
    const pool = inner.length > 0 ? inner : direct;
    out.isco = pool.reduce((a, b) => (Math.abs(b.ndc[0]) + 0.3 * b.r < Math.abs(a.ndc[0]) + 0.3 * a.r ? b : a)).ndc;
  }
  return out;
}
