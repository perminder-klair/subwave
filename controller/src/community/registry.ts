// Realtime community catalog — the single fetch seam for the community
// skills / personas / shows / stations catalog.
//
// The catalog is a JSON index published by the `community` repo (CI-built
// from per-entry markdown/JSON — see that repo's scripts/build-catalog.mjs). It
// SUPERSEDES the image-baked controller/src/skills/community + personas/community
// dirs: a station fetches the live index, so a newly-merged persona/skill/show
// appears without a controller upgrade.
//
// Live-fetch only (the operator's explicit choice): the index is fetched once and
// memoised on a TTL, degrading to whatever we last held — and to an EMPTY catalog
// when we've never reached the host (fresh boot offline). There is NO bundled
// snapshot to keep in sync. Any failure (unreachable host, non-200, bad JSON,
// timeout) is swallowed: the accessors never throw, so the admin Community
// browser is simply empty/stale and the station keeps broadcasting.
//
// The entry shapes mirror the previous fs readers verbatim (CommunitySkill /
// CommunityPersona), so skills/loader.ts + personas/community.ts just delegate
// here and every route + admin-UI consumer is unchanged. CommunityShow is new.

import { config } from '../config.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { queue } from '../broadcast/queue.js';
import {
  FREQUENCIES,
  SCRIPT_LENGTHS,
  SHOW_MOODS,
  SHOW_ENERGY,
  SOUL_MAX,
  type EraWindow,
} from '../settings.js';

// Slug rule shared by every community artifact — lowercase, starts alphanumeric,
// then alphanumeric/hyphen, ≤49 chars. Anchored, so a slug can't carry a path
// separator. Duplicated (not imported from skills/loader.ts) to keep this module
// free of an import cycle with the loader that delegates to it.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

// ---- Entry shapes (mirror the previous fs readers) -------------------------

export interface CommunitySkill {
  slug: string;
  label: string;
  brief: string;
  cooldown?: string;
  window?: 'any' | 'commute';
  context?: string;
  submittedBy?: string;
  dateAdded?: string;
  dateModified?: string;
}

export interface CommunityPersona {
  slug: string;
  displayName: string;
  tagline?: string;
  soul: string;
  frequency: 'silent' | 'quiet' | 'moderate' | 'chatty' | 'aggressive';
  scriptLength: 'one-liner' | 'concise' | 'extended' | 'storyteller';
  djMode: boolean;
  humour?: number;
  localColour?: number;
  warmth?: number;
  language?: string;
  submittedBy?: string;
  dateAdded?: string;
  dateModified?: string;
}

// A shareable show carries the portable substance only: a brief + music-steering
// filters + mode flags. Everything install-specific (personaId/guests, themeId,
// playlist ids, schedule-grid placement) is re-bound locally by the install route
// (routes/shows.ts) — see that route + settings.validateShowsStrict.
export interface CommunityShow {
  slug: string;
  name: string;
  topic: string;
  moods: string[];
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  filtersStrict: boolean;
  banter: boolean;
  programme: boolean;
  segmentSkill: string;
  maxTrackSeconds: number | null;
  submittedBy?: string;
  dateAdded?: string;
  dateModified?: string;
}

// Stations are the public directory (a map of listeners' stations) — pass-through
// JSON, shape-owned by web/lib/stations.ts. We keep them loose here.
export type CommunityStation = Record<string, unknown> & { slug?: string };

interface Catalog {
  skills: CommunitySkill[];
  personas: CommunityPersona[];
  shows: CommunityShow[];
  stations: CommunityStation[];
}

const EMPTY: Catalog = { skills: [], personas: [], shows: [], stations: [] };

export interface CatalogStatus {
  url: string;
  ok: boolean;               // did the most recent fetch attempt succeed?
  fetchedAt: number | null;  // Date.now() of the last SUCCESSFUL fetch
  generatedAt: string | null; // the index's own build timestamp, if present
  error: string | null;      // last error message, or null
  counts: { skills: number; personas: number; shows: number; stations: number };
}

// ---- Cache -----------------------------------------------------------------

interface Cached {
  data: Catalog;
  fetchedAt: number;         // last SUCCESSFUL fetch (Date.now())
  generatedAt: string | null;
}
let cached: Cached | null = null;
let lastOk = false;
let lastError: string | null = null;
let inflight: Promise<Catalog> | null = null;

function catalogUrl(): string {
  return config.community.catalogUrl;
}
function ttlMs(): number {
  return config.community.ttlMs;
}

// ---- Normalisation (defensive — a bad index entry is dropped, never thrown) --

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function optStr(v: unknown, max: number): string | undefined {
  const s = str(v);
  return s ? s.slice(0, max) : undefined;
}
function dial(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : undefined;
}
function strList(v: unknown, max: number, maxLen = 64): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s.slice(0, maxLen));
    if (out.length >= max) break;
  }
  return out;
}

function normalizeSkill(raw: any): CommunitySkill | null {
  const slug = str(raw?.slug);
  if (!SLUG_RE.test(slug)) return null;
  const brief = str(raw?.brief);
  if (!brief) return null;
  return {
    slug,
    label: str(raw?.label) || slug,
    brief,
    cooldown: optStr(raw?.cooldown, 16),
    window: raw?.window === 'commute' ? 'commute' : undefined,
    context: optStr(raw?.context, 200),
    submittedBy: optStr(raw?.submittedBy, 80),
    dateAdded: optStr(raw?.dateAdded, 10),
    dateModified: optStr(raw?.dateModified, 10),
  };
}

function normalizePersona(raw: any): CommunityPersona | null {
  const slug = str(raw?.slug);
  if (!SLUG_RE.test(slug)) return null;
  // Must track SOUL_MAX: an over-cap soul would fail validatePersonasStrict at
  // install time, so a catalog entry the operator can't actually install is
  // dropped from the listing rather than offered and then rejected with a 400.
  const soul = str(raw?.soul);
  if (!soul || soul.length > SOUL_MAX) return null;
  return {
    slug,
    displayName: (str(raw?.displayName) || slug).slice(0, 40),
    tagline: optStr(raw?.tagline, 80),
    soul,
    frequency: (FREQUENCIES as string[]).includes(raw?.frequency) ? raw.frequency : 'moderate',
    scriptLength: (SCRIPT_LENGTHS as string[]).includes(raw?.scriptLength) ? raw.scriptLength : 'concise',
    djMode: raw?.djMode === true,
    humour: dial(raw?.humour),
    localColour: dial(raw?.localColour),
    warmth: dial(raw?.warmth),
    language: optStr(raw?.language, 60),
    submittedBy: optStr(raw?.submittedBy, 80),
    dateAdded: optStr(raw?.dateAdded, 10),
    dateModified: optStr(raw?.dateModified, 10),
  };
}

function normalizeEras(v: unknown): EraWindow[] {
  if (!Array.isArray(v)) return [];
  const out: EraWindow[] = [];
  for (const w of v) {
    if (!w || typeof w !== 'object') continue;
    const r = w as { fromYear?: unknown; toYear?: unknown };
    const from = Number.isInteger(r.fromYear) ? (r.fromYear as number) : null;
    const to = Number.isInteger(r.toYear) ? (r.toYear as number) : null;
    if (from == null && to == null) continue;
    if (from != null && to != null && from > to) continue;
    out.push({ fromYear: from, toYear: to });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeShow(raw: any): CommunityShow | null {
  const slug = str(raw?.slug);
  if (!SLUG_RE.test(slug)) return null;
  const name = (str(raw?.name) || str(raw?.displayName)).slice(0, 60);
  if (!name) return null;
  const seconds = Number(raw?.maxTrackSeconds);
  return {
    slug,
    name,
    topic: str(raw?.topic).slice(0, 1000),
    moods: strList(raw?.moods, 6).filter(m => (SHOW_MOODS as string[]).includes(m)),
    genres: strList(raw?.genres, 6),
    eras: normalizeEras(raw?.eras),
    energies: strList(raw?.energies, 6).filter(e => (SHOW_ENERGY as string[]).includes(e)),
    filtersStrict: raw?.filtersStrict === true,
    banter: raw?.banter === true,
    programme: raw?.programme === true,
    segmentSkill: str(raw?.segmentSkill).slice(0, 64),
    maxTrackSeconds: Number.isInteger(seconds) && seconds >= 0 ? seconds : null,
    submittedBy: optStr(raw?.submittedBy, 80),
    dateAdded: optStr(raw?.dateAdded, 10),
    dateModified: optStr(raw?.dateModified, 10),
  };
}

function normalizeStation(raw: any): CommunityStation | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as CommunityStation;
}

function normalizeCatalog(raw: any): Catalog {
  const pick = <T>(arr: unknown, fn: (r: any) => T | null): T[] =>
    Array.isArray(arr) ? arr.map(fn).filter((x): x is T => x != null) : [];
  return {
    skills: pick(raw?.skills, normalizeSkill),
    personas: pick(raw?.personas, normalizePersona),
    shows: pick(raw?.shows, normalizeShow),
    stations: pick(raw?.stations, normalizeStation),
  };
}

// ---- Fetch + memo ----------------------------------------------------------

async function fetchCatalog(): Promise<Catalog> {
  const url = catalogUrl();
  const res = await fetchWithTimeout(url, { timeoutMs: 8000, bodyDeadline: true });
  if (!res.ok) throw new Error(`community catalog HTTP ${res.status}`);
  const raw = await res.json();
  const data = normalizeCatalog(raw);
  cached = { data, fetchedAt: Date.now(), generatedAt: str((raw as any)?.generatedAt) || null };
  lastOk = true;
  lastError = null;
  return data;
}

// Return the catalog, refetching when the memo is cold or stale. On any failure
// we fall back to whatever we last held (stale-while-error) and, failing that,
// to an empty catalog — never throwing. Concurrent callers share one in-flight
// fetch so a burst of browse requests hits the origin once.
async function getCatalog(force = false): Promise<Catalog> {
  if (!force && cached && Date.now() - cached.fetchedAt < ttlMs()) return cached.data;
  if (inflight) return inflight;
  inflight = fetchCatalog()
    .catch((err: any) => {
      lastOk = false;
      lastError = err?.message || String(err);
      queue.log('error', `[community] catalog fetch failed (${catalogUrl()}): ${lastError}`);
      return cached?.data ?? EMPTY;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// ---- Public accessors ------------------------------------------------------

export async function communitySkills(): Promise<CommunitySkill[]> {
  return (await getCatalog()).skills;
}
export async function communityPersonas(): Promise<CommunityPersona[]> {
  return (await getCatalog()).personas;
}
export async function communityShows(): Promise<CommunityShow[]> {
  return (await getCatalog()).shows;
}
export async function communityStations(): Promise<CommunityStation[]> {
  return (await getCatalog()).stations;
}

export async function readCommunitySkill(slug: string): Promise<CommunitySkill | null> {
  if (!SLUG_RE.test(slug)) return null;
  return (await communitySkills()).find(s => s.slug === slug) ?? null;
}
export async function readCommunityPersona(slug: string): Promise<CommunityPersona | null> {
  if (!SLUG_RE.test(slug)) return null;
  return (await communityPersonas()).find(p => p.slug === slug) ?? null;
}
export async function readCommunityShow(slug: string): Promise<CommunityShow | null> {
  if (!SLUG_RE.test(slug)) return null;
  return (await communityShows()).find(s => s.slug === slug) ?? null;
}

// Bust the memo and refetch now (backs the admin "refresh catalog" button).
export async function refreshCatalog(): Promise<CatalogStatus> {
  await getCatalog(true);
  return catalogStatus();
}

export function catalogStatus(): CatalogStatus {
  const data = cached?.data ?? EMPTY;
  return {
    url: catalogUrl(),
    ok: lastOk,
    fetchedAt: cached?.fetchedAt ?? null,
    generatedAt: cached?.generatedAt ?? null,
    error: lastError,
    counts: {
      skills: data.skills.length,
      personas: data.personas.length,
      shows: data.shows.length,
      stations: data.stations.length,
    },
  };
}
