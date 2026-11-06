/**
 * Redshift of light from a thin disk of gas on circular geodesic orbits.
 * Units: r_s = 1 (M = 1/2), lengths in r_s.
 *
 * Emitter on a circular orbit at radius r with angular velocity
 *     Ω = dφ/dt = √(M/r³) = √(r_s / (2 r³))
 * has four-velocity u_em = u^t (1, 0, 0, Ω) with
 *     u^t = 1/√(1 − 3M/r) = 1/√(1 − (3/2) r_s / r).
 * A photon has conserved energy E = −p_t and angular momentum about the
 * disk axis L_z = p_φ. The frequency an observer measures is ν ∝ −p·u, so
 *     ν_em  = u^t (E − Ω L_z)
 *     ν_obs = E / √(1 − r_s/r_obs)          (static observer at r_obs)
 * and the ratio g = ν_obs/ν_em = 1/(1+z) is
 *
 *     g = √(1 − 3r_s/(2r)) / [ (1 − Ω ℓ) √(1 − r_s/r_obs) ],   ℓ = L_z/E.
 *
 * It factors exactly into a gravitational part and a special-relativistic
 * Doppler part measured by a static observer at the emitter:
 *     g_grav = √(1 − r_s/r) / √(1 − r_s/r_obs)
 *     g_dopp = √(1 − v²) / (1 − v cos θ) = √(1 − v²) / (1 − Ω ℓ)
 * with local orbital speed v = √(r_s / (2(r − r_s))) (= c/2 at the ISCO) and
 * v cos θ = Ω ℓ. The renderer exposes g_grav and g_dopp as separate toggles.
 *
 * Face-on check: a photon that reaches an observer on the axis has ℓ = 0,
 * so for r_obs → ∞, g = √(1 − 3/(2r)); at the ISCO (r = 3) g = 1/√2.
 */
import { DISK_INNER, DISK_PEAK_RADIUS, R_S } from './constants';

/** Keplerian angular velocity dφ/dt (exact for Schwarzschild in coordinate time). */
export function omegaKepler(r: number): number {
  return Math.sqrt(R_S / (2 * r * r * r));
}

/** Orbital speed measured by a local static observer. */
export function orbitalSpeed(r: number): number {
  return Math.sqrt(R_S / (2 * (r - R_S)));
}

/** Gravitational part of g: emitter at r, static observer at rObs (Infinity allowed). */
export function gravFactor(r: number, rObs: number): number {
  const obs = Number.isFinite(rObs) ? Math.sqrt(1 - R_S / rObs) : 1;
  return Math.sqrt(1 - R_S / r) / obs;
}

/** Doppler part of g for photon angular momentum ℓ = L_z/E about the orbit axis. */
export function dopplerFactor(r: number, ell: number): number {
  const v = orbitalSpeed(r);
  return Math.sqrt(1 - v * v) / (1 - omegaKepler(r) * ell);
}

/** Full redshift factor g = ν_obs/ν_em. */
export function redshiftFactor(r: number, ell: number, rObs: number): number {
  const obs = Number.isFinite(rObs) ? Math.sqrt(1 - R_S / rObs) : 1;
  return Math.sqrt(1 - (1.5 * R_S) / r) / ((1 - omegaKepler(r) * ell) * obs);
}

/**
 * Observed bolometric intensity scales as g⁴: I_ν/ν³ is invariant along a
 * ray (Liouville), so I_ν,obs = g³ I_ν,em(ν/g), and integrating over ν adds
 * one more factor of g. For a blackbody this is the same as saying the
 * observer sees a blackbody at temperature g·T.
 */
export const BEAMING_EXPONENT = 4;

/** Novikov–Thorne-like radial flux shape r⁻³ (1 − √(r_in/r)), zero at the inner edge. */
export function diskFluxShape(r: number): number {
  if (r <= DISK_INNER) return 0;
  return (1 - Math.sqrt(DISK_INNER / r)) / (r * r * r);
}

/** Local effective temperature, T ∝ F^{1/4}, scaled so the peak equals tPeak. */
export function diskTemperature(r: number, tPeak: number): number {
  return tPeak * Math.pow(diskFluxShape(r) / diskFluxShape(DISK_PEAK_RADIUS), 0.25);
}
