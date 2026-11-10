#!/usr/bin/env python3
"""Cross-browser regression evidence for schedule run movement.

Usage:
  python3 web/scripts/verify-schedule-run-dnd.py

The script drives Chromium, Firefox, and WebKit against an isolated web dev
server (default http://127.0.0.1:7793). Controller requests are intercepted in
the browser and served from fixtures, so the script cannot write station state.

It covers two details that are easy to miss in a visual drag-and-drop check:

* Repeated occurrences of the same show keep the dragged card's DOM identity,
  focus, and subsequent keyboard action after the occurrence changes order.
* A real emulated touch stream can reorder a run. The touch case uses Chromium
  CDP because Playwright exposes touch taps, but not a portable touch-drag API.

Failures are intentionally ordinary FAIL lines and produce exit status 1. This
keeps known gaps visible rather than turning them into expected failures.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any

from playwright.sync_api import Browser, BrowserType, Page, Playwright, sync_playwright


WEB = os.environ.get("SUBWAVE_VERIFY_WEB", "http://127.0.0.1:7793")
API = os.environ.get("SUBWAVE_VERIFY_API", "http://127.0.0.1:7791")
AUTH = base64.b64encode(
    os.environ.get("SUBWAVE_VERIFY_AUTH", "test:test").encode()
).decode()
BROWSERS = {
    value.strip().lower()
    for value in os.environ.get("SUBWAVE_VERIFY_BROWSERS", "chromium,firefox,webkit").split(",")
    if value.strip()
}
SCENARIOS = {
    value.strip().lower()
    for value in os.environ.get(
        "SUBWAVE_VERIFY_SCENARIOS", "repeated,keyboard,existing,touch"
    ).split(",")
    if value.strip()
}

passes: list[str] = []
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    line = ("PASS " if ok else "FAIL ") + name
    if detail:
        line += " — " + detail
    print(line, flush=True)
    (passes if ok else failures).append(name)


def empty_week() -> dict[str, list[str | None]]:
    return {str(day): [None] * 24 for day in range(7)}


def fixture_week() -> dict[str, list[str | None]]:
    week = empty_week()
    week["1"][0] = "alpha"
    week["1"][3] = "bravo"
    week["1"][6:9] = ["alpha"] * 3
    return week


def fixture_settings(week: dict[str, list[str | None]]) -> dict[str, Any]:
    return {
        "values": {
            "shows": [
                {
                    "id": "alpha",
                    "name": "Alpha",
                    "personaId": "presenter",
                    "moods": [],
                    "energies": [],
                },
                {
                    "id": "bravo",
                    "name": "Bravo",
                    "personaId": "presenter",
                    "moods": [],
                    "energies": [],
                },
            ],
            "schedule": week,
            "personas": [{"id": "presenter", "name": "Verify DJ"}],
            "timezone": "UTC",
            "locale": "en-GB",
        },
        "serverTimezone": "UTC",
    }


def install_fixture(page: Page, week: dict[str, list[str | None]]) -> None:
    settings = fixture_settings(week)

    def controller_fixture(route: Any) -> None:
        path = route.request.url.removeprefix(API)
        if path == "/settings":
            body = settings
        elif path == "/schedule":
            body = {"schedule": week, "override": None}
        elif path == "/themes":
            body = {
                "themes": [], "active": None, "activeSource": None,
                "stationDefault": None, "activeShow": None,
            }
        else:
            route.fulfill(
                status=404,
                content_type="application/json",
                body=json.dumps({"error": "not part of this isolated fixture"}),
            )
            return
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(body),
        )

    page.route(API + "/**", controller_fixture)
    page.add_init_script(
        f"localStorage.setItem('subwave_admin_auth', {json.dumps(AUTH)})"
    )


def open_schedule(
    page: Page,
    week: dict[str, list[str | None]],
    ready_title: str,
) -> None:
    install_fixture(page, week)
    page.goto(f"{WEB}/admin/shows/schedule", wait_until="networkidle")
    page.locator(f'button[title^="{ready_title}"]').wait_for()


def card_titles(page: Page) -> list[str]:
    return sorted(
        title
        for title in page.locator('button[data-schedule-run]').evaluate_all(
            "els => els.map(el => el.getAttribute('title'))"
        )
        if title
    )


def has_ranges(titles: list[str], ranges: list[str]) -> bool:
    return all(any(title.startswith(wanted) for title in titles) for wanted in ranges)


def settle_scroll(page: Page) -> int | float:
    """Wait until touch-scroll momentum has stopped moving the board."""
    last: int | float | None = None
    for _ in range(40):
        current = page.evaluate("window.scrollY")
        if current == last:
            return current
        last = current
        page.wait_for_timeout(100)
    return last or 0


def mouse_drag(page: Page, source: Any, target: Any) -> None:
    """Drive pointer movement rather than the browser's native DragEvent API."""
    source_handle = source.locator("xpath=..").locator("[data-schedule-drag-handle]")
    source_box = source_handle.bounding_box()
    target_box = target.bounding_box()
    if not source_box or not target_box:
        raise RuntimeError("could not resolve mouse drag coordinates")
    x0 = source_box["x"] + source_box["width"] / 2
    y0 = source_box["y"] + source_box["height"] / 2
    x1 = target_box["x"] + target_box["width"] / 2
    y1 = target_box["y"] + target_box["height"] / 2
    page.mouse.move(x0, y0)
    page.mouse.down()
    for step in range(1, 13):
        frac = step / 12
        page.mouse.move(x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac)
        page.wait_for_timeout(20)
    page.mouse.up()


def exercise_repeated_identity(browser_name: str, browser: Browser) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        open_schedule(page, fixture_week(), "Alpha · 00 – 01")
        source = page.locator('button[title^="Alpha · 06 – 09"]')
        target = page.locator('button[title^="Alpha · 00 – 01"]')
        source.focus()
        source.evaluate("el => window.__draggedScheduleNode = el.parentElement")
        mouse_drag(page, source, target)
        page.wait_for_timeout(450)

        titles = card_titles(page)
        reordered = ["Alpha · 00 – 03", "Alpha · 05 – 06", "Bravo · 08 – 09"]
        check(
            f"{browser_name}: repeated-show drag applies the requested reorder",
            has_ranges(titles, reordered),
            "; ".join(title.split(" — ")[0] for title in titles),
        )

        moved = page.locator('button[title^="Alpha · 00 – 03"]')
        check(
            f"{browser_name}: moved repeated run keeps its DOM identity through commit",
            moved.evaluate("el => el.parentElement === window.__draggedScheduleNode"),
        )

        active = page.evaluate(
            "document.activeElement && document.activeElement.getAttribute('title')"
        )
        check(
            f"{browser_name}: focus follows the dragged repeated occurrence",
            isinstance(active, str) and active.startswith("Alpha · 00 – 03"),
            f"active={active!r}",
        )

        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(300)
        nudged = card_titles(page)
        expected_nudge = ["Alpha · 01 – 04", "Alpha · 05 – 06", "Bravo · 08 – 09"]
        check(
            f"{browser_name}: next keypress moves that same repeated occurrence",
            has_ranges(nudged, expected_nudge),
            "; ".join(title.split(" — ")[0] for title in nudged),
        )
        check(f"{browser_name}: repeated-show path has no page errors", not errors, "; ".join(errors))
    except Exception as exc:  # keep one browser failure from hiding the rest
        check(f"{browser_name}: repeated-show scenario completed", False, repr(exc))
    finally:
        page.close()


def exercise_keyboard_control(browser_name: str, browser: Browser) -> None:
    week = empty_week()
    week["1"][2:4] = ["alpha"] * 2
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        open_schedule(page, week, "Alpha · 02 – 04")
        page.locator('button[title^="Alpha · 02 – 04"]').focus()
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(300)
        titles = card_titles(page)
        check(
            f"{browser_name}: keyboard nudge remains available",
            has_ranges(titles, ["Alpha · 03 – 05"]),
            "; ".join(title.split(" — ")[0] for title in titles),
        )

        # The focusable grip uses dnd-kit's KeyboardSensor as well as its
        # Mouse/Touch sensors. Reload the fixture so this is independent of the
        # direct card-arrow shortcut above.
        page.reload(wait_until="networkidle")
        source = page.locator('button[title^="Alpha · 02 – 04"]')
        source.wait_for()
        grip = source.locator("xpath=..").locator("[data-schedule-drag-handle]")
        grip.focus()
        page.keyboard.press("Space")
        page.wait_for_timeout(100)
        check(
            f"{browser_name}: keyboard can pick up the drag grip",
            grip.get_attribute("aria-pressed") == "true",
        )
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(250)
        page.keyboard.press("Space")
        page.wait_for_timeout(300)
        titles = card_titles(page)
        check(
            f"{browser_name}: keyboard drag moves through the same planner",
            has_ranges(titles, ["Alpha · 03 – 05"]),
            "; ".join(title.split(" — ")[0] for title in titles),
        )
        active = page.evaluate(
            "document.activeElement && document.activeElement.getAttribute('title')"
        )
        check(
            f"{browser_name}: keyboard drag restores focus to the moved card",
            isinstance(active, str) and active.startswith("Alpha · 03 – 05"),
            f"active={active!r}",
        )
        check(f"{browser_name}: keyboard path has no page errors", not errors, "; ".join(errors))
    except Exception as exc:
        check(f"{browser_name}: keyboard scenario completed", False, repr(exc))
    finally:
        page.close()


def exercise_existing_paths(browser_name: str, browser: Browser) -> None:
    """Ensure the new run sensor does not consume resize or shelf HTML DnD."""

    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        open_schedule(page, fixture_week(), "Alpha · 00 – 01")
        source = page.locator('button[title^="Alpha · 00 – 01"]')
        resize = source.locator("xpath=..").get_by_role(
            "button", name="Move the end of “Alpha” — currently 01:00"
        )
        box = resize.bounding_box()
        if not box:
            raise RuntimeError("could not resolve resize handle coordinates")
        x = box["x"] + box["width"] / 2
        y = box["y"] + box["height"] / 2
        hour_px = source.evaluate(
            "el => parseFloat(getComputedStyle(el.closest('[style*=\"--hour-px\"]'))"
            ".getPropertyValue('--hour-px'))"
        )
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x, y + hour_px)
        page.mouse.up()
        page.wait_for_timeout(300)
        check(
            f"{browser_name}: pointer edge-resize remains available",
            has_ranges(card_titles(page), ["Alpha · 00 – 02"]),
        )

        page.reload(wait_until="networkidle")
        page.locator('button[title^="Alpha · 00 – 01"]').wait_for()
        shelf = page.locator('button[title*="drag it onto the board"]', has_text="Bravo")
        target = page.locator('button[title^="Silent 01 – 03"]')
        shelf.drag_to(target)
        page.wait_for_timeout(300)
        check(
            f"{browser_name}: shelf HTML drag still books a silent run",
            has_ranges(card_titles(page), ["Bravo · 01 – 04"]),
        )
        check(f"{browser_name}: existing paths have no page errors", not errors, "; ".join(errors))
    except Exception as exc:
        check(f"{browser_name}: existing schedule paths completed", False, repr(exc))
    finally:
        page.close()


def exercise_browser(browser_name: str, browser_type: BrowserType) -> None:
    try:
        browser = browser_type.launch()
    except Exception as exc:
        check(f"{browser_name}: browser launches", False, repr(exc))
        return
    try:
        if "repeated" in SCENARIOS:
            exercise_repeated_identity(browser_name, browser)
        if "keyboard" in SCENARIOS:
            exercise_keyboard_control(browser_name, browser)
        if "existing" in SCENARIOS:
            exercise_existing_paths(browser_name, browser)
    finally:
        browser.close()


def exercise_touch(playwright: Playwright) -> None:
    """Deliver a genuine touch stream and require it to move the run."""

    browser = playwright.chromium.launch()
    context = browser.new_context(
        viewport={"width": 390, "height": 844},
        has_touch=True,
        is_mobile=True,
        device_scale_factor=2,
    )
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(
        """
        window.__scheduleTouchEvidence = {touchstart: 0, touchmove: 0, touchend: 0,
                                          dragstart: 0, drop: 0};
        for (const type of Object.keys(window.__scheduleTouchEvidence)) {
          document.addEventListener(type, () => window.__scheduleTouchEvidence[type]++, true);
        }
        """
    )
    try:
        open_schedule(page, fixture_week(), "Alpha · 00 – 01")
        source = page.locator('button[title^="Alpha · 00 – 01"]')
        target = page.locator('button[title^="Bravo · 03 – 04"]')
        source.evaluate("el => el.scrollIntoView({block: 'center'})")
        settle_scroll(page)

        # A short tap remains the existing edit gesture; the long-press sensor
        # must not consume it merely because the same button is draggable.
        drag_handle = source.locator("xpath=..").locator("[data-schedule-drag-handle]")
        check(
            "Chromium mobile: the touch drag handle is visible",
            drag_handle.is_visible(),
        )
        handle_box = drag_handle.bounding_box()
        check(
            "Chromium mobile: the drag handle has a usable touch target",
            bool(handle_box and handle_box["width"] >= 28 and handle_box["height"] >= 28),
            json.dumps(handle_box, sort_keys=True) if handle_box else "no box",
        )
        source_box = source.bounding_box()
        if not source_box:
            raise RuntimeError("could not resolve touch tap coordinates")
        page.touchscreen.tap(
            source_box["x"] + source_box["width"] / 2,
            source_box["y"] + source_box["height"] / 2,
        )
        page.wait_for_timeout(500)
        check(
            "Chromium mobile: a quick card tap still loads the order desk",
            page.get_by_text(
                "Monday 00:00 → 01:00 is currently Alpha", exact=False,
            ).count() > 0,
        )

        # Moving before the long-press delay must remain an ordinary page
        # swipe. This is the reason the app uses separate Mouse/Touch sensors.
        swipe = page.locator('button[title^="Alpha · 06 – 09"]')
        swipe.scroll_into_view_if_needed()
        page.wait_for_timeout(500)
        swipe_box = swipe.bounding_box()
        if not swipe_box:
            raise RuntimeError("could not resolve quick-swipe coordinates")
        sx = swipe_box["x"] + swipe_box["width"] / 2
        sy = swipe_box["y"] + swipe_box["height"] / 2
        before_swipe = card_titles(page)
        scroll_before = page.evaluate("window.scrollY")
        session = context.new_cdp_session(page)
        session.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": sx, "y": sy}],
        })
        for step in range(1, 6):
            session.send("Input.dispatchTouchEvent", {
                "type": "touchMove",
                "touchPoints": [{"x": sx, "y": sy - step * 24}],
            })
            page.wait_for_timeout(10)
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(600)
        scroll_after = page.evaluate("window.scrollY")
        check(
            "Chromium mobile: a quick card swipe scrolls without reordering",
            card_titles(page) == before_swipe and abs(scroll_after - scroll_before) > 20,
            f"scroll={scroll_before}->{scroll_after}",
        )

        source.evaluate("el => el.scrollIntoView({block: 'center'})")
        settle_scroll(page)
        source_box = drag_handle.bounding_box()
        target_box = target.bounding_box()
        if not source_box or not target_box:
            raise RuntimeError("could not resolve touch drag coordinates")

        x0 = source_box["x"] + source_box["width"] / 2
        y0 = source_box["y"] + source_box["height"] / 2
        x1 = target_box["x"] + target_box["width"] / 2
        y1 = target_box["y"] + target_box["height"] / 2
        def point(x: float, y: float) -> dict[str, float | int]:
            return {
                "x": x,
                "y": y,
                "radiusX": 2,
                "radiusY": 2,
                "force": 1,
                "id": 1,
            }

        session.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [point(x0, y0)],
        })
        page.wait_for_timeout(350)  # exceeds the TouchSensor's 220ms delay
        activated = drag_handle.get_attribute("aria-pressed")
        for step in range(1, 13):
            frac = step / 12
            session.send("Input.dispatchTouchEvent", {
                "type": "touchMove",
                "touchPoints": [point(x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac)],
            })
            page.wait_for_timeout(35)
        during_titles = card_titles(page)
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(600)

        evidence = page.evaluate("window.__scheduleTouchEvidence")
        check(
            "Chromium mobile: emulation delivered a real touch drag stream",
            evidence["touchstart"] > 0 and evidence["touchmove"] > 0 and evidence["touchend"] > 0,
            json.dumps(evidence, sort_keys=True),
        )
        titles = card_titles(page)
        check(
            "Chromium mobile: touch drag reorders a scheduled run",
            has_ranges(titles, ["Bravo · 00 – 01", "Alpha · 03 – 04", "Alpha · 06 – 09"]),
            f"activated={activated!r}; from=({x0:.0f},{y0:.0f}); "
            f"to=({x1:.0f},{y1:.0f}); preview="
            + ", ".join(title.split(" — ")[0] for title in during_titles) + "; "
            + json.dumps(evidence, sort_keys=True) + "; "
            + "; ".join(title.split(" — ")[0] for title in titles),
        )
        check("Chromium mobile: touch path has no page errors", not errors, "; ".join(errors))
    except Exception as exc:
        check("Chromium mobile: touch scenario completed", False, repr(exc))
    finally:
        context.close()
        browser.close()


with sync_playwright() as playwright:
    for name, browser_type in (
        ("Chromium", playwright.chromium),
        ("Firefox", playwright.firefox),
        ("WebKit", playwright.webkit),
    ):
        if name.lower() in BROWSERS:
            exercise_browser(name, browser_type)
    if "touch" in SCENARIOS and "chromium" in BROWSERS:
        exercise_touch(playwright)

print(f"RESULT pass={len(passes)} fail={len(failures)} total={len(passes) + len(failures)}")
if failures:
    print("FAILED CHECKS:")
    for failure in failures:
        print(f"- {failure}")

sys.exit(1 if failures else 0)
