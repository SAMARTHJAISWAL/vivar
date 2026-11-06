/**
 * Shared physical and numerical constants.
 *
 * Units: geometric units with G = c = 1 and the Schwarzschild radius
 * r_s = 2M = 1. Every length is measured in r_s and every time in r_s / c.
 * (So M = 1/2. Formulas written for M in textbooks pick up factors of 2.)
 *
 * This file is the single source of truth for both the TypeScript physics
 * port and the GLSL shader: `glslDefines()` turns the values below into a
 * block of `#define`s that is spliced into the shader source, so the two
 * cannot drift apart. tests/shader-constants.test.ts enforces this.
 */

/** Schwarzschild radius (event horizon), the unit of length. */
export const R_S = 1.0;

/** Mass in these units: r_s = 2M. */
export const MASS = R_S / 2;

/** Radius of the unstable circular photon orbit, r = 3M = 1.5 r_s. */
export const R_PHOTON = 1.5 * R_S;

/** Innermost stable circular orbit for massive particles, r = 6M = 3 r_s. */
export const R_ISCO = 3.0 * R_S;

/**
 * Critical impact parameter b_c = 3√3 M = (3√3/2) r_s ≈ 2.598 r_s.
 * Rays from infinity with b < b_c are captured; b > b_c escape. This is the
 * radius of the shadow seen by a distant observer.
 */
export const B_CRIT = ((3 * Math.sqrt(3)) / 2) * R_S;

/** Inner and outer edge of the thin accretion disk. */
export const DISK_INNER = R_ISCO;
export const DISK_OUTER = 14.0 * R_S;

/**
 * Radius of peak emitted flux in the Novikov–Thorne / Shakura–Sunyaev
 * profile F ∝ r⁻³ (1 − √(r_in/r)): dF/dr = 0 at r = (49/36) r_in.
 */
export const DISK_PEAK_RADIUS = (49 / 36) * DISK_INNER;

/** Rays moving outward beyond this radius are treated as escaped. */
export const R_ESCAPE = 100.0 * R_S;

/** Camera distance limits (must stay well inside R_ESCAPE). */
export const CAM_DIST_MIN = 5.0;
export const CAM_DIST_MAX = 60.0;

/** Hard upper bound on integration steps compiled into the shader loop. */
export const MAX_STEPS_HARD = 640;

/** Smallest allowed step in φ, to stop the step controller stalling. */
export const H_MIN = 1.0e-4;

/** Simulation time (r_s/c) that elapses per wall-clock second of animation. */
export const TIME_SCALE = 8.0;

/**
 * Period (in r_s/c) of the two-layer flow used to animate the disk texture.
 * Keplerian shear winds any pattern into ever-thinner spirals; two copies of
 * the texture, each reset every period and cross-faded, keep it bounded.
 */
export const FLOW_PERIOD = 60.0;

/** Temperature range of the blackbody lookup texture, sampled uniformly in log T. */
export const LUT_T_MIN = 800;
export const LUT_T_MAX = 60000;

/** Direction (unit vector) of the procedural background galaxy used for the Einstein-ring preset. */
export const GALAXY_DIR: readonly [number, number, number] = normalize3([-0.82, 0.18, -0.54]);

function normalize3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Values injected into the shader. Keys become `#define` names. */
export const SHADER_CONSTANTS = {
  R_S,
  R_PHOTON,
  R_ISCO,
  B_CRIT,
  DISK_INNER,
  DISK_OUTER,
  DISK_PEAK_RADIUS,
  R_ESCAPE,
  MAX_STEPS_HARD,
  H_MIN,
  FLOW_PERIOD,
  LUT_T_MIN,
  LUT_T_MAX,
  PI: Math.PI,
} as const;

/** Vector constants injected as `const vec3`. */
export const SHADER_VEC3_CONSTANTS = {
  GALAXY_DIR,
} as const;

function glslFloat(x: number): string {
  // Always emit a decimal point or exponent so GLSL parses a float.
  const s = Number.isInteger(x) ? x.toFixed(1) : x.toPrecision(9);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/** GLSL source for the shared constants (one `#define` per line). */
export function glslDefines(): string {
  const lines: string[] = ['// ---- generated from src/physics/constants.ts; do not edit ----'];
  for (const [name, value] of Object.entries(SHADER_CONSTANTS)) {
    lines.push(name === 'MAX_STEPS_HARD' ? `#define ${name} ${value}` : `#define ${name} ${glslFloat(value)}`);
  }
  for (const [name, v] of Object.entries(SHADER_VEC3_CONSTANTS)) {
    lines.push(`const vec3 ${name} = vec3(${v.map(glslFloat).join(', ')});`);
  }
  lines.push('// ---- end generated ----');
  return lines.join('\n');
}

/** Splice the generated constants into a shader that contains the `//#include constants` marker. */
export function injectConstants(source: string): string {
  const marker = '//#include constants';
  if (!source.includes(marker)) throw new Error('shader source is missing the constants marker');
  return source.replace(marker, glslDefines());
}
