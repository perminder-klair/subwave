"""Focused checks for the shared admin TanStack Query client.

Runs only against the isolated controller and web servers documented in
.claude/skills/verify/SKILL.md.  It intentionally refuses any other ports.
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


def assert_throwaway_stack():
    if API != "http://localhost:7791" or WEB != "http://localhost:7793":
        sys.exit("refusing to run: API/WEB are not the verify stack's ports")
    try:
        api("/health")
    except Exception as error:
        sys.exit(f"verify stack not reachable at {API}: {error}")


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
    context = browser.new_context(viewport={"width": 1440, "height": 900})
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


def main():
    assert_throwaway_stack()
    names = sys.argv[1:] or list(CHECKS)
    unknown = [name for name in names if name not in CHECKS]
    if unknown:
        sys.exit(f"unknown check(s): {', '.join(unknown)} — have {', '.join(CHECKS)}")
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
