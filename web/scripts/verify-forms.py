"""web/scripts/verify-forms.py

Drives the isolated verify stack (controller :7791, web :7793) through every
form converted to react-hook-form. Not part of CI — web/ has no test suite
and the merge gate is lint. This is the evidence for a forms PR; run it
after touching any converted form.

Usage: SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1 python3 web/scripts/verify-forms.py [check ...]
Every check in CHECKS runs with no args; name one or more to run a subset.
Every check does DESTRUCTIVE writes (takeovers, whole-array replaces,
create/delete fixtures) authenticated as test/test — see
assert_throwaway_stack() for why the guard is a plain env-var opt-in
(SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1) rather than an inferred check.

THE FOUR-STEP SHAPE. Most @check functions drive the same rough arc, though
not every step applies to every form:
  1. Load — navigate, wait for hydration from a real GET, confirm a stored
     value actually reached the bound field.
  2. Validate — drive an actual value through an actual input to trip a
     real client-side rule, and confirm Save/submit disables.
  3. Save — a valid value clears the refusal and a REAL round trip
     persists it, confirmed by reading it back through api() — never trust
     a client-side state flip alone. A server-only rule (an orphan guard,
     a duplicate slug) gets driven for real too, and its refusal must land
     on the right field via assert_field_error/applyServerFieldErrors, not
     a toast standing in for a field message.
  4. Poll-safety — ONLY for panels with a live polling refresh. Call
     page.clock.install() as the FIRST line of the check, before
     page.goto — installed later, the poll's setInterval is created
     outside the fake clock's control and fast_forward can't reach it.
     Always pass assert_survives_poll an explicit seconds= matching the
     panel's REAL interval: its seconds=35 default is calibrated for
     TakeoverCard's 30s poll and proves nothing against a different one
     (see the imaging check's 3s coverage).

SEED AND TEARDOWN. A check that creates a named fixture must best-effort
pre-clean that same name at the top (a prior run may have crashed before
its own teardown) and delete it in a `finally:` (so THIS run can't leave
litter either). Use find_by_name/find_show for the lookup — don't hand-roll
another loop-and-compare.

ID-SCOPED ASSERTIONS, the one convention in this file. Never wait on a bare
page-wide `[aria-invalid="true"]` or `text=must be…` selector — both pass
just as easily when a DIFFERENT field broke. Every wait on invalid state
goes through wait_for_invalid(page, locator), and every message check
through assert_field_error(page, locator, text), both scoped to the
locator's OWN id (a plain field) or aria-labelledby (a group control —
fieldAria's groupProps carries no id, see lib/form.ts).
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

WEB = "http://localhost:7793"
API = "http://localhost:7791"
AUTH = base64.b64encode(b"test:test").decode()

WEB_DIR = Path(__file__).resolve().parents[1]
CONTROLLER_DIR = WEB_DIR.parent / "controller"


def api(path):
    """Read state back through the controller, never through a toast."""
    out = subprocess.run(
        ["curl", "-s", "-u", "test:test", f"{API}{path}"],
        capture_output=True, text=True, check=True,
    )
    return out.stdout


def api_write(method, path, body=None, ok_statuses=None):
    """POST/PUT/DELETE through the same curl mechanism as `api()` — for a
    check to seed or tear down its OWN fixtures rather than depending on a
    human to run curl separately outside the script.

    `check=True` on the subprocess only proves curl itself ran — it says
    nothing about the HTTP response. A seed that 4xx/5xx's used to sail
    through silently, dropping the calling check straight into a full-timeout
    hang (waiting on a fixture that was never actually created) with no
    evidence pointing at the real cause. This asks curl for the status code
    (`-w`) alongside the body and raises on anything outside 200-299, naming
    the method, path and status — so a broken seed fails at the seed, not 30s
    later at some unrelated `wait_for_selector`.

    A caller that genuinely expects a non-2xx (a best-effort delete-before-
    seed, where "nothing to delete yet" is a normal 404) passes the codes it
    accepts via `ok_statuses`, e.g. `ok_statuses=(200, 404)`.
    """
    cmd = [
        "curl", "-s", "-u", "test:test", "-X", method,
        "-w", "\n%{http_code}", f"{API}{path}",
    ]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    stdout, _, status = out.stdout.rpartition("\n")
    ok = set(ok_statuses) if ok_statuses is not None else range(200, 300)
    if int(status) not in ok:
        raise RuntimeError(
            f"api_write {method} {path} -> HTTP {status}: {stdout.strip()[:500]}"
        )
    return stdout


def new_page(pw):
    browser = pw.chromium.launch()
    ctx = browser.new_context()
    # Before load: signing in through the form races a delayed /admin/dash push.
    ctx.add_init_script(
        f"localStorage.setItem('subwave_admin_auth', '{AUTH}')"
    )
    return browser, ctx.new_page()


def assert_aria(page, locator):
    """Assertion 2's teeth: an invalid control must point at an id that is
    really in the DOM. A dangling aria-describedby (or aria-labelledby) is
    worse than none.

    Resolved via an attribute selector (`[id="..."]`), never a bare `#id` CSS
    selector: a legal DOM id can contain characters that are CSS-selector
    metacharacters (`festivals.0.name-error` has dots, which start a class
    selector), and `page.locator(f"#{token}")` then silently matches nothing
    even though the element is really there (verified directly:
    `page.set_content('<div id="foo.bar">')` then `page.locator("#foo.bar")`
    is a 0-count match on a page that unambiguously has that id). The a11y
    machinery that actually consumes this id at runtime — getElementById,
    aria-describedby/aria-labelledby resolution, the accessibility tree —
    does plain string matching, not CSS-selector parsing, so a dotted id is
    completely valid there; only the naive selector was wrong, and
    `[id="..."]` matches by exact attribute value with no such parsing.

    Checks BOTH aria-describedby and aria-labelledby — a group control (chips,
    checkboxes) names itself via aria-labelledby (fieldAria's groupProps),
    since htmlFor can't point at a <div>. A group that spreads groupProps but
    never renders the paired `-label` id (fieldAria's labelledByProps on a
    FieldTitle/Label) is exactly as broken as a dangling aria-describedby —
    two checkbox groups in ShowEditor shipped that way and survived twelve
    reviews because this function only ever looked at aria-describedby.
    """
    assert locator.get_attribute("aria-invalid") == "true", "aria-invalid not set"
    described = locator.get_attribute("aria-describedby")
    assert described, "aria-describedby missing on an invalid control"
    for token in described.split():
        assert page.locator(f'[id="{token}"]').count() == 1, f"dangling id: {token}"
    labelled = locator.get_attribute("aria-labelledby")
    if labelled:
        for token in labelled.split():
            assert page.locator(f'[id="{token}"]').count() == 1, f"dangling id: {token}"


def assert_survives_poll(page, locator, expected, seconds=35):
    """Proves a form value survives a REAL poll tick — not that a couple of
    real seconds passed uneventfully.

    This exists because a naive version of this assertion cannot fail. A
    dispatched `window.dispatchEvent(new Event('focus'))` plus a short
    `wait_for_timeout` looks like it re-triggers the poll, but two things make
    it a no-op: (1) the poll effects here are bare `setInterval(tick, 30_000)`
    calls with no `focus`/`visibilitychange` listener at all — nothing is
    listening for that event — and (2) even a real listener wouldn't fire
    within a couple of real seconds against a 30s+ interval. A check that
    passes whether or not the poll ever runs proves nothing about the bug it
    exists to catch (a stray `values` prop re-seeding the form on every poll).

    The caller must install a fake clock (`page.clock.install()`) BEFORE
    `page.goto`, so every timer the page schedules — including the poll's
    `setInterval` — is one Playwright controls. This jumps the clock past the
    real interval so the tick's callback genuinely fires while `locator` still
    holds `expected`, then waits on REAL wall-clock time (fast-forwarding the
    virtual clock does not speed up the still-real network fetch inside that
    tick) for the refetch and re-render to land, and only then asserts the
    value is untouched.
    """
    page.clock.fast_forward(seconds * 1000)
    page.wait_for_timeout(1500)
    actual = locator.input_value()
    assert actual == expected, (
        f"poll clobbered operator input: expected {expected!r}, got {actual!r}"
    )


def wait_for_invalid(page, locator, invalid=True, timeout=None):
    """Waits for THIS specific control (or group) to reach the given
    aria-invalid state — the module's one convention for waiting on invalid
    state (see the module docstring). Never a bare page-wide
    `[aria-invalid="true"]` (matches ANY invalid field on the page, not
    necessarily `locator`) or a `text=must be…` match (matches the message
    wherever it renders, which proves nothing about attribution) — both of
    those used to coexist with this scoped form and two others across the
    file; this is the one that survived.

    Scopes off whichever real attribute `locator` actually carries: a plain
    field's `id` (fieldAria's `controlProps` — always present, invalid or
    not), or a group control's `aria-labelledby` (fieldAria's `groupProps`,
    which carries no `id` at all — see the comment on `fieldAria` in
    `lib/form.ts`). Both are read live off `locator`, so a caller may hand
    this a suffix-selector locator (`dialog.locator('[aria-labelledby$="-values-label"]')`)
    just as well as an exact one; only the CURRENT match's own attribute
    value is used to build the poll selector.
    """
    field_id = locator.get_attribute("id")
    if field_id:
        scope = f'[id="{field_id}"]'
    else:
        labelledby = locator.get_attribute("aria-labelledby")
        assert labelledby, "locator has neither an id nor aria-labelledby to scope the wait on"
        scope = f'[aria-labelledby="{labelledby}"]'
    state = "attached" if invalid else "detached"
    kwargs = {"state": state}
    if timeout is not None:
        kwargs["timeout"] = timeout
    page.wait_for_selector(f'{scope}[aria-invalid="true"]', **kwargs)


def assert_field_error(page, locator, expected_text):
    """Reads the `-error` id off `locator`'s OWN `aria-describedby` and
    asserts its rendered text contains `expected_text` — the "read the
    -error id off aria-describedby, then assert its text" idiom that used
    to be copied out by hand at 8 call sites across this file (a duplicate:
    `remove temp` chip work, a slug refusal, a persona tts refusal, a show
    host/track-length/guest refusal, a playlist name cap…). Proves the
    message is attributed to THIS control, never a bare page-wide
    `text=…` match, which passes just as easily if a different field
    happens to render the same string. Returns the resolved error id for a
    caller that wants to chain a further assertion on it (see festivals()'s
    dotted-id proof, which needs the raw `aria-describedby` value itself,
    not just this helper's pass/fail).
    """
    described = locator.get_attribute("aria-describedby")
    assert described, "aria-describedby missing on an invalid control"
    error_ids = [t for t in described.split() if t.endswith("-error")]
    assert error_ids, f"no -error id in aria-describedby: {described!r}"
    error_id = error_ids[0]
    text = page.locator(f'[id="{error_id}"]').inner_text()
    assert expected_text in text, f"expected {expected_text!r} in error text, got {text!r}"
    return error_id


def find_by_name(path, list_path, name, name_key="name"):
    """Generic 'find the fixture I seeded, by name' finder — the shape that
    used to be hand-rolled per check (a GET, a walk into a nested list, a
    linear scan comparing one field) for shows, personas, sound effects and
    blocklist rules alike. `list_path` is a dot-separated walk into the
    JSON response to the list being searched (e.g. `"values.shows"`,
    `"sfx"`, `"rules"`); `name_key` is the field compared against `name`
    (blocklist rules are keyed by `label`, not `name`). Returns the whole
    matched item, or None.
    """
    data = json.loads(api(path))
    for key in list_path.split("."):
        data = data.get(key) if isinstance(data, dict) else None
    for item in data or []:
        if item.get(name_key) == name:
            return item
    return None


def find_show(name):
    """Shared by takeover() and shows() — both used to carry a byte-
    identical nested `find_show` closure."""
    return find_by_name("/settings", "values.shows", name)


CHECKS = {}


def check(fn):
    CHECKS[fn.__name__] = fn
    return fn


TAKEOVER_SHOW_NAME = "Verify Takeover Show"


@check
def stream_buffer(page):
    """The listener buffer control round-trips the advertised Icecast depth.

    This is the timing value that listener-facing titles and voice events use,
    so the UI must save through the real /settings route and surface the
    controller's existing 0-60 validation rather than applying a second rule.
    """
    original = json.loads(api("/settings"))["values"]["stream"]["bufferSeconds"]

    try:
        page.goto(f"{WEB}/admin/settings?section=danger")
        page.wait_for_selector("text=Stream MP3 bitrate")

        seconds = page.get_by_label("Listener buffer (seconds)")
        assert seconds.input_value() == str(original), (
            f"buffer field hydrated as {seconds.input_value()!r}, want {original!r}"
        )

        # The controller owns the range. Prove its fieldErrors response lands
        # beside this input and the rejected value is not persisted.
        seconds.fill("61")
        with page.expect_response(
            lambda r: r.url.endswith("/settings") and r.request.method == "POST"
        ) as refused_info:
            page.get_by_role("button", name="Save listener buffer").click()
        assert refused_info.value.status == 400, (
            f"out-of-range save returned HTTP {refused_info.value.status}, want 400"
        )
        field = seconds.locator(
            "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' field ')][1]"
        )
        field.get_by_text("stream.bufferSeconds must be a number between 0 and 60").wait_for()
        after_refusal = json.loads(api("/settings"))["values"]["stream"]["bufferSeconds"]
        assert after_refusal == original, "rejected buffer value was persisted"

        # A valid save persists the exact value and reports the broadcast
        # restart the Icecast template needs before the new burst takes effect.
        seconds.fill("17")
        with page.expect_response(
            lambda r: r.url.endswith("/settings") and r.request.method == "POST"
        ) as saved_info:
            page.get_by_role("button", name="Save listener buffer").click()
        saved = saved_info.value
        assert saved.status == 200, f"valid save returned HTTP {saved.status}, want 200"
        assert saved.json().get("requiresRestart") is True, "save did not request a restart"
        stored = json.loads(api("/settings"))["values"]["stream"]["bufferSeconds"]
        assert stored == 17, f"buffer save stored {stored!r}, want 17"
        page.get_by_text("Pending settings need a restart to apply.").wait_for()
    finally:
        api_write("POST", "/settings", {"stream": {"bufferSeconds": original}})


@check
def takeover(page):
    """TakeoverCard (Task 2) renders NOTHING to interact with — not "Pin a
    show", not "Takeover minutes" — when `shows.length === 0`
    (TakeoverCard.tsx:186-192 falls to the "no shows to pin" branch), so
    every assertion below needs at least one real show to exist first. This
    check used to pass by silently riding a show shows() left behind before
    that check's own teardown was fixed (commit f94c0738); now that shows()
    cleans up after itself, a takeover() run against a freshly booted stack
    (no shows at all) hung waiting for the takeover picker. Seeded/torn down
    the same try/finally pattern shows()/skills()/imaging() use, so this
    check is self-contained and order-independent within the file.
    """
    # Best-effort cleanup from a run that crashed before its own teardown.
    leftover = find_show(TAKEOVER_SHOW_NAME)
    if leftover:
        api_write("DELETE", f"/shows/{leftover['id']}", ok_statuses=(200, 404))

    # name + personaId are showSchema's only required fields — everything
    # else defaults. personaId is read from the live roster rather than
    # hardcoded (like moods()'s early_morning_mood lookup), since a seeded
    # persona id isn't a documented contract of the verify stack.
    personas = json.loads(api("/settings")).get("values", {}).get("personas", [])
    assert personas, "no personas on the roster — can't seed a show to pin"
    seeded = json.loads(api_write(
        "POST", "/shows",
        {"show": {"name": TAKEOVER_SHOW_NAME, "personaId": personas[0]["id"]}},
    ))["show"]

    try:
        # Installed BEFORE goto so every timer the page schedules on mount —
        # including TakeoverCard's 30s poll setInterval — is one this test
        # controls. Left in default (auto-ticking) mode: only the later
        # fast_forward jumps ahead of real time, everything up to that point
        # behaves exactly like an uninstalled clock would.
        page.clock.install()
        page.goto(f"{WEB}/admin/dash")
        page.wait_for_selector("text=Takeover")

        minutes = page.get_by_label("Takeover minutes")

        # 2. Validate — 5 is under OVERRIDE_MIN_MINUTES (15).
        minutes.fill("5")
        wait_for_invalid(page, minutes)
        assert_aria(page, minutes)
        assert_field_error(page, minutes, "must be an integer between 15 and 720")

        # Save must be gated while invalid.
        pin = page.get_by_role("button", name="Take over")
        assert pin.is_disabled(), "Save enabled with an out-of-range window"

        # 3. Save — choose Default programming, confirm the explicit null
        # target persists and presents as a live takeover.
        minutes.fill("60")
        page.get_by_label("Choose takeover programming").click()
        page.get_by_role("menuitem", name="Default programming").click()
        pin.click()
        page.get_by_text("Default programming", exact=True).wait_for()
        page.get_by_text("autonomous music · default DJ", exact=False).wait_for()
        stored = json.loads(api("/schedule")).get("override")
        assert stored and stored.get("showId", "missing") is None, stored

        # 4. Poll safety — the 30s tick must not clobber a half-typed window.
        #    fast_forward past the real interval so the tick genuinely fires
        #    (see assert_survives_poll's docstring for why a dispatched focus
        #    event and a short sleep cannot prove this).
        page.get_by_role("button", name="Cancel takeover").click()
        page.wait_for_selector("text=Choose programming")
        minutes.fill("123")
        assert_survives_poll(page, minutes, "123")
    finally:
        # Runs whether the assertions above passed or raised — a failed run
        # must not leave the fixture show behind to poison the NEXT run.
        api_write("DELETE", f"/shows/{seeded['id']}", ok_statuses=(200, 404))


FESTIVAL_VERIFY_NAME = "Verify Festival"


def _festivals():
    return json.loads(api("/settings")).get("values", {}).get("festivals", [])


def _strip_verify_festival():
    """Whole-array replace, like FestivalsSection.persist itself — festivals
    have no per-row DELETE endpoint. Best-effort: called both as a pre-clean
    (a prior run crashed before its own teardown) and as the real teardown."""
    current = _festivals()
    without = [f for f in current if f.get("name") != FESTIVAL_VERIFY_NAME]
    if len(without) != len(current):
        api_write("POST", "/settings", {"festivals": without})


@check
def festivals(page):
    """Pre-clean + try/finally, same pattern as shows()/skills()/blockrules()/
    imaging()/personas(). Without it the final assertion is vacuous from the
    SECOND run onward: festivals is a whole-array field with no per-row
    delete, so a leftover "Verify Festival" row from a prior run satisfies a
    bare `'"Verify Festival"' in api("/settings")` substring check whether or
    not THIS run's save did anything — and left unbounded, repeated runs walk
    the array straight into SETTINGS_FESTIVALS_LIMIT (50), which fails as a
    seeming form regression rather than what it actually is (a fixture leak).
    The fixed assertion counts entries named FESTIVAL_VERIFY_NAME before and
    after this run's save, so it proves THIS save added exactly one, not that
    a row with that name exists somewhere in the blob.
    """
    _strip_verify_festival()
    before_count = sum(1 for f in _festivals() if f.get("name") == FESTIVAL_VERIFY_NAME)
    assert before_count == 0, f"pre-clean left {before_count} leftover Verify Festival rows"

    try:
        page.goto(f"{WEB}/admin/moods?tab=festivals")
        page.wait_for_selector("text=Festival calendar")

        page.get_by_role("button", name="Add festival").click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for()

        name = dialog.get_by_label("Name")
        save = dialog.get_by_role("button", name="Add festival")

        # 2. Validate — a blank name. The row is appended blank already, but
        #    mode: 'onChange' only reacts to a real change event, so fill a
        #    value first and then clear it to force one.
        name.fill("x")
        name.fill("")
        wait_for_invalid(page, name)

        # `name` is bound through TextField directly against the array path
        # (`festivals.${idx}.name`), so its id is genuinely dotted — prove that,
        # not just that assert_aria happens to pass. This is the harness fix's
        # actual teeth: the OLD bare `#id` selector must fail to resolve this
        # exact id (confirming the id really is dotted and really would have
        # been reported dangling under the old lookup — on this id it doesn't
        # even degrade to a silent 0-count miss, it's a straight CSS parse error,
        # since a digit right after the dot, e.g. `.14.name`, isn't a legal
        # unescaped class-name start either), and the NEW attribute-selector
        # lookup assert_aria now uses must resolve it cleanly.
        described = name.get_attribute("aria-describedby")
        assert described and "." in described, f"expected a dotted id, got {described!r}"
        try:
            old_result = f"{page.locator(f'#{described}').count()} matches"
        except Exception as e:  # noqa: BLE001 — deliberately broad, this IS the old bug
            old_result = f"raised {type(e).__name__}"
        assert old_result != "1 matches", (
            f"expected the old bare #id selector to fail on a dotted id, got {old_result}"
        )
        new_fixed = page.locator(f'[id="{described}"]').count()
        assert new_fixed == 1, f"expected the attribute selector to resolve the dotted id, got {new_fixed}"
        print(f"  (dotted id confirmed: {described!r} — old selector: {old_result}, new selector: 1 match)")

        assert_aria(page, name)
        assert_field_error(page, name, "must be 1-80 chars")
        assert save.is_disabled(), "Save enabled with a blank name"

        # 3. Save — a valid name (month/day/mood default to valid values), confirm
        #    THIS run's save actually added it: exactly one row named
        #    FESTIVAL_VERIFY_NAME now exists, where the pre-clean above proved
        #    zero existed a moment ago. A stale row from a prior crashed run
        #    could satisfy a bare substring-in-the-whole-blob check; it cannot
        #    satisfy a before/after count tied to a fresh pre-clean.
        name.fill(FESTIVAL_VERIFY_NAME)
        save.click()
        dialog.wait_for(state="detached")
        after_count = sum(1 for f in _festivals() if f.get("name") == FESTIVAL_VERIFY_NAME)
        assert after_count == 1, f"expected exactly 1 Verify Festival row after save, found {after_count}"
    finally:
        # Runs whether the assertions above passed or raised — a failed run
        # must not leave the fixture behind to poison the NEXT run (or, over
        # ~40 runs, walk the array into SETTINGS_FESTIVALS_LIMIT).
        _strip_verify_festival()


@check
def moods(page):
    # No page.clock.install() — MoodsPanel has no poll (one GET /settings on
    # mount, like FestivalsSection); assert_survives_poll doesn't apply here.
    page.goto(f"{WEB}/admin/moods?tab=vocab")
    page.wait_for_selector("text=Mood vocabulary")

    # Find which mood the early-morning slot currently points at (server
    # seed: 'morning'), so the rename below is guaranteed to orphan a real
    # reference rather than assuming a fixed seed name.
    settings_before = api("/settings")
    early_morning_mood = json.loads(settings_before)["values"]["moodSchedule"]["early-morning"]

    name_inputs = page.get_by_label("Mood id")
    target_idx = None
    for i in range(name_inputs.count()):
        if name_inputs.nth(i).input_value() == early_morning_mood:
            target_idx = i
            break
    assert target_idx is not None, f"could not find a vocab row named {early_morning_mood!r}"
    target = name_inputs.nth(target_idx)

    # 1. Client-side validation still runs first: TextField/SelectField wired
    #    through the arrayControl cast, real dotted ids (`moods.N.name`).
    save = page.get_by_role("button", name="Save vocabulary")
    target.fill("")
    wait_for_invalid(page, target)
    assert_aria(page, target)
    assert_field_error(page, target, "must be 1-40 chars")
    assert save.is_disabled(), "Save enabled with a blank mood id"

    # 2. Rename (not delete) the mood the early-morning slot points at, to
    #    something not already in the vocabulary. Client-side validation
    #    passes (a valid, non-duplicate id) — the refusal below can only come
    #    from the server, proving this is really a round trip.
    renamed = f"{early_morning_mood}-orphantest"
    target.fill(renamed)
    wait_for_invalid(page, target, invalid=False)
    assert not save.is_disabled(), "Save stayed disabled on a valid rename"

    save.click()
    # 3. The controller's in-use removal guard (assertNoOrphanMoods) refuses:
    #    the early-morning moodSchedule slot still names the OLD mood id, and
    #    that check runs inside settings.update() over the FULL patch, not
    #    the route's shape-only pre-flight — so it throws a plain Error with
    #    no field path, not a fieldErrors entry. Confirmed by reading
    #    settings/validate.ts (assertNoOrphanMoods) and routes/settings/
    #    core.ts's POST handler (`res.status(400).json({ error: err.message
    #    })`, no fieldErrors passed through on that branch) — MoodsPanel's
    #    persistPatch still WIRES applyServerFieldErrors (real, and load-
    #    bearing for a shape-level failure, asserted in step 1's server-shape
    #    twin below), but this specific rule structurally can't land on one
    #    input, so the proof here is: the refusal surfaces somewhere the
    #    operator will see it (a toast), AND it does NOT falsely mark the
    #    renamed field invalid (no orphan-guard aria-invalid).
    toast = page.locator('[data-sonner-toast]:has-text("still used by")')
    toast.wait_for(timeout=6000)
    assert "early-morning" in toast.inner_text(), toast.inner_text()

    # The save must have been REJECTED, not silently accepted — confirm the
    # controller's stored vocabulary still has the OLD name, not the rename.
    settings_after = api("/settings")
    stored_names = [m["name"] for m in json.loads(settings_after)["values"]["moods"]]
    assert early_morning_mood in stored_names, "orphan-guard refusal did not actually block the save"
    assert renamed not in stored_names, "rename persisted despite the orphan-guard refusal"

    # And the refusal did NOT get attributed to the (perfectly valid) rename
    # input — no aria-invalid was set on it by this failure.
    assert target.get_attribute("aria-invalid") != "true", (
        "orphan-guard refusal incorrectly marked the input aria-invalid — "
        "it has no field to attach to, see the comment above"
    )

    # Revert the rename so the check is repeatable against the same seed.
    target.fill(early_morning_mood)
    wait_for_invalid(page, target, invalid=False)


@check
def moods_unsaved_vocab_gap(page):
    """Fix round 1 finding: the Moments dropdowns (and the schema context
    validating them) must be built from the PERSISTED mood vocabulary, not
    the live, possibly-unsaved content of the Vocabulary tab. The two cards
    are not symmetric server-side: saveSchedule/saveWeather never carry
    `moods` in their own patch, so settings.ts always judges them against
    what's actually stored (settings.ts:1205-1219) — an unsaved rename that
    the LIVE list would have allowed through client validation is a save the
    server structurally cannot accept. Drives the exact repro from the
    finding: rename a mood in Vocabulary without saving, switch to Moments,
    and confirm the stale rename is not even offered as a choice there.
    """
    page.goto(f"{WEB}/admin/moods?tab=vocab")
    page.wait_for_selector("text=Mood vocabulary")

    settings_before = json.loads(api("/settings"))
    midday_mood = settings_before["values"]["moodSchedule"]["midday"]

    name_inputs = page.get_by_label("Mood id")
    target_idx = None
    for i in range(name_inputs.count()):
        if name_inputs.nth(i).input_value() == midday_mood:
            target_idx = i
            break
    assert target_idx is not None, f"could not find a vocab row named {midday_mood!r}"
    target = name_inputs.nth(target_idx)

    # Rename without saving — client validation passes (valid, non-duplicate
    # id), and nothing is posted to the server.
    renamed = f"{midday_mood}-liveonly"
    target.fill(renamed)
    wait_for_invalid(page, target, invalid=False)

    # Switch tabs via the real tab control — a page.goto here would hard-
    # reload the page and discard the in-memory rename, which would not
    # reproduce the finding (confirmed the hard way in manual testing: an
    # earlier ad hoc script that used page.goto for a tab switch looked like
    # a data-loss bug and was actually just a bad test).
    page.get_by_role("tab", name="Moments").click()
    page.wait_for_selector("text=Time of day")

    midday_select = page.get_by_label("Midday", exact=False)
    midday_select.click()
    options_text = page.locator("[role=option]").all_inner_texts()
    page.keyboard.press("Escape")

    assert renamed not in options_text, (
        f"unsaved vocab rename {renamed!r} was offered as a Moments option — "
        f"the client/server vocabulary gap is open. Options were: {options_text}"
    )
    assert midday_mood in options_text, (
        f"the real persisted mood {midday_mood!r} should still be offered — got {options_text}"
    )

    # Revert the in-progress rename (never saved, so nothing to revert
    # server-side) so the check is repeatable.
    page.get_by_role("tab", name="Vocabulary").click()
    page.wait_for_selector("text=Mood vocabulary")
    target = page.get_by_label("Mood id").nth(target_idx)
    target.fill(midday_mood)
    wait_for_invalid(page, target, invalid=False)


SKILLS_FIXTURE_SLUG = "verify-dup-skill"


@check
def skills(page):
    """SkillEditModal (#1358 follow-on): a create whose slug already exists on
    disk is a SERVER-only rule (skillSlugSchema only checks shape) — traced
    routes/dj.ts's POST /dj/skills: it DOES answer with
    `fieldErrors: { name: … }` on both the reserved-slug and already-exists
    branches, unlike Task 4's persona-orphan guard, which threw a fieldless
    Error. So this modal is a genuine round trip: client-side validation
    passes (the slug is well-formed), and the refusal that lands is the
    server's, attributed to the right input via applyServerFieldErrors.

    Seeds and tears down its own fixture — a custom skill named
    "verify-dup-skill" — through api_write(), the same curl mechanism every
    other request in this file already uses. Every other check here is
    repeatable from a pristine state dir (moods_unsaved_vocab_gap explicitly
    reverts its own in-progress edit at the end); this one must be too, or it
    fails unreadably — no collision, so the "already exists" wait just times
    out — against a freshly booted stack that never got a manual curl seed.
    """
    # Best-effort delete first: clears a fixture left behind by a run that
    # crashed before its own teardown, so this run's collision is guaranteed
    # to be the seed made just below, not a stale leftover. 404 ("no such
    # custom skill") is the expected, normal outcome on a clean stack —
    # confirmed against routes/dj.ts's DELETE /dj/skills/:slug — so it's
    # named explicitly rather than opening api_write's check up to every
    # status.
    api_write("DELETE", f"/dj/skills/{SKILLS_FIXTURE_SLUG}", ok_statuses=(200, 404))
    api_write("POST", "/dj/skills", {
        "name": SKILLS_FIXTURE_SLUG,
        "label": "Verify Dup Skill",
        "brief": "Seeded by verify-forms.py's skills() check — collision fixture, torn down at the end of the same run.",
    })

    skill_gets = []
    page.on(
        "request",
        lambda request: skill_gets.append(request.url)
        if request.method == "GET" and request.url.split("?", 1)[0].endswith("/dj/skills")
        else None,
    )

    try:
        page.goto(f"{WEB}/admin/skills")
        page.get_by_role("button", name="New skill").click()

        dialog = page.get_by_role("dialog")
        dialog.wait_for()

        slug = dialog.get_by_label("SLUG")
        brief = dialog.get_by_label("The brief")
        create = dialog.get_by_role("button", name="Create", exact=True)

        slug.fill(SKILLS_FIXTURE_SLUG)   # valid shape, but already exists on disk
        brief.fill("Playwright dup-slug probe — should never actually save.")
        assert not create.is_disabled(), "Create stayed disabled on a well-formed, if colliding, slug"

        create.click()
        wait_for_invalid(page, slug)
        assert_aria(page, slug)

        # The dialog must still be open — a real refusal, not a swallowed error
        # that quietly closed the modal.
        assert dialog.is_visible(), "dialog closed despite the server refusal"

        # And the refusal really did attribute to THIS input, not just render an
        # aria-describedby pointing at unrelated text — the associated node's own
        # text must be the "already exists" message.
        assert_field_error(page, slug, "already exists")

        # A failed create is still a TanStack mutation, but it must leave the
        # fresh installed-skills resource reusable. Closing the refused form,
        # visiting another panel, and returning should neither evict nor refetch
        # the roster inside the shared 30-second stale window.
        dialog.get_by_text("Close", exact=True).click()
        dialog.wait_for(state="detached")
        page.get_by_role("link", name="Connect", exact=True).click()
        page.wait_for_url("**/admin/connect**")
        page.get_by_role("link", name="Skills", exact=True).click()
        page.wait_for_url("**/admin/skills**")
        page.get_by_text("Verify Dup Skill", exact=True).first.wait_for(state="visible")
        assert len(skill_gets) == 1, f"failed create evicted/refetched /dj/skills: {skill_gets}"
    finally:
        # Runs whether the assertions above passed or raised — a failed run
        # must not leave the fixture behind to poison the NEXT run. 200 is
        # the normal case; 404 covers a run that failed before the seed
        # above ever landed.
        api_write("DELETE", f"/dj/skills/{SKILLS_FIXTURE_SLUG}", ok_statuses=(200, 404))


BLOCKRULE_LABEL = "Verify Blocklist Rule"


@check
def blockrules(page):
    """BlockRulesCard (#1300 FR 1, converted onto blockRuleSchema).

    Both halves run the SAME schema — validateBody(blockRuleSchema) at
    POST/PUT /library/blocklist/rules (confirmed by reading routes/library.ts)
    is byte-for-byte what the client's zodResolver runs — so there is no
    client-accepts/server-rejects gap to exercise here the way skills()'s
    duplicate-slug check does; the only refusal reachable from this build is
    the client-side one, gated on the Save button rather than a round trip.
    That refusal is proven here; the round trip is proven separately by
    actually saving and reading the result back.

    `values` (the chip input, and the playlist checkbox list — same field,
    two branches keyed on `field`) has no single labelable element, so its
    Field names itself via aria-labelledby/groupProps (fieldAria's group
    variant), not htmlFor. assert_aria is generic over the locator it's
    given; the point of this check's aria assertions is confirming that
    GROUP locator (found via the "-values-label" suffix on aria-labelledby,
    not a `for` attribute) is a real, single node with real ids behind it —
    not just that assert_aria passes on whatever the caller happened to hand
    it.

    Message + invalid-state assertions go through the module's shared
    wait_for_invalid/assert_field_error helpers (Fix round 1's Minor 1: the
    message being unique in the app today isn't a property this check
    should depend on) — scoped to the ONE group locator below, which stays
    valid across both the tag-mode and playlist-mode branches since both
    render through the same `-values-label` suffix.

    GET /dj/playlists is mocked to return one fixture playlist regardless of
    whether this verify stack has real Navidrome connectivity (it usually
    doesn't) — the playlist branch's checkbox-list container only renders at
    all when `playlists.length > 0` (an empty list falls back to a plain
    "No Navidrome playlists found" hint with no group control to assert
    against), so without a real playlist to select, Fix round 1's dangling-
    aria-describedby bug in that branch would have nothing to catch it on.
    """
    def find_rule_id():
        rule = find_by_name("/library/blocklist", "rules", BLOCKRULE_LABEL, name_key="label")
        return rule["id"] if rule else None

    # Best-effort cleanup from a run that crashed before its own teardown —
    # same posture as skills()'s pre-seed delete.
    leftover = find_rule_id()
    if leftover:
        api_write("DELETE", f"/library/blocklist/rules/{leftover}", ok_statuses=(204, 404))

    def mock_playlists(route):
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"results": [
                {"id": "verify-playlist", "name": "Verify Playlist", "songCount": 3},
            ]}),
        )

    try:
        page.route("**/dj/playlists", mock_playlists)

        page.goto(f"{WEB}/admin/library?tab=blocked")
        page.wait_for_selector("text=Blocking rules")

        page.get_by_role("button", name="Add rule").click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for()

        name = dialog.get_by_label("Name")
        # Scoped to the dialog: the page ALSO has a toolbar "Add rule" button
        # that opens this same dialog, and the footer's save button carries
        # the identical label while no rule is being edited.
        save = dialog.get_by_role("button", name="Add rule", exact=True)
        match_on = dialog.get_by_label("Match on")

        name.fill(BLOCKRULE_LABEL)
        # Same group locator for both the tag-mode and playlist-mode
        # branches below — `values` (the chip input, and the playlist
        # checkbox list) is one field with two render branches keyed on
        # `field`, both naming themselves via the same `-values-label`
        # suffix (fieldAria's groupProps; see the docstring).
        group = dialog.locator('[aria-labelledby$="-values-label"]')

        # 1. Validate (tag mode) — a label with no values. The default field
        #    is 'tag' (EMPTY_RULE), whose chip input carries the "e.g.
        #    christmas" placeholder. `values` starts already empty, and
        #    mode: 'onChange' only reacts to a real change event (same
        #    caveat festivals() and moods() note) — so commit a chip and
        #    remove it again to force one, landing back on an empty,
        #    freshly-invalidated list.
        chip_input = dialog.get_by_placeholder("e.g. christmas", exact=True)
        chip_input.fill("temp")
        chip_input.press("Enter")
        dialog.get_by_role("button", name="remove temp").click()
        wait_for_invalid(page, group)
        assert save.is_disabled(), "Add rule enabled with an empty values list"
        assert group.count() == 1, f"expected exactly one values group, found {group.count()}"
        assert_aria(page, group)
        assert_field_error(page, group, "must have at least one entry")

        # 1b. Validate (playlist mode) — Fix round 1's finding: switching
        #     Match-on resets `values` to [] (see the field Controller's
        #     onValueChange, below), which makes an unticked playlist list
        #     the DEFAULT state on every switch into Playlist mode, not a
        #     rare edge case — and this branch previously spread
        #     aria-describedby with no FieldError behind it. No earlier
        #     check ever switched into Playlist mode to notice.
        match_on.click()
        page.get_by_role("option", name="Playlist").click()
        wait_for_invalid(page, group)
        assert save.is_disabled(), "Add rule enabled with no playlists selected"
        assert group.count() == 1, f"expected exactly one values group, found {group.count()}"
        assert_aria(page, group)
        assert_field_error(page, group, "must have at least one entry")

        # Tick the mocked playlist — the group must actually leave its
        # invalid state once `values` is non-empty again, not just report
        # invalid forever regardless of content.
        group.get_by_text("Verify Playlist").click()
        wait_for_invalid(page, group, invalid=False)
        assert not save.is_disabled(), "Add rule stayed disabled with a playlist selected"

        # Switch back to `tag` before the real save below — this check's
        # persisted rule stays field='tag', same as before this fix round.
        # The switch resets `values` to [] again, which is exactly the
        # empty starting point step 2 below already expects.
        match_on.click()
        page.get_by_role("option", name="Any tag").click()
        wait_for_invalid(page, group)

        # 2. Save — a valid value clears the refusal, and the round trip
        #    really persists (not just a client-side state flip): confirmed
        #    against GET /library/blocklist afterward.
        chip_input.fill("verify-tag")
        chip_input.press("Enter")
        wait_for_invalid(page, group, invalid=False)
        assert not save.is_disabled(), "Add rule stayed disabled on a valid rule"

        save.click()
        dialog.wait_for(state="detached")
        assert BLOCKRULE_LABEL in api("/library/blocklist"), "rule did not persist"
    finally:
        # Runs whether the assertions above passed or raised — a failed run
        # must not leave the fixture behind to poison the NEXT run.
        rid = find_rule_id()
        if rid:
            api_write("DELETE", f"/library/blocklist/rules/{rid}", ok_statuses=(204, 404))


SFX_FIXTURE_NAME = "verify-sfx-effect"


def _write_silent_wav(path, seconds=0.3, rate=8000):
    """A minimal, real (not just well-formed-header) mono WAV — importAudio
    transcodes it through ffmpeg when available, so the bytes have to survive
    an actual decode, not merely pass a header sniff."""
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))


@check
def imaging(page):
    """SfxSection's create + import modals (Task 7, imaging/{Sfx,Beds,Jingles,
    Voices}Section).

    POST /sfx runs validateBody(sfxCreateSchema) (controller routes/sfx.ts) —
    the SAME schema the create modal's zodResolver runs (imported from
    lib/schemas.generated.ts) — so the duration-over-SFX_MAX_SEC refusal
    proven below is a genuine mirror of the server rule, not a UI-only
    constraint invented for this check.

    The real routes are `/sfx` (create) and `/sfx/upload` (import), never
    `/imaging/...` — confirmed by grepping ImagingPanel.tsx's adminFetch
    calls; `/imaging` is only the admin PAGE path (`/admin/imaging?tab=sfx`),
    never an API prefix.

    The persistence round trip is proven through the IMPORT modal, not a real
    generation. Verification runs with every TTS credential neutralised, so
    the browser stubs only GET /sfx's `generatorReady` capability to expose
    the create form's submit state; POSTs remain real and no costed provider
    call is made. Import needs no external API — a real WAV upload through
    /sfx/upload — and shares the same imagingImportSchema name/description
    fields.

    Also covers ImagingPanel's own 3s TanStack Query `refetchInterval` — ten
    times faster than TakeoverCard's 30s, and the panel most likely to exhibit
    the clobber bug `assert_survives_poll` exists to catch. The Jingle ratio
    input is the right target: it's a real on-page control hydrated from the
    shared settings query only while clean, so an in-progress edit must
    survive every background revision. `seconds=3` matches THIS panel's real interval —
    `assert_survives_poll`'s `seconds=35` default is calibrated for
    TakeoverCard's 30s poll and would prove nothing here (it'd fast-forward
    past 11 ticks instead of exercising one real one).
    """
    def find_effect():
        return find_by_name("/sfx", "sfx", SFX_FIXTURE_NAME)

    # Best-effort cleanup from a run that crashed before its own teardown.
    if find_effect():
        api_write("DELETE", f"/sfx/{SFX_FIXTURE_NAME}", ok_statuses=(200, 400, 404))

    try:
        # The isolated stack deliberately has no ElevenLabs credential. Keep
        # the real controller list but expose the create form's validation
        # path without enabling or calling an external generator.
        sfx_fixture = json.loads(api("/sfx"))
        sfx_fixture["generatorReady"] = True
        page.route(
            f"{API}/sfx",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(sfx_fixture),
            ) if route.request.method == "GET" else route.continue_(),
        )

        # Installed BEFORE goto — like takeover()'s clock — so the query's
        # refetch timer is one this test controls from the moment ImagingPanel
        # mounts, not one already ticking on real wall-clock time.
        page.clock.install()
        page.goto(f"{WEB}/admin/imaging?tab=jingles")
        page.wait_for_selector("text=how often")

        ratio = page.get_by_label("Jingle ratio")
        original = ratio.input_value()
        ratio.fill("77")
        assert_survives_poll(page, ratio, "77", seconds=3)
        # Revert so this check leaves no dirty, unsaved edit behind — the
        # ratio was never actually saved (that would need a mixer restart to
        # matter), so restoring the input value alone makes the run repeatable.
        ratio.fill(original)

        page.get_by_role("tab", name="SFX").click()
        page.wait_for_selector("text=Sound effects")

        # 1. Create modal — duration above SFX_MAX_SEC (10s) refuses on the
        #    duration field itself.
        page.get_by_role("button", name="+ Create").click()
        create_dialog = page.get_by_role("dialog")
        create_dialog.wait_for()

        name = create_dialog.get_by_label("Name")
        prompt = create_dialog.get_by_label("Generation prompt")
        duration = create_dialog.get_by_label("Duration · s")
        create_save = create_dialog.get_by_role("button", name="Create", exact=True)

        name.fill(SFX_FIXTURE_NAME)
        prompt.fill("Playwright duration-over-max probe — should never actually generate.")

        # Scoped to the duration field's own aria-describedby (not a bare
        # page-wide text= match — see blockrules()/skills()), proving the
        # message is really attributed to THIS input.
        duration.fill("999")
        wait_for_invalid(page, duration)
        assert_aria(page, duration)
        assert_field_error(page, duration, "is capped at 10s")
        assert create_save.is_disabled(), "Create enabled with an out-of-range duration"

        # A valid duration clears the refusal. FieldError (components/ui/
        # field.tsx) renders null once `errors` is undefined (form-fields.tsx
        # passes `fieldState.error ? [fieldState.error] : undefined`, not an
        # always-truthy `[fieldState.error]`), so the field's own `-error` id
        # actually leaves the DOM — scoped the same way the initial assertion
        # above is, not a bare page-wide text= match.
        duration.fill("1")
        wait_for_invalid(page, duration, invalid=False)
        assert duration.get_attribute("aria-invalid") is None, "duration still marked invalid"
        assert not create_save.is_disabled(), "Create stayed disabled on a valid duration"

        # Close without submitting — see the docstring for why a real create()
        # is not exercised on this stack.
        page.get_by_role("button", name="Cancel").click()
        create_dialog.wait_for(state="detached")

        # 2. Import modal — a real file upload persists, proving the round
        #    trip end to end (not just a client-side state flip): confirmed
        #    against GET /sfx afterward, same as blockrules()/festivals()'s
        #    save step.
        wav_path = "/tmp/verify-sfx-fixture.wav"
        _write_silent_wav(wav_path)

        page.get_by_role("button", name="Import", exact=True).click()
        import_dialog = page.get_by_role("dialog")
        import_dialog.wait_for()

        import_dialog.get_by_label("Name").fill(SFX_FIXTURE_NAME)
        import_dialog.locator('input[aria-label="Import SFX audio file"]').set_input_files(wav_path)
        import_save = import_dialog.get_by_role("button", name="Import", exact=True)
        assert not import_save.is_disabled(), "Import stayed disabled with a name and a file chosen"

        import_save.click()
        import_dialog.wait_for(state="detached")
        assert find_effect(), "sound effect did not persist"
    finally:
        # Runs whether the assertions above passed or raised — a failed run
        # must not leave the fixture behind to poison the NEXT run.
        if find_effect():
            api_write("DELETE", f"/sfx/{SFX_FIXTURE_NAME}", ok_statuses=(200, 400, 404))


# --- onboarding: needs its OWN second stack -------------------------------
#
# The wizard (WizardShell) only renders when GET /onboarding/status reports
# needsSetup: true. The shared verify controller on :7791 is deliberately
# booted WITH fake NAVIDROME_* env (see .claude/skills/verify/SKILL.md)
# specifically so needsSetup is FALSE and the admin shell doesn't redirect
# every other check in this file into the wizard — so this check structurally
# cannot run against :7791/:7793 the way the rest of the file does, and must
# not touch that shared stack (six other checks, and everything Task 13
# drives, depend on it staying up and configured).
ONBOARD_CONTROLLER_PORT = 7792
ONBOARD_WEB_PORT = 7794
ONBOARD_API = f"http://localhost:{ONBOARD_CONTROLLER_PORT}"
ONBOARD_WEB = f"http://localhost:{ONBOARD_WEB_PORT}"


def _onboard_curl(method, url, body=None):
    cmd = ["curl", "-s", "-u", "test:test", "-X", method, url]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
    return out.stdout


def _wait_http(url, timeout=90):
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            r = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", url],
                capture_output=True, text=True, timeout=5,
            )
            if r.stdout.strip() and r.stdout.strip() != "000":
                return
        except Exception as e:  # noqa: BLE001 — keep polling, report the last one on timeout
            last_err = e
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for {url} (last error: {last_err})")


@check
def onboarding(page):
    """The onboarding wizard, converted onto react-hook-form (Task 8):
    NavidromeStep/LlmStep/TtsStep/DjStep each own a useZodForm and their own
    gated "Next" submit; ReviewStep is unchanged (no fields of its own).

    Boots its OWN throwaway controller (port 7792, a fresh temp STATE_DIR, and
    critically NO NAVIDROME_* env at all — that absence is what makes
    needsSetup true) and its OWN second Next dev server (port 7794). Both are
    started and stopped by THIS check, in a `finally`, so this file stays
    runnable as a whole against a freshly booted stack (Task 13's job) with no
    manual step for anyone to forget — that was Task 5's bar.

    Two things make the second web server non-trivial, not just a second
    `npm run dev -p N`:

    1. `NEXT_PUBLIC_API_URL` is inlined into the client bundle at `next dev`
       STARTUP (webpack `DefinePlugin`), not read per request — confirmed by
       reading app/onboarding/page.tsx's `process.env.NEXT_PUBLIC_API_URL`
       and next.config.js (no rewrite proxies `/api` dynamically). So the
       EXISTING :7793 server this file's other checks use cannot be
       retargeted per request; a second `next dev` process, pointed at 7792
       from the start, is the only way.
    2. A second `next dev` in the SAME source tree collides with the first:
       Next's dev server refuses to start a second instance sharing one
       `.next/dev/lock` file ("Another next dev server is already running",
       confirmed by actually hitting it). The lock path is keyed off
       `distDir`, so this needs its own — `next.config.js` reads
       `SUBWAVE_NEXT_DIST_DIR` (falls back to plain `.next` for every other
       invocation) for exactly this. Building instead of a second dev server
       was considered and rejected: `next build` overwrites the SHARED
       `.next/` output the :7793 dev server is serving from, corrupting it
       for every other check in this file (this is the documented "don't
       `npm run build` while dev server runs" gotcha, and it would fire here
       even though the intent is isolation, since both processes would
       default to the same `.next` without the distDir override).
       `next dev` (not `next start`) is also needed because this worktree's
       `node_modules` is a symlink — Turbopack panics resolving it
       ("Symlink […]/node_modules is invalid"), so this launches with
       `--webpack`, same as every other worktree dev invocation until a real
       `npm install` replaces the symlink.

    Runnable standalone: `python3 web/scripts/verify-forms.py onboarding`.
    Needs nothing pre-booted beyond the repo + node_modules every other check
    already needs — no manual second-stack step for Task 13 or anyone else.

    fieldErrors trace (Task 8's step 6-7): POST /onboarding/save is a
    hand-rolled try/catch (routes/onboarding.ts), not validateBody(schema),
    so it NEVER emits fieldErrors — only `{ok, error}`. The two probe routes
    (test-navidrome, test-llm) DO run validateBody(navidromeProbeSchema /
    llmProbeSchema) and DO carry a fieldErrors object on a 400 — but both
    schemas are `z.unknown().refine(...)` with no `.path()` on the refine, so
    every issue lands at the schema ROOT: flattenIssues produces `{"":
    message}`, not `{provider: message}` or `{url: message}`. There is no
    field to call form.setError() on, so steps.tsx does not wire
    applyServerFieldErrors anywhere in this wizard — doing so would be inert,
    misrepresenting a channel that doesn't functionally exist here (Task 4's
    mistake, not Task 5's). Both halves of that trace are proven below by
    curl, not just cited.
    """
    state_dir = tempfile.mkdtemp(prefix="subwave-onboarding-verify-")
    # Next's `distDir` is ALWAYS resolved relative to the project root
    # (path.join(projectDir, distDir)) — handing it an absolute /tmp path
    # doesn't escape that, it just gets joined as another path SEGMENT
    # (path.join('/a/b', '/tmp/c') === '/a/b/tmp/c' in Node, no special
    # leading-slash handling), so the real build output silently lands under
    # web/tmp/... instead of the tempdir this script thinks it owns and
    # cleans up — confirmed the hard way: an early version of this check left
    # exactly that behind, and it was picking up `npm run lint` because the
    # relative name is a real leftover directory in the repo, not the actual
    # temp path. A plain relative name, cleaned up via its OWN absolute path
    # (WEB_DIR / name), avoids the mismatch entirely.
    dist_dir_name = f".next-onboarding-verify-{os.getpid()}"
    dist_dir_abs = WEB_DIR / dist_dir_name

    controller_env = dict(os.environ)
    controller_env.update({
        "STATE_DIR": state_dir,
        "PORT": str(ONBOARD_CONTROLLER_PORT),
        "ADMIN_USER": "test",
        "ADMIN_PASS": "test",
        "NODE_ENV": "development",
    })
    # The absence of these three is the entire point — with them set,
    # needsSetup is false and the wizard never renders. Strip rather than
    # trust the ambient shell not to have them (the shared verify SKILL sets
    # exactly these three for the OTHER stack).
    for k in ("NAVIDROME_URL", "NAVIDROME_USER", "NAVIDROME_PASS"):
        controller_env.pop(k, None)

    controller_proc = subprocess.Popen(
        ["npx", "tsx", "src/server.ts"],
        cwd=str(CONTROLLER_DIR),
        env=controller_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    web_proc = None
    try:
        _wait_http(f"{ONBOARD_API}/onboarding/status")
        status = json.loads(_onboard_curl("GET", f"{ONBOARD_API}/onboarding/status"))
        assert status.get("needsSetup") is True, (
            f"second controller did not come up in needs-setup state: {status}"
        )

        web_env = dict(os.environ)
        web_env.update({
            "NEXT_PUBLIC_API_URL": ONBOARD_API,
            "SUBWAVE_NEXT_DIST_DIR": dist_dir_name,
        })
        web_proc = subprocess.Popen(
            ["npx", "next", "dev", "-p", str(ONBOARD_WEB_PORT), "--webpack"],
            cwd=str(WEB_DIR),
            env=web_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _wait_http(f"{ONBOARD_WEB}/onboarding")

        # 1. The wizard renders step 1 and NOT the "already set up" fallback.
        page.goto(f"{ONBOARD_WEB}/onboarding")
        page.wait_for_selector("text=Connect Navidrome", timeout=20000)

        # 2. Navidrome step: Test connection gates on navidromeProbeSchema
        #    (all three fields required), Next does not (skipping Navidrome
        #    is a supported path — useWizard.save()/routes/onboarding.ts both
        #    persist empty creds fine).
        test_conn = page.get_by_role("button", name="Test connection")
        assert test_conn.is_disabled(), "Test connection enabled with blank Navidrome fields"
        next_btn = page.get_by_role("button", name="Next →")
        assert not next_btn.is_disabled(), "Navidrome step's Next should never require creds"

        page.get_by_label("Navidrome URL").fill("http://verify.invalid:4533")
        page.get_by_label("Username").fill("verify-user")
        page.get_by_label("Password").fill("verify-pass")
        assert not test_conn.is_disabled(), "Test connection stayed disabled with all 3 fields filled"

        next_btn.click()
        page.wait_for_selector("text=Pick a language model", timeout=15000)

        # 3. LLM step: the FAILS-BEFORE case (confirmed by hand against the
        #    pre-migration code: clearing Model neither disabled Next nor
        #    blocked advancing — there was no gating at all). Now the step's
        #    own resolver is llmProbeSchema, so formState.isValid — gating
        #    both Next and the Test button, one source of truth — goes false
        #    the moment Model is empty.
        next_btn = page.get_by_role("button", name="Next →")
        assert not next_btn.is_disabled(), "LLM Next should start enabled (DEFAULT_DATA is already valid)"
        model = page.get_by_label("Model")
        model.fill("")
        page.wait_for_timeout(300)
        assert next_btn.is_disabled(), "LLM Next did not disable once Model was cleared"
        assert page.get_by_role("button", name="Send a test prompt").is_disabled(), (
            "Send a test prompt did not disable once Model was cleared"
        )
        model.fill("verify-model")
        page.wait_for_timeout(300)
        assert not next_btn.is_disabled(), "LLM Next did not re-enable once Model was restored"

        next_btn.click()
        page.wait_for_selector("text=Choose a voice engine", timeout=15000)

        # 4. TTS step: the default-engine SelectField renders as a real Radix
        #    combobox (the swap from a native <select>), not just present.
        engine_select = page.get_by_label("Default engine")
        assert engine_select.get_attribute("role") == "combobox", (
            f"expected Default engine to be a combobox (SelectField), got role={engine_select.get_attribute('role')!r}"
        )
        page.get_by_role("button", name="Next →").click()
        page.wait_for_selector("text=DJ persona", timeout=15000)

        # 5. DJ step: the one genuinely NEW, field-addressable validation rule
        #    in this migration (stationName <= SETTINGS_STATION_NAME_MAX) —
        #    confirmed by hand against the pre-migration code that neither the
        #    error text nor a disabled Next existed there at all. assert_aria
        #    proves the id it points at is really in the DOM, not just that
        #    SOME error rendered somewhere on the page.
        station = page.get_by_label("Station name")
        dj_next = page.get_by_role("button", name="Next →")
        station.fill("x" * 81)
        wait_for_invalid(page, station, timeout=5000)
        assert_aria(page, station)
        assert_field_error(page, station, "station name must be 80 chars or fewer")
        assert dj_next.is_disabled(), "DJ Next stayed enabled with an over-length station name"

        station.fill("Verify Station")
        wait_for_invalid(page, station, invalid=False, timeout=5000)
        assert station.get_attribute("aria-invalid") is None, "station name still marked invalid"
        assert not dj_next.is_disabled(), "DJ Next stayed disabled on a valid station name"

        dj_next.click()
        page.wait_for_selector("text=All set?", timeout=15000)

        # 6. Save — the full round trip, not just a client-side state flip:
        #    confirmed against GET /onboarding/status on the SECOND
        #    controller afterward, same pattern as festivals()/moods()'s save
        #    steps against the shared one.
        page.get_by_role("button", name="Save and finish").click()
        page.wait_for_selector("text=You're on air.", timeout=20000)
        after = json.loads(_onboard_curl("GET", f"{ONBOARD_API}/onboarding/status"))
        assert after.get("needsSetup") is False, f"needsSetup did not flip to false after save: {after}"
        assert after.get("setupCompletedAt"), f"setupCompletedAt was not stamped: {after}"

        # 7. The fieldErrors trace above, proven empirically rather than only
        #    cited: the probe endpoints' 400s carry a fieldErrors object keyed
        #    by the empty root path (no field to attach to), and /save's 400
        #    carries no fieldErrors key at all.
        probe_400 = json.loads(_onboard_curl("POST", f"{ONBOARD_API}/onboarding/test-llm", {}))
        assert list(probe_400.get("fieldErrors", {}).keys()) == [""], (
            f"expected the probe's sole fieldErrors key to be the empty root path, got {probe_400}"
        )
        save_400 = json.loads(_onboard_curl(
            "POST", f"{ONBOARD_API}/onboarding/save",
            {"tts": {"cloud": {"enabled": True, "provider": "fish-audio", "model": "", "voice": ""}}},
        ))
        assert save_400.get("ok") is False, f"expected the malformed Fish Audio save to be refused: {save_400}"
        assert "fieldErrors" not in save_400, (
            f"expected /onboarding/save to carry no fieldErrors key at all, got {save_400}"
        )
    finally:
        # Kill by port, never `pkill -f "tsx src/server.ts"` / "next dev" —
        # either would match this very Bash/subprocess wrapper's own cmdline
        # and take the calling shell down with it (exit 144).
        if web_proc is not None:
            subprocess.run(["fuser", "-k", f"{ONBOARD_WEB_PORT}/tcp"], capture_output=True)
            web_proc.wait(timeout=15)
        subprocess.run(["fuser", "-k", f"{ONBOARD_CONTROLLER_PORT}/tcp"], capture_output=True)
        controller_proc.wait(timeout=15)
        shutil.rmtree(state_dir, ignore_errors=True)
        shutil.rmtree(dist_dir_abs, ignore_errors=True)
        # `next dev` with a non-default distDir still rewrites tsconfig.json
        # and next-env.d.ts (both tracked files) to reference it — restore
        # them so this check leaves the working tree exactly as it found it.
        subprocess.run(
            ["git", "checkout", "--", "web/tsconfig.json", "web/next-env.d.ts"],
            cwd=str(WEB_DIR.parent), capture_output=True,
        )


PERSONA_VERIFY_NAME = "Verify Persona"


@check
def personas(page):
    """PersonasPanel (Task 9) — the roster + system-prompt library on
    react-hook-form. Two field arrays (`personas`, `djPrompts`) bound via
    `useZodForm(z.object({ personas: z.array(personaSchema), djPrompts:
    z.array(djPromptSchema) }))`; `activePersonaId`/`activeDjPromptId`/
    `djHouseRules` stay plain useState (they aren't array rows).

    Unlike webhooks/festivals (every row rendered simultaneously as a card),
    this editor is single-focus: ONE persona's fields render at a time inside
    a full-screen dialog (`PersonaEditor`), selected by `focusIdx`. Assertion
    4 below proves the row-indexing property by switching FOCUS between two
    already-open rows in the same form instance, not by reading two rows off
    the page at once.

    applyServerFieldErrors trace (read against controller/src/routes/
    settings/core.ts, middleware/validate.ts, settings/patch-registry.ts,
    schemas/persona.ts): `personas` IS one of the 26 converted `/settings`
    patch-registry keys — `validateSettingsBody()` runs `personasSchema`
    (== `z.array(personaSchema)`, the SAME schema this form's zodResolver
    runs) BEFORE the route handler, so a bad persona never reaches
    `settings.update()`; the middleware itself answers the 400 with
    `fieldErrors`. Traced empirically (a real safeParse against a 3-persona
    array with a bad `tts` in the MIDDLE entry):
        fieldErrors: { "personas.1.tts": "tts.voice must be 1-100 chars" }
    `ttsVoiceSlotSchema` (schemas/persona.ts) is ONE `.transform()` over the
    whole `{engine, cloudProvider, voice, gainDb, speed}` slot with no
    `.path()` on its `ctx.addIssue` calls, so the error is rooted at
    `personas.<i>.tts` — never deeper (`.tts.voice`) — which is exactly why
    PersonaVoiceCard binds ONE `useController` over the whole `tts` object
    rather than a `SelectField` per subfield: only a control literally
    subscribed at that exact path can pick the error up at all.

    Because personaSchema is the identical mirror on both sides, there is NO
    client-accepts/server-rejects gap for THIS rule the way skills()'s
    duplicate-slug or moods()'s orphan-guard have one — the editor's own Save
    gate (`formState.isValid`) already refuses to submit a persona whose tts
    the schema would flag, so a real end-to-end 400 for this exact rule is
    not reachable by driving the UI honestly. What IS proven for real: a
    mocked `POST /settings` response carrying the controller's ACTUAL,
    traced `fieldErrors` shape (`personas.1.tts`, the real path + a real
    message the schema emits) reaches `applyServerFieldErrors` and lands on
    the RIGHT persona's Voice field, not persona 0's — which is the field-
    array wiring this task exists to prove, and is exactly the kind of bug
    (an off-by-one, or a collapse-to-index-0 in the row mapping) an honest
    round trip and a mocked one would catch identically, since neither the
    client nor the server does any index remapping of its own.
    """
    def find_verify_persona():
        return find_by_name("/settings", "values.personas", PERSONA_VERIFY_NAME)

    # Best-effort cleanup from a run that crashed before finishing. Personas
    # have no per-row DELETE endpoint (the roster is one whole-array `POST
    # /settings` patch) — idempotent across repeated runs the same way
    # skills()/blockrules() pre-clean their own fixtures.
    if find_verify_persona():
        data = json.loads(api("/settings"))
        remaining = [p for p in data["values"]["personas"] if p.get("name") != PERSONA_VERIFY_NAME]
        api_write("POST", "/settings", {"personas": remaining})

    page.goto(f"{WEB}/admin/personas")
    page.wait_for_selector("text=The voices on your station.")

    # 1. Hydrate — the verify stack seeds three personas (Marlowe, Wren,
    #    Hale); open the MIDDLE one (Wren, index 1) so assertion 4 below can
    #    prove a server message lands on ITS row, not row 0's. A stored
    #    field value landing in the bound TextField is the round trip.
    page.get_by_role("button", name="Edit Wren").click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()
    name = dialog.get_by_label("On-air name")
    assert name.input_value() == "Wren", f"expected hydrated name 'Wren', got {name.input_value()!r}"

    # 2. Validate — clearing the name refuses locally against personaSchema
    #    (the SAME schema the server runs), scoped to this field's own
    #    aria-describedby id, and disables Save.
    save = dialog.get_by_role("button", name="Save persona")
    name.fill("x")
    name.fill("")  # mode: 'onChange' needs a real change event, not a starting-blank value
    wait_for_invalid(page, name)
    assert_aria(page, name)
    assert_field_error(page, name, "name must be 1-40 chars")
    assert save.is_disabled(), "Save persona enabled with a blank name"

    # Restore — nothing was ever saved this invalid, so putting the value
    # back is just clearing the local edit, not reverting server state.
    name.fill("Wren")
    wait_for_invalid(page, name, invalid=False)
    assert not save.is_disabled(), "Save persona stayed disabled once the name was restored"

    # Close (Wren is now byte-identical to what the server has, so no
    # discard-confirm should fire) so the roster/hero are clickable again for
    # step 3.
    dialog.get_by_role("button", name="Close").click()
    dialog.wait_for(state="detached")

    # 3. Save — a genuinely NEW persona (not a mutation of a seeded fixture,
    #    so nothing here needs reverting for repeatability beyond the
    #    pre-clean above) persists through a real POST /settings round trip.
    page.get_by_role("button", name="+ Add persona").click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()
    add_name = dialog.get_by_label("On-air name")
    add_name.fill("")
    add_name.fill(PERSONA_VERIFY_NAME)
    # A freshly-appended row's `soul` starts empty (personaSchema requires
    # 1-2000 chars, same as every persona) — fill it too, or Save correctly
    # stays disabled and this step would be testing the wrong thing.
    dialog.get_by_label("Soul").fill("Playwright fixture — a placeholder persona created and persisted by verify-forms.py's personas() check.")
    add_save = dialog.get_by_role("button", name="Save persona")
    assert not add_save.is_disabled(), "Save persona disabled on a freshly-added, valid persona"
    add_save.click()
    dialog.wait_for(state="detached")
    assert PERSONA_VERIFY_NAME in api("/settings"), "new persona did not persist"

    # 4. applyServerFieldErrors, the row-proof: reopen Wren (still index 1 —
    #    the new persona appended at the END, index 3), mock POST /settings
    #    to answer with the controller's REAL, traced fieldErrors shape for a
    #    bad `personas.1.tts`, and confirm the message lands on WREN's Voice
    #    field. Then swap focus to Marlowe (index 0) in the SAME form
    #    instance and confirm its Voice field carries no such error — an
    #    off-by-one or a collapse-to-index-0 in the row wiring would show the
    #    message on the wrong persona (or on both).
    def mock_tts_refusal(route):
        if route.request.method != "POST":
            route.continue_()
            return
        route.fulfill(
            status=400,
            content_type="application/json",
            body=json.dumps({
                "error": "personas.1.tts: tts.voice must be 1-100 chars",
                "fieldErrors": {"personas.1.tts": "tts.voice must be 1-100 chars"},
            }),
        )

    page.get_by_role("button", name="Edit Wren").click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()
    assert dialog.get_by_label("On-air name").input_value() == "Wren"

    page.route("**/settings", mock_tts_refusal)
    try:
        wren_save = dialog.get_by_role("button", name="Save persona")
        assert not wren_save.is_disabled(), "Save persona disabled on an already-valid, unedited persona"
        wren_save.click()

        voice_group = dialog.locator('[aria-labelledby$="-tts-label"]')
        voice_group.wait_for()
        wait_for_invalid(page, voice_group)
        assert_aria(page, voice_group)
        assert_field_error(page, voice_group, "tts.voice must be 1-100 chars")

        # The dialog must still be on WREN — a real refusal, not a swallowed
        # error that quietly closed or advanced the editor.
        assert dialog.get_by_label("On-air name").input_value() == "Wren"

        # Now switch focus to Marlowe (index 0) in the SAME form instance —
        # the whole point of this check. Close Wren first (no unsaved edit:
        # the refused save never mutated any field, so no discard-confirm).
        dialog.get_by_role("button", name="Close").click()
        dialog.wait_for(state="detached")

        page.get_by_role("button", name="Edit Marlowe").click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for()
        assert dialog.get_by_label("On-air name").input_value() == "Marlowe"

        marlowe_voice_group = dialog.locator('[aria-labelledby$="-tts-label"]')
        marlowe_voice_group.wait_for()
        assert marlowe_voice_group.get_attribute("aria-invalid") != "true", (
            "the personas.1.tts server error bled onto persona 0 (Marlowe) — "
            "off-by-one or collapse-to-index-0 in the field-array row mapping"
        )
    finally:
        page.unroute("**/settings", mock_tts_refusal)


SHOW_VERIFY_NAME = "Verify Show"
GHOST_SHOW_NAME = "Verify Ghost Show"


@check
def shows(page):
    """ShowsPanel + ShowEditor (Task 10) — the second master-detail panel, and
    the only schema in the whole react-hook-form migration that is a FACTORY:
    `showSchema(ctx)` cannot be validated against itself because `personaId`
    has to name a real persona, `moods` a live mood, `themeId` an installed
    theme, and `maxTrackSeconds` clears a floor derived from the station's
    crossfade. The browser passes all four (ShowsPanel's `showCtx`), which is
    what makes the three assertions below possible at all.

    Bound via `useZodForm(z.object({shows: z.array(showSchema(showCtx))}),
    {shows: []})`, `showCtx`/the schema object both memoised on identity
    (showSchema is documented as a heavyweight ~20-pipeline factory). One
    `useFieldArray({name: 'shows', keyName: '_rhfKey'})`; `schedule` stays a
    plain useState — this panel loads it read-only for the hours-a-week counts
    and never saves it (the weekly grid + PUT /schedule live on the separate
    Rundown page, already converted separately and out of scope here).

    trigger()-vs-remount, and how it was actually determined: read directly
    against node_modules/react-hook-form/dist/index.cjs.js's `useForm` body —
    `const o = r.current.control; return o._options = t, ...` runs
    UNCONDITIONALLY on every render (not gated behind a ref, an effect, or a
    dirty-check), so `control._options.resolver` always reflects the LATEST
    `zodResolver(schema)` passed to `useZodForm` on the render that just
    committed. `form.trigger()` reads `_options.resolver` at CALL time, so a
    `trigger()` fired from a `useEffect(() => {...}, [showCtx])` — which by
    definition runs AFTER the render that produced the new `showCtx` — always
    sees the current schema, never a stale one captured at mount. No remount
    needed anywhere, confirmed by inspecting the actual diff (ShowEditor is
    still keyed by show id and remounts on FOCUS switch, exactly as before
    this task — that key was never about validation).

    This was also confirmed empirically, by sabotage (not part of this
    committed check — see the task report for the exact before/after
    transcript): temporarily deleting ShowsPanel's `useEffect(() => {void
    form.trigger()}, [showCtx])` reproduces a REAL bug, not a contrived one.
    `resetForm({shows})` and `setData(j)` (which is what makes `showCtx` go
    from its default empty context to the real one) run back-to-back in the
    same synchronous callback, so a `trigger()` fired inline right after
    `resetForm` — the naive placement — would run against the schema from the
    PREVIOUS render, built from the empty-context default
    (`personaIds: []`) that showCtx starts at before `data` loads. Every
    already-valid show's `personaId` fails `ctx.personaIds.includes(v)`
    against that empty list, so EVERY row reads "incomplete" immediately after
    a real page load until something re-validates it — which, without the
    ctx-keyed effect, only happens once the operator touches a field. With the
    effect restored, the SAME sequence validates correctly because the effect
    runs one tick later, after `showCtx` has already updated to the real
    roster.

    Where each cross-field rule's error actually roots (traced against
    controller/src/schemas/show.ts, confirmed by reading the schema, not
    guessed): `personaId`'s `.refine(v => ctx.personaIds.includes(v))` roots
    at `personaId` itself; `maxTrackSeconds`'s floor `.refine()` roots at
    `maxTrackSeconds` itself; the guest-is-host rule is a `.check()` on the
    whole object that explicitly pushes its issue at `path: ['guestPersonaIds']`
    — all three root at a real, distinct, field-addressable path (unlike Task
    9's `tts` slot, which rooted at the whole object). Despite that, ShowEditor
    binds `personaId` through a raw `useController` + a plain `<Select>`, NOT
    the `SelectField` wrapper — not because the error roots anywhere deeper,
    but because switching the host has to explicitly `trigger()` the SIBLING
    `guestPersonaIds` path (react-hook-form's lazy error population is keyed
    per PATH, not per field-that-changed — a plain `field.onChange` from
    `SelectField` can't fire that re-trigger, and without it Save reads as
    enabled off a stale `errors` tree even though `isValid` already disagrees;
    see ShowEditor.tsx's `personaIdCtl` comment for the full trace).
    `maxTrackSeconds`/`guestPersonaIds` each get their own single
    `useController` too (a clamping onChange and a chip-array onChange,
    respectively — real work by the same header rule).

    Assertion 3 (guest-is-host) needed one real behaviour change to become
    reachable through the UI at all: the pre-RHF editor's host picker cleared
    any guest matching the newly-picked host as a side effect ("the new host
    can't also sit in the guest chairs"), which is a nice UX default but also
    made the invalid state structurally unreachable by driving the UI
    honestly — selecting a host always vacated that seat first. Dropped, and
    documented in ShowEditor's personaId Controller comment: Save now refuses
    instead and names the guests field, which is what this assertion actually
    proves.

    Assertion 1 (host not a live persona) turned out to be UNREACHABLE by any
    real API call, and that took an actual failed attempt to discover, not a
    guess: the first version of this check created a throwaway show pointing
    at a real persona (Hale) and then removed Hale from the roster via a
    `personas`-only PATCH, expecting the show's stored `personaId` to go
    stale. It didn't — the show vanished outright. Reading
    controller/src/settings.ts around its "Post-patch integrity sweep"
    comment (~line 1982) shows why: `next.shows = next.shows.filter(s =>
    personaIds.includes(s.personaId))` runs INSIDE `update()`
    UNCONDITIONALLY, in a bare block with no `if ('shows' in patch)` or
    `if ('personas' in patch)` guard — every single `settings.update()` call,
    whatever keys it patches, filters every show's host against the CURRENT
    roster and drops the ones that don't resolve. Confirmed empirically too
    (`curl` transcript, not just the source read): POST a show hosted by
    Hale → `GET /settings` shows it; POST `{"personas": [...without Hale]}` →
    `GET /settings` shows the show gone, not merely host-invalid. So a show
    with a dangling `personaId` cannot exist in PERSISTED state, full stop —
    not "the client already refuses what the server would", the stronger
    claim that the inconsistent STATE itself cannot be constructed by any
    caller, client or server, ever, including a backup restore (which also
    goes through `update()`). What's proven below instead, the same
    `page.route()`-mock technique Task 9 used for its one unreachable rule:
    the CLIENT's own validation machinery, fed a hypothetically inconsistent
    `GET /settings` response (the shape a stale cache, a future server bug, or
    a self-hosted variant with a different sweep could in principle hand it),
    correctly flags the host field and refuses to save — proving the wiring
    works even though the current server can never trigger it honestly.
    """
    # Best-effort cleanup from a run that crashed before its own teardown.
    for leftover_name in (SHOW_VERIFY_NAME, GHOST_SHOW_NAME):
        leftover = find_show(leftover_name)
        if leftover:
            api_write("DELETE", f"/shows/{leftover['id']}", ok_statuses=(200, 404))

    base_show = {
        "topic": "", "guestPersonaIds": [], "banter": False, "moods": [], "themeId": "",
        "genres": [], "eras": [], "energies": [], "vocals": "", "filtersStrict": False,
        "maxTrackSeconds": None, "playlistIds": [], "playlistStrict": False,
        "excludedPlaylistIds": [], "programme": False, "segmentSkill": "",
    }

    # 1. Validate — a show whose host is not a live persona. `GET /settings`
    #    is mocked (never the server) to hand the panel a `values.shows` entry
    #    whose `personaId` names nobody in `values.personas` — the one state
    #    the docstring above establishes the real server can never produce.
    real_settings = json.loads(api("/settings"))
    mocked_settings = json.loads(json.dumps(real_settings))  # deep copy
    mocked_settings["values"]["shows"] = [{
        **base_show, "id": "s_verify_ghost", "name": GHOST_SHOW_NAME, "personaId": "p_does_not_exist",
    }]

    def mock_settings_get(route):
        if route.request.method != "GET":
            route.continue_()
            return
        route.fulfill(status=200, content_type="application/json", body=json.dumps(mocked_settings))

    page.route("**/settings", mock_settings_get)
    try:
        page.goto(f"{WEB}/admin/shows")
        page.wait_for_selector("text=Build your shows here.")
        page.get_by_role("button", name=f"Edit {GHOST_SHOW_NAME}").click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for()

        host_field = dialog.get_by_label("persona owner")
        wait_for_invalid(page, host_field)
        assert_aria(page, host_field)
        assert_field_error(page, host_field, "must reference an existing persona")

        save = dialog.get_by_role("button", name="Save show")
        assert save.is_disabled(), "Save show enabled with a host that names no live persona"

        # ShowEditor's footer carries an explicit "Close" action (unlike
        # PersonaEditor's "Discard"), which shares its accessible name with
        # EditorDialog's header × control (aria-label="Close") — `.last` is
        # the real footer action, the one actually wired to onClose.
        dialog.get_by_role("button", name="Close").last.click()
        dialog.wait_for(state="detached")
    finally:
        page.unroute("**/settings", mock_settings_get)

    # 2 & 3, and the final valid save — one continuous "Add show" session,
    # against the REAL (unmocked) controller. Wrapped in try/finally like
    # skills()/blockrules()/imaging()/personas() — a real, persisted show is
    # created in step 4 below, and a run that fails partway through must not
    # leave it behind to poison the next run.
    try:
        page.goto(f"{WEB}/admin/shows")
        page.wait_for_selector("text=Build your shows here.")

        page.get_by_role("button", name="+ Add show").click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for()

        name = dialog.get_by_label("show name")
        name.fill("")
        name.fill(SHOW_VERIFY_NAME)  # mode: 'onChange' needs a real change event
        save = dialog.get_by_role("button", name="Save show")

        # Host defaults to the roster's first persona; pin it explicitly so the
        # guest-overlap scenario below is deterministic regardless of roster order.
        host_field = dialog.get_by_label("persona owner")
        host_field.click()
        page.get_by_role("option", name="Marlowe").click()

        # 2. Validate — maxTrackSeconds under the crossfade-derived floor (30s
        #    by default on this verify stack: max(30, ceil(2 * crossfadeDuration))).
        #    Scoped to the field's own aria-describedby -error id, like
        #    assertions 1 and 3 — never a bare page-wide `text=` match.
        maxlen = dialog.get_by_label("max track length (seconds)")
        maxlen.fill("5")
        wait_for_invalid(page, maxlen)
        assert_aria(page, maxlen)
        assert_field_error(
            page, maxlen,
            "must be 0 (inherit/unlimited) or at least the station's minimum track length",
        )
        assert save.is_disabled(), "Save show enabled with a track cap under the crossfade floor"

        maxlen.fill("")  # blank = inherit the station default, always valid
        wait_for_invalid(page, maxlen, invalid=False)

        # 3. Validate — a guest who is also the host. The pre-RHF editor
        #    auto-cleared an overlapping guest when the host changed, which made
        #    this state unreachable by honest UI interaction; that side effect is
        #    deliberately gone now (see ShowEditor's personaIdCtl comment), so
        #    picking a guest and then switching the host onto her really does
        #    reach it.
        guest_group = dialog.locator('[aria-labelledby$=".guestPersonaIds-label"]')
        guest_group.wait_for()
        guest_group.get_by_role("button", name="Wren").click()

        host_field.click()
        page.get_by_role("option", name="Wren").click()

        wait_for_invalid(page, guest_group)
        assert save.is_disabled(), "Save show enabled with a guest who is also the host"
        assert_aria(page, guest_group)
        assert_field_error(page, guest_group, "must not include the show's host persona")

        # Fix — host back to Marlowe (clears the overlap; Wren stays selected as
        # a guest, which is fine, but untoggle her too for a clean fixture).
        host_field.click()
        page.get_by_role("option", name="Marlowe").click()
        wait_for_invalid(page, guest_group, invalid=False)
        guest_group.get_by_role("button", name="Wren").click()

        assert not save.is_disabled(), "Save show stayed disabled once the overlap was fixed"

        # 4. Save — a genuinely valid show persists through a real POST /shows
        #    round trip.
        save.click()
        dialog.wait_for(state="detached")
        assert SHOW_VERIFY_NAME in api("/settings"), "new show did not persist"
    finally:
        # Runs whether the assertions above passed or raised — a failed run
        # must not leave "Verify Show" behind to poison the NEXT run, and a
        # successful run must not leave it in the shared stack forever either
        # (Task 13 runs this whole file against a freshly booted stack).
        leftover = find_show(SHOW_VERIFY_NAME)
        if leftover:
            api_write("DELETE", f"/shows/{leftover['id']}", ok_statuses=(200, 404))


@check
def schedule(page):
    """Rundown board — local booking survives until one authoritative save.

    The board is intentionally not an RHF form, but it is a programming
    surface exercised beside Shows and Playlists.  Stub the controller edge so
    the check can assert the exact PUT payload, the mounted live-schedule
    refresh, and the shared settings-cache patch without altering the isolated
    fixture's real week.
    """
    settings = json.loads(api("/settings"))
    personas = settings.get("values", {}).get("personas", [])
    assert personas, "verify stack needs a seeded persona"
    show = {
        "id": "s_verify_schedule", "name": "Verify Schedule Show",
        "personaId": personas[0]["id"], "moods": [], "energies": [],
    }
    week = {str(day): [None] * 24 for day in range(7)}
    settings["values"]["shows"] = [show]
    settings["values"]["schedule"] = week
    saved = {"schedule": None}

    page.route(
        f"{API}/settings",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(settings),
        ) if route.request.method == "GET" else route.continue_(),
    )

    def schedule_route(route):
        if route.request.method == "PUT":
            saved["schedule"] = json.loads(route.request.post_data or "{}").get("schedule")
            route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"schedule": saved["schedule"], "dropped": 0}),
            )
            return
        route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps({"schedule": saved["schedule"] or week, "override": None}),
        )

    page.route(f"{API}/schedule", schedule_route)
    page.goto(f"{WEB}/admin/shows/schedule")
    brush = page.locator('button[title*="Click to arm"]').first
    brush.wait_for(state="visible")
    brush.click()
    page.locator("button", has_text="+").filter(has_not_text="Add show").first.click()

    save = page.get_by_role("button", name="Save the week").first
    assert not save.is_disabled(), "Save the week stayed disabled after a booking"
    save.click()
    page.get_by_text("Week saved", exact=False).wait_for(state="visible")
    assert saved["schedule"], "Rundown save sent no schedule"
    booked = sum(1 for day in saved["schedule"].values() for show_id in day if show_id)
    assert booked > 0, f"Rundown save carried no booked cells: {saved['schedule']}"

    # The authoritative write patches settingsKeys.detail(), so navigation to
    # the roster observes the saved hour count without another settings GET.
    page.get_by_role("link", name="New show →").click()
    page.wait_for_url("**/admin/shows")
    metric = page.locator(".metric").filter(has_text="hours scheduled")
    metric.locator(".n").get_by_text(str(booked), exact=True).wait_for(state="visible")


PLAYLIST_NAME_MAX = 120  # controller/src/schemas/playlist.ts
PLAYLIST_VERIFY_NAME = "Verify Playlist"


@check
def playlists(page):
    """PlaylistBuilderPanel (Task 11) — the recipe rail is bound to
    playlistGenerateSchema (RecipeFormValues; no per-field rule exists in that
    schema — knobs/sources are deliberately unchecked passthrough, see
    schemas/playlist.ts's header comment — so `playlistHasIntent(buildBody())`
    stays the real Generate gate, called directly, exactly as before
    conversion; see the split comment at the top of PlaylistBuilderPanel.tsx).
    The save modal is a second, separate form bound to playlistSaveSchema
    itself: `name` is the ONE real rule in the whole playlist schema module
    (1-120 chars), which is what assertion 2 below exercises. `saveMode`
    rides in this form too but is NOT a schema key — assertion 4 pins the
    Fix round 1 regression where reading it off handleSubmit's (schema-
    parsed, `saveMode`-stripping) output made every "Overwrite existing"
    save silently create a duplicate instead.

    Reaching the deck (tracks.length > 0) needs a generation result, which in
    the real app comes from POST /playlists/generate/jobs over a live
    Navidrome + curation model. This verify stack's controller is started
    with an UNREACHABLE Navidrome on purpose for the other checks
    (NAVIDROME_URL=http://localhost:9999) — confirmed directly against the
    running stack (`curl -u test:test localhost:7791/dj/search?q=a` and
    `.../playlists` both answer `{"error":"fetch failed"}`), so there is no
    honest way to generate or persist a REAL playlist here. Generate and Save
    are therefore mocked at the browser's fetch boundary — the same
    `page.route()` technique shows()'s assertion 1 uses for its one
    server-unreachable rule — so what's under test is the CLIENT's own
    wiring (does the form assemble the real wire body, does it apply the
    server's response), not Navidrome reachability. Assertion 3 is proved
    against that mocked POST /playlists response rather than a real
    `api('/playlists')` GET round-trip, because that GET is equally
    unreachable here; the mock's own assertions on the posted body (name,
    songIds) are what stand in for "persisted correctly".

    The brief's other named assertion — "a backwards year window (yearFrom >
    yearTo) refuses" — does not correspond to any real rule anywhere in the
    system: knobs/eras carry no zod validation (playlistLooseRecord is
    deliberately unchecked passthrough) and no server logic rejects an
    inverted window either (music/playlist-gen.ts's matchesEra just filters
    every track out, indistinguishable from an over-narrow window that
    happens to match nothing). The DualRange widget instead makes the state
    UNREACHABLE BY CONSTRUCTION: its onLo/onHi clamp the incoming value
    against the OTHER thumb before either prop fires
    (playlist-builder/bits.tsx), so dragging "from" past "to" carries "to"
    along with it rather than crossing it — which is what assertion 1 proves
    instead, the real, reachable guarantee standing in for the brief's
    premise.
    """
    page.goto(f"{WEB}/admin/playlists")
    page.wait_for_selector("text=Describe the set")

    # 1. The year DualRange clamps rather than ever allowing an inverted
    #    window — see the docstring for why this replaces the brief's literal
    #    "backwards window refuses" premise (there is no such rule to trip).
    year_from = page.get_by_label("earliest release year")
    year_to = page.get_by_label("latest release year")
    year_max = int(year_from.get_attribute("max"))
    year_min = int(year_from.get_attribute("min"))
    year_to.fill(str(year_min + 5))
    year_from.fill(str(year_min + 5))
    year_from.fill(str(year_max))  # push "from" up to the slider's own max, past "to"
    assert int(year_from.input_value()) <= int(year_to.input_value()), (
        "yearFrom exceeded yearTo — the DualRange clamp regressed"
    )
    # Put the window back to "any year" (both anchors at their extremes) so
    # it doesn't feed a stray knob into the mocked generate call below —
    # cosmetic, the mock ignores the request body, but keeps this check's
    # intent honest.
    year_from.fill(str(year_min))
    year_to.fill(str(year_max))

    # Generate is gated on playlistHasIntent(buildBody()), not on this form's
    # own isValid (see the docstring) — an "any year" recipe with nothing
    # else set has no intent, same as pre-conversion, so give it a prompt.
    page.get_by_label("Vibe").fill("verify vibe")

    # 2 & 3 need at least one track in the deck — mocked generation, see the
    # docstring for why a real one isn't reachable in this environment.
    def mock_start(route):
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"jobId": "verify-job"}))

    def mock_poll(route):
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "status": "done",
            "result": {
                "tracks": [{"id": "verify-track-1", "title": "Verify Track", "artist": "Verify Artist", "durationSec": 180}],
                "reasons": [], "usedFallback": False, "poolSize": 1, "name": "", "description": None,
            },
        }))

    page.route("**/playlists/generate/jobs", mock_start)
    page.route("**/playlists/generate/jobs/verify-job", mock_poll)
    try:
        page.get_by_role("button", name="Generate", exact=True).click()
        # A bare `text=` selector also matches the browser <title> (this admin
        # shell reflects the now-playing track into the document title), which
        # is never visible and stalls wait_for_selector's default "visible"
        # state — scope to the deck row's own title span instead.
        page.locator("span.font-semibold", has_text="Verify Track").first.wait_for()
    finally:
        page.unroute("**/playlists/generate/jobs", mock_start)
        page.unroute("**/playlists/generate/jobs/verify-job", mock_poll)

    page.get_by_role("button", name="Save", exact=True).click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()

    name_field = dialog.get_by_label("Name")
    save_btn = dialog.get_by_role("button", name="Save playlist")

    # 2. Validate — a name over PLAYLIST_NAME_MAX refuses on the name field.
    name_field.fill("x" * (PLAYLIST_NAME_MAX + 1))
    wait_for_invalid(page, name_field)
    assert_aria(page, name_field)
    assert_field_error(page, name_field, f"1-{PLAYLIST_NAME_MAX}")
    assert save_btn.is_disabled(), "Save playlist enabled with a name over PLAYLIST_NAME_MAX"

    # 3. Save — a valid build submits the real wire body (mocked response —
    #    see the docstring) and the client applies it (modal closes).
    name_field.fill("")
    name_field.fill(PLAYLIST_VERIFY_NAME)
    wait_for_invalid(page, name_field, invalid=False)

    posted = {}

    def mock_save(route):
        if route.request.method != "POST":
            route.continue_()
            return
        posted.update(json.loads(route.request.post_data or "{}"))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"playlist": {"id": "verify-playlist-1"}, "added": 1}))

    page.route("**/playlists", mock_save)
    try:
        assert not save_btn.is_disabled(), "Save playlist stayed disabled with a valid name"
        save_btn.click()
        dialog.wait_for(state="detached")
    finally:
        page.unroute("**/playlists", mock_save)

    assert posted.get("name") == PLAYLIST_VERIFY_NAME, f"posted body carried the wrong name: {posted}"
    assert posted.get("songIds") == ["verify-track-1"], f"posted body did not carry the deck's track ids: {posted}"
    assert posted.get("playlistId") is None, f"a CREATE save carried a playlistId: {posted}"

    # 4. Save (overwrite) — Fix round 1 regression coverage. `saveMode` is not
    #    a key of playlistSaveSchema, so zodResolver's parsed output (what
    #    `handleSubmit`'s callback receives) silently drops it; reading it
    #    from there always saw `undefined`, so `overwrite` was always false
    #    and "Overwrite existing" created a duplicate instead of updating.
    #    The deck now holds `existingId` from assertion 3's save, so
    #    reopening Save defaults `saveMode` to 'overwrite' (openSave's own
    #    rule) — click it explicitly too, then assert the posted body
    #    actually carries `playlistId`.
    page.get_by_role("button", name="Update", exact=True).click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()
    dialog.get_by_role("button", name="Overwrite existing").click()
    save_btn = dialog.get_by_role("button", name="Save playlist")

    posted.clear()
    page.route("**/playlists", mock_save)
    try:
        save_btn.click()
        dialog.wait_for(state="detached")
    finally:
        page.unroute("**/playlists", mock_save)

    assert posted.get("playlistId") == "verify-playlist-1", (
        f"Overwrite existing did not carry playlistId — saveMode was dropped: {posted}"
    )


VERIFY_STACK_PERSONAS = {"Marlowe", "Wren", "Hale"}
ALLOW_DESTRUCTIVE_ENV = "SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE"


def assert_throwaway_stack():
    """Refuses to run a single check until the caller has EXPLICITLY opted
    into destructive writes against `API`/`WEB` — an env var, not an
    inference.

    Every check in this file does destructive, whole-array-replace writes —
    60-minute takeovers via `POST /schedule/override`, a full `POST /settings`
    personas-roster replace, show/rule/skill/festival create-and-delete — and
    they all authenticate as `test`/`test` (AUTH, above). Pointed at a real
    operator's station (a stale `SUBWAVE_HOME`, a command copy-pasted into the
    wrong shell) this would scribble over their actual configuration with no
    confirmation prompt anywhere in the file.

    An earlier version of this guard tried to INFER "throwaway" from two
    signals: test/test credentials authenticating, plus the persona roster
    containing the seeded names Marlowe/Wren/Hale. That inference does not
    hold: `SEED_PERSONAS` (`controller/src/settings/vocab.ts`) — the roster
    `defaults.ts` seeds on every FRESH install — is exactly Marlowe/Wren/Hale.
    Any real operator who hasn't yet customised personas satisfies both
    signals simultaneously; they aren't independent evidence of "throwaway",
    they're both just "this is an unconfigured install", which a real station
    legitimately is for a while after setup. A guard that reads as protection
    but doesn't protect is worse than none — it stops the next person from
    adding a real one, on the belief the risk is already covered.

    So the load-bearing check is now a plain opt-in: the caller must set
    `SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE=1` (or any other truthy-looking value —
    see `_env_truthy`) before running this file at all, which the product
    never sets on its own. `.claude/skills/verify/SKILL.md`'s documented
    isolated-controller boot is the one place that should ever export it.

    The old credential + roster checks are kept, but now purely as a
    SECONDARY sanity check that runs only once the opt-in has already been
    proven — they can turn a wrong-target opt-in into a clearer error message
    (e.g. "wrong port"), but they never substitute for the opt-in and never
    grant permission on their own.
    """
    if not _env_truthy(os.environ.get(ALLOW_DESTRUCTIVE_ENV)):
        print(
            f"ABORT: refusing to run — every check in this file makes "
            f"destructive writes against {API} (60-minute takeovers, a full "
            f"personas-roster replace, show/rule/skill/festival writes), "
            f"authenticated as test/test. This script will not infer that a "
            f"target is a safe throwaway stack; you must say so explicitly.\n"
            f"  Set {ALLOW_DESTRUCTIVE_ENV}=1 and re-run — only after "
            f"confirming {API} is the isolated verify controller from "
            f".claude/skills/verify/SKILL.md, never a real station.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    # Secondary sanity check, informational only from here on — it cannot
    # grant permission (that already happened above) and a failure here
    # aborts too, but the message is about a probably-wrong TARGET, not about
    # missing consent.
    try:
        settings = json.loads(api("/settings"))
    except Exception as e:  # noqa: BLE001 — any failure here means "not our stack"
        print(
            f"ABORT: {ALLOW_DESTRUCTIVE_ENV} is set, but could not read "
            f"{API}/settings with test/test admin credentials — this doesn't "
            f"look like the isolated verify stack's controller at all. "
            f"({type(e).__name__}: {e})",
            file=sys.stderr,
        )
        raise SystemExit(1)
    persona_names = {p.get("name") for p in settings.get("values", {}).get("personas", [])}
    if not VERIFY_STACK_PERSONAS.issubset(persona_names):
        print(
            f"ABORT: {ALLOW_DESTRUCTIVE_ENV} is set, but {API}'s persona "
            f"roster is {sorted(n for n in persona_names if n)!r}, not a "
            f"superset of the verify stack's seeded "
            f"{sorted(VERIFY_STACK_PERSONAS)!r} — double-check {API} is "
            f"really the isolated controller and not something else running "
            f"on this port.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def _env_truthy(v):
    return v is not None and v.strip().lower() not in ("", "0", "false", "no", "off")


if __name__ == "__main__":
    assert_throwaway_stack()
    names = sys.argv[1:] or list(CHECKS)
    results = []  # (name, passed, error) — the runner used to abort on the
    # FIRST failure (no try/except around CHECKS[name](page), no tally), so
    # "11/11 PASS" was only ever observable when every single check passed;
    # one failure hid the pass/fail status of everything after it in the
    # list. Now every check runs regardless of earlier failures, and the
    # process still exits non-zero if any of them failed, so CI-style
    # consumption (`&& echo ok`) still works.
    with sync_playwright() as pw:
        for name in names:
            browser, page = new_page(pw)
            try:
                CHECKS[name](page)
                print(f"PASS {name}")
                results.append((name, True, None))
            except Exception as e:  # noqa: BLE001 — record and keep going
                print(f"FAIL {name}: {e}")
                traceback.print_exc()
                results.append((name, False, e))
            finally:
                browser.close()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{passed}/{total} PASS" if passed == total else f"\n{passed}/{total} PASS, {total - passed} FAILED")
    if passed != total:
        for name, ok, e in results:
            if not ok:
                print(f"  FAILED: {name}: {e}")
        sys.exit(1)
