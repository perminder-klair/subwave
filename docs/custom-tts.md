# Bring your own TTS server

SUB/WAVE can speak through **any HTTP server you run**, the same way the LLM
side can point at any OpenAI-compatible endpoint. It's a first-class engine
called **Remote** — not a workaround, not an impersonation of one of the bundled
engines.

> Running a station already? The same material with screenshots lives in the
> in-app manual at **/manual/voices → Remote**. This page is the repo-side copy,
> plus the operational detail (fallback behaviour, timeouts, what Remote
> deliberately doesn't do) for someone deciding whether to build the adapter.

Reach for it when:

- local TTS is pegging the box the station runs on (heavy engines rendering on
  the same CPU as Liquidsoap is how you get a distorted broadcast),
- the cloud engines are too expensive for a station that talks a lot,
- you need a **language or a voice** none of the bundled engines cover,
- or you already run a TTS server (Qwen3-TTS, F5-TTS, CosyVoice, XTTS, Piper as
  a service, a homegrown one) and want the DJ to use it.

The audio comes back **in the HTTP response body**, so — unlike the `tts-heavy`
sidecar, which hands back a path on the shared volume — the server can live on
any host the controller can reach: another box on the LAN, a GPU machine, a
Tailscale peer. No shared filesystem.

---

## Turn it on

**Admin → Settings → Voices → Default engine → Remote**, then fill in
**Server URL**.

```
http://192.168.1.101:5001
```

Use the host's LAN or Tailscale address — `127.0.0.1` is the *controller
container's* loopback, not your machine's. The URL is a station setting (it
lives in `state/settings.json`), not an env var, so it applies live with no
restart and no rebuild.

Remote is selectable **per persona** as well, like every other engine, so one DJ
can speak through your server while the rest stay on Piper.

---

## The contract

Two endpoints. That's the whole thing.

### `GET /health`

```json
{ "ok": true }
```

Probed every 30s (and immediately when you change the URL). `ok: true` is what
makes the engine *available*; anything else — non-200, unparseable body,
timeout, connection refused — marks it unavailable and the dispatcher routes
around it. There is no engine-name check: the endpoint is a generic bridge and
decides for itself what it supports.

### `POST /speak`

Request:

```json
{ "text": "Coming up next, something loud.", "voice": "alba" }
```

Response: **200 with the rendered audio as the body** (WAV, `Content-Type:
audio/*`). Not JSON, not a path — the bytes. The controller writes them into its
own voice directory where Liquidsoap can read them.

`voice` is whatever *your* server means by a voice — a built-in id, a reference
clip filename, a style prompt. SUB/WAVE passes the persona's configured voice
string through untouched and never validates it against a list, precisely
because that vocabulary is yours. An empty string means "use your default".
The request always has exactly these two fields: speech rate is never sent to
your server.

Optional response headers make a silent voice substitution visible in the
station log (issue #238) — set them if your server ever renders something other
than what was asked for:

| Header | Meaning |
|---|---|
| `X-TTS-Fell-Back` | present ⇒ the requested voice was not used |
| `X-TTS-Voice-Used` | what was rendered instead |
| `X-TTS-Fell-Back-Reason` | why |

An empty response body is treated as a failure rather than aired, so a broken
render can't hand Liquidsoap a zero-byte file (a silent segment with no error).

### A minimal server

```python
# pip install fastapi uvicorn
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI()

class SpeakRequest(BaseModel):
    text: str
    voice: str = ""

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/speak")
def speak(req: SpeakRequest):
    wav_bytes = your_tts_engine(req.text, voice=req.voice or "default")
    return Response(content=wav_bytes, media_type="audio/wav")
```

Run it on the GPU box, point the station at it, done. Nothing about the DJ
changes — this only swaps where the voice is rendered.

---

## How it behaves when your server is down

Remote participates in the **rescue chain** like any other engine
(`audio/tts-fallback.ts`): if it's unreachable at dispatch time, or fails
mid-render, the station falls through to your configured fallback voice, then
`defaultEngine` → `piper` → `kokoro`. **The DJ never goes silent because your
box is rebooting.** The Voices settings panel shows a warning while the endpoint
is unreachable, and a rescue is recorded as `fellBack` in admin → Stats — worth
checking there first if a persona ever sounds like the wrong voice.

Timeout is 180s per render, which is generous on purpose: a cold model load on
the far side shouldn't lose the segment.

---

## Speech rate

Remote supports the same engine and persona speed controls as Piper, Kokoro and
Cloud. For persona-voiced speech on air, SUB/WAVE composes the Remote engine
rate with the persona's delivery rate and the current daypart or show's energy,
then applies that effective rate locally with ffmpeg's pitch-preserving
`atempo` filter. Global voice kinds such as jingles use the engine rate alone.

Admin previews stay deterministic: the station preview auditions the engine
rate by itself, while a persona preview composes the saved engine and persona
rates. Neither preview adds the current daypart/show factor, which can change by
the time a segment airs. Preview and live audio otherwise use the same local
processing path.

This means an upgrade can make pacing audible even when both saved sliders still
show `1.00×`: automatic daypart rates normally range around unity, and an active
show's selected energy can also supply a non-unity delivery rate. Remote speed
values that were stored but previously ignored also begin taking effect. There
is no settings migration or new server capability to enable.

A final effective rate of exactly `1.00×` bypasses ffmpeg and writes the response
bytes unchanged. For any other valid rate, local processing is best-effort: if
ffmpeg is missing or the conversion fails, SUB/WAVE logs a warning and uses the
server's original audio at 1× rather than changing to a fallback voice. The
`POST /speak` body remains exactly `{ "text", "voice" }`; rate is never sent
upstream.

## What Remote doesn't do

- **Voice previews by name** — the preview button works, but auditions your
  server's *default* voice: the panel can't enumerate a vocabulary it doesn't
  own.
- **Paralinguistic tags** — `[laugh]` / `[sigh]` are only injected into the
  system prompt when the on-air engine is Chatterbox, so the DJ won't emit them
  for your server. If yours supports its own tag vocabulary, teach it to the DJ
  through **station house rules** (admin → Personas → System prompt) — that
  block is appended to both prompt paths.

---

## Gemini TTS, ElevenLabs, OpenAI

Two different doors, so pick by shape:

- Speaks the **OpenAI speech API** (`POST /v1/audio/speech`)? Use the **Cloud**
  engine with the `OpenAI-compatible` provider and a base URL — no bridge
  needed. That's also the easy route for a self-hosted Chatterbox server; see
  [docs/gpu-tts.md](gpu-tts.md).
- Speaks something else — **Gemini's TTS API**, a vendor SDK, an in-house
  format? Put ~20 lines in front of it in the shape above. The Remote contract
  exists so that adapter is the only thing you write, and it stays yours to
  update when the vendor's API moves.

---

## See also

- [docs/gpu-tts.md](gpu-tts.md) — running Chatterbox on an NVIDIA GPU, either
  via the OpenAI layer or by GPU-enabling the bundled sidecar.
- [docs/tts-heavy.md](tts-heavy.md) — the bundled heavy voices (Chatterbox,
  PocketTTS) and the acoustic analyzer, including running analysis on another
  machine.
