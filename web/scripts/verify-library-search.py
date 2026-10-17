#!/usr/bin/env python3
"""web/scripts/verify-library-search.py

Evidence that the Library tab's search box speaks the query language end to
end: the browse route returns `readsAs`, `queryError` (message, offset, kind)
and `searched`, and the box shows them — the try-chips on an empty box, the
query read back in plain words, the plain-text fallback with a marker and a
quoted suggestion, never feedback for older keystrokes, and the `?` examples.

Usage: python3 web/scripts/verify-library-search.py

STACK. Defaults to the isolated verify stack from the `verify` skill (web on
:7793, controller on :7791, admin test:test). Point it elsewhere with
SUBWAVE_VERIFY_WEB, SUBWAVE_VERIFY_API and SUBWAVE_VERIFY_AUTH ("user:pass").

SAFE BY CONSTRUCTION. Only GET /library/browse is called; nothing is written.
The library may be empty: this checks what the box says, not which tracks match.
"""
import base64, json, os, sys, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

WEB = os.environ.get("SUBWAVE_VERIFY_WEB", "http://localhost:7793")
API = os.environ.get("SUBWAVE_VERIFY_API", "http://localhost:7791")
AUTH = base64.b64encode(
    os.environ.get("SUBWAVE_VERIFY_AUTH", "test:test").encode()
).decode()

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" — " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def browse(q):
    url = f"{API}/library/browse?" + urllib.parse.urlencode({"q": q, "limit": 1})
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {AUTH}"})
    return json.load(urllib.request.urlopen(req))


# The route.
d = browse('title:/^love/ -genre:pop')
check("route: a query comes back read in plain words",
      d.get("readsAs") == 'title starts with "love" · not genre pop (or a kind of pop)', repr(d.get("readsAs")))
check("route: a valid query has no queryError", d.get("queryError") is None)
check("route: it echoes the text it compiled", d.get("searched") == 'title:/^love/ -genre:pop', repr(d.get("searched")))
d = browse("AC/DC")
err = d.get("queryError") or {}
check("route: a name with / runs as plain text with a syntax error",
      err.get("kind") == "syntax" and err.get("offset") == 2 and '"/"' in err.get("message", ""), json.dumps(err))
check("route: no reading for plain text", d.get("readsAs") == "")
err = browse("year:>abc").get("queryError") or {}
check("route: a wrong value is a meaning error", err.get("kind") == "meaning", json.dumps(err))
check("route: an empty search has no feedback", browse("").get("searched") == "")

with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 1200, "height": 900})
    pg.add_init_script(f"localStorage.setItem('subwave_admin_auth','{AUTH}')")
    pg.goto(f"{WEB}/admin/library", wait_until="networkidle")
    pg.get_by_text("Browse", exact=True).first.click()
    box = pg.get_by_label("Search tracks")
    box.wait_for()
    hint = pg.locator("section.card", has=box).locator('[aria-live="polite"]').first

    chips = pg.locator("button.lib-chip.font-mono")
    check("empty box: three example chips", chips.count() == 3, f"found {chips.count()}")
    chips.first.click()
    pg.wait_for_timeout(1200)
    check("a chip fills the box", box.input_value() == "title:/^love/", box.input_value())
    check("the box reads the query back", 'reads as title starts with "love"' in hint.inner_text(), hint.inner_text())
    check("chips leave once the box has text", chips.count() == 0)

    box.fill("AC/DC")
    pg.wait_for_timeout(1200)
    text = hint.inner_text()
    check("plain-text fallback: the text, a marker under the /, and why",
          "AC/DC\n  ^" in text and "searched as plain text instead" in text, repr(text[:160]))
    pg.get_by_role("button", name='"AC/DC"').click()
    check("the quoted suggestion fills the box", box.input_value() == '"AC/DC"', box.input_value())

    box.fill("year:>abc")
    pg.wait_for_timeout(1200)
    text = hint.inner_text()
    check("a wrong value shows its message and no quote suggestion",
          "year takes a number" in text and "as written" not in text, repr(text[:160]))

    # Stale feedback: type fast, read at once — nothing may describe older text.
    box.fill("genre:pop")
    pg.wait_for_timeout(1200)
    box.press_sequentially(" -title:live", delay=20)
    text = hint.inner_text()
    check("feedback never describes older keystrokes",
          text == "" or "not title" in text, repr(text))

    box.fill("")
    toggle = pg.get_by_label("Query examples")
    check("? starts closed", toggle.get_attribute("aria-expanded") == "false")
    toggle.click()
    panel = pg.locator(f"#{toggle.get_attribute('aria-controls').replace(':', chr(92) + ':')}")
    check("? opens the examples and says so", toggle.get_attribute("aria-expanded") == "true" and panel.is_visible())
    panel.get_by_text("bpm:>140").click()
    pg.wait_for_timeout(1200)
    check("an example fills the box", box.input_value() == "bpm:>140", box.input_value())
    check("and reads back", "reads as bpm > 140" in hint.inner_text(), hint.inner_text())

    browser.close()

sys.exit(1 if fails else 0)
