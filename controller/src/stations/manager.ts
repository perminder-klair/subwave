// Station-profile management: list/create/duplicate/rename/delete/activate plus
// the one-time legacy-root conversion. Every function takes the state ROOT
// explicitly rather than importing config.js — cycle-free and tmp-root testable.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve as pathResolve, sep } from 'node:path';
import {
  STATION_ID_RE, conversionAction, duplicateAction, parseActivePointer,
} from './pure.js';
import { stationCreateSchema, stationRenameSchema } from '../schemas/station.js';
import { stationCapMessage, uniqueStationId } from '../schemas/station-server.js';
import { firstMessage } from '../util/zod-error.js';

// Thrown by createStation(). `converted` says the legacy-root conversion already
// completed and is durable, so the route must schedule the restart even though
// the create failed — otherwise the process keeps writing to the stale root and
// a retry sees converted:false.
export class StationCreateError extends Error {
  readonly converted: boolean;
  /**
   * Dotted path of the request field at fault, so the route can land the message
   * on that input. Only set for a failure a FIELD caused — a full rack is not
   * one, since nothing typed in the dialog fixes it.
   */
  readonly field?: string;
  constructor(message: string, converted: boolean, field?: string) {
    super(message);
    this.name = 'StationCreateError';
    this.converted = converted;
    this.field = field;
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

// Slug-validate AND containment-check, both, always.
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

// Keep the ON-AIR name (settings.station) in step with the identity card, else a
// fresh station boots as "SUB/WAVE" and a duplicate carries the source's name.
// settings.load() merges over DEFAULTS, so a minimal {station} file is valid.
// For the ACTIVE station this fs write is not enough — the live process has
// settings cached, so the rename route also pushes it through settings.update().
function patchSettingsStation(dir: string, name: string): void {
  const p = join(dir, 'settings.json');
  let s: Record<string, unknown> = {};
  try {
    s = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    // absent or corrupt — seed minimal; load() fills the rest from DEFAULTS
  }
  s.station = name;
  writeFileSync(p, JSON.stringify(s, null, 2));
}

// envConfigured: env-supplied Navidrome creds apply to EVERY station and such
// installs never write setup-config.json, so without the flag they all read
// "needs setup". Threaded in from the route so this module stays fs-only.
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
  // fs.rename per entry: same filesystem, so never a copy. The just-created
  // stations/ dir classifies as 'keep' and skips itself.
  const moved: string[] = [];
  try {
    for (const entry of readdirSync(root)) {
      if (conversionAction(entry) === 'keep') continue;
      renameFn(join(root, entry), join(dest, entry));
      moved.push(entry);
    }
  } catch (err) {
    // Best-effort move-back. If any move-back itself fails, leave dest in place
    // so the entries stay recoverable under stations/main.
    let moveBackFailed = false;
    for (const entry of moved) {
      try {
        renameFn(join(dest, entry), join(root, entry));
      } catch {
        // one failure must not block the rest, but marks the rollback incomplete
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

export async function createStation(root: string, opts: {
  name: string;
  mode?: 'fresh' | 'duplicate';
  currentName: string;
  backupLibraryDb?: (dest: string) => Promise<void>;
}): Promise<{ id: string; converted: boolean }> {
  // The chokepoint, not the route: this runs the same schema the route and the
  // admin form do. Rethrown as a plain Error because a raw ZodError's .message is
  // a multi-line JSON blob and the route answers `{ error: err.message }`.
  const parsed = stationCreateSchema.safeParse({ name: opts.name, mode: opts.mode });
  if (!parsed.success) throw new Error(firstMessage(parsed.error));
  const { name, mode } = parsed.data;

  let converted = false;
  if (!isMultiStation(root)) {
    convertToMultiStation(root, opts.currentName);
    converted = true;
  }
  // Counts real station dirs, post-conversion.
  const entries = readdirSync(stationsDir(root), { withFileTypes: true });
  const count = entries.filter(e => e.isDirectory() && STATION_ID_RE.test(e.name)).length;
  const capped = stationCapMessage(count);
  if (capped) throw new StationCreateError(capped, converted);

  const sourceId = activeIdOnDisk(root);
  // A duplicate with nothing to duplicate FROM must refuse loudly, not degrade
  // to a fresh station. Attributed to `mode`: the way out is to pick Fresh.
  if (mode === 'duplicate' && !sourceId) {
    throw new StationCreateError('no active station to duplicate from', converted, 'mode');
  }
  const id = uniqueStationId(entries.map(e => e.name), name);
  const dest = stationPath(root, id);
  // Wrapped: on a throw the new-station dir is best-effort removed, and a
  // completed conversion is re-attached to the error so the route still restarts.
  let destCreated = false;
  try {
    // Non-recursive on purpose: a create race on the same id throws EEXIST rather
    // than silently merging into an existing directory.
    mkdirSync(dest);
    destCreated = true;
    writeCard(dest, name);
    if (mode === 'duplicate' && sourceId) {
      const src = join(stationsDir(root), sourceId);
      for (const entry of readdirSync(src)) {
        const action = duplicateAction(entry);
        if (action === 'copy') {
          // Async: voices/ and jingles/ can run to hundreds of MB, and a sync
          // copy would block the event loop for the whole duplicate.
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
    // Fresh: seeds settings.json so first boot isn't "SUB/WAVE". Duplicate:
    // overwrites the name copied from the source.
    patchSettingsStation(dest, name);
    return { id, converted };
  } catch (err) {
    if (destCreated) {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        // best-effort — never mask the real error behind a cleanup failure
      }
    }
    throw new StationCreateError((err as Error).message, converted);
  }
}

// Returns the resolved name so the route can mirror it into the live settings
// layer when the renamed station is the active one.
export function renameStation(root: string, id: string, name: string): string {
  const dir = stationPath(root, id);
  if (!existsSync(dir)) throw new Error('no such station');
  // Same chokepoint reasoning as createStation: an empty or over-long name
  // refuses rather than being silently slugged or truncated.
  const check = stationRenameSchema.safeParse({ name });
  if (!check.success) throw new Error(firstMessage(check.error));
  const resolved = check.data.name;
  const card = readCard(dir);
  writeFileSync(
    join(dir, 'station.json'),
    JSON.stringify({ ...card, name: resolved }, null, 2),
  );
  patchSettingsStation(dir, resolved);
  return resolved;
}

export function deleteStation(root: string, id: string): void {
  const dir = stationPath(root, id);
  if (id === activeIdOnDisk(root)) throw new Error('cannot delete the live station');
  if (!existsSync(dir)) throw new Error('no such station');
  rmSync(dir, { recursive: true, force: true });
}

// Stale file-based IPC in the TARGET dir must not be replayed the moment
// Liquidsoap starts polling it after the switch. The *-playing snapshots come
// too: a days-old now-playing.json would be served as the current track until
// the first on_meta fires.
const STALE_IPC_FILES = [
  'next.txt', 'jingle-now.txt', 'say.txt', 'intro.txt', 'sfx.txt',
  'now-playing.json', 'jingle-playing.json', 'bed-playing.json', 'pause-talk-playing.json',
  'music-starved.json',
];

function drainStaleIpc(dir: string): void {
  for (const file of STALE_IPC_FILES) {
    try {
      unlinkSync(join(dir, file));
    } catch {
      // absent is the normal case, and a failure must not block the switch
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
