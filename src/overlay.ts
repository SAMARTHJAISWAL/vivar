/**
 * Turn the analytic Kerr shadow edge (tangent-plane screen coordinates) into
 * the polar form the composite shader draws: a centre in canvas pixels and the
 * curve's radius at CURVE_SAMPLES angles θ_k = −π + 2πk/N around it.
 */
import { CURVE_SAMPLES, type ShadowOverlay } from './renderer';

export function curveOverlay(screen: readonly [number, number][], tanX: number, tanY: number, width: number, height: number): ShadowOverlay | null {
  if (screen.length < 3) return null;
  const px = screen.map(([x, y]) => [(x / tanX) * 0.5 * width + 0.5 * width, (y / tanY) * 0.5 * height + 0.5 * height] as const);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of px) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const cx = 0.5 * (x0 + x1);
  const cy = 0.5 * (y0 + y1);
  const radii: number[] = [];
  for (let k = 0; k < CURVE_SAMPLES; k++) {
    const th = -Math.PI + (2 * Math.PI * k) / CURVE_SAMPLES;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    let best = 0;
    // Intersect the ray from the centre with every segment of the closed polyline.
    for (let i = 0; i < px.length; i++) {
      const [ax, ay] = px[i]!;
      const [bx, by] = px[(i + 1) % px.length]!;
      const ex = bx - ax;
      const ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - cx) * ey - (ay - cy) * ex) / den;
      const u = ((ax - cx) * dy - (ay - cy) * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
    }
    radii.push(best);
  }
  return { center: [cx, cy], radii };
}
