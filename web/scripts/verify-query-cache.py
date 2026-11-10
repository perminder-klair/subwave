"""web/scripts/verify-query-cache.py

The half of the TanStack Query conversion that verify-library.py cannot see.
That script pins BEHAVIOUR that must not change; this one pins the two things
the change is FOR (cache reuse across a tab switch, request de-duplication)
plus the cross-tab cache writes and the no-retry-storm guarantee.

Same isolated verify stack, same ports, same throwaway-stack assertion — see
verify-library.py's docstring. Run it the same way:

    python3 web/scripts/verify-query-cache.py [check ...]
"""
import base64
import json
import pathlib
import subprocess
import sys
import textwrap
import traceback
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

WEB = "http://localhost:7793"
API = "http://localhost:7791"
AUTH = base64.b64encode(b"test:test").decode()

ROW = ".lib-row"
TITLE = ".lib-title"
EDIT_BTN = '[title="Edit moods manually"]'
BLOCK_BTN = '[title="Never play this on air"]'
BLOCKED_BADGE = ".lib-btag"
FLASHED_ROW = ".lib-row.flash"
EMPTY = '[data-testid="empty-state"]'
EDITOR = '[data-testid="manual-tag-editor"]'

CHECKS = {}


def check(fn):
    CHECKS[fn.__name__] = fn
    return fn


def api(path):
    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Basic {AUTH}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def api_write(method, path, body=None, ok_statuses=(200, 201, 204, 404)):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Basic {AUTH}"}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code in ok_statuses:
            return {}
        raise


def assert_throwaway_stack():
    if API != "http://localhost:7791" or WEB != "http://localhost:7793":
        sys.exit("refusing to run: API/WEB are not the verify stack's ports")
    try:
        api("/health")
    except Exception as e:
        sys.exit(f"verify stack not reachable at {API}: {e}")
    if not (api("/library/browse?limit=1").get("rows") or []):
        sys.exit("verify stack has an empty library.db — copy one into its STATE_DIR")


def new_page(pw):
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(
        f"try {{ localStorage.setItem('subwave_admin_auth', '{AUTH}'); }} catch (e) {{}}"
    )
    page = ctx.new_page()
    page.requests = []
    page.on("request", lambda r: page.requests.append(r.url))
    return browser, page


def goto_tab(page, query, wait=ROW):
    page.goto(f"{WEB}/admin/library{query}", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector(wait, timeout=60_000)


def tab(page, label):
    page.locator(".lib-tab", has_text=label).first.click()


# ---------------------------------------------------------------------------


@check
def cache_survives_tab_switch(page):
    """Returning to Browse paints cached rows in the SAME frame as the click.

    The point of the change. Before it, BrowseTab unmounted with the tab and
    remounted with `browse === null`, so the table was empty until a fresh
    /library/browse landed. Asserting "rows are present with no paint gap" is
    the only way to tell a cache hit from a very fast refetch, so the rows are
    read synchronously right after the click rather than waited for.
    """
    goto_tab(page, "?tab=browse")
    first_title = page.locator(TITLE).first.inner_text().strip()
    assert first_title, "browse rendered no titles"

    tab(page, "History")
    page.wait_for_selector(TITLE, timeout=60_000)
    tab(page, "Browse")

    # No wait_for_*: if this needed a refetch the table would be empty here.
    shown = page.locator(TITLE).first.inner_text().strip()
    assert shown == first_title, (
        f"Browse did not paint from cache on return: got {shown!r}, want {first_title!r}"
    )


@check
def no_duplicate_inflight(page):
    """Bouncing between tabs does not fire one request per visit.

    The cache both de-duplicates concurrent observers and serves inside
    staleTime (30s), so four visits to Browse inside a few seconds must not be
    four /library/browse calls.
    """
    goto_tab(page, "?tab=browse")
    page.wait_for_timeout(500)
    base = len([u for u in page.requests if "/library/browse?" in u])
    assert base >= 1, "browse never fetched at all"

    for _ in range(3):
        tab(page, "History")
        page.wait_for_selector(TITLE, timeout=60_000)
        tab(page, "Browse")
        page.wait_for_selector(ROW, timeout=60_000)
    page.wait_for_timeout(1_000)

    after = len([u for u in page.requests if "/library/browse?" in u])
    assert after == base, (
        f"three round trips to Browse fired {after - base} extra /library/browse "
        "calls — the cache is not being reused"
    )


def seed_like(track):
    """Put a track in Liked so Browse and Liked hold the SAME row.

    Two library.db-backed lists that genuinely overlap is what makes a
    cross-list assertion meaningful. Search would be the more obvious partner
    and is deliberately not used: its rows come from Navidrome's own metadata
    search, so whether the browse row is IN them depends on the title, and this
    library's first row is titled ";)".
    """
    api_write("POST", f"/likes/song/{track['id']}", {
        "title": track.get("title"), "artist": track.get("artist"),
        "album": track.get("album"), "duration": track.get("duration"),
    })


def open_liked(page):
    page.locator(".lib-tab", has_text="Tracks").first.click()
    page.locator("[role=radio]").filter(has_text="LIKED").first.click()
    page.wait_for_function("() => location.search.includes('view=liked')", timeout=15_000)
    page.wait_for_selector(ROW, timeout=60_000)


@check
def block_marks_reach_an_unmounted_list(page):
    """A block on Browse marks the same row in Liked — via the cache, not a
    registry of mounted lists.

    Liked is loaded FIRST and then left behind. Under the RowSource registry its
    source unregistered on unmount and the re-stamp could not reach it; the
    cache keeps the entry, so coming back shows the badge.
    """
    track = (api("/library/browse?limit=1").get("rows") or [])[0]
    seed_like(track)
    try:
        goto_tab(page, "?tab=browse")
        open_liked(page)

        tab(page, "Browse")
        page.wait_for_selector(ROW, timeout=60_000)
        page.locator(ROW).first.locator(BLOCK_BTN).click()
        page.get_by_role("button", name="Never play this track", exact=True).click()
        page.wait_for_selector(f"{ROW} {BLOCKED_BADGE}", timeout=60_000)

        open_liked(page)
        assert page.locator(BLOCKED_BADGE).count() >= 1, (
            "the block did not reach the Liked list held in cache"
        )
    finally:
        api_write("DELETE", f"/library/blocklist/track/{track['id']}")
        api_write("DELETE", f"/likes/song/{track['id']}")


@check
def retag_reaches_browse_through_cache(page):
    """A manual tag save in Liked shows up on Browse without a manual reload.

    Browse is the one list that REFETCHES on a tag event (its membership can
    change from a mood filter), so this pins applyTagEvent's invalidate half
    rather than its patch half.
    """
    track = (api("/library/browse?limit=1").get("rows") or [])[0]
    before_moods = track.get("moods") or []
    before_energy = track.get("energy")
    seed_like(track)
    try:
        goto_tab(page, "?tab=browse")
        open_liked(page)

        page.locator(ROW).first.locator(EDIT_BTN).click()
        page.wait_for_selector(EDITOR, timeout=30_000)
        chips = page.locator(f"{EDITOR} button[aria-pressed]")
        labels = [chips.nth(i).inner_text().strip().split("\n")[0].lower()
                  for i in range(chips.count())]
        for i, label in enumerate(labels):
            if label in before_moods:
                chips.nth(i).click()
        picked = next((l for l in labels if l and l not in before_moods), None)
        assert picked, "no unselected mood chip available in the editor"
        chips.nth(labels.index(picked)).click()
        page.get_by_role("button", name="Save tags", exact=True).click()
        page.wait_for_selector(FLASHED_ROW, timeout=60_000)

        tab(page, "Browse")
        page.wait_for_selector(ROW, timeout=60_000)
        page.wait_for_function(
            "(want) => Array.from(document.querySelectorAll('.lib-row'))"
            " .some(r => Array.from(r.querySelectorAll('.lib-mtag'))"
            "   .some(t => t.innerText.trim().toLowerCase() === want))",
            arg=picked, timeout=60_000,
        )
    finally:
        api_write("POST", "/library/manual-tag", {
            "id": track["id"], "moods": before_moods,
            "energy": before_energy, "applyToAlbum": False,
        })
        api_write("DELETE", f"/likes/song/{track['id']}")


@check
def signed_out_does_not_retry_storm(page):
    """With the token gone, the page must not hammer the controller.

    `retry: false` on the QueryClient is what guarantees this: adminFetch turns
    a 401 into a sign-out, and a retrying query would fire three more
    unauthenticated calls per key and race the token wipe.
    """
    # Browse is library.db-backed on the isolated stack. The default Tracks
    # view may be Recent, which depends on the deliberately unreachable fake
    # Navidrome and can be empty before this check reaches its 401 assertion.
    page.goto(f"{WEB}/admin/library?tab=browse", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector(ROW, timeout=60_000)
    page.evaluate("() => localStorage.removeItem('subwave_admin_auth')")

    page.requests.clear()
    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(6_000)

    # Scoped to the endpoints this page's QueryClient owns. AdminShell's own
    # hand-rolled /state + /now-playing pollers are untouched by this PR and
    # legitimately tick several times inside the window.
    owned = ("/library/", "/likes/index", "/dj/recent", "/settings", "/playlists")
    per_path = {}
    for u in page.requests:
        if ":7791/" not in u:
            continue
        path = u.split(":7791", 1)[1].split("?", 1)[0]
        if path.startswith(owned):
            per_path[path] = per_path.get(path, 0) + 1
    assert per_path, "no library queries fired at all — the check proved nothing"
    worst = max(per_path.values())
    assert worst <= 2, f"signed-out page retried a library query: {per_path}"


@check
def row_mutations_patch_all_cache_shapes(_page):
    """Block and tag writes patch bare, paged, and infinite Track caches."""
    web_root = pathlib.Path(__file__).resolve().parents[1]
    program = textwrap.dedent("""
        import { QueryClient } from '@tanstack/react-query';
        import {
          applyBlockMarks, applyTagEvent, libraryKeys, rowsOf,
        } from './components/admin/library/queries.ts';

        const client = new QueryClient();
        const track = {
          id: 'shape-track', title: 'Shape Track', artist: 'SUB/WAVE',
          album: 'Cache Contract', moods: [], energy: null, source: null,
        };
        const filters = {
          moods: [], energy: '', vocal: '', genre: '', yearFrom: '', yearTo: '',
          q: '', sort: 'recent', page: 1,
        };
        const keys = [
          libraryKeys.recent(),
          libraryKeys.browse(filters),
          libraryKeys.search('shape', 'metadata'),
        ];
        client.setQueryData(keys[0], [track]);
        client.setQueryData(keys[1], { rows: [track], total: 1 });
        client.setQueryData(keys[2], {
          pages: [{ rows: [track], nextCursor: null }], pageParams: [null],
        });

        applyBlockMarks(client, { 'shape-track': { kind: 'track', id: 'shape-track' } });
        for (const key of keys) {
          const rows = rowsOf(client.getQueryData(key));
          if (rows.length !== 1 || rows[0].blockedBy?.id !== 'shape-track') {
            throw new Error(`block mark missed cache shape ${JSON.stringify(key)}`);
          }
        }

        applyTagEvent(client, {
          track, moods: ['night'], energy: 'low', source: 'manual',
          cleared: false, applyToAlbum: false,
        });
        for (const key of keys) {
          const rows = rowsOf(client.getQueryData(key));
          if (rows.length !== 1 || rows[0].moods?.[0] !== 'night' || rows[0].energy !== 'low') {
            throw new Error(`tag event missed cache shape ${JSON.stringify(key)}`);
          }
        }
        client.clear();
    """)
    result = subprocess.run(
        [str(web_root.parent / "controller/node_modules/.bin/tsx"), "--eval", program],
        cwd=web_root,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


# ---------------------------------------------------------------------------


def main():
    assert_throwaway_stack()
    names = sys.argv[1:] or list(CHECKS)
    unknown = [n for n in names if n not in CHECKS]
    if unknown:
        sys.exit(f"unknown check(s): {', '.join(unknown)} — have {', '.join(CHECKS)}")
    failed = []
    with sync_playwright() as pw:
        for name in names:
            browser, page = new_page(pw)
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
