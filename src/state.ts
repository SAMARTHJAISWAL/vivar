/**
 * Viewer state and its URL-hash encoding.
 *
 * The hash is a short, human-readable query string, e.g.
 *   #az=34.0&inc=80.0&r=26.0&spin=0.000&t=6500&ev=0.00&q=high&fx=dop,grav,lens,disk&anim=1&orbit=0
 * Unknown keys are ignored and out-of-range values are clamped, so any hash
 * (including hand-edited or truncated ones) decodes to a valid state.
 */
import { CAM_DIST_MAX, CAM_DIST_MIN, SPIN_MAX } from './physics/constants';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITIES: readonly Quality[] = ['low', 'medium', 'high', 'ultra'];

export interface ViewState {
  /** Camera azimuth around the disk axis, degrees. */
  azimuth: number;
  /** Observer inclination from the disk axis, degrees: 0 face-on, 90 edge-on. */
  inclination: number;
  /** Camera distance from the centre, in r_s. */
  distance: number;
  /** Dimensionless spin χ = a/M of the hole, 0 (Schwarzschild) to SPIN_MAX. */
  spin: number;
  /** Peak disk temperature in kelvin. */
  temperature: number;
  /** Exposure in stops (EV). */
  exposure: number;
  quality: Quality;
  doppler: boolean;
  gravRedshift: boolean;
  lensing: boolean;
  disk: boolean;
  guides: boolean;
  /** Split screen: left half GR rays, right half straight rays. */
  compare: boolean;
  /** Animate the disk texture. */
  animate: boolean;
  autoOrbit: boolean;
}

export const INCLINATION_MIN = 1;
export const INCLINATION_MAX = 179;
export const TEMP_MIN = 2000;
export const TEMP_MAX = 20000;
export const EV_MIN = -3;
export const EV_MAX = 3;

export function defaultState(reducedMotion = false): ViewState {
  return {
    azimuth: 30,
    inclination: 84,
    distance: 24,
    spin: 0,
    temperature: 4500,
    exposure: 0,
    quality: 'high',
    doppler: true,
    gravRedshift: true,
    lensing: true,
    disk: true,
    guides: false,
    compare: false,
    animate: !reducedMotion,
    autoOrbit: false,
  };
}

const FLAG_KEYS = {
  doppler: 'dop',
  gravRedshift: 'grav',
  lensing: 'lens',
  disk: 'disk',
  guides: 'guides',
  compare: 'split',
} as const;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Wrap an angle in degrees into [0, 360). */
export function wrapDegrees(a: number): number {
  if (a >= 0 && a < 360) return a;
  return ((a % 360) + 360) % 360;
}

export function encodeState(s: ViewState): string {
  const fx = (Object.keys(FLAG_KEYS) as (keyof typeof FLAG_KEYS)[]).filter((k) => s[k]).map((k) => FLAG_KEYS[k]);
  const parts = [
    `az=${wrapDegrees(s.azimuth).toFixed(1)}`,
    `inc=${s.inclination.toFixed(1)}`,
    `r=${s.distance.toFixed(2)}`,
    `spin=${s.spin.toFixed(3)}`,
    `t=${Math.round(s.temperature)}`,
    `ev=${s.exposure.toFixed(2)}`,
    `q=${s.quality}`,
    `fx=${fx.join(',')}`,
    `anim=${s.animate ? 1 : 0}`,
    `orbit=${s.autoOrbit ? 1 : 0}`,
  ];
  return '#' + parts.join('&');
}

function num(params: URLSearchParams, key: string): number | undefined {
  const v = params.get(key);
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Decode a hash onto `base`; anything missing or invalid keeps the base value. */
export function decodeState(hash: string, base: ViewState): ViewState {
  const s: ViewState = { ...base };
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const az = num(params, 'az');
  if (az !== undefined) s.azimuth = wrapDegrees(az);
  const inc = num(params, 'inc');
  if (inc !== undefined) s.inclination = clamp(inc, INCLINATION_MIN, INCLINATION_MAX);
  const r = num(params, 'r');
  if (r !== undefined) s.distance = clamp(r, CAM_DIST_MIN, CAM_DIST_MAX);
  const spin = num(params, 'spin');
  if (spin !== undefined) s.spin = clamp(spin, 0, SPIN_MAX);
  const t = num(params, 't');
  if (t !== undefined) s.temperature = clamp(t, TEMP_MIN, TEMP_MAX);
  const ev = num(params, 'ev');
  if (ev !== undefined) s.exposure = clamp(ev, EV_MIN, EV_MAX);
  const q = params.get('q');
  if (q !== null && (QUALITIES as readonly string[]).includes(q)) s.quality = q as Quality;
  const fx = params.get('fx');
  if (fx !== null) {
    const set = new Set(fx.split(',').map((x) => x.trim()));
    for (const [k, code] of Object.entries(FLAG_KEYS) as [keyof typeof FLAG_KEYS, string][]) s[k] = set.has(code);
  }
  const anim = params.get('anim');
  if (anim === '0' || anim === '1') s.animate = anim === '1';
  const orbit = params.get('orbit');
  if (orbit === '0' || orbit === '1') s.autoOrbit = orbit === '1';
  return s;
}

/** Extra, non-shared display options that may also appear in the hash. */
export interface DisplayOptions {
  /** Hide all UI (for clean captures). */
  hideUi: boolean;
  /** Debug view: captured = red, escaped = green, disk = blue. */
  debug: boolean;
}

export function decodeDisplay(hash: string): DisplayOptions {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return { hideUi: params.get('ui') === '0', debug: params.get('debug') === '1' };
}
