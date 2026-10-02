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
  'settings.json', 'setup-config.json', 'secrets.env', 'moods.json',
  'schedule.json', 'jingles.m3u', 'jingles.json', 'beds.json', 'bed.mp3',
  'voices', 'persona-avatars', 'jingles', 'beds', 'skills', 'sfx',
  'icecast_listener_auth.txt', 'themes', 'sfx.json', 'playlist-recipes.json',
]);

export function duplicateAction(entry: string): 'copy' | 'backup' | 'skip' {
  if (entry === 'library.db') return 'backup'; // live WAL handle → .backup() snapshot
  if (DUPLICATE_COPY.has(entry)) return 'copy';
  // Derived-from-settings.json files: copying keeps the pair consistent
  // (skipping them would leave a drift window until the first settings save).
  if (/^liquidsoap_.*\.txt$/.test(entry)) return 'copy';
  return 'skip';
}

// Conversion moves the legacy root's contents into stations/main/. Only
// install-level entries stay at the root (spec §2). `hls` and `edge` are the
// HLS output and the edge's playlist log: the edge serves and writes one fixed
// root-level path whichever station is on air, and the compose stack
// bind-mounts both into the edge container, so moving them would detach it.
const INSTALL_LEVEL = new Set([
  'stations', 'icecast-secrets.env', 'hf-cache', 'analyze-tmp', 'lost+found',
  'hls', 'edge',
]);

export function conversionAction(entry: string): 'move' | 'keep' {
  return INSTALL_LEVEL.has(entry) ? 'keep' : 'move';
}
