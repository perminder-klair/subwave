"""Focused checks for the shared admin TanStack Query client.

Runs only against the isolated controller and web servers documented in
.claude/skills/verify/SKILL.md.  It intentionally refuses any other ports.
"""
import base64
import copy
import json
import os
import sys
import tempfile
import traceback
import urllib.error
import urllib.parse
import urllib.request
import wave

from playwright.sync_api import sync_playwright

WEB = "http://localhost:7793"
API = "http://localhost:7791"
AUTH = base64.b64encode(b"test:test").decode()
ALLOW_DESTRUCTIVE_ENV = "SUBWAVE_VERIFY_ALLOW_DESTRUCTIVE"

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


def api_write(method, path, body=None, ok_statuses=(200, 204)):
    payload = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": f"Basic {AUTH}"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{API}{path}", data=payload, headers=headers, method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            assert response.status in ok_statuses, (method, path, response.status, raw)
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        if error.code in ok_statuses:
            return {}
        raise


def assert_verify_stack():
    if API != "http://localhost:7791" or WEB != "http://localhost:7793":
        sys.exit("refusing to run: API/WEB are not the verify stack's ports")
    try:
        api("/health")
    except Exception as error:
        sys.exit(f"verify stack not reachable at {API}: {error}")


DESTRUCTIVE_CHECKS = {
    "settings_save_propagates",
    "imaging_mutations_refresh",
    "personas_mutations_refresh",
    "show_install_refresh",
    "schedule_save_refresh",
    "playlist_sync_refresh",
    "skills_mutations_refresh",
    "doctor_report_updates",
}


def assert_destructive_opt_in(names):
    selected = DESTRUCTIVE_CHECKS.intersection(names)
    if selected and os.environ.get(ALLOW_DESTRUCTIVE_ENV) != "1":
        sys.exit(
            f"refusing destructive checks ({', '.join(sorted(selected))}): set "
            f"{ALLOW_DESTRUCTIVE_ENV}=1 only for the isolated verify stack"
        )


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
    context = browser.new_context(
        viewport={"width": 1440, "height": 900},
        reduced_motion="reduce",
    )
    context.add_init_script(
        f"localStorage.setItem('subwave_admin_auth', '{AUTH}')",
    )
    page = context.new_page()
    page.requests = []
    page.request_log = []
    def record_request(request):
        page.requests.append(request.url)
        page.request_log.append((request.method, request.url, bool(request.headers.get("authorization"))))
    page.on("request", record_request)
    return browser, page


def request_count(page, path, method="GET", query=None, authenticated=None):
    def matches(entry):
        entry_method, url, has_auth = entry
        parsed = urllib.parse.urlparse(url)
        return (
            entry_method == method
            and parsed.path == path
            and (query is None or parsed.query == query)
            and (authenticated is None or has_auth == authenticated)
        )
    return len([entry for entry in page.request_log if matches(entry)])


def mutation_cache_snapshot(page):
    return page.evaluate("""() => {
      if (typeof window.__subwaveAdminMutationCacheSnapshot !== 'function') {
        throw new Error('admin mutation cache observable is unavailable');
      }
      return window.__subwaveAdminMutationCacheSnapshot();
    }""")


def install_poll_clock(page):
    """Freeze browser timers and expose a deterministic visibility switch."""
    page.clock.install()
    page.add_init_script("""
      window.__subwaveVerifyHidden = false;
      Object.defineProperty(Document.prototype, 'hidden', {
        configurable: true,
        get: () => window.__subwaveVerifyHidden,
      });
      Object.defineProperty(Document.prototype, 'visibilityState', {
        configurable: true,
        get: () => window.__subwaveVerifyHidden ? 'hidden' : 'visible',
      });
    """)


def set_page_hidden(page, hidden):
    page.evaluate(
        "hidden => { window.__subwaveVerifyHidden = hidden; "
        "document.dispatchEvent(new Event('visibilitychange')); }",
        hidden,
    )


def settle_clock(page, milliseconds=0):
    page.clock.fast_forward(milliseconds)
    page.evaluate("() => Promise.resolve()")


def fulfill_json(route, body, status=200):
    route.fulfill(
        status=status,
        content_type="application/json",
        body=json.dumps(body),
    )


def is_admin_request(request, path, method="GET"):
    return (
        request.method == method
        and urllib.parse.urlparse(request.url).path == path
        and bool(request.headers.get("authorization"))
    )


def click_admin_link(page, name, path):
    page.get_by_role("link", name=name, exact=True).click()
    page.wait_for_url(f"**{path}**")


def write_silent_wav(path, seconds, rate=8000):
    with wave.open(path, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"\x00\x00" * int(rate * seconds))


def stub_dashboard(page, queue_track=False):
    state = {
        "upcoming": ([{
            "subsonic_id": "verify-queue-track",
            "title": "Verify queue track",
            "artist": "SUB/WAVE",
        }] if queue_track else []),
        "history": [],
        "autoPick": True,
        "autoLink": True,
        "musicStarved": False,
    }
    fixtures = {
        "/now-playing": {},
        "/state": state,
        "/session": {"messages": []},
        "/listeners/connections": {"count": 0, "connections": []},
        "/stats": {"llm": {"count": 0, "latency": {}}, "tts": {"count": 0}},
        "/requests": {"requests": []},
        "/generate/say-suggestions": {"suggestions": []},
        "/schedule": {"shows": [], "override": None},
        "/doctor/navidrome": {"ok": True},
    }

    def route_fixture(route):
        path = urllib.parse.urlparse(route.request.url).path
        if route.request.method == "DELETE" and path == "/dj/queue/verify-queue-track":
            fulfill_json(route, {"ok": True})
            return
        body = fixtures.get(path)
        if body is None:
            route.continue_()
            return
        fulfill_json(route, body)

    page.route("http://localhost:7791/**", route_fixture)


def model_response(models):
    return {
        "content_type": "application/json",
        "body": json.dumps({"ok": True, "models": models}),
    }


def voice_response(voices):
    return {
        "content_type": "application/json",
        "body": json.dumps({"ok": True, "voices": voices}),
    }


SETTINGS_FIXTURE = {
    "values": {
        "llm": {
            "provider": "ollama", "model": "", "ollamaUrl": "http://ollama.test",
            "providerBaseUrls": {}, "fallback": {"enabled": False, "provider": "ollama"},
        },
        "tts": {
            "enabled": True, "defaultEngine": "piper",
            "cloud": {
                "provider": "openai-compatible", "model": "", "voice": "", "baseUrl": "",
                "compatParams": [],
            },
        },
    },
    "llm": {"providers": ["ollama", "openai-compatible", "openrouter"]},
    "tts": {
        "engines": ["piper", "cloud"],
        "cloudProviders": ["openai-compatible", "elevenlabs"],
        "available": {"cloud": True, "cloudByProvider": {"openai-compatible": True, "elevenlabs": True}},
    },
    "env": {},
}


def stub_settings(page):
    page.route(
        "**/settings",
        lambda route: route.fulfill(content_type="application/json", body=json.dumps(SETTINGS_FIXTURE)),
    )


def open_settings_llm(page):
    stub_settings(page)
    page.goto(f"{WEB}/admin/settings?section=llm", wait_until="domcontentloaded")
    page.get_by_role("radio", name="OpenAI-compatible").click()
    return page.get_by_placeholder("http://192.168.1.101:8080/v1")


def open_settings_tts(page):
    stub_settings(page)
    page.goto(f"{WEB}/admin/settings?section=tts", wait_until="domcontentloaded")
    page.get_by_role("radio", name="Cloud").click()
    page.get_by_role("radiogroup", name="Cloud TTS provider").get_by_role("radio", name="OpenAI-compatible").click()
    return page.get_by_placeholder("http://192.168.1.101:5000/v1")


def enter_onboarding_llm(page):
    page.route(
        "**/onboarding/status",
        lambda route: route.fulfill(
            content_type="application/json",
            body=json.dumps({"needsSetup": True, "setupCompletedAt": None}),
        ),
    )
    page.goto(f"{WEB}/onboarding", wait_until="domcontentloaded")
    page.get_by_role("button", name="Next →").click()
    page.get_by_role("radio", name="OpenAI-compatible").click()
    return page.get_by_label("Base URL")


@check
def discovery_settings_debounce(page):
    model_hits = []
    page.route(
        "**/settings/llm/models**",
        lambda route: (model_hits.append(route.request.url), route.fulfill(**model_response(["fresh-model"])))[1],
    )
    box = open_settings_llm(page)
    box.fill("http://model.test/v1")
    page.wait_for_timeout(350)
    assert not [hit for hit in model_hits if "model.test" in hit], model_hits
    page.wait_for_timeout(100)
    matching = [hit for hit in model_hits if "model.test" in hit]
    assert len(matching) == 1, model_hits


@check
def discovery_voice_settings_debounce(page):
    voice_hits = []
    page.route(
        "**/settings/tts/voices**",
        lambda route: (voice_hits.append(route.request.url), route.fulfill(**voice_response([
            {"id": "debounced-voice", "label": "Debounced voice"},
        ])))[1],
    )
    box = open_settings_tts(page)
    box.fill("http://voice-debounce.test/v1")
    page.wait_for_timeout(350)
    assert not [hit for hit in voice_hits if "voice-debounce.test" in hit], voice_hits
    page.wait_for_timeout(100)
    matching = [hit for hit in voice_hits if "voice-debounce.test" in hit]
    assert len(matching) == 1, voice_hits


@check
def discovery_onboarding_provider(page):
    model_hits = []
    page.route(
        "**/settings/llm/models**",
        lambda route: (model_hits.append(route.request.url), route.fulfill(**model_response(["wizard-model"])))[1],
    )
    box = enter_onboarding_llm(page)
    box.fill("http://wizard.test/v1")
    page.wait_for_timeout(350)
    assert not [hit for hit in model_hits if "wizard.test" in hit], model_hits
    page.wait_for_timeout(100)
    wizard_hits = [hit for hit in model_hits if "wizard.test" in hit]
    assert len(wizard_hits) == 1, model_hits

    # The LLM step unmounts on navigation. Returning within the query client's
    # 30-second stale window must reuse its discovery result instead of making
    # an effect-backed request a second time.
    page.get_by_role("button", name="Next →").click()
    page.get_by_role("button", name="← Back").click()
    page.wait_for_timeout(450)
    wizard_hits = [hit for hit in model_hits if "wizard.test" in hit]
    assert len(wizard_hits) == 1, model_hits


@check
def discovery_refresh_is_immediate(page):
    model_hits = []
    page.route(
        "**/settings/llm/models**",
        lambda route: (model_hits.append(route.request.url), route.fulfill(**model_response(["refresh-model"])))[1],
    )
    box = open_settings_llm(page)
    box.fill("http://refresh.test/v1")
    page.get_by_title("Refresh model list").first.click()
    page.wait_for_timeout(0)
    refresh_hits = [hit for hit in model_hits if "refresh.test" in hit]
    assert len(refresh_hits) == 1, model_hits
    # Once the debounce catches up it observes the same raw-key cache entry;
    # the manual refresh must not turn into a duplicate automatic request.
    page.wait_for_timeout(450)
    refresh_hits = [hit for hit in model_hits if "refresh.test" in hit]
    assert len(refresh_hits) == 1, model_hits


@check
def discovery_voice_refresh_is_immediate(page):
    voice_hits = []
    page.route(
        "**/settings/tts/voices**",
        lambda route: (voice_hits.append(route.request.url), route.fulfill(**voice_response([
            {"id": "refresh-voice", "label": "Refresh voice"},
        ])))[1],
    )
    settings = json.loads(json.dumps(SETTINGS_FIXTURE))
    settings["env"]["ELEVENLABS_API_KEY"] = True
    page.route(
        "**/settings",
        lambda route: route.fulfill(content_type="application/json", body=json.dumps(settings)),
    )
    page.goto(f"{WEB}/admin/settings?section=tts", wait_until="domcontentloaded")
    page.get_by_role("radio", name="Cloud").click()
    page.get_by_role("radiogroup", name="Cloud TTS provider").get_by_role("radio", name="OpenAI-compatible").click()
    box = page.get_by_placeholder("http://192.168.1.101:5000/v1")
    box.fill("http://voice-refresh.test/v1")
    page.wait_for_timeout(600)
    refresh_button = page.get_by_title("Refresh voice list")
    refresh_button.wait_for(state="visible")
    refresh_button.scroll_into_view_if_needed()
    page.get_by_role("radiogroup", name="Cloud TTS provider").get_by_role("radio", name="ElevenLabs").click()
    # ElevenLabs has curated choices, so the picker remains rendered while its
    # fresh discovery request is pending. Rachel proves the new provider input
    # is committed before the refresh handler reads it.
    page.get_by_role("button", name="Rachel").wait_for(state="visible")
    refresh_button.click()
    page.wait_for_timeout(0)
    refresh_hits = [hit for hit in voice_hits if "provider=elevenlabs" in hit]
    assert len(refresh_hits) == 1, voice_hits
    page.wait_for_timeout(450)
    refresh_hits = [hit for hit in voice_hits if "provider=elevenlabs" in hit]
    assert len(refresh_hits) == 1, voice_hits


@check
def discovery_stale_response_isolated(page):
    model_hits = []
    voice_hits = []

    # The endpoint can answer the old key immediately, but keep its browser
    # fetch promise pending until after the new key renders. This reproduces
    # the real race without adding a second server or touching the controller.
    page.add_init_script("""
      const nativeFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        if (url.includes('old.test')) await new Promise(resolve => setTimeout(resolve, 900));
        return response;
      };
    """)

    def models(route):
        url = route.request.url
        model_hits.append(url)
        if "old.test" in url:
            route.fulfill(**model_response(["old-model"]))
            return
        route.fulfill(**model_response(["new-model"]))

    page.route("**/settings/llm/models**", models)
    def voices(route):
        voice_hits.append(route.request.url)
        # Keep the new provider pending so the reopened picker can only expose
        # local ElevenLabs choices. A stale old-provider result must not leak
        # back into that list while its replacement is still loading.
        if "provider=elevenlabs" not in route.request.url:
            route.fulfill(**voice_response([{"id": "old-voice", "label": "Old voice"}]))

    page.route("**/settings/tts/voices**", voices)
    box = open_settings_llm(page)
    box.fill("http://old.test/v1")
    page.wait_for_timeout(450)
    box.fill("http://new.test/v1")
    page.wait_for_timeout(450)
    assert any("old.test" in hit for hit in model_hits), model_hits
    assert any("new.test" in hit for hit in model_hits), model_hits
    picker = page.get_by_role("button", name="Select a model")
    picker.scroll_into_view_if_needed()
    picker.click()
    assert page.get_by_text("new-model", exact=True).is_visible()
    picker.click()
    page.wait_for_timeout(450)
    picker.scroll_into_view_if_needed()
    picker.click()
    assert page.get_by_text("new-model", exact=True).is_visible()
    picker.click()

    # Voice discovery lives in the TTS cloud panel. Its old list must disappear
    # synchronously when the provider changes, before the next provider can
    # finish discovery.
    voice_url = open_settings_tts(page)
    voice_url.fill("http://voice.test/v1")
    page.wait_for_timeout(600)
    assert any("voice.test" in hit for hit in voice_hits), voice_hits
    voice_picker = page.get_by_role("button", name="Custom voice id…")
    voice_picker.scroll_into_view_if_needed()
    voice_picker.click()
    assert page.get_by_text("Old voice", exact=True).is_visible()
    page.keyboard.press("Escape")
    page.get_by_role("radiogroup", name="Cloud TTS provider").get_by_role("radio", name="ElevenLabs").click()
    voice_picker = page.get_by_role("button", name="Rachel")
    voice_picker.scroll_into_view_if_needed()
    voice_picker.click()
    assert not page.get_by_text("Old voice", exact=True).is_visible()


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


@check
def unauthorised_shell_signs_out(page):
    """The one StationSwitcher 401 tears down the shell-owned query provider."""
    hits = []
    page.route(
        "**/stations",
        lambda route: (hits.append(route.request.url), route.fulfill(status=401, body='{}'))[1],
    )
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_text("Admin sign-in", exact=True).wait_for(state="visible")
    assert len(hits) == 1, hits
    assert page.evaluate("localStorage.getItem('subwave_admin_auth')") is None
    assert page.evaluate(
        "typeof window.__subwaveAdminMutationCacheSnapshot"
    ) == "undefined"


@check
def dashboard_poll_cadences(page):
    """Catches a changed cadence or a Dashboard interval that runs while hidden."""
    install_poll_clock(page)
    stub_dashboard(page)
    with page.expect_request(lambda request: is_admin_request(request, "/requests")):
        page.goto(f"{WEB}/admin/dash", wait_until="domcontentloaded")
    page.get_by_text("queue empty, auto-playlist fallback", exact=True).wait_for(state="visible")
    settle_clock(page)
    initial = {
        path: request_count(page, path, authenticated=True)
        for path in ("/session", "/listeners/connections", "/stats", "/requests")
    }
    assert all(count > 0 for count in initial.values()), (initial, page.request_log)

    settle_clock(page, 2_900)
    assert request_count(page, "/session", authenticated=True) == initial["/session"], page.request_log
    with page.expect_request(lambda request: is_admin_request(request, "/session")):
        settle_clock(page, 100)
    assert request_count(page, "/session", authenticated=True) == initial["/session"] + 1, page.request_log

    with page.expect_request(lambda request: is_admin_request(request, "/listeners/connections")):
        with page.expect_request(lambda request: is_admin_request(request, "/requests")):
            settle_clock(page, 7_000)
    assert request_count(page, "/listeners/connections", authenticated=True) == initial["/listeners/connections"] + 1, page.request_log
    assert request_count(page, "/requests", authenticated=True) == initial["/requests"] + 1, page.request_log
    with page.expect_request(lambda request: is_admin_request(request, "/stats")):
        settle_clock(page, 5_000)
    assert request_count(page, "/stats", authenticated=True) == initial["/stats"] + 1, page.request_log

    before = {
        path: request_count(page, path, authenticated=True)
        for path in ("/session", "/listeners/connections", "/stats", "/requests")
    }
    set_page_hidden(page, True)
    settle_clock(page, 30_000)
    after = {path: request_count(page, path, authenticated=True) for path in before}
    assert after == before, (before, after)


@check
def dashboard_mutation_refresh(page):
    """Catches queue cancellation that waits for the next status/request polls."""
    install_poll_clock(page)
    stub_dashboard(page, queue_track=True)
    page.goto(f"{WEB}/admin/dash", wait_until="domcontentloaded")
    remove = page.get_by_role("button", name="Remove Verify queue track from queue")
    remove.wait_for(state="visible")
    before_status = request_count(page, "/session", authenticated=True)
    before_requests = request_count(page, "/requests", authenticated=True)
    remove.click()
    settle_clock(page, 50)
    assert request_count(page, "/dj/queue/verify-queue-track", "DELETE", authenticated=True) == 1, page.request_log
    assert request_count(page, "/session", authenticated=True) == before_status + 1, page.request_log
    assert request_count(page, "/requests", authenticated=True) == before_requests + 1, page.request_log


@check
def stats_pause_and_poll(page):
    """Catches incorrect Stats cadences, range keys, pause, or hidden polling."""
    install_poll_clock(page)
    stub_dashboard(page)
    stats = {
        "llm": {
            "window": 0, "count": 0, "ok": 0, "failed": 0,
            "latency": {}, "agent": {"calls": 0}, "byKind": [], "byModel": [],
        },
        "tts": {
            "window": 0, "count": 0, "ok": 0, "failed": 0,
            "latency": {}, "fellBack": 0, "byEngine": [], "byKind": [],
        },
        "djLog": {"count": 0, "byKind": []},
        "requests": {
            "window": 0, "count": 0, "resolved": 0, "failed": 0,
            "latency": {}, "artistMiss": {"count": 0}, "byPath": [],
            "byPickSource": [], "topRequesters": [],
        },
    }
    fixtures = {
        "/stats": stats,
        "/listeners": {"current": 0, "samples": []},
        "/audience": {"sessions": 0, "referrers": [], "countries": [], "paths": []},
        "/listeners/connections": {"count": 0, "connections": []},
        "/system": {"containers": []},
    }
    def stats_routes(route):
        parsed = urllib.parse.urlparse(route.request.url)
        body = fixtures.get(parsed.path)
        if body is None:
            route.fallback()
            return
        fulfill_json(route, body)
    page.route("http://localhost:7791/**", stats_routes)

    with page.expect_request(lambda request: is_admin_request(request, "/stats")):
        page.goto(f"{WEB}/admin/stats", wait_until="domcontentloaded")
    pause = page.get_by_role("button", name="Pause")
    pause.wait_for(state="visible")
    paths = ("/stats", "/listeners", "/audience", "/listeners/connections", "/system")
    initial = {path: request_count(page, path) for path in paths}
    assert all(count > 0 for count in initial.values()), (initial, page.request_log)
    settle_clock(page, 5_000)
    assert request_count(page, "/stats") == initial["/stats"] + 1, page.request_log
    assert all(request_count(page, path) == initial[path] for path in paths[1:]), page.request_log

    pause.click()
    paused = {path: request_count(page, path) for path in paths}
    page.get_by_text("7d", exact=True).click()
    settle_clock(page, 30_000)
    settle_clock(page)
    assert {path: request_count(page, path) for path in paths} == paused, page.request_log

    page.get_by_role("button", name="Resume").click()
    settle_clock(page)
    assert request_count(page, "/listeners", query="sinceMinutes=10080") == 1, page.request_log
    assert request_count(page, "/audience", query="sinceMinutes=10080") == 1, page.request_log

    before_hidden = {path: request_count(page, path) for path in paths}
    set_page_hidden(page, True)
    settle_clock(page, 30_000)
    after_hidden = {path: request_count(page, path) for path in paths}
    assert after_hidden == before_hidden, (before_hidden, after_hidden)


@check
def stats_range_failure_retains_last_good(page):
    """Catches a failed new range replacing the last visible listener rollups."""
    install_poll_clock(page)
    stub_dashboard(page)
    stats = {
        "llm": {
            "window": 0, "count": 0, "ok": 0, "failed": 0,
            "latency": {}, "agent": {"calls": 0}, "byKind": [], "byModel": [],
        },
        "tts": {
            "window": 0, "count": 0, "ok": 0, "failed": 0,
            "latency": {}, "fellBack": 0, "byEngine": [], "byKind": [],
        },
        "djLog": {"count": 0, "byKind": []},
        "requests": {
            "window": 0, "count": 0, "resolved": 0, "failed": 0,
            "latency": {}, "artistMiss": {"count": 0}, "byPath": [],
            "byPickSource": [], "topRequesters": [],
        },
    }

    def range_routes(route):
        parsed = urllib.parse.urlparse(route.request.url)
        if parsed.path == "/stats":
            fulfill_json(route, stats)
        elif parsed.path == "/listeners" and parsed.query == "sinceMinutes=1440":
            fulfill_json(route, {"current": 7, "samples": [{"t": "2026-08-23T12:00:00Z", "count": 7}]})
        elif parsed.path == "/audience" and parsed.query == "sinceMinutes=1440":
            fulfill_json(route, {
                "sessions": 13,
                "referrers": [{"source": "Direct", "count": 13}],
                "countries": [{"country": "GB", "count": 13}],
                "paths": [],
            })
        elif parsed.path in ("/listeners", "/audience") and parsed.query == "sinceMinutes=10080":
            fulfill_json(route, {"error": "verification failure"}, status=503)
        elif parsed.path == "/listeners/connections":
            fulfill_json(route, {"count": 0, "connections": []})
        elif parsed.path == "/system":
            fulfill_json(route, {"containers": []})
        else:
            route.fallback()
    page.route("http://localhost:7791/**", range_routes)

    with page.expect_request(lambda request: is_admin_request(request, "/stats")):
        page.goto(f"{WEB}/admin/stats", wait_until="domcontentloaded")
    page.get_by_text("Sessions", exact=True).locator("..").get_by_text("13", exact=True).wait_for(state="visible")
    page.get_by_text("Now", exact=True).locator("..").get_by_text("7", exact=True).wait_for(state="visible")

    with page.expect_response(
        lambda response: urllib.parse.urlparse(response.url).path == "/audience"
        and urllib.parse.urlparse(response.url).query == "sinceMinutes=10080"
    ):
        page.get_by_text("7d", exact=True).click()
    settle_clock(page)

    page.get_by_text("Now", exact=True).locator("..").get_by_text("7", exact=True).wait_for(state="visible")
    page.get_by_text("Sessions", exact=True).locator("..").get_by_text("13", exact=True).wait_for(state="visible")


@check
def debug_pause_and_poll(page):
    """Catches overlap-prone Debug timing, pause drift, or hidden polling."""
    install_poll_clock(page)
    stub_dashboard(page)
    debug = {
        "queue": {"current": None, "upcoming": [], "djLog": [], "djLogCount": 0},
        "config": {}, "nowPlaying": None, "context": {}, "liquidsoapLog": "",
        "llm": {"provider": "verify", "activeModel": "verify", "recentCalls": []},
        "subsonic": {"recentCalls": [], "endpoints": []},
    }
    page.route("http://localhost:7791/debug", lambda route: fulfill_json(route, debug))
    with page.expect_request(lambda request: is_admin_request(request, "/debug")):
        page.goto(f"{WEB}/admin/debug", wait_until="domcontentloaded")
    pause = page.get_by_role("button", name="Pause")
    pause.wait_for(state="visible")
    settle_clock(page)
    initial_debug = request_count(page, "/debug")
    assert initial_debug > 0, page.request_log
    settle_clock(page, 1_000)
    assert request_count(page, "/debug") == initial_debug, page.request_log
    settle_clock(page, 1_000)
    assert request_count(page, "/debug") == initial_debug + 1, page.request_log

    pause.click()
    paused = request_count(page, "/debug")
    settle_clock(page, 4_000)
    assert request_count(page, "/debug") == paused, page.request_log
    page.get_by_role("button", name="Resume").click()
    settle_clock(page)
    assert request_count(page, "/debug") == paused + 1, page.request_log

    set_page_hidden(page, True)
    hidden = request_count(page, "/debug")
    settle_clock(page, 4_000)
    assert request_count(page, "/debug") == hidden, page.request_log
    set_page_hidden(page, False)
    settle_clock(page)
    assert request_count(page, "/debug") == hidden + 1, page.request_log


@check
def banner_poll_silence(page):
    """Catches changed 30s banner/takeover beats or hidden-tab traffic."""
    install_poll_clock(page)
    stub_dashboard(page)
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_role("link", name="Dash", exact=True).wait_for(state="visible")
    initial_doctor = request_count(page, "/doctor/navidrome", authenticated=True)
    assert initial_doctor > 0, page.request_log
    initial_state = request_count(page, "/state", authenticated=True)
    settle_clock(page, 30_000)
    assert request_count(page, "/doctor/navidrome", authenticated=True) == initial_doctor + 1, page.request_log
    assert request_count(page, "/state", authenticated=True) == initial_state + 1, page.request_log

    hidden_doctor = request_count(page, "/doctor/navidrome", authenticated=True)
    hidden_state = request_count(page, "/state", authenticated=True)
    set_page_hidden(page, True)
    settle_clock(page, 30_000)
    assert request_count(page, "/doctor/navidrome", authenticated=True) == hidden_doctor, page.request_log
    assert request_count(page, "/state", authenticated=True) == hidden_state, page.request_log

    set_page_hidden(page, False)
    page.get_by_role("link", name="Dash", exact=True).click()
    page.wait_for_url("**/admin/dash")
    page.get_by_text("queue empty, auto-playlist fallback", exact=True).wait_for(state="visible")
    initial_schedule = request_count(page, "/schedule")
    settle_clock(page, 30_000)
    assert request_count(page, "/schedule") == initial_schedule + 1, page.request_log
    set_page_hidden(page, True)
    hidden_schedule = request_count(page, "/schedule")
    settle_clock(page, 30_000)
    assert request_count(page, "/schedule") == hidden_schedule, page.request_log


@check
def takeover_expiry_survives_failed_poll(page):
    """Catches an expired takeover frozen on air by a failed schedule poll."""
    install_poll_clock(page)
    stub_dashboard(page)
    now = page.evaluate("Date.now()")
    schedule_hits = 0

    def schedule_route(route):
        nonlocal schedule_hits
        schedule_hits += 1
        if schedule_hits == 1:
            fulfill_json(route, {
                "shows": [{"id": "review-show", "name": "Review takeover show"}],
                "override": {
                    "showId": "review-show",
                    "startedAt": now,
                    "expiresAt": now + 30_000,
                },
            })
        else:
            fulfill_json(route, {"error": "verification failure"}, status=503)
    page.route("http://localhost:7791/schedule", schedule_route)

    with page.expect_request(lambda request: is_admin_request(request, "/schedule")):
        page.goto(f"{WEB}/admin/dash", wait_until="domcontentloaded")
    page.get_by_role("button", name="Cancel takeover").wait_for(state="visible")

    with page.expect_response(
        lambda response: urllib.parse.urlparse(response.url).path == "/schedule"
        and response.status == 503
    ):
        settle_clock(page, 30_000)
    settle_clock(page)

    page.get_by_role("button", name="Pin to air →").wait_for(state="visible")
    assert schedule_hits == 2, schedule_hits


@check
def settings_cache_shared(page):
    """Every admin curation surface observes one fresh /settings cache entry."""
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
    click_admin_link(page, "Moods", "/admin/moods")
    page.get_by_text("Moods & moments.", exact=True).wait_for(state="visible")
    click_admin_link(page, "Personas", "/admin/personas")
    page.get_by_text("The voices on your station.", exact=True).wait_for(state="visible")
    click_admin_link(page, "Imaging", "/admin/imaging")
    page.get_by_text("The sounds between the songs.", exact=True).wait_for(state="visible")
    click_admin_link(page, "Settings", "/admin/settings")
    page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
    assert request_count(page, "/settings", authenticated=True) == 1, page.request_log
    # StationSwitcher owns the authenticated shell read. A second standalone
    # auth probe would duplicate both the normal request and a revoked-token 401.
    assert request_count(page, "/stations", authenticated=True) == 1, page.request_log


@check
def settings_save_propagates(page):
    """One safe GET propagates a save without caching POST secrets or stale derived data."""
    initial = copy.deepcopy(api("/settings"))
    fixture = "Task 4 shared settings cache fixture"
    secret = "task4-raw-post-secret-must-not-cache"
    unsaved_key = "operator-unsaved-search-key"
    mood = "task4-derived-mood"
    initial_values = copy.deepcopy(initial.get("values", {}))
    personas = initial_values.get("personas", [])
    assert len(personas) >= 2, "verify settings need two seeded personas"
    on_air_id = personas[1]["id"]

    # Make the secret-bearing Search control deterministic without persisting a
    # credential. GET stays redacted; only the mocked POST carries raw material.
    initial_values["search"] = {
        **initial_values.get("search", {}), "provider": "tavily", "apiKey": "set",
    }
    initial["values"] = initial_values
    raw_saved = copy.deepcopy(initial_values)
    raw_saved["stationDescription"] = fixture
    raw_saved["search"] = {**raw_saved["search"], "apiKey": secret}
    raw_saved["moods"] = [*raw_saved.get("moods", []), {"name": mood, "clapPrompt": ""}]
    raw_saved["activePersonaId"] = on_air_id

    authoritative = copy.deepcopy(initial)
    authoritative["values"] = copy.deepcopy(raw_saved)
    authoritative["values"]["search"]["apiKey"] = "set"
    authoritative.setdefault("tts", {})["moods"] = [
        entry.get("name") for entry in authoritative["values"]["moods"]
    ]
    authoritative["onAir"] = {"personaId": on_air_id, "show": None}
    state = {"saved": False}

    def settings_route(route):
        if route.request.method == "POST":
            state["saved"] = True
            fulfill_json(route, {"saved": raw_saved, "requiresRestart": False})
        else:
            fulfill_json(route, authoritative if state["saved"] else initial)

    page.route("http://localhost:7791/settings", settings_route)
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    description = page.get_by_placeholder("A short line describing your station…")
    description.wait_for(state="visible")
    initial_gets = request_count(page, "/settings", authenticated=True)
    description.fill(fixture)
    # Keep an unrelated section dirty while Station saves. The authoritative
    # revision must not use that save as permission to erase this edit.
    page.get_by_role("button", name="Web search", exact=False).click()
    page.locator('input[type="password"]:visible').first.fill(unsaved_key)
    page.get_by_role("button", name="Station", exact=False).click()
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/settings", "POST")
    ):
        page.get_by_role("button", name="Save station settings").click()
    page.wait_for_timeout(300)
    assert request_count(page, "/settings", authenticated=True) == initial_gets + 1, page.request_log
    page.get_by_role("button", name="Web search", exact=False).click()
    search_key = page.locator('input[type="password"]:visible').first
    search_key.wait_for(state="visible")
    assert search_key.input_value() == unsaved_key, search_key.input_value()

    # Remount from the still-fresh shared entry: there is no third GET, the
    # saved description propagates, and the raw POST secret never reaches DOM.
    click_admin_link(page, "Moods", "/admin/moods")
    page.get_by_text("Moods & moments.", exact=True).wait_for(state="visible")
    click_admin_link(page, "Settings", "/admin/settings")
    description = page.get_by_placeholder("A short line describing your station…")
    description.wait_for(state="visible")
    assert description.input_value() == fixture, description.input_value()
    page.get_by_role("button", name="Web search", exact=False).click()
    search_key = page.locator('input[type="password"]:visible').first
    search_key.wait_for(state="visible")
    assert search_key.input_value() != secret, search_key.input_value()
    assert "key on file" in (search_key.get_attribute("placeholder") or "")

    # The same authoritative GET refreshes top-level derived fields consumed by
    # Festivals and Personas; retaining the old envelope would miss both.
    click_admin_link(page, "Moods", "/admin/moods")
    page.get_by_role("tab", name="Festivals").click()
    page.get_by_role("button", name="Add festival").click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Mood").click()
    page.get_by_role("option", name=mood).wait_for(state="visible")
    page.keyboard.press("Escape")
    dialog.get_by_role("button", name="Cancel").click()
    dialog.wait_for(state="detached")
    click_admin_link(page, "Personas", "/admin/personas")
    hero = page.locator("section.card").filter(has_text="● on air").first
    hero.get_by_text(personas[1]["name"], exact=True).wait_for(state="visible")
    assert request_count(page, "/settings", authenticated=True) == initial_gets + 1, page.request_log


@check
def settings_save_serializes_after_inflight_get(page):
    """A save cannot dedupe its authoritative read onto a pre-write GET."""
    initial = copy.deepcopy(api("/settings"))
    initial["values"]["stationDescription"] = "old server description"
    operator_value = "operator write during an overlapping poll"
    authoritative_value = "server-normalised post-write description"
    authoritative = copy.deepcopy(initial)
    authoritative["values"]["stationDescription"] = authoritative_value
    raw_saved = copy.deepcopy(initial["values"])
    raw_saved["stationDescription"] = operator_value
    state = {
        "initial_gets": 0,
        "posted": False,
        "post_write_gets": 0,
    }

    def settings_route(route):
        if route.request.method == "POST":
            state["posted"] = True
            fulfill_json(route, {"saved": raw_saved, "requiresRestart": False})
            return
        if state["initial_gets"] == 0:
            state["initial_gets"] += 1
            fulfill_json(route, initial)
            return
        if state["posted"]:
            state["post_write_gets"] += 1
            fulfill_json(route, authoritative)
            return
        fulfill_json(route, initial)

    # Resolve the polling GET at the network boundary, but hold its fetch
    # promise in the browser until either its AbortSignal fires or the RED run
    # releases it. This exercises the real TanStack/adminFetch cancellation
    # path without leaving a Playwright route callback pending.
    page.add_init_script("""
      (() => {
        const nativeFetch = window.fetch.bind(window);
        const race = {
          holdNext: false,
          held: false,
          aborted: false,
          released: false,
          release: null,
        };
        window.__subwaveSettingsRace = race;
        window.__subwaveHoldSettingsGet = () => { race.holdNext = true; };
        window.__subwaveReleaseSettingsGet = () => race.release?.();
        window.fetch = async (input, init = {}) => {
          const response = await nativeFetch(input, init);
          const url = typeof input === 'string' ? input : input.url;
          const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
          if (!race.holdNext || method !== 'GET' || new URL(url, location.href).pathname !== '/settings') {
            return response;
          }
          race.holdNext = false;
          race.held = true;
          await new Promise((resolve, reject) => {
            const signal = init.signal;
            let settled = false;
            const finish = (kind) => {
              if (settled) return;
              settled = true;
              signal?.removeEventListener('abort', onAbort);
              if (kind === 'abort') {
                race.aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
              } else {
                race.released = true;
                resolve();
              }
            };
            const onAbort = () => finish('abort');
            race.release = () => finish('release');
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
          return response;
        };
      })();
    """)
    install_poll_clock(page)
    page.route("http://localhost:7791/settings", settings_route)
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    description = page.get_by_placeholder("A short line describing your station…")
    description.wait_for(state="visible")
    initial_gets = request_count(page, "/settings", authenticated=True)

    with page.expect_request(
        lambda request: is_admin_request(request, "/settings", "GET")
    ):
        page.evaluate("window.__subwaveHoldSettingsGet()")
        settle_clock(page, 3_000)
    page.wait_for_function("window.__subwaveSettingsRace.held")

    description.fill(operator_value)
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/settings", "POST")
    ):
        page.get_by_role("button", name="Save station settings").click()

    # Give a serialized implementation time to cancel the old request and
    # start its exact post-write GET. The old implementation is waiting on the
    # held request, so release it only to let the RED run terminate cleanly.
    page.wait_for_timeout(250)
    if state["post_write_gets"] == 0:
        page.evaluate("window.__subwaveReleaseSettingsGet()")
    page.wait_for_timeout(300)

    race = page.evaluate("window.__subwaveSettingsRace")
    assert race["aborted"], race
    assert not race["released"], "save waited for and accepted the pre-write GET"
    assert state["post_write_gets"] == 1, state
    assert request_count(page, "/settings", authenticated=True) == initial_gets + 2, page.request_log
    assert description.input_value() == authoritative_value, description.input_value()


@check
def settings_mutation_cache_redacts_secrets(page):
    """Settings MutationCache retains neither secret variables nor raw POST data."""
    initial = copy.deepcopy(api("/settings"))
    secret = "task4-mutation-cache-secret"
    initial["values"]["search"] = {
        **initial["values"].get("search", {}), "provider": "tavily", "apiKey": "set",
    }
    raw_saved = copy.deepcopy(initial["values"])
    raw_saved["search"]["apiKey"] = secret
    authoritative = copy.deepcopy(initial)
    state = {"saved": False}

    def settings_route(route):
        if route.request.method == "POST":
            state["saved"] = True
            fulfill_json(route, {"saved": raw_saved, "requiresRestart": False})
        else:
            fulfill_json(route, authoritative if state["saved"] else initial)

    page.route("http://localhost:7791/settings", settings_route)
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
    initial_gets = request_count(page, "/settings", authenticated=True)
    page.get_by_role("button", name="Web search", exact=False).click()
    page.locator('input[type="password"]:visible').first.fill(secret)
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/settings", "POST")
    ):
        page.get_by_role("button", name="Save web search").click()
    page.wait_for_timeout(200)
    assert request_count(page, "/settings", authenticated=True) == initial_gets + 1, page.request_log
    settings_mutations = mutation_cache_snapshot(page)
    assert settings_mutations, mutation_cache_snapshot(page)
    serialized = json.dumps(settings_mutations)
    assert secret not in serialized, serialized
    assert all(mutation.get("variables") is None for mutation in settings_mutations), settings_mutations
    assert all(mutation.get("data") is None for mutation in settings_mutations), settings_mutations


@check
def moods_cross_card_save_preserves_dirty(page):
    """Saving Moments card A keeps card B's value and dirty/default state."""
    initial = copy.deepcopy(api("/settings"))
    moods = [
        {"name": "baseline-mood", "clapPrompt": ""},
        {"name": "alternate-mood", "clapPrompt": ""},
    ]
    initial["values"]["moods"] = moods
    initial["values"]["moodSchedule"] = {"early-morning": "baseline-mood"}
    initial["values"]["weatherMoods"] = {"clear": "baseline-mood"}
    initial.setdefault("tts", {})["moods"] = ["baseline-mood", "alternate-mood"]
    authoritative = copy.deepcopy(initial)
    authoritative["values"]["moodSchedule"]["early-morning"] = "alternate-mood"
    state = {"saved": False}

    def settings_route(route):
        if route.request.method == "POST":
            state["saved"] = True
            fulfill_json(route, {"saved": authoritative["values"], "requiresRestart": False})
        else:
            fulfill_json(route, authoritative if state["saved"] else initial)

    def choose(field, option):
        field.click()
        page.get_by_role("option", name=option, exact=True).click()

    page.route("http://localhost:7791/settings", settings_route)
    page.goto(f"{WEB}/admin/moods?tab=moments", wait_until="domcontentloaded")
    schedule = page.get_by_label("Early morning · 05–09")
    weather = page.get_by_label("Clear")
    schedule.wait_for(state="visible")
    choose(weather, "alternate-mood")
    choose(schedule, "alternate-mood")
    weather_save = page.get_by_role("button", name="Save weather moods")
    assert not weather_save.is_disabled()
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/settings", "POST")
    ):
        page.get_by_role("button", name="Save time-of-day moods").click()
    page.wait_for_timeout(200)
    assert "alternate-mood" in weather.inner_text(), weather.inner_text()
    assert not weather_save.is_disabled(), "saving schedule cleared the weather card's dirty state"


def install_settings_refresh_failure(page, initial):
    state = {"posted": False}

    def settings_route(route):
        if route.request.method == "POST":
            state["posted"] = True
            fulfill_json(route, {"saved": initial["values"], "requiresRestart": False})
        elif state["posted"]:
            fulfill_json(route, {"error": "redacted settings refresh unavailable"}, status=503)
        else:
            fulfill_json(route, initial)

    page.route("http://localhost:7791/settings", settings_route)


@check
def moods_save_refresh_failure_preserves_edit(page):
    """A successful Mood POST plus failed safe GET stays dirty and reports failure."""
    initial = copy.deepcopy(api("/settings"))
    initial["values"]["moods"] = [{"name": "baseline-mood", "clapPrompt": "baseline"}]
    initial["values"]["moodSchedule"] = {}
    initial["values"]["weatherMoods"] = {}
    initial.setdefault("tts", {})["moods"] = ["baseline-mood"]
    install_settings_refresh_failure(page, initial)
    page.goto(f"{WEB}/admin/moods?tab=vocab", wait_until="domcontentloaded")
    prompt = page.get_by_label("Sound description").first
    prompt.fill("operator edit survives refresh failure")
    page.get_by_role("button", name="Save vocabulary").click()
    page.get_by_text("settings were saved, but refresh failed", exact=False).wait_for(state="visible")
    assert prompt.input_value() == "operator edit survives refresh failure"
    assert not page.get_by_role("button", name="Save vocabulary").is_disabled()


@check
def personas_save_refresh_failure_preserves_edit(page):
    """A successful Persona POST plus failed safe GET keeps the editor and edit open."""
    initial = copy.deepcopy(api("/settings"))
    persona = initial["values"]["personas"][1]
    install_settings_refresh_failure(page, initial)
    page.goto(f"{WEB}/admin/personas", wait_until="domcontentloaded")
    page.get_by_role("button", name=f"Edit {persona['name']}").click()
    dialog = page.get_by_role("dialog")
    name = dialog.get_by_label("On-air name")
    name.fill("Operator Persona After Refresh Failure")
    dialog.get_by_role("button", name="Save persona").click()
    page.get_by_text("settings were saved, but refresh failed", exact=False).wait_for(state="visible")
    dialog.wait_for(state="visible")
    assert name.input_value() == "Operator Persona After Refresh Failure"


def reconnect_stale_query(page):
    settle_clock(page, 31_000)
    page.context.set_offline(True)
    page.context.set_offline(False)


@check
def settings_dirty_revision_deferred(page):
    """A server revision waits behind dirty RHF edits, then hydrates once clean."""
    page.clock.install()
    seed = copy.deepcopy(api("/settings"))

    def run_stage(path, initial, revised, open_input):
        state = {"body": initial}

        def route_settings(route):
            fulfill_json(route, state["body"])

        page.route("http://localhost:7791/settings", route_settings)
        page.goto(f"{WEB}{path}", wait_until="domcontentloaded")
        field, baseline, dirty, server = open_input(page)
        field.fill(dirty)
        state["body"] = revised
        before = request_count(page, "/settings", authenticated=True)
        reconnect_stale_query(page)
        page.wait_for_timeout(100)
        assert request_count(page, "/settings", authenticated=True) == before + 1, page.request_log
        assert field.input_value() == dirty, field.input_value()
        field.fill(baseline)
        field.wait_for(state="visible")
        page.wait_for_timeout(100)
        assert field.input_value() == server, field.input_value()
        page.unroute("http://localhost:7791/settings", route_settings)

    mood_initial = copy.deepcopy(seed)
    mood_initial["values"]["moods"] = [{"name": "baseline-mood", "clapPrompt": ""}]
    mood_initial["values"]["moodSchedule"] = {}
    mood_initial["values"]["weatherMoods"] = {}
    mood_initial.setdefault("tts", {})["moods"] = ["baseline-mood"]
    mood_revised = copy.deepcopy(mood_initial)
    mood_revised["values"]["moods"] = [{"name": "server-mood", "clapPrompt": ""}]
    mood_revised["tts"]["moods"] = ["server-mood"]
    run_stage(
        "/admin/moods?tab=vocab", mood_initial, mood_revised,
        lambda p: (p.get_by_label("Mood id").first, "baseline-mood", "operator-mood", "server-mood"),
    )

    festival_initial = copy.deepcopy(seed)
    festival_initial["values"]["festivals"] = [{
        "month": 1, "day": 1, "name": "Baseline Festival", "mood": "festival",
        "description": "", "windowDays": 0,
    }]
    festival_revised = copy.deepcopy(festival_initial)
    festival_revised["values"]["festivals"][0]["name"] = "Server Festival"

    def open_festival(p):
        p.get_by_role("button", name="Baseline Festival", exact=False).click()
        return p.get_by_role("dialog").get_by_label("Name"), "Baseline Festival", "Operator Festival", "Server Festival"

    run_stage(
        "/admin/moods?tab=festivals", festival_initial, festival_revised, open_festival,
    )

    persona_initial = copy.deepcopy(seed)
    persona = persona_initial["values"]["personas"][1]
    persona_revised = copy.deepcopy(persona_initial)
    persona_revised["values"]["personas"][1]["name"] = "Server Wren"

    def open_persona(p):
        p.get_by_role("button", name=f"Edit {persona['name']}").click()
        return p.get_by_role("dialog").get_by_label("On-air name"), persona["name"], "Operator Wren", "Server Wren"

    run_stage("/admin/personas", persona_initial, persona_revised, open_persona)


@check
def response_message_error_preserved(page):
    """Imperative settings commands retain actionable `{message}` failures."""
    settings = copy.deepcopy(SETTINGS_FIXTURE)
    settings["values"]["scrobble"] = {
        "lastfm": {
            "enabled": True, "apiKey": "set", "apiSecret": "set",
            "sessionKey": "set", "username": "verify",
        },
        "listenbrainz": {"enabled": False, "userToken": "", "username": "", "baseUrl": ""},
    }
    page.route(
        "http://localhost:7791/settings",
        lambda route: fulfill_json(route, settings),
    )
    message = "Last.fm already has an authorization waiting"
    page.route(
        "http://localhost:7791/scrobble/lastfm/connect",
        lambda route: fulfill_json(route, {"message": message}, status=409),
    )
    page.goto(f"{WEB}/admin/settings?section=scrobble", wait_until="domcontentloaded")
    page.get_by_role("button", name="Connect to Last.fm").click()
    page.get_by_text(message, exact=False).wait_for(state="visible")


@check
def imaging_mutations_refresh(page):
    """SFX/bed mutations invalidate only their resource and keep the fresh list cached."""
    sfx_name = "task4-cache-sfx"
    bed_name = "task4-cache-bed"
    api_write("DELETE", f"/sfx/{sfx_name}", ok_statuses=(200, 400, 404))
    api_write("DELETE", f"/beds/{bed_name}", ok_statuses=(200, 400, 404))
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        sfx_wav_path = handle.name
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        bed_wav_path = handle.name
    write_silent_wav(sfx_wav_path, seconds=0.3)
    write_silent_wav(bed_wav_path, seconds=31)
    try:
        page.clock.install()
        page.goto(f"{WEB}/admin/imaging?tab=sfx", wait_until="domcontentloaded")
        page.get_by_text("Sound effects", exact=True).wait_for(state="visible")
        sfx_initial = request_count(page, "/sfx", authenticated=True)
        page.get_by_role("button", name="Import", exact=True).click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_label("Name").fill(sfx_name)
        dialog.locator('input[aria-label="Import SFX audio file"]').set_input_files(sfx_wav_path)
        dialog.get_by_role("button", name="Import", exact=True).click()
        dialog.wait_for(state="detached")
        page.get_by_text(sfx_name, exact=True).wait_for(state="visible")
        assert request_count(page, "/sfx", authenticated=True) == sfx_initial + 1, page.request_log

        page.get_by_role("tab", name="Beds").click()
        page.get_by_text("when to use a bed", exact=True).wait_for(state="visible")
        beds_initial = request_count(page, "/beds", authenticated=True)
        page.get_by_role("button", name="Import", exact=True).click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_label("Name").fill(bed_name)
        dialog.locator('input[aria-label="Import bed audio file"]').set_input_files(bed_wav_path)
        dialog.get_by_role("button", name="Import", exact=True).click()
        dialog.wait_for(state="detached")
        page.get_by_text(bed_name, exact=True).wait_for(state="visible")
        assert request_count(page, "/beds", authenticated=True) == beds_initial + 1, page.request_log

        click_admin_link(page, "Settings", "/admin/settings")
        page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
        click_admin_link(page, "Imaging", "/admin/imaging")
        page.get_by_text("The sounds between the songs.", exact=True).wait_for(state="visible")

        page.get_by_role("tab", name="SFX").click()
        page.get_by_text(sfx_name, exact=True).wait_for(state="visible")
        assert request_count(page, "/sfx", authenticated=True) == sfx_initial + 1, page.request_log
        row = page.get_by_text(sfx_name, exact=True).locator("xpath=ancestor::div[contains(@class,'grid-cols-1')][1]")
        row.get_by_role("button", name="Delete effect").click()
        page.get_by_role("alertdialog").get_by_role("button", name="Delete").click()
        page.get_by_text(sfx_name, exact=True).wait_for(state="detached")

        page.get_by_role("tab", name="Beds").click()
        page.get_by_text(bed_name, exact=True).wait_for(state="visible")
        assert request_count(page, "/beds", authenticated=True) == beds_initial + 1, page.request_log
        row = page.get_by_text(bed_name, exact=True).locator("xpath=ancestor::div[contains(@class,'grid-cols-1')][1]")
        row.get_by_role("button", name="Delete bed").click()
        page.get_by_role("alertdialog").get_by_role("button", name="Delete").click()
        page.get_by_text(bed_name, exact=True).wait_for(state="detached")
    finally:
        api_write("DELETE", f"/sfx/{sfx_name}", ok_statuses=(200, 400, 404))
        api_write("DELETE", f"/beds/{bed_name}", ok_statuses=(200, 400, 404))
        os.unlink(sfx_wav_path)
        os.unlink(bed_wav_path)


@check
def personas_mutations_refresh(page):
    """Roster saves refetch the safe envelope once, then remount from cache."""
    fixture = "Task 4 Cache Persona"

    def remove_fixture():
        settings = api("/settings")
        personas = settings.get("values", {}).get("personas", [])
        remaining = [persona for persona in personas if persona.get("name") != fixture]
        if len(remaining) != len(personas):
            api_write("POST", "/settings", {"personas": remaining})

    remove_fixture()
    try:
        page.goto(f"{WEB}/admin/personas", wait_until="domcontentloaded")
        page.get_by_text("The voices on your station.", exact=True).wait_for(state="visible")
        initial_gets = request_count(page, "/settings", authenticated=True)
        page.get_by_role("button", name="+ Add persona").click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_label("On-air name").fill(fixture)
        dialog.get_by_label("Soul").fill("Temporary persona for the Task 4 shared-cache browser check.")
        dialog.get_by_role("button", name="Save persona").click()
        dialog.wait_for(state="detached")
        assert any(
            persona.get("name") == fixture
            for persona in api("/settings").get("values", {}).get("personas", [])
        )
        authoritative_gets = initial_gets + 1
        assert request_count(page, "/settings", authenticated=True) == authoritative_gets, page.request_log

        click_admin_link(page, "Imaging", "/admin/imaging")
        page.get_by_text("The sounds between the songs.", exact=True).wait_for(state="visible")
        click_admin_link(page, "Personas", "/admin/personas")
        page.get_by_role("button", name=f"Edit {fixture}").wait_for(state="visible")
        assert request_count(page, "/settings", authenticated=True) == authoritative_gets, page.request_log

        # AdminShell crossfades route children. The incoming roster is visible
        # before the exiting Imaging subtree has finished leaving; wait out
        # that 120ms transition so the card receives a real operator click.
        page.wait_for_timeout(250)
        page.get_by_role("button", name=f"Edit {fixture}").click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for(state="visible")
        dialog.get_by_label("On-air name").wait_for(state="visible")
        assert dialog.get_by_label("On-air name").input_value() == fixture
        # The full-screen editor swaps its keyed persona subtree as focus moves;
        # dispatch to the current control without waiting for animation stability.
        dialog.get_by_role("button", name="Remove").dispatch_event("click")
        confirm = page.get_by_role("alertdialog")
        confirm.wait_for(state="visible")
        confirm.get_by_role("button", name="Delete").dispatch_event("click")
        confirm.wait_for(state="detached")
        dialog.wait_for(state="detached")
        page.wait_for_timeout(100)
        assert page.get_by_role("button", name=f"Edit {fixture}").count() == 0
        page.get_by_role("button", name="Edit Marlowe").click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_role("button", name="Save persona").click()
        dialog.wait_for(state="detached")
        assert not any(
            persona.get("name") == fixture
            for persona in api("/settings").get("values", {}).get("personas", [])
        )
    finally:
        remove_fixture()


def programming_fixture():
    """A complete settings envelope with one deterministic programming show."""
    settings = copy.deepcopy(api("/settings"))
    personas = settings.get("values", {}).get("personas", [])
    assert personas, "verify settings need a seeded persona"
    show = {
        "id": "s_task5_verify",
        "name": "Task 5 Verify Show",
        "topic": "A deterministic programming fixture.",
        "personaId": personas[0]["id"],
        "guestPersonaIds": [],
        "banter": False,
        "moods": [],
        "themeId": "",
        "genres": [],
        "eras": [],
        "energies": [],
        "vocals": "",
        "filtersStrict": False,
        "maxTrackSeconds": None,
        "playlistIds": [],
        "playlistStrict": False,
        "excludedPlaylistIds": [],
        "programme": False,
        "segmentSkill": "",
    }
    week = {str(day): [None] * 24 for day in range(7)}
    settings["values"]["shows"] = [show]
    settings["values"]["schedule"] = week
    return settings, show, week


@check
def shows_cache_reuse(page):
    """Shows and Rundown reuse the shell's one fresh settings envelope."""
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
    click_admin_link(page, "Shows", "/admin/shows")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    page.get_by_role("link", name="Open the schedule →").click()
    page.wait_for_url("**/admin/shows/schedule")
    page.get_by_text("Empty hours run autonomously", exact=False).wait_for(state="visible")
    assert request_count(page, "/settings", authenticated=True) == 1, page.request_log


@check
def show_install_refresh(page):
    """An authoritative install response reaches Rundown without another GET."""
    settings, show, week = programming_fixture()
    settings["values"]["shows"] = []
    community = {
        "slug": "task-5-verify-show",
        "name": show["name"],
        "topic": show["topic"],
        "moods": [],
        "genres": [],
        "eras": [],
        "energies": [],
        "filtersStrict": False,
        "banter": False,
        "programme": False,
        "segmentSkill": "",
        "maxTrackSeconds": None,
    }

    page.route("http://localhost:7791/settings", lambda route: fulfill_json(route, settings))
    page.route(
        "http://localhost:7791/shows/community",
        lambda route: fulfill_json(route, {"community": [community]}),
    )
    page.route(
        "http://localhost:7791/shows/community/task-5-verify-show/install",
        lambda route: fulfill_json(route, {"shows": [show], "show": show}),
    )

    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/shows/community")
    ):
        click_admin_link(page, "Shows", "/admin/shows")
    community_button = page.get_by_role("button", name="Community", exact=False)
    community_button.get_by_text("1", exact=True).wait_for(state="visible")
    # AdminShell keeps the outgoing route above the incoming subtree during its
    # crossfade; wait until this click reaches the live Shows panel.
    page.wait_for_timeout(250)
    community_button.click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for(state="visible")
    dialog.get_by_text(show["name"], exact=True).wait_for(state="visible")
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/shows/community/task-5-verify-show/install", "POST",
        )
    ):
        dialog.get_by_role("button", name="Install").click()
    page.keyboard.press("Escape")
    dialog.wait_for(state="detached")
    page.get_by_role("link", name="Open the schedule →").click()
    page.wait_for_url("**/admin/shows/schedule")
    page.get_by_text(show["name"], exact=True).first.wait_for(state="visible")
    assert request_count(page, "/settings", authenticated=True) == 1, page.request_log
    assert week == settings["values"]["schedule"]


@check
def schedule_save_refresh(page):
    """Saving the week patches settings and refreshes the mounted override key."""
    settings, show, _week = programming_fixture()
    saved = {"schedule": None}

    page.route("http://localhost:7791/settings", lambda route: fulfill_json(route, settings))

    def schedule_route(route):
        if route.request.method == "PUT":
            body = route.request.post_data_json
            saved["schedule"] = body["schedule"]
            fulfill_json(route, {"schedule": body["schedule"], "dropped": 0})
        else:
            fulfill_json(route, {
                "shows": [show],
                "schedule": saved["schedule"] or settings["values"]["schedule"],
                "override": None,
            })

    page.route("http://localhost:7791/schedule", schedule_route)
    page.goto(f"{WEB}/admin/shows/schedule", wait_until="domcontentloaded")
    brush = page.locator('button[title*="Click to arm"]').first
    brush.wait_for(state="visible")
    brush.click()
    page.locator("button", has_text="+").filter(has_not_text="Add show").first.click()
    initial_live_reads = request_count(page, "/schedule", authenticated=True)
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/schedule", "PUT")
    ):
        page.get_by_role("button", name="Save the week").first.click()
    page.wait_for_timeout(200)
    assert saved["schedule"] is not None
    assert request_count(page, "/schedule", authenticated=True) == initial_live_reads + 1, page.request_log

    page.get_by_role("link", name="New show →").click()
    page.wait_for_url("**/admin/shows")
    metric = page.locator(".metric").filter(has_text="hours scheduled")
    scheduled_hours = sum(
        1 for day in saved["schedule"].values() for show_id in day if show_id
    )
    assert scheduled_hours > 0
    metric.locator(".n").get_by_text(str(scheduled_hours), exact=True).wait_for(state="visible")
    assert request_count(page, "/settings", authenticated=True) == 1, page.request_log


def stub_playlist_programming(page):
    settings, _show, _week = programming_fixture()
    playlist = {
        "id": "task5-playlist",
        "name": "Task 5 Playlist",
        "songCount": 1,
        "synced": True,
        "lastSyncedAt": None,
    }
    tracks = [
        {"id": "task5-track-1", "title": "Task 5 One", "artist": "Task Artist", "durationSec": 180},
    ]
    state = {"synced": False}

    page.route("http://localhost:7791/settings", lambda route: fulfill_json(route, settings))
    page.route(
        "http://localhost:7791/library/genres",
        lambda route: fulfill_json(route, {"genres": [{"value": "Verify", "songCount": 1}]}),
    )
    page.route(
        "http://localhost:7791/playlists",
        lambda route: fulfill_json(route, {"playlists": [playlist]}),
    )

    def detail_route(route):
        body = list(tracks)
        if state["synced"]:
            body.append({
                "id": "task5-track-2", "title": "Task 5 Two",
                "artist": "Task Artist", "durationSec": 200,
            })
        fulfill_json(route, {"entries": body})

    page.route("http://localhost:7791/playlists/task5-playlist", detail_route)

    def sync_route(route):
        state["synced"] = True
        fulfill_json(route, {"added": 1})

    page.route("http://localhost:7791/playlists/task5-playlist/sync", sync_route)
    page.route(
        "http://localhost:7791/dj/search**",
        lambda route: fulfill_json(route, {"results": tracks}),
    )
    return playlist


def repeat_debounced_search(page, label, term):
    field = page.get_by_label(label)
    field.fill(term)
    page.wait_for_timeout(350)
    field.fill("")
    page.wait_for_timeout(20)
    field.fill(term)
    page.wait_for_timeout(350)
    field.fill("")


@check
def playlist_search_dedup(page):
    """Purpose keys isolate shapes while same-purpose remounts reuse results."""
    playlist = stub_playlist_programming(page)
    page.goto(f"{WEB}/admin/playlists", wait_until="domcontentloaded")
    page.get_by_text("Nothing in the set yet.", exact=True).wait_for(state="visible")

    repeat_debounced_search(page, "Search seeds", "task")
    repeat_debounced_search(page, "Add an artist", "task")

    page.get_by_role("button", name="Browse").click()
    page.get_by_text(playlist["name"], exact=True).click()
    page.get_by_text("Task 5 One", exact=True).wait_for(state="visible")
    page.get_by_role("button", name="Open", exact=True).click()
    page.get_by_text(playlist["name"], exact=True).click()
    page.locator("[data-row]").filter(has_text="Task 5 One").wait_for(state="visible")
    repeat_debounced_search(page, "Add a track", "task")

    assert request_count(page, "/dj/search", query="q=task&limit=8", authenticated=True) == 1, page.request_log
    assert request_count(page, "/dj/search", query="q=task&limit=20", authenticated=True) == 1, page.request_log
    assert request_count(page, "/dj/search", query="q=task&limit=10", authenticated=True) == 1, page.request_log
    assert request_count(page, "/playlists/task5-playlist", authenticated=True) == 1, page.request_log


@check
def playlist_sync_refresh(page):
    """Sync refreshes only the active detail and playlist index families."""
    playlist = stub_playlist_programming(page)
    page.goto(f"{WEB}/admin/playlists", wait_until="domcontentloaded")
    page.get_by_role("button", name="Browse").click()
    page.get_by_text(playlist["name"], exact=True).click()
    page.get_by_text("Task 5 One", exact=True).wait_for(state="visible")
    initial_settings = request_count(page, "/settings", authenticated=True)
    initial_index = request_count(page, "/playlists", authenticated=True)
    initial_detail = request_count(page, "/playlists/task5-playlist", authenticated=True)

    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/playlists/task5-playlist/sync", "POST",
        )
    ):
        page.get_by_role("button", name="sync now").click()
    page.get_by_text("Task 5 Two", exact=True).wait_for(state="visible")
    assert request_count(page, "/playlists/task5-playlist", authenticated=True) == initial_detail + 1, page.request_log

    page.get_by_role("button", name="Open", exact=True).click()
    page.get_by_text(playlist["name"], exact=True).wait_for(state="visible")
    assert request_count(page, "/playlists", authenticated=True) == initial_index + 1, page.request_log
    assert request_count(page, "/settings", authenticated=True) == initial_settings, page.request_log
    page.get_by_text(playlist["name"], exact=True).click()
    page.locator("[data-row]").filter(has_text="Task 5 Two").wait_for(state="visible")
    assert request_count(page, "/playlists/task5-playlist", authenticated=True) == initial_detail + 1, page.request_log

    page.get_by_role("button", name="Open", exact=True).click()
    page.get_by_text(playlist["name"], exact=True).wait_for(state="visible")
    assert request_count(page, "/playlists", authenticated=True) == initial_index + 1, page.request_log


@check
def playlist_show_catalogue_refresh(page):
    """Playlist writes refresh the prewarmed Shows playlist catalogue once."""
    settings, show, _week = programming_fixture()
    summaries = {
        "task5-source": {
            "id": "task5-source", "name": "Task 5 Source", "songCount": 1,
            "synced": True, "lastSyncedAt": None,
        },
    }
    details = {
        "task5-source": [
            {"id": "task5-track-1", "title": "Task 5 One", "artist": "Task Artist", "durationSec": 180},
        ],
    }

    page.route("http://localhost:7791/settings", lambda route: fulfill_json(route, settings))
    page.route(
        "http://localhost:7791/dj/playlists",
        lambda route: fulfill_json(route, {"results": list(summaries.values())}),
    )
    page.route(
        "http://localhost:7791/library/genres",
        lambda route: fulfill_json(route, {"genres": []}),
    )

    def playlist_item_route(route):
        path = urllib.parse.urlparse(route.request.url).path
        parts = path.strip("/").split("/")
        playlist_id = parts[1]
        if route.request.method == "POST" and parts[-1] == "sync":
            details[playlist_id].append({
                "id": "task5-track-2", "title": "Task 5 Two",
                "artist": "Task Artist", "durationSec": 200,
            })
            summaries[playlist_id]["songCount"] = len(details[playlist_id])
            fulfill_json(route, {"added": 1})
        elif route.request.method == "DELETE":
            summaries.pop(playlist_id, None)
            details.pop(playlist_id, None)
            fulfill_json(route, {"ok": True})
        else:
            fulfill_json(route, {"entries": details[playlist_id]})

    page.route("http://localhost:7791/playlists/**", playlist_item_route)

    def playlist_index_route(route):
        if route.request.method == "POST":
            body = route.request.post_data_json
            playlist_id = body.get("playlistId") or "task5-created"
            details[playlist_id] = [
                next(
                    track for tracks in details.values() for track in tracks
                    if track["id"] == song_id
                )
                for song_id in body["songIds"]
            ]
            summaries[playlist_id] = {
                "id": playlist_id,
                "name": body["name"],
                "songCount": len(details[playlist_id]),
                "synced": bool(body.get("keepInSync")),
                "lastSyncedAt": None,
            }
            fulfill_json(route, {"playlist": {"id": playlist_id}, "added": len(details[playlist_id])})
        else:
            fulfill_json(route, {"playlists": list(summaries.values())})

    # Register the exact collection route last so it wins over the item glob.
    page.route("http://localhost:7791/playlists", playlist_index_route)

    def open_show_catalogue(expected, absent=()):
        page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
        page.wait_for_timeout(250)  # let AdminShell's incoming route own clicks
        page.get_by_role("button", name=f"Edit {show['name']}").click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for(state="visible")
        anchor = dialog.get_by_label("playlist anchor")
        for name, count in expected:
            row = anchor.locator("label").filter(has_text=name)
            row.wait_for(state="visible")
            assert f"({count})" in row.inner_text(), row.inner_text()
        for name in absent:
            assert anchor.locator("label").filter(has_text=name).count() == 0, anchor.inner_text()
        dialog.get_by_role("button", name="Close").last.click()
        dialog.wait_for(state="detached")

    def go_to_playlists():
        toggle = page.get_by_role("button", name="Toggle Library submenu")
        if toggle.get_attribute("data-state") != "open":
            toggle.click()
        click_admin_link(page, "Playlists", "/admin/playlists")
        page.get_by_text("Describe the set", exact=False).wait_for(state="visible")
        page.wait_for_timeout(250)

    def load_playlist(name):
        page.get_by_role("button", name="Browse", exact=True).click()
        page.get_by_text(name, exact=True).click()
        page.get_by_text("Task 5 One", exact=True).wait_for(state="visible")

    def return_to_shows():
        click_admin_link(page, "Shows", "/admin/shows")
        page.wait_for_url("**/admin/shows")

    # Prewarm showKeys.playlists() before any Playlist Builder write.
    page.goto(f"{WEB}/admin/shows", wait_until="domcontentloaded")
    open_show_catalogue([("Task 5 Source", 1)])
    assert request_count(page, "/dj/playlists", authenticated=True) == 1, page.request_log

    # Rename (overwrite save) must make the fresh name visible on return.
    go_to_playlists()
    load_playlist("Task 5 Source")
    page.get_by_role("button", name="Update", exact=True).click()
    save_dialog = page.get_by_role("dialog")
    save_dialog.get_by_label("Name").fill("Task 5 Renamed")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/playlists", "POST")
    ):
        save_dialog.get_by_role("button", name="Save playlist").click()
    save_dialog.wait_for(state="detached")
    return_to_shows()
    open_show_catalogue([("Task 5 Renamed", 1)], absent=("Task 5 Source",))

    # Create from the same deck; both playlists must reach Shows.
    go_to_playlists()
    load_playlist("Task 5 Renamed")
    page.get_by_role("button", name="Update", exact=True).click()
    save_dialog = page.get_by_role("dialog")
    save_dialog.get_by_role("button", name="Create a new playlist").click()
    save_dialog.get_by_label("Name").fill("Task 5 Created")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/playlists", "POST")
    ):
        save_dialog.get_by_role("button", name="Save playlist").click()
    save_dialog.wait_for(state="detached")
    return_to_shows()
    open_show_catalogue([("Task 5 Renamed", 1), ("Task 5 Created", 1)])

    # Sync changes songCount, which is part of the Shows picker summary.
    go_to_playlists()
    load_playlist("Task 5 Renamed")
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/playlists/task5-source/sync", "POST",
        )
    ):
        page.get_by_role("button", name="sync now").click()
    page.get_by_text("Task 5 Two", exact=True).wait_for(state="visible")
    return_to_shows()
    open_show_catalogue([("Task 5 Renamed", 2), ("Task 5 Created", 1)])

    # Deleting the created copy must remove it from the cached Show picker.
    go_to_playlists()
    page.get_by_role("button", name="Browse", exact=True).click()
    created_row = page.locator('[role="button"]').filter(has_text="Task 5 Created")
    created_row.get_by_title("delete playlist").click()
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/playlists/task5-created", "DELETE",
        )
    ):
        created_row.get_by_title("click again to delete from Navidrome").click()
    page.get_by_text("Task 5 Created", exact=True).wait_for(state="detached")
    page.keyboard.press("Escape")
    return_to_shows()
    open_show_catalogue([("Task 5 Renamed", 2)], absent=("Task 5 Created",))

    # One initial read plus one exact refresh per write, never a request storm.
    assert request_count(page, "/dj/playlists", authenticated=True) == 5, page.request_log


def task6_skill(name, label, enabled=False, custom=False):
    return {
        "name": name,
        "kind": name,
        "label": label,
        "description": f"{label} description",
        "enabled": enabled,
        "ready": True,
        "custom": custom,
        "cooldownMs": 900000,
        "tags": ["verify"],
    }


@check
def skills_mutations_refresh(page):
    """Skill writes update exact cached lists and settings-backed roster data."""
    skills = [task6_skill("task-6-verify", "Task 6 Verify")]
    community = [{
        "slug": "task-6-community",
        "label": "Task 6 Community",
        "brief": "A deterministic community fixture.",
        "cooldown": "15m",
        "installed": False,
        "reserved": False,
    }]
    mutation_hits = {"toggle": 0, "rescan": 0, "import": 0, "install": 0}

    def task6_routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/dj/skills" and method == "GET":
            fulfill_json(route, {"skills": skills})
        elif path == "/dj/skills/community" and method == "GET":
            fulfill_json(route, {"community": community})
        elif path == "/dj/skill-toggle" and method == "POST":
            mutation_hits["toggle"] += 1
            body = route.request.post_data_json
            for item in skills:
                if item["name"] == body["name"]:
                    item["enabled"] = body["on"]
            fulfill_json(route, {"skills": skills})
        elif path == "/dj/skills/rescan" and method == "POST":
            mutation_hits["rescan"] += 1
            if not any(item["name"] == "task-6-rescanned" for item in skills):
                skills.append(task6_skill("task-6-rescanned", "Task 6 Rescanned", custom=True))
            fulfill_json(route, {"skills": skills, "custom": 1})
        elif path == "/dj/skills/import" and method == "POST":
            mutation_hits["import"] += 1
            if not any(item["name"] == "task-6-imported" for item in skills):
                skills.append(task6_skill("task-6-imported", "Task 6 Imported", custom=True))
            fulfill_json(route, {"skills": skills, "slug": "task-6-imported", "hasTool": False})
        elif path == "/dj/skills/community/task-6-community/install" and method == "POST":
            mutation_hits["install"] += 1
            community[0]["installed"] = True
            if not any(item["name"] == "task-6-community" for item in skills):
                skills.append(task6_skill("task-6-community", "Task 6 Community", custom=True))
            fulfill_json(route, {"skills": skills})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", task6_routes)

    def leave_and_return():
        click_admin_link(page, "Connect", "/admin/connect")
        click_admin_link(page, "Skills", "/admin/skills")
        page.get_by_text("What the DJ does between tracks.", exact=True).wait_for(state="visible")

    page.goto(f"{WEB}/admin/skills", wait_until="domcontentloaded")
    page.get_by_text("Task 6 Verify", exact=True).wait_for(state="visible")
    leave_and_return()

    with page.expect_response(
        lambda response: is_admin_request(response.request, "/dj/skill-toggle", "POST")
    ):
        page.get_by_label("Enable Task 6 Verify").click()
    leave_and_return()
    page.get_by_text("1 enabled", exact=True).wait_for(state="visible")

    with page.expect_response(
        lambda response: is_admin_request(response.request, "/dj/skills/rescan", "POST")
    ):
        page.get_by_title("Rescan state/skills").click()
    page.get_by_text("Task 6 Rescanned", exact=True).wait_for(state="visible")
    leave_and_return()

    page.get_by_role("button", name="Community", exact=False).click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for(state="visible")
    with tempfile.NamedTemporaryFile(suffix=".zip") as bundle:
        bundle.write(b"PK\x05\x06" + b"\x00" * 18)
        bundle.flush()
        with page.expect_response(
            lambda response: is_admin_request(response.request, "/dj/skills/import", "POST")
        ):
            dialog.get_by_label("Import skill zip").set_input_files(bundle.name)
    page.get_by_text("Task 6 Imported", exact=True).wait_for(state="visible")
    dialog.get_by_role("button", name="Install", exact=True).click()
    page.get_by_text("installed", exact=True).wait_for(state="visible")
    page.keyboard.press("Escape")
    dialog.wait_for(state="detached")
    leave_and_return()
    page.get_by_text("Task 6 Community", exact=True).wait_for(state="visible")

    assert mutation_hits == {"toggle": 1, "rescan": 1, "import": 1, "install": 1}, mutation_hits
    assert request_count(page, "/dj/skills", authenticated=True) == 1, page.request_log
    # Initial catalog plus one exact refresh after import and install.
    assert request_count(page, "/dj/skills/community", authenticated=True) == 3, page.request_log
    # Skills reuses the settings owner rather than creating a second roster key.
    assert request_count(page, "/settings", authenticated=True) == 1, page.request_log


@check
def connect_cache_reuse(page):
    """Connect metadata survives tab changes and a client-side route round trip."""
    catalog = {
        "station": "Task 6 Station",
        "apiBase": "http://localhost:7791",
        "origin": "http://localhost:7793",
        "version": "task-6",
        "groups": [],
        "mcpTools": [],
        "mcpHttpPath": "/mcp",
        "streamMounts": [{
            "mount": "/stream.mp3", "format": "MP3", "codec": "mp3",
            "description": "Universal stream", "settingFlag": None,
            "alwaysOn": True, "enabled": True,
        }],
        "openapiPath": "/connect/openapi.json",
    }
    page.route(
        "http://localhost:7791/connect/catalog",
        lambda route: fulfill_json(route, catalog),
    )
    page.goto(f"{WEB}/admin/connect", wait_until="domcontentloaded")
    page.get_by_text("Everything wired to Task 6 Station.", exact=True).wait_for(state="visible")
    page.get_by_role("tab", name="Integrations").click()
    page.get_by_text("Stream URLs", exact=True).wait_for(state="visible")
    page.get_by_role("tab", name="MCP").click()
    page.get_by_label("MCP endpoint URL").wait_for(state="visible")
    click_admin_link(page, "Skills", "/admin/skills")
    click_admin_link(page, "Connect", "/admin/connect")
    page.get_by_text("Everything wired to Task 6 Station.", exact=True).wait_for(state="visible")
    assert request_count(page, "/connect/catalog", authenticated=True) == 1, page.request_log


def task6_doctor_report(label, fix=False):
    finding = {"label": label, "status": "warn", "detail": f"{label} detail"}
    if fix:
        finding["fix"] = {"id": "refresh-playlist", "label": "Refresh playlist"}
    return {
        "t": f"2026-08-23T12:00:0{1 if fix else 2}.000Z",
        "sections": [{"name": "Content", "findings": [finding]}],
        "counts": {"ok": 0, "warn": 1, "fail": 0, "skip": 0},
    }


@check
def doctor_report_updates(page):
    """Batch fallback, review, and a fix replace the exact last-report cache."""
    old_report = task6_doctor_report("Old cached report")
    first_report = task6_doctor_report("Batch fallback report", fix=True)
    fixed_report = task6_doctor_report("After fix report")
    old_review = {"available": True, "overall": "attention", "summary": "Old cached review", "priorities": []}
    first_review = {
        "available": True,
        "overall": "attention",
        "summary": "Batch fallback review",
        "priorities": [{
            "title": "Refresh it", "severity": "med", "why": "The fixture says so.",
            "suggestedFix": "Refresh the playlist.", "fixId": "refresh-playlist",
        }],
    }
    server_last = {"report": old_report, "review": old_review}
    batch_runs = []

    def doctor_routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/doctor/last" and method == "GET":
            fulfill_json(route, server_last)
        elif path == "/doctor/stream" and method == "GET":
            fulfill_json(route, {"error": "SSE unavailable in fallback fixture"}, status=503)
        elif path == "/doctor" and method == "GET":
            report = first_report if not batch_runs else fixed_report
            batch_runs.append(report)
            server_last.update({"report": report, "review": None})
            fulfill_json(route, report)
        elif path == "/doctor/review" and method == "POST":
            server_last["review"] = first_review
            fulfill_json(route, first_review)
        elif path == "/dj/refresh-playlist" and method == "POST":
            fulfill_json(route, {"ok": True})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", doctor_routes)
    page.goto(f"{WEB}/admin/doctor", wait_until="domcontentloaded")
    page.get_by_text("Old cached report", exact=True).wait_for(state="visible")
    page.get_by_role("button", name="Re-run Doctor").click()
    page.get_by_text("Batch fallback review", exact=True).wait_for(state="visible")

    click_admin_link(page, "Connect", "/admin/connect")
    page.get_by_role("link", name="DJ Doc", exact=True).click()
    page.wait_for_url("**/admin/doctor")
    page.get_by_text("Batch fallback report", exact=True).wait_for(state="visible")
    page.get_by_text("Batch fallback review", exact=True).wait_for(state="visible")

    page.get_by_role("button", name="Refresh playlist").first.click()
    page.get_by_text("After fix report", exact=True).wait_for(state="visible")
    click_admin_link(page, "Connect", "/admin/connect")
    page.get_by_role("link", name="DJ Doc", exact=True).click()
    page.wait_for_url("**/admin/doctor")
    page.get_by_text("After fix report", exact=True).wait_for(state="visible")
    assert page.get_by_text("Batch fallback review", exact=True).count() == 0

    assert request_count(page, "/doctor/last", authenticated=True) == 1, page.request_log
    assert request_count(page, "/doctor/stream", authenticated=True) == 2, page.request_log
    assert request_count(page, "/doctor", authenticated=True) == 2, page.request_log
    assert request_count(page, "/doctor/review", method="POST", authenticated=True) == 1, page.request_log
    assert request_count(page, "/dj/refresh-playlist", method="POST", authenticated=True) == 1, page.request_log


@check
def doctor_stream_not_retried(page):
    """A diagnosis opens one imperative SSE request and falls back once."""
    report = task6_doctor_report("Single stream fallback")
    page.route(
        "http://localhost:7791/doctor/last",
        lambda route: fulfill_json(route, {"report": None, "review": None}),
    )
    page.route(
        "http://localhost:7791/doctor/stream",
        lambda route: fulfill_json(route, {"error": "stream unavailable"}, status=503),
    )
    page.route("http://localhost:7791/doctor", lambda route: fulfill_json(route, report))
    page.route(
        "http://localhost:7791/doctor/review",
        lambda route: fulfill_json(route, {"available": False, "reason": "review disabled in fixture"}),
    )
    page.goto(f"{WEB}/admin/doctor", wait_until="domcontentloaded")
    page.get_by_role("button", name="Let's go").click()
    page.get_by_text("Single stream fallback", exact=True).wait_for(state="visible")
    page.get_by_text("review disabled in fixture", exact=True).wait_for(state="visible")
    page.wait_for_timeout(500)
    assert request_count(page, "/doctor/stream", authenticated=True) == 1, page.request_log
    assert request_count(page, "/doctor", authenticated=True) == 1, page.request_log


def main():
    names = sys.argv[1:] or list(CHECKS)
    unknown = [name for name in names if name not in CHECKS]
    if unknown:
        sys.exit(f"unknown check(s): {', '.join(unknown)} — have {', '.join(CHECKS)}")
    assert_verify_stack()
    assert_destructive_opt_in(names)
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
