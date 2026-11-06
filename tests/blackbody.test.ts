import { describe, expect, it } from 'vitest';
import { blackbodyRGB, buildBlackbodyLUT, cieXYZ, lutCoord, LUT_SIZE } from '../src/physics/blackbody';

describe('blackbody colour', () => {
  it('1500 K is orange-red', () => {
    const [r, g, b] = blackbodyRGB(1500);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(g / r).toBeLessThan(0.5);
    expect(b / r).toBeLessThan(0.05);
  });

  it('6500 K is close to white', () => {
    const [r, g, b] = blackbodyRGB(6500);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    expect(min / max).toBeGreaterThan(0.9);
  });

  it('15000 K is bluish', () => {
    const [r, g, b] = blackbodyRGB(15000);
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });

  it('red/blue ratio falls monotonically with temperature', () => {
    let prev = Infinity;
    for (let t = 1000; t <= 40000; t *= 1.25) {
      const [r, , b] = blackbodyRGB(t);
      const ratio = r / Math.max(b, 1e-9);
      expect(ratio).toBeLessThan(prev);
      prev = ratio;
    }
  });

  it('colour-matching fit peaks near the right wavelengths', () => {
    const peak = (i: 0 | 1 | 2, lo: number, hi: number) => {
      let best = lo;
      for (let l = lo; l <= hi; l++) if (cieXYZ(l)[i] > cieXYZ(best)[i]) best = l;
      return best;
    };
    expect(Math.abs(peak(1, 450, 650) - 555)).toBeLessThan(10); // ȳ peaks at ~555 nm
    expect(Math.abs(peak(0, 520, 700) - 600)).toBeLessThan(10); // x̄ main lobe ~600 nm
    expect(Math.abs(peak(2, 400, 520) - 446)).toBeLessThan(10); // z̄ ~446 nm
  });

  it('lookup table is finite and spans the range', () => {
    const lut = buildBlackbodyLUT();
    expect(lut.length).toBe(LUT_SIZE * 4);
    expect(lut.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(lutCoord(800)).toBe(0);
    expect(lutCoord(60000)).toBe(1);
    expect(lutCoord(1e9)).toBe(1);
  });
});
