// Pure helpers for multi-station profiles — no fs, no config import (config.ts
// depends on stations/resolve.ts, which depends on this file; keep it leaf-level).
//
// STATION_ID_RE, MAX_STATIONS and slugifyStationName live in schemas/station.ts
// so the admin form validates against them directly; they are re-exported here
// because this is the import path every caller already uses, and that module
// imports only zod, so the leaf-level rule above holds.
import { STATION_ID_RE } from '../schemas/station.js';

export {
  MAX_STATIONS,
  STATION_ID_RE,
  slugifyStationName,
} from '../schemas/station.js';

// stations/active.json is controller-written as {"activeId":"<id>"} but parsed
// defensively — a hand-edited or truncated file must never crash a boot path.
export function parseActivePointer(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const id = parsed?.activeId;
    if (typeof id === 'string' && STATION_ID_RE.test(id)) return id;
  } catch {}
  return null;
}

// Duplicate = new station inherits identity/config, starts fresh history.
// Allowlist (default 'skip') so a future state file must be classified
// deliberately before it rides along into a duplicate.
const DUPLICATE_COPY = new Set([
  'settings.json', 'secrets.env',
  'schedule.json', 'jingles.m3u', 'jingles.json', 'beds.json', 'bed.mp3',
  'voices', 'persona-avatars', 'jingles', 'beds', 'skills', 'sfx',
  'icecast_listener_auth.txt', 'themes', 'sfx.json',
]);

export function duplicateAction(entry: string): 'copy' | 'skip' {
  if (entry === 'show-preparations.json') return 'skip'; // new station, fresh episode choices
  if (DUPLICATE_COPY.has(entry)) return 'copy';
  // Derived-from-settings.json files: copying keeps the pair consistent
  // (skipping them would leave a drift window until the first settings save).
  if (/^liquidsoap_.*\.txt$/.test(entry)) return 'copy';
  return 'skip';
}

// Conversion moves the legacy root's contents into stations/main/. Only
// install-level entries stay at the root (spec §2). `router` is the music
// router's whole state (#692): its credentials, installed plugins and plugin
// data. The router container mounts exactly STATE_ROOT/router, so moving it
// would strand the plugins and make the controller mint new credentials.
const INSTALL_LEVEL = new Set([
  'stations', 'icecast-secrets.env', 'hf-cache', 'analyze-tmp', 'lost+found', 'router',
]);

export function conversionAction(entry: string): 'move' | 'keep' {
  if (entry === 'show-preparations.json') return 'move';
  return INSTALL_LEVEL.has(entry) ? 'keep' : 'move';
}
