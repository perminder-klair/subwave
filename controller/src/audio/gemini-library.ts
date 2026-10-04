// The Gemini Extended Voice Library — the ~2,000 prebuilt voices BEYOND the 30
// featured studio ones in GEMINI_TTS_VOICES.
//
// WHY THIS IS A SEPARATE CATALOGUE
// ---------------------------------
// GEMINI_TTS_VOICES is Google's documented list of *30 featured studio voices*
// (Zephyr…Sulafat). Google separately exposes ~2,089 *prebuilt* voices through
// GET /v1beta/voices — different ids (`en-us-varo`, not `Varo`), richer
// metadata (language, accent, gender, pitch, persona, context), and paginated.
// An operator browsing AI Studio's "2,000+ voices" picker is looking at THIS
// one. Verified against the live API: `{"voice":"Varo"}` and
// `{"voice":"en-us-varo"}` both synthesise, while a nonsense name 400s with
// "No matching speaker voice found" — so Google VALIDATES rather than silently
// falling back, which is what makes the membership test below worth having.
//
// WHY GENDER AND ACCENT ARE FILTERS HERE AND NOT STYLE TEXT
// ---------------------------------------------------------
// Google is explicit: "Do not try to change immutable speaker traits in style:
// avoid putting age, gender, names, or permanent accent changes in
// speech_metadata.style. Instead, pick a regional voice from the Extended Voice
// Library." So the operator picks a voice that HAS the trait; there is no
// directive form to offer, and offering one would be a control that silently
// does nothing. Also note the accent vocabulary is NOT "Australian" — the live
// values are things like "Sydney English" (44 en-AU voices all carry it), which
// is why nothing here hardcodes a list of accents or languages.
//
// The vocabulary is discovered, never restated: `facets()` returns the distinct
// values actually present in a page, so the admin dropdown cannot drift from
// what Google currently serves.

import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { apiKey } from './gemini.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Discovery is a browse, not the audio path: a page of metadata comes back in
// well under a second, and the index (all ids) is ~3 requests. Kept short
// because this sits behind an admin UI that shows a spinner.
const LIST_TIMEOUT_MS = 15_000;

// Google's own cap; the docs say page_size maxes at 1000.
const MAX_PAGE_SIZE = 1000;

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
    if ((err as { name?: string })?.name === 'AbortError') throw err;
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

/** Whether this process has seen this voice from Google. Both the id and the
 *  display name count — the engine accepts either, and the picker shows the
 *  name. */
export function isLibraryVoice(name: unknown): boolean {
  const raw = String(name ?? '').trim();
  if (!raw || raw.length > MAX_ID_LEN) return false;
  return known.has(raw.toLowerCase());
}

/** Load the full catalogue into the membership index. Cheap (a few pages of
 *  ids) and safe to call repeatedly — it no-ops inside the TTL. Never throws:
 *  a failure leaves the index as it was, which degrades to the pre-existing
 *  graceful fallback rather than to an error. */
export async function prewarm(opts: { force?: boolean } = {}): Promise<number> {
  if (!apiKey()) return 0;
  if (!opts.force && warmedAt && Date.now() - warmedAt < TTL_MS) return known.size;
  let token: string | undefined;
  let pages = 0;
  try {
    // Bounded: Google serves ~2,100 prebuilt voices in three pages of 1000.
    // The bound is a stop, not an expectation — a catalogue that grew past it
    // leaves the tail undiscoverable rather than looping.
    do {
      const page = await listLibraryVoices({ pageSize: MAX_PAGE_SIZE, pageToken: token, signal: AbortSignal.timeout(WARM_TIMEOUT_MS) });
      if (!page.ok) return known.size;
      token = page.nextPageToken;
      pages += 1;
      if (pages >= 5) break;
    } while (token);
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

/** Test seam — the index is process-global, so a test that asserts on it needs
 *  to be able to reset it. */
export function _resetLibraryIndex(): void {
  known = new Set();
  warmedAt = 0;
}