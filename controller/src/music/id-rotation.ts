// The walk adopts track rows and journals their old→new IDs transactionally.
// The controller replays that journal through the owners of cached state files,
// acknowledging it only after every write succeeds. Older JSON handoffs remain
// readable so an interrupted run from the first implementation can recover.

import { existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as db from './library-db.js';
import * as stemCache from './stem-cache.js';
import * as subsonic from './subsonic.js';
import * as blocklist from './blocklist.js';
import * as playlistRecipes from './playlist-recipes.js';
import * as likes from '../broadcast/likes.js';
import * as settings from '../settings.js';
import { canonicalId } from './id-canonical.js';
import { reportRotation } from './tagger-progress.js';

export interface RotationManifest {
  version: 1;
  at: string;
  trackMap: Record<string, string>;
}

export function manifestPath(): string {
  return path.join(config.stateDir, 'id-rotation.json');
}

async function readManifest(): Promise<RotationManifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as RotationManifest;
  if (parsed?.version !== 1 || !parsed.trackMap || typeof parsed.trackMap !== 'object' ||
      Array.isArray(parsed.trackMap) || Object.values(parsed.trackMap).some((v) => typeof v !== 'string')) {
    throw new Error('Invalid ID-rotation manifest; leaving it for recovery');
  }
  return parsed;
}

async function moveStemDirs(map: ReadonlyMap<string, string>): Promise<void> {
  for (const [old, neu] of map) {
    try {
      const from = stemCache.dirFor(old);
      const to = stemCache.dirFor(neu);
      if (existsSync(from) && !existsSync(to)) await rename(from, to);
    } catch { /* best-effort cache: a miss can be recomputed */ }
  }
}

// A complete walk calls this before pruning. No filesystem write is needed to
// make recovery possible: adoptRotatedIds commits its journal with the rows.
export async function adoptAndPrune(
  liveIds: ReadonlySet<string>,
): Promise<{ adopted: number; pruned: number }> {
  const { adopted } = db.adoptRotatedIds(liveIds);
  const pending = db.pendingIdRotations();
  if (pending.size) {
    await moveStemDirs(pending);
    // Also emitted when retrying a walk that already committed its adoption.
    // A stopped child may have missed the previous notification entirely.
    reportRotation({ adopted });
  }
  const pruned = db.pruneMissingTracks(liveIds);
  return { adopted, pruned };
}

export interface RotationApplyResult {
  /** Any state file was rewritten. */
  applied: boolean;
  /** Nothing is left to retry — the recovery map has been acknowledged. `false` means
   *  the track half landed but the playlist half is deferred, so the recovery map
   *  is still durable and the caller must NOT run the playlist sync. */
  complete: boolean;
}

// Serialize boot, sentinel and exit callers through one owner. A rejection
// must not poison subsequent retries.
let applying: Promise<RotationApplyResult> = Promise.resolve({ applied: false, complete: true });
export function applyPendingRotation(): Promise<RotationApplyResult> {
  const next = applying.then(applyRotation, applyRotation);
  applying = next;
  return next;
}

async function applyRotation(): Promise<RotationApplyResult> {
  const manifest = await readManifest();
  const trackMap = new Map([
    ...Object.entries(manifest?.trackMap ?? {}),
    ...db.pendingIdRotations(),
  ]);
  if (!manifest && !trackMap.size) return { applied: false, complete: true };
  await moveStemDirs(trackMap);

  // The journal proves song IDs only. Confirm playlist transforms against the
  // live index; on an outage apply track IDs but keep the map and hold sync.
  // Boot before Navidrome is ready is a normal reason to defer this half.
  let livePlaylists: Set<string> | null = null;
  try {
    livePlaylists = new Set(
      ((await subsonic.getPlaylists()) as Array<{ id: string }>).map((p) => String(p.id)),
    );
  } catch (err: any) {
    console.warn(
      `[id-rotation] playlist index unreachable (${err?.message || err}) — migrating track ids only; ` +
        'playlist pins/recipes stay for the next attempt',
    );
  }
  const mapPlaylistId = (id: string): string => {
    if (!livePlaylists) return id;
    if (livePlaylists.has(id)) return id;
    const c = canonicalId(id);
    if (c === id || !livePlaylists.has(c)) return id;
    return c;
  };

  const blocked = await blocklist.remapIds(trackMap, canonicalId, mapPlaylistId);
  const liked = await likes.remapTrackIds(trackMap);
  const recipes = playlistRecipes.remapIds(trackMap, mapPlaylistId);
  const shows = await remapShowPlaylistIds(mapPlaylistId);

  let complete = livePlaylists !== null;
  if (complete) {
    if (manifest) await rm(manifestPath(), { force: true });
    db.acknowledgeIdRotations(trackMap);
    complete = db.pendingIdRotations().size === 0;
  }
  console.log(
    `[id-rotation] state files migrated (${trackMap.size} track id(s)): ` +
      `${blocked} blocklist, ${liked} like(s), ${recipes} recipe field(s), ${shows} show pin(s)` +
      (complete ? '' : ' — recovery still pending'),
  );
  return { applied: true, complete };
}

// Show playlist anchors/exclusions, moved through the real settings write path
// so validation, normalisation and the schedule.json persist all run unchanged.
async function remapShowPlaylistIds(mapPlaylistId: (id: string) => string): Promise<number> {
  const shows = (settings.get().shows ?? []) as Array<{
    playlistIds?: string[];
    excludedPlaylistIds?: string[];
  }>;
  if (!shows.length) return 0;
  let changed = 0;
  const mapOne = (id: string): string => {
    const next = mapPlaylistId(id);
    if (next !== id) changed++;
    return next;
  };
  // Spread, then overwrite only the keys the show actually had: normalising an
  // absent playlistIds into [] would push a change through settings.update for
  // every show on the schedule, on a write that is meant to touch pins alone.
  const next = shows.map((s) => {
    const out: Record<string, unknown> = { ...s };
    if (s.playlistIds) out.playlistIds = s.playlistIds.map(mapOne);
    if (s.excludedPlaylistIds) out.excludedPlaylistIds = s.excludedPlaylistIds.map(mapOne);
    return out;
  });
  // settings.update changes its cache before persisting schedule.json too.
  // Flush on replay even if the earlier failed attempt already moved the pins.
  await settings.update({ shows: next });
  return changed;
}
