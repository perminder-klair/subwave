"""Focused checks for the shared admin TanStack Query client.

Runs only against the isolated controller and web servers documented in
.claude/skills/verify/SKILL.md.  It intentionally refuses any other ports.
"""
import base64
import copy
import json
import os
import subprocess
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
    "stations_mutations_refresh",
    "webhooks_mutations_refresh",
    "archives_clear_refresh",
    "backup_index_refresh",
    "webhooks_secret_leaves_no_cache_trace",
    "backup_restore_invalidates_admin_cache",
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


def query_cache_snapshot(page):
    return page.evaluate("""() => {
      if (typeof window.__subwaveAdminQueryCacheSnapshot !== 'function') {
        throw new Error('admin query cache observable is unavailable');
      }
      return window.__subwaveAdminQueryCacheSnapshot();
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


def pause_clock_now(page):
    """Freeze at the browser's current wall clock without numeric unit ambiguity."""
    page.clock.pause_at(page.evaluate("new Date(Date.now() + 1000).toISOString()"))


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
    page.clock.install()
    model_hits = []
    page.route(
        "**/settings/llm/models**",
        lambda route: (model_hits.append(route.request.url), route.fulfill(**model_response(["fresh-model"])))[1],
    )
    box = open_settings_llm(page)
    settle_clock(page, 400)
    model_hits.clear()
    pause_clock_now(page)
    box.fill("http://model.test/v1")
    settle_clock(page, 399)
    assert not [hit for hit in model_hits if "model.test" in hit], model_hits
    settle_clock(page, 1)
    matching = [hit for hit in model_hits if "model.test" in hit]
    assert len(matching) == 1, model_hits


@check
def discovery_voice_settings_debounce(page):
    page.clock.install()
    voice_hits = []
    page.route(
        "**/settings/tts/voices**",
        lambda route: (voice_hits.append(route.request.url), route.fulfill(**voice_response([
            {"id": "debounced-voice", "label": "Debounced voice"},
        ])))[1],
    )
    box = open_settings_tts(page)
    settle_clock(page, 400)
    voice_hits.clear()
    pause_clock_now(page)
    box.fill("http://voice-debounce.test/v1")
    settle_clock(page, 399)
    assert not [hit for hit in voice_hits if "voice-debounce.test" in hit], voice_hits
    settle_clock(page, 1)
    matching = [hit for hit in voice_hits if "voice-debounce.test" in hit]
    assert len(matching) == 1, voice_hits


@check
def discovery_onboarding_provider(page):
    page.clock.install()
    model_hits = []
    page.route(
        "**/settings/llm/models**",
        lambda route: (model_hits.append(route.request.url), route.fulfill(**model_response(["wizard-model"])))[1],
    )
    box = enter_onboarding_llm(page)
    settle_clock(page, 400)
    model_hits.clear()
    pause_clock_now(page)
    box.fill("http://wizard.test/v1")
    settle_clock(page, 399)
    assert not [hit for hit in model_hits if "wizard.test" in hit], model_hits
    settle_clock(page, 1)
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
def onboarding_credential_change_isolates_discovery_cache(page):
    """A delayed A 401 cannot own B's onboarding discovery or sign B out."""
    page.set_default_timeout(5000)
    token_a = AUTH
    token_b = base64.b64encode(b"test:onboarding-b").decode()
    model_auth = []

    page.add_init_script(f"""
      (() => {{
        const nativeFetch = window.fetch.bind(window);
        const tokenA = 'Basic {token_a}';
        let delayStaleOnce = true;
        window.__onboardingDelayed = [];
        window.__releaseOnboardingDelayed = () => {{
          for (const release of window.__onboardingDelayed.splice(0)) release();
        }};
        window.fetch = async (input, init = {{}}) => {{
          const url = typeof input === 'string' ? input : input.url;
          const authorization = new Headers(init.headers).get('authorization');
          const response = await nativeFetch(input, init);
          if (url.includes('stale-401.test') && delayStaleOnce) {{
            delayStaleOnce = false;
            await new Promise(resolve => window.__onboardingDelayed.push(resolve));
          }}
          return response;
        }};
      }})();
    """)

    def models(route):
        authorization = route.request.headers.get("authorization")
        model_auth.append(authorization)
        url = route.request.url
        if authorization == f"Basic {token_a}" and "stale-401.test" in url:
            fulfill_json(route, {"error": "expired A"}, status=401)
        elif authorization == f"Basic {token_a}":
            route.fulfill(**model_response(["model-a-delayed"]))
        else:
            route.fulfill(**model_response(["model-b-current"]))

    page.route("**/settings/llm/models**", models)
    box = enter_onboarding_llm(page)
    box.fill("http://stale-401.test/v1")
    page.wait_for_timeout(450)
    page.wait_for_function("() => window.__onboardingDelayed.length === 1")

    # Deliver the same StorageEvent a second tab would produce. The wizard
    # itself must stay on the LLM step, but the credential-scoped client must
    # be replaced before B renders or starts discovery.
    page.evaluate("""({ key, oldValue, newValue }) => {
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent('storage', {
        key, oldValue, newValue, storageArea: localStorage,
      }));
    }""", {
        "key": "subwave_admin_auth", "oldValue": token_a, "newValue": token_b,
    })

    page.get_by_text("Step 2 of 5", exact=True).wait_for(state="visible")
    page.wait_for_function("""() => {
      const queries = window.__subwaveAdminQueryCacheSnapshot?.() || [];
      return queries.some(query =>
        query.queryKey?.[0] === 'discovery'
        && query.data?.models?.includes('model-b-current')
      );
    }""")

    page.evaluate("window.__releaseOnboardingDelayed()")
    page.wait_for_timeout(200)
    assert page.evaluate("localStorage.getItem('subwave_admin_auth')") == token_b
    assert page.get_by_text("Admin sign-in", exact=True).count() == 0
    cached_models = page.evaluate("""() =>
      (window.__subwaveAdminQueryCacheSnapshot?.() || [])
        .filter(query => query.queryKey?.[0] === 'discovery')
        .flatMap(query => query.data?.models || [])
    """)
    assert cached_models == ["model-b-current"], cached_models
    assert f"Basic {token_a}" in model_auth, model_auth
    assert f"Basic {token_b}" in model_auth, model_auth


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
def page_query_401_tears_down_shell_cache(page):
    """A page-owned query signs out the shell and destroys its shared cache."""
    page.set_default_timeout(5000)
    stub_dashboard(page)
    station = {
        "multiStation": False,
        "activeId": "main",
        "limit": 8,
        "stations": [{
            "id": "main", "name": "Verify Main", "configured": True,
            "createdAt": "2026-08-23T10:00:00.000Z", "active": True,
        }],
    }
    page.route("http://localhost:7791/stations", lambda route: fulfill_json(route, station))
    page.route("http://localhost:7791/settings", lambda route: fulfill_json(route, SETTINGS_FIXTURE))

    debug = {
        "queue": {"current": None, "upcoming": [], "djLog": [], "djLogCount": 0},
        "config": {}, "nowPlaying": None, "context": {}, "liquidsoapLog": "",
        "llm": {"provider": "verify", "activeModel": "verify", "recentCalls": []},
        "subsonic": {"recentCalls": [], "endpoints": []},
    }
    page.route("http://localhost:7791/debug", lambda route: fulfill_json(route, debug))
    root_hits = 0

    def state_tree_route(route):
        nonlocal root_hits
        query = urllib.parse.parse_qs(
            urllib.parse.urlparse(route.request.url).query,
            keep_blank_values=True,
        )
        path = query.get("path", [""])[0]
        if path == "":
            root_hits += 1
            if root_hits == 2:
                fulfill_json(route, {"error": "expired"}, status=401)
                return
        fulfill_json(route, {
            "root": "/verify/state",
            "path": path,
            "entries": ([] if path else [{
                "name": "cold-marker" if root_hits >= 3 else "warm-marker",
                "isDir": False,
                "isSymlink": False,
                "size": 1,
            }]),
            "shown": 0 if path else 1,
            "total": 0 if path else 1,
        })

    page.route("http://localhost:7791/debug/state-tree**", state_tree_route)
    page.goto(f"{WEB}/admin/debug", wait_until="domcontentloaded")
    page.get_by_text("warm-marker", exact=True).wait_for(state="visible")
    assert request_count(page, "/stations", authenticated=True) == 1, page.request_log
    warm_dump = json.dumps(query_cache_snapshot(page))
    assert "warm-marker" in warm_dump and "state-files" in warm_dump, warm_dump

    state_header = page.get_by_text("/verify/state", exact=True).locator("..")
    state_header.get_by_role("button", name="Refresh").click()
    page.get_by_text("Admin sign-in", exact=True).wait_for(state="visible")
    page.wait_for_timeout(500)
    assert root_hits == 2, root_hits
    assert page.evaluate("localStorage.getItem('subwave_admin_auth')") is None
    assert page.evaluate("typeof window.__subwaveAdminQueryCacheSnapshot") == "undefined"

    page.get_by_label("Username").fill("test")
    page.get_by_label("Password").fill("test")
    page.get_by_role("button", name="sign in").click()
    page.wait_for_url("**/admin/dash")
    click_admin_link(page, "Debug", "/admin/debug")
    page.get_by_text("cold-marker", exact=True).wait_for(state="visible")
    assert root_hits >= 3, root_hits
    assert request_count(page, "/stations", authenticated=True) == 2, page.request_log


@check
def credential_change_remounts_cache_and_ignores_stale_401(page):
    """Storage C beats delayed B 401 before its cross-tab event reaches the store."""
    page.set_default_timeout(5000)
    token_a = AUTH
    token_b = base64.b64encode(b"test:rotated").decode()
    token_c = base64.b64encode(b"test:cross-tab").decode()
    stub_dashboard(page)
    station_auth = []
    state_auth = []
    station = {
        "multiStation": False,
        "activeId": "main",
        "limit": 8,
        "stations": [{
            "id": "main", "name": "Verify Main", "configured": True,
            "createdAt": "2026-08-23T10:00:00.000Z", "active": True,
        }],
    }

    def stations_route(route):
        station_auth.append(route.request.headers.get("authorization"))
        fulfill_json(route, station)

    def state_tree_route(route):
        authorization = route.request.headers.get("authorization")
        state_auth.append(authorization)
        marker = (
            "cold-c" if authorization == f"Basic {token_c}"
            else "cold-b" if authorization == f"Basic {token_b}"
            else "warm-a"
        )
        fulfill_json(route, {
            "root": "/verify/state", "path": "", "shown": 1, "total": 1,
            "entries": [{
                "name": marker, "isDir": False, "isSymlink": False, "size": 1,
            }],
        })

    page.route("http://localhost:7791/stations", stations_route)
    page.route("http://localhost:7791/settings", lambda route: fulfill_json(route, SETTINGS_FIXTURE))
    page.route("http://localhost:7791/debug", lambda route: fulfill_json(route, {
        "queue": {"current": None, "upcoming": [], "djLog": [], "djLogCount": 0},
        "config": {}, "nowPlaying": None, "context": {}, "liquidsoapLog": "",
        "llm": {"provider": "verify", "activeModel": "verify", "recentCalls": []},
        "subsonic": {"recentCalls": [], "endpoints": []},
    }))
    page.route("http://localhost:7791/debug/state-tree**", state_tree_route)
    page.add_init_script("""
      (() => {
        const nativeFetch = window.fetch.bind(window);
        window.__delayNextStateTree = false;
        window.__delayedAdminCount = 0;
        window.fetch = (input, init = {}) => {
          const url = typeof input === 'string' ? input : input.url;
          if (url.includes('/debug/state-tree') && window.__delayNextStateTree) {
            window.__delayNextStateTree = false;
            window.__delayedAdminCount += 1;
            window.__delayedAdminAuthorization = new Headers(init.headers).get('authorization');
            return new Promise(resolve => {
              window.__releaseDelayedAdmin401 = () => resolve(new Response(
                JSON.stringify({ error: 'expired A' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } },
              ));
            });
          }
          return nativeFetch(input, init);
        };
      })();
    """)

    page.goto(f"{WEB}/admin/debug", wait_until="domcontentloaded")
    page.get_by_text("warm-a", exact=True).wait_for(state="visible")
    assert "warm-a" in json.dumps(query_cache_snapshot(page))

    # Cross-tab A -> B has already reached this tab, so B owns both the shell
    # provider and the request that is about to be delayed.
    page.evaluate("""({ key, oldValue, newValue }) => {
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent('storage', {
        key, oldValue, newValue, storageArea: localStorage,
      }));
    }""", {"key": "subwave_admin_auth", "oldValue": token_a, "newValue": token_b})
    page.get_by_text("cold-b", exact=True).wait_for(state="visible")
    cache_dump = json.dumps(query_cache_snapshot(page))
    assert "cold-b" in cache_dump and "warm-a" not in cache_dump, cache_dump

    page.evaluate("window.__delayNextStateTree = true")
    page.get_by_text("/verify/state", exact=True).locator("..").get_by_role(
        "button", name="Refresh",
    ).click()
    page.wait_for_function("() => typeof window.__releaseDelayedAdmin401 === 'function'")
    # Another tab has committed C to storage, but scheduling has not delivered
    # its StorageEvent yet. B's delayed rejection must consult storage itself
    # and leave C untouched even though the external-store snapshot still says B.
    page.evaluate("""({ key, newValue }) => {
      localStorage.setItem(key, newValue);
      window.__releaseDelayedAdmin401();
    }""", {"key": "subwave_admin_auth", "newValue": token_c})

    page.wait_for_timeout(200)
    assert page.evaluate("localStorage.getItem('subwave_admin_auth')") == token_c
    assert page.get_by_text("Admin sign-in", exact=True).count() == 0
    assert page.evaluate("window.__delayedAdminCount") == 1
    assert page.evaluate("window.__delayedAdminAuthorization") == f"Basic {token_b}"

    # Delivery of the queued event now advances the shared store and keys the
    # provider to C. C must start cold; no B cache may cross that boundary.
    page.evaluate("""({ key, oldValue, newValue }) => {
      window.dispatchEvent(new StorageEvent('storage', {
        key, oldValue, newValue, storageArea: localStorage,
      }));
    }""", {"key": "subwave_admin_auth", "oldValue": token_b, "newValue": token_c})
    page.get_by_text("cold-c", exact=True).wait_for(state="visible")
    assert f"Basic {token_b}" in station_auth, station_auth
    assert f"Basic {token_c}" in station_auth, station_auth
    assert f"Basic {token_b}" in state_auth, state_auth
    assert f"Basic {token_c}" in state_auth, state_auth
    cache_dump = json.dumps(query_cache_snapshot(page))
    assert "cold-c" in cache_dump and "cold-b" not in cache_dump, cache_dump


@check
def themes_cache_reuse_and_mutation_refresh(page):
    """Shows prewarms one admin themes query reused and patched by Settings."""
    page.set_default_timeout(5000)
    themes = [{
        "id": "verify-dark", "name": "Verify Dark", "description": "initial",
        "mode": "dark", "tokens": {"--bg": "#101010"}, "builtin": True,
    }]

    def theme_routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        if path == "/themes" and route.request.method == "GET":
            fulfill_json(route, {"themes": themes, "active": "verify-dark"})
        elif path == "/themes/refresh" and route.request.method == "POST":
            themes.append({
                "id": "verify-fresh", "name": "Verify Fresh", "description": "refreshed",
                "mode": "light", "tokens": {"--bg": "#fafafa"}, "builtin": False,
            })
            fulfill_json(route, {"themes": themes, "active": "verify-dark"})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", theme_routes)
    page.goto(f"{WEB}/admin/shows", wait_until="domcontentloaded")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    page.wait_for_timeout(0)
    assert request_count(page, "/themes", authenticated=True) == 1, page.request_log
    assert '"themes"' in json.dumps(query_cache_snapshot(page)), query_cache_snapshot(page)

    click_admin_link(page, "Settings", "/admin/settings")
    page.get_by_role("button", name="Skin & Themes", exact=False).click()
    page.get_by_text("Verify Dark", exact=True).wait_for(state="visible")
    assert request_count(page, "/themes", authenticated=True) == 1, page.request_log

    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
    ):
        with page.expect_response(
            lambda response: is_admin_request(response.request, "/themes/refresh", "POST")
        ) as refresh_response:
            page.wait_for_function("""() => {
              const button = [...document.querySelectorAll('button')]
                .find(item => item.textContent?.trim() === 'Refresh');
              if (!button?.isConnected) return false;
              button.click();
              return true;
            }""")
    assert "verify-fresh" in json.dumps(refresh_response.value.json()), refresh_response.value.text()
    try:
        page.wait_for_function(
            "() => JSON.stringify(window.__subwaveAdminQueryCacheSnapshot?.() || []).includes('verify-fresh')"
        )
    except Exception as error:
        raise AssertionError((query_cache_snapshot(page), page.request_log)) from error
    cache_dump = json.dumps(query_cache_snapshot(page))
    assert "verify-fresh" in cache_dump, cache_dump
    # Mutation receipts omit `active`, so refresh performs one authoritative
    # GET before publishing the exact shared entry.
    assert request_count(page, "/themes", authenticated=True) == 2, page.request_log

    click_admin_link(page, "Shows", "/admin/shows")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    route_theme_cache = next(
        query for query in query_cache_snapshot(page)
        if query["queryKey"] == ["themes", "admin"]
    )
    assert route_theme_cache["data"]["active"] == "verify-dark", route_theme_cache
    assert next(
        theme for theme in route_theme_cache["data"]["themes"]
        if theme["id"] == "verify-fresh"
    )["tokens"]["--bg"] == "#fafafa", route_theme_cache
    route_cache_dump = json.dumps(query_cache_snapshot(page))
    assert "verify-fresh" in route_cache_dump, route_cache_dump
    assert request_count(page, "/themes", authenticated=True) == 2, page.request_log


@check
def themes_active_is_authoritative_after_settings_and_delete(page):
    """Theme writes refetch active so Shows never consumes a removed/stale id."""
    page.set_default_timeout(7000)
    settings = copy.deepcopy(SETTINGS_FIXTURE)
    settings["values"].update({
        "theme": {"active": "verify-dark"},
        "ui": {"skin": "classic"},
        "personas": [{
            "id": "verify-persona", "name": "Verify Persona", "tagline": "",
            "frequency": "moderate", "scriptLength": "concise", "soul": "verify",
            "tts": {"engine": "piper", "voice": "verify"},
        }],
        "shows": [{
            "id": "verify-show", "name": "Verify Show", "topic": "verify",
            "personaId": "verify-persona", "guestPersonaIds": [], "banter": False,
            "moods": [], "themeId": "", "genres": [], "eras": [], "energies": [],
            "vocals": "", "filtersStrict": False, "maxTrackSeconds": 0,
            "programme": False, "segmentSkill": "",
        }],
        "schedule": {}, "minTrackSeconds": 30,
    })
    settings["tts"]["moods"] = ["calm"]
    themes = [
        {
            "id": "verify-dark", "name": "Verify Dark", "description": "initial",
            "mode": "dark", "tokens": {"--bg": "#101010"}, "builtin": True,
        },
        {
            "id": "verify-fresh", "name": "Verify Fresh", "description": "custom",
            "mode": "light", "tokens": {"--bg": "#fafafa"}, "builtin": False,
        },
    ]
    active = "verify-dark"
    admin_theme_gets = 0
    stub_dashboard(page)

    def settings_route(route):
        nonlocal active
        if route.request.method == "POST":
            body = route.request.post_data_json
            next_active = body.get("theme", {}).get("active")
            if next_active:
                active = next_active
                settings["values"]["theme"]["active"] = next_active
            fulfill_json(route, {"ok": True})
            return
        fulfill_json(route, settings)

    def themes_route(route):
        nonlocal active, admin_theme_gets, themes
        path = urllib.parse.urlparse(route.request.url).path
        if route.request.method == "GET" and path == "/themes":
            if route.request.headers.get("authorization"):
                admin_theme_gets += 1
            fulfill_json(route, {"themes": themes, "active": active})
            return
        if route.request.method == "DELETE" and path == "/themes/verify-fresh":
            themes = [theme for theme in themes if theme["id"] != "verify-fresh"]
            if active == "verify-fresh":
                active = "verify-dark"
            # Real mutation receipts intentionally omit active.
            fulfill_json(route, {"ok": True, "themes": themes})
            return
        route.continue_()

    page.route("http://localhost:7791/settings", settings_route)
    page.route("http://localhost:7791/themes**", themes_route)
    page.goto(f"{WEB}/admin/shows", wait_until="domcontentloaded")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    assert admin_theme_gets == 1, admin_theme_gets

    click_admin_link(page, "Settings", "/admin/settings")
    page.get_by_role("button", name="Skin & Themes", exact=False).click()
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
    ):
        with page.expect_request(
            lambda request: is_admin_request(request, "/settings", "POST")
            and request.post_data_json.get("theme", {}).get("active") == "verify-fresh"
        ):
            page.wait_for_function("""() => {
              const button = [...document.querySelectorAll('button')]
                .find(item => item.textContent?.includes('Verify Fresh'));
              if (!button?.isConnected) return false;
              button.click();
              return true;
            }""")
    try:
        page.wait_for_function("""() => {
          const theme = window.__subwaveAdminQueryCacheSnapshot?.()
            .find(query => JSON.stringify(query.queryKey) === '["themes","admin"]');
          return theme?.data?.active === 'verify-fresh';
        }""")
    except Exception as error:
        raise AssertionError((admin_theme_gets, query_cache_snapshot(page), page.request_log)) from error
    assert admin_theme_gets == 2, admin_theme_gets

    click_admin_link(page, "Shows", "/admin/shows")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    route_theme_cache = next(
        query for query in query_cache_snapshot(page)
        if query["queryKey"] == ["themes", "admin"]
    )
    assert route_theme_cache["data"]["active"] == "verify-fresh", route_theme_cache
    assert next(
        theme for theme in route_theme_cache["data"]["themes"]
        if theme["id"] == "verify-fresh"
    )["tokens"]["--bg"] == "#fafafa", route_theme_cache
    page.get_by_role("button", name="Edit Verify Show", exact=True).press("Enter")
    page.get_by_role("button", name="Station default", exact=True).wait_for(state="visible")
    try:
        page.wait_for_function("""() => {
          const button = [...document.querySelectorAll('button')]
            .find(item => item.textContent?.trim() === 'Station default');
          return button && [...button.querySelectorAll('[aria-hidden=true]')]
            .some(element => getComputedStyle(element).backgroundColor === 'rgb(250, 250, 250)');
        }""")
    except Exception as error:
        default_cards = page.locator('button[title="follows the station palette"]').all()
        raise AssertionError([card.evaluate("button => button.outerHTML") for card in default_cards]) from error
    page.keyboard.press("Escape")

    click_admin_link(page, "Settings", "/admin/settings")
    page.get_by_role("button", name="Skin & Themes", exact=False).click()
    page.wait_for_function("""() => {
      const button = document.querySelector('button[title="Remove this custom theme"]');
      if (!button?.isConnected) return false;
      button.click();
      return true;
    }""")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
    ):
        with page.expect_request(
            lambda request: is_admin_request(request, "/themes/verify-fresh", "DELETE")
        ):
            page.wait_for_function("""() => {
              const dialog = document.querySelector('[role=alertdialog]');
              const button = dialog && [...dialog.querySelectorAll('button')]
                .find(item => item.textContent?.trim() === 'remove');
              if (!button?.isConnected) return false;
              button.click();
              return true;
            }""")
    page.wait_for_function("""() => {
      const theme = window.__subwaveAdminQueryCacheSnapshot?.()
        .find(query => JSON.stringify(query.queryKey) === '["themes","admin"]');
      return theme?.data?.active === 'verify-dark'
        && !theme?.data?.themes?.some(item => item.id === 'verify-fresh');
    }""")
    # Initial load + active-theme save + delete refresh. The authoritative
    # delete GET already reports the fallback, so no redundant fourth read.
    assert admin_theme_gets == 3, admin_theme_gets
    theme_cache = next(
        query for query in query_cache_snapshot(page)
        if query["queryKey"] == ["themes", "admin"]
    )
    assert theme_cache["data"]["active"] == "verify-dark", theme_cache
    assert all(theme["id"] != "verify-fresh" for theme in theme_cache["data"]["themes"])


@check
def theme_choose_failures_reconcile_provider(page):
    """Failed theme saves roll back; failed post-save reads reconcile safely."""
    page.set_default_timeout(5000)
    settings = copy.deepcopy(SETTINGS_FIXTURE)
    settings["values"].update({
        "theme": {"active": "verify-dark"},
        "ui": {"skin": "classic"},
    })
    themes = [
        {
            "id": "verify-dark", "name": "Verify Dark", "description": "saved",
            "mode": "dark", "tokens": {"--bg": "#101010"}, "builtin": True,
        },
        {
            "id": "verify-fresh", "name": "Verify Fresh", "description": "candidate",
            "mode": "light", "tokens": {"--bg": "#fafafa"}, "builtin": True,
        },
    ]
    active = "verify-dark"
    post_mode = {"value": "fail"}
    fail_next_admin_themes = {"value": False}
    public_theme_gets = 0
    admin_theme_gets = 0
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    stub_dashboard(page)

    def settings_route(route):
        nonlocal active
        if route.request.method == "POST":
            if post_mode["value"] == "fail":
                fulfill_json(route, {"error": "theme save rejected"}, status=500)
                return
            active = "verify-fresh"
            settings["values"]["theme"]["active"] = active
            # The public provider response deliberately differs from the
            # optimistic swatch so the assertion proves a real reconcile.
            themes[1]["tokens"]["--bg"] = "#eeeeee"
            fulfill_json(route, {"ok": True})
            return
        fulfill_json(route, settings)

    def themes_route(route):
        nonlocal public_theme_gets, admin_theme_gets
        if route.request.method != "GET":
            route.continue_()
            return
        if route.request.headers.get("authorization"):
            admin_theme_gets += 1
            if fail_next_admin_themes["value"]:
                fail_next_admin_themes["value"] = False
                fulfill_json(route, {"error": "authoritative themes unavailable"}, status=503)
                return
        else:
            public_theme_gets += 1
        fulfill_json(route, {
            "themes": themes,
            "active": active,
            "activeSource": "station",
            "stationDefault": active,
            "activeShow": None,
        })

    page.route("http://localhost:7791/settings", settings_route)
    page.route("http://localhost:7791/themes**", themes_route)
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_role("button", name="Skin & Themes", exact=False).click()
    page.get_by_text("Verify Fresh", exact=True).wait_for(state="visible")
    page.wait_for_function(
        "() => document.documentElement.style.getPropertyValue('--bg') === '#101010'"
    )
    initial_public_gets = public_theme_gets
    initial_admin_gets = admin_theme_gets

    # POST failure: the optimistic light palette and pre-paint cache must both
    # return to the still-authoritative dark provider response.
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/settings", "POST")
    ) as failed_post:
        page.get_by_text("Verify Fresh", exact=True).locator("..").locator("..").click()
    assert failed_post.value.status == 500, failed_post.value.status
    page.wait_for_function(
        "() => document.documentElement.style.getPropertyValue('--bg') === '#101010'"
    )
    cached = page.evaluate(
        "() => JSON.parse(localStorage.getItem('subwave-theme-tokens') || 'null')"
    )
    assert cached["id"] == "verify-dark" and cached["tokens"]["--bg"] == "#101010", cached
    assert public_theme_gets == initial_public_gets + 1, public_theme_gets
    assert admin_theme_gets == initial_admin_gets, admin_theme_gets
    assert not page_errors, page_errors

    # The POST now succeeds, but its exact authenticated themes read fails.
    # The provider's public read must reconcile the real saved palette, the
    # rejected promise must be caught, and no old active id may remain dressed
    # up as authoritative in the shared admin cache.
    post_mode["value"] = "succeed"
    fail_next_admin_themes["value"] = True
    public_before_reconcile = public_theme_gets
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
        and response.status == 503
    ):
        with page.expect_response(
            lambda response: is_admin_request(response.request, "/settings", "POST")
        ) as saved_post:
            page.get_by_text("Verify Fresh", exact=True).locator("..").locator("..").click()
    assert saved_post.value.status == 200, saved_post.value.status
    page.wait_for_function(
        "() => document.documentElement.style.getPropertyValue('--bg') === '#eeeeee'"
    )
    page.get_by_text("authoritative themes unavailable", exact=False).wait_for(state="visible")
    cached = page.evaluate(
        "() => JSON.parse(localStorage.getItem('subwave-theme-tokens') || 'null')"
    )
    assert cached["id"] == "verify-fresh" and cached["tokens"]["--bg"] == "#eeeeee", cached
    assert public_theme_gets == public_before_reconcile + 1, public_theme_gets
    theme_entries = [
        query for query in query_cache_snapshot(page)
        if query["queryKey"] == ["themes", "admin"]
    ]
    assert all(query.get("data", {}).get("active") != "verify-dark" for query in theme_entries), theme_entries
    assert page.get_by_text("Admin sign-in", exact=True).count() == 0
    assert not page_errors, page_errors


@check
def theme_mutation_refresh_failures_reconcile_provider(page):
    """Committed theme writes survive failed authoritative reads honestly."""
    page.set_default_timeout(7000)
    settings = copy.deepcopy(SETTINGS_FIXTURE)
    settings["values"].update({
        "theme": {"active": "verify-custom"},
        "ui": {"skin": "classic"},
    })
    themes = [
        {
            "id": "verify-dark", "name": "Verify Dark", "description": "fallback",
            "mode": "dark", "tokens": {"--bg": "#101010"}, "builtin": True,
        },
        {
            "id": "verify-custom", "name": "Verify Custom", "description": "active",
            "mode": "dark", "tokens": {"--bg": "#202020"}, "builtin": False,
        },
    ]
    active = "verify-custom"
    active_source = "show"
    active_show = {
        "id": "verify-show", "name": "Verify Show", "themeId": "verify-custom",
    }
    fail_next_admin_get = False
    failed_admin_gets = 0
    public_gets = 0
    settings_posts = []
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    stub_dashboard(page)

    def settings_route(route):
        nonlocal active, active_source, active_show
        if route.request.method == "POST":
            body = route.request.post_data_json
            settings_posts.append(body)
            fallback_id = body.get("theme", {}).get("active")
            if fallback_id:
                settings["values"]["theme"]["active"] = fallback_id
                active = fallback_id
                active_source = "station"
                active_show = None
        fulfill_json(route, settings)

    def themes_route(route):
        nonlocal themes, active, active_source, active_show
        nonlocal fail_next_admin_get, failed_admin_gets, public_gets
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if method == "GET" and path == "/themes":
            if route.request.headers.get("authorization"):
                if fail_next_admin_get:
                    fail_next_admin_get = False
                    failed_admin_gets += 1
                    fulfill_json(route, {"error": "authoritative themes unavailable"}, status=503)
                    return
            else:
                public_gets += 1
            fulfill_json(route, {
                "themes": themes, "active": active, "activeSource": active_source,
                "stationDefault": "verify-dark", "activeShow": active_show,
            })
            return
        if method == "POST" and path == "/themes":
            body = route.request.post_data_json
            existing_id = body.get("id")
            if existing_id:
                themes = [
                    {**theme, "name": body["name"]} if theme["id"] == existing_id else theme
                    for theme in themes
                ]
            else:
                themes.append({
                    "id": "verify-created", "name": body["name"], "description": "",
                    "mode": body["mode"], "tokens": body["tokens"], "builtin": False,
                })
            fail_next_admin_get = True
            fulfill_json(route, {"ok": True, "themes": themes})
            return
        if method == "POST" and path == "/themes/refresh":
            themes = [
                {**theme, "tokens": {"--bg": "#303030"}}
                if theme["id"] == "verify-custom" else theme
                for theme in themes
            ]
            fail_next_admin_get = True
            fulfill_json(route, {"ok": True, "themes": themes})
            return
        if method == "DELETE" and path == "/themes/verify-custom":
            themes = [theme for theme in themes if theme["id"] != "verify-custom"]
            fail_next_admin_get = True
            fulfill_json(route, {"ok": True, "themes": themes})
            return
        route.continue_()

    page.route("http://localhost:7791/settings", settings_route)
    page.route("http://localhost:7791/themes**", themes_route)

    def open_themes(expected_name="Verify Custom"):
        page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
        page.get_by_role("button", name="Skin & Themes", exact=False).click()
        page.get_by_text(expected_name, exact=True).wait_for(state="visible")

    def assert_no_stale_admin_theme(predicate):
        entries = [
            query for query in query_cache_snapshot(page)
            if query["queryKey"] == ["themes", "admin"]
        ]
        assert all(not predicate(query.get("data", {})) for query in entries), entries

    open_themes()
    public_before = public_gets
    page.get_by_role("button", name="Create theme", exact=True).click()
    dialog = page.get_by_role("dialog")
    dialog.locator("input").first.fill("Verify Created")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
        and response.status == 503
    ):
        dialog.get_by_role("button", name="Save theme", exact=True).click()
    page.get_by_text("saved", exact=False).filter(has_text="refresh failed").wait_for(state="visible")
    page.get_by_role("dialog").wait_for(state="detached")
    assert_no_stale_admin_theme(
        lambda data: not any(theme["id"] == "verify-created" for theme in data.get("themes", []))
    )
    assert public_gets == public_before + 1, public_gets

    open_themes()
    public_before = public_gets
    page.locator('button[title="Edit this custom theme"]').first.click()
    dialog = page.get_by_role("dialog")
    dialog.locator("input").first.fill("Verify Edited")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
        and response.status == 503
    ):
        dialog.get_by_role("button", name="Save changes", exact=True).click()
    page.get_by_text("updated", exact=False).filter(has_text="refresh failed").wait_for(state="visible")
    page.get_by_role("dialog").wait_for(state="detached")
    assert_no_stale_admin_theme(
        lambda data: any(theme.get("name") == "Verify Custom" for theme in data.get("themes", []))
    )
    assert public_gets == public_before + 1, public_gets

    open_themes("Verify Edited")
    public_before = public_gets
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
        and response.status == 503
    ):
        page.get_by_role("button", name="Refresh", exact=True).click()
    page.get_by_text("reloaded", exact=False).filter(has_text="refresh failed").wait_for(state="visible")
    page.wait_for_function(
        "() => document.documentElement.style.getPropertyValue('--bg') === '#303030'"
    )
    assert_no_stale_admin_theme(
        lambda data: next(
            (theme.get("tokens", {}).get("--bg") for theme in data.get("themes", [])
             if theme["id"] == "verify-custom"),
            None,
        ) == "#202020"
    )
    assert public_gets == public_before + 1, public_gets

    open_themes("Verify Edited")
    public_before = public_gets
    page.locator('button[title="Remove this custom theme"]').first.click()
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
        and response.status == 503
    ):
        page.get_by_role("alertdialog").get_by_role(
            "button", name="remove", exact=True,
        ).click()
    page.get_by_text("removed", exact=False).filter(has_text="refresh failed").wait_for(state="visible")
    page.wait_for_function(
        "() => document.documentElement.style.getPropertyValue('--bg') === '#101010'"
    )
    assert_no_stale_admin_theme(
        lambda data: data.get("active") == "verify-custom"
        or any(theme["id"] == "verify-custom" for theme in data.get("themes", []))
    )
    assert settings_posts[-1] == {"theme": {"active": "verify-dark"}}, settings_posts
    assert settings["values"]["theme"]["active"] == "verify-dark", settings
    assert active == "verify-dark", active
    assert public_gets == public_before + 1, public_gets
    assert failed_admin_gets == 4, failed_admin_gets
    assert not page_errors, page_errors


@check
def theme_show_pin_delete_preserves_station_default_on_refresh_failure(page):
    """Deleting only a show pin cannot replace a still-valid station default."""
    page.set_default_timeout(7000)
    settings = copy.deepcopy(SETTINGS_FIXTURE)
    settings["values"].update({
        "theme": {"active": "verify-b"},
        "ui": {"skin": "classic"},
    })
    themes = [
        {
            "id": "verify-a", "name": "Verify A", "description": "first registry theme",
            "mode": "dark", "tokens": {"--bg": "#111111"}, "builtin": True,
        },
        {
            "id": "verify-b", "name": "Verify B", "description": "station default",
            "mode": "dark", "tokens": {"--bg": "#222222"}, "builtin": True,
        },
        {
            "id": "verify-c", "name": "Verify C", "description": "show pin",
            "mode": "dark", "tokens": {"--bg": "#333333"}, "builtin": False,
        },
    ]
    active = "verify-c"
    station_default = "verify-b"
    active_source = "show"
    active_show = {
        "id": "verify-show", "name": "Verify Show", "themeId": "verify-c",
    }
    fail_next_admin_get = False
    failed_admin_gets = 0
    public_gets = 0
    settings_posts = []
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    stub_dashboard(page)

    def settings_route(route):
        nonlocal active, station_default, active_source, active_show
        if route.request.method == "POST":
            body = route.request.post_data_json
            settings_posts.append(body)
            next_default = body.get("theme", {}).get("active")
            if next_default:
                settings["values"]["theme"]["active"] = next_default
                station_default = next_default
                active = next_default
                active_source = "station"
                active_show = None
        fulfill_json(route, settings)

    def themes_route(route):
        nonlocal themes, active, active_source, active_show
        nonlocal fail_next_admin_get, failed_admin_gets, public_gets
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if method == "GET" and path == "/themes":
            if route.request.headers.get("authorization"):
                if fail_next_admin_get:
                    fail_next_admin_get = False
                    failed_admin_gets += 1
                    fulfill_json(route, {"error": "authoritative themes unavailable"}, status=503)
                    return
            else:
                public_gets += 1
            fulfill_json(route, {
                "themes": themes, "active": active, "activeSource": active_source,
                "stationDefault": station_default, "activeShow": active_show,
            })
            return
        if method == "DELETE" and path == "/themes/verify-c":
            themes = [theme for theme in themes if theme["id"] != "verify-c"]
            active = station_default
            active_source = "station"
            active_show = None
            fail_next_admin_get = True
            fulfill_json(route, {"ok": True, "themes": themes})
            return
        route.continue_()

    page.route("http://localhost:7791/settings", settings_route)
    page.route("http://localhost:7791/themes**", themes_route)
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_role("button", name="Skin & Themes", exact=False).click()
    page.get_by_text("Verify C", exact=True).wait_for(state="visible")
    page.wait_for_function(
        "() => document.documentElement.style.getPropertyValue('--bg') === '#333333'"
    )

    public_before = public_gets
    page.locator('button[title="Remove this custom theme"]').click()
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/themes", "GET")
        and response.status == 503
    ):
        page.get_by_role("alertdialog").get_by_role(
            "button", name="remove", exact=True,
        ).click()
    page.get_by_text("removed", exact=False).filter(has_text="refresh failed").wait_for(
        state="visible"
    )
    page.wait_for_function(
        "() => document.documentElement.style.getPropertyValue('--bg') === '#222222'"
    )

    assert not settings_posts or all(
        post == {"theme": {"active": "verify-b"}} for post in settings_posts
    ), settings_posts
    assert settings["values"]["theme"]["active"] == "verify-b", settings
    assert station_default == "verify-b", station_default
    assert active == "verify-b", active
    theme_cache = next(
        query for query in query_cache_snapshot(page)
        if query["queryKey"] == ["themes", "admin"]
    )
    assert theme_cache["data"]["active"] == "verify-b", theme_cache
    assert [theme["id"] for theme in theme_cache["data"]["themes"]] == [
        "verify-a", "verify-b",
    ], theme_cache
    assert public_gets == public_before + 1, public_gets
    assert failed_admin_gets == 1, failed_admin_gets
    assert not page_errors, page_errors


@check
def audit_rejects_direct_cacheable_reads(_page):
    """The static ownership gate resists aliases, members, and false allowlists."""
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    valid_allowlist = {
        "AdminShell.tsx": """export async function run() {
  // admin-query-imperative: first-run-redirect
  return fetch('/api/onboarding/status');
}\n""",
        "ArchivesPanel.tsx": """export async function run(adminFetch) {
  // admin-query-imperative: archive-download
  return adminResponse(adminFetch, `/archives/file/${'x'}`);
}\n""",
        "BackupPanel.tsx": """export async function run(adminFetch) {
  // admin-query-imperative: backup-export
  return adminResponse(adminFetch, '/backup/export');
}\n""",
        "DoctorPanel.tsx": """export async function run(adminFetch) {
  // admin-query-imperative: diagnosis-command
  await adminResponse(adminFetch, '/doctor');
  // admin-query-imperative: diagnosis-stream
  return adminResponse(adminFetch, '/doctor/stream', { headers: { Accept: 'text/event-stream' } });
}\n""",
        "connect/ConnectPanel.tsx": """export async function run(adminFetch, catalog) {
  // admin-query-imperative: openapi-download
  return adminResponse(adminFetch, catalog.openapiPath);
}\n""",
        "connect/Playground.tsx": """export async function run(adminFetch, relPath, endpoint) {
  // admin-query-imperative: operator-api-command
  return adminResponse(adminFetch, relPath, { method: endpoint.method });
}\n""",
        "personas/helpers.ts": """export async function run(style, seed, size) {
  // admin-query-imperative: random-avatar-download
  return fetch(`https://api.dicebear.com/9.x/${style}/png?seed=${seed}&size=${size}`);
}\n""",
        "playlist-builder/generate.ts": """export async function run(fetcher, id) {
  const init = { method: 'POST' };
  // admin-query-imperative: generation-job-start
  await fetcher('/playlists/generate/jobs', init);
  // admin-query-imperative: generation-sync-fallback
  await fetcher('/playlists/generate', init);
  // admin-query-imperative: generation-job-poll
  return fetcher(`/playlists/generate/jobs/${id}`);
}\n""",
        "settings/LibrarySection.tsx": """export async function run(adminFetch, url) {
  // admin-query-imperative: locca-discovery-probe
  return adminResponse(adminFetch, `/settings/llm/discover?baseUrl=${url}`);
}\n""",
        "settings/shared.tsx": """export async function run(adminFetch, path) {
  // admin-query-imperative: protected-audio-preview
  return adminResponse(adminFetch, path);
}\n""",
        "skills/SkillEditModal.tsx": """export async function run(adminFetch, id) {
  // admin-query-imperative: skill-export
  return adminResponse(adminFetch, `/dj/skills/${id}/export`);
}\n""",
    }

    def audit_fixture(extra=None, override=None, ownership_registry=None):
        with tempfile.TemporaryDirectory(prefix="subwave-admin-audit-") as root:
            files = {**valid_allowlist, **(extra or {}), **(override or {})}
            for relative, contents in files.items():
                target = os.path.join(root, relative)
                parent = os.path.dirname(target)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                with open(target, "w", encoding="utf-8") as source:
                    source.write(contents)
            registry_path = os.path.join(root, "ownership.json")
            with open(registry_path, "w", encoding="utf-8") as registry_file:
                json.dump(ownership_registry or [], registry_file)
            result = subprocess.run(
                [
                    "node", "web/scripts/audit-admin-query.mjs", "--root", root,
                    "--ownership-registry", registry_path,
                ],
                cwd=repo, text=True, capture_output=True, check=False,
            )
        return result.returncode, result.stdout + result.stderr

    invalid = {
        "RenamedRead.tsx": """import { adminJson as readJson } from './admin-query';
export async function bad(fetcher) { return readJson(fetcher, '/themes'); }\n""",
        "AliasedRead.tsx": """const first = adminResponse; const second = first;
export async function bad(fetcher) { return second(fetcher, '/settings'); }\n""",
        "MemberFetch.tsx": """export async function bad() {
  await window.fetch('/api/themes'); return globalThis.fetch('/api/settings');
}\n""",
        "queries.ts": """export async function stray(fetcher) {
  return adminJson(fetcher, '/themes');
}\n""",
    }
    for relative, contents in invalid.items():
        code, output = audit_fixture(extra={relative: contents})
        assert code != 0, (relative, output)
        assert relative in output, (relative, output)

    wrong_allowlist = [
        """export async function run() {
  // admin-query-imperative: first-run-redirect
  return fetch('/api/settings');
}\n""",
        """export async function run() {
  // admin-query-imperative: first-run-redirect
  return fetch('/api/onboarding/status', { method: 'POST' });
}\n""",
        """export async function run(adminFetch) {
  // admin-query-imperative: first-run-redirect
  return adminResponse(adminFetch, '/onboarding/status');
}\n""",
    ]
    for contents in wrong_allowlist:
        code, output = audit_fixture(override={"AdminShell.tsx": contents})
        assert code != 0, output
        assert "AdminShell.tsx" in output, output

    fraudulent_marker = """export async function stray(fetcher, signal) {
  // admin-query-owned: GET /themes
  return adminJson(fetcher, '/themes', undefined, signal);
}\n"""
    code, output = audit_fixture(extra={"FraudulentMarker.tsx": fraudulent_marker})
    assert code != 0, output
    assert "FraudulentMarker.tsx" in output, output

    owned_helper = """import { adminJson as readJson } from './admin-query';
export function fetchThemes(fetcher, signal) {
  return readJson(fetcher, '/themes', undefined, signal);
}\n"""
    valid_owned = """import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: (fetcher, signal) => fetchThemes(fetcher, signal),
  });
}\n"""
    ownership = [{
        "file": "OwnedHelper.ts",
        "function": "fetchThemes",
        "reads": [{
            "callee": "adminJson", "method": "GET", "path": "/themes", "signal": "signal",
        }],
        "consumers": [{
            "file": "Owned.tsx", "owner": "useAdminQuery", "property": "request", "count": 1,
        }],
    }]
    code, output = audit_fixture(
        extra={"OwnedHelper.ts": owned_helper, "Owned.tsx": valid_owned},
        ownership_registry=ownership,
    )
    assert code == 0, output

    valid_direct = """import { fetchThemes as loadThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({ key: ['themes'], adminFetch, request: loadThemes });
}\n"""
    code, output = audit_fixture(
        extra={"OwnedHelper.ts": owned_helper, "Owned.tsx": valid_direct},
        ownership_registry=ownership,
    )
    assert code == 0, output

    invalid_consumers = [
        """import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: (fetcher, signal) => { void fetchThemes; return Promise.resolve({}); },
  });
}\n""",
        """import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({ key: ['themes'], adminFetch, request: fetchThemes });
}
export function runNow(adminFetch, signal) { return fetchThemes(adminFetch, signal); }
""",
        """import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: (fetcher, signal) => fetchThemes(fetcher, new AbortController().signal),
  });
}\n""",
        """import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: (fetcher, signal) => fetchThemes(signal, fetcher),
  });
}\n""",
        """import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch) {
  const otherRequest = () => Promise.resolve({});
  return useAdminQuery({
    key: ['themes'], adminFetch,
    request: otherRequest,
    meta: { request: (fetcher, signal) => fetchThemes(fetcher, signal) },
  });
}\n""",
    ]
    for consumer_source in invalid_consumers:
        code, output = audit_fixture(
            extra={"OwnedHelper.ts": owned_helper, "Owned.tsx": consumer_source},
            ownership_registry=ownership,
        )
        assert code != 0, output
        assert "fetchThemes" in output, output

    use_queries_ownership = [{
        **ownership[0],
        "consumers": [{
            "file": "Owned.tsx", "owner": "useQueries",
            "property": "queryFn", "count": 1,
        }],
    }]
    valid_use_queries = """import { fetchThemes } from './OwnedHelper';
export function useThemes(adminFetch, ids) {
  return useQueries({
    queries: ids.map(id => ({
      queryKey: ['themes', id],
      queryFn: ({ signal }) => fetchThemes(adminFetch, signal),
    })),
  });
}\n"""
    code, output = audit_fixture(
        extra={"OwnedHelper.ts": owned_helper, "Owned.tsx": valid_use_queries},
        ownership_registry=use_queries_ownership,
    )
    assert code == 0, output

    wrong_registries = [
        [{**ownership[0], "function": "fetchOtherThemes"}],
        [{**ownership[0], "consumers": [{
            "file": "WrongConsumer.tsx", "owner": "useAdminQuery",
            "property": "request", "count": 1,
        }]}],
        ownership,
        ownership,
    ]
    wrong_sources = [
        owned_helper,
        owned_helper,
        owned_helper.replace("undefined, signal", "undefined, undefined"),
        owned_helper.replace(
            "fetchThemes(fetcher, signal) {",
            "fetchThemes(fetcher) { const signal = new AbortController().signal;",
        ),
    ]
    for registry, helper_source in zip(wrong_registries, wrong_sources):
        code, output = audit_fixture(
            extra={"OwnedHelper.ts": helper_source, "Owned.tsx": valid_owned},
            ownership_registry=registry,
        )
        assert code != 0, output
        assert "OwnedHelper.ts" in output or "WrongConsumer.tsx" in output, output

    code, output = audit_fixture()
    assert code == 0, output


@check
def stations_mutations_refresh(page):
    """Station writes refresh one shared rack and remount from that cache."""
    state = {
        "multiStation": True,
        "activeId": "main",
        "limit": 8,
        "stations": [{
            "id": "main", "name": "Verify Main", "configured": True,
            "createdAt": "2026-08-23T10:00:00.000Z", "active": True,
        }],
    }
    next_id = {"value": 1}

    def stations_route(route):
        method = route.request.method
        path = urllib.parse.urlparse(route.request.url).path
        if method == "GET" and path == "/stations":
            fulfill_json(route, state)
            return
        if method == "POST" and path == "/stations":
            body = route.request.post_data_json
            station_id = f"verify-{next_id['value']}"
            next_id["value"] += 1
            state["stations"].append({
                "id": station_id, "name": body["name"], "configured": False,
                "createdAt": "2026-08-23T10:01:00.000Z", "active": False,
            })
            fulfill_json(route, {
                "ok": True, "id": station_id, "converted": False, "switching": False,
            }, status=201)
            return
        if method == "PATCH" and path.startswith("/stations/"):
            station_id = path.rsplit("/", 1)[-1]
            body = route.request.post_data_json
            for station in state["stations"]:
                if station["id"] == station_id:
                    station["name"] = body["name"]
            fulfill_json(route, {"ok": True, "requiresRestart": False})
            return
        if method == "DELETE" and path.startswith("/stations/"):
            station_id = path.rsplit("/", 1)[-1]
            state["stations"] = [s for s in state["stations"] if s["id"] != station_id]
            fulfill_json(route, {"ok": True})
            return
        route.continue_()

    page.route("http://localhost:7791/stations**", stations_route)
    page.goto(f"{WEB}/admin/stations", wait_until="domcontentloaded")
    page.get_by_text("Verify Main", exact=True).first.wait_for(state="visible")
    initial_gets = request_count(page, "/stations", authenticated=True)
    assert initial_gets >= 1, page.request_log

    page.get_by_role("button", name="New station").click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Station name").fill("Verify Standby")
    dialog.get_by_role("button", name="Create station").click()
    page.get_by_text("Verify Standby", exact=True).first.wait_for(state="visible")
    assert request_count(page, "/stations", authenticated=True) == initial_gets + 1, page.request_log

    page.get_by_role("button", name="Rename").last.click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Station name").fill("Verify Renamed")
    dialog.get_by_role("button", name="Save", exact=True).click()
    page.get_by_text("Verify Renamed", exact=True).first.wait_for(state="visible")
    assert request_count(page, "/stations", authenticated=True) == initial_gets + 2, page.request_log

    page.get_by_role("button", name="Delete").click()
    page.get_by_role("alertdialog").get_by_role("button", name="Delete forever").click()
    page.get_by_text("Verify Renamed", exact=True).first.wait_for(state="detached")
    assert request_count(page, "/stations", authenticated=True) == initial_gets + 3, page.request_log

    page.get_by_role("link", name="Settings", exact=True).click()
    page.wait_for_url("**/admin/settings**")
    page.go_back(wait_until="domcontentloaded")
    page.get_by_text("Verify Main", exact=True).first.wait_for(state="visible")
    assert request_count(page, "/stations", authenticated=True) == initial_gets + 3, page.request_log


@check
def webhooks_mutations_refresh(page):
    """Webhook saves own the cached envelope, including removal and remount."""
    state = {
        "events": ["track.play", "request.received"],
        "webhooks": [],
        "trackPlayListenerGated": False,
    }

    def webhooks_route(route):
        if route.request.method == "GET":
            fulfill_json(route, state)
            return
        if route.request.method == "POST":
            body = route.request.post_data_json
            if "webhooks" in body:
                state["webhooks"] = body["webhooks"]
            if "trackPlayListenerGated" in body:
                state["trackPlayListenerGated"] = body["trackPlayListenerGated"]
            fulfill_json(route, {
                "webhooks": state["webhooks"],
                "trackPlayListenerGated": state["trackPlayListenerGated"],
                "requiresRestart": False,
            })

    page.route("http://localhost:7791/webhooks", webhooks_route)
    page.goto(f"{WEB}/admin/connect?tab=webhooks", wait_until="domcontentloaded")
    page.get_by_text("No webhooks yet", exact=True).first.wait_for(state="visible")
    initial_gets = request_count(page, "/webhooks", authenticated=True)
    assert initial_gets >= 1, page.request_log

    page.get_by_role("button", name="Add webhook").evaluate("button => button.click()")
    page.get_by_label("Webhook URL").fill("https://verify.invalid/subwave")
    page.get_by_role("button", name="Save", exact=True).click()
    page.get_by_text("https://verify.invalid/subwave", exact=True).wait_for(state="visible")
    assert request_count(page, "/webhooks", authenticated=True) == initial_gets, page.request_log

    page.get_by_role("button", name="Remove").click()
    page.get_by_role("button", name="Save", exact=True).click()
    page.get_by_text("No webhooks yet", exact=True).first.wait_for(state="visible")
    assert request_count(page, "/webhooks", authenticated=True) == initial_gets, page.request_log

    page.locator('a[href="/admin/dash"]').first.click()
    page.wait_for_url("**/admin/dash**")
    page.go_back(wait_until="domcontentloaded")
    page.get_by_text("No webhooks yet", exact=True).first.wait_for(state="visible")
    remount_gets = request_count(page, "/webhooks", authenticated=True) - initial_gets
    assert 1 <= remount_gets <= 2, page.request_log


@check
def webhooks_secret_leaves_no_cache_trace(page):
    """A saved authorization secret survives only in the outbound request."""
    secret = "task7-webhook-secret-9f23a"
    state = {
        "events": ["track.play", "request.received"],
        "webhooks": [],
        "trackPlayListenerGated": False,
    }

    def webhooks_route(route):
        if route.request.method == "GET":
            fulfill_json(route, state)
            return
        body = route.request.post_data_json
        assert body["webhooks"][0]["authHeader"] == secret, body
        saved = [{**hook, "authHeader": "set"} for hook in body["webhooks"]]
        state["webhooks"] = saved
        fulfill_json(route, {
            "webhooks": saved,
            "trackPlayListenerGated": False,
            "requiresRestart": False,
        })

    page.route("http://localhost:7791/webhooks", webhooks_route)
    page.goto(f"{WEB}/admin/connect?tab=webhooks", wait_until="domcontentloaded")
    page.get_by_text("No webhooks yet", exact=True).first.wait_for(state="visible")
    page.get_by_role("button", name="Add webhook").evaluate("button => button.click()")
    page.get_by_label("Webhook URL").fill("https://verify.invalid/secret-hook")
    page.get_by_label("Authorization header").fill(secret)
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/webhooks", "POST")
    ):
        page.get_by_role("button", name="Save", exact=True).click()
    page.get_by_text("https://verify.invalid/secret-hook", exact=True).wait_for(state="visible")

    mutations = mutation_cache_snapshot(page)
    assert mutations, mutations
    mutation_dump = json.dumps(mutations)
    assert secret not in mutation_dump, mutation_dump
    assert all(mutation.get("variables") is None for mutation in mutations), mutations
    assert all(mutation.get("data") is None for mutation in mutations), mutations

    query_dump = json.dumps(query_cache_snapshot(page))
    assert secret not in query_dump, query_dump
    dom_dump = page.locator("input").evaluate_all(
        "els => els.map(el => ({value: el.value, placeholder: el.placeholder}))"
    )
    assert secret not in json.dumps(dom_dump), dom_dump

    page.locator('a[href="/admin/dash"]').first.click()
    page.wait_for_url("**/admin/dash**")
    page.go_back(wait_until="domcontentloaded")
    page.get_by_text("https://verify.invalid/secret-hook", exact=True).wait_for(state="visible")
    assert page.get_by_label("Authorization header").input_value() == ""
    assert secret not in json.dumps(query_cache_snapshot(page))
    assert secret not in json.dumps(mutation_cache_snapshot(page))
    dom_dump = page.locator("input").evaluate_all(
        "els => els.map(el => ({value: el.value, placeholder: el.placeholder}))"
    )
    assert secret not in json.dumps(dom_dump), dom_dump

@check
def archives_clear_refresh(page):
    """Archive clear invalidates once and the empty index survives remount."""
    state = {"archives": [{
        "path": "2026-08-23/12-00.mp3", "date": "2026-08-23", "hour": 12,
        "bytes": 4096, "mtime": "2026-08-23T12:59:00.000Z",
    }]}

    def archives_route(route):
        if route.request.method == "GET":
            fulfill_json(route, state)
            return
        if route.request.method == "DELETE":
            state["archives"] = []
            fulfill_json(route, {"ok": True, "deleted": 1})

    page.route("http://localhost:7791/archives", archives_route)
    page.goto(f"{WEB}/admin/archives", wait_until="domcontentloaded")
    page.get_by_text("12:00", exact=True).wait_for(state="visible")
    initial_gets = request_count(page, "/archives", authenticated=True)
    assert initial_gets >= 1, page.request_log

    page.get_by_role("button", name="Clear archive").click()
    page.get_by_role("alertdialog").get_by_role("button", name="clear archive").click()
    page.get_by_text("No recordings yet", exact=True).wait_for(state="visible")
    assert request_count(page, "/archives", authenticated=True) == initial_gets + 1, page.request_log

    page.locator('a[href="/admin/dash"]').first.click()
    page.wait_for_url("**/admin/dash**")
    page.go_back(wait_until="domcontentloaded")
    page.get_by_text("No recordings yet", exact=True).wait_for(state="visible")
    assert request_count(page, "/archives", authenticated=True) == initial_gets + 1, page.request_log


@check
def backup_index_refresh(page):
    """A refreshed disk candidate remains cached after it is selected."""
    refreshed = {"value": False}
    candidate = {
        "name": "verify-backup.zip", "size": 8192,
        "mtime": "2026-08-23T13:00:00.000Z",
    }

    def backups_route(route):
        fulfill_json(route, {
            "stateDir": "/tmp/subwave-task7/state",
            "files": [candidate] if refreshed["value"] else [],
        })

    page.route("http://localhost:7791/backup/restorable", backups_route)
    page.goto(f"{WEB}/admin/settings?section=backup", wait_until="domcontentloaded")
    page.get_by_text("No .zip backups found", exact=False).wait_for(state="visible")
    initial_gets = request_count(page, "/backup/restorable", authenticated=True)
    assert initial_gets >= 1, page.request_log

    refreshed["value"] = True
    page.get_by_role("button", name="Refresh", exact=True).evaluate("button => button.click()")
    page.get_by_text(candidate["name"], exact=True).wait_for(state="visible")
    assert request_count(page, "/backup/restorable", authenticated=True) == initial_gets + 1, page.request_log

    page.get_by_role("button", name="Restore", exact=True).click()
    page.get_by_role("alertdialog").get_by_text(candidate["name"], exact=False).wait_for(state="visible")
    page.get_by_role("alertdialog").get_by_role("button", name="Cancel").click()

    page.locator('a[href="/admin/dash"]').first.click()
    page.wait_for_url("**/admin/dash**")
    page.go_back(wait_until="domcontentloaded")
    page.get_by_text(candidate["name"], exact=True).wait_for(state="visible")
    assert request_count(page, "/backup/restorable", authenticated=True) == initial_gets + 1, page.request_log


@check
def backup_restore_invalidates_admin_cache(page):
    """A completed restore refreshes active queries and stales inactive ones."""
    initial_settings = copy.deepcopy(api("/settings"))
    restored_settings = copy.deepcopy(initial_settings)
    initial_settings["values"]["stationDescription"] = "Before restore cache"
    restored_settings["values"]["stationDescription"] = "After restore cache"
    state = {"restored": False}
    candidate = {
        "name": "verify-restored-state.zip", "size": 16384,
        "mtime": "2026-08-23T14:00:00.000Z",
    }

    def settings_route(route):
        fulfill_json(route, restored_settings if state["restored"] else initial_settings)

    def archives_route(route):
        hour = 10 if state["restored"] else 9
        fulfill_json(route, {"archives": [{
            "path": f"2026-08-23/{hour:02d}-00.mp3",
            "date": "2026-08-23", "hour": hour, "bytes": 4096,
            "mtime": "2026-08-23T14:00:00.000Z",
        }]})

    def restore_route(route):
        assert route.request.post_data_json == {"file": candidate["name"]}
        state["restored"] = True
        fulfill_json(route, {
            "ok": True, "restored": ["settings", "library"],
            "requiresRestart": False,
        })

    page.route("http://localhost:7791/settings", settings_route)
    page.route("http://localhost:7791/archives", archives_route)
    page.route("http://localhost:7791/backup/restorable", lambda route: fulfill_json(route, {
        "stateDir": "/tmp/subwave-task7-review/state", "files": [candidate],
    }))
    page.route("http://localhost:7791/backup/import-file", restore_route)

    page.goto(f"{WEB}/admin/archives", wait_until="domcontentloaded")
    page.get_by_text("09:00", exact=True).wait_for(state="visible")
    initial_archive_gets = request_count(page, "/archives", authenticated=True)
    initial_settings_gets = request_count(page, "/settings", authenticated=True)
    assert initial_archive_gets >= 1 and initial_settings_gets >= 1, page.request_log

    # Clear the legacy redirect's `section=archives` before changing the local
    # Settings section. Otherwise the 3s settings-query rerender can replay the
    # still-present search param and switch back to Archives while Backup is
    # loading, which made this full-suite fixture timing-dependent.
    page.locator('a[href="/admin/settings"]').first.click()
    page.wait_for_function(
        "() => location.pathname === '/admin/settings' && location.search === ''"
    )
    page.locator("aside button").filter(has_text="Backup").click()
    try:
        page.get_by_text(candidate["name"], exact=True).wait_for(state="visible")
    except Exception as error:
        raise AssertionError({
            "url": page.url,
            "backup_gets": request_count(page, "/backup/restorable", authenticated=True),
            "requests": page.request_log,
            "body": page.locator("body").inner_text()[:4000],
        }) from error
    page.get_by_role("button", name="Restore", exact=True).click()
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/backup/import-file", "POST")
    ):
        page.get_by_role("alertdialog").get_by_role("button", name="restore").click()
    page.get_by_text("settings, library", exact=False).wait_for(state="visible")
    page.wait_for_timeout(300)

    assert request_count(page, "/settings", authenticated=True) == initial_settings_gets + 1, page.request_log
    assert request_count(page, "/archives", authenticated=True) == initial_archive_gets, page.request_log

    page.locator("aside button").filter(has_text="Station").click()
    description = page.get_by_placeholder("A short line describing your station…")
    assert description.input_value() == "After restore cache", description.input_value()

    page.locator("aside button").filter(has_text="Archives").click()
    page.get_by_text("10:00", exact=True).wait_for(state="visible")
    assert request_count(page, "/archives", authenticated=True) == initial_archive_gets + 1, page.request_log

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
def dashboard_cancel_failure_refreshes_latest_status(page):
    """A rejected optimistic cancel cannot restore the old full dashboard envelope."""
    install_poll_clock(page)
    now_playing_reads = 0
    cancel_attempted = False
    state = {
        "upcoming": [{
            "subsonic_id": "verify-queue-track",
            "title": "Verify queue track",
            "artist": "SUB/WAVE",
        }],
        "history": [],
    }

    def routes(route):
        nonlocal now_playing_reads, cancel_attempted
        path = urllib.parse.urlparse(route.request.url).path
        if path == "/now-playing":
            now_playing_reads += 1
            title = "Latest poll survives" if cancel_attempted else "Before failed cancel"
            fulfill_json(route, {"nowPlaying": {"title": title, "artist": "SUB/WAVE"}})
        elif path == "/state":
            fulfill_json(route, state)
        elif path == "/session":
            fulfill_json(route, {"messages": []})
        elif path == "/dj/queue/verify-queue-track" and route.request.method == "DELETE":
            cancel_attempted = True
            fulfill_json(route, {"error": "track already went to air"}, status=409)
        elif path == "/listeners/connections":
            fulfill_json(route, {"count": 0, "connections": []})
        elif path == "/stats":
            fulfill_json(route, {"llm": {"count": 0}, "tts": {"count": 0}})
        elif path == "/requests":
            fulfill_json(route, {"requests": []})
        elif path == "/schedule":
            fulfill_json(route, {"shows": [], "override": None})
        elif path == "/doctor/navidrome":
            fulfill_json(route, {"ok": True})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", routes)
    page.goto(f"{WEB}/admin/dash", wait_until="domcontentloaded")
    page.get_by_text("Before failed cancel", exact=False).wait_for(state="visible")
    reads_before_cancel = now_playing_reads
    page.get_by_role("button", name="Remove Verify queue track from queue").click()
    page.get_by_text("Latest poll survives", exact=False).wait_for(timeout=5000)
    assert now_playing_reads == reads_before_cancel + 1, (reads_before_cancel, now_playing_reads, page.request_log)


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
    fail_polls = False

    def schedule_route(route):
        nonlocal schedule_hits, fail_polls
        schedule_hits += 1
        if not fail_polls:
            fulfill_json(route, {
                "shows": [{"id": "review-show", "name": "Review takeover show"}],
                "override": {
                    "showId": "review-show",
                    "startedAt": now,
                    "expiresAt": now + 60_000,
                },
            })
        else:
            fulfill_json(route, {"error": "verification failure"}, status=503)
    page.route("http://localhost:7791/schedule", schedule_route)

    with page.expect_request(lambda request: is_admin_request(request, "/schedule")):
        page.goto(f"{WEB}/admin/dash", wait_until="domcontentloaded")
    page.get_by_role("button", name="Cancel takeover").wait_for(state="visible")
    initial_hits = schedule_hits
    assert 1 <= initial_hits <= 2, schedule_hits
    pause_clock_now(page)
    fail_polls = True

    with page.expect_response(
        lambda response: urllib.parse.urlparse(response.url).path == "/schedule"
        and response.status == 503
    ):
        settle_clock(page, 30_000)
    settle_clock(page)
    page.get_by_role("button", name="Cancel takeover").wait_for(state="visible")

    with page.expect_response(
        lambda response: urllib.parse.urlparse(response.url).path == "/schedule"
        and response.status == 503
    ):
        settle_clock(page, 30_000)
    settle_clock(page)

    page.get_by_role("button", name="Pin to air →").wait_for(state="visible")
    assert schedule_hits == initial_hits + 2, schedule_hits


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
    """A committed Mood POST stays successful when its safe follow-up GET fails."""
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
    page.get_by_text("saved, but refresh failed", exact=False).wait_for(state="visible")
    assert prompt.input_value() == "operator edit survives refresh failure"
    assert page.get_by_role("button", name="Save vocabulary").is_disabled()


@check
def personas_save_refresh_failure_preserves_edit(page):
    """A committed Persona POST closes cleanly when its safe follow-up GET fails."""
    initial = copy.deepcopy(api("/settings"))
    persona = initial["values"]["personas"][1]
    install_settings_refresh_failure(page, initial)
    page.goto(f"{WEB}/admin/personas", wait_until="domcontentloaded")
    page.get_by_role("button", name=f"Edit {persona['name']}").click()
    dialog = page.get_by_role("dialog")
    name = dialog.get_by_label("On-air name")
    name.fill("Operator Persona After Refresh Failure")
    dialog.get_by_role("button", name="Save persona").click()
    page.get_by_text("saved, but refresh failed", exact=False).wait_for(state="visible")
    dialog.wait_for(state="detached")
    page.get_by_role(
        "button", name="Edit Operator Persona After Refresh Failure"
    ).wait_for(state="visible")


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
    """Shows reuses settings while Rundown takes one fresh whole-week baseline."""
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
    click_admin_link(page, "Shows", "/admin/shows")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    page.get_by_role("link", name="Open the schedule →").click()
    page.wait_for_url("**/admin/shows/schedule")
    page.get_by_text("Empty hours run autonomously", exact=False).wait_for(state="visible")
    assert 2 <= request_count(page, "/settings", authenticated=True) <= 3, page.request_log


@check
def schedule_mount_hydrates_authoritative_settings(page):
    """Rundown waits for a fresh settings read before hydrating its whole-week editor."""
    stale, show, _week = programming_fixture()
    stale_show = {**show, "name": "Stale cached show"}
    fresh_show = {**show, "name": "Fresh authoritative show"}
    stale["values"]["shows"] = [stale_show]
    fresh = copy.deepcopy(stale)
    fresh["values"]["shows"] = [fresh_show]
    current = {"body": stale}

    page.route(
        "http://localhost:7791/settings",
        lambda route: fulfill_json(route, current["body"]),
    )
    page.route(
        "http://localhost:7791/schedule",
        lambda route: fulfill_json(route, {"shows": [fresh_show], "override": None}),
    )
    page.goto(f"{WEB}/admin/settings", wait_until="domcontentloaded")
    page.get_by_placeholder("A short line describing your station…").wait_for(state="visible")
    initial_gets = request_count(page, "/settings", authenticated=True)
    current["body"] = fresh

    click_admin_link(page, "Shows", "/admin/shows")
    page.get_by_role("link", name="Open the schedule →").click()
    page.wait_for_url("**/admin/shows/schedule")
    page.get_by_text("Fresh authoritative show", exact=True).first.wait_for(timeout=5000)
    mount_gets = request_count(page, "/settings", authenticated=True) - initial_gets
    assert 1 <= mount_gets <= 2, page.request_log


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
def shows_dashboard_takeover_roster_reconciliation(page):
    """Show save/create/install/delete patches Dashboard's prewarmed roster."""
    settings, original, _week = programming_fixture()
    shows = [copy.deepcopy(original)]
    installed = {**copy.deepcopy(original), "id": "s_task5_installed", "name": "Task 5 Installed"}
    stub_dashboard(page)

    def settings_route(route):
        body = copy.deepcopy(settings)
        body["values"]["shows"] = copy.deepcopy(shows)
        fulfill_json(route, body)

    page.route("http://localhost:7791/settings", settings_route)
    page.route(
        "http://localhost:7791/schedule",
        lambda route: fulfill_json(route, {"shows": shows, "override": None}),
    )
    page.route(
        "http://localhost:7791/shows/community",
        lambda route: fulfill_json(route, {"community": [{
            "slug": "task-5-installed", "name": installed["name"],
            "topic": installed["topic"], "moods": [], "genres": [], "eras": [],
            "energies": [], "filtersStrict": False, "banter": False,
            "programme": False, "segmentSkill": "", "maxTrackSeconds": None,
        }]}),
    )

    def save_route(route):
        saved = route.request.post_data_json["show"]
        at = next((i for i, show in enumerate(shows) if show["id"] == saved["id"]), None)
        if at is None:
            shows.append(saved)
        else:
            shows[at] = saved
        fulfill_json(route, {"shows": shows, "show": saved})

    page.route("http://localhost:7791/shows", save_route)

    def install_route(route):
        if not any(show["id"] == installed["id"] for show in shows):
            shows.append(copy.deepcopy(installed))
        fulfill_json(route, {"shows": shows, "show": installed})

    page.route(
        "http://localhost:7791/shows/community/task-5-installed/install", install_route,
    )

    def delete_route(route):
        show_id = urllib.parse.urlparse(route.request.url).path.rsplit("/", 1)[-1]
        shows[:] = [show for show in shows if show["id"] != show_id]
        fulfill_json(route, {"shows": shows, "schedule": settings["values"]["schedule"]})

    page.route("http://localhost:7791/shows/s_*", delete_route)

    def cached_names():
        hits = [
            query["data"] for query in query_cache_snapshot(page)
            if query["queryKey"] == ["dash", "takeover"]
        ]
        assert len(hits) == 1, hits
        return [show["name"] for show in hits[0]["shows"]]

    page.goto(f"{WEB}/admin/dash", wait_until="domcontentloaded")
    page.get_by_label("Pin a show").wait_for(state="visible")
    assert cached_names() == [original["name"]], cached_names()
    initial_schedule_reads = request_count(page, "/schedule", authenticated=True)

    click_admin_link(page, "Shows", "/admin/shows")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    page.wait_for_timeout(250)
    page.get_by_role("button", name=f"Edit {original['name']}").click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("show name").fill("Task 5 Renamed Show")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/shows", "POST")
    ):
        dialog.get_by_role("button", name="Save show").click()
    dialog.wait_for(state="detached")
    assert cached_names() == ["Task 5 Renamed Show"], cached_names()

    page.get_by_role("button", name="+ Add show").click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("show name").fill("Task 5 Created Show")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/shows", "POST")
    ):
        dialog.get_by_role("button", name="Save show").click()
    dialog.wait_for(state="detached")
    assert cached_names() == ["Task 5 Renamed Show", "Task 5 Created Show"], cached_names()

    page.get_by_role("button", name="Community", exact=False).click()
    community_dialog = page.get_by_role("dialog")
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/shows/community/task-5-installed/install", "POST",
        )
    ):
        community_dialog.get_by_role("button", name="Install").click()
    page.keyboard.press("Escape")
    community_dialog.wait_for(state="detached")
    assert cached_names() == [
        "Task 5 Renamed Show", "Task 5 Created Show", "Task 5 Installed",
    ], cached_names()

    page.get_by_role("button", name="Edit Task 5 Created Show").click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_role("button", name="Remove").click()
    confirm = page.get_by_role("alertdialog")
    with page.expect_response(
        lambda response: response.request.method == "DELETE"
        and urllib.parse.urlparse(response.url).path.startswith("/shows/"),
    ):
        confirm.get_by_role("button", name="Delete").click()
    confirm.wait_for(state="detached")
    assert cached_names() == ["Task 5 Renamed Show", "Task 5 Installed"], cached_names()
    # Mutations patch the dormant dashboard key without polling it in the background.
    assert request_count(page, "/schedule", authenticated=True) == initial_schedule_reads, page.request_log


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


@check
def schedule_dashboard_override_reconciliation(page):
    """Dashboard pin/cancel reaches the prewarmed Rundown cache immediately."""
    settings, show, _week = programming_fixture()
    current = {"override": None}
    stub_dashboard(page)
    page.route("http://localhost:7791/settings", lambda route: fulfill_json(route, settings))

    def schedule_route(route):
        if route.request.method == "POST":
            now = 1_900_000_000_000
            current["override"] = {
                "showId": route.request.post_data_json["showId"],
                "startedAt": now,
                "expiresAt": now + 3_600_000,
            }
            fulfill_json(route, {"override": current["override"]})
        elif route.request.method == "DELETE":
            current["override"] = None
            fulfill_json(route, {"ok": True})
        else:
            fulfill_json(route, {
                "shows": [show],
                "schedule": settings["values"]["schedule"],
                "override": current["override"],
            })

    # Exact route registered after stub_dashboard so the stateful fixture wins.
    page.route("http://localhost:7791/schedule", schedule_route)
    page.route("http://localhost:7791/schedule/override", schedule_route)
    page.goto(f"{WEB}/admin/shows/schedule", wait_until="domcontentloaded")
    page.get_by_text("Empty hours run autonomously", exact=False).wait_for(state="visible")
    initial_reads = request_count(page, "/schedule", authenticated=True)

    click_admin_link(page, "Dash", "/admin/dash")
    page.wait_for_timeout(250)  # incoming route must own the click after the shell crossfade
    page.get_by_label("Pin a show").click()
    page.locator("[role=menuitem], [role=option]").first.click()
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/schedule/override", "POST")
    ):
        page.get_by_role("button", name="Pin to air →").click()
    page.get_by_role("button", name="Cancel takeover").wait_for(state="visible")
    reads_after_pin = request_count(page, "/schedule", authenticated=True)

    click_admin_link(page, "Schedule", "/admin/shows/schedule")
    page.get_by_text("On air · takeover", exact=True).wait_for(state="visible")
    # Dashboard owns a live query and may perform its exact post-write refresh;
    # returning within the stale window must add no request or wait for a poll.
    assert request_count(page, "/schedule", authenticated=True) == reads_after_pin, page.request_log

    click_admin_link(page, "Dash", "/admin/dash")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/schedule/override", "DELETE")
    ):
        page.get_by_role("button", name="Cancel takeover").click()
    page.get_by_label("Pin a show").wait_for(state="visible")
    reads_after_cancel = request_count(page, "/schedule", authenticated=True)
    click_admin_link(page, "Schedule", "/admin/shows/schedule")
    page.get_by_text("On air", exact=True).wait_for(state="visible")
    assert page.get_by_text("On air · takeover", exact=True).count() == 0
    assert request_count(page, "/schedule", authenticated=True) == reads_after_cancel, page.request_log
    assert reads_after_pin - initial_reads <= 3, page.request_log
    assert reads_after_cancel - reads_after_pin <= 2, page.request_log


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
    page.route(
        "http://localhost:7791/library/browse**",
        lambda route: fulfill_json(route, {
            "rows": [{
                "id": "task5-track-3", "title": "Task 5 Three",
                "artist": "Task Artist", "duration": 180,
            }],
            "total": 1, "stats": {"byMood": {}, "byEnergy": {}}, "moodVocab": [],
        }),
    )

    def playlist_item_route(route):
        path = urllib.parse.urlparse(route.request.url).path
        parts = path.strip("/").split("/")
        playlist_id = parts[1]
        if route.request.method == "POST" and parts[-1] == "tracks":
            for song_id in route.request.post_data_json["songIds"]:
                if not any(track["id"] == song_id for track in details[playlist_id]):
                    details[playlist_id].append({
                        "id": song_id, "title": "Task 5 Three",
                        "artist": "Task Artist", "durationSec": 210,
                    })
            summaries[playlist_id]["songCount"] = len(details[playlist_id])
            fulfill_json(route, {"added": 1})
        elif route.request.method == "POST" and parts[-1] == "sync":
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

    def cached_catalogue(key):
        hits = [
            query["data"] for query in query_cache_snapshot(page)
            if query["queryKey"] == key
        ]
        assert len(hits) == 1, (key, hits)
        return [(item["name"], item["songCount"]) for item in hits[0]]

    def visit_library_catalogues(expected):
        click_admin_link(page, "Library", "/admin/library")
        page.wait_for_timeout(250)
        page.locator(".lib-tab", has_text="Browse").click()
        page.get_by_text("Task 5 Three", exact=True).wait_for(state="visible")
        page.get_by_label("select Task 5 Three").click()
        page.get_by_label("Target playlist").wait_for(state="visible")
        assert cached_catalogue(["library", "playlists"]) == expected
        page.locator(".lib-tab", has_text="Blocked").click()
        page.get_by_text("Blocking rules", exact=True).wait_for(state="visible")
        assert cached_catalogue(["library", "rule-playlists"]) == expected

    # Prewarm both `/playlists` and `/dj/playlists` consumers before a write.
    page.goto(f"{WEB}/admin/library?tab=browse", wait_until="domcontentloaded")
    page.get_by_text("Task 5 Three", exact=True).wait_for(state="visible")
    page.get_by_label("select Task 5 Three").click()
    page.get_by_label("Target playlist").wait_for(state="visible")
    page.locator(".lib-tab", has_text="Blocked").click()
    page.get_by_text("Blocking rules", exact=True).wait_for(state="visible")
    return_to_shows()
    open_show_catalogue([("Task 5 Source", 1)])
    assert request_count(page, "/dj/playlists", authenticated=True) == 2, page.request_log

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
    visit_library_catalogues([("Task 5 Renamed", 1)])

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

    # Library append invalidates the Builder detail and both `/dj/playlists`
    # catalogues; returning to Builder reads the added track immediately.
    visit_library_catalogues([("Task 5 Renamed", 2)])
    page.locator(".lib-tab", has_text="Browse").click()
    page.get_by_text("Task 5 Three", exact=True).wait_for(state="visible")
    page.get_by_label("select Task 5 Three").click()
    page.get_by_label("Target playlist").click()
    page.get_by_role("option").filter(has_text="Task 5 Renamed").click()
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/playlists/task5-source/tracks", "POST",
        )
    ):
        page.get_by_role("button", name="Add to playlist", exact=True).click()
    page.get_by_text("added 1 track", exact=False).wait_for(state="visible")
    go_to_playlists()
    load_playlist("Task 5 Renamed")
    page.get_by_text("Task 5 Three", exact=True).wait_for(state="visible")

    # Library create must surface in Builder, Shows and Block Rules too.
    click_admin_link(page, "Library", "/admin/library")
    page.locator(".lib-tab", has_text="Browse").click()
    page.get_by_text("Task 5 Three", exact=True).wait_for(state="visible")
    page.get_by_label("select Task 5 Three").click()
    page.get_by_label("New playlist name").fill("Task 5 Library Created")
    with page.expect_response(
        lambda response: is_admin_request(response.request, "/playlists", "POST")
    ):
        page.get_by_role("button", name="Create playlist", exact=True).click()
    go_to_playlists()
    page.get_by_role("button", name="Browse", exact=True).click()
    page.get_by_text("Task 5 Library Created", exact=True).wait_for(state="visible")
    page.keyboard.press("Escape")
    return_to_shows()
    open_show_catalogue([("Task 5 Renamed", 3), ("Task 5 Library Created", 1)])
    visit_library_catalogues([("Task 5 Renamed", 3), ("Task 5 Library Created", 1)])

    # Each mounted envelope reads at most once per write/return; no broad-key storm.
    assert request_count(page, "/dj/playlists", authenticated=True) == 10, page.request_log
    assert request_count(page, "/playlists", authenticated=True) == 11, page.request_log


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
    """Skill writes patch both Skills and the prewarmed Shows enabled subset."""
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
                skills.append(task6_skill(
                    "task-6-rescanned", "Task 6 Rescanned", enabled=True, custom=True,
                ))
            fulfill_json(route, {"skills": skills, "custom": 1})
        elif path == "/dj/skills/import" and method == "POST":
            mutation_hits["import"] += 1
            if not any(item["name"] == "task-6-imported" for item in skills):
                skills.append(task6_skill(
                    "task-6-imported", "Task 6 Imported", enabled=True, custom=True,
                ))
            fulfill_json(route, {"skills": skills, "slug": "task-6-imported", "hasTool": False})
        elif path == "/dj/skills/community/task-6-community/install" and method == "POST":
            mutation_hits["install"] += 1
            community[0]["installed"] = True
            if not any(item["name"] == "task-6-community" for item in skills):
                skills.append(task6_skill(
                    "task-6-community", "Task 6 Community", enabled=True, custom=True,
                ))
            fulfill_json(route, {"skills": skills})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", task6_routes)

    def leave_and_return():
        click_admin_link(page, "Connect", "/admin/connect")
        click_admin_link(page, "Skills", "/admin/skills")
        page.get_by_text("What the DJ does between tracks.", exact=True).wait_for(state="visible")

    def show_skill_names():
        hits = [
            query["data"] for query in query_cache_snapshot(page)
            if query["queryKey"] == ["shows", "skills"]
        ]
        assert len(hits) == 1, hits
        return [item["kind"] for item in hits[0]]

    # Prewarm the separate Shows consumer before entering Skills.
    page.goto(f"{WEB}/admin/shows", wait_until="domcontentloaded")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    page.wait_for_function("""() =>
      (window.__subwaveAdminQueryCacheSnapshot?.() || [])
        .some(query => JSON.stringify(query.queryKey) === '["shows","skills"]')
    """)
    assert show_skill_names() == [], show_skill_names()
    click_admin_link(page, "Skills", "/admin/skills")
    page.get_by_text("Task 6 Verify", exact=True).wait_for(state="visible")
    leave_and_return()

    with page.expect_response(
        lambda response: is_admin_request(response.request, "/dj/skill-toggle", "POST")
    ):
        page.get_by_label("Enable Task 6 Verify").click()
    leave_and_return()
    page.get_by_text("1 enabled", exact=True).wait_for(state="visible")
    assert show_skill_names() == ["task-6-verify"], show_skill_names()

    with page.expect_response(
        lambda response: is_admin_request(response.request, "/dj/skills/rescan", "POST")
    ):
        page.get_by_title("Rescan state/skills").click()
    page.get_by_text("Task 6 Rescanned", exact=True).wait_for(state="visible")
    assert show_skill_names() == ["task-6-verify", "task-6-rescanned"], show_skill_names()
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
    assert show_skill_names() == [
        "task-6-verify", "task-6-rescanned", "task-6-imported",
    ], show_skill_names()
    dialog.get_by_role("button", name="Install", exact=True).click()
    page.get_by_text("installed", exact=True).wait_for(state="visible")
    page.keyboard.press("Escape")
    dialog.wait_for(state="detached")
    leave_and_return()
    page.get_by_text("Task 6 Community", exact=True).wait_for(state="visible")
    assert show_skill_names() == [
        "task-6-verify", "task-6-rescanned", "task-6-imported", "task-6-community",
    ], show_skill_names()

    with page.expect_response(
        lambda response: is_admin_request(response.request, "/dj/skill-toggle", "POST")
    ):
        page.get_by_label("Enable Task 6 Verify").click()
    assert show_skill_names() == [
        "task-6-rescanned", "task-6-imported", "task-6-community",
    ], show_skill_names()

    assert mutation_hits == {"toggle": 2, "rescan": 1, "import": 1, "install": 1}, mutation_hits
    assert request_count(page, "/dj/skills", authenticated=True) == 2, page.request_log
    # Initial catalog plus one exact refresh after import and install.
    assert request_count(page, "/dj/skills/community", authenticated=True) == 3, page.request_log
    # Skills reuses the settings owner rather than creating a second roster key.
    assert request_count(page, "/settings", authenticated=True) == 1, page.request_log


@check
def skills_rescan_refreshes_files(page):
    """Rescan invalidates primed SKILL.md queries as well as the installed list."""
    skills = [task6_skill("task-6-file", "Task 6 File", custom=True)]
    current_brief = {"value": "Brief before disk rescan"}

    def skill_file():
        return {
            "kind": "task-6-file",
            "custom": True,
            "configFields": [],
            "config": {},
            "label": "Task 6 File",
            "cooldown": "15m",
            "cron": None,
            "cronInvalid": False,
            "cronOnly": False,
            "context": "",
            "knownContextFields": ["time"],
            "window": "any",
            "requiresKey": "",
            "hasTool": False,
            "tags": ["verify"],
            "brief": current_brief["value"],
            "defaults": None,
        }

    def task6_routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/dj/skills" and method == "GET":
            fulfill_json(route, {"skills": skills})
        elif path == "/dj/skills/community" and method == "GET":
            fulfill_json(route, {"community": []})
        elif path == "/dj/skills/task-6-file/file" and method == "GET":
            fulfill_json(route, skill_file())
        elif path == "/dj/skills/rescan" and method == "POST":
            current_brief["value"] = "Brief changed on disk"
            fulfill_json(route, {"skills": skills, "custom": 1})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", task6_routes)
    page.goto(f"{WEB}/admin/skills", wait_until="domcontentloaded")
    page.get_by_text("Task 6 File", exact=True).first.wait_for(state="visible")

    page.get_by_label("Edit Task 6 File").click()
    dialog = page.get_by_role("dialog")
    brief = dialog.get_by_label("The brief")
    brief.wait_for(state="visible")
    assert brief.input_value() == "Brief before disk rescan", brief.input_value()
    dialog.get_by_text("Close", exact=True).click()
    dialog.wait_for(state="detached")
    file_gets_before_rescan = request_count(
        page, "/dj/skills/task-6-file/file", authenticated=True,
    )

    with page.expect_response(
        lambda response: is_admin_request(response.request, "/dj/skills/rescan", "POST")
    ):
        page.get_by_title("Rescan state/skills").click()
    page.get_by_text("Rescanned, 1 custom skill loaded", exact=True).wait_for(state="visible")

    page.get_by_label("Edit Task 6 File").click()
    dialog = page.get_by_role("dialog")
    brief = dialog.get_by_label("The brief")
    brief.wait_for(state="visible")
    assert brief.input_value() == "Brief changed on disk", brief.input_value()
    assert request_count(
        page, "/dj/skills/task-6-file/file", authenticated=True,
    ) == file_gets_before_rescan + 1, page.request_log


@check
def skill_file_save_close_reopen_is_authoritative(page):
    """A pending save refresh cannot be dismissed and leave the old file cached."""
    skills = [task6_skill("task-6-saved-file", "Task 6 Saved File", enabled=True, custom=True)]
    current_brief = {"value": "Brief before save"}
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))

    # Let the real authenticated GET resolve at the network boundary, then hold
    # its fetch promise until the modal either aborts it or this check releases
    # it. A paused Playwright route deadlocks if it is fulfilled from the same
    # sync callback, so keep the delay in the browser where TanStack's real
    # AbortSignal remains observable.
    page.add_init_script("""
      (() => {
        const nativeFetch = window.fetch.bind(window);
        const race = { holdNext: false, held: false, aborted: false, release: null };
        window.__subwaveSkillFileRace = race;
        window.__subwaveHoldSkillFileGet = () => { race.holdNext = true; };
        window.__subwaveReleaseSkillFileGet = () => race.release?.();
        window.fetch = async (input, init = {}) => {
          const response = await nativeFetch(input, init);
          const url = typeof input === 'string' ? input : input.url;
          const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
          if (!race.holdNext || method !== 'GET' || new URL(url, location.href).pathname !== '/dj/skills/task-6-saved-file/file') {
            return response;
          }
          race.holdNext = false;
          race.held = true;
          await new Promise((resolve, reject) => {
            const signal = init.signal;
            let settled = false;
            const finish = (aborted) => {
              if (settled) return;
              settled = true;
              signal?.removeEventListener('abort', onAbort);
              if (aborted) {
                race.aborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
              } else {
                resolve();
              }
            };
            const onAbort = () => finish(true);
            race.release = () => finish(false);
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
          return response;
        };
      })();
    """)

    def skill_file():
        return {
            "kind": "task-6-saved-file", "custom": True,
            "configFields": [], "config": {}, "label": "Task 6 Saved File",
            "cooldown": "15m", "cron": None, "cronInvalid": False,
            "cronOnly": False, "context": "", "knownContextFields": ["time"],
            "window": "any", "requiresKey": "", "hasTool": False,
            "tags": ["verify"], "brief": current_brief["value"], "defaults": None,
        }

    def routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/dj/skills" and method == "GET":
            fulfill_json(route, {"skills": skills})
        elif path == "/dj/skills/community" and method == "GET":
            fulfill_json(route, {"community": []})
        elif path == "/dj/skills/task-6-saved-file/file" and method == "GET":
            fulfill_json(route, skill_file())
        elif path == "/dj/skills/task-6-saved-file/file" and method == "PUT":
            current_brief["value"] = route.request.post_data_json["brief"]
            # The write endpoint owns the installed roster, not a complete file envelope.
            fulfill_json(route, {"skills": skills})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", routes)
    page.goto(f"{WEB}/admin/skills", wait_until="domcontentloaded")
    page.get_by_text("Task 6 Saved File", exact=True).first.wait_for(state="visible")
    page.get_by_label("Edit Task 6 Saved File").click()
    dialog = page.get_by_role("dialog")
    brief = dialog.get_by_label("The brief")
    brief.wait_for(state="visible")
    brief.fill("Brief after save")
    page.evaluate("window.__subwaveHoldSkillFileGet()")
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/dj/skills/task-6-saved-file/file", "PUT",
        )
    ):
        dialog.get_by_role("button", name="Save", exact=True).click()
    page.wait_for_function("window.__subwaveSkillFileRace.held")

    # All three real dismissal routes must stay closed while the authoritative
    # GET is attached to this modal: Radix open-change (Escape and the header
    # close control) plus the footer's direct Close callback.
    page.keyboard.press("Escape")
    assert dialog.is_visible(), "Escape dismissed the editor during the save refresh"
    close_buttons = dialog.get_by_role("button", name="Close", exact=True)
    assert close_buttons.count() == 2, close_buttons.count()
    assert close_buttons.first.is_disabled(), "header Close stayed enabled during the save refresh"
    assert dialog.is_visible(), "header Close dismissed the editor during the save refresh"
    assert close_buttons.last.is_disabled(), "footer Close stayed enabled during the save refresh"
    assert dialog.is_visible(), "footer Close dismissed the editor during the save refresh"
    assert dialog.get_attribute("aria-busy") == "true", dialog.get_attribute("aria-busy")
    assert page.evaluate("window.__subwaveSkillFileRace.aborted") is False

    page.evaluate("window.__subwaveReleaseSkillFileGet()")
    dialog.get_by_text("SAVED TO BOOTH", exact=False).wait_for(state="visible")
    assert dialog.get_attribute("aria-busy") is None, dialog.get_attribute("aria-busy")
    dialog.get_by_role("button", name="Close", exact=True).last.click()
    dialog.wait_for(state="detached")

    page.get_by_label("Edit Task 6 Saved File").click()
    reopened = page.get_by_role("dialog").get_by_label("The brief")
    reopened.wait_for(state="visible")
    assert reopened.input_value() == "Brief after save", reopened.input_value()
    assert request_count(
        page, "/dj/skills/task-6-saved-file/file", authenticated=True,
    ) == 2, page.request_log
    assert request_count(
        page, "/dj/skills/task-6-saved-file/file", method="PUT", authenticated=True,
    ) == 1, page.request_log
    assert page_errors == [], page_errors


@check
def skills_modal_mutations_reconcile_show_picker(page):
    """Edit, reset and delete share the enabled Shows projection handler."""
    skills = [
        task6_skill("task-6-custom-edit", "Task 6 Custom Edit", enabled=True, custom=True),
        task6_skill("task-6-built-in", "Task 6 Built In", enabled=True, custom=False),
    ]
    file_labels = {
        "task-6-custom-edit": "Task 6 Custom Edit",
        "task-6-built-in": "Task 6 Built In",
    }

    def file_body(kind):
        custom = kind == "task-6-custom-edit"
        return {
            "kind": kind, "custom": custom, "configFields": [], "config": {},
            "label": file_labels[kind], "cooldown": "15m", "cron": None,
            "cronInvalid": False, "cronOnly": False, "context": "",
            "knownContextFields": ["time"], "window": "any", "requiresKey": "",
            "hasTool": False, "tags": ["verify"], "brief": "A valid skill brief.",
            "defaults": None if custom else {
                "label": "Task 6 Built In Reset", "cooldown": "15m",
                "context": "", "brief": "A valid shipped brief.",
            },
        }

    def routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/dj/skills" and method == "GET":
            fulfill_json(route, {"skills": skills})
        elif path == "/dj/skills/community" and method == "GET":
            fulfill_json(route, {"community": []})
        elif path.endswith("/file") and method == "GET":
            kind = path.split("/")[3]
            fulfill_json(route, file_body(kind))
        elif path.endswith("/file") and method == "PUT":
            kind = path.split("/")[3]
            file_labels[kind] = route.request.post_data_json["label"]
            next(item for item in skills if item["name"] == kind)["label"] = file_labels[kind]
            fulfill_json(route, {"skills": skills})
        elif path == "/dj/skills/task-6-built-in/reset" and method == "POST":
            file_labels["task-6-built-in"] = "Task 6 Built In Reset"
            skills[0 if skills[0]["name"] == "task-6-built-in" else 1]["label"] = file_labels["task-6-built-in"]
            fulfill_json(route, {"skills": skills})
        elif path == "/dj/skills/task-6-custom-edit" and method == "DELETE":
            skills[:] = [item for item in skills if item["name"] != "task-6-custom-edit"]
            fulfill_json(route, {"skills": skills})
        else:
            route.continue_()

    page.route("http://localhost:7791/**", routes)

    def show_projection():
        data = next(
            query["data"] for query in query_cache_snapshot(page)
            if query["queryKey"] == ["shows", "skills"]
        )
        return [(item["kind"], item.get("label")) for item in data]

    page.goto(f"{WEB}/admin/shows", wait_until="domcontentloaded")
    page.get_by_text("Build your shows here.", exact=False).wait_for(state="visible")
    page.wait_for_function("""() =>
      (window.__subwaveAdminQueryCacheSnapshot?.() || [])
        .some(query => JSON.stringify(query.queryKey) === '["shows","skills"]')
    """)
    click_admin_link(page, "Skills", "/admin/skills")
    page.wait_for_timeout(250)
    page.get_by_label("Edit Task 6 Custom Edit").click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label("Skill name").fill("Task 6 Custom Edited")
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/dj/skills/task-6-custom-edit/file", "PUT",
        )
    ):
        dialog.get_by_role("button", name="Save", exact=True).click()
    dialog.get_by_text("SAVED TO BOOTH", exact=False).wait_for(state="visible")
    assert show_projection()[0] == ("task-6-custom-edit", "Task 6 Custom Edited"), show_projection()

    dialog.get_by_role("button", name="Delete", exact=True).click()
    confirm = page.get_by_role("alertdialog")
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/dj/skills/task-6-custom-edit", "DELETE",
        )
    ):
        confirm.get_by_role("button", name="delete skill", exact=True).click()
    dialog.wait_for(state="detached")
    assert show_projection() == [("task-6-built-in", "Task 6 Built In")], show_projection()

    page.get_by_label("Edit Task 6 Built In").click()
    dialog = page.get_by_role("dialog")
    with page.expect_response(
        lambda response: is_admin_request(
            response.request, "/dj/skills/task-6-built-in/reset", "POST",
        )
    ):
        dialog.get_by_text("Reset to default", exact=False).click()
    dialog.get_by_text("RESET TO SHIPPED DEFAULT", exact=False).wait_for(state="visible")
    assert show_projection() == [
        ("task-6-built-in", "Task 6 Built In Reset"),
    ], show_projection()
    assert request_count(page, "/dj/skills", authenticated=True) == 2, page.request_log


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


def run_doctor_clean_eof_fallback(page, stream_body):
    """A clean transport EOF is not the Doctor protocol's completion marker."""
    fallback_report = task6_doctor_report("Completed fallback after EOF")
    reviewed_labels = []

    def doctor_routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/doctor/last" and method == "GET":
            fulfill_json(route, {"report": None, "review": None})
        elif path == "/doctor/stream" and method == "GET":
            route.fulfill(status=200, content_type="text/event-stream", body=stream_body)
        elif path == "/doctor" and method == "GET":
            fulfill_json(route, fallback_report)
        elif path == "/doctor/review" and method == "POST":
            body = route.request.post_data_json
            reviewed_labels.append(
                body["report"]["sections"][0]["findings"][0]["label"]
            )
            fulfill_json(route, {
                "available": True,
                "overall": "healthy",
                "summary": "Reviewed completed fallback",
                "priorities": [],
            })
        else:
            route.continue_()

    page.route("http://localhost:7791/**", doctor_routes)
    page.goto(f"{WEB}/admin/doctor", wait_until="domcontentloaded")
    page.get_by_role("button", name="Let's go").click()
    page.get_by_text("Completed fallback after EOF", exact=True).wait_for(timeout=5000)
    page.get_by_text("Reviewed completed fallback", exact=True).wait_for(timeout=5000)
    click_admin_link(page, "Connect", "/admin/connect")
    page.get_by_role("link", name="DJ Doc", exact=True).click()
    page.wait_for_url("**/admin/doctor")
    page.get_by_text("Completed fallback after EOF", exact=True).wait_for(state="visible")
    assert reviewed_labels == ["Completed fallback after EOF"], reviewed_labels
    assert request_count(page, "/doctor/last", authenticated=True) == 1, page.request_log
    assert request_count(page, "/doctor/stream", authenticated=True) == 1, page.request_log
    assert request_count(page, "/doctor", authenticated=True) == 1, page.request_log
    assert request_count(page, "/doctor/review", method="POST", authenticated=True) == 1, page.request_log


@check
def doctor_partial_eof_keeps_progress(page):
    """A section followed by EOF remains the report without a duplicate batch run."""
    partial_label = "Partial stream survives clean EOF"
    partial = task6_doctor_report(partial_label)["sections"][0]
    reviewed_labels = []

    def doctor_routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/doctor/last" and method == "GET":
            fulfill_json(route, {"report": None, "review": None})
        elif path == "/doctor/stream" and method == "GET":
            route.fulfill(
                status=200,
                content_type="text/event-stream",
                body=f"event: section\ndata: {json.dumps(partial)}\n\n",
            )
        elif path == "/doctor" and method == "GET":
            fulfill_json(route, task6_doctor_report("Batch must not run"))
        elif path == "/doctor/review" and method == "POST":
            reviewed_labels.append(
                route.request.post_data_json["report"]["sections"][0]["findings"][0]["label"]
            )
            fulfill_json(route, {
                "available": True,
                "overall": "attention",
                "summary": "Reviewed partial report",
                "priorities": [],
            })
        else:
            route.continue_()

    page.route("http://localhost:7791/**", doctor_routes)
    page.goto(f"{WEB}/admin/doctor", wait_until="domcontentloaded")
    page.get_by_role("button", name="Let's go").click()
    page.get_by_text(partial_label, exact=True).wait_for(timeout=5000)
    page.get_by_text("Reviewed partial report", exact=True).wait_for(timeout=5000)
    assert reviewed_labels == [partial_label], reviewed_labels
    assert request_count(page, "/doctor/stream", authenticated=True) == 1, page.request_log
    assert request_count(page, "/doctor", authenticated=True) == 0, page.request_log


@check
def doctor_empty_eof_falls_back(page):
    """An empty 200 SSE body also falls back exactly once."""
    run_doctor_clean_eof_fallback(page, "")


@check
def doctor_partial_eof_skips_failed_batch(page):
    """A partial stream never starts the failing batch fallback."""
    partial_label = "Partial stream remains visible"
    partial = task6_doctor_report(partial_label)["sections"][0]

    def doctor_routes(route):
        path = urllib.parse.urlparse(route.request.url).path
        method = route.request.method
        if path == "/doctor/last" and method == "GET":
            fulfill_json(route, {"report": None, "review": None})
        elif path == "/doctor/stream" and method == "GET":
            route.fulfill(
                status=200,
                content_type="text/event-stream",
                body=f"event: section\ndata: {json.dumps(partial)}\n\n",
            )
        elif path == "/doctor" and method == "GET":
            fulfill_json(route, {"error": "batch diagnosis failed"}, status=503)
        elif path == "/doctor/review" and method == "POST":
            fulfill_json(route, {
                "available": True,
                "overall": "attention",
                "summary": "partial was reviewed",
                "priorities": [],
            })
        else:
            route.continue_()

    page.route("http://localhost:7791/**", doctor_routes)
    page.goto(f"{WEB}/admin/doctor", wait_until="domcontentloaded")
    page.get_by_role("button", name="Let's go").click()
    page.get_by_text(partial_label, exact=True).wait_for(timeout=5000)
    page.get_by_text("partial was reviewed", exact=True).wait_for(timeout=5000)
    assert request_count(page, "/doctor/stream", authenticated=True) == 1, page.request_log
    assert request_count(page, "/doctor", authenticated=True) == 0, page.request_log
    assert request_count(page, "/doctor/review", method="POST", authenticated=True) == 1, page.request_log


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
