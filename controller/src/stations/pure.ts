// Pure helpers for multi-station profiles — no fs, no config import (config.ts
// depends on stations/resolve.ts, which depends on this file; keep it leaf-level).
// Spec: docs/superpowers/specs/2026-07-24-multi-station-profiles-design.md

// Station id = directory name under state/stations/. Also the containment
// guard's first line of defence (no dots, no slashes, no uppercase).
export const STATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

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

export function slugifyStationName(name: string): string {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
  return STATION_ID_RE.test(slug) ? slug : 'station';
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
// install-level entries stay at the root (spec §2).
const INSTALL_LEVEL = new Set([
  'stations', 'icecast-secrets.env', 'hf-cache', 'analyze-tmp', 'lost+found',
]);

export function conversionAction(entry: string): 'move' | 'keep' {
  return INSTALL_LEVEL.has(entry) ? 'keep' : 'move';
}
