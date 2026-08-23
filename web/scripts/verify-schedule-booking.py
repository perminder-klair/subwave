#!/usr/bin/env python3
"""web/scripts/verify-schedule-booking.py

Evidence that every write on the weekly schedule board confirms itself — the
gap this script was written for is that BOOKING did not. Filling a day, filling
an hour, resizing and removing all called `notify.ok`; `dropShow` did not, so
the brush (the only booking path a finger or a keyboard has) landed silently.
Sonner's toast is also the aria-live region, so that silence was a screen reader
hearing nothing for the write an operator makes most often.

Usage: python3 web/scripts/verify-schedule-booking.py

STACK. Defaults to the isolated verify stack from the `verify` skill (web on
:7793, admin test:test). Point it elsewhere with SUBWAVE_VERIFY_WEB and
SUBWAVE_VERIFY_AUTH ("user:pass") — e.g. a worktree dev stack on :7700.

SAFE BY CONSTRUCTION. It frees one run and books it straight back, and the board
is local state until Save — which this never clicks. Nothing is written to the
station.

TWO TRAPS, both hit while writing this:
 1. `button[aria-pressed]` is not the show palette. The day-group toggles in the
    order desk carry it too, and they sort first, so arming "WEEKDAYS" armed
    nothing at all and the slot silently fell through to its dropdown. Select
    the palette by its title ("Click to arm"), not by the ARIA attribute.
 2. Arming REWRITES that title, so a locator built from it re-resolves to a
    different show on the next call. Assert on the armed button, not the stale
    locator, or the check reads a neighbour's aria-pressed and fails a passing
    app.
"""
import base64, json, os, re, sys
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


def toasts(pg):
    return " | ".join(pg.locator("[data-sonner-toast]").all_inner_texts()).strip()


with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 1440, "height": 900})
    pg.add_init_script(f"localStorage.setItem('subwave_admin_auth','{AUTH}')")

    # A fresh isolated controller has no shows or bookings. Keep this check
    # safe and repeatable by supplying one browser-local programming fixture;
    # the board never clicks Save, so no station state can be changed.
    week = {str(day): [None] * 24 for day in range(7)}
    week["0"][0] = "s_verify_booking"
    week["0"][1] = "s_verify_booking"
    settings = {
        "values": {
            "shows": [{
                "id": "s_verify_booking", "name": "Verify Booking Show",
                "personaId": "p_verify_booking", "moods": [], "energies": [],
            }],
            "schedule": week,
            "personas": [{"id": "p_verify_booking", "name": "Verify DJ"}],
            "timezone": "UTC", "locale": "en-GB",
        },
        "serverTimezone": "UTC",
    }
    pg.route(API + "/settings", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(settings),
    ))
    pg.route(API + "/schedule", lambda route: route.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"schedule": week, "override": None}),
    ))
    pg.goto(f"{WEB}/admin/shows/schedule", wait_until="networkidle")
    pg.wait_for_timeout(3000)

    # A seeded week can be fully booked, so free one run to get a silent slot.
    pg.locator("button", has_text=re.compile(r"^×$")).first.click()
    pg.wait_for_timeout(1200)
    check("removing a run announces (control: worked before this change)",
          "unsaved until you save the week" in toasts(pg), toasts(pg)[:140])

    # Let it clear, so the booking assertion can only be seeing a NEW toast.
    pg.wait_for_timeout(4800)
    check("toast area clear before the booking", toasts(pg) == "", toasts(pg)[:120] or "(clear)")

    brush = pg.locator('button[title*="Click to arm"]').first
    check("show palette found", brush.count() > 0)
    name = brush.inner_text().strip().split("\n")[0]
    brush.click()
    pg.wait_for_timeout(500)
    armed = pg.locator('button[aria-pressed="true"][title*="is armed"]')
    check("show armed", armed.count() == 1, f"armed={name}, matches={armed.count()}")

    slot = pg.locator("button", has_text=re.compile(r"^\+\s")).first
    check("the silent slot shows the armed brush",
          "add a show" not in slot.inner_text().strip().lower(),
          f"slot={slot.inner_text().strip()!r}")
    slot.click()
    pg.wait_for_timeout(1200)

    check("no menu opened — an armed click writes directly",
          pg.locator("[role=menu]").count() == 0)

    t = toasts(pg)
    check("booking a single run announces",
          "unsaved until you save the week" in t, t[:220] or "(SILENT)")
    check("the announcement names the show and its hours",
          name.split()[0].lower() in t.lower() and "–" in t, t[:200])

    region = pg.locator("[aria-live]").first
    check("it lands in an aria-live region a screen reader reads",
          region.count() > 0 and region.get_attribute("aria-live") in ("polite", "assertive"),
          f"aria-live={region.get_attribute('aria-live') if region.count() else 'none'}")

    browser.close()

sys.exit(1 if fails else 0)
