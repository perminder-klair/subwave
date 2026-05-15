# Ollama Intent Parsing — Stage 3.2 in Detail

> **⚠️ Superseded (AI SDK migration).** This document described the original
> hand-rolled `fetch` client. `matchRequest` now goes through the Vercel AI
> SDK: `ollama.matchRequest()` → `djObject()` (`llm/sdk.js`) →
> `generateText` + `Output.object` with a Zod schema, and the model is
> resolved by `llm/provider.js` (no longer hard-wired to Ollama). The schema
> is now Zod-validated by the SDK — there is no manual `JSON.parse` or regex
> recovery. The *prompt* (`REQUEST_SYSTEM`, the user-prompt assembly) is
> unchanged. See [`ai-sdk-migration.md`](./ai-sdk-migration.md) for the
> current architecture. The sections below are kept for historical context.

A deep look at the single step in the [request flow](./request-flow.md) where
the listener's raw words ("something for late-night driving") become structured
search parameters the controller can act on.

This is `ollama.matchRequest()` in `controller/src/ollama.js`.

---

## What this step does

| | |
|---|---|
| **Input** | A free-text string + the currently-playing track (optional) |
| **Output** | A fixed-shape JSON object: `search_terms`, `artist`, `sort`, `scope`, `mood`, `intent`, `ack` |
| **Where** | `controller/src/ollama.js` → `matchRequest()` → `ollamaChat()` |
| **Model** | An LLM running on a homelab Ollama box (default `qwen2.5:7b`) |
| **Why an LLM** | Listener words are unstructured ("cosy", "more like this", "Diljit's newest"). A keyword search can't tell a *mood* from an *artist name*. The LLM classifies the request into fields each downstream pick source understands. |

The controller never trusts the LLM to *find* a song — only to *classify the
request*. Track resolution happens afterwards against Navidrome and the local
mood library (stage 3.3 of the request flow).

---

## Libraries involved

This is the part worth being precise about — the repo has **two** LLM paths and
intent parsing uses the older one.

### What `matchRequest` actually uses

| Library | Used? | Notes |
|---|---|---|
| Node built-in `fetch` | ✅ | The only HTTP client. No `axios`, no `node-fetch`. |
| Ollama native REST API | ✅ | `POST {OLLAMA_URL}/api/chat` — Ollama's own HTTP endpoint. |
| `ai` (Vercel AI SDK) | ❌ | **Not used** by `matchRequest`. |
| `ollama-ai-provider-v2` | ❌ | Not used here. |
| `zod` | ❌ | Not used here — the schema is enforced by the prompt + Ollama's JSON mode, not a Zod object. |

`matchRequest` → `ollamaChat()` is a hand-rolled `fetch` wrapper. It posts a
plain JSON body to Ollama and parses the response itself.

### The other path (for contrast)

`controller/src/llm/sdk.js` *does* use the Vercel AI SDK — `generateText` /
`generateObject` from the `ai` package, wired to Ollama through
`ollama-ai-provider-v2`, with `zod` schemas. But per the comment in that file,
**only `controller/src/skills/` uses it**. The core paths — `matchRequest`,
`pickNextTrack`, `generateIntro/Link/Hourly/Weather/StationId` — were
deliberately left on the raw `fetch` client.

So: **intent parsing = raw `fetch` + Ollama JSON mode. Skills = Vercel AI SDK.**

### Dependency origin

From `controller/package.json`:

```json
"dependencies": {
  "ai": "^6.0.182",                  // Vercel AI SDK — skills/ only
  "ollama-ai-provider-v2": "^3.5.1", // AI SDK ↔ Ollama bridge — skills/ only
  "zod": "^4.4.3",                   // schema validation — skills/ only
  "express": "^4.21.0",
  "node-cron": "^3.0.3",
  "pino": "^9.5.0", "pino-pretty": "^11.3.0"
}
```

`matchRequest` depends on **none** of these — it's pure Node.

### Configuration

From `controller/src/config.js`:

```js
ollama: {
  url:   process.env.OLLAMA_URL   || 'http://x1pro.tail.ts.net:11434',
  model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
}
```

The default URL is a Tailscale hostname — the LLM runs on a separate homelab
machine, not inside the Docker stack.

---

## Data flow, step by step

```
matchRequest(userQuery, { listenerName, nowPlaying })
        │
        │  1. Build the user prompt string
        ▼
   userPrompt =  'Listener "Sam" requests: <text>
                  [Context: Currently playing "<title>" by <artist>]'
        │
        │  2. Hand to ollamaChat() with two messages
        ▼
   messages = [
     { role: 'system', content: REQUEST_SYSTEM },   // the schema + rules
     { role: 'user',   content: userPrompt },
   ]
        │
        │  3. ollamaChat() POSTs to Ollama
        ▼
   POST http://x1pro.tail.ts.net:11434/api/chat
   {
     "model":   "qwen2.5:7b",
     "messages": [...],
     "stream":   false,
     "format":   "json",          ← constrained decoding
     "options":  { "temperature": 0.4 }
   }
        │
        │  4. Ollama returns
        ▼
   { "message": { "content": "{ \"search_terms\": [...], ... }" }, ... }
        │
        │  5. record() the call into a 30-entry ring buffer (for /debug)
        │  6. JSON.parse(content)  — with regex fallback
        ▼
   { search_terms, artist, sort, scope, mood, intent, ack }
```

### 1. Building the user prompt

`matchRequest` assembles a single user string from three parts:

```js
const userPrompt = [
  listenerName ? `Listener "${listenerName}" requests:` : `Anonymous request:`,
  userQuery,
  ctxLines.length ? `\n[Context for resolving references like "similar",
      "more like this", "match this vibe":\n${ctxLines.join('\n')}]` : '',
].filter(Boolean).join(' ');
```

- **Listener name** — so the model knows whose request it is (it doesn't change
  the parse, but the `ack` can be phrased naturally).
- **The raw query** — verbatim listener text.
- **Now-playing context** — only added if a track is playing. This is what lets
  the model resolve relative requests: *"something slower than this"*,
  *"match this vibe"* are meaningless without knowing what "this" is.

### 2. The system prompt — `REQUEST_SYSTEM`

A long constant string in `ollama.js`. It carries three things:

1. **The exact output schema** — 7 keys, in a fixed order, none omittable,
   `null` where inapplicable.
2. **A vibe-to-mood mapping table** — e.g. `overcast → calm or reflective`,
   `late night → night`, `gym → workout`. This forces vibe words *out* of
   `search_terms` and *into* the `mood` field, because Navidrome can't search
   for "cosy" but the local mood library can.
3. **Seven worked examples** — one per request shape (`latest album`,
   `old track`, `something romantic`, `overcast mood`, `rainy day`,
   `late-night driving`, `play <title> by <artist>`), each showing the exact
   JSON to mirror.

The hard rule: `search_terms` may only contain **real library values** —
artist names, song titles, genres. Never mood words. Downstream code in
`server.js` (stage 2b) defensively re-checks this and drops any term equal to
the `mood` string.

### 3. The HTTP call — `ollamaChat()`

The key flag is `format: 'json'`. When `format === 'json'` is in the request
body, Ollama uses **constrained decoding** — it is structurally prevented from
emitting anything that isn't valid JSON. This is what makes the parse in step 6
reliable.

Sampling for this call: `temperature: 0.4`. Low on purpose — request matching
is a *classification* task, so it wants deterministic, repeatable output, not
creativity. (Contrast: `generateIntro` runs at `temperature: 0.95` because that
one is a creative writing task.)

### 4. The Ollama response

Ollama replies with its standard chat envelope:

```json
{ "message": { "role": "assistant", "content": "{...the JSON we want...}" }, ... }
```

`ollamaChat()` pulls out `data.message?.content` — a **string** that (thanks to
JSON mode) contains a JSON document.

### 5. Recording the call

Every call — success or failure — is pushed onto `recentCalls`, a 30-entry
ring buffer exported from `ollama.js`:

```js
record({
  kind: 'matchRequest', ok: true, ms: <elapsed>,
  model, sampling, systemPreview, user, response, t
});
```

The admin `GET /debug` endpoint reads this buffer, so the last 30 LLM calls
(prompt + raw response + latency) are inspectable without log diving.

### 6. Parsing — with a fallback

```js
try {
  return JSON.parse(text);
} catch (err) {
  const match = text.match(/\{[\s\S]*\}/);   // grab the first {...} block
  if (match) return JSON.parse(match[0]);
  throw new Error(`Failed to parse Ollama response: ${text.slice(0, 200)}`);
}
```

JSON mode makes the direct parse succeed almost always. The regex fallback
catches the rare case where a model wraps the object in stray prose. If even
that fails, it throws — and the `POST /request` handler in `server.js` catches
it and returns `500` to the listener.

**There is no retry.** Per `CLAUDE.md`, Ollama on a homelab box may be slow but
is reliable; a retry storm would make a slow box slower.

---

## The output object

```js
{
  search_terms: ["punjabi"],   // 1-3 strings: artist / title / genre — or []
  artist:       null,          // artist's common name, or null
  sort:         null,          // "latest" | "oldest" | "popular" | null
  scope:        "song",        // "song" | "album"  (default "song")
  mood:         "driving",     // one of ~17 fixed mood words, or null
  intent:       "Wants night-drive music.",
  ack:          "Keep the road quiet — this one's for you."
}
```

Each field drives a specific downstream branch in `server.js` (request-flow
stage 3.3):

| Field | Consumed by |
|---|---|
| `artist` + `sort`/`scope` | `pickByArtistAndSort()` — "latest album by X" path |
| `search_terms` | `subsonic.search()` per term |
| `mood` | `library.songsByMood()` against `state/moods.json` |
| `intent` | logged; also passed to `queue.push()` as the queue item's intent |
| `ack` | returned straight to the browser, shown in the request drawer's success card |

`mood` and `intent`/`ack` are the LLM's only "free" outputs that reach the
listener; the rest are routing keys.

---

## Worked example

Listener "Sam" types **"something for late-night driving"** with nothing playing.

**User prompt sent to Ollama:**
```
Listener "Sam" requests: something for late-night driving
```

**System prompt:** `REQUEST_SYSTEM` (schema + mood table + examples).

**HTTP body:**
```json
{ "model": "qwen2.5:7b", "stream": false, "format": "json",
  "options": { "temperature": 0.4 }, "messages": [ ... ] }
```

**Ollama returns** (`message.content`):
```json
{"search_terms":[],"artist":null,"sort":null,"scope":"song",
 "mood":"driving","intent":"Wants night-drive music.",
 "ack":"Keep the road quiet — this one's for you."}
```

**`matchRequest` returns** that object. Back in `server.js`: `search_terms` is
empty and `artist` is null, so the artist-sort and search branches are skipped;
`mood: "driving"` hits stage 2c — `library.songsByMood("driving")` picks a
track. `ack` flows back to Sam's browser.

---

## Failure modes

| Failure | What happens |
|---|---|
| Ollama box unreachable / non-200 | `ollamaChat()` throws → `matchRequest` throws → `POST /request` returns `500 { error }` → browser shows "Request failed". |
| Model emits non-JSON despite JSON mode | regex `{...}` recovery; if that fails too, throw → `500`. |
| Valid JSON but a nonsense `mood` (not in the 17-word vocabulary) | `library.songsByMood()` returns an empty pool → the controller falls through to the next pick source (similar-to-current → context mood → starred). |
| Empty `search_terms` and null everything | falls through to the dominant-mood / starred fallbacks — the listener still gets a song. |

The design principle: the LLM can be wrong about *classification* and the
listener still gets music, because stage 3.3 has six ordered fallbacks. The
only thing that produces a hard error is the LLM being **unreachable** or
**unparseable**.

---

## File map

| File | Role in this step |
|---|---|
| `controller/src/ollama.js` | `matchRequest()`, `ollamaChat()`, `REQUEST_SYSTEM`, `recentCalls` ring buffer |
| `controller/src/config.js` | `config.ollama.url` / `config.ollama.model` |
| `controller/src/server.js` | calls `matchRequest()`, consumes the parsed fields |
| `controller/src/llm/sdk.js` | the *other* LLM path — Vercel AI SDK, used by `skills/` only, **not** by intent parsing |
| `controller/package.json` | declares `ai` / `ollama-ai-provider-v2` / `zod` (skills) — none used by `matchRequest` |
