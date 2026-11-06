/**
 * A small GLSL → JavaScript translator for the straight-line numeric subset the
 * shader's physics functions use, so tests can run the shader's own code.
 *
 * Supported: float/int/bool/vec3 declarations and assignments (=, +=, -=, *=),
 * `return`, counted `for` loops, the ternary operator, swizzles .x/.y/.z,
 * vec3(...) constructors, built-ins (sqrt, abs, min, max, clamp, pow, log, atan,
 * dot, length, normalize, floor, fract) and calls between translated functions,
 * including `out`/`inout` parameters. Vector arithmetic goes through helpers
 * that mix scalars and 3-vectors the way GLSL does. Anything else throws, so a
 * shader edit that leaves the subset fails loudly instead of silently.
 */

type Tok = { t: 'num' | 'id' | 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[-+*/(),.?:<>!]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot tokenize: ${src.slice(i)}`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'id', v: m[2] });
    else out.push({ t: 'op', v: m[3]! });
  }
  return out;
}

const BUILTINS: Record<string, string> = {
  sqrt: 'G.sqrt',
  abs: 'G.abs',
  min: 'G.min',
  max: 'G.max',
  clamp: 'G.clamp',
  pow: 'G.pow',
  log: 'G.log',
  atan: 'G.atan',
  dot: 'G.dot',
  length: 'G.length',
  normalize: 'G.normalize',
  floor: 'G.floor',
  fract: 'G.fract',
  vec3: 'G.vec3',
};

const BIN: Record<string, [number, string]> = {
  '||': [1, '||'],
  '&&': [2, '&&'],
  '<': [3, '<'],
  '>': [3, '>'],
  '<=': [3, '<='],
  '>=': [3, '>='],
  '==': [3, '==='],
  '!=': [3, '!=='],
  '+': [4, 'G.add'],
  '-': [4, 'G.sub'],
  '*': [5, 'G.mul'],
  '/': [5, 'G.div'],
};

export interface FnInfo {
  params: { qual: string; type: string; name: string }[];
}

/** Translate one expression. `ref(name)` maps identifiers; `call` emits user-function calls. */
function expr(src: string, ref: (id: string) => string, call: (name: string, args: string[], raw: string[]) => string): string {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++]!;
  const expect = (v: string) => {
    const t = next();
    if (!t || t.v !== v) throw new Error(`expected ${v} in ${src}`);
  };
  // Raw source text of each argument (for out-parameter targets).
  const parseArgs = (): { js: string[]; raw: string[] } => {
    const js: string[] = [];
    const raw: string[] = [];
    if (peek()?.v === ')') {
      next();
      return { js, raw };
    }
    for (;;) {
      const start = pos;
      js.push(parse(0));
      raw.push(
        toks
          .slice(start, pos)
          .map((t) => t.v)
          .join(''),
      );
      const t = next();
      if (t.v === ')') break;
      if (t.v !== ',') throw new Error(`bad argument list in ${src}`);
    }
    return { js, raw };
  };
  const primary = (): string => {
    const t = next();
    if (!t) throw new Error(`unexpected end of ${src}`);
    let e: string;
    if (t.t === 'num') e = t.v;
    else if (t.v === '(') {
      e = `(${parse(0)})`;
      expect(')');
    } else if (t.v === '-') e = `G.neg(${unary()})`;
    else if (t.v === '!') e = `!(${unary()})`;
    else if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') e = t.v;
      else if (peek()?.v === '(') {
        next();
        const { js, raw } = parseArgs();
        e = BUILTINS[t.v] ? `${BUILTINS[t.v]}(${js.join(', ')})` : call(t.v, js, raw);
      } else e = ref(t.v);
    } else throw new Error(`unexpected ${t.v} in ${src}`);
    while (peek()?.v === '.') {
      next();
      const sw = next().v;
      const idx = { x: 0, y: 1, z: 2 }[sw];
      if (idx === undefined) throw new Error(`unsupported swizzle .${sw}`);
      e = `G.at(${e}, ${idx})`;
    }
    return e;
  };
  const unary = (): string => primary();
  const parse = (minPrec: number): string => {
    let lhs = unary();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.v === '?' && minPrec === 0) {
        next();
        const a = parse(0);
        expect(':');
        const b = parse(0);
        lhs = `(${lhs} ? ${a} : ${b})`;
        continue;
      }
      const op = BIN[t.v];
      if (!op || op[0] < Math.max(minPrec, 1) || t.t !== 'op') break;
      next();
      const rhs = parse(op[0] + 1);
      lhs = op[1].startsWith('G.') ? `${op[1]}(${lhs}, ${rhs})` : `(${lhs} ${op[1]} ${rhs})`;
    }
    return lhs;
  };
  const out = parse(0);
  if (pos !== toks.length) throw new Error(`trailing tokens in ${src}`);
  return out;
}

/** Pull a top-level function's signature and body out of GLSL source. */
export function extractGlsl(src: string, name: string): { ret: string; params: string; body: string } {
  const m = new RegExp(`^(\\w+) ${name}\\(([^)]*)\\) \\{\\n([\\s\\S]*?)^\\}`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return { ret: m[1]!, params: m[2]!, body: m[3]! };
}

function parseParams(params: string): FnInfo['params'] {
  if (params.trim() === '') return [];
  return params.split(',').map((p) => {
    const parts = p.trim().split(/\s+/);
    if (parts.length === 3) return { qual: parts[0]!, type: parts[1]!, name: parts[2]! };
    return { qual: 'in', type: parts[0]!, name: parts[1]! };
  });
}

/**
 * Translate the named GLSL functions (and nothing else) to JavaScript.
 * `consts` are #define values; `uniforms` are made available by name.
 * Returns callable functions. A function with out/inout parameters takes them
 * as an object `{ name: value }` after the in-parameters and writes results back into it.
 */
export function translateGlsl(src: string, names: string[], consts: Record<string, number>): Record<string, (...args: unknown[]) => unknown> {
  const infos = new Map<string, FnInfo>();
  const pieces = names.map((n) => ({ n, ...extractGlsl(src, n) }));
  for (const p of pieces) infos.set(p.n, { params: parseParams(p.params) });
  let js = '';
  for (const p of pieces) {
    const info = infos.get(p.n)!;
    const outs = new Set(info.params.filter((q) => q.qual !== 'in').map((q) => q.name));
    const ref = (id: string) => (outs.has(id) ? `$.${id}` : /^[A-Z][A-Z0-9_]+$/.test(id) ? `C.${id}` : id);
    let tmp = 0;
    const call = (fn: string, args: string[], raw: string[]) => {
      const callee = infos.get(fn);
      if (!callee) throw new Error(`call to untranslated function ${fn}`);
      const ins: string[] = [];
      const binds: [string, string][] = [];
      callee.params.forEach((q, i) => {
        if (q.qual === 'in') ins.push(args[i]!);
        else binds.push([q.name, raw[i]!]);
      });
      if (binds.length === 0) return `${fn}(${ins.join(', ')})`;
      const o = `$o${tmp++}`;
      const init = binds.map(([k, v]) => `${k}: ${ref(v)}`).join(', ');
      const back = binds.map(([k, v]) => `${ref(v)} = ${o}.${k};`).join(' ');
      return `((${o}) => { const $r = ${fn}(${[...ins, o].join(', ')}); ${back} return $r; })({ ${init} })`;
    };
    const lines: string[] = [];
    for (const raw of p.body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (line === '') continue;
      if (line === '}' || line === '{') {
        lines.push(line);
        continue;
      }
      const forM = /^for \(int (\w+) = (\d+); \1 < (\d+); \1\+\+\) \{$/.exec(line);
      if (forM) {
        lines.push(`for (let ${forM[1]} = ${forM[2]}; ${forM[1]} < ${forM[3]}; ${forM[1]}++) {`);
        continue;
      }
      for (const stmt of line.split(';').map((x) => x.trim()).filter(Boolean)) {
        let m: RegExpExecArray | null;
        if ((m = /^(?:float|int|bool|vec3) (\w+) = (.+)$/.exec(stmt))) lines.push(`let ${m[1]} = ${expr(m[2]!, ref, call)};`);
        else if ((m = /^(?:float|int|bool|vec3) (\w+)$/.exec(stmt))) lines.push(`let ${m[1]};`);
        else if ((m = /^return (.+)$/.exec(stmt))) lines.push(`return ${expr(m[1]!, ref, call)};`);
        else if ((m = /^(\w+) (=|\+=|-=|\*=) (.+)$/.exec(stmt))) {
          const target = ref(m[1]!);
          const rhs = expr(m[3]!, ref, call);
          const op = { '=': '', '+=': 'G.add', '-=': 'G.sub', '*=': 'G.mul' }[m[2]!]!;
          lines.push(op ? `${target} = ${op}(${target}, ${rhs});` : `${target} = ${rhs};`);
        } else throw new Error(`unsupported statement in ${p.n}: ${stmt}`);
      }
    }
    const ins = info.params.filter((q) => q.qual === 'in').map((q) => q.name);
    const sig = outs.size > 0 ? [...ins, '$'] : ins;
    js += `function ${p.n}(${sig.join(', ')}) {\n${lines.join('\n')}\n}\n`;
  }
  const G = glslRuntime();
  const factory = new Function('G', 'C', `${js}\nreturn { ${names.join(', ')} };`) as (
    g: typeof G,
    c: Record<string, number>,
  ) => Record<string, (...args: unknown[]) => unknown>;
  return factory(G, consts);
}

type V = number | number[];

function glslRuntime() {
  const lift = (f: (a: number, b: number) => number) => (a: V, b: V): V => {
    if (typeof a === 'number' && typeof b === 'number') return f(a, b);
    const va = typeof a === 'number' ? [a, a, a] : a;
    const vb = typeof b === 'number' ? [b, b, b] : b;
    return [f(va[0]!, vb[0]!), f(va[1]!, vb[1]!), f(va[2]!, vb[2]!)];
  };
  const map = (f: (a: number) => number) => (a: V): V => (typeof a === 'number' ? f(a) : a.map(f));
  const dot = (a: V, b: V) => {
    const va = a as number[];
    const vb = b as number[];
    return va[0]! * vb[0]! + va[1]! * vb[1]! + va[2]! * vb[2]!;
  };
  return {
    add: lift((a, b) => a + b),
    sub: lift((a, b) => a - b),
    mul: lift((a, b) => a * b),
    div: lift((a, b) => a / b),
    neg: map((a) => -a),
    sqrt: map(Math.sqrt),
    abs: map(Math.abs),
    log: map(Math.log),
    floor: map(Math.floor),
    fract: map((a) => a - Math.floor(a)),
    min: lift(Math.min),
    max: lift(Math.max),
    pow: lift(Math.pow),
    atan: (y: V, x?: V) => (x === undefined ? map(Math.atan)(y) : lift(Math.atan2)(y, x)),
    clamp: (x: V, lo: V, hi: V) => lift(Math.min)(lift(Math.max)(x, lo), hi),
    dot,
    length: (a: V) => Math.sqrt(dot(a, a)),
    normalize: (a: V) => {
      const l = Math.sqrt(dot(a, a));
      return (a as number[]).map((x) => x / l);
    },
    vec3: (...a: number[]) => (a.length === 1 ? [a[0]!, a[0]!, a[0]!] : [a[0]!, a[1]!, a[2]!]),
    at: (v: V, i: number) => (v as number[])[i]!,
  };
}
