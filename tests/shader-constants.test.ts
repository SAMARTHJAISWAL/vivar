/**
 * Keeps the GLSL and the TypeScript physics in lock-step:
 *  - shared constants live only in src/physics/constants.ts and are injected;
 *  - the shader's integrator functions (binetAccel, rk4, stepSize, and the
 *    Kerr functions) are pulled out of the .glsl source, translated
 *    mechanically to JavaScript and run against the TypeScript port on the
 *    same inputs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { glslDefines, injectConstants, SHADER_CONSTANTS, SHADER_VEC3_CONSTANTS, VARIANT_DEFINES, B_CRIT, DISK_OUTER, R_ESCAPE } from '../src/physics/constants';
import { binetAccel, rk4, stepSize } from '../src/physics/geodesic';
import {
  blAzimuthOffset,
  circularOrbit,
  hermite,
  hermiteRoot,
  horizonRadius,
  kerrCamera,
  kerrRedshift,
  kerrRhs,
  kerrRk4,
  kerrStepSize,
  ksRadius,
  initialMomentum,
  iscoRadius,
  localDirection,
  spinLength,
} from '../src/physics/kerr';
import type { Vec3 } from '../src/physics/vec';
import { translateGlsl } from './glsl-to-js';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../src/shaders/${name}`, import.meta.url)), 'utf8');
const frag = read('blackhole.frag.glsl');
const composite = read('composite.frag.glsl');

describe('shared constants', () => {
  it('every shared constant is emitted as a #define or const', () => {
    const defs = glslDefines();
    for (const k of Object.keys(SHADER_CONSTANTS)) expect(defs).toMatch(new RegExp(`#define ${k} `));
    for (const k of Object.keys(SHADER_VEC3_CONSTANTS)) expect(defs).toMatch(new RegExp(`const vec3 ${k} = vec3\\(`));
  });

  it('defines are valid GLSL float literals (except the loop bound)', () => {
    for (const line of glslDefines().split('\n').filter((l) => l.startsWith('#define'))) {
      const [, name, value] = line.split(' ');
      if (name === 'MAX_STEPS_HARD' || name === 'KERR') expect(value).toMatch(/^\d+$/);
      else expect(value).toMatch(/^-?\d+\.\d*(e[-+]?\d+)?$/);
    }
  });

  for (const [name, src] of [
    ['blackhole.frag.glsl', frag],
    ['composite.frag.glsl', composite],
  ] as const) {
    it(`${name} takes constants only from the injected block`, () => {
      expect(src).toContain('//#include constants');
      const shared = new Set([...Object.keys(SHADER_CONSTANTS), ...Object.keys(SHADER_VEC3_CONSTANTS), ...VARIANT_DEFINES]);
      // Constants the shader declares itself (purely cosmetic ones like STAR_SIGMA).
      const local = new Set([...src.matchAll(/const\s+\w+\s+([A-Z][A-Z0-9_]+)\s*=/g)].map((m) => m[1]!));
      const used = new Set([...src.replace(/\/\/.*$/gm, '').matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]!));
      for (const id of used) expect(shared.has(id) || local.has(id), `${id} is neither shared nor declared locally`).toBe(true);
      for (const id of shared) expect(src).not.toMatch(new RegExp(`#define\\s+${id}\\b`));
      expect(() => injectConstants(src)).not.toThrow();
    });
  }

  it('the KERR switch is emitted for both variants', () => {
    expect(glslDefines()).toContain('#define KERR 0');
    expect(glslDefines({ kerr: true })).toContain('#define KERR 1');
    expect(injectConstants(frag, { kerr: true })).toContain('#define KERR 1');
  });

  it('no physical constant is hard-coded in the shader', () => {
    const code = frag.replace(/\/\/.*$/gm, '');
    expect(code).not.toContain(B_CRIT.toFixed(3).slice(0, 4)); // 2.59…
    expect(code).not.toMatch(new RegExp(`\\b${DISK_OUTER}\\.0\\b`));
    expect(code).not.toMatch(new RegExp(`\\b${R_ESCAPE}\\.0\\b`));
  });
});

/** Pull a top-level function's parameter list and body out of GLSL source. */
function extract(src: string, name: string): { params: string; body: string } {
  const m = new RegExp(`^\\w+ ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)^\\}`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return { params: m[1]!, body: m[2]! };
}

/** Mechanical GLSL→JS for the tiny scalar subset used by the integrator. */
function toJs(body: string): string {
  return body
    .replace(/\b(float|bool|int)\s+(?=\w+\s*=)/g, 'let ')
    .replace(/\b(max|min|abs|sqrt)\(/g, 'Math.$1(')
    .replace(/(\d+\.\d*)(?![\d.])/g, '$1');
}

describe('GLSL integrator matches the TypeScript port', () => {
  const consts = Object.entries(SHADER_CONSTANTS)
    .map(([k, v]) => `const ${k} = ${v};`)
    .join('\n');

  const accelSrc = extract(frag, 'binetAccel');
  const glslAccel = new Function('u', 'gr', `${consts}\n${toJs(accelSrc.body)}`) as (u: number, gr: boolean) => number;
  const rk4Src = extract(frag, 'rk4');
  const glslRk4 = new Function(
    'u',
    'w',
    'h',
    'gr',
    `${consts}\nconst binetAccel = (u, gr) => {${toJs(accelSrc.body)}};\n${toJs(rk4Src.body)}\nreturn [u, w];`,
  ) as (u: number, w: number, h: number, gr: boolean) => [number, number];
  const stepSrc = extract(frag, 'stepSize');
  const glslStep = new Function('u', 'w', 'u_hBase', 'u_eps', `${consts}\n${toJs(stepSrc.body)}`) as (
    u: number,
    w: number,
    hBase: number,
    eps: number,
  ) => number;

  it('parameter lists are what the harness expects', () => {
    expect(accelSrc.params).toBe('float u, bool gr');
    expect(rk4Src.params).toBe('inout float u, inout float w, float h, bool gr');
    expect(stepSrc.params).toBe('float u, float w');
  });

  it('binetAccel agrees', () => {
    for (const u of [0, 0.01, 0.3, 2 / 3, 0.99]) {
      expect(glslAccel(u, true)).toBe(binetAccel(u, true));
      expect(glslAccel(u, false)).toBe(binetAccel(u, false));
    }
  });

  it('rk4 agrees over a whole trajectory', () => {
    let a: [number, number] = [1 / 26, 0.03];
    let b: [number, number] = [1 / 26, 0.03];
    for (let i = 0; i < 300; i++) {
      const h = stepSize(a[0], a[1], 0.05, 0.05);
      a = rk4(a[0], a[1], h, true);
      b = glslRk4(b[0], b[1], glslStep(b[0], b[1], 0.05, 0.05), true);
      if (a[0] > 1) break;
    }
    expect(b[0]).toBeCloseTo(a[0], 12);
    expect(b[1]).toBeCloseTo(a[1], 12);
  });

  it('stepSize agrees', () => {
    for (const [u, w] of [
      [0.04, 0],
      [0.04, 0.5],
      [0.5, -3],
      [0.9, 1e8],
    ] as const) {
      expect(glslStep(u, w, 0.08, 0.08)).toBe(stepSize(u, w, 0.08, 0.08));
    }
  });
});

describe('GLSL Kerr functions match the TypeScript port', () => {
  const consts = { ...SHADER_CONSTANTS } as Record<string, number>;
  const g = translateGlsl(
    frag,
    ['ksRadius', 'kerrRhs', 'kerrRk4', 'kerrStepSize', 'hermiteRoot', 'hermite3', 'kerrOmega', 'blAzimuthOffset', 'kerrRedshift'],
    consts,
  );
  type Out = Record<string, unknown>;
  const rhs = (q: Vec3, p: Vec3, a: number) => {
    const o: Out = { dq: [0, 0, 0], dp: [0, 0, 0] };
    const r = g.kerrRhs!(q, p, a, o) as number;
    return { r, dq: o.dq as Vec3, dp: o.dp as Vec3 };
  };
  const close = (x: number, y: number) => expect(x).toBeCloseTo(y, 12);
  const closeV = (x: Vec3, y: Vec3) => x.forEach((v, i) => expect(v).toBeCloseTo(y[i]!, 12));

  const a = spinLength(0.99);
  const states: [Vec3, Vec3][] = [
    [[3, 0.4, -2], [0.2, -0.5, 0.7]],
    [[0.1, 5, 0.2], [-0.3, -0.9, 0.1]],
    [[-1.2, -0.05, 0.9], [0.8, 0.2, -0.4]],
    [[20, 1, 12], [-0.8, 0.05, -0.5]],
  ];

  it('ksRadius and kerrRhs agree', () => {
    for (const spin of [0, a, spinLength(0.5)]) {
      for (const [q, p] of states) {
        close(g.ksRadius!(q, spin) as number, ksRadius(q, spin));
        const x = rhs(q, p, spin);
        const y = kerrRhs(q, p, spin);
        close(x.r, y.r);
        closeV(x.dq, y.dq);
        closeV(x.dp, y.dp);
      }
    }
  });

  it('kerrRk4 and kerrStepSize agree over a whole ray from the camera', () => {
    const cam = kerrCamera(30, 84, 24, a);
    const p0 = initialMomentum(cam, localDirection(0.12, 0.05, 0.868, 0.488));
    const rH = horizonRadius(a);
    let qa = cam.pos;
    let pa = p0;
    let qb: Vec3 = [...cam.pos];
    let pb: Vec3 = [...p0];
    for (let i = 0; i < 120; i++) {
      const ka = kerrRhs(qa, pa, a);
      const ha = kerrStepSize(ka.r, Math.hypot(...ka.dq), rH, 0.08);
      [qa, pa] = kerrRk4(qa, pa, ka, ha, a);
      const kb = rhs(qb, pb, a);
      const hb = g.kerrStepSize!(kb.r, Math.hypot(...kb.dq), rH, 0.08) as number;
      const o: Out = { q: qb, p: pb };
      g.kerrRk4!(kb.dq, kb.dp, hb, a, o);
      qb = o.q as Vec3;
      pb = o.p as Vec3;
      if (ka.r < rH + 0.01) break;
    }
    closeV(qb, qa);
    closeV(pb, pa);
  });

  it('hermiteRoot and hermite3 agree', () => {
    for (const [y0, y1, m0, m1] of [
      [0.3, -0.2, -0.4, -0.6],
      [-1, 2, 3, 2.5],
      [0.01, -0.01, -0.02, -0.02],
    ] as const) {
      const t = hermiteRoot(y0, y1, m0, m1);
      close(g.hermiteRoot!(y0, y1, m0, m1) as number, t);
      expect(Math.abs(hermite(y0, y1, m0, m1, t))).toBeLessThan(1e-9);
      const v = g.hermite3!([y0, 1, 2], [y1, 3, -1], [m0, 0.5, 0.1], [m1, -0.2, 0.3], t) as Vec3;
      close(v[0], hermite(y0, y1, m0, m1, t));
      close(v[2], hermite(2, -1, 0.1, 0.3, t));
    }
  });

  it('kerrOmega, blAzimuthOffset and kerrRedshift agree', () => {
    for (const spin of [spinLength(0.3), a, spinLength(0.998)]) {
      const rH = horizonRadius(spin);
      const rIn = iscoRadius(spin);
      for (const r of [rIn, 1.3 * rIn, 4, 13]) {
        close(g.kerrOmega!(r, spin) as number, circularOrbit(r, spin).omega);
        close(g.blAzimuthOffset!(r, spin, rH) as number, blAzimuthOffset(r, spin));
        for (const ell of [-3, 0, 2.2]) {
          const o: Out = { grav: 0 };
          const gAll = g.kerrRedshift!(r, spin, ell, 0.96, o) as number;
          const ts = kerrRedshift(r, spin, ell, 0.96);
          close(gAll, ts.g);
          close(o.grav as number, ts.grav);
        }
      }
    }
  });
});
