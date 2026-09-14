#!/usr/bin/env python3
"""Real-controller schedule save/reload evidence for PR #1642.

The caller must point this at a disposable controller whose background services
and provider calls were disabled before boot. Unlike the drag regression script,
this file does not intercept requests: setup, PUT /schedule, browser save and
reload all cross the real HTTP/storage boundary.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request
from typing import Any

from playwright.sync_api import sync_playwright


WEB = os.environ.get("SUBWAVE_VERIFY_WEB", "http://127.0.0.1:7793")
API = os.environ.get("SUBWAVE_VERIFY_API", "http://127.0.0.1:7791")
AUTH_RAW = os.environ.get("SUBWAVE_VERIFY_AUTH", "test:test")
AUTH = base64.b64encode(AUTH_RAW.encode()).decode()

passes: list[str] = []
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    line = ("PASS " if ok else "FAIL ") + name
    if detail:
        line += " — " + detail
    print(line, flush=True)
    (passes if ok else failures).append(name)


def api(method: str, path: str, body: Any | None = None) -> Any:
    payload = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        API + path,
        data=payload,
        method=method,
        headers={
            "Authorization": "Basic " + AUTH,
            **({"Content-Type": "application/json"} if payload is not None else {}),
        },
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def empty_week() -> dict[str, list[str | None]]:
    return {str(day): [None] * 24 for day in range(7)}


week = empty_week()
week["1"][0] = "alpha"
week["1"][3] = "bravo"
week["1"][6:9] = ["alpha"] * 3

try:
    for show_id, name in (("alpha", "Alpha"), ("bravo", "Bravo")):
        api("POST", "/shows", {
            "show": {"id": show_id, "name": name, "personaId": "p_default0"},
        })
    seeded = api("PUT", "/schedule", {"schedule": week})
    check(
        "disposable controller accepts the seeded repeated-show schedule",
        seeded["schedule"]["1"] == week["1"],
    )
except Exception as exc:
    check("disposable controller fixture setup completed", False, repr(exc))
    print(f"RESULT pass={len(passes)} fail={len(failures)} total={len(passes) + len(failures)}")
    sys.exit(1)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    browser_errors: list[str] = []
    controller_responses: list[str] = []
    page.on("pageerror", lambda error: browser_errors.append(str(error)))
    page.on(
        "response",
        lambda response: controller_responses.append(
            f"{response.request.method} {response.url.removeprefix(API)}={response.status}"
        ) if response.url.startswith(API) else None,
    )
    page.add_init_script(
        f"localStorage.setItem('subwave_admin_auth', {json.dumps(AUTH)})"
    )
    try:
        page.goto(WEB + "/admin/shows/schedule", wait_until="networkidle")
        source = page.locator('button[title^="Alpha · 06 – 09"]')
        target = page.locator('button[title^="Alpha · 00 – 01"]')
        source.wait_for()
        handle = source.locator("xpath=..").locator("[data-schedule-drag-handle]")
        source_box = handle.bounding_box()
        target_box = target.bounding_box()
        if not source_box or not target_box:
            raise RuntimeError("could not resolve drag coordinates")
        x0 = source_box["x"] + source_box["width"] / 2
        y0 = source_box["y"] + source_box["height"] / 2
        x1 = target_box["x"] + target_box["width"] / 2
        y1 = target_box["y"] + target_box["height"] / 2
        page.mouse.move(x0, y0)
        page.mouse.down()
        for step in range(1, 13):
            fraction = step / 12
            page.mouse.move(
                x0 + (x1 - x0) * fraction,
                y0 + (y1 - y0) * fraction,
            )
            page.wait_for_timeout(20)
        page.mouse.up()
        page.wait_for_timeout(300)

        with page.expect_response(
            lambda response: response.url == API + "/schedule"
            and response.request.method == "PUT"
            and response.status == 200
        ):
            page.get_by_role("button", name="Save the week").first.click()
        page.get_by_text("Week saved", exact=False).wait_for()
        check("browser saves the moved run through the real controller", True)

        page.reload(wait_until="networkidle")
        expected = ("Alpha · 00 – 03", "Alpha · 05 – 06", "Bravo · 08 – 09")
        reloaded = [
            title
            for title in page.locator("button[data-schedule-run]").evaluate_all(
                "els => els.map(el => el.getAttribute('title'))"
            )
            if title
        ]
        check(
            "browser reload reads the saved schedule back",
            all(any(title.startswith(prefix) for title in reloaded) for prefix in expected),
            "; ".join(title.split(" — ")[0] for title in sorted(reloaded)),
        )

        stored = api("GET", "/schedule")["schedule"]["1"]
        wanted = ["alpha"] * 3 + [None] * 2 + ["alpha"] + [None] * 2 + ["bravo"] + [None] * 15
        check("GET /schedule exposes the exact persisted cells", stored == wanted)
    except Exception as exc:
        body = page.locator("body").inner_text()[:300].replace("\n", " | ")
        detail = (
            f"{exc!r}; responses={controller_responses}; "
            f"page_errors={browser_errors}; body={body!r}"
        )
        check("real-controller browser persistence scenario completed", False, detail)
    finally:
        browser.close()

print(f"RESULT pass={len(passes)} fail={len(failures)} total={len(passes) + len(failures)}")
if failures:
    print("FAILED CHECKS:")
    for failure in failures:
        print("- " + failure)
sys.exit(1 if failures else 0)
