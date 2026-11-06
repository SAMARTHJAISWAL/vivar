/**
 * Locate the features explained in the "What am I looking at?" overlay by
 * tracing a coarse grid of the same rays the shader traces, on the CPU.
 */
import { DISK_INNER, DISK_OUTER } from './physics/constants';
import { directionToNdc, rayDirection, shadowAngularRadius, type Camera } from './physics/camera';
import { firstEquatorCrossing, planePoint, setupRay, trace } from './physics/geodesic';
import { iscoRadius, kerrRedshift, shadowCurveScreen, traceKerrPixel, type KerrCamera } from './physics/kerr';
import { redshiftFactor } from './physics/redshift';
import { add, cross, dot, length, normalize, scale, type Vec3 } from './physics/vec';

export type FeatureId = 'shadow' | 'ring' | 'over' | 'under' | 'doppler' | 'isco';

export type FeaturePositions = Partial<Record<FeatureId, [number, number]>>;

interface Hit {
  ndc: [number, number];
  k: number;
  /** Shows the underside image: it lands on the disk after crossing the plane once. */
  under: boolean;
  r: number;
  g: number;
  far: boolean;
}

export function locateFeatures(cam: Camera, lensing: boolean, cols = 56, rows = 34, kerr: KerrCamera | null = null): FeaturePositions {
  if (kerr && lensing) return locateKerr(cam, kerr, cols, rows);
  const out: FeaturePositions = {};
  const dist = length(cam.pos);

  // Shadow: label the upper half of the dark disc (the lower half is usually behind the disk).
  const alpha = lensing ? shadowAngularRadius(dist) : Math.asin(1 / dist);
  out.shadow = [0, (0.5 * Math.tan(alpha)) / cam.tanY];

  // Photon ring: the critical curve, labelled at 45° up and to the right.
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
      hits.push({ ndc, k: c.k, under: c.k === 1, r, g: redshiftFactor(r, ell, dist), far: dot(pt, toCam) < 0 });
    }
  }
  return placeDiskFeatures(out, hits, DISK_INNER);
}

/** The same features for a spinning hole, traced with the Kerr integrator. */
function locateKerr(cam: Camera, kerr: KerrCamera, cols: number, rows: number): FeaturePositions {
  const out: FeaturePositions = {};
  const a = kerr.a;
  const rIn = iscoRadius(a);
  // Shadow and ring from the analytic edge: label inside its upper half, and on the edge up and to the right.
  const curve = shadowCurveScreen(a, kerr.r, kerr.theta, 200).map(([x, y]) => [x / cam.tanX, y / cam.tanY] as [number, number]);
  if (curve.length > 2) {
    const xs = curve.map((c) => c[0]);
    const ys = curve.map((c) => c[1]);
    const cx = 0.5 * (Math.min(...xs) + Math.max(...xs));
    const cy = 0.5 * (Math.min(...ys) + Math.max(...ys));
    out.shadow = [cx, cy + 0.5 * (Math.max(...ys) - cy)];
    const aspect = cam.tanX / cam.tanY;
    const ang = (c: [number, number]) => Math.atan2(c[1] - cy, (c[0] - cx) * aspect);
    out.ring = curve.reduce((b, c) => (Math.abs(ang(c) - Math.PI / 4) < Math.abs(ang(b) - Math.PI / 4) ? c : b));
  }
  const toCam = normalize(kerr.pos);
  const hits: Hit[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const ndc: [number, number] = [-0.95 + (1.9 * i) / (cols - 1), -0.95 + (1.9 * j) / (rows - 1)];
      const res = traceKerrPixel(kerr, ndc[0], ndc[1], cam.tanX, cam.tanY, { h: 0.16, maxSteps: 220 });
      const on = res.crossings.filter((x) => x.r > rIn && x.r < DISK_OUTER);
      const c = on[0];
      if (!c) continue;
      // With spin the disk reaches further in, so its near side can cover the underside image;
      // that image still shows through the thin outer part of the near disk.
      const under = c.k === 1 || (c.k === 0 && c.r > 0.7 * DISK_OUTER && on.some((x) => x.k === 1));
      hits.push({ ndc, k: c.k, under, r: c.r, g: kerrRedshift(c.r, a, res.ell, kerr.lapse2).g, far: dot(c.pos, toCam) < 0 });
    }
  }
  return placeDiskFeatures(out, hits, rIn);
}

function placeDiskFeatures(out: FeaturePositions, hits: Hit[], rIn: number): FeaturePositions {
  if (hits.length === 0) return out;

  // Far side of the disk, bent up over the top of the shadow.
  const over = hits.filter((h) => h.k === 0 && h.far && h.ndc[1] > 0 && Math.abs(h.ndc[0]) < 0.12);
  if (over.length > 0) {
    over.sort((a, b) => a.ndc[1] - b.ndc[1]);
    out.over = over[Math.floor(over.length / 2)]!.ndc;
  }
  // Secondary image: rays that cross the plane once before hitting the disk.
  const under = hits.filter((h) => h.under && Math.abs(h.ndc[0]) < 0.12 && h.ndc[1] < 0);
  if (under.length > 0) {
    under.sort((a, b) => b.ndc[1] - a.ndc[1]);
    out.under = under[0]!.ndc;
  }
  // Brightest (most blueshifted) direct image of the disk.
  const direct = hits.filter((h) => h.k === 0);
  if (direct.length > 0) {
    out.doppler = direct.reduce((a, b) => (b.g > a.g ? b : a)).ndc;
    // ISCO: the inner edge of the near side's direct image, a little left of
    // centre so it does not sit on top of the shadow label.
    const inner = direct.filter((h) => h.r < Math.max(rIn * 1.25, rIn + 0.3) && !h.far);
    const pool = inner.length > 0 ? inner : direct;
    const score = (h: Hit) => Math.abs(h.ndc[0] + 0.18) + 0.3 * h.r;
    out.isco = pool.reduce((a, b) => (score(b) < score(a) ? b : a)).ndc;
  }
  return out;
}
