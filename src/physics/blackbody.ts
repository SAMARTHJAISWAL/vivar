/**
 * Blackbody colour.
 *
 * The colour of a blackbody at temperature T is computed by integrating
 * Planck's law against the CIE 1931 2° colour-matching functions to get XYZ,
 * then converting to linear sRGB. The colour-matching functions use the
 * multi-lobe Gaussian fit of Wyman, Sloan & Shirley (JCGT 2013), which is
 * accurate to well under 1% of the tabulated curves for this purpose.
 *
 * The result is normalised to unit luminance (Y = 1); brightness is applied
 * separately by the renderer. The shader samples a 1-D lookup table built
 * from this function, so CPU and GPU colours are identical.
 */
import { LUT_T_MAX, LUT_T_MIN } from './constants';

const H = 6.62607015e-34; // Planck constant, J s
const C = 2.99792458e8; // speed of light, m/s
const K = 1.380649e-23; // Boltzmann constant, J/K

function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

/** CIE 1931 colour-matching functions (Wyman et al. 2013 multi-lobe fit), λ in nm. */
export function cieXYZ(lambdaNm: number): [number, number, number] {
  const l = lambdaNm;
  const x = 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
  const y = 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
  const z = 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

/** Planck spectral radiance B_λ(T) in W·sr⁻¹·m⁻³. */
export function planck(lambdaNm: number, tKelvin: number): number {
  const l = lambdaNm * 1e-9;
  return (2 * H * C * C) / (l ** 5 * (Math.exp((H * C) / (l * K * tKelvin)) - 1));
}

/** Unnormalised CIE XYZ of a blackbody at T. */
export function blackbodyXYZ(tKelvin: number): [number, number, number] {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let l = 380; l <= 780; l += 2) {
    const p = planck(l, tKelvin);
    const [x, y, z] = cieXYZ(l);
    X += p * x;
    Y += p * y;
    Z += p * z;
  }
  return [X, Y, Z];
}

/** XYZ → linear sRGB (D65). */
export function xyzToLinearSrgb([X, Y, Z]: [number, number, number]): [number, number, number] {
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

/**
 * Linear sRGB colour of a blackbody at T, normalised to luminance Y = 1.
 * Out-of-gamut (negative) components are clipped to zero.
 */
export function blackbodyRGB(tKelvin: number): [number, number, number] {
  const xyz = blackbodyXYZ(tKelvin);
  const y = xyz[1];
  const rgb = xyzToLinearSrgb([xyz[0] / y, 1, xyz[2] / y]);
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}

export { LUT_T_MIN, LUT_T_MAX };
export const LUT_SIZE = 256;

/** Map a temperature to the LUT texture coordinate in [0, 1] (mirrors the shader). */
export function lutCoord(tKelvin: number): number {
  const t = Math.min(Math.max(tKelvin, LUT_T_MIN), LUT_T_MAX);
  return Math.log(t / LUT_T_MIN) / Math.log(LUT_T_MAX / LUT_T_MIN);
}

/** RGBA float data for the blackbody lookup texture (alpha unused). */
export function buildBlackbodyLUT(size = LUT_SIZE): Float32Array {
  const data = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const s = i / (size - 1);
    const t = LUT_T_MIN * Math.pow(LUT_T_MAX / LUT_T_MIN, s);
    const [r, g, b] = blackbodyRGB(t);
    data.set([r, g, b, 1], i * 4);
  }
  return data;
}
