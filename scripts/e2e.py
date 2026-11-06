"""End-to-end checks of a running build with Playwright's Chromium.

    npm run build:pages
    mkdir -p /tmp/site && cp -r dist /tmp/site/vivar
    (cd /tmp/site && python -m http.server 8765) &
    python scripts/e2e.py http://localhost:8765/vivar/

Checks: no console errors, non-blank canvas, animation, every control changes
the image, URL-hash round trip, mobile viewport, the explainer overlay, the
shadow radius against b_c, and a small frame-time benchmark.
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

        sliders = {'inclination': '60', 'distance': '14', 'temperature': '12000', 'exposure': '1.5'}
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
        for preset in ['edge', 'face', 'einstein', 'default']:
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
        page.evaluate("window.__vivar.set({ azimuth: 77, inclination: 63, distance: 19.5, temperature: 8000, exposure: -0.5, doppler: false, guides: true, animate: false, quality: 'medium' })")
        time.sleep(0.6)
        h = page.evaluate('location.hash')
        state_a = page.evaluate('window.__vivar.state')
        ctx2, page2, errors2 = open_page(browser, BASE + h, viewport={'width': 1280, 'height': 720})
        state_b = page2.evaluate('window.__vivar.state')
        check('URL hash round trip restores the state', state_a == state_b, h)
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

        check('no console errors (desktop)', not errors, json.dumps(errors[:5]))
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
        pred = math.tan(alpha) / math.tan(math.radians(26)) * radii['H'] / 2
        meas = sum(radii['out']) / len(radii['out'])
        spread = max(radii['out']) - min(radii['out'])
        check('shadow radius matches b_c', abs(meas - pred) < 1.5 and spread <= 2, f'measured {meas:.2f}px (spread {spread:.1f}) vs predicted {pred:.2f}px')
        check('no console errors (debug view)', not errors, json.dumps(errors[:5]))
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

        # ---------------------------------------------------------- benchmark
        print('\nbenchmark (frames rendered back to back, fixed render scale 1.0, mean ms per frame):')
        for w, h in [(1280, 720), (1920, 1080), (2560, 1440)]:
            ctx, page, errors = open_page(browser, BASE + '#az=30&inc=84&r=24&anim=0&ui=0', viewport={'width': w, 'height': h})
            row = []
            for q in ['low', 'medium', 'high', 'ultra']:
                page.evaluate(f"window.__vivar.set({{ quality: '{q}' }}); window.__vivar.lockScale(1)")
                wait_frame(page)
                ms = min(page.evaluate('window.__vivar.bench(20)') for _ in range(3))
                st = page.evaluate('window.__vivar.stats')
                row.append(f"{q} {ms:6.2f} ms ({1000 / ms:5.0f} fps)")
            print(f"  {w}x{h} (scene {st['sceneW']}x{st['sceneH']}): " + ' | '.join(row))
            ctx.close()

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
