# Pause-and-talk breaks

By default the DJ talks *over* the music: a spoken segment (weather, news, a
curiosity, a web-search result, one of your own skills) ducks the current song
down and speaks on top of it. That's right for a quick aside, but a long
segment talked over a song buries both.

Pause-and-talk (issue #551) gives long segments a real gap. When it's on, a
spoken segment longer than a threshold **pauses the music**: the current song
plays to its natural end, the DJ says their piece in the clear, then the next
track starts (ramping in briefly under the sign-off, classic-radio style).
Short segments still duck over the music exactly as before.

## Turning it on

It's **per show, off by default**.

- **Enable it per show:** admin → **Shows** → pick a show → **Pause-and-talk
  breaks** toggle. Applies live; no restart.
- **Set the length cut-off** (shared by every show): admin → **Settings → DJ →
  Pause-and-talk threshold**. Default **20 seconds**, range 5–90. A segment
  whose rendered voice clip runs at least this long gets a gap; anything
  shorter ducks. Applies live; no restart.

There's no global "everywhere" switch yet — enable it on the shows where the
longer breaks make sense (a morning news show, a talk-heavy programme) and
leave it off elsewhere.

## What gets a gap

Only **skill segments** are eligible: the built-in features (weather, news,
traffic, curiosity, album-anniversary, library-deep-cut, web-search) and any
operator skills you've added under `state/skills/`. Track intros/links, station
IDs, the hourly time check, banter, programme beats, and listener-request
intros always duck — they're short, wall-clock-pinned, or part of a moment
where a gap would feel wrong (a talk break is never wedged in front of a
listener request).

The decision is made from the segment's **actual measured length** after it's
voiced — not a guess from the word count — so it doesn't matter which TTS
engine or persona is speaking.

## Cloud TTS voices always duck

The gap works by padding silence into the voice clip so the music fades cleanly
around it. That padding only works on the local engines' WAV output. The
**cloud** engine (OpenAI / ElevenLabs) returns MP3, which can't be padded the
same way, so a cloud-voiced segment **always ducks**, even on a pause-and-talk
show and even when it's long. The controller logs this when it happens. If you
want pause-and-talk breaks, run a local voice (Piper, Kokoro, Chatterbox,
PocketTTS) for those segments.

## What you'll see and hear

Across a break: the song fades out on its own ending, then clean DJ speech with
no music under it, then the next song ramps in under the final words. No jingle
will land between the break and the song it leads into.

During the break the web player keeps showing the **previous** song (the break
itself is not a "track" — it never enters now-playing, history, or your
scrobbles), the same way an instrumental bed behaves today. A dedicated "DJ
break" now-playing state is a possible future addition.

## Limits (v1)

- Per-show only, no global toggle.
- A simple length threshold decides gap vs duck — the DJ doesn't choose per
  segment yet.
- Cloud (MP3) voices always duck (above).
- Only skill segments are eligible; links, banter, programmes, hourly checks,
  and station IDs always duck.
