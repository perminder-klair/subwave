# Cloud TTS voice discovery

Pull the available voice list from a cloud TTS engine and offer it as a dropdown
when picking a persona's voice, instead of making the operator paste an opaque
voice id into a free-text box.

Origin: Discord suggestion from K8-Bit [SBL] — *"it would be good if it was
possible to pull the available voices from an OpenAI cloud/local TTS engine to
be able to select in drop-down for the personas. Highly variable, but e.g. on
the docker deployments I made, they mostly respond to `curl
http://ip:port/v1/audio/voices` (for Fish, Echo-TTS and Omnivoice anyway)."*

## Background: what already exists

Most of the plumbing is in place. SUB/WAVE's `cloud` TTS engine already supports
three providers (`TTS_CLOUD_PROVIDERS`, `settings.ts:509`): `openai`,
`elevenlabs`, `openai-compatible`. The compat provider already has a
`settings.tts.cloud.baseUrl` (`settings.ts:1176`, documented as needing the
`/v1` suffix) and is constructed with `createOpenAI({ baseURL, apiKey: apiKey ||
'unused' })` at `cloud-speech.ts:162-166`.

Critically, **model discovery against a compat server already works**:
`GET /settings/llm/models` (`routes/settings.ts:608-798`) fetches
`${baseUrl}/models` and the cloud-TTS section is already wired to it —
`TtsSection.tsx:312-322` calls `useModelDiscovery` with
`provider: 'openai-compatible'`. So an operator running Fish or Kokoro already
gets a model dropdown.

What is missing is the voice half. Today, when the provider is
`openai-compatible`, the voice is a bare text input in both places it can be
set:

- station-wide default — `TtsSection.tsx:874-893`, placeholder
  `"Server-specific (cloning ref or speaker id)"`
- per persona — `PersonaVoiceCard.tsx:376-388`, same treatment

For `openai` and `elevenlabs` the UI shows a curated hardcoded list
(`web/lib/cloudVoices.ts` → `CLOUD_VOICES`) plus a `__custom__` free-text
escape hatch. That list is nine stock ElevenLabs voices — it cannot know about
an operator's own cloned voices, so ElevenLabs users are pasting raw
`voice_id`s by hand too.

There is no voice list anywhere in the controller. Cloud voice curation is
entirely client-side.

## Approaches considered

**A. Mirror the model-discovery route (chosen).** Add
`GET /settings/tts/voices`, a near-copy of the existing `/settings/llm/models`
route, plus a `useVoiceDiscovery` hook copied from `useModelDiscovery.ts`, and
feed the result into the existing `VoicePicker` component. Fits the established
pattern exactly, reuses a component that already supports grouped options and
per-row audition, and degrades to today's behaviour when discovery fails.

**B. Client-side fetch straight from the browser.** The admin page would call
the compat server directly. Rejected: the TTS server is typically on the
operator's LAN and the admin UI may be reached over the internet through Caddy,
so the browser often cannot reach it; it would also need CORS on every
third-party TTS server, which none of them set.

**C. Cache a voice list into `settings.json` at save time.** Discover once when
the operator saves the TTS config and persist it. Rejected: adds a stale-cache
failure mode and a settings-schema migration for something that costs one cheap
fetch on demand. Discovery is a UI affordance, not station state.

## Design

### 1. Voice catalog module (the isolated unit)

New file `controller/src/llm/internal/speech/voice-catalog.ts`, exported through
the existing barrel `controller/src/llm/speech.ts` (which today re-exports only
`{ speak, isConfigured }`). Call sites import the barrel — never `internal/`,
per CLAUDE.md.

Two exports:

```ts
export type CloudVoice = { id: string; label: string; hint?: string };

// Pure. No I/O. The unit-test seam.
export function normalizeVoiceList(payload: unknown): CloudVoice[];

// Network. Never throws; returns { ok, voices, error? }.
export function listVoices(opts: {
  provider: 'openai-compatible' | 'elevenlabs';
  baseUrl?: string;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; voices: CloudVoice[]; error?: string }>;
```

**`normalizeVoiceList` accepts the shapes the ecosystem actually returns**, since
`/v1/audio/voices` is not in the OpenAI spec and every server invented its own:

| Payload | Source style |
|---|---|
| `["alloy","nova"]` | bare array |
| `{"voices":["af_alloy",…]}` | Kokoro-FastAPI, openedai-speech |
| `{"data":[{"id":"x"},…]}` | servers mimicking `/v1/models` |
| `[{"voice_id":"x","name":"Rachel"}]` | ElevenLabs style |

Rules: unwrap `.voices` or `.data` if the payload is an object; for each item,
id comes from the string itself or the first present of
`id | voice_id | name | voice`, label from the first present of
`name | label | display_name` falling back to a title-cased id; drop entries
with a blank id; dedupe by id keeping the first; **discard ids longer than 100
chars** (`normalizeTts` caps persona voice at 100 chars, `settings.ts:1564` — a
voice we cannot save must not be offered); cap the list at 500 entries.

**`listVoices` probing**, for `openai-compatible`, in order, stopping at the
first response that parses to at least one voice:

```
GET {baseUrl}/audio/voices        ← try first
GET {baseUrl}/voices              ← on non-200 or unparseable
GET {baseUrl}/audio/speech/voices
```

Sends `Authorization: Bearer ${apiKey}` only when a key is configured, matching
`routes/settings.ts:647-650`. Per-attempt timeout ~3s via `AbortSignal.timeout`,
whole-call budget 8s, mirroring the models route's 10s.

For `elevenlabs`: a single `GET https://api.elevenlabs.io/v1/voices` with the
`xi-api-key` header — the pattern already used for key validation at
`routes/settings.ts:348-350`. Maps `voice_id` → id, `name` → label,
`category` (`premade` / `cloned` / `generated`) → hint.

`openai` is not discoverable — OpenAI publishes no voice-list endpoint. It keeps
the curated `CLOUD_VOICES.openai` list unchanged.

### 2. Route

`GET /settings/tts/voices?provider=<p>&baseUrl=<u>` in
`controller/src/routes/settings.ts`, behind the existing `requireAdmin` gate
like every other settings route.

Always responds 200 with `{ ok, voices, provider, error? }` — same
never-throw contract as `/settings/llm/models`, so the UI has one code path.

**The API key is never accepted as a query parameter.** It is read from the
persisted config (`settings.tts.cloud.apiKey`, or `ELEVENLABS_API_KEY` from
`state/secrets.env`) so it cannot leak into access logs or browser history.
Consequence: ElevenLabs discovery works only after the key is saved. The UI
already computes that condition — `ttsKeySet` in `TtsSection.tsx:406-411` —
and gates the control on it.

`baseUrl` comes from the query rather than settings so the operator can discover
against a URL they have typed but not yet saved, which is the same affordance
the model dropdown gives them.

**Hardening (in scope, small):** `settings.tts.cloud.baseUrl` is currently only
trimmed on load (`settings.ts:2059-2062`) with no shape check, unlike
`llm.baseUrl` which enforces an `http(s)://` prefix and a 200-char cap
(`settings.ts:424-431`). Since this feature makes the controller fetch that URL
on demand, apply the same validation to `tts.cloud.baseUrl`. This adds no new
capability — the controller already POSTs synthesis requests to that exact URL —
but it closes the sloppiest input path into a server-side fetch.

### 3. Web hook

New `web/hooks/useVoiceDiscovery.ts`, modeled directly on
`useModelDiscovery.ts` (92 lines): 400ms debounce, monotonic `reqIdRef` to drop
stale responses, `AbortController` on unmount, returns
`{ voices, loading, error, refresh }`.

**Fetch once, not once per persona.** `PersonaVoiceCard` renders per persona, so
a hook instance inside it would fire N identical requests. Because persona
overrides only carry `{ provider, voice }` and `baseUrl` is always read from the
global config (`cloud-speech.ts:231-234`), there are at most two distinct lists
station-wide. So the parent that already owns the `SettingsResponse` (
`PersonaEditor` / the personas page) owns the hook(s) and passes
`cloudVoices: Partial<Record<CloudProvider, CloudVoice[]>>` down as a prop.
Lists are fetched lazily — only for providers actually selected by the station
default or by some persona.

### 4. UI

Both call sites switch from "free text for compat, curated Select otherwise" to
a `VoicePicker` fed by grouped options. `VoicePicker` already takes
`groups: VoicePickerGroup[]` and already auditions each row through
`POST /settings/tts/preview`, so discovered voices become playable with no
change to that component.

- **`openai-compatible`** — `[{label:'Discovered', voices}, {label:'Custom',
  voices:[__custom__]}]`. With zero discovered voices, the picker is skipped
  entirely and today's free-text input renders unchanged.
- **`elevenlabs`** — `[{label:'Your voices', voices: discovered}, {label:
  'Presets', voices: curated.filter(c => !discovered.some(d => d.id === c.id))},
  {label:'Custom', …}]`. Discovered wins on id collision because it carries the
  operator's own name for the voice.
- **`openai`** — unchanged.

Touch points: `PersonaVoiceCard.tsx:338-432` (cloud branch) and
`TtsSection.tsx:868-946` (station default voice).

`GET /settings` is **not** changed. Discovery is a separate on-demand route, so
the fat settings payload does not grow and `SettingsResponse['tts']`
(`web/components/admin/personas/types.ts:88-107`) is untouched. A voice list is
fetched only when an operator is actually looking at a cloud voice field.

## Edge cases and regressions to guard

1. **Voice-reset handlers will clobber a discovered voice.** `selectEngine`
   (`PersonaVoiceCard.tsx:56-74`) resets voice to `CLOUD_VOICES[provider][0].id`
   when the current value is not a curated preset, and `selectCloudProvider`
   (`TtsSection.tsx:414-424`) does the same. Both "is this a known voice" checks
   must be widened to include discovered ids, or switching engine back and forth
   silently destroys a valid selection.
2. **Discovery must never block saving.** The `__custom__` free-text path stays
   in every branch. A server that returns nothing, errors, times out, or is
   unreachable leaves the operator exactly where they are today.
3. **Compat personas may legitimately have an empty voice.** `settings.ts:1595`
   deliberately does not fill a default for `openai-compatible` (the server
   picks). The picker must treat empty as valid, not coerce to the first
   discovered entry.
4. **ElevenLabs auditions cost credits.** Per-row preview already behaves this
   way for the nine curated voices, so this is not new, but a discovered list can
   be long — do not auto-preview, keep it click-to-play as it is now.
5. **`hint` is display-only.** Never persist it; only the id round-trips into
   settings.

## Out of scope

- `availableEngines().cloudByProvider` omits `openai-compatible`
  (`tts.ts:438-441`), which the UI works around by hardcoding `cloud: true` at
  `PersonaVoiceCard.tsx:86-88`. Adjacent, pre-existing, not required here.
- Voice discovery for local engines (piper/kokoro/chatterbox/pocket-tts). Those
  already enumerate from the filesystem via `chatterbox.listReferenceVoices()`
  and `piper.listPiperVoices()`.
- Any change to how synthesis itself works. This is a picker feature only.

## Testing

- **Pure**: new `controller/scripts/voice-catalog.test.ts` covering all four
  payload shapes above plus junk (`null`, `{}`, `[{}]`, an id over 100 chars,
  duplicate ids, a 600-entry list). `controller/scripts/run-tests.ts`
  auto-discovers any `scripts/*.test.ts`, so `npm test` picks it up with no
  `package.json` edit.
- **Route**: manual probe against a live compat server; verify the 200-with-error
  contract when `baseUrl` is unreachable and when it 404s all three paths.
- **UI**: `/admin/personas` and `/admin/settings` with (a) a reachable compat
  server, (b) an unreachable one — must render today's text input, (c) an
  ElevenLabs key set. The `verify` skill covers the isolated-controller +
  Playwright loop.
- **Gate**: `npm run lint` in `controller/` and `web/` (eslint + `tsc --noEmit`),
  which is the CI merge gate.

## Files touched

| File | Change |
|---|---|
| `controller/src/llm/internal/speech/voice-catalog.ts` | new — normalizer + fetch |
| `controller/src/llm/speech.ts` | re-export `listVoices` |
| `controller/src/routes/settings.ts` | new `GET /settings/tts/voices` |
| `controller/src/settings.ts` | validate `tts.cloud.baseUrl` shape |
| `controller/scripts/voice-catalog.test.ts` | new — normalizer cases |
| `web/hooks/useVoiceDiscovery.ts` | new |
| `web/components/admin/personas/PersonaVoiceCard.tsx` | picker for compat + merged ElevenLabs groups |
| `web/components/admin/personas/PersonaEditor.tsx` | own the hook, pass lists down |
| `web/components/admin/settings/TtsSection.tsx` | same for the station default |
| `docs/` | brief note on voice discovery in the TTS docs |
