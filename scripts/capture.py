"""Capture the README screenshots, og.png and the no-WebGL2 fallback still
from a running build, using Playwright's Chromium.

    npm run build && npx vite preview --port 4173 &
    python scripts/capture.py http://localhost:4173/

Requires `pip install playwright && playwright install chromium`. On macOS the
headless browser uses the real GPU through ANGLE/Metal; elsewhere you may need
`--swiftshader` (slow, but it produces the same image).
"""

import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
SWIFTSHADER = '--swiftshader' in sys.argv
ARGS = (
    ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    if SWIFTSHADER
    else ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
)

# name, hash, viewport, output path, settle seconds
SHOTS = [
    ('hero', 'az=30&inc=84&r=22&t=4500&ev=0&q=ultra&fx=dop,grav,lens,disk&anim=0&ui=0', (1600, 900), 'docs/hero.png'),
    ('edge', 'az=30&inc=89.2&r=21&t=5000&ev=0&q=ultra&fx=dop,grav,lens,disk&anim=0&ui=0', (1200, 675), 'docs/edge-on.png'),
    ('face', 'az=30&inc=6&r=26&t=5000&ev=0&q=ultra&fx=dop,grav,lens,disk&anim=0&ui=0', (1200, 675), 'docs/face-on.png'),
    ('split', 'az=30&inc=80&r=24&t=4500&ev=0&q=ultra&fx=dop,grav,lens,disk,split&anim=0&ui=0', (1200, 675), 'docs/lensing-split.png'),
    ('ring', 'az=33.4&inc=100.4&r=22&t=4500&ev=0&q=ultra&fx=dop,grav,lens&anim=0&ui=0', (1200, 675), 'docs/einstein-ring.png'),
    ('nodop', 'az=30&inc=84&r=22&t=4500&ev=0&q=ultra&fx=lens,disk&anim=0&ui=0', (1200, 675), 'docs/no-redshift.png'),
    ('kerr', 'az=30&inc=86&r=21&spin=0.99&t=4500&ev=-1.25&q=ultra&fx=dop,grav,lens,disk&anim=0&ui=0', (1200, 675), 'docs/kerr.png'),
    ('kerrguide', 'az=30&inc=89.5&r=20&spin=0.99&t=4500&ev=-1.25&q=ultra&fx=dop,grav,lens,disk,guides&anim=0&ui=0', (1200, 675), 'docs/kerr-guides.png'),
    ('og', 'az=30&inc=84&r=21&t=4500&ev=0.2&q=ultra&fx=dop,grav,lens,disk&anim=0&ui=0', (1200, 630), 'public/og.png'),
    ('fallback', 'az=30&inc=84&r=22&t=4500&ev=0&q=ultra&fx=dop,grav,lens,disk&anim=0&ui=0', (1200, 675), 'public/fallback.jpg'),
]


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=ARGS, channel='chromium')
        errors: list[str] = []

        def new_page(**kw):
            ctx = browser.new_context(**kw)
            # Skip the first-visit hint ("drag to orbit") in every capture.
            ctx.add_init_script("try { localStorage.setItem('vivar.hinted', '1') } catch (e) {}")
            return ctx.new_page()

        for name, h, (w, hgt), out in SHOTS:
            page = new_page(viewport={'width': w, 'height': hgt}, device_scale_factor=1)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'{BASE}#{h}')
            page.wait_for_function('window.__vivar && window.__vivar.stats.frames > 0', timeout=60000)
            page.evaluate('window.__vivar.setTime(120); window.__vivar.lockScale(1)')
            time.sleep(1.5 if not SWIFTSHADER else 10)
            path = ROOT / out
            path.parent.mkdir(parents=True, exist_ok=True)
            if out.endswith('.jpg'):
                page.screenshot(path=str(path), type='jpeg', quality=88)
            else:
                page.screenshot(path=str(path))
            print(f'{name:9s} -> {out}')
            page.close()

        # UI screenshot with the explainer open.
        page = new_page(viewport={'width': 1440, 'height': 860}, device_scale_factor=1)
        page.goto(f'{BASE}#az=30&inc=84&r=24&t=4500&ev=0&q=high&fx=dop,grav,lens,disk&anim=0')
        page.wait_for_function('window.__vivar && window.__vivar.stats.frames > 0', timeout=60000)
        page.evaluate('window.__vivar.setTime(120)')
        page.click('#explain')
        time.sleep(1.5)
        page.screenshot(path=str(ROOT / 'docs/ui.png'))
        print('ui        -> docs/ui.png')
        browser.close()
        if errors:
            raise SystemExit(f'page errors: {errors}')


if __name__ == '__main__':
    main()
