// Append-only sync for recipe-backed playlists. Re-resolves a saved recipe and
// appends library songs that are (a) new since the last sync and (b) still match
// the recipe — reusing the builder's own candidate-pool engine, no LLM call.
// See docs/superpowers/specs/2026-07-15-playlist-recipe-sync-design.md.

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import { buildCandidatePool, type GenerateInput } from './playlist-gen.js';
import { selectAppendable } from './playlist-gen-pure.js';
import * as recipes from './playlist-recipes.js';
import type { PlaylistRecipeEntry } from './playlist-recipes.js';

export interface SyncOutcome { added: number; prunedMissing?: boolean }

// Sync one recipe: append new-since-last-sync, still-matching tracks. Never
// removes anything. Returns prunedMissing when the Navidrome playlist is gone.
export async function syncRecipe(entry: PlaylistRecipeEntry): Promise<SyncOutcome> {
  // Current members — the exclude set + the "already there" guard.
  let members: string[];
  try {
    const entries = await subsonic.getPlaylist(entry.playlistId);
    members = (entries || []).map((e: any) => e.id).filter(Boolean);
  } catch {
    return { added: 0, prunedMissing: true };
  }

  // Re-resolve the recipe's pool (knobs as hard filters + vibe/mood/genre
  // sources), excluding what's already in the playlist.
  const input: GenerateInput = { ...entry.recipe, excludeTrackIds: members };
  const { pool } = await buildCandidatePool(input);

  // Annotate each candidate with its library add-date so "new since last sync"
  // can act; Subsonic-only rows read null and never qualify.
  await library.load();
  for (const t of pool) t.addedAt = library.taggedAtOf(t.id);

  // First sync uses the entry's createdAt as the cutoff, so an initial sync only
  // pulls music added AFTER the playlist was made.
  const sinceIso = entry.lastSyncedAt ?? entry.createdAt;
  const requireVibe = Boolean(entry.recipe.prompt && entry.recipe.prompt.trim());

  const additions = selectAppendable(pool, {
    sinceIso,
    requireVibe,
    cap: entry.perSyncCap,
    excludeIds: new Set(members),
  });

  if (additions.length) {
    await subsonic.addToPlaylist(entry.playlistId, additions.map((t) => t.id));
  }
  recipes.recordSync(entry.playlistId, additions.length);
  return { added: additions.length };
}

// Sync every recipe-backed playlist. Per-recipe try/catch (one bad recipe never
// sinks the batch); prunes entries whose playlist has vanished.
export async function syncAll(): Promise<{ synced: number; added: number }> {
  let synced = 0;
  let added = 0;
  for (const entry of recipes.list()) {
    try {
      const r = await syncRecipe(entry);
      if (r.prunedMissing) { recipes.remove(entry.playlistId); continue; }
      synced += 1;
      added += r.added;
    } catch (err: any) {
      console.warn(`[playlist-sync] "${entry.name}" (${entry.playlistId}) failed: ${err?.message || err}`);
    }
  }
  return { synced, added };
}

// Fire-and-forget entry point for the tagger's completion hook. No-op when no
// recipes exist so an ordinary tagging run pays nothing.
export async function syncAllAfterTag(): Promise<void> {
  if (recipes.count() === 0) return;
  try {
    const { synced, added } = await syncAll();
    console.log(`[playlist-sync] post-tag sync: ${synced} playlist(s), ${added} track(s) added`);
  } catch (err: any) {
    console.warn(`[playlist-sync] post-tag sync failed: ${err?.message || err}`);
  }
}
