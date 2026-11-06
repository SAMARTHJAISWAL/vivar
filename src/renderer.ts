/**
 * Frame pipeline:
 *   1. blackhole.frag → scene target (HDR, at `renderScale` × canvas pixels)
 *   2. bloom: prefiltered 13-tap downsample chain, tent upsample back up
 *   3. composite.frag → canvas (exposure, ACES, sRGB, dither, overlays)
 */
import { buildBlackbodyLUT } from './physics/blackbody';
import { injectConstants } from './physics/constants';
import type { Camera } from './physics/camera';
import type { QualitySettings } from './quality';
import { createLutTexture, createTarget, deleteTarget, GpuTimer, pickTargetFormat, Program, type Target, type TargetFormat } from './gl/gl';
import vertSrc from './shaders/fullscreen.vert?raw';
import sceneSrc from './shaders/blackhole.frag?raw';
import downSrc from './shaders/bloom_down.frag?raw';
import upSrc from './shaders/bloom_up.frag?raw';
import compositeSrc from './shaders/composite.frag?raw';

export interface FrameParams {
  camera: Camera;
  quality: QualitySettings;
  time: number;
  temperature: number;
  exposureEv: number;
  doppler: boolean;
  gravRedshift: boolean;
  lensing: boolean;
  disk: boolean;
  guides: boolean;
  /** NDC x of the split line, or null for no split. */
  split: number | null;
  /** Angular radius of the predicted shadow edge to draw, or null. */
  shadowAngle: number | null;
  debug: boolean;
}

const BLOOM_LEVELS = 6;
const LDR_SCALE = 8;
/** Linear exposure at 0 EV. */
const BASE_EXPOSURE = 0.55;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly hdr: boolean;
  readonly timer: GpuTimer;
  private readonly fmt: TargetFormat;
  private readonly scene: Program;
  private readonly down: Program;
  private readonly up: Program;
  private readonly composite: Program;
  private readonly lut: WebGLTexture;
  private readonly vao: WebGLVertexArrayObject;
  private sceneTarget: Target | null = null;
  private bloom: Target[] = [];
  private canvasW = 1;
  private canvasH = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // lets the share/screenshot code read pixels back
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const picked = pickTargetFormat(gl);
    this.fmt = picked.fmt;
    this.hdr = picked.hdr;
    this.timer = new GpuTimer(gl);
    this.scene = new Program(gl, vertSrc, injectConstants(sceneSrc), 'blackhole');
    this.down = new Program(gl, vertSrc, downSrc, 'bloom_down');
    this.up = new Program(gl, vertSrc, upSrc, 'bloom_up');
    this.composite = new Program(gl, vertSrc, injectConstants(compositeSrc), 'composite');
    this.lut = createLutTexture(gl, buildBlackbodyLUT());
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Resize the canvas backing store and the internal targets. */
  resize(canvasW: number, canvasH: number, renderScale: number): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(canvasW));
    const h = Math.max(1, Math.round(canvasH));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvasW = w;
    this.canvasH = h;
    const sw = Math.max(16, Math.round(w * renderScale));
    const sh = Math.max(16, Math.round(h * renderScale));
    if (this.sceneTarget && this.sceneTarget.width === sw && this.sceneTarget.height === sh) return;
    if (this.sceneTarget) deleteTarget(gl, this.sceneTarget);
    for (const t of this.bloom) deleteTarget(gl, t);
    this.sceneTarget = createTarget(gl, sw, sh, this.fmt);
    this.bloom = [];
    let bw = sw;
    let bh = sh;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      this.bloom.push(createTarget(gl, bw, bh, this.fmt));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get sceneSize(): [number, number] {
    return this.sceneTarget ? [this.sceneTarget.width, this.sceneTarget.height] : [0, 0];
  }

  private bindTarget(t: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.width : this.canvasW, t ? t.height : this.canvasH);
  }

  private draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  render(p: FrameParams): void {
    const gl = this.gl;
    const scene = this.sceneTarget;
    if (!scene) return;
    const cam = p.camera;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.timer.begin();

    // 1. Ray-traced scene.
    this.bindTarget(scene);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    this.scene
      .use()
      .set('u_camPos', cam.pos)
      .set('u_camRight', cam.right)
      .set('u_camUp', cam.up)
      .set('u_camForward', cam.forward)
      .set('u_tan', [cam.tanX, cam.tanY])
      .set('u_time', p.time)
      .set('u_maxSteps', p.quality.maxSteps)
      .set('u_hBase', p.quality.hBase)
      .set('u_eps', p.quality.eps)
      .set('u_octaves', p.quality.octaves)
      .set('u_doppler', p.doppler)
      .set('u_grav', p.gravRedshift)
      .set('u_lensing', p.lensing)
      .set('u_disk', p.disk)
      .set('u_guides', p.guides)
      .set('u_debug', p.debug)
      .set('u_split', p.split ?? 2)
      .set('u_tPeak', p.temperature)
      .set('u_bbLut', 0)
      .set('u_outScale', this.hdr ? 1 : 1 / LDR_SCALE);
    this.draw();

    // 2. Bloom down chain.
    this.down.use().set('u_src', 0).set('u_threshold', 0.9).set('u_knee', 0.6);
    let src: Target = scene;
    for (let i = 0; i < this.bloom.length; i++) {
      const dst = this.bloom[i]!;
      this.bindTarget(dst);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      this.down.set('u_texel', [1 / src.width, 1 / src.height]).set('u_prefilter', i === 0);
      this.draw();
      src = dst;
    }
    // Up chain, additive.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.up.use().set('u_src', 0).set('u_radius', 1.0);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const from = this.bloom[i]!;
      const to = this.bloom[i - 1]!;
      this.bindTarget(to);
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      this.up.set('u_texel', [1 / from.width, 1 / from.height]).set('u_weight', 0.85);
      this.draw();
    }
    gl.disable(gl.BLEND);

    // 3. Composite to the canvas.
    this.bindTarget(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom[0]!.tex);
    this.composite
      .use()
      .set('u_scene', 0)
      .set('u_bloom', 1)
      .set('u_exposure', Math.pow(2, p.exposureEv) * BASE_EXPOSURE)
      .set('u_bloomStrength', p.debug ? 0 : 0.09)
      .set('u_sceneScale', this.hdr ? 1 : LDR_SCALE)
      .set('u_resolution', [this.canvasW, this.canvasH])
      .set('u_camForward', cam.forward)
      .set('u_camRight', cam.right)
      .set('u_camUp', cam.up)
      .set('u_tan', [cam.tanX, cam.tanY])
      .set('u_shadowAngle', p.shadowAngle ?? -1)
      .set('u_split', p.split ?? 2)
      .set('u_time', p.time);
    this.draw();
    gl.activeTexture(gl.TEXTURE0);
    this.timer.end();
  }
}
