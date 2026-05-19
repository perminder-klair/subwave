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

// Hide the cursor so it doesn't strobe over the UI. Ink renders inline (no
// alt screen) — putting the TUI in an alt screen scrambled the layout in
// testing, so we live with inline rendering and instead minimise redraws by
// removing the per-second elapsed tick (see useStationFeed / NowPlaying).
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

let restored = false;
function restoreCursor() {
  if (restored) return;
  restored = true;
  process.stdout.write(SHOW_CURSOR);
}

process.stdout.write(HIDE_CURSOR);
process.on('exit', restoreCursor);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreCursor(); process.exit(0); });
}

const ink = render(<App config={config} />);
ink.waitUntilExit().finally(restoreCursor);
