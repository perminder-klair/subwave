// Carrying a station's library across a music-source switch (#692).
//
// Every track id changes when the station moves to another backend (direct
// Navidrome → the router, Jellyfin → Plex, a new server URL). Ids key about
// fifteen stores, and library.db's tags, analysis and embeddings are the
// expensive ones. Saving a new selection writes a marker
// (setup/music-source.ts markSourceSwitch); the next complete library walk
// then adopts orphaned rows by METADATA as well as by Navidrome's canonical-id
// rule, through the same adoption path (library-db/id-adoption.ts) whose
// journal id-rotation.ts replays over likes, the blocklist, recipes, show pins
// and stem dirs.
//
// The match is deliberately strict — the same normalised artist, title and
// album, and a duration within DURATION_TOLERANCE_SEC when both are known —
// and one-to-one: an orphan with two equally good candidates is left alone.
// A wrong match would hang one track's moods and analysis on another, which is
// worse than re-tagging it; an unmatched row simply ages out through the
// existing prune (and its mass-removal guard).

import { readFileSync, rmSync } from 'node:fs';
import { SOURCE_SWITCH_PATH } from '../setup/music-source.js';

export const DURATION_TOLERANCE_SEC = 2;

export interface TrackIdentityRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration_sec: number | null;
}

export interface SourceSwitchMarker {
  at: string;
  from: string;
  to: string;
}

export function pendingSourceSwitch(): SourceSwitchMarker | null {
  try {
    const raw = JSON.parse(readFileSync(SOURCE_SWITCH_PATH, 'utf8'));
    return typeof raw?.at === 'string' ? { at: raw.at, from: String(raw.from ?? ''), to: String(raw.to ?? '') } : null;
  } catch {
    return null;
  }
}

/**
 * Whether the switch was recorded after `sinceMs` — the moment a process
 * resolved which library it talks to, or a maintenance run started. A walk
 * whose connection predates the marker walked the OLD library, so it must
 * neither match by metadata nor spend the marker. An unknown moment (null)
 * keeps the original behaviour.
 */
export function switchedAfter(marker: SourceSwitchMarker, sinceMs: number | null): boolean {
  return sinceMs !== null && Date.parse(marker.at) > sinceMs;
}

/**
 * What the controller does with a still-pending marker when a maintenance
 * run exits. A run that started before the switch could not carry it across,
 * so a reconcile walk follows — unless the operator stopped the run, which
 * is not the moment to start another one. A run that started after the
 * switch had its chance; retrying it here could loop.
 */
export function afterMaintenanceRun(
  marker: SourceSwitchMarker | null,
  run: { startedAt: string; outcome: 'ok' | 'failed' | 'stopped' },
): 'reconcile' | 'stopped' | null {
  if (!marker || !switchedAfter(marker, Date.parse(run.startedAt))) return null;
  return run.outcome === 'stopped' ? 'stopped' : 'reconcile';
}

export function clearSourceSwitch(): void {
  rmSync(SOURCE_SWITCH_PATH, { force: true });
}

// Case, accents, punctuation and spacing differ between backends reading the
// same tags (Jellyfin's "Sigur Rós", Plex's "Sigur Ros"); none of them makes a
// different recording.
export function identityText(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // An apostrophe joins a word ("don't" = "dont"); other punctuation splits.
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function identityKey(r: TrackIdentityRow): string | null {
  const title = identityText(r.title);
  const artist = identityText(r.artist);
  if (!title || !artist) return null;
  return `${artist}\u0000${title}\u0000${identityText(r.album)}`;
}

function durationOk(a: number | null, b: number | null): boolean {
  if (!a || !b) return true;
  return Math.abs(a - b) <= DURATION_TOLERANCE_SEC;
}

/**
 * Pair each orphan (a row the walk no longer saw) with the one live row that
 * is the same recording. `claimed` holds live ids already taken by an earlier
 * rule; it is extended with every target this returns.
 */
export function matchByMetadata(
  orphans: readonly TrackIdentityRow[],
  live: readonly TrackIdentityRow[],
  claimed: Set<string>,
): Array<[string, string]> {
  const byKey = new Map<string, TrackIdentityRow[]>();
  for (const row of live) {
    if (claimed.has(row.id)) continue;
    const key = identityKey(row);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  const pairs: Array<[string, string]> = [];
  for (const orphan of orphans) {
    const key = identityKey(orphan);
    if (!key) continue;
    const candidates = (byKey.get(key) ?? []).filter((c) => !claimed.has(c.id) && durationOk(orphan.duration_sec, c.duration_sec));
    if (candidates.length === 0) continue;
    let pick = candidates[0]!;
    if (candidates.length > 1) {
      // Two live copies of the same song: take the clearly closest duration,
      // or leave the orphan alone rather than guess.
      const dist = (c: TrackIdentityRow) => (orphan.duration_sec && c.duration_sec ? Math.abs(orphan.duration_sec - c.duration_sec) : Infinity);
      const sorted = [...candidates].sort((a, b) => dist(a) - dist(b));
      if (dist(sorted[0]!) === Infinity || dist(sorted[0]!) === dist(sorted[1]!)) continue;
      pick = sorted[0]!;
    }
    claimed.add(pick.id);
    pairs.push([orphan.id, pick.id]);
  }
  return pairs;
}

export interface BlockedTrack {
  id: string;
  name: string | null;
  artist: string | null;
  album: string | null;
}

/**
 * Track blocks a switch left with nothing to hold on to: no live track has
 * their id (after this walk re-linked it), and none matches them by artist,
 * title and album. If the song IS on the new source under other metadata, it
 * now plays — the blocklist is absolute, so the operator has to be told.
 * `nameKeyOf` is the blocklist's own track key, injected so this stays pure.
 */
export function strandedTrackBlocks(
  blocks: readonly BlockedTrack[],
  live: readonly { id: string; title: string | null; artist: string | null; album: string | null }[],
  moved: ReadonlyMap<string, string>,
  nameKeyOf: (title: unknown, artist: unknown, album: unknown) => string | null,
): BlockedTrack[] {
  const liveIds = new Set(live.map((r) => r.id));
  const liveKeys = new Set(live.map((r) => nameKeyOf(r.title, r.artist, r.album)).filter((k): k is string => k !== null));
  return blocks.filter((b) => {
    if (liveIds.has(moved.get(b.id) ?? b.id)) return false;
    const key = nameKeyOf(b.name, b.artist, b.album);
    return !(key && liveKeys.has(key));
  });
}
