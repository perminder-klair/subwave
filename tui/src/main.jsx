import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import App from './App.jsx';
import { resolveConfig } from './config.js';

const cli = meow(`
  SUB/WAVE — terminal player

  Usage
    $ subwave-tui [options]

  Options
    --api <url>     Controller API base URL   (env: SUBWAVE_API_URL)
    --stream <url>  Icecast stream URL        (env: SUBWAVE_STREAM_URL)

  Defaults to the dev stack:
    --api     http://localhost:7701
    --stream  http://localhost:7702/stream.mp3

  Production (single origin behind Caddy):
    $ subwave-tui --api https://your.host/api --stream https://your.host/stream.mp3
`, {
  importMeta: import.meta,
  flags: {
    api: { type: 'string' },
    stream: { type: 'string' },
  },
});

const config = resolveConfig(cli.flags);

// Full-screen TUI: ask Ink for the alternate screen buffer and incremental
// rendering. Incremental rendering only repaints lines that changed, which
// is what keeps the animated spectrum from flickering the whole frame on
// every tick. maxFps caps the update rate so a 80 ms animation interval
// doesn't pile up renders. Cursor is hidden via Ink's own machinery (Ink 7
// uses cli-cursor) — no manual ANSI escape juggling needed.
const ink = render(<App config={config} />, {
  alternateScreen: true,
  incrementalRendering: true,
  maxFps: 30,
});

await ink.waitUntilExit();
