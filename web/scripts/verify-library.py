"""web/scripts/verify-library.py

Characterization checks for the admin Library page. Not part of CI — web/ has
no test suite and the merge gate is lint. This is the regression net for the
LibraryPanel split: every check describes behaviour that exists BEFORE the
refactor and must still hold after it. A check that fails on unmodified code
is a wrong check, not a bug.

Usage: python3 web/scripts/verify-library.py [check ...]
Every check in CHECKS runs with no args; name one or more to run a subset.

STACK. The isolated verify stack from the `verify` skill — controller on
:7791, web dev server on :7793, admin creds test:test. The controller needs a
seeded library.db in its STATE_DIR (copy one in; a fresh state dir indexes
nothing and every row assertion fails). Search (/dj/search) and Tracks → All
(/dj/recent) normally read Subsonic; this harness routes those two GETs to
deterministic envelopes built from the copied library.db so the isolated stack
never needs an operator's music-server credentials. Everything else answers
from the controller directly.

Unlike verify-forms.py these checks are read-mostly, so there is no
SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE gate — but assert_throwaway_stack() still
runs, because blocked_marks and retag_patches_rows DO write (a blocklist
entry, a track's moods) and pointing them at a real station would edit an
operator's actual library. Both undo themselves in a finally:.

SELECTORS. TrackTable renders divs, not a <table> — rows are `.lib-row` and
titles `.lib-title` (history has no .lib-row, only .lib-title). Row actions
are keyed on their `title` tooltip, the mode toggle on Radix's [role=radio]
+ data-state. Those files are presentational and untouched by the split, so
their hooks are stable; the one added attribute is data-testid="empty-state"
on the shared EmptyState, which otherwise carries nothing selectable and is
the only way to tell "loaded but empty" from "still loading".
"""
import base64
import json
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

WEB = "http://localhost:7793"
API = "http://localhost:7791"
AUTH = base64.b64encode(b"test:test").decode()

# Rows are divs; history reuses only the title class.
ROW = ".lib-row"
TITLE = ".lib-title"
MOOD_CHIP = ".lib-chip"
ACTIVE_CHIP = ".lib-active-chip"
BLOCK_BTN = '[title="Never play this on air"]'
EDIT_BTN = '[title="Edit moods manually"]'
HEART_OFF = '[title="Heart this track"]'
HEART_ON = '[title="Remove your heart"]'
BLOCKED_BADGE = ".lib-btag"
FLASHED_ROW = ".lib-row.flash"
EMPTY = '[data-testid="empty-state"]'
EDITOR = '[data-testid="manual-tag-editor"]'
# The Card subtitle — "1,413 matches" on Browse. Row COUNT is useless as a
# filter assertion: browse pages at 50, so a filter that drops 1413 rows to
# 571 still renders exactly 50 and the count never moves.
CARD_SUB = ".card-head .sub"

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
    """Refuse to run against anything but the isolated verify stack.

    Two checks write. A wrong port here would block a track on, and retag a
    track in, the operator's real station, so this is checked, not assumed.
    """
    if API != "http://localhost:7791" or WEB != "http://localhost:7793":
        sys.exit("refusing to run: API/WEB are not the verify stack's ports")
    try:
        api("/health")
    except Exception as e:
        sys.exit(f"verify stack not reachable at {API}: {e}")
    rows = api("/library/browse?limit=1").get("rows") or []
    if not rows:
        sys.exit(
            "verify stack has an empty library.db — copy one into its STATE_DIR, "
            "or every row assertion below fails for the wrong reason"
        )


def new_page(pw):
    browser = pw.chromium.launch()
    # Desktop viewport: the row action buttons are sm:-and-up; below that they
    # collapse into an overflow menu and every [title=…] lookup misses.
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    # Pre-seed the admin token: the sign-in form's delayed /admin/dash push
    # races Playwright in dev mode.
    ctx.add_init_script(
        f"try {{ localStorage.setItem('subwave_admin_auth', '{AUTH}'); }} catch (e) {{}}"
    )
    return browser, ctx.new_page()


def goto_tab(page, query, wait=ROW, allow_empty=False):
    """Navigate to a tab and wait for its list.

    allow_empty is off by default and that is load-bearing: TrackTable renders
    the EmptyState on first paint (rows are [] until the fetch lands), so a
    `rows-or-empty` wait returns instantly on EVERY tab and the row assertion
    that follows reads 0. Pass it only where an empty list is a real outcome.
    """
    page.goto(f"{WEB}/admin/library{query}", wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_selector(f"{wait}, {EMPTY}" if allow_empty else wait, timeout=60_000)


def mode_button(page, label):
    """The Tracks mode toggle is a Radix ToggleGroup; items carry no value
    attribute, so match on the visible label and read data-state."""
    return page.locator("[role=radio]").filter(has_text=label).first


def stub_subsonic_library_modes(page):
    """Keep the two Subsonic-backed tabs deterministic on the isolated stack.

    The verify controller deliberately points NAVIDROME_URL at a dead loopback
    port so it can never inherit or mutate an operator's music server. These
    route fixtures replace only the two read envelopes normally supplied by
    that server; their rows still come from the isolated controller's copied
    library.db, and Search still exercises offset paging and append behavior.
    """
    rows = api("/library/browse?limit=100").get("rows") or []
    assert len(rows) > 50, "fixture library needs more than one Search page"

    def route_subsonic_read(route):
        parsed = urllib.parse.urlparse(route.request.url)
        params = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/dj/recent":
            limit = int(params.get("limit", ["50"])[0])
            body = {"results": rows[:limit]}
        else:
            limit = int(params.get("limit", ["50"])[0])
            offset = int(params.get("offset", ["0"])[0])
            page_rows = rows[offset:offset + limit]
            body = {"results": page_rows, "hasMore": len(page_rows) == limit}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    page.route("http://localhost:7791/dj/recent**", route_subsonic_read)
    page.route("http://localhost:7791/dj/search**", route_subsonic_read)


# ---------------------------------------------------------------------------


@check
def browse_filters(page):
    """A mood chip narrows the rows, mirrors to the URL, and restores on reload."""
    goto_tab(page, "?tab=browse")
    assert page.locator(ROW).count() > 0, "browse returned no rows"
    before = page.locator(CARD_SUB).first.inner_text().strip()

    chip = page.locator(MOOD_CHIP).first
    label = chip.inner_text().strip().split("\n")[0]
    chip.click()
    page.wait_for_function(
        "(t) => { const el = document.querySelector('.card-head .sub');"
        " return el && el.innerText.trim() !== t; }",
        arg=before, timeout=30_000,
    )
    assert f"moods={label}" in page.url, f"filter not mirrored to URL: {page.url}"

    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector(ACTIVE_CHIP, timeout=60_000)
    assert page.locator(ACTIVE_CHIP, has_text=label).count() >= 1, \
        "active-filter chip did not restore from the URL"


@check
def search_modes(page):
    """A metadata search returns rows; Load more appends rather than replaces."""
    stub_subsonic_library_modes(page)
    goto_tab(page, "?tab=search", wait=EMPTY)
    page.fill('input[placeholder*="floating"]', "love")
    page.get_by_role("button", name="Search", exact=True).click()
    page.wait_for_selector(ROW, timeout=60_000)
    first = page.locator(ROW).count()
    assert first > 0, "search returned no rows"
    assert "sq=love" in page.url, f"search query not mirrored to URL: {page.url}"

    more = page.get_by_role("button", name="Load more", exact=True)
    if more.count():
        more.first.click()
        # Generous: this is the only wait in the suite that goes over the
        # network to the operator's Subsonic host rather than to library.db,
        # and a remote Navidrome's second search page has been seen to take
        # well over a minute. A tighter bound flakes and reads as a regression.
        page.wait_for_function(
            "(n) => document.querySelectorAll('.lib-row').length > n",
            arg=first, timeout=180_000,
        )


@check
def tracks_modes(page):
    """Each Tracks mode loads its own list and the mode rides the URL.

    Seeds an operator like so Liked mode has something to render — an empty
    likes store would let the mode 'pass' without ever exercising the list.
    """
    stub_subsonic_library_modes(page)
    seed = (api("/library/browse?limit=1").get("rows") or [])[0]
    api_write("POST", f"/likes/song/{seed['id']}", {
        "title": seed.get("title"), "artist": seed.get("artist"),
        "album": seed.get("album"), "duration": seed.get("duration"),
    })
    try:
        goto_tab(page, "")
        assert page.locator(ROW).count() > 0, "Tracks → All returned no rows"
        assert mode_button(page, "ALL").get_attribute("data-state") == "on"

        mode_button(page, "NEEDS TAGS").click()
        page.wait_for_function("() => location.search.includes('view=needs')", timeout=15_000)
        page.wait_for_selector(f"{ROW}, {EMPTY}", timeout=60_000)  # a fully tagged library is legitimately empty

        mode_button(page, "LIKED").click()
        page.wait_for_function("() => location.search.includes('view=liked')", timeout=15_000)
        page.wait_for_selector(ROW, timeout=60_000)
        assert page.locator(ROW).count() > 0, "Liked mode rendered no rows despite a seeded like"
    finally:
        api_write("DELETE", f"/likes/song/{seed['id']}")


@check
def like_toggle(page):
    """Hearting a row on Browse puts it in Liked; un-hearting removes the row.

    The cross-tab half the API-seeded tracks_modes check cannot reach: the
    like index is shared by every tab, and Liked is the ONLY list that drops a
    row when its count hits zero. Both live behind onLikeChanged.
    """
    track = (api("/library/browse?limit=1").get("rows") or [])[0]
    try:
        goto_tab(page, "?tab=browse")
        row = page.locator(ROW).first
        row.locator(HEART_OFF).click()
        # aria-pressed flips optimistically, then settles on the server count.
        page.wait_for_selector(f"{ROW} {HEART_ON}", timeout=60_000)
        # There is no GET /likes/song/:id — the index is the only read.
        assert track["id"] in (api("/likes/index").get("songs") or {}), \
            "heart did not persist server-side"

        goto_tab(page, "?view=liked")
        titles = page.locator(TITLE)
        assert any(titles.nth(i).inner_text().strip() == (track.get("title") or "")
                   for i in range(titles.count())), \
            "hearted track did not appear in Liked"

        before = page.locator(ROW).count()
        page.locator(ROW).first.locator(HEART_ON).click()
        page.wait_for_function(
            "(n) => document.querySelectorAll('.lib-row').length < n",
            arg=before, timeout=60_000,
        )
    finally:
        api_write("DELETE", f"/likes/song/{track['id']}")


@check
def selection_clears_on_tab_change(page):
    """Row selection is per-view and resets when the tab changes.

    Added after a refactor silently dropped the effect that does this: the
    selection bar stayed populated with ids from a tab whose rows were no
    longer on screen, which is the "Add 12 tracks, 9 of them invisible"
    foot-gun the reset exists to prevent.
    """
    goto_tab(page, "?tab=browse")
    boxes = page.locator(f"{ROW} input[type=checkbox]")
    for i in range(3):
        boxes.nth(i).click()
    assert page.locator(f"{ROW} input[type=checkbox]:checked").count() == 3, \
        "could not select three rows"

    page.locator(".lib-tab", has_text="History").first.click()
    page.wait_for_selector(TITLE, timeout=60_000)
    page.locator(".lib-tab", has_text="Browse").first.click()
    page.wait_for_selector(ROW, timeout=60_000)
    assert page.locator(f"{ROW} input[type=checkbox]:checked").count() == 0, \
        "selection survived a tab change"


@check
def history_paging(page):
    """History renders air-time rows and its pager advances the offset."""
    goto_tab(page, "?tab=history", wait=TITLE)
    rows = page.locator(TITLE).count()
    assert rows > 0, "history returned no rows"
    nxt = page.get_by_role("button", name="next", exact=False).first
    if nxt.count() and nxt.is_enabled():
        head = page.locator(TITLE).first.inner_text()
        nxt.click()
        page.wait_for_function(
            "(t) => { const r = document.querySelector('.lib-title');"
            " return r && r.innerText !== t; }",
            arg=head, timeout=60_000,
        )


@check
def blocked_marks(page):
    """Blocking a row marks it in place and lists it on the Blocked tab.

    The cross-tab half of this — restampBlockMarks reaching a list the click
    did not come from — is what the RowSource registry has to preserve.
    """
    track = (api("/library/browse?limit=1").get("rows") or [])[0]
    try:
        goto_tab(page, "?tab=browse")
        # The block control is a menu trigger, not a one-click block — the
        # scope (track / album / artist) is chosen from the popover.
        page.locator(ROW).first.locator(BLOCK_BTN).click()
        page.get_by_role("button", name="Never play this track", exact=True).click()
        page.wait_for_selector(f"{ROW} {BLOCKED_BADGE}", timeout=60_000)

        goto_tab(page, "?tab=blocked", wait=TITLE)
        assert page.get_by_text(track.get("title") or track["id"], exact=False).count() >= 1, \
            "blocked entry did not appear on the Blocked tab"
    finally:
        api_write("DELETE", f"/library/blocklist/track/{track['id']}")


@check
def retag_patches_rows(page):
    """A manual tag save patches the row in place, without a tab refetch.

    This pins the cross-tab patching the RowSource registry replaces: the row
    flashes and keeps its new tags with no reload.
    """
    track = (api("/library/browse?limit=1").get("rows") or [])[0]
    before_moods = track.get("moods") or []
    before_energy = track.get("energy")
    try:
        goto_tab(page, "?tab=browse")
        page.locator(ROW).first.locator(EDIT_BTN).click()
        page.wait_for_selector(EDITOR, timeout=30_000)
        save = page.get_by_role("button", name="Save tags", exact=True)

        # Mood chips are the only Pills in the editor carrying aria-pressed;
        # `{EDITOR} button` would also match Save, Clear and the energy Seg.
        # Their rendered text is UPPERCASED by CSS while the stored mood is
        # lowercase, so every comparison here folds case — matching on the
        # rendered label directly makes "not already selected" always true and
        # the picker re-clicks a chip that was on, deselecting it.
        chips = page.locator(f"{EDITOR} button[aria-pressed]")
        labels = [chips.nth(i).inner_text().strip().split("\n")[0].lower()
                  for i in range(chips.count())]

        # Deselect every mood the track already has, THEN pick one new one, so
        # the result is exactly [picked]. Appending instead would leave the new
        # mood at index 2+, and the row renders only moods.slice(0, 2) — the
        # save would be invisible and the assertion would fail on a working app.
        for i, label in enumerate(labels):
            if label in before_moods:
                chips.nth(i).click()

        picked = next((l for l in labels if l and l not in before_moods), None)
        assert picked, "no unselected mood chip available in the editor"
        chips.nth(labels.index(picked)).click()

        save.click()
        page.wait_for_selector(FLASHED_ROW, timeout=60_000)
        shown = page.locator(ROW).first.locator(".lib-mtag")
        texts = [shown.nth(i).inner_text().strip().lower() for i in range(shown.count())]
        assert picked in texts, \
            f"row did not show the newly saved mood without a refetch: {texts}"
    finally:
        api_write("POST", "/library/manual-tag", {
            "id": track["id"], "moods": before_moods,
            "energy": before_energy, "applyToAlbum": False,
        })


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
