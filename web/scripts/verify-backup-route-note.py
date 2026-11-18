"""Check the Debug backup note's layout against a local Next dev server.

Usage: python3 web/scripts/verify-backup-route-note.py [http://localhost:7843]
Requires Python Playwright and Chromium. API replies are intercepted fixtures;
no controller or station is contacted. Works with /api or an absolute API base.
"""
import os
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

WEB = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:7843'
origin = urlparse(WEB)
assert origin.hostname == 'localhost' and origin.port not in (7700, 1234, 8000), WEB
debug = {'queue': {}, 'llm': {'provider': 'ollama', 'activeModel': 'primary'}}


def fixture(route):
    url = urlparse(route.request.url)
    path = url.path.removeprefix('/api')
    if path == '/debug':
        route.fulfill(json=debug)
    elif path == '/themes':
        route.fulfill(json={'themes': []})
    elif path == '/debug/state-tree':
        route.fulfill(json={'root': 'verify', 'path': '', 'entries': []})
    elif url.path.startswith('/api/') or url.netloc != origin.netloc:
        if route.request.resource_type in ('fetch', 'xhr'):
            route.fulfill(json={})
        else:
            route.abort()
    else:
        route.continue_()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'))
    try:
        page = browser.new_page()
        page.set_default_timeout(15000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script("localStorage.setItem('subwave_admin_auth', btoa('test:test'))")
        page.route('**/*', fixture)
        for width in (320, 375, 768, 1440):
            page.set_viewport_size({'width': width, 'height': 900})
            debug['llm']['routedToBackup'] = None
            page.goto(WEB + '/admin/debug', wait_until='domcontentloaded', timeout=120000)
            card = page.locator('[data-card="llm-recent-calls"]')
            expect(card).to_be_visible()
            note = card.locator('span[title]').filter(has_text='routed to backup')
            expect(note).to_have_count(0)
            for model in ('openai-compatible:backup', 'openai-compatible:org/' + 'x' * 100):
                debug['llm']['routedToBackup'] = {
                    'provider': 'openai-compatible', 'model': model,
                    'reason': 'primary model unavailable', 'calls': 1,
                }
                expect(note).to_contain_text(model)
                page.evaluate('document.fonts.ready')
                # The admin page clips overflow. document.scrollWidth misses
                # a clipped label, so check the note and its actual text lines.
                bounds = card.bounding_box()
                lines = note.evaluate('''el => {
                    const range = document.createRange();
                    range.selectNodeContents(el.lastElementChild);
                    return Array.from(range.getClientRects(), r => ({left: r.left, right: r.right}));
                }''')
                box = note.bounding_box()
                lines.append({'left': box['x'], 'right': box['x'] + box['width']})
                for line in lines:
                    assert line['left'] >= bounds['x'] - 1, (width, model, line, bounds)
                    assert line['right'] <= bounds['x'] + bounds['width'] + 1, (width, model, line, bounds)
                print(f'PASS {width}px: complete backup label fits ({len(model)} model characters)', flush=True)
        assert not errors, errors
    finally:
        browser.close()
