'use client';

// The Gemini Extended Voice Library read, owned by TanStack Query per
// `web/CLAUDE.md` ("cacheable admin reads … use those helpers plus a
// feature-owned key factory"). An `audit-admin-query.mjs` run rejects a raw
// `adminResponse` read in `components/admin`, so this is enforced, not stylistic.
//
// It is a CACHEABLE read — the same filter set is asked for by every persona
// card on the Personas page, and the catalogue is identical for all of them.
// As a per-component `useCallback` each card issued its own request; here one
// request serves every card that asks for the same filters, and a filter set
// revisited after navigating away is served from cache.
//
// The preview audio stays IMPERATIVE on purpose: `admin-query.ts` classifies
// one-shot previews as commands, and an `Audio` element has no cacheable
// payload.

import { useInfiniteQuery, type QueryClient, type QueryFilters } from '@tanstack/react-query';
import { adminJson, type AdminFetch } from '@/lib/admin-query';

export interface LibraryVoice {
  id: string;
  label: string;
  language?: string;
  accent?: string;
  gender?: string;
  pitch?: string;
  persona?: string;
  description?: string;
}

export interface LibraryFacets {
  languages: string[];
  accents: string[];
  genders: string[];
  pitches: string[];
  contexts: string[];
  ready: boolean;
}

/** The NORMALISED filters a page was requested with. Keys describe the server
 *  resource and its inputs only — never `adminFetch` identity. */
export interface LibraryInput {
  /** A BCP-47 tag, `any` for every language, or OMITTED to defer to the station's
   *  saved `tts.gemini.libraryLanguage`.
   *
   *  Three distinct states, and conflating any two produces a wrong request
   *  rather than a missing one:
   *
   *    omitted — "whatever the station is configured to browse". Sent as an
   *              ABSENT `language`, which the route reads as the saved default.
   *    'any'   — the operator explicitly asked for every language. MUST be sent
   *              explicitly, because absent means the saved default, so a control
   *              labelled "Every language" would silently return one region.
   *    'en-AU' — an explicit filter.
   *
   *  UI sentinels never reach this type. A `__any__`-style placeholder is a Radix
   *  Select requirement, not a server value, and letting one through put
   *  `language=__any__` on the wire, which the route forwarded upstream as a
   *  literal language code — an empty library that reads as "no voices" rather
   *  than as a bug. `normalizeLibraryInput` is the boundary that translates them,
   *  and it is tested directly for that reason. */
  language?: string;
  gender?: string;
  pitch?: string;
  accent?: string;
  search?: string;
  pageSize?: number;
}

export interface LibraryPage {
  ok: boolean;
  voices: LibraryVoice[];
  facets?: LibraryFacets;
  nextPageToken?: string;
  error?: string;
}

export const geminiLibraryKeys = {
  all: ['gemini-voice-library'] as const,
  catalogue: (input: LibraryInput) => ['gemini-voice-library', input] as const,
};

/** A saved default changes the effective filter of every omitted-language read.
 * Clear its pages and cursors together, including inactive queries, and cancel
 * old requests before a mounted browser starts again at page one. Explicit
 * language filters, including `any`, do not depend on that setting. */
export async function resetGeminiLibraryDefaults(client: QueryClient): Promise<void> {
  const filters: QueryFilters = {
    queryKey: geminiLibraryKeys.all,
    predicate: query => !(query.queryKey[1] as LibraryInput | undefined)?.language,
  };
  await client.cancelQueries(filters);
  await client.resetQueries(filters);
}

/** Drop unset filters so two controls holding the same effective choices share
 *  ONE cache entry. Without this, `gender: undefined` and an absent `gender`
 *  would key differently and defeat the de-duplication entirely. */
export function normalizeLibraryInput(input: LibraryInput): LibraryInput {
  // A UI placeholder is not a language. `__any__` is truthy, so treating it as a
  // value kept it, and `?language=__any__` reached Google as
  // `language_code=__any__` — a filter matching nothing.
  const PLACEHOLDERS = new Set(['', '__any__', '__station_default__']);
  const lang = (input.language ?? '').trim();
  return {
    // An absent language is meaningful — it defers to the station's saved
    // default — so it is omitted from the key rather than defaulted to 'any'.
    ...(lang && !PLACEHOLDERS.has(lang) ? { language: lang } : {}),
    ...(input.gender?.trim() ? { gender: input.gender.trim() } : {}),
    ...(input.pitch?.trim() ? { pitch: input.pitch.trim() } : {}),
    ...(input.accent?.trim() ? { accent: input.accent.trim() } : {}),
    ...(input.search?.trim() ? { search: input.search.trim() } : {}),
    ...(input.pageSize ? { pageSize: input.pageSize } : {}),
  };
}

/** Normalise the envelope INSIDE the queryFn, never via `select` — a `select`
 *  transforms what an observer sees while `setQueriesData` writes the RAW cached
 *  value, so an unwrapped shape here would leave cache writers mismatched. */
export async function fetchLibraryPage(
  adminFetch: AdminFetch,
  input: LibraryInput,
  token: string | undefined,
  signal: AbortSignal,
): Promise<LibraryPage> {
  const q = new URLSearchParams({ provider: 'gemini' });
  for (const [k, v] of Object.entries(input)) {
    if (k === 'pageSize') { q.set('pageSize', String(v)); continue; }
    if (v) q.set(k, String(v));
  }
  if (token) q.set('pageToken', token);
  const body = await adminJson<LibraryPage>(
    adminFetch, `/settings/tts/voices?${q}`, undefined, signal,
  );
  // The controller reports upstream failures inside an HTTP-200 envelope.
  // Reject it so an infinite query keeps its successful pages and next cursor
  // instead of appending an empty, apparently final page.
  if (!body.ok) throw new Error(body.error || 'Voice library unavailable');
  return {
    ok: body.ok,
    voices: Array.isArray(body.voices) ? body.voices : [],
    facets: body.facets,
    nextPageToken: body.nextPageToken,
    error: body.error,
  };
}

/** Pagination rides `useInfiniteQuery`, so the cursor and the filter set that
 *  produced it are one cache entry by construction — the "Load more combined an
 *  old page_token with new filters" failure cannot be expressed, let alone
 *  happen. */
export function useGeminiLibraryQuery(
  adminFetch: AdminFetch,
  rawInput: LibraryInput,
  enabled: boolean,
) {
  const input = normalizeLibraryInput(rawInput);
  return useInfiniteQuery({
    queryKey: geminiLibraryKeys.catalogue(input),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetchLibraryPage(adminFetch, input, pageParam, signal),
    getNextPageParam: (last) => last.nextPageToken,
    // Far above the provider's 30s default. Google retires and adds voices at a
    // crawl, and every card on the Personas page asks for the same catalogue —
    // a short window turns one walk into a re-fetch per card per navigation.
    // Restarting the controller rebuilds the index anyway, so the data is never
    // stale for long in the only sense that matters.
    staleTime: 5 * 60_000,
  });
}

/** Flatten pages and fold the catalogue vocabulary across them. Facets arrive
 *  on every page and are identical; taking the first is enough. */
export function flattenLibraryPages(pages: LibraryPage[] | undefined) {
  const voices: LibraryVoice[] = [];
  let facets: LibraryFacets | undefined;
  for (const p of pages ?? []) {
    voices.push(...p.voices);
    if (!facets && p.facets?.ready) facets = p.facets;
  }
  return { voices, facets };
}
