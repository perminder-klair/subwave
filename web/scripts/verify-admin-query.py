"""Focused checks for the shared admin TanStack Query client.

Runs only against the isolated controller and web servers documented in
.claude/skills/verify/SKILL.md.  It intentionally refuses any other ports.
"""
import base64
import json
import sys
import traceback
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

WEB = "http://localhost:7793"
API = "http://localhost:7791"
AUTH = base64.b64encode(b"test:test").decode()

CHECKS = {}


def check(fn):
    CHECKS[fn.__name__] = fn
    return fn


def api(path):
    request = urllib.request.Request(
        f"{API}{path}", headers={"Authorization": f"Basic {AUTH}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def assert_throwaway_stack():
    if API != "http://localhost:7791" or WEB != "http://localhost:7793":
        sys.exit("refusing to run: API/WEB are not the verify stack's ports")
    try:
        api("/health")
    except Exception as error:
        sys.exit(f"verify stack not reachable at {API}: {error}")


def needs_stubbed_browse():
    """Whether a fresh stack can supply a real library row.

    The check is about QueryClient lifetime, not Navidrome. A fresh isolated
    controller normally has no library database (and its database native
    module can be unavailable in a lightweight worktree), so no real station
    state is ever copied into the verify stack just to create one row.
    """
    try:
        return not (api("/library/browse?limit=1").get("rows") or [])
    except (urllib.error.HTTPError, urllib.error.URLError):
        return True


def stub_browse_when_needed(page):
    if not needs_stubbed_browse():
        return
    page.route(
        "**/library/browse**",
        lambda route: route.fulfill(
            content_type="application/json",
            body=json.dumps({
                "rows": [{"id": "verify-track", "title": "Verify track", "artist": "SUB/WAVE"}],
                "total": 1,
                "stats": {"byMood": {}, "byEnergy": {}},
                "moodVocab": [],
            }),
        ),
    )


def new_page(playwright):
    browser = playwright.chromium.launch()
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    context.add_init_script(
        f"localStorage.setItem('subwave_admin_auth', '{AUTH}')",
    )
    page = context.new_page()
    page.requests = []
    page.on("request", lambda request: page.requests.append(request.url))
    return browser, page


@check
def cache_survives_admin_navigation(page):
    stub_browse_when_needed(page)
    page.goto(f"{WEB}/admin/library?tab=browse", wait_until="networkidle")
    before = len([url for url in page.requests if "/library/browse" in url])
    page.get_by_role("link", name="Settings", exact=True).click()
    page.wait_for_url("**/admin/settings")
    page.get_by_role("link", name="Library", exact=True).click()
    page.wait_for_url("**/admin/library")
    page.locator(".lib-tab", has_text="Browse").click()
    page.wait_for_selector(".lib-row")
    after = len([url for url in page.requests if "/library/browse" in url])
    assert after == before, (before, after)


@check
def unauthorised_query_is_not_retried(page):
    hits = []
    page.route(
        "**/stations",
        lambda route: (hits.append(route.request.url), route.fulfill(status=401, body='{}'))[1],
    )
    page.goto(f"{WEB}/admin/stations", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    assert len(hits) == 1, hits


def main():
    assert_throwaway_stack()
    names = sys.argv[1:] or list(CHECKS)
    unknown = [name for name in names if name not in CHECKS]
    if unknown:
        sys.exit(f"unknown check(s): {', '.join(unknown)} — have {', '.join(CHECKS)}")
    failed = []
    with sync_playwright() as playwright:
        for name in names:
            browser, page = new_page(playwright)
            try:
                CHECKS[name](page)
                print(f"PASS {name}")
            except Exception:
                traceback.print_exc()
                failed.append(name)
                print(f"FAIL {name}")
            finally:
                browser.close()
    if failed:
        sys.exit(f"{len(failed)} check(s) failed: {', '.join(failed)}")
    print(f"all {len(names)} check(s) passed")


if __name__ == "__main__":
    main()
