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
    cache = {
      version: 1,
      recipes: Array.isArray(parsed?.recipes) ? parsed.recipes.filter((r: any) => r && typeof r.playlistId === 'string') : [],
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

export function has(playlistId: string): boolean {
  return read().recipes.some((r) => r.playlistId === playlistId);
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

export function remove(playlistId: string): void {
  const store = read();
  const next = store.recipes.filter((r) => r.playlistId !== playlistId);
  if (next.length !== store.recipes.length) persist({ ...store, recipes: next });
}
