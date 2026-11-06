/**
 * Keeps the GLSL and the TypeScript physics in lock-step:
 *  - shared constants live only in src/physics/constants.ts and are injected;
 *  - the shader's integrator functions (binetAccel, rk4, stepSize) are pulled
 *    out of the .glsl source, translated mechanically to JavaScript and run
 *    against the TypeScript port on the same inputs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { glslDefines, injectConstants, SHADER_CONSTANTS, SHADER_VEC3_CONSTANTS, B_CRIT, DISK_OUTER, R_ESCAPE } from '../src/physics/constants';
import { binetAccel, rk4, stepSize } from '../src/physics/geodesic';

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
      if (name === 'MAX_STEPS_HARD') expect(value).toMatch(/^\d+$/);
      else expect(value).toMatch(/^-?\d+\.\d*(e[-+]?\d+)?$/);
    }
  });

  for (const [name, src] of [
    ['blackhole.frag.glsl', frag],
    ['composite.frag.glsl', composite],
  ] as const) {
    it(`${name} takes constants only from the injected block`, () => {
      expect(src).toContain('//#include constants');
      const shared = new Set([...Object.keys(SHADER_CONSTANTS), ...Object.keys(SHADER_VEC3_CONSTANTS)]);
      // Constants the shader declares itself (purely cosmetic ones like STAR_SIGMA).
      const local = new Set([...src.matchAll(/const\s+\w+\s+([A-Z][A-Z0-9_]+)\s*=/g)].map((m) => m[1]!));
      const used = new Set([...src.replace(/\/\/.*$/gm, '').matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]!));
      for (const id of used) expect(shared.has(id) || local.has(id), `${id} is neither shared nor declared locally`).toBe(true);
      for (const id of shared) expect(src).not.toMatch(new RegExp(`#define\\s+${id}\\b`));
      expect(() => injectConstants(src)).not.toThrow();
    });
  }

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
