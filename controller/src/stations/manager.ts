// Station-profile management: list/create/duplicate/rename/delete/activate and
// the one-time legacy-root conversion. All functions take the state ROOT
// explicitly — no config.js import (cycle-free, tmp-root testable). Routes
// pass config.stateRoot. Spec §5/§6.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve as pathResolve, sep } from 'node:path';
import {
  MAX_STATIONS, STATION_ID_RE, conversionAction, duplicateAction,
  parseActivePointer, slugifyStationName,
} from './pure.js';

// Thrown by createStation() when the failure happens AFTER the legacy-root
// conversion already completed. Conversion is durable the moment it returns
// (the pointer + stations/main are on disk) — a caller that only sees a 400
// and never restarts would keep writing to the now-stale root forever, and a
// retry would see converted:false and never trigger the restart either. The
// route checks `.converted` to schedule the switch-exit regardless of the
// create failure.
export class StationCreateError extends Error {
  readonly converted: boolean;
  constructor(message: string, converted: boolean) {
    super(message);
    this.name = 'StationCreateError';
    this.converted = converted;
  }
}

export interface StationInfo {
  id: string | null;          // null = unconverted single-station root
  name: string;
  configured: boolean;        // has setup-config.json, OR env creds cover the install
  createdAt: string | null;
  active: boolean;
}

const stationsDir = (root: string) => join(root, 'stations');

// Slug-validate AND containment-check — both, always (defence in depth).
function stationPath(root: string, id: string): string {
  if (!STATION_ID_RE.test(id)) throw new Error(`invalid station id: ${id}`);
  const dir = pathResolve(stationsDir(root), id);
  if (!dir.startsWith(pathResolve(stationsDir(root)) + sep)) {
    throw new Error('station path escapes the stations dir');
  }
  return dir;
}

export function isMultiStation(root: string): boolean {
  return existsSync(stationsDir(root));
}

export function activeIdOnDisk(root: string): string | null {
  try {
    return parseActivePointer(readFileSync(join(stationsDir(root), 'active.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readCard(dir: string): { name?: string; createdAt?: string } {
  try {
    return JSON.parse(readFileSync(join(dir, 'station.json'), 'utf8'));
  } catch {
    return {};
  }
}

// envConfigured: env-supplied Navidrome creds apply to EVERY station (env wins
// at each boot regardless of the active dir), and env-driven installs never
// write setup-config.json — without this flag they'd all read "needs setup".
// Threaded in from the route (setup/firstRun.envHasNavidrome) so this module
// stays fs-only and cycle-free.
export function listStations(
  root: string,
  fallbackName: string,
  envConfigured = false,
): StationInfo[] {
  if (!isMultiStation(root)) {
    return [{
      id: null,
      name: fallbackName,
      configured: envConfigured || existsSync(join(root, 'setup-config.json')),
      createdAt: null,
      active: true,
    }];
  }
  const active = activeIdOnDisk(root);
  return readdirSync(stationsDir(root), { withFileTypes: true })
    .filter((e) => e.isDirectory() && STATION_ID_RE.test(e.name))
    .map((e) => {
      const dir = join(stationsDir(root), e.name);
      const card = readCard(dir);
      return {
        id: e.name,
        name: typeof card.name === 'string' && card.name ? card.name : e.name,
        configured: envConfigured || existsSync(join(dir, 'setup-config.json')),
        createdAt: card.createdAt || null,
        active: e.name === active,
      };
    })
    .sort((a, b) => (a.name).localeCompare(b.name));
}

function writeActivePointer(root: string, id: string): void {
  stationPath(root, id);
  const file = join(stationsDir(root), 'active.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ activeId: id }));
  renameSync(tmp, file); // atomic on the same fs — a reader never sees a torn file
}

function writeCard(dir: string, name: string): void {
  writeFileSync(
    join(dir, 'station.json'),
    JSON.stringify({ name, createdAt: new Date().toISOString() }, null, 2),
  );
}

export function convertToMultiStation(
  root: string,
  currentName: string,
  renameFn: (src: string, dest: string) => void = renameSync,
): string {
  if (isMultiStation(root)) throw new Error('already multi-station');
  const id = 'main';
  const dest = stationPath(root, id);
  mkdirSync(dest, { recursive: true });
  // fs.rename per entry — same filesystem, so this is fast and never copies.
  // The just-created stations/ dir classifies as 'keep' and skips itself.
  const moved: string[] = [];
  try {
    for (const entry of readdirSync(root)) {
      if (conversionAction(entry) === 'keep') continue;
      renameFn(join(root, entry), join(dest, entry));
      moved.push(entry);
    }
  } catch (err) {
    // Best-effort move-back: restore whatever already relocated before the
    // failure. Track whether any move-back itself fails; if so, leave dest in
    // place (entries stay recoverable under stations/main) — spec §6.
    let moveBackFailed = false;
    for (const entry of moved) {
      try {
        renameFn(join(dest, entry), join(root, entry));
      } catch {
        // swallow — an individual move-back failure shouldn't block the rest,
        // but it marks the whole rollback as incomplete
        moveBackFailed = true;
      }
    }
    if (!moveBackFailed) {
      rmSync(dest, { recursive: true, force: true });
      try {
        if (readdirSync(stationsDir(root)).length === 0) {
          rmSync(stationsDir(root), { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
    }
    const stateMsg = moveBackFailed
      ? '— some entries could not be moved back; recover them from stations/main'
      : '— state root restored';
    throw new Error(`conversion failed (${(err as Error).message}) ${stateMsg}`);
  }
  writeCard(dest, currentName);
  writeActivePointer(root, id);
  return id;
}

function uniqueStationId(root: string, name: string): string {
  const base = slugifyStationName(name);
  let id = base;
  for (let n = 2; existsSync(join(stationsDir(root), id)); n++) {
    id = `${base.slice(0, 38)}-${n}`;
  }
  return id;
}

export async function createStation(root: string, opts: {
  name: string;
  mode: 'fresh' | 'duplicate';
  currentName: string;
  backupLibraryDb?: (dest: string) => Promise<void>;
}): Promise<{ id: string; converted: boolean }> {
  const name = String(opts.name || '').trim().slice(0, 80);
  if (!name) throw new Error('station name required');
  let converted = false;
  if (!isMultiStation(root)) {
    convertToMultiStation(root, opts.currentName);
    converted = true;
  }
  // Cap check counts real station dirs, post-conversion (a fresh conversion
  // yields exactly one, so `converted` can never coincide with a full rack —
  // the flag is carried anyway so the route's restart guarantee holds).
  const count = readdirSync(stationsDir(root), { withFileTypes: true })
    .filter(e => e.isDirectory() && STATION_ID_RE.test(e.name)).length;
  if (count >= MAX_STATIONS) {
    throw new StationCreateError(`this install is capped at ${MAX_STATIONS} stations`, converted);
  }
  const sourceId = activeIdOnDisk(root);
  // A duplicate with nothing to duplicate FROM (multi-station dir present but
  // the pointer corrupt/missing) must refuse loudly, not silently degrade to
  // a fresh station.
  if (opts.mode === 'duplicate' && !sourceId) {
    throw new StationCreateError('no active station to duplicate from', converted);
  }
  const id = uniqueStationId(root, name);
  const dest = stationPath(root, id);
  // Everything from here is wrapped: if it throws, the new-station dir is
  // best-effort removed, but a completed conversion above must never be
  // silently lost — it's re-attached on the error so the route still fires
  // the restart even though this create() failed (spec: Important 1).
  let destCreated = false;
  try {
    // stations/ is guaranteed to exist by now (either pre-existing or just
    // created by convertToMultiStation above) — a plain mkdirSync (no
    // recursive) means a create race on the same id throws EEXIST instead of
    // silently merging into an existing directory.
    mkdirSync(dest);
    destCreated = true;
    writeCard(dest, name);
    if (opts.mode === 'duplicate' && sourceId) {
      const src = join(stationsDir(root), sourceId);
      for (const entry of readdirSync(src)) {
        const action = duplicateAction(entry);
        if (action === 'copy') {
          // Async cp — voices/ and jingles/ can run to hundreds of MB, and a
          // sync copy would block the event loop (and /now-playing) for the
          // whole duplicate.
          await cp(join(src, entry), join(dest, entry), { recursive: true });
        } else if (action === 'backup') {
          if (opts.backupLibraryDb) {
            await opts.backupLibraryDb(join(dest, entry));
          } else {
            console.warn('[stations] duplicate: no backupLibraryDb callback — library.db not copied');
          }
        }
      }
    }
    return { id, converted };
  } catch (err) {
    if (destCreated) {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        // best-effort — a stuck partial dir is recoverable by hand, and
        // masking the real error behind a cleanup failure helps no one
      }
    }
    throw new StationCreateError((err as Error).message, converted);
  }
}

export function renameStation(root: string, id: string, name: string): void {
  const dir = stationPath(root, id);
  if (!existsSync(dir)) throw new Error('no such station');
  const card = readCard(dir);
  writeFileSync(
    join(dir, 'station.json'),
    JSON.stringify(
      { ...card, name: String(name || '').trim().slice(0, 80) || id },
      null, 2,
    ),
  );
}

export function deleteStation(root: string, id: string): void {
  const dir = stationPath(root, id);
  if (id === activeIdOnDisk(root)) throw new Error('cannot delete the live station');
  if (!existsSync(dir)) throw new Error('no such station');
  rmSync(dir, { recursive: true, force: true });
}

// Stale file-based IPC in the TARGET station dir — left over from whenever
// this station was last live (or never cleaned up) — must not be replayed
// the moment Liquidsoap starts polling it again after the switch. The
// *-playing snapshots come along too: a days-old now-playing.json would be
// served as the current track until the first on_meta fires after the
// switch. Each is swallowed independently: a missing file is the common
// case, not an error.
const STALE_IPC_FILES = [
  'next.txt', 'say.txt', 'intro.txt', 'sfx.txt',
  'now-playing.json', 'jingle-playing.json', 'bed-playing.json',
];

function drainStaleIpc(dir: string): void {
  for (const file of STALE_IPC_FILES) {
    try {
      unlinkSync(join(dir, file));
    } catch {
      // best-effort — absent is the normal case, and a locked/permission
      // failure here shouldn't block the switch itself
    }
  }
}

export function activateStation(root: string, id: string): void {
  const dir = stationPath(root, id);
  if (!existsSync(dir)) throw new Error('no such station');
  if (id === activeIdOnDisk(root)) throw new Error('station is already live');
  drainStaleIpc(dir);
  writeActivePointer(root, id);
}
