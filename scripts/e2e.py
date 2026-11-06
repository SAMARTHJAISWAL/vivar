"""End-to-end checks of a running build with Playwright's Chromium.

    npm run build:pages
    mkdir -p /tmp/site && cp -r dist /tmp/site/vivar
    (cd /tmp/site && python -m http.server 8765) &
    python scripts/e2e.py http://localhost:8765/vivar/

Checks: no console errors, non-blank canvas, animation, every control changes
the image, URL-hash round trip, mobile viewport, the explainer overlay, the
shadow radius against b_c, portrait framing, the spinning (Kerr) shadow against
Bardeen's analytic curve, the HUD and first-visit hint, frame rate with the
adaptive scaler, and a small frame-time benchmark.
Requires `pip install playwright && playwright install chromium`.
"""

import json
import math
import sys
import time

from playwright.sync_api import Page, sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/vivar/'
SWIFTSHADER = '--swiftshader' in sys.argv
ARGS = (
    ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    if SWIFTSHADER
    else ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
)
SETTLE = 4.0 if SWIFTSHADER else 0.6

SIGNATURE_JS = """() => {
  const src = document.getElementById('view');
  const c = document.createElement('canvas');
  c.width = 96; c.height = 54;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = [];
  for (let i = 0; i < d.length; i += 4) out.push((d[i] + d[i + 1] + d[i + 2]) / 3);
  return out;
}"""

# Debug-view row scan: for each canvas row, the leftmost and rightmost pixel of
# the shadow (captured = red; rays that ran out of steps = magenta count too),
# plus the extent of disk pixels (blue = absorbed, cyan = crossed the disk).
ROWS_JS = """() => {
  const src = document.getElementById('view');
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
  const W = c.width, H = c.height, d = ctx.getImageData(0, 0, W, H).data;
  const rows = [];
  let diskL = W, diskR = -1, sx = 0, sy = 0, sn = 0;
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) {
      const i = 4 * (y * W + x);
      const R = d[i], G = d[i + 1], B = d[i + 2];
      if (R > 128 && G < 64) {
        if (l < 0) l = x;
        r = x;
        if (B < 64) { sx += x + 0.5; sy += y + 0.5; sn++; }
      }
      if (B > 128 && R < 64) { diskL = Math.min(diskL, x); diskR = Math.max(diskR, x); }
    }
    rows.push([l, r]);
  }
  return { W, H, rows, diskL, diskR, cx: sx / Math.max(sn, 1), cy: sy / Math.max(sn, 1) };
}"""

# Mean luminance of the leftmost / rightmost columns over the middle third of the canvas.
EDGE_JS = """(frac) => {
  const src = document.getElementById('view');
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
  const W = c.width, H = c.height, d = ctx.getImageData(0, 0, W, H).data;
  const n = Math.max(2, Math.round(W * frac));
  const band = (x0) => {
    let s = 0, k = 0;
    for (let y = Math.round(H / 3); y < Math.round(2 * H / 3); y++)
      for (let x = x0; x < x0 + n; x++) { const i = 4 * (y * W + x); s += (d[i] + d[i + 1] + d[i + 2]) / 3; k++; }
    return s / k;
  };
  return { left: band(0), right: band(W - n), W, H };
}"""


def framing(aspect: float) -> tuple[float, float]:
    """Same as framing() in src/physics/camera.ts: 52° vertical FOV, at least 37.5° horizontal half-angle."""
    tan_x = max(math.tan(math.radians(26)) * aspect, math.tan(math.radians(37.5)))
    return tan_x, tan_x / aspect


def kerr_shadow(chi: float, r: float, theta: float, n: int = 1500) -> list[tuple[float, float]]:
    """Shadow edge of a Kerr hole seen by a static observer at Boyer-Lindquist (r, theta),
    as tangent-plane screen coordinates (x right, y up). Units r_s = 1, M = 1/2.

    Written independently of the TypeScript: the edge is made of rays with the constants of
    the spherical photon orbits (Bardeen 1973), xi = L/E and eta = Q/E^2 at radius rp, and the
    observer measures their direction in its static frame (e_r, e_theta, e_phi). The disk and
    the hole rotate towards +phi, which is screen right; screen up is -e_theta."""
    M = 0.5
    a = chi * M
    rpro = 2 * M * (1 + math.cos(2 / 3 * math.acos(-chi)))
    rret = 2 * M * (1 + math.cos(2 / 3 * math.acos(chi)))
    c, s = math.cos(theta), math.sin(theta)
    rho2 = r * r + a * a * c * c
    delta = r * r - 2 * M * r + a * a
    gtt = -(1 - 2 * M * r / rho2)
    gtp = -2 * M * a * r * s * s / rho2
    gpp = ((r * r + a * a) ** 2 - a * a * delta * s * s) * s * s / rho2
    upper = []
    for i in range(n + 1):
        rp = rpro + (rret - rpro) * i / n
        xi = -(rp ** 3 - 3 * M * rp ** 2 + a * a * rp + a * a * M) / (a * (rp - M))
        eta = rp ** 3 * (4 * a * a * M - rp * (rp - 3 * M) ** 2) / (a * a * (rp - M) ** 2)
        R = (r * r + a * a - a * xi) ** 2 - delta * (eta + (xi - a) ** 2)
        Th = eta + a * a * c * c - xi * xi * c * c / (s * s)
        if R < 0 or Th < 0:
            continue
        p_r = math.sqrt(R) / math.sqrt(rho2 * delta)
        p_th = math.sqrt(Th) / math.sqrt(rho2)
        p_ph = (xi + gtp / gtt) / math.sqrt(gpp - gtp * gtp / gtt)
        # Arriving photon moves along +e_r; the camera looks the other way (forward = -e_r).
        upper.append((-p_ph / p_r, p_th / p_r))
    return upper + [(x, -y) for x, y in reversed(upper)]


def distance_to_curve(curve_px: list[tuple[float, float]], px: float, py: float) -> float:
    """Shortest distance from (px, py) to the closed polyline."""
    best = math.inf
    for (x0, y0), (x1, y1) in zip(curve_px, curve_px[1:] + curve_px[:1]):
        dx, dy = x1 - x0, y1 - y0
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(px - x0 - t * dx, py - y0 - t * dy))
    return best


def curve_extent_at(curve_px: list[tuple[float, float]], y: float) -> tuple[float, float] | None:
    """Leftmost and rightmost x where the closed polyline crosses the horizontal line y."""
    xs = []
    for (x0, y0), (x1, y1) in zip(curve_px, curve_px[1:] + curve_px[:1]):
        if (y0 - y) * (y1 - y) <= 0 and y0 != y1:
            xs.append(x0 + (x1 - x0) * (y - y0) / (y1 - y0))
    return (min(xs), max(xs)) if xs else None


results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")


def sig(page: Page) -> list[float]:
    return page.evaluate(SIGNATURE_JS)


def diff(a: list[float], b: list[float]) -> float:
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def wait_frame(page: Page) -> None:
    """Let pending changes land, then force one more frame and wait for it."""
    time.sleep(0.05)
    n = page.evaluate('window.__vivar.stats.frames')
    page.evaluate('window.__vivar.redraw()')
    page.wait_for_function(f'window.__vivar.stats.frames > {n}', timeout=30000)
    time.sleep(SETTLE)


def open_page(browser, url: str, **ctx):
    context = browser.new_context(**ctx)
    page = context.new_page()
    errors: list[str] = []
    page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.goto(url)
    page.wait_for_function('window.__vivar && window.__vivar.stats.frames > 0', timeout=60000)
    time.sleep(SETTLE)
    return context, page, errors


def reload_at(page: Page, url: str) -> None:
    """Load `url` as a fresh document (a hash-only change would not reload, and display
    options such as ui=0 and debug=1 are read once at load)."""
    page.goto('about:blank')
    page.goto(url)
    page.wait_for_function('window.__vivar && window.__vivar.stats.frames > 0', timeout=60000)
    time.sleep(SETTLE)


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')

        # ---------------------------------------------------------- desktop
        ctx, page, errors = open_page(browser, BASE, viewport={'width': 1280, 'height': 720})
        info = page.evaluate("""() => {
          const gl = document.createElement('canvas').getContext('webgl2');
          const e = gl.getExtension('WEBGL_debug_renderer_info');
          return gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
        }""")
        print('renderer:', info)
        s0 = sig(page)
        mean = sum(s0) / len(s0)
        var = sum((x - mean) ** 2 for x in s0) / len(s0)
        lit = sum(1 for x in s0 if x > 40) / len(s0)
        check('canvas is not blank', var > 100 and lit > 0.05, f'mean={mean:.1f} std={math.sqrt(var):.1f} lit={lit:.2f}')

        time.sleep(1.5)
        s1 = sig(page)
        check('image changes over time (disk animation)', diff(s0, s1) > 0.05, f'diff={diff(s0, s1):.3f}')

        # Freeze time so every comparison below isolates one control.
        page.evaluate("window.__vivar.set({ animate: false }); window.__vivar.setTime(100); window.__vivar.lockScale(1)")
        wait_frame(page)
        base_sig = sig(page)

        toggles = ['lensing', 'compare', 'doppler', 'gravRedshift', 'disk', 'guides']
        for t in toggles:
            page.click(f'label:has(#{t})')
            wait_frame(page)
            d = diff(base_sig, sig(page))
            check(f'toggle {t} changes the image', d > 0.05, f'diff={d:.2f}')
            page.click(f'label:has(#{t})')
            wait_frame(page)
        back = diff(base_sig, sig(page))
        check('toggling everything back restores the image', back < 0.05, f'diff={back:.3f}')

        # Animate and auto-orbit change the image over time.
        for t in ['animate', 'autoOrbit']:
            page.click(f'label:has(#{t})')
            a = sig(page)
            time.sleep(1.2)
            d = diff(a, sig(page))
            check(f'toggle {t} makes the image change over time', d > 0.05, f'diff={d:.3f}')
            page.click(f'label:has(#{t})')
        page.evaluate("window.__vivar.set({ azimuth: 30, animate: false }); window.__vivar.setTime(100)")
        wait_frame(page)
        base_sig = sig(page)

        sliders = {'inclination': '60', 'distance': '14', 'spin': '0.9', 'temperature': '12000', 'exposure': '1.5'}
        for sid, value in sliders.items():
            old = page.eval_on_selector(f'#{sid}', 'e => e.value')
            page.eval_on_selector(f'#{sid}', f"e => {{ e.value = '{value}'; e.dispatchEvent(new Event('input', {{ bubbles: true }})); }}")
            wait_frame(page)
            d = diff(base_sig, sig(page))
            check(f'slider {sid} changes the image', d > 0.2, f'diff={d:.2f}')
            page.eval_on_selector(f'#{sid}', f"e => {{ e.value = '{old}'; e.dispatchEvent(new Event('input', {{ bubbles: true }})); }}")
            wait_frame(page)

        page.evaluate('window.__vivar.lockScale(1)')
        wait_frame(page)
        hi = sig(page)
        page.click('label:has(input[value="low"])')
        page.evaluate('window.__vivar.lockScale(0.45)')
        wait_frame(page)
        d = diff(hi, sig(page))
        check('quality selector changes the image', d > 0.05, f'diff={d:.3f}')
        page.click('label:has(input[value="high"])')
        page.evaluate('window.__vivar.lockScale(1)')

        # Presets.
        for preset in ['edge', 'face', 'einstein', 'spinning', 'default']:
            before = sig(page)
            page.click(f'[data-preset="{preset}"]')
            wait_frame(page)
            d = diff(before, sig(page))
            check(f'preset {preset} changes the view', d > 0.2, f'diff={d:.2f}')
        page.click('[data-preset="flyin"]')
        time.sleep(1.0)
        st = page.evaluate('window.__vivar.state')
        check('fly-in preset moves the camera', st['distance'] > 30, f"distance={st['distance']:.1f}")

        # Hash round trip.
        page.evaluate("window.__vivar.set({ azimuth: 77, inclination: 63, distance: 19.5, spin: 0.75, temperature: 8000, exposure: -0.5, doppler: false, guides: true, animate: false, quality: 'medium' })")
        time.sleep(0.6)
        h = page.evaluate('location.hash')
        state_a = page.evaluate('window.__vivar.state')
        ctx2, page2, errors2 = open_page(browser, BASE + h, viewport={'width': 1280, 'height': 720})
        state_b = page2.evaluate('window.__vivar.state')
        check('URL hash round trip restores the state (spin included)', state_a == state_b and state_b['spin'] == 0.75 and 'spin=0.750' in h, h)
        page.evaluate('window.__vivar.setTime(5); window.__vivar.lockScale(1)')
        page2.evaluate('window.__vivar.setTime(5); window.__vivar.lockScale(1)')
        wait_frame(page)
        wait_frame(page2)
        d = diff(sig(page), sig(page2))
        check('...and the same image', d < 0.5, f'diff={d:.3f}')
        errors += errors2
        ctx2.close()

        # Explainer overlay.
        page.click('#explain')
        time.sleep(0.6)
        vis = page.is_visible('#explainer')
        markers = page.eval_on_selector_all('#markers .marker', 'm => m.length')
        check('explainer opens with numbered markers', vis and markers >= 4, f'markers={markers}')
        page.keyboard.press('Escape')
        time.sleep(0.2)
        check('explainer closes with Escape', not page.is_visible('#explainer'))
        page.click('#explain')
        page.click('#explainer-close')
        time.sleep(0.2)
        check('explainer closes with its button', not page.is_visible('#explainer') and page.eval_on_selector_all('#markers .marker', 'm => m.length') == 0)

        # Spin-dependent explainer text and markers.
        page.evaluate("window.__vivar.set({ spin: 0.99, azimuth: 30, inclination: 82, distance: 22, quality: 'high' })")
        page.click('#explain')
        time.sleep(0.8)
        shadow_text = page.inner_text('#explainer li[data-feature="shadow"]')
        markers = page.eval_on_selector_all('#markers .marker', 'm => m.length')
        tag = page.inner_text('#tag')
        check('explainer explains the spinning hole when a > 0', 'D-shaped' in shadow_text and 'frame dragging' in shadow_text and 'Kerr' in tag and markers >= 4, f'markers={markers} tag={tag!r}')
        page.click('#explainer-close')

        # Guides draw the analytic Kerr shadow edge (and the horizon / ISCO circles).
        page.evaluate("window.__vivar.set({ guides: false })")
        wait_frame(page)
        g0 = sig(page)
        page.evaluate("window.__vivar.set({ guides: true })")
        wait_frame(page)
        d = diff(g0, sig(page))
        check('guides change the image with spin (Kerr shadow curve, horizon, ISCO)', d > 0.05, f'diff={d:.3f}')
        page.evaluate("window.__vivar.set({ guides: false, spin: 0 })")

        # HUD: compact frame rate, details on hover; never the stale placeholder.
        page.evaluate("window.__vivar.set({ animate: true })")
        time.sleep(1.2)
        compact = page.inner_text('#hud')
        page.hover('#hud')
        time.sleep(0.1)
        detailed = page.inner_text('#hud')
        page.mouse.move(640, 360)
        check('HUD shows a compact fps, details on hover', compact.endswith('fps') and '×' not in compact and '×' in detailed and 'steps' in detailed, f'{compact!r} / {detailed!r}')

        check('no console errors (desktop)', not errors, json.dumps(errors[:5]))
        ctx.close()

        # ---------------------------------------------------------- HUD when idle, first-visit hint
        ctx, page, errors = open_page(browser, BASE + '#anim=0', viewport={'width': 1440, 'height': 860})
        time.sleep(0.3)
        hint_on = page.is_visible('#hint') and page.inner_text('#hint').startswith('drag to orbit')
        time.sleep(1.5)
        hud = page.inner_text('#hud')
        check('HUD never shows a stray placeholder (idle renderer shows "idle")', hud.strip() in ('idle',) or hud.endswith('fps'), repr(hud))
        time.sleep(5)
        hint_gone = not page.is_visible('#hint')
        page.reload()
        page.wait_for_function('window.__vivar && window.__vivar.stats.frames > 0', timeout=60000)
        time.sleep(1.0)
        check('first-visit hint shows once, then fades and stays away', hint_on and hint_gone and not page.is_visible('#hint'))
        check('no console errors (hint)', not errors, json.dumps(errors[:5]))
        ctx.close()

        # ---------------------------------------------------------- shadow radius
        ctx, page, errors = open_page(browser, BASE + '#az=30&inc=84&r=24&fx=lens&anim=0&q=ultra&debug=1&ui=0', viewport={'width': 1280, 'height': 720})
        page.evaluate('window.__vivar.lockScale(1)')
        wait_frame(page)
        radii = page.evaluate("""() => {
          const src = document.getElementById('view');
          const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
          const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
          const W = c.width, H = c.height, d = ctx.getImageData(0, 0, W, H).data;
          const red = (x, y) => { const i = 4 * (y * W + x); return d[i] > 128 && d[i + 1] < 64 && d[i + 2] < 64; };
          const cx = W / 2, cy = H / 2;
          const out = [];
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * 2 * Math.PI;
            let r = 0;
            while (red(Math.round(cx + (r + 1) * Math.cos(a) - 0.5), Math.round(cy - (r + 1) * Math.sin(a) - 0.5))) r++;
            out.push(r + 0.5);
          }
          return { out, H };
        }""")
        dist = 24.0
        bc = 3 * math.sqrt(3) / 2
        alpha = math.asin(bc / dist * math.sqrt(1 - 1 / dist))
        # NDC y = tan(angle) / tanY, and tanY comes from the same framing rule as the app.
        pred = math.tan(alpha) / framing(1280 / 720)[1] * radii['H'] / 2
        meas = sum(radii['out']) / len(radii['out'])
        spread = max(radii['out']) - min(radii['out'])
        check('shadow radius matches b_c', abs(meas - pred) < 1.5 and spread <= 2, f'measured {meas:.2f}px (spread {spread:.1f}) vs predicted {pred:.2f}px')
        check('no console errors (debug view)', not errors, json.dumps(errors[:5]))
        ctx.close()

        # ---------------------------------------------------------- portrait framing
        for (vw, vh, dpr) in [(390, 844, 3), (784, 1666, 1)]:
            mobile = vw < 500
            extra = {'device_scale_factor': dpr, 'is_mobile': mobile, 'has_touch': mobile}
            # Debug view without the disk: the shadow, centred, with the radius the framing predicts.
            ctx, page, errors = open_page(browser, BASE + '#az=30&inc=84&r=24&anim=0&q=high&fx=lens&debug=1&ui=0', viewport={'width': vw, 'height': vh}, **extra)
            page.evaluate('window.__vivar.lockScale(1)')
            wait_frame(page)
            rr = page.evaluate(ROWS_JS)
            W, H = rr['W'], rr['H']
            ys = [y for y, (l, r) in enumerate(rr['rows']) if l >= 0]
            check(f'{vw}x{vh}: shadow is centred', abs(rr['cx'] - W / 2) < 1.5 and abs((ys[0] + ys[-1] + 1) / 2 - H / 2) < 1.5,
                  f'centre ({rr["cx"]:.1f}, {(ys[0] + ys[-1] + 1) / 2:.1f}) vs ({W / 2}, {H / 2})')
            tan_x, tan_y = framing(vw / vh)
            pred = math.tan(alpha) / tan_x * W / 2
            row = rr['rows'][H // 2]
            meas = (row[1] - row[0] + 1) / 2
            check(f'{vw}x{vh}: shadow radius matches the portrait field of view', abs(meas - pred) < 1.5, f'measured {meas:.1f}px vs predicted {pred:.1f}px')
            # Debug view with the disk: every ray that lands on it (out to its 14 r_s edge) is inside the frame.
            reload_at(page, BASE + '#az=30&inc=84&r=24&anim=0&q=high&fx=lens,disk&debug=1&ui=0')
            page.evaluate('window.__vivar.lockScale(1)')
            wait_frame(page)
            rr = page.evaluate(ROWS_JS)
            margin_l, margin_r = rr['diskL'] / W, (W - 1 - rr['diskR']) / W
            check(f'{vw}x{vh}: the whole disk fits across the screen', margin_l > 0.02 and margin_r > 0.02 and rr['diskR'] > rr['diskL'],
                  f'disk spans x {rr["diskL"]}..{rr["diskR"]} of {W} (margins {margin_l:.1%}, {margin_r:.1%})')
            # The same view rendered normally: no bright disk pixels in the edge columns.
            reload_at(page, BASE + '#az=30&inc=84&r=24&anim=0&q=high&ui=0')
            page.evaluate('window.__vivar.lockScale(1); window.__vivar.setTime(100)')
            wait_frame(page)
            e = page.evaluate(EDGE_JS, 0.02)
            check(f'{vw}x{vh}: the disk does not touch the side edges', e['left'] < 20 and e['right'] < 20, f"edge luminance {e['left']:.1f} / {e['right']:.1f}")
            # Explainer markers on screen, the shadow label on the shadow's vertical axis.
            reload_at(page, BASE + '#az=30&inc=84&r=24&anim=0&q=high')
            if mobile:
                page.tap('#panel-toggle')
            page.click('#explain')
            time.sleep(0.8)
            ms = page.eval_on_selector_all('#markers .marker', 'm => m.map(e => [e.textContent, parseFloat(e.style.left), parseFloat(e.style.top)])')
            inside = all(0 <= x <= vw and 0 <= y <= vh for _, x, y in ms)
            shadow_m = next(((x, y) for t, x, y in ms if t == '1'), None)
            ok = len(ms) >= 4 and inside and shadow_m is not None and abs(shadow_m[0] - vw / 2) < 2 and shadow_m[1] < vh / 2
            check(f'{vw}x{vh}: explainer markers are on screen and the shadow marker sits on the shadow', ok, json.dumps(ms))
            check(f'no console errors ({vw}x{vh})', not errors, json.dumps(errors[:5]))
            ctx.close()

        # ---------------------------------------------------------- Kerr shadow vs Bardeen
        for inc in [90.0, 60.0]:
            ctx, page, errors = open_page(browser, BASE + f'#az=30&inc={inc}&r=24&spin=0.99&fx=lens&anim=0&q=ultra&debug=1&ui=0', viewport={'width': 1280, 'height': 720})
            page.evaluate('window.__vivar.lockScale(1)')
            wait_frame(page)
            rr = page.evaluate(ROWS_JS)
            W, H = rr['W'], rr['H']
            tan_x, tan_y = framing(W / H)
            curve = [(W / 2 + x / tan_x * W / 2, H / 2 - y / tan_y * H / 2) for x, y in kerr_shadow(0.99, 24.0, math.radians(inc))]
            # Distance from every edge pixel of the GPU shadow to the analytic curve.
            ys = [y for y, (l, r) in enumerate(rr['rows']) if l >= 0]
            dists = []
            for y in ys:
                l, r = rr['rows'][y]
                dists += [distance_to_curve(curve, l, y + 0.5), distance_to_curve(curve, r + 1, y + 0.5)]
            mean_d = sum(dists) / len(dists)
            check(f'a/M = 0.99, inclination {inc:.0f}°: GPU shadow edge matches the analytic Kerr curve', mean_d < 0.75 and max(dists) < 2.0,
                  f'{len(dists)} edge pixels, mean distance {mean_d:.2f}px, worst {max(dists):.2f}px')
            if inc == 90.0:
                xl = min(l for l, r in (rr['rows'][y] for y in ys))
                xr = max(r for l, r in (rr['rows'][y] for y in ys)) + 1
                shift = (xl + xr) / 2 - W / 2
                # Flatness: how far each side's edge moves in from its extreme over the middle half of the
                # height, measured on the GPU image and on the analytic curve over the same rows.
                mid = ys[len(ys) // 4: -len(ys) // 4]
                bulge_l = max(rr['rows'][y][0] for y in mid) - xl
                bulge_r = xr - min(rr['rows'][y][1] + 1 for y in mid)
                ext = [curve_extent_at(curve, y + 0.5) for y in ys]
                ext_mid = [curve_extent_at(curve, y + 0.5) for y in mid]
                a_l = max(e[0] for e in ext_mid) - min(e[0] for e in ext if e)
                a_r = max(e[1] for e in ext if e) - min(e[1] for e in ext_mid)
                check('a/M = 0.99 edge-on: shadow shifted right and flattened on the left (prograde, approaching) side',
                      shift > 0.15 * (xr - xl) and a_l < 0.65 * a_r and abs(bulge_l - a_l) <= 2.5 and abs(bulge_r - a_r) <= 2.5,
                      f'shift {shift:.1f}px of width {xr - xl}px; edge bulge left {bulge_l}px (analytic {a_l:.1f}), right {bulge_r}px (analytic {a_r:.1f})')
            check(f'no console errors (Kerr debug, inclination {inc:.0f}°)', not errors, json.dumps(errors[:5]))
            ctx.close()

        # The flattened side is the side where the disk comes towards the camera (it is brighter).
        ctx, page, errors = open_page(browser, BASE + '#az=30&inc=84&r=24&spin=0.99&fx=dop,lens,disk&anim=0&q=high&ui=0', viewport={'width': 1280, 'height': 720})
        page.evaluate('window.__vivar.lockScale(1)')
        wait_frame(page)
        halves = page.evaluate("""() => {
          const src = document.getElementById('view');
          const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
          const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
          const W = c.width, H = c.height, d = ctx.getImageData(0, 0, W, H).data;
          let l = 0, r = 0;
          for (let y = Math.round(0.35 * H); y < Math.round(0.65 * H); y++)
            for (let x = 0; x < W; x++) { const i = 4 * (y * W + x); const v = d[i] + d[i + 1] + d[i + 2]; if (x < W / 2) l += v; else r += v; }
          return [l, r];
        }""")
        check('with spin the brighter, approaching half of the disk is on the left (the flattened side)', halves[0] > 1.2 * halves[1], f'left/right = {halves[0] / halves[1]:.2f}')
        ctx.close()

        # ---------------------------------------------------------- mobile
        ctx, page, errors = open_page(
            browser, BASE, viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True
        )
        s = sig(page)
        m = sum(s) / len(s)
        sd = math.sqrt(sum((x - m) ** 2 for x in s) / len(s))
        check('mobile: canvas renders', sd > 8, f'std={sd:.1f}')
        overflow = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        check('mobile: no horizontal overflow', overflow <= 0, f'overflow={overflow}')
        collapsed = page.get_attribute('#panel-toggle', 'aria-expanded')
        page.tap('#panel-toggle')
        time.sleep(0.3)
        opened = page.get_attribute('#panel-toggle', 'aria-expanded')
        check('mobile: panel starts collapsed and opens', collapsed == 'false' and opened == 'true')
        q = page.evaluate('window.__vivar.state.quality')
        check('mobile: starts at medium quality', q == 'medium', q)
        page.tap('label:has(#disk)')
        time.sleep(SETTLE)
        check('mobile: toggles respond to taps', page.evaluate('window.__vivar.state.disk') is False)
        check('no console errors (mobile)', not errors, json.dumps(errors[:5]))
        ctx.close()

        # ---------------------------------------------------------- reduced motion
        ctx, page, errors = open_page(browser, BASE, viewport={'width': 1280, 'height': 720}, reduced_motion='reduce')
        st = page.evaluate('window.__vivar.state')
        check('prefers-reduced-motion disables disk animation and auto-orbit', not st['animate'] and not st['autoOrbit'])
        ctx.close()

        # ---------------------------------------------------------- frame rate in the real loop
        if not SWIFTSHADER:
            print('\nframe loop with the adaptive scaler (10 s settle, 5 s count, animated disk):')
            for (vw, vh, dpr, spin, label) in [(1280, 720, 1, 0, 'a=0'), (1280, 720, 1, 0.99, 'a=0.99'), (1440, 900, 2, 0, 'a=0'), (1440, 900, 2, 0.99, 'a=0.99')]:
                ctx, page, errors = open_page(browser, BASE + f'#az=30&inc=84&r=24&spin={spin}&anim=1&ui=0&q=high', viewport={'width': vw, 'height': vh}, device_scale_factor=dpr)
                time.sleep(10)
                f0 = page.evaluate('window.__vivar.stats.frames')
                time.sleep(5)
                f1 = page.evaluate('window.__vivar.stats.frames')
                st = page.evaluate('window.__vivar.stats')
                fps = (f1 - f0) / 5
                check(f'{vw}x{vh} DPR {dpr}, {label}, High: holds 60 fps with adaptive resolution', fps >= 57,
                      f"{fps:.1f} fps at render scale {st['scale']:.2f} ({st['sceneW']}x{st['sceneH']})")
                ctx.close()

        # ---------------------------------------------------------- benchmark
        print('\nbenchmark (frames rendered back to back, fixed render scale 1.0, mean ms per frame):')
        for w, h in [(1280, 720), (1920, 1080), (2560, 1440)]:
            for spin in [0, 0.99]:
                ctx, page, errors = open_page(browser, BASE + f'#az=30&inc=84&r=24&spin={spin}&anim=0&ui=0', viewport={'width': w, 'height': h})
                row = []
                for q in ['low', 'medium', 'high', 'ultra']:
                    page.evaluate(f"window.__vivar.set({{ quality: '{q}' }}); window.__vivar.lockScale(1)")
                    wait_frame(page)
                    ms = min(page.evaluate('window.__vivar.bench(20)') for _ in range(3))
                    st = page.evaluate('window.__vivar.stats')
                    row.append(f"{q} {ms:6.2f} ms ({1000 / ms:5.0f} fps)")
                print(f"  {w}x{h} a={spin} (scene {st['sceneW']}x{st['sceneH']}): " + ' | '.join(row))
                ctx.close()

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
