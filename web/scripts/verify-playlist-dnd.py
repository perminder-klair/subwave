#!/usr/bin/env python3
"""web/scripts/verify-playlist-dnd.py

Evidence for the Playlist Builder's dnd-kit reorder (#1370): the three input
paths the HTML5 drag API could not serve — mouse, touch and keyboard — plus the
paths that already existed and must not regress. Not part of CI: web/ has no
test suite and the merge gate is lint.

Usage: python3 web/scripts/verify-playlist-dnd.py

STACK. The isolated verify stack from the `verify` skill — controller on :7791,
web dev server on :7793, admin creds test:test. Unlike the other verify-*
scripts this one needs NO seeded library and NO music server, and it writes
nothing anywhere: /settings, /playlists and /cover are stubbed in the browser,
and a deck reorder is local state until Save, which this never clicks.

TWO MEASUREMENT TRAPS, both learned the hard way and both guarded below.
 1. Route globs. A bare `**/playlists` also matches the page's own document
    request at /admin/playlists and serves the HTML request JSON. Scope every
    stub to the controller ORIGIN.
 2. Scrolling under a synthetic finger. A scripted drag follows fixed
    coordinates; it cannot watch the list move and adjust the way a real finger
    does, so any scroll during the drag reads as an overshoot. Two separate
    sources: dnd-kit's auto-scroll near the viewport edges (correct behaviour —
    it is how you reach a row below the fold, so drags here stay in the
    band-free middle), and a one-off ~176px document growth on the FIRST focus
    of any control in the deck, which is pre-existing (measured identically on
    the old "Move down" button) and is taken as a warm-up before measuring.
"""
import base64, json, os, sys, tempfile
from playwright.sync_api import sync_playwright

WEB = "http://localhost:7793"
AUTH = base64.b64encode(b"test:test").decode()
OUT = os.environ.get("VERIFY_SHOTS") or os.path.join(tempfile.gettempdir(), "subwave-dnd-shots")
os.makedirs(OUT, exist_ok=True)

# 6 tracks; #2 and #5 are the SAME song id — the duplicate case that rules out
# a track-id sortable id.
TRACKS = [
    {"id": "s1", "title": "Alpha",   "artist": "A1", "durationSec": 200, "energy": "low"},
    {"id": "dup", "title": "Bravo",  "artist": "A2", "durationSec": 210, "energy": "medium"},
    {"id": "s3", "title": "Charlie", "artist": "A3", "durationSec": 220, "energy": "high"},
    {"id": "s4", "title": "Delta",   "artist": "A4", "durationSec": 230, "energy": "low"},
    {"id": "dup", "title": "Bravo",  "artist": "A2", "durationSec": 210, "energy": "medium"},
    {"id": "s6", "title": "Foxtrot", "artist": "A6", "durationSec": 240, "energy": "high"},
]
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

fails = []


def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + ((" — " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def titles(page):
    return page.eval_on_selector_all(
        "[data-row] .truncate.text-sm.font-semibold", "els => els.map(e => e.textContent.trim())"
    )


API = "http://localhost:7791"


def stub(page):
    # Scope to the CONTROLLER origin: a bare `**/playlists` also matches the
    # page's own document request at /admin/playlists and serves it JSON.
    page.route(API + "/settings", lambda r: r.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"tts": {"moods": []}, "values": {}})))
    page.route(API + "/playlists", lambda r: r.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"playlists": [{"id": "p1", "name": "Verify Deck", "songCount": len(TRACKS)}]})))
    page.route(API + "/playlists/p1", lambda r: r.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"id": "p1", "name": "Verify Deck", "entries": TRACKS})))
    page.route(API + "/cover/**", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG))


def load_deck(page):
    page.goto(WEB + "/admin/playlists", wait_until="domcontentloaded")
    page.wait_for_selector("text=Browse", timeout=45000)
    page.click("text=Browse")
    page.wait_for_selector("text=Verify Deck", timeout=15000)
    page.click("text=Verify Deck")
    page.wait_for_selector("[data-row='0']", timeout=15000)
    page.wait_for_timeout(400)


def grip(page, i):
    return page.locator(f"[data-row='{i}'] button[aria-label^='Reorder']").first


def box_center(loc):
    b = loc.bounding_box()
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def mouse_drag(page, frm, to):
    x0, y0 = box_center(grip(page, frm))
    x1, y1 = box_center(grip(page, to))
    page.mouse.move(x0, y0)
    page.mouse.down()
    for k in range(1, 13):  # small steps: the MouseSensor needs 4px before it starts
        page.mouse.move(x0 + (x1 - x0) * k / 12, y0 + (y1 - y0) * k / 12)
        page.wait_for_timeout(20)
    page.mouse.up()
    page.wait_for_timeout(500)


def settle(page):
    """A scroll still in flight moves the rows under a synthetic finger and
    fakes an overshoot — wait for window.scrollY to stop changing."""
    last = None
    for _ in range(40):
        y = page.evaluate("window.scrollY")
        if y == last:
            return y
        last = y
        page.wait_for_timeout(100)
    return last


def touch_drag(page, cdp, frm, to):
    """Playwright has no touch-drag helper, so drive raw CDP touch events.
    The TouchSensor arms on a 220ms press, hence the hold before moving."""
    x0, y0 = box_center(grip(page, frm))
    x1, y1 = box_center(grip(page, to))
    s0 = page.evaluate("window.scrollY")
    print(f"    [touch] from y={y0:.0f} to y={y1:.0f} scrollY={s0} "
          f"rows={page.eval_on_selector_all('[data-row]', 'els => els.map(e => Math.round(e.getBoundingClientRect().y))')}")
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    page.wait_for_timeout(400)  # > the 220ms activation delay
    for k in range(1, 13):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
            {"x": x0 + (x1 - x0) * k / 12, "y": y0 + (y1 - y0) * k / 12}]})
        page.wait_for_timeout(25)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(500)
    print(f"    [touch] scroll delta during drag: {page.evaluate('window.scrollY') - s0}")


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------- mouse + keyboard (desktop) ----------
    ctx = browser.new_context(viewport={"width": 1400, "height": 950})
    ctx.add_init_script(f"localStorage.setItem('subwave_admin_auth', '{AUTH}')")
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    stub(page)
    load_deck(page)

    start = titles(page)
    print("\nDECK:", start)
    check("deck loaded with 6 rows", len(start) == 6, str(start))
    check("duplicate song rendered twice", start.count("Bravo") == 2)
    check("DUPLICATE badge present", page.locator("text=DUPLICATE").count() == 2)
    page.screenshot(path=OUT + "/1-deck.png")

    print("\nMOUSE")
    mouse_drag(page, 0, 3)
    after = titles(page)
    check("mouse drag row1 -> row4", after == ["Bravo", "Charlie", "Delta", "Alpha", "Bravo", "Foxtrot"], str(after))
    page.screenshot(path=OUT + "/2-after-mouse.png")

    print("\nDUPLICATE IDENTITY (drag the 2nd copy of the duplicate song)")
    before = titles(page)
    dup_rows = [i for i, t in enumerate(before) if t == "Bravo"]
    mouse_drag(page, dup_rows[1], dup_rows[1] - 1)  # 2nd Bravo up one
    moved = titles(page)
    check("2nd duplicate copy moved, 1st stayed put",
          moved == ["Bravo", "Charlie", "Delta", "Bravo", "Alpha", "Foxtrot"], str(moved))

    print("\nKEYBOARD")
    page.reload()  # the deck is local state — reload gives a clean order
    load_deck(page)
    base = titles(page)
    grip(page, 0).focus()
    focused = page.evaluate("document.activeElement.getAttribute('aria-label')")
    check("grip is focusable", (focused or "").startswith("Reorder"), str(focused))
    page.keyboard.press("Space")
    page.wait_for_timeout(250)
    live = page.locator("[role='status'], [aria-live]").all_inner_texts()
    picked = " ".join(live)
    check("screen-reader announcement names the track", "Alpha" in picked, picked.strip()[:120])
    page.screenshot(path=OUT + "/3-keyboard-picked-up.png")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(200)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(200)
    page.keyboard.press("Space")
    page.wait_for_timeout(500)
    kb = titles(page)
    check("keyboard reorder moved row1 down two",
          kb == [base[1], base[2], base[0], base[3], base[4], base[5]], f"{base} -> {kb}")
    page.screenshot(path=OUT + "/4-after-keyboard.png")

    print("\nESCAPE CANCELS")
    pre = titles(page)
    grip(page, 0).focus()
    page.keyboard.press("Space")
    page.wait_for_timeout(200)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(200)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    check("Escape leaves the order untouched", titles(page) == pre, str(titles(page)))

    print("\nEXISTING PATHS STILL WORK")
    pre = titles(page)
    page.locator("[data-row='0'] button[title='Move down']").first.click()
    page.wait_for_timeout(300)
    check("Move down button still reorders",
          titles(page) == [pre[1], pre[0]] + pre[2:], str(titles(page)))
    page.locator("[data-row='0'] button[title='Remove']").first.click()
    page.wait_for_timeout(300)
    check("Remove button still removes", len(titles(page)) == 5, str(titles(page)))

    check("no page errors", not errs, "; ".join(errs[:3]))
    ctx.close()

    # ---------- touch (mobile emulation) ----------
    print("\nTOUCH (iPhone-sized viewport, hasTouch)")
    mctx = browser.new_context(viewport={"width": 430, "height": 900}, has_touch=True,
                               is_mobile=True, device_scale_factor=2)
    mctx.add_init_script(f"localStorage.setItem('subwave_admin_auth', '{AUTH}')")
    mp = mctx.new_page()
    merrs = []
    mp.on("pageerror", lambda e: merrs.append(str(e)))
    stub(mp)
    load_deck(mp)
    cdp = mctx.new_cdp_session(mp)
    check("grip visible on a phone viewport", grip(mp, 0).is_visible())
    mp.screenshot(path=OUT + "/5-mobile-deck.png")

    # Both ends of the drag must sit clear of dnd-kit's auto-scroll bands (the
    # outer ~20% of the viewport). Auto-scroll is not a bug to assert against —
    # it is how a finger reaches a row below the fold — but it makes a SCRIPTED
    # drag non-deterministic: fixed coordinates can't watch the list move and
    # adjust the way a real finger does. Inside the band-free middle the drop
    # position is exact, which is what these two checks pin.
    def safe_rows(page, n):
        h = page.evaluate("window.innerHeight")
        lo, hi = h * 0.28, h * 0.68
        out = []
        for i in range(n):
            b = grip(page, i).bounding_box()
            if b and lo <= b["y"] + b["height"] / 2 <= hi:
                out.append(i)
        return out

    # Warm-up: the FIRST focus of any control in the deck grows the document by
    # ~176px on a narrow viewport and the page scrolls to match — measured
    # identically on the pre-existing "Move down" button, so it predates dnd-kit
    # and is not what is under test here. It happens once; take it before
    # measuring, or it lands in the middle of the first drag.
    mp.eval_on_selector("[data-row='0'] button[title='Move down']", "e => e.focus()")
    mp.wait_for_timeout(800)
    mp.eval_on_selector("[data-row='2']", "e => e.scrollIntoView({block:'center'})")
    settle(mp)
    rows = safe_rows(mp, 6)
    print("    band-free rows:", rows)
    check("at least two rows clear of the auto-scroll bands", len(rows) >= 2, str(rows))

    a, b = rows[0], rows[1]
    mstart = titles(mp)
    touch_drag(mp, cdp, a, b)               # downward, one slot
    mafter = titles(mp)
    exp = mstart[:a] + mstart[a + 1:]
    exp = exp[:b] + [mstart[a]] + exp[b:]
    check(f"touch drag row{a + 1} -> row{b + 1} (down)", mafter == exp, f"{mstart} -> {mafter}")

    mstart = titles(mp)
    touch_drag(mp, cdp, b, a)               # and back up
    mafter = titles(mp)
    exp = mstart[:b] + mstart[b + 1:]
    exp = exp[:a] + [mstart[b]] + exp[a:]
    check(f"touch drag row{b + 1} -> row{a + 1} (up)", mafter == exp, f"{mstart} -> {mafter}")
    mp.screenshot(path=OUT + "/6-after-touch.png")

    # A plain quick swipe must still scroll, not drag.
    pre = titles(mp)
    x, y = box_center(grip(mp, 0))
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for k in range(1, 6):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - k * 30}]})
        mp.wait_for_timeout(10)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    mp.wait_for_timeout(400)
    check("quick swipe on the grip does not reorder", titles(mp) == pre, str(titles(mp)))
    check("no page errors (mobile)", not merrs, "; ".join(merrs[:3]))

    mctx.close()
    browser.close()

print("\n" + ("ALL CHECKS PASSED" if not fails else "FAILED: " + ", ".join(fails)))
print("screenshots:", OUT)
sys.exit(1 if fails else 0)
