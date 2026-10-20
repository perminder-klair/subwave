// Disposable state for the operator tools that call a model from a clone
// (`npm run llm-bench`, `npm run leanings:replay`).
//
// config.ts resolves STATE_DIR once, at import, and with none set that is the
// repo-local state/: on a host running the station, the live state root.
// Importing src/ there was enough to write into it. events.ts and piper.ts
// create logs/ and voice/, and telemetry/log.ts and subsonic-log.ts rename an
// oversized picks.log or subsonic.log to .old at module load, replacing the
// station's own .old. Every model call then appended to the station's events
// log, where the log-analysis skill and the daily token budget's restart seed
// read it back as the station's own traffic, and with raw capture on it
// overwrote the station's llm-debug.log.
//
// So a tool calls isolateStationState() first, and only then imports src/, and
// dynamically, because static imports are hoisted above any code in the module
// body. This module imports nothing that reaches config.ts: stations/resolve.ts
// is leaf-level by design.

import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveActiveStationDir } from '../../src/stations/resolve.js';

// What makes a model call resolve exactly as it does on the station.
// settings.json and schedule.json are the two files settings.load() reads, so
// together they reproduce settings.get(): the llm block with its inline keys,
// the personas, the mood vocabulary, and the show and host that pickSystem()
// resolves for a moment in time. secrets.env holds the cloud keys
// loadSecretsIntoEnv() reads. Nothing else is copied. The tools' fixtures fake
// the library, so library.db in particular stays behind, and setup-config.json
// is only the Navidrome connection.
export const STATION_KEY_FILES = ['settings.json', 'schedule.json', 'secrets.env'] as const;

// config.ts's own fallback, resolved from this file's place in the tree.
const REPO_STATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../state');

// Copy STATION_KEY_FILES from the source root's ACTIVE station (the root
// itself on a single-station install) into `dest`. Every copy is 0600, since
// settings.json and secrets.env both carry credentials. A file that is absent
// or unreadable is skipped, as settings.load() and loadSecretsIntoEnv() skip
// it, so the tool runs as the station would boot; unreadable is also warned
// about. Returns the names copied.
export function copyStationKeys(sourceRoot: string, dest: string): string[] {
  const sourceDir = resolveActiveStationDir(sourceRoot);
  const copied: string[] = [];
  for (const name of STATION_KEY_FILES) {
    const from = join(sourceDir, name);
    if (!existsSync(from)) continue;
    try {
      copyFileSync(from, join(dest, name));
      chmodSync(join(dest, name), 0o600);
      copied.push(name);
    } catch (error) {
      console.warn(`Could not copy ${from} (${(error as NodeJS.ErrnoException).code ?? error}); continuing without it.`);
    }
  }
  return copied;
}

// Make a temp state root seeded from the station's keys and point STATE_DIR at
// it. An operator's STATE_DIR names the SOURCE root, as config.ts would read
// it. The dir is removed when the process exits: on success, on a thrown error
// and on Ctrl-C.
export function isolateStationState(prefix: string): { sourceRoot: string; dir: string } {
  const sourceRoot = process.env.STATE_DIR || REPO_STATE_ROOT;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  // A signal's default action ends the process without an 'exit' event, which
  // would leave the dir behind. This listener turns the signal into
  // process.exit(). A tool that installs its own (llm-bench flushes its report
  // first) owns the exit instead, and its process.exit() reaches 'exit' too.
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      if (process.listenerCount(signal) === 0) process.exit(code);
    });
  }
  copyStationKeys(sourceRoot, dir);
  process.env.STATE_DIR = dir;
  return { sourceRoot, dir };
}
