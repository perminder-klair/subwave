"""Focused checks for the shared admin TanStack Query client.

Runs only against the isolated controller and web servers documented in
.claude/skills/verify/SKILL.md.  It intentionally refuses any other ports.
"""
import base64
import json
import sys
import traceback
import urllib.error
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
    page.on("request", lambda request: page.requests.append(request.url))
    return browser, page


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
    box = open_settings_tts(page)
    box.fill("http://voice-refresh.test/v1")
    page.get_by_title("Refresh voice list").click()
    page.wait_for_timeout(0)
    refresh_hits = [hit for hit in voice_hits if "voice-refresh.test" in hit]
    assert refresh_hits, voice_hits


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
    page.route(
        "**/settings/tts/voices**",
        lambda route: (voice_hits.append(route.request.url), route.fulfill(**voice_response([
            {"id": "old-voice", "label": "Old voice"},
        ])))[1],
    )
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
    assert "Old voice" not in page.locator("body").inner_text()


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
