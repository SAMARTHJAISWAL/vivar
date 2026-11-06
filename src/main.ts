import './style.css';
import { AdaptiveScale } from './adaptive';
import { locateFeatures, type FeatureId } from './annotations';
import { makeCamera, shadowAngularRadius, type Camera } from './physics/camera';
import { CAM_DIST_MAX, CAM_DIST_MIN, GALAXY_DIR, TIME_SCALE } from './physics/constants';
import { QUALITY_SETTINGS } from './quality';
import { Renderer, type FrameParams } from './renderer';
import {
  decodeDisplay,
  decodeState,
  defaultState,
  encodeState,
  INCLINATION_MAX,
  INCLINATION_MIN,
  wrapDegrees,
  type Quality,
  type ViewState,
} from './state';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const display = decodeDisplay(location.hash);
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const base = defaultState(reducedMotion);
// Phones and tablets start at medium quality; the adaptive scaler does the rest.
if (coarsePointer) base.quality = 'medium';
let state: ViewState = decodeState(location.hash, base);
if (display.hideUi) document.body.classList.add('no-ui');

const canvas = $<HTMLCanvasElement>('view');

function showFallback(reason: string): void {
  console.warn(`vivar: ${reason}`);
  $('fallback').hidden = false;
  canvas.style.display = 'none';
  for (const id of ['panel', 'hud']) $(id).hidden = true;
}

let renderer: Renderer | null = null;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  showFallback(err instanceof Error ? err.message : String(err));
}

if (renderer) start(renderer);

function start(renderer: Renderer): void {
  const clampInc = (x: number) => Math.min(INCLINATION_MAX, Math.max(INCLINATION_MIN, x));
  const clampDist = (x: number) => Math.min(CAM_DIST_MAX, Math.max(CAM_DIST_MIN, x));

  let quality = QUALITY_SETTINGS[state.quality];
  const adaptive = new AdaptiveScale({ min: quality.minScale, max: quality.maxScale, initial: quality.maxScale * 0.85 });

  let diskTime = 40;
  let lastFrame = performance.now();
  let raf = 0;
  let dirty = true;
  let dragging = false;
  /** Fixed render scale for captures and benchmarks; null = adaptive. */
  let lockedScale: number | null = null;
  let fly: { t0: number; dur: number; from: [number, number, number]; to: [number, number, number] } | null = null;

  // Stats exposed for the HUD and for automated checks.
  const stats = { fps: 0, frameMs: 16.7, gpuMs: null as number | null, scale: adaptive.scale, sceneW: 0, sceneH: 0, frames: 0, hdr: renderer.hdr };

  // ------------------------------------------------------------ state → UI

  const toggles = ['lensing', 'compare', 'doppler', 'gravRedshift', 'disk', 'animate', 'guides', 'autoOrbit'] as const;
  const sliders = {
    inclination: { fmt: (v: number) => `${v.toFixed(1)}°` },
    distance: { fmt: (v: number) => `${v.toFixed(1)} r<sub>s</sub>` },
    temperature: { fmt: (v: number) => `${Math.round(v).toLocaleString('en-US')} K` },
    exposure: { fmt: (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} EV` },
  } as const;
  type SliderKey = keyof typeof sliders;

  function syncUi(): void {
    for (const k of toggles) $<HTMLInputElement>(k).checked = state[k];
    for (const k of Object.keys(sliders) as SliderKey[]) {
      const input = $<HTMLInputElement>(k);
      input.value = String(state[k]);
      const lo = Number(input.min);
      const hi = Number(input.max);
      input.style.setProperty('--fill', `${((state[k] - lo) / (hi - lo)) * 100}%`);
      $(`out-${k}`).innerHTML = sliders[k].fmt(state[k]);
    }
    for (const r of document.querySelectorAll<HTMLInputElement>('input[name="quality"]')) r.checked = r.value === state.quality;
  }

  let hashTimer = 0;
  function changed(opts: { ui?: boolean } = {}): void {
    dirty = true;
    if (opts.ui !== false) syncUi();
    window.clearTimeout(hashTimer);
    hashTimer = window.setTimeout(() => history.replaceState(null, '', encodeState(state) + displaySuffix()), 250);
    scheduleFeatures();
  }

  function displaySuffix(): string {
    return (display.hideUi ? '&ui=0' : '') + (display.debug ? '&debug=1' : '');
  }

  function setQuality(q: Quality): void {
    state.quality = q;
    quality = QUALITY_SETTINGS[q];
    adaptive.setBounds(quality.minScale, quality.maxScale);
  }

  // ------------------------------------------------------------ UI → state

  for (const k of toggles) {
    $<HTMLInputElement>(k).addEventListener('change', (e) => {
      state[k] = (e.target as HTMLInputElement).checked;
      if (k === 'autoOrbit' && state.autoOrbit) fly = null;
      changed();
    });
  }
  for (const k of Object.keys(sliders) as SliderKey[]) {
    $<HTMLInputElement>(k).addEventListener('input', (e) => {
      state[k] = Number((e.target as HTMLInputElement).value);
      if (k === 'inclination' || k === 'distance') fly = null;
      changed();
    });
  }
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="quality"]')) {
    r.addEventListener('change', () => {
      if (r.checked) {
        setQuality(r.value as Quality);
        changed();
      }
    });
  }

  const presets: Record<string, () => void> = {
    default: () => Object.assign(state, { azimuth: 30, inclination: 84, distance: 24 }),
    edge: () => Object.assign(state, { inclination: 88.5, distance: 24 }),
    face: () => Object.assign(state, { inclination: 4, distance: 24 }),
    einstein: () => {
      // Put the background galaxy directly behind the hole.
      const [x, y, z] = GALAXY_DIR;
      Object.assign(state, {
        azimuth: wrapDegrees((Math.atan2(-z, -x) * 180) / Math.PI),
        inclination: clampInc((Math.acos(-y) * 180) / Math.PI),
        distance: 22,
        autoOrbit: false,
      });
    },
    flyin: () => {
      const az = state.azimuth;
      fly = {
        t0: performance.now(),
        dur: reducedMotion ? 1 : 14000,
        from: [az - 70, 62, 60],
        to: [az + 25, 84.5, 12.5],
      };
      state.autoOrbit = false;
    },
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    b.addEventListener('click', () => {
      const p = b.dataset.preset ?? 'default';
      if (p !== 'flyin') fly = null;
      presets[p]?.();
      changed();
    });
  }

  // Panel collapse (collapsed by default on small screens).
  const panelToggle = $<HTMLButtonElement>('panel-toggle');
  const panelBody = $('panel-body');
  const setPanel = (open: boolean) => {
    panelToggle.setAttribute('aria-expanded', String(open));
    panelBody.hidden = !open;
  };
  setPanel(window.innerWidth > 720);
  panelToggle.addEventListener('click', () => setPanel(panelBody.hidden));

  // Share.
  const toast = $('toast');
  let toastTimer = 0;
  function say(msg: string): void {
    toast.textContent = msg;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1800);
  }
  $('share').addEventListener('click', () => {
    history.replaceState(null, '', encodeState(state) + displaySuffix());
    const url = location.href;
    navigator.clipboard?.writeText(url).then(
      () => say('Link copied'),
      () => say('The address bar now holds a shareable link'),
    ) ?? say('The address bar now holds a shareable link');
  });

  window.addEventListener('hashchange', () => {
    state = decodeState(location.hash, state);
    setQuality(state.quality);
    fly = null;
    changed();
  });

  // ------------------------------------------------------------ explainer

  const explainer = $('explainer');
  const markers = $('markers');
  const order: FeatureId[] = ['shadow', 'ring', 'over', 'under', 'doppler', 'isco'];
  let featureTimer = 0;

  function placeMarkers(): void {
    markers.replaceChildren();
    if (explainer.hidden) return;
    const cam = makeCamera(state.azimuth, state.inclination, state.distance, window.innerWidth / window.innerHeight);
    const pos = locateFeatures(cam, state.lensing && !state.compare);
    order.forEach((id, i) => {
      const p = pos[id];
      const li = explainer.querySelector<HTMLElement>(`li[data-feature="${id}"]`);
      if (li) li.style.opacity = p || id === 'shadow' ? '1' : '0.55';
      if (!p || Math.abs(p[0]) > 0.98 || Math.abs(p[1]) > 0.98) return;
      if (id === 'doppler' && !state.disk) return;
      if ((id === 'over' || id === 'under' || id === 'isco') && !state.disk) return;
      const m = document.createElement('div');
      m.className = 'marker';
      m.textContent = String(i + 1);
      m.style.left = `${(p[0] * 0.5 + 0.5) * window.innerWidth}px`;
      m.style.top = `${(0.5 - p[1] * 0.5) * window.innerHeight}px`;
      markers.appendChild(m);
    });
  }
  function scheduleFeatures(): void {
    if (explainer.hidden) return;
    window.clearTimeout(featureTimer);
    featureTimer = window.setTimeout(placeMarkers, 160);
  }
  const explainBtn = $<HTMLButtonElement>('explain');
  function setExplainer(open: boolean): void {
    explainer.hidden = !open;
    explainBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      placeMarkers();
      $('explainer-close').focus();
    } else {
      markers.replaceChildren();
    }
  }
  explainBtn.addEventListener('click', () => setExplainer(explainer.hidden));
  $('explainer-close').addEventListener('click', () => {
    setExplainer(false);
    explainBtn.focus();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !explainer.hidden) setExplainer(false);
  });
  window.addEventListener('resize', () => {
    dirty = true;
    scheduleFeatures();
  });

  // ------------------------------------------------------------ camera input

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = true;
    fly = null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      const k = 180 / Math.max(window.innerHeight, 400);
      state.azimuth = wrapDegrees(state.azimuth + (cur.x - prev.x) * k);
      state.inclination = clampInc(state.inclination - (cur.y - prev.y) * k * 0.8);
      changed();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDist > 0 && d > 0) state.distance = clampDist(state.distance * (pinchDist / d));
      pinchDist = d;
      changed();
    }
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) dragging = false;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      fly = null;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      state.distance = clampDist(state.distance * Math.exp(dy * 0.0012));
      changed();
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 3;
    let used = true;
    if (e.key === 'ArrowLeft') state.azimuth = wrapDegrees(state.azimuth - step);
    else if (e.key === 'ArrowRight') state.azimuth = wrapDegrees(state.azimuth + step);
    else if (e.key === 'ArrowUp') state.inclination = clampInc(state.inclination - step);
    else if (e.key === 'ArrowDown') state.inclination = clampInc(state.inclination + step);
    else if (e.key === '+' || e.key === '=') state.distance = clampDist(state.distance / 1.1);
    else if (e.key === '-' || e.key === '_') state.distance = clampDist(state.distance * 1.1);
    else used = false;
    if (used) {
      e.preventDefault();
      fly = null;
      changed();
    }
  });

  // ------------------------------------------------------------ frame loop

  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const hud = $('fps');
  let hudTime = 0;
  let fpsFrames = 0;
  let fpsT0 = performance.now();

  function frameParams(camera: Camera): FrameParams {
    return {
      camera,
      quality,
      time: diskTime,
      temperature: state.temperature,
      exposureEv: state.exposure,
      doppler: state.doppler,
      gravRedshift: state.gravRedshift,
      lensing: state.lensing,
      disk: state.disk,
      guides: state.guides,
      split: state.compare && state.lensing ? 0 : null,
      shadowAngle: state.guides ? (state.lensing ? shadowAngularRadius(state.distance) : Math.asin(1 / state.distance)) : null,
      debug: display.debug,
    };
  }

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const frameMs = now - lastFrame;
    const dt = Math.min(0.1, frameMs / 1000);
    lastFrame = now;

    let uiChanged = false;
    if (state.animate) {
      diskTime += dt * TIME_SCALE;
      dirty = true;
    }
    if (state.autoOrbit && !dragging) {
      state.azimuth = wrapDegrees(state.azimuth + 4 * dt);
      uiChanged = true;
    }
    if (fly) {
      const t = Math.min(1, (now - fly.t0) / fly.dur);
      const e = ease(t);
      state.azimuth = wrapDegrees(fly.from[0] + (fly.to[0] - fly.from[0]) * e);
      state.inclination = fly.from[1] + (fly.to[1] - fly.from[1]) * e;
      state.distance = Math.exp(Math.log(fly.from[2]) + (Math.log(fly.to[2]) - Math.log(fly.from[2])) * e);
      if (t >= 1) fly = null;
      uiChanged = true;
    }
    if (uiChanged) changed();

    const gpuMs = renderer.timer.poll();
    if (gpuMs !== null) stats.gpuMs = gpuMs;
    if (!dirty) return;

    const dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr);
    const cw = Math.round(window.innerWidth * dpr);
    const ch = Math.round(window.innerHeight * dpr);
    // Only feed the controller frames that were actually rendered back to back.
    const scale = lockedScale ?? (frameMs < 250 ? adaptive.update(frameMs, now) : adaptive.scale);
    renderer.resize(cw, ch, scale);
    const camera = makeCamera(state.azimuth, state.inclination, state.distance, cw / ch);
    renderer.render(frameParams(camera));
    dirty = false;

    stats.frames++;
    fpsFrames++;
    stats.frameMs = frameMs;
    stats.scale = scale;
    [stats.sceneW, stats.sceneH] = renderer.sceneSize;
    if (now - fpsT0 > 500) {
      stats.fps = (fpsFrames * 1000) / (now - fpsT0);
      fpsFrames = 0;
      fpsT0 = now;
    }
    if (now - hudTime > 500) {
      hudTime = now;
      const gpu = stats.gpuMs !== null ? ` · gpu ${stats.gpuMs.toFixed(1)} ms` : '';
      hud.textContent = `${stats.fps.toFixed(0)} fps · ${stats.sceneW}×${stats.sceneH} (${(scale * 100).toFixed(0)}%) · ${quality.maxSteps} steps${gpu}`;
    }
  }

  function resume(): void {
    cancelAnimationFrame(raf);
    lastFrame = performance.now();
    adaptive.warmUp(lastFrame);
    fpsT0 = lastFrame;
    fpsFrames = 0;
    dirty = true;
    raf = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else resume();
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    say('Graphics context lost; reloading…');
  });
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  // Hook for automated checks (tests/e2e and the screenshot script).
  Object.assign(window, {
    __vivar: {
      get state() {
        return { ...state };
      },
      stats,
      set(partial: Partial<ViewState>) {
        Object.assign(state, partial);
        if (partial.quality) setQuality(partial.quality);
        fly = null;
        changed();
      },
      setTime(t: number) {
        diskTime = t;
        dirty = true;
      },
      redraw() {
        dirty = true;
      },
      /**
       * Render `n` frames back to back at the current size, outside the
       * display's vsync, and return the mean milliseconds per frame. A 1-pixel
       * readback after the loop waits for the GPU to finish.
       */
      bench(n = 30): number {
        const gl = renderer.gl;
        const camera = makeCamera(state.azimuth, state.inclination, state.distance, canvas.width / canvas.height);
        const px = new Uint8Array(4);
        renderer.render(frameParams(camera));
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          diskTime += 0.1;
          renderer.render(frameParams(camera));
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return (performance.now() - t0) / n;
      },
      lockScale(s: number | null) {
        lockedScale = s;
        dirty = true;
      },
    },
  });

  setQuality(state.quality);
  syncUi();
  resume();
}
