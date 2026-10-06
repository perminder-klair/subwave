"""Regression check for #1790 against a local Next dev server.

Start web with NEXT_PUBLIC_API_URL=/api, then run:
python3 web/scripts/verify-settings-mobile.py [http://localhost:7798]
Requires Python Playwright and Chromium. API responses are intercepted fixtures;
no controller or live station is contacted. Exercises the real Settings page.
"""
import os
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

WEB = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:7798'
MODELS = ['openai/gpt-4o', 'anthropic/claude-sonnet', 'google/gemini'] + [
    f'provider/model-{i:03d}' for i in range(100)
]


def fixture(route):
    path = urlparse(route.request.url).path
    data = {}
    if path == '/api/settings':
        data = {
            'values': {'llm': {'provider': 'openrouter', 'model': MODELS[0]}},
            'env': {'OPENROUTER_API_KEY': True},
            'llm': {'providers': ['ollama', 'openrouter', 'anthropic', 'openai-compatible']},
        }
    elif path == '/api/settings/llm/models':
        data = {'ok': True, 'models': MODELS}
    elif path == '/api/themes':
        data = {'themes': []}
    route.fulfill(json=data)


def assert_fits(locator, width):
    for box in locator.evaluate_all('(els) => els.map(e => { const r = e.getBoundingClientRect(); return {left:r.left,right:r.right} })'):
        assert box['left'] >= -1 and box['right'] <= width + 1, box


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM', '/usr/bin/chromium'))
    try:
        for width in [320, 393, 768, 1440]:
            page = browser.new_page(viewport={'width': width, 'height': 800}, has_touch=True, is_mobile=width < 800)
            page.set_default_timeout(10000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script("localStorage.setItem('subwave_admin_auth', btoa('test:test'))")
            # Refuse external requests, even if the server was started with a
            # different API base or a component loads a remote resource.
            page.route('**/*', lambda route: route.continue_()
                       if urlparse(route.request.url).netloc == urlparse(WEB).netloc
                       else route.abort())
            page.route('**/api/**', fixture)
            page.goto(WEB + '/admin/settings?section=behaviour')
            expect(page.get_by_text('Decide how the DJ occupies the station.', exact=True)).to_be_visible()
            # The page clips horizontal overflow, so document.scrollWidth alone
            # falsely passes the old layout. Check actual navigation/card bounds.
            assert_fits(page.locator('aside').last, width)
            assert_fits(page.locator('[data-card]'), width)
            page.goto(WEB + '/admin/settings?section=llm')
            trigger = page.get_by_role('button', name=MODELS[0], exact=True)
            expect(trigger).to_be_visible()
            assert_fits(page.locator('[data-card]'), width)
            trigger.scroll_into_view_if_needed()
            page.wait_for_timeout(150)  # settle the pre-tap scroll event
            trigger.tap()
            search = page.get_by_role('combobox')
            expect(search).to_be_visible()
            # cmdk's initial selection scroll used to dismiss the popup. Page
            # scroll and keyboard-like resize must keep it open and searchable.
            page.evaluate('window.scrollBy(0, 24)')
            expect(search).to_be_visible()
            page.set_viewport_size({'width': width, 'height': 500})
            expect(search).to_be_visible()
            search.fill('claude')
            option = page.get_by_role('option', name=MODELS[1], exact=True)
            expect(option).to_be_visible()
            assert_fits(option, width)
            option.tap()
            expect(page.get_by_role('button', name=MODELS[1], exact=True)).to_be_visible()
            expect(search).to_have_count(0)
            page.get_by_role('button', name=MODELS[1], exact=True).tap()
            search.fill('provider/model-099')
            search.press('ArrowDown')
            search.press('Enter')
            keyboard = page.get_by_role('button', name='provider/model-099', exact=True)
            expect(keyboard).to_be_visible()
            keyboard.tap()
            search.fill('custom/private-model')
            page.get_by_role('option', name='Use “custom/private-model”', exact=True).tap()
            custom = page.get_by_role('button', name='custom/private-model', exact=True)
            expect(custom).to_be_visible()
            custom.tap()
            search.press('Escape')
            expect(search).to_have_count(0)
            expect(custom).to_be_focused()
            custom.tap()
            page.touchscreen.tap(2, 250)
            expect(search).to_have_count(0)
            assert not errors, errors
            print(f'PASS {width}px: layout, touch selection, scroll/resize, custom ID, Escape, outside tap')
            page.close()
    finally:
        browser.close()
