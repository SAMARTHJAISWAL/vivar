import type { Quality } from './state';

export interface QualitySettings {
  /** Integration step budget per ray. */
  maxSteps: number;
  /** Cap on Δφ per step (radians). */
  hBase: number;
  /** Target |Δ ln u| per step. */
  eps: number;
  /** FBM octaves for the disk texture. */
  octaves: number;
  /** Render-scale bounds (fraction of canvas pixels per axis) for the adaptive controller. */
  minScale: number;
  maxScale: number;
  /** Device-pixel-ratio cap. */
  maxDpr: number;
  /** Kerr tracer (spin > 0): step budget, affine step as a fraction of r − ½r₊, and the render-scale floor. */
  kerrSteps: number;
  kerrH: number;
  kerrMinScale: number;
}

export const QUALITY_SETTINGS: Record<Quality, QualitySettings> = {
  low: { maxSteps: 120, hBase: 0.12, eps: 0.12, octaves: 3, minScale: 0.3, maxScale: 0.6, maxDpr: 1, kerrSteps: 120, kerrH: 0.22, kerrMinScale: 0.25 },
  medium: { maxSteps: 200, hBase: 0.08, eps: 0.08, octaves: 4, minScale: 0.4, maxScale: 0.85, maxDpr: 1.5, kerrSteps: 180, kerrH: 0.16, kerrMinScale: 0.33 },
  high: { maxSteps: 320, hBase: 0.05, eps: 0.05, octaves: 5, minScale: 0.5, maxScale: 1.0, maxDpr: 2, kerrSteps: 260, kerrH: 0.11, kerrMinScale: 0.4 },
  ultra: { maxSteps: 560, hBase: 0.03, eps: 0.03, octaves: 6, minScale: 0.6, maxScale: 1.0, maxDpr: 2, kerrSteps: 640, kerrH: 0.06, kerrMinScale: 0.5 },
};
