/**
 * Orbit camera shared by the renderer (to fill shader uniforms) and the
 * CPU-side annotation code (to trace the same rays the shader traces).
 */
import { B_CRIT, R_S } from './constants';
import { cross, dot, normalize, scale, add, type Vec3 } from './vec';

export interface Camera {
  pos: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** tan of half the field of view along x and y. */
  tanX: number;
  tanY: number;
}

/**
 * Framing. The scene is wider than it is tall: seen from near the disk plane,
 * the disk spans about ±36° horizontally from the default distance (its outer
 * edge, r = 14 r_s seen from 24 r_s, subtends asin(14/24) ≈ 35.7°) but only a
 * few degrees vertically. So the camera guarantees two things at once:
 *  - a vertical field of view of at least FOV_DEG (what wide screens get), and
 *  - a horizontal half-angle of at least FIT_HALF_DEG = 37.5°, enough for the
 *    whole disk (35.7° plus a little lensing) with a small margin.
 * On a 16:9 or wider screen the first is the binding one, so landscape framing
 * is exactly what it always was. On narrower screens (4:3, portrait phones) the
 * second takes over, so the disk never runs off the sides; a portrait screen
 * then simply shows more sky above and below.
 */
export const FOV_DEG = 52;
export const FIT_HALF_DEG = 37.5;

const DEG = Math.PI / 180;

/** tan of the half field of view along x and y for a viewport aspect ratio (width / height). */
export function framing(aspect: number): { tanX: number; tanY: number } {
  const tanX = Math.max(Math.tan((FOV_DEG * DEG) / 2) * aspect, Math.tan(FIT_HALF_DEG * DEG));
  return { tanX, tanY: tanX / aspect };
}

/** Camera position for azimuth/inclination (degrees) and distance. The disk axis is +y. */
export function cameraPosition(azimuthDeg: number, inclinationDeg: number, distance: number): Vec3 {
  const a = azimuthDeg * DEG;
  const i = inclinationDeg * DEG;
  return [distance * Math.sin(i) * Math.cos(a), distance * Math.cos(i), distance * Math.sin(i) * Math.sin(a)];
}

export function makeCamera(azimuthDeg: number, inclinationDeg: number, distance: number, aspect: number): Camera {
  const pos = cameraPosition(azimuthDeg, inclinationDeg, distance);
  const forward = normalize(scale(pos, -1));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const { tanX, tanY } = framing(aspect);
  return { pos, forward, right, up, tanX, tanY };
}

/** Ray direction for normalised device coordinates in [−1, 1]². */
export function rayDirection(cam: Camera, ndcX: number, ndcY: number): Vec3 {
  return normalize(add(add(cam.forward, scale(cam.right, ndcX * cam.tanX)), scale(cam.up, ndcY * cam.tanY)));
}

/** Normalised device coordinates of a (unit) view direction, or null if behind the camera. */
export function directionToNdc(cam: Camera, dir: Vec3): [number, number] | null {
  const z = dot(dir, cam.forward);
  if (z <= 1e-6) return null;
  return [dot(dir, cam.right) / z / cam.tanX, dot(dir, cam.up) / z / cam.tanY];
}

/**
 * Apparent angular radius of the shadow for a static observer at distance r:
 * the ray with b = b_c leaves the camera at angle α_c from the inward
 * direction with sin α_c = (b_c / r) √(1 − r_s/r). Valid for r > 1.5 r_s.
 */
export function shadowAngularRadius(distance: number): number {
  return Math.asin(Math.min(1, (B_CRIT / distance) * Math.sqrt(1 - R_S / distance)));
}
