/**
 * Null geodesics in the Schwarzschild metric, in the orbit-equation (Binet) form.
 *
 * A photon's orbit lies in a plane through the centre (spherical symmetry plus
 * conservation of angular momentum). In that plane, with u = 1/r and φ the
 * polar angle,
 *
 *     d²u/dφ² = −u + (3/2) r_s u²                      (GR)
 *     d²u/dφ² = −u                                     (straight lines)
 *
 * with first integral
 *
 *     (du/dφ)² + u² (1 − r_s u) = 1/b²                 (b = L/E, impact parameter)
 *
 * This module mirrors the GLSL in src/shaders/blackhole.frag function for
 * function (binetAccel, rk4, stepSize, setupRay, trace loop), so the shader's
 * behaviour can be tested here.
 */
import { H_MIN, R_ESCAPE, R_S } from './constants';
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from './vec';

/** u'' as a function of u. `gr = false` gives straight (flat-space) rays. */
export function binetAccel(u: number, gr: boolean): number {
  return gr ? -u + 1.5 * R_S * u * u : -u;
}

/** One classical RK4 step of the system (u, w = du/dφ) over Δφ = h. */
export function rk4(u: number, w: number, h: number, gr: boolean): [number, number] {
  const k1u = w;
  const k1w = binetAccel(u, gr);
  const k2u = w + 0.5 * h * k1w;
  const k2w = binetAccel(u + 0.5 * h * k1u, gr);
  const k3u = w + 0.5 * h * k2w;
  const k3w = binetAccel(u + 0.5 * h * k2u, gr);
  const k4u = w + h * k3w;
  const k4w = binetAccel(u + h * k3u, gr);
  return [u + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u), w + (h / 6) * (k1w + 2 * k2w + 2 * k3w + k4w)];
}

/**
 * Step-size control. Two limits:
 *  - a cap `hBase` on Δφ, which bounds the error while the ray swings around
 *    the hole (the ODE is smooth in φ there, so a fixed angular step is right);
 *  - |Δ ln u| ≲ eps, i.e. Δφ ≤ eps · u / |u'|, which shrinks the step on
 *    nearly radial legs where r changes a lot per radian (plunging rays, and
 *    the start of rays aimed close to the centre).
 * Stepping in ln u near-uniformly means a radial plunge from r = 30 to the
 * horizon costs about ln(30)/eps steps instead of thousands.
 */
export function stepSize(u: number, w: number, hBase: number, eps: number): number {
  const h = (eps * u) / Math.max(Math.abs(w), 1e-12);
  return Math.min(hBase, Math.max(h, H_MIN));
}

/** First integral (du/dφ)² + u²(1 − r_s u). Equals 1/b² and is conserved. */
export function invariant(u: number, w: number, gr: boolean): number {
  return w * w + u * u * (gr ? 1 - R_S * u : 1);
}

export interface RayPlane {
  /** Unit vector from the centre to the camera (φ = 0). */
  e1: Vec3;
  /** Unit vector in the orbit plane, perpendicular to e1, towards the ray (φ = π/2). */
  e2: Vec3;
  /** Initial u = 1/r and w = du/dφ. */
  u0: number;
  w0: number;
  /** Impact parameter b = L/E of the photon. */
  b: number;
}

/**
 * Build the orbit plane and initial conditions for a ray leaving a static
 * camera at `cam` in (unit) direction `dir`, as measured by that camera.
 *
 * For a static observer at radius r the angle α between the ray and the
 * outward radial direction satisfies sin α = (b/r) √(1 − r_s/r). Combining
 * with the first integral gives
 *     u' = −u √(1 − r_s u) · cot α,   b = r sin α / √(1 − r_s/r).
 * With lensing off, the flat-space versions drop the square roots.
 */
export function setupRay(cam: Vec3, dir: Vec3, gr: boolean): RayPlane {
  const r0 = length(cam);
  const e1 = scale(cam, 1 / r0);
  const cosA = dot(dir, e1);
  let perp = sub(dir, scale(e1, cosA));
  let sinA = length(perp);
  if (sinA < 1e-7) {
    // Ray aimed exactly through the centre: any plane containing it works.
    const helper: Vec3 = Math.abs(e1[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    perp = normalize(cross(cross(e1, helper), e1));
    sinA = 1e-7;
  } else {
    perp = scale(perp, 1 / sinA);
  }
  const u0 = 1 / r0;
  const lapse = gr ? Math.sqrt(1 - R_S * u0) : 1;
  const w0 = (-u0 * lapse * cosA) / sinA;
  const b = (r0 * sinA) / lapse;
  return { e1, e2: perp, u0, w0, b };
}

/** Point in 3-D space at polar angle φ and inverse radius u in the ray's plane. */
export function planePoint(p: RayPlane, phi: number, u: number): Vec3 {
  const r = 1 / u;
  return add(scale(p.e1, r * Math.cos(phi)), scale(p.e2, r * Math.sin(phi)));
}

/**
 * The first φ > 0 at which the ray's plane cuts the equatorial plane y = 0.
 * y(φ) ∝ cos φ · e1.y + sin φ · e2.y does not depend on u, so the crossings are
 * exactly π apart: φ_k = φ_0 + kπ. The shader lands an RK4 step exactly on
 * each φ_k instead of interpolating, so disk hits are as accurate as the
 * integrator itself. Returns Infinity if the ray lies in the equatorial plane.
 */
export function firstEquatorCrossing(p: RayPlane): number {
  const a = p.e1[1];
  const c = p.e2[1];
  if (Math.abs(c) < 1e-9 && Math.abs(a) < 1e-9) return Infinity;
  // Solve a cos φ + c sin φ = 0  →  φ = atan2(−a, c), taken into (0, π].
  let phi = Math.atan2(-a, c);
  while (phi <= 1e-6) phi += Math.PI;
  while (phi > Math.PI + 1e-6) phi -= Math.PI;
  return phi;
}

export interface Crossing {
  /** Index k of the crossing (0 = first time the ray meets the plane). */
  k: number;
  phi: number;
  u: number;
  w: number;
}

export type Fate = 'captured' | 'escaped' | 'exhausted';

export interface TraceResult {
  fate: Fate;
  steps: number;
  phi: number;
  u: number;
  w: number;
  crossings: Crossing[];
  /** For escaped rays: φ of the asymptotic outgoing direction. */
  phiInf: number;
  /** Largest relative drift of the first integral seen along the ray. */
  maxInvariantDrift: number;
}

export interface TraceOptions {
  gr: boolean;
  hBase: number;
  eps: number;
  maxSteps: number;
  /** φ of the first equatorial crossing (Infinity to disable). */
  firstCross?: number;
  /** u below which an outgoing ray counts as escaped. */
  uEscape?: number;
  /** b, used only for the asymptotic direction of escaped rays. */
  b?: number;
}

/**
 * Integrate a ray from (u0, w0) at φ = 0. Same loop as the shader:
 * adaptive step, clamped to land exactly on the next equatorial crossing,
 * capture at the horizon (u ≥ 1/r_s), escape when moving outward past R_ESCAPE.
 */
export function trace(u0: number, w0: number, opts: TraceOptions): TraceResult {
  const uEsc = opts.uEscape ?? 1 / R_ESCAPE;
  let u = u0;
  let w = w0;
  let phi = 0;
  let nextCross = opts.firstCross ?? Infinity;
  let k = 0;
  const crossings: Crossing[] = [];
  const inv0 = invariant(u0, w0, opts.gr);
  let maxDrift = 0;
  for (let i = 0; i < opts.maxSteps; i++) {
    let h = stepSize(u, w, opts.hBase, opts.eps);
    let onCross = false;
    if (phi + h >= nextCross) {
      h = nextCross - phi;
      onCross = true;
    }
    [u, w] = rk4(u, w, h, opts.gr);
    phi += h;
    const drift = Math.abs(invariant(u, w, opts.gr) - inv0) / inv0;
    if (drift > maxDrift) maxDrift = drift;
    if (u >= 1 / R_S) {
      return { fate: 'captured', steps: i + 1, phi, u, w, crossings, phiInf: NaN, maxInvariantDrift: maxDrift };
    }
    if (onCross) {
      crossings.push({ k, phi, u, w });
      k += 1;
      nextCross += Math.PI;
    }
    if (u < uEsc && w < 0) {
      // Remaining bend from here to infinity, treating the last stretch as straight:
      // u = sin(φ∞ − φ)/b  →  φ∞ = φ + asin(b u).
      const b = opts.b ?? 1 / Math.sqrt(invariant(u, w, opts.gr));
      const phiInf = phi + Math.asin(Math.min(1, Math.max(0, b * u)));
      return { fate: 'escaped', steps: i + 1, phi, u, w, crossings, phiInf, maxInvariantDrift: maxDrift };
    }
  }
  return { fate: 'exhausted', steps: opts.maxSteps, phi, u, w, crossings, phiInf: NaN, maxInvariantDrift: maxDrift };
}

/** Asymptotic outgoing direction of an escaped ray (the sky direction it samples). */
export function escapeDirection(p: RayPlane, phiInf: number): Vec3 {
  return add(scale(p.e1, Math.cos(phiInf)), scale(p.e2, Math.sin(phiInf)));
}

/**
 * Total bending angle for a ray coming in from infinity with impact parameter b:
 * Δφ − π, where Δφ is the change in polar angle between the incoming and
 * outgoing asymptotes. Used to check the weak-field limit 2 r_s / b.
 */
export function deflectionAngle(b: number, hBase = 0.01, eps = 0.01): number {
  const uStart = 1e-5;
  const w0 = Math.sqrt(Math.max(0, 1 / (b * b) - uStart * uStart * (1 - R_S * uStart)));
  // Incoming straight-line asymptote is at φ = −asin(b u) relative to the start point.
  const phiIn = -Math.asin(b * uStart);
  const res = trace(uStart, w0, { gr: true, hBase, eps, maxSteps: 200000, uEscape: uStart, b });
  if (res.fate !== 'escaped') return NaN;
  return res.phiInf - phiIn - Math.PI;
}
