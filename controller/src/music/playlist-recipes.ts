// Persistent store of "recipes" behind sync-enabled playlists. A saved playlist
// stays a plain Navidrome playlist (the track store); this side-file remembers
// the vibe/seed/knob recipe that built it, so the sync engine can re-resolve it
// and append newly-matching library songs. See
//
// Small, single-purpose: load / persist (atomic) + get / list / upsert / remove.
// A missing file is an empty store; a corrupt file degrades to empty (never
// throws into a caller — a bad side-file must not break playlist saves).

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import { normalizeRecipeRow } from '../schemas/playlist.js';
import type { Knobs, Sources } from './playlist-gen.js';

export interface StoredRecipe {
  prompt?: string;
  seedTrackIds?: string[];
  seedArtist?: string;
  knobs: Knobs;
  sources: Sources;
}

export interface PlaylistRecipeEntry {
  playlistId: string;
  name: string;
  recipe: StoredRecipe;
  perSyncCap: number;
  createdAt: string;            // ISO
  lastSyncedAt: string | null;  // ISO; null until the first sync
  lastResult: { added: number; at: string } | null;
}

interface RecipeStore {
  version: 1;
  recipes: PlaylistRecipeEntry[];
}

const FILE = `${config.stateDir}/playlist-recipes.json`;

let cache: RecipeStore | null = null;

function empty(): RecipeStore {
  return { version: 1, recipes: [] };
}

function read(): RecipeStore {
  if (cache) return cache;
  try {
    if (!existsSync(FILE)) { cache = empty(); return cache; }
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    // Rows repair through the shared schema's normalizeRecipeRow rather than a
    // bare playlistId check: the old filter kept any row carrying a string
    // playlistId and NOTHING else, so a hand-edited entry missing its `recipe`
    // reached syncRecipe and threw on `entry.recipe.prompt` — POST
    // /playlists/:id/sync answered 500 where a repaired row syncs fine.
    cache = {
      version: 1,
      recipes: Array.isArray(parsed?.recipes)
        ? parsed.recipes
            .map((r: unknown) => normalizeRecipeRow(r))
            .filter((r: ReturnType<typeof normalizeRecipeRow>): r is NonNullable<typeof r> => r != null)
            .map((r: NonNullable<ReturnType<typeof normalizeRecipeRow>>) => r as PlaylistRecipeEntry)
        : [],
    };
  } catch (err: any) {
    console.warn(`[playlist-recipes] could not read store, starting empty: ${err?.message || err}`);
    cache = empty();
  }
  return cache;
}

function persist(store: RecipeStore): void {
  cache = store;
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, FILE);
}

export function list(): PlaylistRecipeEntry[] {
  return read().recipes;
}

export function get(playlistId: string): PlaylistRecipeEntry | undefined {
  return read().recipes.find((r) => r.playlistId === playlistId);
}

export function count(): number {
  return read().recipes.length;
}

// Insert or replace the entry for a playlist. Preserves lastSyncedAt/lastResult
// across a re-save of the same playlist so an overwrite doesn't reset the clock.
export function upsert(input: {
  playlistId: string;
  name: string;
  recipe: StoredRecipe;
  perSyncCap?: number;
}): PlaylistRecipeEntry {
  const store = read();
  const now = new Date().toISOString();
  const existing = store.recipes.find((r) => r.playlistId === input.playlistId);
  const entry: PlaylistRecipeEntry = {
    playlistId: input.playlistId,
    name: input.name,
    recipe: input.recipe,
    perSyncCap: input.perSyncCap ?? existing?.perSyncCap ?? 25,
    createdAt: existing?.createdAt ?? now,
    lastSyncedAt: existing?.lastSyncedAt ?? null,
    lastResult: existing?.lastResult ?? null,
  };
  store.recipes = [...store.recipes.filter((r) => r.playlistId !== input.playlistId), entry];
  persist(store);
  return entry;
}

// Persist a sync result onto an entry (called by the sync engine).
export function recordSync(playlistId: string, added: number): void {
  const store = read();
  const entry = store.recipes.find((r) => r.playlistId === playlistId);
  if (!entry) return;
  const now = new Date().toISOString();
  entry.lastSyncedAt = now;
  entry.lastResult = { added, at: now };
  persist(store);
}

// Rewrite ids after a Navidrome ID rotation (music/id-rotation.ts). Runs
// through this module (not a raw file rewrite) so the forever-cache and the
// file stay consistent. Playlist keys go through the caller's playlist mapper;
// seed track ids move via the adoption-confirmed map only — an unmapped seed
// stays put, the pool builder already tolerates dead seeds.
export function remapIds(
  trackMap: ReadonlyMap<string, string>,
  mapPlaylistId: (id: string) => string,
): number {
  const store = read();
  let changed = 0;
  for (const entry of store.recipes) {
    const nextId = mapPlaylistId(entry.playlistId);
    if (nextId !== entry.playlistId) {
      entry.playlistId = nextId;
      changed++;
    }
    const seeds = entry.recipe?.seedTrackIds;
    if (Array.isArray(seeds)) {
      for (let i = 0; i < seeds.length; i++) {
        const next = trackMap.get(seeds[i]);
        if (next && next !== seeds[i]) {
          seeds[i] = next;
          changed++;
        }
      }
    }
  }
  if (changed) persist(store);
  return changed;
}

export function remove(playlistId: string): void {
  const store = read();
  const next = store.recipes.filter((r) => r.playlistId !== playlistId);
  if (next.length !== store.recipes.length) persist({ ...store, recipes: next });
}
