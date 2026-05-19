# SUB/WAVE — terminal player

A terminal listener for the SUB/WAVE radio station. It's the listener side of
the web player (`web/app/listen`) rendered in a TUI: now-playing, the
timeline, the live booth feed, and track requests. No admin, no settings.

It targets the same public controller API and the same Icecast stream as the
web player, so it needs **no controller changes**.

## Prerequisites

- Node.js ≥ 18
- For audio: [`mpv`](https://mpv.io) (preferred — supports live volume control)
  or `ffplay` (from FFmpeg). With neither installed the TUI still runs as a
  read-only dashboard.

## Install & run

```bash
cd tui
npm install
npm start                 # or: node bin/subwave-tui.js
```

Defaults point at the dev stack (controller on `:7701`, Icecast on `:7702`).

```bash
# Production — one origin behind Caddy:
node bin/subwave-tui.js --api https://your.host/api --stream https://your.host/stream.mp3

# Or via environment:
SUBWAVE_API_URL=https://your.host/api \
SUBWAVE_STREAM_URL=https://your.host/stream.mp3 \
  node bin/subwave-tui.js
```

## Keys

| Key       | Action                |
|-----------|-----------------------|
| `space`   | tune in / out         |
| `↑` / `↓` | volume (mpv only)     |
| `m`       | mute / unmute         |
| `1`       | timeline panel        |
| `2`       | booth feed panel      |
| `3` / `r` | request panel         |
| `?`       | shortcuts             |
| `q`       | quit                  |

In the request panel, `Enter` advances fields and sends; `Esc` closes it.

## Notes

- Audio is played by an external `mpv`/`ffplay` child process pointed at the
  Icecast stream. Volume can only be changed live under `mpv`.
- No waveform or cover art — a child-process player exposes no PCM, and
  terminal image protocols are inconsistent. A progress bar stands in.
- The JSX modules under `src/` are transformed at import time by the `tsx`
  loader, so there is no build step.
