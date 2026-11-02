#!/usr/bin/env python3
"""web/scripts/verify-schedule-now-line.py

Evidence that the schedule board's "now" line marks the station's clock: one
solid line with a time tag in today's column, a dashed one at the same height in
every other column, placed at the station's minute (not the browser's), and kept
below the sticky hour rail.

Usage: python3 web/scripts/verify-schedule-now-line.py [screenshot.png]

STACK. Defaults to the isolated verify stack from the `verify` skill (web on
:7793, controller on :7791, admin test:test). Point it elsewhere with
SUBWAVE_VERIFY_WEB, SUBWAVE_VERIFY_API and SUBWAVE_VERIFY_AUTH ("user:pass").

SAFE BY CONSTRUCTION. /settings and /schedule are answered from a fixture in the
browser and only row-density controls are clicked, so no station state is written.

The clock is frozen at Wednesday 15:37 UTC and the station runs on Asia/Kolkata
(UTC+05:30), so the board must show 21:07 on Wednesday. The browser stays on
UTC: a line drawn from the browser's clock lands at 15:37, and a half-hour
offset catches a minute taken from the wrong zone.
"""
import base64, json, os, sys
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

WEB = os.environ.get("SUBWAVE_VERIFY_WEB", "http://localhost:7793")
API = os.environ.get("SUBWAVE_VERIFY_API", "http://localhost:7791")
AUTH = base64.b64encode(
    os.environ.get("SUBWAVE_VERIFY_AUTH", "test:test").encode()
).decode()
SHOT = sys.argv[1] if len(sys.argv) > 1 else None

NOW = datetime(2026, 10, 14, 15, 37, tzinfo=timezone.utc)  # a Wednesday
TODAY, EXPECT_MINUTE, EXPECT_TAG = "Wednesday", 21 * 60 + 7, "21:07"

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" — " + detail) if detail else ""))
    if not ok:
        fails.append(name)


# One evening show every day, so today's line crosses a card.
week = {str(day): [None] * 24 for day in range(7)}
for day in range(7):
    for hour in range(19, 22):
        week[str(day)][hour] = "s_verify_now"
settings = {
    "values": {
        "shows": [{
            "id": "s_verify_now", "name": "Verify Evening Show",
            "personaId": "p_verify_now", "moods": [], "energies": [],
        }],
        "schedule": week,
        "personas": [{"id": "p_verify_now", "name": "Verify DJ"}],
        "timezone": "Asia/Kolkata", "locale": "en-GB",
    },
    "serverTimezone": "Asia/Kolkata",
}

# Per day column (found by its fold button): the now line, the hour height and
# the sticky hour rail's stacking level.
MEASURE = """() => [...document.querySelectorAll('button[aria-label$=" out of the way"]')]
  .map(btn => {
    const column = btn.parentElement.parentElement;
    const hours = column.children[1]?.firstElementChild;
    const line = hours?.firstElementChild;
    if (!line || line.getAttribute('aria-hidden') !== 'true') return null;
    const tag = line.querySelector('span');
    const lb = line.getBoundingClientRect(), tb = tag?.getBoundingClientRect();
    return {
      day: btn.getAttribute('aria-label').replace('Fold ', '').replace(' out of the way', ''),
      top: line.offsetTop,
      hourPx: parseFloat(getComputedStyle(hours).getPropertyValue('--hour-px')),
      dashed: getComputedStyle(line).borderTopStyle === 'dashed',
      z: Number(getComputedStyle(line).zIndex),
      tag: tag ? tag.textContent : null,
      tagRightGap: tb ? lb.right - tb.right : null,
    };
  })
  .filter(Boolean)"""

TITLE_CLEARANCE = """() => {
  const btn = document.querySelector('button[aria-label="Fold Wednesday out of the way"]');
  const hours = btn.parentElement.parentElement.children[1].firstElementChild;
  const tag = hours.firstElementChild.querySelector('span');
  const badge = tag.getBoundingClientRect();
  const titles = [...document.querySelectorAll('button[data-schedule-run] > span:first-child')];
  const overlaps = titles.flatMap(title => {
    const range = document.createRange();
    range.selectNodeContents(title);
    const text = range.getBoundingClientRect(), box = title.getBoundingClientRect();
    const style = getComputedStyle(title);
    const left = Math.max(text.left, box.left + parseFloat(style.paddingLeft));
    const right = Math.min(text.right, box.right - parseFloat(style.paddingRight));
    const width = Math.min(right, badge.right) - Math.max(left, badge.left);
    const height = Math.min(text.bottom, badge.bottom) - Math.max(text.top, badge.top);
    return width > 0 && height > 0
      ? [{ run: title.parentElement.dataset.scheduleRun, width, height }]
      : [];
  });
  return { tag: tag.textContent, titles: titles.length, overlaps };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 1440, "height": 1100}, timezone_id="UTC")
    pg.clock.set_fixed_time(NOW)
    pg.add_init_script(f"localStorage.setItem('subwave_admin_auth','{AUTH}')")
    pg.route(API + "/settings", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(settings),
    ))
    pg.route(API + "/schedule", lambda route: route.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"schedule": week, "override": None}),
    ))
    pg.goto(f"{WEB}/admin/shows/schedule", wait_until="networkidle")
    pg.wait_for_timeout(3000)

    cols = pg.evaluate(MEASURE)
    check("a now line in all seven columns", len(cols) == 7, f"found {len(cols)}")

    today = [c for c in cols if c["day"] == TODAY]
    others = [c for c in cols if c["day"] != TODAY]
    check("today's line is solid with the station's time",
          len(today) == 1 and not today[0]["dashed"] and today[0]["tag"] == EXPECT_TAG,
          json.dumps(today))
    check("the other days are dashed and carry no tag",
          len(others) == 6 and all(c["dashed"] and c["tag"] is None for c in others),
          json.dumps([(c["day"], c["dashed"], c["tag"]) for c in others]))

    if cols:
        want = cols[0]["hourPx"] * EXPECT_MINUTE / 60
        check("every line sits at the station's minute",
              all(abs(c["top"] - want) <= 1 for c in cols),
              f"want {want:.1f}px, got {sorted({c['top'] for c in cols})}")
        check("the line stays under the sticky hour rail (z-10)",
              all(c["z"] < 10 for c in cols), f"z={cols[0]['z']}")
    if today:
        check("the tag sits at the right edge of the line",
              today[0]["tagRightGap"] is not None and abs(today[0]["tagRightGap"]) <= 1,
              f"gap={today[0]['tagRightGap']}")

    if SHOT:
        pg.screenshot(path=SHOT, full_page=True)
        print(f"screenshot: {SHOT}")

    # Half past a one-hour show puts the badge level with its centered title.
    for day in range(7):
        week[str(day)] = [None] * 24
        week[str(day)][21] = "s_verify_now"
    pg.clock.set_fixed_time(datetime(2026, 10, 14, 16, 0, tzinfo=timezone.utc))
    pg.reload(wait_until="networkidle")
    pg.locator('button[data-schedule-run="3:21"]').wait_for()
    pg.evaluate("document.fonts.ready")
    for width in (1440, 390):
        pg.set_viewport_size({"width": width, "height": 1100})
        for density in ("Roomy", "Compact"):
            pg.locator(f'button[title^="{density} rows"]').click()
            pg.wait_for_timeout(250)
            clearance = pg.evaluate(TITLE_CLEARANCE)
            check(f"{width}px {density.lower()}: the badge clears one-hour show titles",
                  clearance["tag"] == "21:30" and clearance["titles"] == 7
                  and not clearance["overlaps"], json.dumps(clearance))
    browser.close()

sys.exit(1 if fails else 0)
