// Google's paginated /v1beta/voices catalogue has regional ids and immutable
// traits beyond GEMINI_TTS_VOICES. Select gender and accent by voice, not style text.
// Derive language/accent facets from API results; Google rejects unknown voice ids.

import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { apiKey } from './gemini.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Discovery is a browse, not the audio path: a page of metadata comes back in
// well under a second, and the index (all ids) is ~3 requests. Kept short
// because this sits behind an admin UI that shows a spinner.
const LIST_TIMEOUT_MS = 15_000;

// Google's own cap; the docs say page_size maxes at 1000.
const MAX_PAGE_SIZE = 1000;
// A guard against an upstream that hands back an endless token chain. Sized so a
// real catalogue finishes inside it (2,277 names at 1,000/page is three pages);
// hitting it means the walk is INCOMPLETE, which is handled below rather than
// published as though it were the whole thing.
const MAX_WALK_PAGES = 5;

// A voice value is short. Anything longer is a paste accident, not an id.
const MAX_ID_LEN = 100;

/** One row of the library, shaped for the picker. Google's snake_case is
 *  normalised here so nothing downstream has to remember it. */
export interface LibraryVoice {
  /** The value that goes on the wire — e.g. `en-us-varo`. */
  id: string;
  /** Google's human label — e.g. `Varo`. Also accepted by the engine. */
  name: string;
  language?: string;
  region?: string;
  accent?: string;
  persona?: string;
  context?: string;
  gender?: string;
  pitch?: string;
  description?: string;
}

export interface LibraryFilters {
  /** BCP-47 tag. Omit for every language. */
  language?: string;
  gender?: string;
  pitch?: string;
  accent?: string;
  /** REST spells this one `context` (the SDK calls it `contexts`). */
  context?: string;
  /** Free text over display_name + description. */
  search?: string;
  pageSize?: number;
  pageToken?: string;
  signal?: AbortSignal;
}

export interface LibraryPage {
  ok: boolean;
  voices: LibraryVoice[];
  nextPageToken?: string;
  /** Present when ok is false. */
  message?: string;
  /** The filters Google actually honoured — echoed so the UI can show what it
   *  is looking at rather than what it asked for. */
  applied?: Record<string, string>;
}

const str = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim();
  return s || undefined;
};

function mapVoice(raw: any): LibraryVoice | null {
  // The REST shape carries `id` + `display_name`; some responses also carry a
  // resource `name` of the form `voices/en-us-varo`. Accept all three rather
  // than betting on one — a wrong guess here silently empties the picker.
  const id = str(raw?.id)
    || str(raw?.name)?.replace(/^voices\//i, '');
  if (!id || id.length > MAX_ID_LEN) return null;
  return {
    id,
    name: str(raw?.display_name) || id,
    language: str(raw?.language_code),
    region: str(raw?.region_code),
    accent: str(raw?.accent),
    persona: str(raw?.persona),
    context: str(raw?.context),
    gender: str(raw?.gender),
    pitch: str(raw?.pitch),
    description: str(raw?.description),
  };
}

/** One page of the library. Never throws — an unreachable Google is a normal
 *  answer the picker renders as free text, exactly like cloud-compat. */
export async function listLibraryVoices(f: LibraryFilters = {}): Promise<LibraryPage> {
  const key = apiKey();
  if (!key) return { ok: false, voices: [], message: 'Google Generative AI key not set' };

  const q = new URLSearchParams();
  // `type=prebuilt` scopes to the catalogue. Voice Design (`prompted`) and Voice
  // Replication (`replicated`) are the operator's OWN stored voices and are
  // already handled by the `voice_…` / `voicekey_…` pass-through, so mixing
  // them in here would double-list them under an id this module can't validate.
  q.set('type', 'prebuilt');
  for (const [param, value] of [
    ['language_code', f.language],
    ['gender', f.gender],
    ['pitch', f.pitch],
    ['accent', f.accent],
    ['context', f.context],
    ['search', f.search],
    ['page_token', f.pageToken],
  ] as const) {
    const v = str(value);
    if (v) q.set(param, v);
  }
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(f.pageSize) || 50));
  q.set('page_size', String(size));

  const applied: Record<string, string> = {};
  for (const [k, v] of q.entries()) if (k !== 'type' && k !== 'page_size' && k !== 'page_token') applied[k] = v;

  try {
    const res = await fetchWithTimeout(`${API_BASE}/voices?${q}`, {
      timeoutMs: LIST_TIMEOUT_MS,
      signal: f.signal,
      headers: { 'x-goog-api-key': key },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        voices: [],
        message: `Voice library HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
      };
    }
    const json = await res.json() as any;
    const voices = (Array.isArray(json?.voices) ? json.voices : [])
      .map(mapVoice)
      .filter((v: LibraryVoice | null): v is LibraryVoice => !!v);
    note(voices);
    // REST spells it `next_page_token`; the SDK's is camelCase. Accept both so
    // a shape change degrades to "no next page" instead of a hard stop.
    const next = str(json?.next_page_token) || str(json?.nextPageToken);
    return { ok: true, voices, nextPageToken: next, applied };
  } catch (err: unknown) {
    // Caller cancellation is rethrown; OUR timeout is not.
    //
    // `fetchWithTimeout` aborts its own controller, so a timeout and a caller
    // disconnect produce the same `name: 'AbortError'` and nothing in the error
    // distinguishes them. Rethrowing on the name alone therefore propagated the
    // internal 15-second timeout out of this function, and the Express 4 handler
    // (`await listLibraryVoices(...)`, no catch) never answered the request — the
    // operator saw a spinner until the browser gave up, instead of the
    // unavailable-library envelope every other failure already returns.
    //
    // The caller's signal is the only thing that can tell the two apart.
    const callerAborted = f.signal?.aborted === true;
    if (callerAborted && (err as { name?: string })?.name === 'AbortError') throw err;
    return { ok: false, voices: [], message: (err as { message?: string })?.message || 'Voice library unreachable' };
  }
}

// ── Membership index ─────────────────────────────────────────────────────────
// Why this exists at all: usableVoice() must reject a typo. A wrong voice name
// is a 400 from Google, and a 400 on a persona's own voice throws that segment
// into the fallback chain — so the pre-existing design whitelists. Accepting
// ~2,000 library names structurally would restore exactly that failure, so the
// index is populated from what Google actually SERVED and nothing else.
//
// Cold start is handled by prewarm(), called from the boot path: a fresh
// controller that has never browsed must still honour a library voice, or a
// restart would silently swap a persona back to the station voice.

let known = new Set<string>();
let warmedAt = 0;

const TTL_MS = 24 * 60 * 60 * 1000;
const WARM_TIMEOUT_MS = 30_000;

function note(voices: LibraryVoice[]): void {
  for (const v of voices) {
    if (v.id) known.add(v.id.toLowerCase());
    if (v.name) known.add(v.name.toLowerCase());
  }
}

// ── Facet vocabulary ─────────────────────────────────────────────────────────
// WHY NOT derived from the page the operator is looking at
// ---------------------------------------------------------
// A filter menu is a vocabulary, not a summary of the current results. Deriving
// it from the returned page made the menu depend on the filter: on first open
// the unfiltered page yielded THREE accents, and "Sydney English" was simply not
// an option — so an Australian station could not select it. Narrowing by gender
// first changed the page, the menu repopulated, and 10 more accents appeared
// including the one being looked for. Measured, not hypothesised: 3 accents
// unfiltered vs 13 after gender=male.
//
// The whole-catalogue walk that fills the membership index above already sees
// every row, so the vocabulary is collected there at no extra cost. This is the
// same reasoning as GEMINI_TTS_VOICES: derived from what Google serves, never
// restated, because the vocabulary moves.

export interface CatalogueFacets {
  languages: string[];
  accents: string[];
  genders: string[];
  pitches: string[];
  contexts: string[];
}

const EMPTY_FACETS: CatalogueFacets = {
  languages: [], accents: [], genders: [], pitches: [], contexts: [],
};

let facetCache: CatalogueFacets | null = null;

/** Replace the cached vocabulary from a COMPLETE walk. Publishing a partial
 *  walk is the bug this signature exists to prevent, so the function is whole
 *  set replacement rather than an accumulation step. */
function publishFacets(voices: LibraryVoice[]): void {
  const lang = new Set<string>(), acc = new Set<string>(), gen = new Set<string>();
  const pit = new Set<string>(), ctx = new Set<string>();
  for (const v of voices) {
    if (v.language) lang.add(v.language);
    if (v.accent) acc.add(v.accent);
    if (v.gender) gen.add(v.gender);
    if (v.pitch) pit.add(v.pitch);
    if (v.context) ctx.add(v.context);
  }
  const sorted = (s: Set<string>) => [...s].sort();
  facetCache = {
    languages: sorted(lang),
    accents: sorted(acc),
    genders: sorted(gen),
    pitches: sorted(pit),
    contexts: sorted(ctx),
  };
}

/** The catalogue-wide vocabulary, or empty when nothing has been walked yet.
 *  `ready` is false in that case so a caller can tell "no accents exist" (never
 *  true) apart from "we have not looked yet". */
export function catalogueFacets(): CatalogueFacets & { ready: boolean } {
  if (!facetCache) return { ...EMPTY_FACETS, ready: false };
  const total = facetCache.accents.length + facetCache.languages.length
    + facetCache.genders.length + facetCache.pitches.length + facetCache.contexts.length;
  return { ...facetCache, ready: total > 0 };
}

/** Make sure the vocabulary exists, walking the catalogue if boot has not (or
 *  ran without a key). Bounded and TTL-cached by prewarm, so this is a no-op on
 *  the second call. Never throws. */
export async function ensureFacets(): Promise<CatalogueFacets & { ready: boolean }> {
  if (catalogueFacets().ready) return catalogueFacets();
  await prewarm();
  return catalogueFacets();
}

/** Whether this process has seen this voice from Google. Both the id and the
 *  display name count — the engine accepts either, and the picker shows the
 *  name. */
export function isLibraryVoice(name: unknown): boolean {
  const raw = String(name ?? '').trim();
  if (!raw || raw.length > MAX_ID_LEN) return false;
  return known.has(raw.toLowerCase());
}

/** Load the full catalogue into the membership index and the facet vocabulary.
 *  Cheap (a few pages of ids) and safe to call repeatedly — it no-ops inside the
 *  TTL. Never throws: a failure leaves the index as it was, which degrades to
 *  the pre-existing graceful fallback rather than to an error. */
export async function prewarm(opts: { force?: boolean } = {}): Promise<number> {
  if (!apiKey()) return 0;
  if (!opts.force && warmedAt && Date.now() - warmedAt < TTL_MS) return known.size;
  let token: string | undefined;
  let pages = 0;
  const staged: LibraryVoice[] = [];
  try {
    // Bounded: Google serves ~2,100 prebuilt voices in three pages of 1000.
    // Stop at the pagination bound rather than loop indefinitely.
    do {
      const page = await listLibraryVoices({ pageSize: MAX_PAGE_SIZE, pageToken: token, signal: AbortSignal.timeout(WARM_TIMEOUT_MS) });
      if (!page.ok) return known.size;
      // Stage facets from the unfiltered catalogue and publish only after a complete walk.
      // Filtered browse pages cannot define vocabulary. Record membership per page: served ids are valid.
      staged.push(...page.voices);
      token = page.nextPageToken;
      pages += 1;
      if (pages >= MAX_WALK_PAGES) break;
    } while (token);

    // A remaining token means incomplete facets: publish nothing and leave the index
    // unwarmed for retry. Keep confirmed voice membership from completed pages.
    if (token) {
      console.warn(`[tts] gemini voice library: walk stopped at the ${MAX_WALK_PAGES}-page cap with pages remaining; facets left unpublished`);
      return known.size;
    }
    publishFacets(staged);
    warmedAt = Date.now();
    return known.size;
  } catch {
    return known.size;
  }
}

/** Distinct values actually present in `voices`, for populating the filter
 *  dropdowns. Derived rather than restated: a hardcoded accent list would be
 *  wrong the moment Google adds or retires one (there is no "Australian"
 *  accent — en-AU voices are labelled "Sydney English"). */
export function facets(voices: LibraryVoice[]): {
  languages: string[];
  accents: string[];
  genders: string[];
  pitches: string[];
  contexts: string[];
} {
  const collect = (pick: (v: LibraryVoice) => string | undefined) =>
    [...new Set(voices.map(pick).filter((s): s is string => !!s))].sort();
  return {
    languages: collect(v => v.language),
    accents: collect(v => v.accent),
    genders: collect(v => v.gender),
    pitches: collect(v => v.pitch),
    contexts: collect(v => v.context),
  };
}

/** Whether a string SHAPES like a library id, without having seen it.
 *
 *  Deliberately a save-time-only allowance. Library ids are
 *  `<language>-<…>-<name>` (`en-us-varo`, `en-au-advisor-1`) — lowercase, at
 *  least one hyphen, no underscore — while the 30 featured ids are bare (`kore`).
 *
 *  The runtime gate does NOT use this: usableVoice() stays strict against the
 *  index so a typo never reaches the wire. Save is looser because the index may
 *  legitimately be cold (no key yet, or Google unreachable at boot) and refusing
 *  to save a real voice would be worse than accepting one that later degrades to
 *  the station voice — the same graceful fallback that already exists. */
export function looksLikeLibraryId(name: unknown): boolean {
  const v = String(name ?? '').trim();
  return v.length > 0 && v.length <= MAX_ID_LEN && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(v);
}

/** Test seam — the index and the vocabulary are process-global, so a test that
 *  asserts on either needs to reset BOTH. Clearing only `known` left the facet
 *  cache populated from the previous test, which made the suite
 *  order-dependent: it passed when the "no facets yet" case ran first and
 *  failed the moment that changed. */
export function _resetLibraryIndex(): void {
  known = new Set();
  warmedAt = 0;
  facetCache = null;
}