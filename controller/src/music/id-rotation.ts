// Orchestration for a Navidrome ID rotation (PR #5824): the sync-time adoption
// step that replaces a bare pruneMissingTracks() at every walk call site, plus
// the manifest handoff to the controller process.
//
// Two processes are involved. The WALK runs in the tagger/analyzer child —
// that's where adoption and prune happen — but the id-keyed state files
// (blocklist, likes, playlist recipes, show playlist pins) are owned by the
// CONTROLLER, which holds in-memory caches of all of them; a child-side disk
// rewrite would be clobbered by the controller's next flush. So the child
// persists the confirmed old→new map to `state/id-rotation.json` and the
// controller applies it through each store module's own hook (see
// applyPendingRotation), strictly BEFORE the post-tag playlist sync — which
// would otherwise see every recipe's playlist id as vanished and delete them.

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
import { writeFileAtomic } from '../util/atomic-file.js';

export interface RotationManifest {
  version: 1;
  at: string;
  trackMap: Record<string, string>;
}

export function manifestPath(): string {
  return path.join(config.stateDir, 'id-rotation.json');
}

async function readManifest(): Promise<RotationManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(), 'utf8')) as RotationManifest;
    return parsed && typeof parsed.trackMap === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// The drop-in replacement for `db.pruneMissingTracks(liveIds)` at the three
// walk call sites (tag-library run, reconcile-only, analyze walk). Adoption
// first, so the prune only ever sees genuinely deleted rows; on a server that
// never rotated its ids the adoption matches nothing and this is byte-for-byte
// the old prune. All fs work is awaited here — reconcileOnly() process.exit()s
// right after its await, so nothing may be left in flight.
export async function adoptAndPrune(
  liveIds: ReadonlySet<string>,
): Promise<{ adopted: number; pruned: number }> {
  const { adopted, map } = db.adoptRotatedIds(liveIds);

  if (adopted > 0) {
    // Stem dirs are keyed by track id on disk; move them with the row so the
    // blend path keeps its cache hits. Renames sit OUTSIDE the DB transaction
    // (already committed) — a failed rename is just a cache miss the LRU sweep
    // eventually reclaims, never an inconsistency.
    let renamed = 0;
    for (const [old, neu] of map) {
      try {
        const from = stemCache.dirFor(old);
        const to = stemCache.dirFor(neu);
        if (existsSync(from) && !existsSync(to)) {
          await rename(from, to);
          renamed++;
        }
      } catch { /* cache miss at worst */ }
    }

    // Merge over an unapplied manifest from an earlier walk (controller down
    // in between): its old ids are gone from the DB but may still sit in the
    // state files, so the controller must see both maps.
    const prior = (await readManifest())?.trackMap ?? {};
    const manifest: RotationManifest = {
      version: 1,
      at: new Date().toISOString(),
      trackMap: { ...prior, ...Object.fromEntries(map) },
    };
    await writeFileAtomic(manifestPath(), JSON.stringify(manifest, null, 2));
    console.log(
      `[id-rotation] adopted ${adopted} rotated Navidrome id(s) — tags/analysis/vectors carried over, ` +
        `${renamed} stem dir(s) renamed; state-file migration handed to the controller`,
    );
  }

  const pruned = db.pruneMissingTracks(liveIds);
  return { adopted, pruned };
}

// Controller-side: apply a manifest the tagger child left behind, rewriting
// every id-keyed state file through its own store module so file and in-memory
// cache stay consistent. Called from the tagger exit handler (strictly BEFORE
// syncAllAfterTag — an unmigrated recipe would read as a vanished playlist and
// be deleted) and once at boot (covers a host-side --reconcile-only run while
// the controller was down). No manifest → immediate no-op, the every-normal-run
// path. On failure the manifest stays for the next attempt and the error
// propagates so the caller can suppress the playlist sync.
export async function applyPendingRotation(): Promise<{ applied: boolean }> {
  const manifest = await readManifest();
  if (!manifest) return { applied: false };
  const trackMap = new Map(Object.entries(manifest.trackMap));

  // Playlist ids never ride the manifest — the walk only proves SONG ids — so
  // they go through the shape transform, checked against the live playlist
  // index when Navidrome is reachable: a still-live id is kept, a dead id is
  // replaced only when its canonical image is actually live. Unreachable →
  // apply the transform unconditionally; it is shape-gated and idempotent, and
  // a wrong guess degrades exactly like today's stale-playlist handling
  // (anchor ignored + logged, recipe pruned as vanished).
  let livePlaylists: Set<string> | null = null;
  try {
    livePlaylists = new Set(
      ((await subsonic.getPlaylists()) as Array<{ id: string }>).map((p) => String(p.id)),
    );
  } catch {
    livePlaylists = null;
  }
  const mapPlaylistId = (id: string): string => {
    if (livePlaylists?.has(id)) return id;
    const c = canonicalId(id);
    if (c === id) return id;
    if (livePlaylists && !livePlaylists.has(c)) return id;
    return c;
  };

  const blocked = await blocklist.remapIds(trackMap, canonicalId);
  const liked = await likes.remapTrackIds(trackMap);
  const recipes = playlistRecipes.remapIds(trackMap, mapPlaylistId);
  const shows = await remapShowPlaylistIds(mapPlaylistId);

  await rm(manifestPath(), { force: true });
  console.log(
    `[id-rotation] state files migrated (${trackMap.size} track id(s)): ` +
      `${blocked} blocklist, ${liked} like(s), ${recipes} recipe field(s), ${shows} show pin(s)`,
  );
  return { applied: true };
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
  const next = shows.map((s) => ({
    ...s,
    playlistIds: (s.playlistIds ?? []).map(mapOne),
    excludedPlaylistIds: (s.excludedPlaylistIds ?? []).map(mapOne),
  }));
  if (changed) await settings.update({ shows: next });
  return changed;
}
