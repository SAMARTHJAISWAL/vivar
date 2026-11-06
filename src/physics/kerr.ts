/**
 * Null geodesics and disk physics around a spinning (Kerr) black hole.
 *
 * Units: as everywhere else, r_s = 2M = 1, so M = 1/2. The spin parameter
 * a = J/M is a length: a = χ M with the dimensionless spin χ = a/M in [0, 1).
 * The UI slider shows χ; everything in this file takes the length a = χ/2.
 * (Textbook formulas are written with M; here M = MASS = 0.5 everywhere.)
 *
 * Axes: the spin axis, the disk axis and the app's +y axis coincide. The hole
 * and the disk both rotate in the positive sense about +y (the disk is
 * prograde). Where formulas use Kerr–Schild (X, Y, Z) with Z on the spin axis,
 * the app's axes map as X = z, Y = x, Z = y, which keeps the frame right-handed.
 *
 * ---------------------------------------------------------------------------
 * How rays are traced
 *
 * A camera ray is the time-reverse of the photon that reaches the camera. We
 * integrate it as a future-directed null geodesic launched from the camera along
 * the viewing direction. Time reversal t → −t maps Kerr with spin a to Kerr with
 * spin −a, so that geodesic lives in Kerr(−a). We use ingoing Kerr–Schild
 * Cartesian coordinates of Kerr(−a) (equivalently: outgoing Kerr–Schild
 * coordinates of the physical Kerr(a) and a past-directed ray). Reasons:
 *
 *  - Kerr–Schild Cartesian coordinates have no pole singularity: nothing in the
 *    equations blows up at θ = 0 or π, so there is no speckle or seam on the axis
 *    (Boyer–Lindquist has 1/sin θ terms there).
 *  - The horizon the traced rays fall through is regular in these coordinates, so
 *    captured rays cross r₊ smoothly instead of freezing as Δ → 0.
 *  - The equations are second-order Hamiltonian ones, so there are no turning
 *    points and no ± sign tracking (the first-order R(r), Θ(θ) form needs both).
 *
 * The metric is g_μν = η_μν + f k_μ k_ν with
 *     f = 2 M r³ / (r⁴ + s² Z²),
 *     k_μ = (1, l),  l = ((r X + s Y)/(r² + s²), (r Y − s X)/(r² + s²), Z/r),
 * s = −a the spin of the traced spacetime, and r the Boyer–Lindquist radius,
 * defined implicitly by (X² + Y²)/(r² + s²) + Z²/r² = 1. The inverse metric is
 * g^μν = η^μν − f k^μ k^ν. With the photon's covariant momentum p_μ = (p_t, p)
 * and p_t = −1 (we normalise E = 1), the Hamiltonian is
 *     H = ½ g^μν p_μ p_ν = ½ (|p|² − 1) − ½ f (1 + l·p)²,
 * and Hamilton's equations, in the affine parameter λ, are
 *     dx/dλ =  ∂H/∂p = p − f (1 + l·p) l
 *     dp/dλ = −∂H/∂x = ½ (1 + l·p)² ∇f + f (1 + l·p) ∇(l·p).
 * The gradients are analytic (see kerrRhs). H = 0 for a null ray and is
 * conserved; so are E = −p_t, L_z = p_φ and the Carter constant Q, which the
 * tests check along rays.
 *
 * The integrator is classical RK4 with step Δλ = h (r − K_HORIZON r₊) / |dx/dλ|,
 * K_HORIZON = ½: a fixed fraction of the distance to the centre (like the Δφ cap
 * of the Schwarzschild tracer), shrinking somewhat near the horizon, where
 * high-spin prograde photon orbits sit just outside r₊. (Kerr–Schild coordinates
 * are regular there, so no stronger shrinking is needed: with K = 0.9 the shadow
 * edge came out identical but near-critical rays cost twice the steps.)
 *
 * This module mirrors the Kerr code in src/shaders/blackhole.frag.glsl
 * function for function; tests/shader-constants.test.ts runs the GLSL against it.
 */
import { CAPTURE_MARGIN, DISK_OUTER, K_HORIZON, MASS, R_ESCAPE, R_S } from './constants';
import { dot, length, normalize, type Vec3 } from './vec';

/** Spin parameter a (length, r_s units) for dimensionless spin χ = a/M. */
export function spinLength(chi: number): number {
  return chi * MASS;
}

/** Outer horizon r₊ = M + √(M² − a²). */
export function horizonRadius(a: number): number {
  return MASS + Math.sqrt(Math.max(0, MASS * MASS - a * a));
}

/** Inner horizon r₋ = M − √(M² − a²). */
export function innerHorizonRadius(a: number): number {
  return MASS - Math.sqrt(Math.max(0, MASS * MASS - a * a));
}

/**
 * Prograde innermost stable circular orbit (Bardeen, Press & Teukolsky 1972):
 *     Z₁ = 1 + (1 − χ²)^⅓ [(1 + χ)^⅓ + (1 − χ)^⅓],   Z₂ = √(3χ² + Z₁²),
 *     r_isco = M [3 + Z₂ − √((3 − Z₁)(3 + Z₁ + 2 Z₂))].
 * χ = 0 gives 6M (= 3 r_s); χ = 0.998 gives ≈ 1.237 M.
 */
export function iscoRadius(a: number): number {
  const chi = a / MASS;
  const z1 = 1 + Math.cbrt(1 - chi * chi) * (Math.cbrt(1 + chi) + Math.cbrt(1 - chi));
  const z2 = Math.sqrt(3 * chi * chi + z1 * z1);
  return MASS * (3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2)));
}

/**
 * Radii of the circular equatorial photon orbits (Bardeen, Press & Teukolsky 1972):
 *     r_ph = 2M [1 + cos(⅔ arccos(∓χ))],   − prograde, + retrograde.
 * Spherical photon orbits fill the range between them; they make the shadow's edge.
 */
export function photonOrbitRadii(a: number): { prograde: number; retrograde: number } {
  const chi = a / MASS;
  return {
    prograde: 2 * MASS * (1 + Math.cos((2 / 3) * Math.acos(-chi))),
    retrograde: 2 * MASS * (1 + Math.cos((2 / 3) * Math.acos(chi))),
  };
}

/**
 * Constants of motion of the spherical photon orbit at radius r (Bardeen 1973):
 *     ξ = L/E = −(r³ − 3Mr² + a²r + a²M) / (a (r − M))
 *     η = Q/E² = r³ (4a²M − r (r − 3M)²) / (a² (r − M)²)
 * Valid for a ≠ 0 and r between the two equatorial photon orbits.
 */
export function sphericalPhotonOrbit(r: number, a: number): { xi: number; eta: number } {
  const M = MASS;
  const xi = -(r * r * r - 3 * M * r * r + a * a * r + a * a * M) / (a * (r - M));
  const eta = (r * r * r * (4 * a * a * M - r * (r - 3 * M) ** 2)) / (a * a * (r - M) ** 2);
  return { xi, eta };
}

/**
 * Bardeen's shadow curve for a distant observer at inclination θₒ, in units of
 * r_s on the observer's sky: α = −ξ / sin θₒ, β = ±√(η + a² cos²θₒ − ξ² cot²θₒ).
 * α > 0 is the side where the hole's surface moves away from the observer.
 * Returns points ordered around the curve (upper half, then lower half).
 */
export function bardeenCurve(a: number, thetaObs: number, n = 400): [number, number][] {
  const { prograde, retrograde } = photonOrbitRadii(a);
  const upper: [number, number][] = [];
  const s = Math.sin(thetaObs);
  const c = Math.cos(thetaObs);
  for (let i = 0; i <= n; i++) {
    // Cluster samples at the ends, where β changes fastest.
    const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    const r = prograde + (retrograde - prograde) * t;
    const { xi, eta } = sphericalPhotonOrbit(r, a);
    const b2 = eta + a * a * c * c - (xi * xi * c * c) / (s * s);
    if (b2 < 0) continue;
    upper.push([-xi / s, Math.sqrt(b2)]);
  }
  const lower = upper.map(([x, y]) => [x, -y] as [number, number]).reverse();
  return [...upper, ...lower];
}

// ------------------------------------------------------------------ circular orbits and redshift

/**
 * Prograde circular equatorial geodesic at radius r (Bardeen, Press & Teukolsky 1972):
 *     Ω = √M / (r^{3/2} + a√M),
 *     u^t = (r^{3/2} + a√M) / (r^{3/4} √(r^{3/2} − 3M r^{1/2} + 2a√M)).
 */
export function circularOrbit(r: number, a: number): { omega: number; ut: number } {
  const sm = Math.sqrt(MASS);
  const r32 = r * Math.sqrt(r);
  const omega = sm / (r32 + a * sm);
  const ut = (r32 + a * sm) / (Math.pow(r, 0.75) * Math.sqrt(r32 - 3 * MASS * Math.sqrt(r) + 2 * a * sm));
  return { omega, ut };
}

/** −g_tt of the static observer at (r, θ): 1 − 2Mr/(r² + a² cos²θ). */
export function staticLapse2(r: number, cosTheta: number, a: number): number {
  return 1 - (2 * MASS * r) / (r * r + a * a * cosTheta * cosTheta);
}

/**
 * Redshift g = ν_obs/ν_em for light from the prograde circular orbit at
 * equatorial radius r, seen by a static observer whose −g_tt is `obsLapse2`
 * (1 for an observer at infinity). ℓ = L_z/E of the photon.
 *     ν_em = u^t (E − Ω L_z),  ν_obs = E/√(−g_tt,obs)  ⇒  g = 1 / (u^t (1 − Ωℓ) √(−g_tt,obs)).
 *
 * The UI splits g into a gravitational and a Doppler part, using the
 * zero-angular-momentum observer (ZAMO) at the emitter as the reference
 * (a static observer does not exist inside the ergosphere, where high-spin disks
 * reach). With equatorial A = (r²+a²)² − a²Δ, lapse α = r√(Δ/A) and frame-
 * dragging rate ω = 2Mar/A:
 *     g_grav = ν_obs/ν_ZAMO = α / ((1 − ωℓ) √(−g_tt,obs))      (includes frame dragging)
 *     g_dopp = ν_ZAMO/ν_em = g / g_grav.
 * For a = 0 these reduce exactly to the Schwarzschild factors in redshift.ts.
 */
export function kerrRedshift(r: number, a: number, ell: number, obsLapse2 = 1): { g: number; grav: number; doppler: number } {
  const { omega, ut } = circularOrbit(r, a);
  const obs = Math.sqrt(obsLapse2);
  const g = 1 / (ut * (1 - omega * ell) * obs);
  const delta = r * r - 2 * MASS * r + a * a;
  const bigA = (r * r + a * a) ** 2 - a * a * delta;
  const alpha = r * Math.sqrt(delta / bigA);
  const w = (2 * MASS * a * r) / bigA;
  const grav = alpha / ((1 - w * ell) * obs);
  return { g, grav, doppler: g / grav };
}

/**
 * Azimuth offset between the traced ray's Kerr–Schild φ and Boyer–Lindquist φ,
 * as an offset on the app's azimuth atan2(z, x) at an equatorial point of
 * Boyer–Lindquist radius r. The disk texture is laid out in Boyer–Lindquist φ
 * (where orbits are circles at constant Ω), so the shader adds this.
 *     φ_KS = φ_BL + ∫_∞^r s/Δ dr = φ_BL + s/(r₊ − r₋) · ln((r − r₊)/(r − r₋)),  s = −a,
 * and arg(X + iY) = φ_KS + atan(s/r) from (X + iY) = (r + i s) sin θ e^{iφ_KS}.
 * The app azimuth atan2(z, x) = π/2 − arg(X + iY) runs the other way, so
 *     azimuth_BL = atan2(z, x) + atan(s/r) + s/(r₊ − r₋) · ln((r − r₊)/(r − r₋)).
 */
export function blAzimuthOffset(r: number, a: number): number {
  if (a === 0) return 0;
  const rp = horizonRadius(a);
  const rm = innerHorizonRadius(a);
  const s = -a;
  return Math.atan(s / r) + (s / (rp - rm)) * Math.log((r - rp) / (r - rm));
}

// ------------------------------------------------------------------ the Hamiltonian system (mirrors GLSL)

/** Boyer–Lindquist r of a Kerr–Schild point q (app axes; spin axis y). */
export function ksRadius(q: Vec3, a: number): number {
  const a2 = a * a;
  const w = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] - a2;
  const r2 = 0.5 * (w + Math.sqrt(w * w + 4 * a2 * q[1] * q[1]));
  return Math.sqrt(r2);
}

export interface Rhs {
  dq: Vec3;
  dp: Vec3;
  r: number;
}

/**
 * Right-hand side of Hamilton's equations at (q, p), app axes, for the traced
 * spacetime (spin s = −a). Returns dq/dλ, dp/dλ and r.
 *
 * With Σ = r⁴ + a²y², A = 1/(r² + a²) and (app axes, s = −a)
 *     l  = ((r x + a z) A, y / r, (r z − a x) A),
 *     ∇r = (x r³, y r (r² + a²), z r³) / Σ,
 *     ∇f = 2M r² / Σ² · [(3a²y² − r⁴) ∇r − (0, 2a² r y, 0)],
 *     ∇(l·p) = S ∇r + (A (r p_x − a p_z), p_y / r, A (r p_z + a p_x)),
 *     S = A (x p_x + z p_z − 2r (l_x p_x + l_z p_z)) − p_y y / r².
 */
export function kerrRhs(q: Vec3, p: Vec3, a: number): Rhs {
  const r = ksRadius(q, a);
  const r2 = r * r;
  const a2 = a * a;
  const y = q[1];
  const sig = r2 * r2 + a2 * y * y;
  const A = 1 / (r2 + a2);
  const lx = (r * q[0] + a * q[2]) * A;
  const ly = y / r;
  const lz = (r * q[2] - a * q[0]) * A;
  const L = 1 + lx * p[0] + ly * p[1] + lz * p[2];
  const f = (2 * MASS * r2 * r) / sig;
  const grx = (q[0] * r2 * r) / sig;
  const gry = (y * r * (r2 + a2)) / sig;
  const grz = (q[2] * r2 * r) / sig;
  const kf = (2 * MASS * r2) / (sig * sig);
  const cf = 3 * a2 * y * y - r2 * r2;
  const gfx = kf * cf * grx;
  const gfy = kf * (cf * gry - 2 * a2 * r * y);
  const gfz = kf * cf * grz;
  const S = A * (q[0] * p[0] + q[2] * p[2] - 2 * r * (lx * p[0] + lz * p[2])) - (p[1] * y) / r2;
  const glx = S * grx + A * (r * p[0] - a * p[2]);
  const gly = S * gry + p[1] / r;
  const glz = S * grz + A * (r * p[2] + a * p[0]);
  const fL = f * L;
  const hL2 = 0.5 * L * L;
  return {
    dq: [p[0] - fL * lx, p[1] - fL * ly, p[2] - fL * lz],
    dp: [hL2 * gfx + fL * glx, hL2 * gfy + fL * gly, hL2 * gfz + fL * glz],
    r,
  };
}

/** The Hamiltonian H = ½(|p|² − 1) − ½ f (1 + l·p)², zero on a null ray. */
export function kerrHamiltonian(q: Vec3, p: Vec3, a: number): number {
  const r = ksRadius(q, a);
  const r2 = r * r;
  const a2 = a * a;
  const A = 1 / (r2 + a2);
  const l: Vec3 = [(r * q[0] + a * q[2]) * A, q[1] / r, (r * q[2] - a * q[0]) * A];
  const f = (2 * MASS * r2 * r) / (r2 * r2 + a2 * q[1] * q[1]);
  const L = 1 + dot(l, p);
  return 0.5 * (dot(p, p) - 1) - 0.5 * f * L * L;
}

/**
 * Carter constant Q = p_θ² + cos²θ (L_z²/sin²θ − a²E²), E = 1. In Kerr–Schild
 * spheroidal coordinates p_θ is the same as in Boyer–Lindquist, and
 * ∂(X, Y, Z)/∂θ = (X cot θ, Y cot θ, −r sin θ).
 */
export function carterQ(q: Vec3, p: Vec3, a: number): number {
  const r = ksRadius(q, a);
  const cosT = q[1] / r;
  const sin2 = Math.max(1e-300, 1 - cosT * cosT);
  const sinT = Math.sqrt(sin2);
  const pTheta = (cosT / sinT) * (q[0] * p[0] + q[2] * p[2]) - r * sinT * p[1];
  const lz = axialMomentum(q, p);
  return pTheta * pTheta + cosT * cosT * ((lz * lz) / sin2 - a * a);
}

/** p_φ = X p_Y − Y p_X = z p_x − x p_z: angular momentum of the traced ray about +y. */
export function axialMomentum(q: Vec3, p: Vec3): number {
  return q[2] * p[0] - q[0] * p[2];
}

/** One RK4 step of size h, reusing the derivative k1 already evaluated at (q, p). */
export function kerrRk4(q: Vec3, p: Vec3, k1: Rhs, h: number, a: number): [Vec3, Vec3] {
  const at = (s: number, k: Rhs): [Vec3, Vec3] => [
    [q[0] + s * k.dq[0], q[1] + s * k.dq[1], q[2] + s * k.dq[2]],
    [p[0] + s * k.dp[0], p[1] + s * k.dp[1], p[2] + s * k.dp[2]],
  ];
  const [q2, p2] = at(0.5 * h, k1);
  const k2 = kerrRhs(q2, p2, a);
  const [q3, p3] = at(0.5 * h, k2);
  const k3 = kerrRhs(q3, p3, a);
  const [q4, p4] = at(h, k3);
  const k4 = kerrRhs(q4, p4, a);
  const c = h / 6;
  const comb = (i: number, f: (k: Rhs) => Vec3) => c * (f(k1)[i]! + 2 * f(k2)[i]! + 2 * f(k3)[i]! + f(k4)[i]!);
  return [
    [q[0] + comb(0, (k) => k.dq), q[1] + comb(1, (k) => k.dq), q[2] + comb(2, (k) => k.dq)],
    [p[0] + comb(0, (k) => k.dp), p[1] + comb(1, (k) => k.dp), p[2] + comb(2, (k) => k.dp)],
  ];
}

/** Affine step: Δλ = h (r − K_HORIZON r₊) / |dx/dλ|. */
export function kerrStepSize(r: number, speed: number, rH: number, h: number): number {
  return (h * (r - K_HORIZON * rH)) / Math.max(speed, 1e-6);
}

/**
 * Root t ∈ [0, 1] of the cubic Hermite interpolant of y over one step, from
 * the end values y0, y1 and slopes m0, m1 (already multiplied by the step).
 * Starts from the secant and takes three Newton steps.
 */
export function hermiteRoot(y0: number, y1: number, m0: number, m1: number): number {
  let t = y0 / (y0 - y1);
  for (let i = 0; i < 3; i++) {
    const t2 = t * t;
    const t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
    const d = (6 * t2 - 6 * t) * y0 + (3 * t2 - 4 * t + 1) * m0 + (-6 * t2 + 6 * t) * y1 + (3 * t2 - 2 * t) * m1;
    t = Math.min(1, Math.max(0, t - v / (Math.abs(d) > 1e-12 ? d : 1e-12)));
  }
  return t;
}

/** Cubic Hermite interpolation of one coordinate. */
export function hermite(y0: number, y1: number, m0: number, m1: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
}

// ------------------------------------------------------------------ camera

/** A 4-covector (t, x, y, z) in app axes. */
export type Vec4 = [number, number, number, number];

export interface KerrCamera {
  /** Spin length a. */
  a: number;
  /** Boyer–Lindquist r, θ of the camera and its Kerr–Schild position. */
  r: number;
  theta: number;
  pos: Vec3;
  /**
   * Lowered tetrad of the static observer: u (time) and the screen axes
   * right = e_φ, up = −e_θ, forward = −e_r. A ray seen in local direction
   * (n_x, n_y, n_z) (right, up, forward) has p_μ ∝ U + n_x R + n_y Up + n_z F.
   */
  U: Vec4;
  R: Vec4;
  Up: Vec4;
  F: Vec4;
  /** Euclidean directions of the same axes (for overlays). */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** −g_tt at the camera (static observer's lapse squared). */
  lapse2: number;
}

/**
 * Static observer at Boyer–Lindquist (r, θ) and the app's azimuth, with its
 * spatial frame aligned to the Boyer–Lindquist directions (e_r, e_θ, e_φ),
 * expressed in the traced spacetime's Kerr–Schild coordinates.
 *
 * A static observer (u ∝ ∂_t) exists outside the ergosphere, r > M + √(M² − a² cos²θ) ≤ r_s;
 * the camera is never closer than 5 r_s. The frame is built by Gram–Schmidt
 * in the full metric, starting from the spatial parts of the Boyer–Lindquist
 * coordinate vectors written in Kerr–Schild coordinates:
 *     ∂_r = (sin θ cos φ, sin θ sin φ, cos θ) + (s/Δ)(−Y, X, 0),
 *     ∂_θ = (cos θ (r cos φ − s sin φ), cos θ (r sin φ + s cos φ), −r sin θ),
 *     ∂_φ = (−Y, X, 0)                                  (Kerr–Schild X, Y, Z).
 * Projecting out u restores the dropped ∂_t parts exactly, so for a = 0 this is
 * the usual static frame and the ray directions agree with the Schwarzschild tracer.
 */
export function kerrCamera(azimuthDeg: number, inclinationDeg: number, distance: number, a: number): KerrCamera {
  const DEG = Math.PI / 180;
  const r = distance;
  const th = inclinationDeg * DEG;
  const ph = Math.PI / 2 - azimuthDeg * DEG; // Kerr–Schild φ; app azimuth runs the other way
  const s = -a;
  const st = Math.sin(th);
  const ct = Math.cos(th);
  const X = st * (r * Math.cos(ph) - s * Math.sin(ph));
  const Y = st * (r * Math.sin(ph) + s * Math.cos(ph));
  const Z = r * ct;
  // KS (X, Y, Z) → app (x, y, z) = (Y, Z, X).
  const app = (v: Vec3): Vec3 => [v[1], v[2], v[0]];
  const pos = app([X, Y, Z]);
  const delta = r * r - 2 * MASS * r + a * a;
  const dr = app([st * Math.cos(ph) - (s / delta) * Y, st * Math.sin(ph) + (s / delta) * X, ct]);
  const dth = app([ct * (r * Math.cos(ph) - s * Math.sin(ph)), ct * (r * Math.sin(ph) + s * Math.cos(ph)), -r * st]);
  const dph = app([-Y, X, 0]);

  // Metric pieces at the camera.
  const q = pos;
  const rr = ksRadius(q, a);
  const r2 = rr * rr;
  const A = 1 / (r2 + a * a);
  const l: Vec3 = [(rr * q[0] + a * q[2]) * A, q[1] / rr, (rr * q[2] - a * q[0]) * A];
  const f = (2 * MASS * r2 * rr) / (r2 * r2 + a * a * q[1] * q[1]);
  // g(v, w) = η(v, w) + f (k·v)(k·w), k_μ = (1, l).
  type V4 = Vec4;
  const kdot = (v: V4) => v[0] + l[0] * v[1] + l[1] * v[2] + l[2] * v[3];
  const g = (v: V4, w: V4) => -v[0] * w[0] + v[1] * w[1] + v[2] * w[2] + v[3] * w[3] + f * kdot(v) * kdot(w);
  const lower = (v: V4): V4 => {
    const k = f * kdot(v);
    return [-v[0] + k, v[1] + k * l[0], v[2] + k * l[1], v[3] + k * l[2]];
  };
  const axpy = (v: V4, s2: number, w: V4): V4 => [v[0] + s2 * w[0], v[1] + s2 * w[1], v[2] + s2 * w[2], v[3] + s2 * w[3]];
  const norm = (v: V4): V4 => {
    const n = Math.sqrt(g(v, v));
    return [v[0] / n, v[1] / n, v[2] / n, v[3] / n];
  };
  const u: V4 = [1 / Math.sqrt(1 - f), 0, 0, 0];
  const spatial = (v: Vec3): V4 => axpy([0, v[0], v[1], v[2]], g(u, [0, v[0], v[1], v[2]]), u); // + g(u,v) u
  const er = norm(spatial(dr));
  let et = spatial(dth);
  et = norm(axpy(et, -g(er, et), er));
  let ep = spatial(dph);
  ep = norm(axpy(axpy(ep, -g(er, ep), er), -g(et, ep), et));
  const neg = (v: V4): V4 => [-v[0], -v[1], -v[2], -v[3]];
  const fwd = neg(er);
  const upv = neg(et);
  const sp = (v: V4): Vec3 => normalize([v[1], v[2], v[3]]);
  return {
    a,
    r,
    theta: th,
    pos,
    U: lower(u),
    R: lower(ep),
    Up: lower(upv),
    F: lower(fwd),
    right: sp(ep),
    up: sp(upv),
    forward: sp(fwd),
    lapse2: 1 - f,
  };
}

/** Initial spatial momentum (p_t = −1) for local direction n = (right, up, forward), |n| = 1. */
export function initialMomentum(cam: KerrCamera, n: Vec3): Vec3 {
  const P = [0, 1, 2, 3].map((i) => cam.U[i]! + n[0] * cam.R[i]! + n[1] * cam.Up[i]! + n[2] * cam.F[i]!);
  const e = -P[0]!;
  return [P[1]! / e, P[2]! / e, P[3]! / e];
}

/** Local direction for normalised device coordinates. */
export function localDirection(ndcX: number, ndcY: number, tanX: number, tanY: number): Vec3 {
  return normalize([ndcX * tanX, ndcY * tanY, 1]);
}

/**
 * Upper-half point (β ≥ 0) of the shadow edge from the spherical photon orbit
 * at radius rp, in this camera's tangent-plane screen coordinates, or null if
 * no ray with those constants reaches the camera. See shadowCurveScreen.
 */
export function shadowPointScreen(a: number, r: number, theta: number, rp: number): [number, number] | null {
  const M = MASS;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const rho2 = r * r + a * a * c * c;
  const delta = r * r - 2 * M * r + a * a;
  const gtt = -(1 - (2 * M * r) / rho2);
  const gtp = (-2 * M * a * r * s * s) / rho2;
  const gpp = (((r * r + a * a) ** 2 - a * a * delta * s * s) * s * s) / rho2;
  const nphi = Math.sqrt(gpp - (gtp * gtp) / gtt);
  const e = 1 / Math.sqrt(-gtt);
  const rho = Math.sqrt(rho2);
  const { xi, eta } = sphericalPhotonOrbit(rp, a);
  const R = (r * r + a * a - a * xi) ** 2 - delta * (eta + (xi - a) ** 2);
  const Th = eta + a * a * c * c - (xi * xi * c * c) / (s * s);
  if (R < 0 || Th < 0) return null;
  const pr = Math.sqrt(R) / (rho * Math.sqrt(delta));
  const pth = Math.sqrt(Th) / rho;
  const pph = (xi + gtp / gtt) / nphi;
  // The photon arrives moving with local components (pr, pth, pph)/e along (e_r, e_θ, e_φ);
  // the camera sees it from the opposite direction. Screen axes: forward = −e_r, up = −e_θ, right = +e_φ.
  const nf = pr / e;
  const nu = pth / e;
  const nr = -pph / e;
  return [nr / nf, nu / nf];
}

/**
 * The analytic shadow edge as this camera sees it, as tangent-plane screen
 * coordinates (x = n_right/n_fwd, y = n_up/n_fwd); divide by tanX, tanY for NDC.
 *
 * The edge is made of rays that asymptote to the spherical photon orbits, with
 * constants ξ = L/E and η = Q/E² from sphericalPhotonOrbit. For the physical
 * photon arriving at the static observer (Boyer–Lindquist, E = 1):
 *     p_r = √R / Δ,  R = (r² + a² − aξ)² − Δ (η + (ξ − a)²),
 *     p_θ = ±√Θ,     Θ = η + a² cos²θ − ξ² cot²θ,
 * and its local components are p^(r) = √R/(ρ√Δ), p^(θ) = p_θ/ρ,
 * p^(φ) = (ξ + g_tφ/g_tt) / √(g_φφ − g_tφ²/g_tt), energy 1/√(−g_tt). The camera
 * sees it coming from the opposite of its direction of travel. This is exact at
 * any distance (no far-observer approximation), and tends to Bardeen's curve,
 * scaled by 1/r, as r → ∞.
 */
export function shadowCurveScreen(a: number, r: number, theta: number, n = 600): [number, number][] {
  if (a < 1e-9) {
    // Schwarzschild: a circle of radius tan α_c.
    const b = (3 * Math.sqrt(3) / 2) * R_S;
    const t = Math.tan(Math.asin(Math.min(1, (b / r) * Math.sqrt(1 - R_S / r))));
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) out.push([t * Math.cos((2 * Math.PI * i) / n), t * Math.sin((2 * Math.PI * i) / n)]);
    return out;
  }
  const { prograde, retrograde } = photonOrbitRadii(a);
  const upper: [number, number][] = [];
  const point = (rp: number) => shadowPointScreen(a, r, theta, rp);
  // The edge uses the photon-orbit radii whose rays can reach this observer
  // (Θ ≥ 0 at θₒ). Find that interval's ends precisely, then sample inside it.
  const valid = (rp: number) => point(rp) !== null;
  const N = 2000;
  const at = (i: number) => prograde + ((retrograde - prograde) * i) / N;
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i <= N; i++) {
    if (valid(at(i))) {
      if (i0 < 0) i0 = i;
      i1 = i;
    }
  }
  if (i0 < 0) return [];
  const edge = (inside: number, outside: number) => {
    let lo = inside;
    let hi = outside;
    for (let k = 0; k < 60; k++) {
      const m = 0.5 * (lo + hi);
      if (valid(m)) lo = m;
      else hi = m;
    }
    return lo;
  };
  const lo = i0 > 0 ? edge(at(i0), at(i0 - 1)) : prograde;
  const hi = i1 < N ? edge(at(i1), at(i1 + 1)) : retrograde;
  for (let i = 0; i <= n; i++) {
    const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    const pt = point(lo + (hi - lo) * t);
    if (pt) upper.push(pt);
  }
  const lower = upper.map(([x, y]) => [x, -y] as [number, number]).reverse();
  return [...upper, ...lower];
}

// ------------------------------------------------------------------ tracing (mirrors the shader loop)

export type KerrFate = 'captured' | 'escaped' | 'exhausted';

export interface KerrCrossing {
  k: number;
  /** Boyer–Lindquist radius of the equatorial crossing. */
  r: number;
  pos: Vec3;
}

export interface KerrTraceResult {
  fate: KerrFate;
  steps: number;
  crossings: KerrCrossing[];
  /** Asymptotic direction for escaped rays (app axes). */
  escapeDir: Vec3 | null;
  /** Photon ℓ = L_z/E of the physical (forward-in-time) photon. */
  ell: number;
  maxHamiltonian: number;
  maxCarterDrift: number;
}

export interface KerrTraceOptions {
  h: number;
  maxSteps: number;
  /** Track H and Q along the ray (slower). */
  monitor?: boolean;
  rEscape?: number;
}

export function traceKerr(q0: Vec3, p0: Vec3, a: number, opts: KerrTraceOptions): KerrTraceResult {
  const rH = horizonRadius(a);
  const rEsc = opts.rEscape ?? R_ESCAPE;
  let q = q0;
  let p = p0;
  let k = kerrRhs(q, p, a);
  const ell = -axialMomentum(q0, p0);
  const crossings: KerrCrossing[] = [];
  const q0c = opts.monitor ? carterQ(q0, p0, a) : 0;
  const qScale = Math.max(1, Math.abs(q0c));
  let maxH = 0;
  let maxQ = 0;
  for (let i = 0; i < opts.maxSteps; i++) {
    const h = kerrStepSize(k.r, length(k.dq), rH, opts.h);
    const [qn, pn] = kerrRk4(q, p, k, h, a);
    const kn = kerrRhs(qn, pn, a);
    if (q[1] * qn[1] < 0 || (qn[1] === 0 && q[1] !== 0)) {
      const t = hermiteRoot(q[1], qn[1], h * k.dq[1], h * kn.dq[1]);
      const x = hermite(q[0], qn[0], h * k.dq[0], h * kn.dq[0], t);
      const z = hermite(q[2], qn[2], h * k.dq[2], h * kn.dq[2], t);
      const rc = Math.sqrt(Math.max(0, x * x + z * z - a * a));
      crossings.push({ k: crossings.length, r: rc, pos: [x, 0, z] });
    }
    q = qn;
    p = pn;
    k = kn;
    // Monitor outside 1.05 r₊: inside that, a captured ray no longer affects the image.
    if (opts.monitor && k.r > rH * 1.05) {
      maxH = Math.max(maxH, Math.abs(kerrHamiltonian(q, p, a)));
      maxQ = Math.max(maxQ, Math.abs(carterQ(q, p, a) - q0c) / qScale);
    }
    if (k.r < rH + CAPTURE_MARGIN) {
      return { fate: 'captured', steps: i + 1, crossings, escapeDir: null, ell, maxHamiltonian: maxH, maxCarterDrift: maxQ };
    }
    if (k.r > rEsc && dot(q, k.dq) > 0) {
      return { fate: 'escaped', steps: i + 1, crossings, escapeDir: normalize(k.dq), ell, maxHamiltonian: maxH, maxCarterDrift: maxQ };
    }
  }
  return { fate: 'exhausted', steps: opts.maxSteps, crossings, escapeDir: null, ell, maxHamiltonian: maxH, maxCarterDrift: maxQ };
}

/** Trace the ray through normalised device coordinates (ndcX, ndcY) of a Kerr camera. */
export function traceKerrPixel(cam: KerrCamera, ndcX: number, ndcY: number, tanX: number, tanY: number, opts: KerrTraceOptions): KerrTraceResult {
  const n = localDirection(ndcX, ndcY, tanX, tanY);
  return traceKerr(cam.pos, initialMomentum(cam, n), cam.a, opts);
}

/** Disk inner edge for spin a: the prograde ISCO. */
export function diskInner(a: number): number {
  return iscoRadius(a);
}

/** Whether an equatorial crossing at r lands on the disk. */
export function onDisk(r: number, a: number): boolean {
  return r > diskInner(a) && r < DISK_OUTER;
}
