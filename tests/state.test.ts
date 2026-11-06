import { describe, expect, it } from 'vitest';
import { decodeDisplay, decodeState, defaultState, encodeState, type ViewState } from '../src/state';

describe('URL hash state', () => {
  it('round-trips the default state', () => {
    const s = defaultState();
    expect(decodeState(encodeState(s), defaultState(true))).toEqual(s);
  });

  it('round-trips a non-default state', () => {
    const s: ViewState = {
      azimuth: 123.4,
      inclination: 12.5,
      distance: 41.25,
      spin: 0.75,
      temperature: 9000,
      exposure: -1.25,
      quality: 'ultra',
      doppler: false,
      gravRedshift: true,
      lensing: false,
      disk: true,
      guides: true,
      compare: true,
      animate: false,
      autoOrbit: true,
    };
    expect(decodeState(encodeState(s), defaultState())).toEqual(s);
  });

  it('every boolean flag survives a round trip on its own', () => {
    const keys = ['doppler', 'gravRedshift', 'lensing', 'disk', 'guides', 'compare', 'animate', 'autoOrbit'] as const;
    for (const k of keys) {
      const s = defaultState();
      s[k] = !s[k];
      expect(decodeState(encodeState(s), defaultState())[k]).toBe(s[k]);
    }
  });

  it('clamps out-of-range values and ignores junk', () => {
    const base = defaultState();
    const s = decodeState('#az=-30&inc=500&r=1&t=99999&ev=nope&q=extreme&zzz=1', base);
    expect(s.azimuth).toBe(330);
    expect(s.inclination).toBe(179);
    expect(s.distance).toBe(5);
    expect(s.temperature).toBe(20000);
    expect(s.exposure).toBe(base.exposure);
    expect(s.quality).toBe(base.quality);
  });

  it('a partial hash only overrides what it mentions', () => {
    const base = defaultState();
    const s = decodeState('#inc=45', base);
    expect({ ...s, inclination: base.inclination }).toEqual(base);
    expect(s.inclination).toBe(45);
  });

  it('decodes display options', () => {
    expect(decodeDisplay('#ui=0&debug=1')).toEqual({ hideUi: true, debug: true });
    expect(decodeDisplay('')).toEqual({ hideUi: false, debug: false });
  });

  it('encodes the spin and clamps it to [0, 0.998]', () => {
    const s = { ...defaultState(), spin: 0.99 };
    const h = encodeState(s);
    expect(h).toContain('spin=0.990');
    expect(decodeState(h, defaultState()).spin).toBe(0.99);
    expect(decodeState('#spin=1.5', defaultState()).spin).toBe(0.998);
    expect(decodeState('#spin=-1', defaultState()).spin).toBe(0);
    expect(decodeState('#spin=abc', defaultState()).spin).toBe(0);
    // Old links without a spin key keep the non-spinning hole.
    expect(decodeState('#az=10&inc=80&r=20', defaultState()).spin).toBe(0);
  });
});
