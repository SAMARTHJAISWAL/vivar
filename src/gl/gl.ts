/** Small raw-WebGL2 helpers: programs, uniforms, render targets. */

export class GLError extends Error {}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new GLError(`createShader failed for ${label}`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    throw new GLError(`${label}: ${log}`);
  }
  return sh;
}

export type UniformValue = number | boolean | readonly number[];

/** A linked program with cached uniform locations and a typed setter. */
export class Program {
  readonly program: WebGLProgram;
  private readonly locs = new Map<string, WebGLUniformLocation | null>();
  private readonly types = new Map<string, number>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
    label: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc, `${label} (vertex)`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, `${label} (fragment)`);
    const p = gl.createProgram();
    if (!p) throw new GLError('createProgram failed');
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new GLError(`${label} link: ${gl.getProgramInfoLog(p) ?? ''}`);
    }
    this.program = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      this.types.set(info.name, info.type);
      this.locs.set(info.name, gl.getUniformLocation(p, info.name));
    }
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  /** Set a uniform by name. Unknown names (optimised out) are ignored. */
  set(name: string, value: UniformValue): this {
    const loc = this.locs.get(name);
    const type = this.types.get(name);
    if (!loc || type === undefined) return this;
    const gl = this.gl;
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    switch (type) {
      case gl.FLOAT:
        gl.uniform1f(loc, v as number);
        break;
      case gl.INT:
      case gl.BOOL:
      case gl.SAMPLER_2D:
        gl.uniform1i(loc, v as number);
        break;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(loc, v as number[]);
        break;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(loc, v as number[]);
        break;
      default:
        throw new GLError(`unsupported uniform type for ${name}`);
    }
    return this;
  }
}

export interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export interface TargetFormat {
  internalFormat: number;
  format: number;
  type: number;
}

/** Pick the best colour-buffer format: half float if renderable, else RGBA8. */
export function pickTargetFormat(gl: WebGL2RenderingContext): { fmt: TargetFormat; hdr: boolean } {
  const hasFloat = gl.getExtension('EXT_color_buffer_float') !== null || gl.getExtension('EXT_color_buffer_half_float') !== null;
  if (hasFloat) {
    const fmt = { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    // Verify completeness; some drivers advertise and still refuse.
    const t = createTarget(gl, 4, 4, fmt);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    deleteTarget(gl, t);
    if (ok) return { fmt, hdr: true };
  }
  return { fmt: { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE }, hdr: false };
}

export function createTarget(gl: WebGL2RenderingContext, width: number, height: number, fmt: TargetFormat): Target {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) throw new GLError('failed to allocate render target');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, width, height, 0, fmt.format, fmt.type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fbo, tex, width, height };
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target): void {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}

/** Upload RGBA float data as a 1-row RGBA16F texture with linear filtering. */
export function createLutTexture(gl: WebGL2RenderingContext, data: Float32Array): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new GLError('failed to allocate LUT');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, data.length / 4, 1, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * GPU frame timing via EXT_disjoint_timer_query_webgl2, when available.
 * Results arrive a few frames late; `poll()` returns the latest in ms.
 */
export class GpuTimer {
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  }

  get available(): boolean {
    return this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll(): number | null {
    if (!this.ext) return null;
    const gl = this.gl;
    let result: number | null = null;
    while (this.pending.length > 0) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint) result = ns / 1e6;
      gl.deleteQuery(q);
      this.pending.shift();
    }
    return result;
  }
}
