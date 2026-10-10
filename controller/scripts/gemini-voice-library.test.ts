// The Extended Voice Library must be reachable, and must stay a WHITELIST.
//
// Two failure directions, opposite, and this file pins both.
//
//   Too strict (the bug being fixed): usableVoice() recognised only Google's 30
//   featured studio voices, so `Varo` — a real prebuilt voice the operator can
//   see in AI Studio — returned undefined. The persona then silently spoke with
//   the STATION's voice. No error, no log line, just the wrong DJ.
//
//   Too loose: Google's reply to an unknown voice name is a 400 ("No matching
//   speaker voice found for name"), and a 400 on a persona's own voice throws
//   that whole segment into the fallback chain. So the runtime gate must accept
//   only what Google has actually SERVED — never a structural guess.
//
// That asymmetry is why save is looser than speak, and it is asserted here
// rather than left as a comment.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isGeminiLibraryLanguage,
  normalizeGeminiLibraryLanguage,
} from '../src/schemas/settings.js';
import {
  _resetLibraryIndex,
  facets,
  looksLikeLibraryId,
} from '../src/audio/gemini-library.js';

// ── The 30 must keep working, untouched ──────────────────────────────────────
// An upgrade that stopped honouring a featured voice would be a regression
// nobody would notice until a persona sounded wrong on air.
test('the 30 featured studio voices are unaffected by the library index', async () => {
  _resetLibraryIndex();
  const { usableVoice } = await import('../src/audio/gemini.js');
  const { GEMINI_TTS_VOICES } = await import('../src/schemas/persona.js');
  assert.equal(GEMINI_TTS_VOICES.length, 30, 'the curated list is Google\'s documented 30');
  for (const v of GEMINI_TTS_VOICES) {
    assert.equal(usableVoice(v), v, `${v} must still resolve with a cold index`);
  }
  // Canonical casing is preserved for the featured set, so existing personas
  // keep the exact string they were saved with.
  assert.equal(usableVoice('kore'), 'Kore');
});

// ── Custom ids still pass through unvalidated ────────────────────────────────
test('designed and replicated ids still pass through untouched', async () => {
  const { usableVoice } = await import('../src/audio/gemini.js');
  assert.equal(usableVoice('voice_abc123'), 'voice_abc123');
  assert.equal(usableVoice('voicekey_xyz789'), 'voicekey_xyz789');
  // Case-insensitive on the prefix, as before.
  assert.equal(usableVoice('VOICE_abc'), 'VOICE_abc');
});

// ── The gate is a whitelist, not a shape ────────────────────────────────────
test('an unknown voice is rejected even when it is perfectly well shaped', async () => {
  _resetLibraryIndex();
  const { usableVoice } = await import('../src/audio/gemini.js');
  // Structurally identical to `en-us-varo`, which is the trap: accepting this
  // because of its shape is exactly how a typo reaches the wire as a 400.
  assert.equal(looksLikeLibraryId('en-us-varoo'), true, 'it IS library-shaped');
  assert.equal(usableVoice('en-us-varoo'), undefined, 'but unseen, so still rejected');
  assert.equal(usableVoice('Varo'), undefined, 'the cold case that motivated the fix');
  assert.equal(usableVoice(''), undefined);
  assert.equal(usableVoice(null), undefined);
  assert.equal(usableVoice(undefined), undefined);
});

test('membership is case-insensitive and accepts the id or the display name', async () => {
  _resetLibraryIndex();
  // Both forms are real: the engine takes `Varo` AND `en-us-varo`, and the
  // picker shows the name while the wire wants the id. Verified against the
  // live API — a nonsense name 400s while both of these synthesise.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/audio/gemini-library.ts', import.meta.url), 'utf8'));
  assert.match(src, /if \(v\.id\) known\.add\(v\.id\.toLowerCase\(\)\)/,
    'the id must be indexed');
  assert.match(src, /if \(v\.name\) known\.add\(v\.name\.toLowerCase\(\)\)/,
    'the display name must be indexed too');
});

// ── libraryLanguage: a shape rule, never a list ─────────────────────────────
test('libraryLanguage accepts a language tag and rejects junk', () => {
  assert.equal(isGeminiLibraryLanguage('en-AU'), true);
  assert.equal(isGeminiLibraryLanguage('en'), true);
  assert.equal(isGeminiLibraryLanguage('en-GB'), true);
  assert.equal(isGeminiLibraryLanguage('zh-Hans-CN'), true, 'script + region');
  assert.equal(isGeminiLibraryLanguage('es-419'), true, 'UN M.49 region');
  assert.equal(isGeminiLibraryLanguage(''), true, 'empty means every language');
  assert.equal(isGeminiLibraryLanguage('  '), true);
  // Not a tag.
  assert.equal(isGeminiLibraryLanguage('Australian'), false,
    'an accent is not a language — this is how the real bug was found');
  assert.equal(isGeminiLibraryLanguage('Sydney English'), false);
  assert.equal(isGeminiLibraryLanguage('en_AU'), false);
  assert.equal(isGeminiLibraryLanguage('en-AU-'), false);
  assert.equal(isGeminiLibraryLanguage('e'), false, 'a one-letter primary subtag is not a language');
  assert.equal(isGeminiLibraryLanguage('en-AU; DROP TABLE'), false);
  assert.equal(isGeminiLibraryLanguage('x'.repeat(40)), false);
});

test('libraryLanguage is canonicalised so one language is one dropdown entry', () => {
  assert.equal(normalizeGeminiLibraryLanguage('en-au'), 'en-AU');
  assert.equal(normalizeGeminiLibraryLanguage('EN-AU'), 'en-AU');
  assert.equal(normalizeGeminiLibraryLanguage('  en-Au  '), 'en-AU');
  assert.equal(normalizeGeminiLibraryLanguage('zh-hans-cn'), 'zh-Hans-CN');
  assert.equal(normalizeGeminiLibraryLanguage(''), '');
  assert.equal(normalizeGeminiLibraryLanguage(undefined), '');
});

// ── Facets are derived, so the dropdown cannot drift from Google ─────────────
test('facets come from the rows served, not from a restated vocabulary', () => {
  const rows = [
    { id: 'a', name: 'A', language: 'en-AU', accent: 'Sydney English', gender: 'male', pitch: 'low', context: 'Content & Media' },
    { id: 'b', name: 'B', language: 'en-AU', accent: 'Sydney English', gender: 'female', pitch: 'low', context: 'Enterprise Agent' },
    { id: 'c', name: 'C', language: 'en-US', accent: 'Northwest', gender: 'male', pitch: 'medium', context: 'Content & Media' },
  ];
  const f = facets(rows as never);
  assert.deepEqual(f.languages, ['en-AU', 'en-US'], 'sorted, deduped');
  assert.deepEqual(f.genders, ['female', 'male']);
  assert.deepEqual(f.pitches, ['low', 'medium']);
  assert.deepEqual(f.accents, ['Northwest', 'Sydney English']);
  assert.deepEqual(f.contexts, ['Content & Media', 'Enterprise Agent']);
  // The point of deriving: no "Australian" appears, because Google does not
  // serve one. A hardcoded accent list would have offered it and returned zero.
  assert.equal(f.accents.includes('Australian'), false);
});

test('facets tolerate rows missing every optional field', () => {
  const f = facets([{ id: 'x', name: 'X' }] as never);
  assert.deepEqual(f.languages, []);
  assert.deepEqual(f.genders, []);
});

// ── Save is looser than speak, deliberately ─────────────────────────────────
test('save accepts an unseen library-shaped id; speak still rejects it', async () => {
  _resetLibraryIndex();
  const { usableVoice } = await import('../src/audio/gemini.js');
  const v = 'en-au-newscaster-7';
  // The save-time rule: a cold index must not stop an operator saving a real
  // voice they just browsed to.
  assert.equal(looksLikeLibraryId(v), true);
  // The speak-time rule: unseen, so it degrades to the station voice rather
  // than 400-ing the segment. This is the asymmetry, asserted.
  assert.equal(usableVoice(v), undefined);
});

test('looksLikeLibraryId does not admit the featured ids or custom ids', () => {
  // Featured ids are bare, with no hyphen.
  assert.equal(looksLikeLibraryId('kore'), false);
  assert.equal(looksLikeLibraryId('sadaltager'), false);
  // Custom ids are underscore-prefixed, handled by their own branch.
  assert.equal(looksLikeLibraryId('voice_abc'), false);
  assert.equal(looksLikeLibraryId('en-us-varo'), true);
  assert.equal(looksLikeLibraryId('en-au-advisor-1'), true);
  assert.equal(looksLikeLibraryId(''), false);
  assert.equal(looksLikeLibraryId('a'.repeat(200)), false);
});
// ── The mutation guard ──────────────────────────────────────────────────────
// Reverting usableVoice() to the 30-only whitelist is THE regression this change
// exists to fix, and it is invisible to every test above: the featured voices
// still resolve, a library-SHAPED id is still rejected, and the save/speak
// asymmetry still holds — because none of them ever make a library name KNOWN.
// Membership is the only thing that changes, so membership is what is driven.
//
// The catalogue is STUBBED rather than fetched. An earlier draft called the live
// endpoint and, with no key present, took the cold-index branch — which is true
// under the bug as well, so the mutation passed. A test that cannot fail is
// worse than no test, and this is the third time in this work that a fail-open
// assertion slipped through (the other two: catch/continue over engine files,
// and a route slice wide enough to cover the next handler).
const CATALOGUE = {
  voices: [
    {
      id: 'en-us-varo',
      type: 'prebuilt',
      display_name: 'Varo',
      language_code: 'en-US',
      region_code: 'US',
      accent: 'Northwest',
      persona: 'Educational Tutor (Writing Tutor)',
      context: 'Conversational / Edu',
      gender: 'male',
      pitch: 'low',
      description: '36-year-old Writing Tutor from the Northwest.',
    },
    {
      // REST sometimes carries a resource `name` instead of `id`; the mapper
      // accepts both, and a wrong guess here empties the picker silently.
      name: 'voices/en-au-advisor-1',
      display_name: 'Authoritative Advisor 1',
      language_code: 'en-AU',
      accent: 'Sydney English',
      gender: 'male',
      pitch: 'low',
    },
  ],
};

/** Serve `body` for the catalogue call and record the query Google was asked
 *  for, so a filter regression is visible without hitting the network.
 *
 *  `fn` receives the ARRAY, not `seen[0]`: the first draft passed the element,
 *  which is evaluated before the async fetch inside `fn` has pushed anything —
 *  so the assertion read an empty query and passed/failed for the wrong reason. */
async function withStubbedCatalogue<T>(
  body: unknown,
  fn: (seen: URLSearchParams[]) => Promise<T>,
  status = 200,
): Promise<T> {
  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const seen: URLSearchParams[] = [];
  globalThis.fetch = (async (input: any) => {
    seen.push(new URL(String(input)).searchParams);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
  // Deliberately NOT key-shaped. `apiKey()` only checks that the variable is
  // non-empty, so any string works — and a realistic-looking `AIza…` literal in
  // source makes every secret scanner in the pipeline fire and forces a human
  // to adjudicate whether it is real.
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stub-key-for-voice-list-tests';
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }
}

test('a library voice Google served becomes usable; an unserved one does not', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  const { usableVoice } = await import('../src/audio/gemini.js');
  _resetLibraryIndex();

  const page = await withStubbedCatalogue(CATALOGUE, () => lib.listLibraryVoices({ search: 'Varo' }));
  assert.equal(page.ok, true);
  assert.equal(page.voices.length, 2, 'both id and resource-name shapes must map');
  assert.equal(page.voices[0].id, 'en-us-varo');
  assert.equal(page.voices[0].name, 'Varo');
  assert.equal(page.voices[1].id, 'en-au-advisor-1', 'the voices/ prefix must be stripped');

  // The whole point: serving them is what makes them usable.
  assert.equal(usableVoice('Varo'), 'Varo');
  assert.equal(usableVoice('en-us-varo'), 'en-us-varo');
  assert.equal(usableVoice('en-au-advisor-1'), 'en-au-advisor-1');
  assert.equal(usableVoice('Authoritative Advisor 1'), 'Authoritative Advisor 1');

  // The control, and the reason for the index at all.
  assert.equal(usableVoice('ZzzNotARealVoice999'), undefined);
  assert.equal(usableVoice('en-us-varoo'), undefined, 'one character off is still not served');
});

test('filters are forwarded to Google in the spelling the REST API wants', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  _resetLibraryIndex();
  const q = await withStubbedCatalogue(CATALOGUE, seen => lib.listLibraryVoices({
    language: 'en-AU', gender: 'male', pitch: 'low', accent: 'Sydney English', context: 'Enterprise Agent',
  }).then(() => seen[0]));

  // snake_case, and `context` — NOT `contexts`, which is the SDK's name. The
  // docs list both and only one of them works on REST.
  assert.equal(q.get('language_code'), 'en-AU');
  assert.equal(q.get('gender'), 'male');
  assert.equal(q.get('pitch'), 'low');
  assert.equal(q.get('accent'), 'Sydney English');
  assert.equal(q.get('context'), 'Enterprise Agent');
  assert.equal(q.get('contexts'), null, 'the SDK spelling is not the REST one');
  // Scoped to the catalogue: the operator's own designed/replicated voices are
  // already handled by the voice_…/voicekey_… pass-through.
  assert.equal(q.get('type'), 'prebuilt');
});

test('a page token is echoed back so the browser can page', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  _resetLibraryIndex();
  const page = await withStubbedCatalogue(
    { ...CATALOGUE, next_page_token: 'EY5OT0iaH==' },
    () => lib.listLibraryVoices({ language: 'en-US' }),
  );
  assert.equal(page.nextPageToken, 'EY5OT0iaH==');
  // Both spellings accepted, so a shape change degrades to "no next page"
  // rather than a hard stop mid-catalogue.
  const camel = await withStubbedCatalogue(
    { ...CATALOGUE, nextPageToken: 'abc' },
    () => lib.listLibraryVoices({}),
  );
  assert.equal(camel.nextPageToken, 'abc');
});

test('an unreachable Google is a normal answer, never a throw', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  _resetLibraryIndex();
  const page = await withStubbedCatalogue({ error: { message: 'boom' } }, () => lib.listLibraryVoices({}), 503);
  assert.equal(page.ok, false);
  assert.equal(page.voices.length, 0);
  assert.match(String(page.message), /503/);
  // And the index is untouched, so the gate stays a whitelist.
  assert.equal(lib.isLibraryVoice('Varo'), false);
});

test('a missing key reports instead of calling out', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  _resetLibraryIndex();
  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error('must not fetch'); }) as typeof fetch;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  try {
    const page = await lib.listLibraryVoices({});
    assert.equal(page.ok, false);
    assert.match(String(page.message), /key not set/i);
    assert.equal(called, false, 'no network call without a key');
  } finally {
    globalThis.fetch = realFetch;
    if (realKey !== undefined) process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }
});

// ── The facet vocabulary ────────────────────────────────────────────────────
// A filter MENU is a vocabulary, not a summary of the current results. Deriving
// it from the visible page made the menus depend on the filter: unfiltered the
// first page offered THREE accents and "Sydney English" was not selectable at
// all, and narrowing by gender repopulated the menu with 13 — ten of which were
// previously unreachable. So an Australian station could not pick an Australian
// voice without first narrowing by something unrelated.
//
// Measured on the live catalogue, which is why this is a test and not a note:
//   unfiltered page (50 rows)  ->  3 accents, no "Sydney English"
//   gender=male     (200 rows) -> 13 accents, "Sydney English" present

test('facets are empty and not-ready until the catalogue has been walked', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();
  const f = lib.catalogueFacets();
  assert.equal(f.ready, false, 'a cold process must not claim to know the vocabulary');
  assert.deepEqual(f.accents, []);
});

test('a FILTERED browse must not populate the facet vocabulary', async () => {
  // The regression this guards is subtle: facets look like they belong in
  // listLibraryVoices() next to the membership `note()`, because both consume
  // "voices Google served". Membership is safe from any page — a voice that
  // exists is a voice that exists. Facets are NOT: accumulating them from a
  // filtered page rebuilds the original bug through the back door, and the menu
  // would once again describe the current results instead of the catalogue.
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();

  // `display_name`, not `name` — that is the field the catalogue actually
  // carries. A fixture using `name` silently falls back to the id, so the
  // display name never gets indexed and the assertion below fails for a
  // reason that has nothing to do with the behaviour under test.
  const maleOnly = [{ id: 'en-us-varo', display_name: 'Varo', language_code: 'en-US', accent: 'Northwest', gender: 'male', pitch: 'low' }];
  await withStubbedCatalogue({ voices: maleOnly }, () => lib.listLibraryVoices({ gender: 'male' }));

  // Membership: a served voice is known, whoever asked.
  assert.equal(lib.isLibraryVoice('Varo'), true);
  // Facets: still unknown, because that browse was filtered.
  assert.equal(lib.catalogueFacets().ready, false,
    'a filtered page must not be mistaken for the catalogue vocabulary');
});

test('facets are published only after a COMPLETE walk', async () => {
  // A partial walk must not be published. Publishing per page made `ready` true
  // on page one, so a failure on page three handed the caller a vocabulary that
  // claimed to be complete while later accents were simply missing — and with no
  // retry until a restart. Staging, then publishing, is the fix.
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();

  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let call_ = 0;
  globalThis.fetch = (async () => {
    // page 1 OK with "Sydney English"; page 2 FAILS.
    if (call_++ === 0) {
      return {
        ok: true, status: 200,
        json: async () => ({ voices: [{ id: 'a', display_name: 'A', language_code: 'en-AU', accent: 'Sydney English', gender: 'male', pitch: 'low' }], next_page_token: 'p2' }),
        text: async () => '{}',
      } as unknown as Response;
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => 'boom' } as unknown as Response;
  }) as typeof fetch;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stub-key-for-facet-tests';
  try {
    await lib.prewarm({ force: true });
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }

  const f = lib.catalogueFacets();
  assert.equal(f.ready, false,
    'an incomplete walk must leave the vocabulary unpublished, not half-published');
  assert.deepEqual(f.accents, []);
  // Membership is per page on purpose: a voice Google served is a voice that
  // exists, whoever asked for it.
  assert.equal(lib.isLibraryVoice('A'), true, 'membership still records what was served');
});

test('a walk stopped at the page cap does NOT publish facets as if complete', async () => {
  // Hitting the cap with a continuation token still in hand means the walk did
  // not finish. Publishing anyway set `ready` true over a PARTIAL catalogue —
  // the exact failure staging was introduced to prevent, reached by a different
  // route: accents and languages past the cap would be silently absent while the
  // cache claimed completeness, and `ensureFacets` would not retry.
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();

  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let call_ = 0;
  // Every page succeeds and every page hands back another token, so the walk
  // runs until the cap rather than finishing or failing.
  globalThis.fetch = (async () => {
    call_ += 1;
    return {
      ok: true, status: 200,
      json: async () => ({
        voices: [{ id: `v${call_}`, display_name: `V${call_}`, language_code: `en-U${call_}`,
          accent: `Accent ${call_}`, gender: 'male', pitch: 'low' }],
        next_page_token: `p${call_ + 1}`,
      }),
      text: async () => '{}',
    } as unknown as Response;
  }) as typeof fetch;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stub-key-for-cap-tests';
  try {
    await lib.prewarm({ force: true });
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }

  const f = lib.catalogueFacets();
  assert.equal(f.ready, false, 'a capped walk is incomplete and must not publish');
  assert.deepEqual(f.accents, [], 'and must not publish the pages it did see');
  // Membership is per page on purpose, so it survives a truncated walk.
  assert.equal(lib.isLibraryVoice('V1'), true, 'what Google served is still known');
});

test('an upstream timeout degrades to the unavailable envelope, it does not reject', async () => {
  // `fetchWithTimeout` aborts its OWN controller, so a timeout and a caller
  // disconnect are the same `name: 'AbortError'`. Rethrowing on the name alone
  // let the internal 15-second timeout escape, and the Express 4 handler
  // (`await listLibraryVoices(...)`, no catch) never answered the request — the
  // operator saw a spinner instead of an unavailable-library envelope.
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();

  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  globalThis.fetch = (async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  }) as typeof fetch;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stub-key-for-timeout-tests';
  try {
    // No caller signal: this is the module's own timeout, and it must resolve.
    const page = await lib.listLibraryVoices({});
    assert.equal(page.ok, false, 'a timeout is an unavailable library, not a thrown error');
    assert.deepEqual(page.voices, []);
    assert.ok(page.message, 'and it carries a message the UI can show');
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }
});

test('a genuine caller cancellation still propagates', async () => {
  // The counterpart, and the reason the timeout case must be distinguished rather
  // than blanket-caught: TanStack Query aborts on unmount and on refetch, and it
  // needs that rejection to settle its own state. Swallowing it would leave the
  // query hanging instead.
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();

  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  globalThis.fetch = (async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  }) as typeof fetch;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stub-key-for-cancel-tests';
  const ac = new AbortController();
  ac.abort();
  try {
    await assert.rejects(
      () => lib.listLibraryVoices({ signal: ac.signal }),
      (err: unknown) => (err as { name?: string }).name === 'AbortError',
      'a caller abort must still reject so the query can settle',
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }
});

test('the catalogue walk accumulates facets across pages', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();

  // Two pages, disjoint vocabularies. If the second replaced the first rather
  // than unioning, "Sydney English" would vanish depending on pagination.
  const p1 = { voices: [{ id: 'a', display_name: 'A', language_code: 'en-US', accent: 'General American', gender: 'male', pitch: 'high' }], next_page_token: 'p2' };
  const p2 = { voices: [{ id: 'b', display_name: 'B', language_code: 'en-AU', accent: 'Sydney English', gender: 'female', pitch: 'low' }] };

  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let call_ = 0;
  globalThis.fetch = (async () => {
    const body = call_++ === 0 ? p1 : p2;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stub-key-for-facet-tests';
  try {
    await lib.prewarm({ force: true });
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }

  const f = lib.catalogueFacets();
  assert.equal(f.ready, true);
  assert.deepEqual(f.accents, ['General American', 'Sydney English'],
    'both pages must contribute to the published vocabulary');
  assert.deepEqual(f.languages, ['en-AU', 'en-US']);
  assert.deepEqual(f.genders, ['female', 'male']);
  assert.deepEqual(f.pitches, ['high', 'low']);
});

test('ensureFacets returns the catalogue vocabulary without a second walk', async () => {
  const lib = await import('../src/audio/gemini-library.js');
  lib._resetLibraryIndex();
  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return {
      ok: true, status: 200,
      json: async () => ({ voices: [{ id: 'a', display_name: 'A', accent: 'Sydney English', language_code: 'en-AU', gender: 'male', pitch: 'low' }] }),
      text: async () => '{}',
    } as unknown as Response;
  }) as typeof fetch;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'stub-key-for-facet-tests';
  try {
    const first = await lib.ensureFacets();
    assert.equal(first.ready, true);
    assert.deepEqual(first.accents, ['Sydney English']);
    const after = requests;
    await lib.ensureFacets();
    assert.equal(requests, after, 'a warm cache must not re-walk the catalogue');
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
  }
});

test('the route serves the catalogue vocabulary, not the page it returned', async () => {
  // The bug was in the SHAPE of the response as much as in the component: the
  // endpoint handed the client a page and expected it to infer a vocabulary.
  const fs = await import('node:fs');
  const route = fs.readFileSync(new URL('../src/routes/settings/tts.ts', import.meta.url), 'utf8');
  const at = route.indexOf("provider === 'gemini'");
  assert.ok(at > 0, 'the gemini branch must exist on the voices route');
  const block = route.slice(at, route.indexOf('res.json(', at));
  assert.match(block, /await ensureFacets\(\)/,
    'the route must supply the catalogue vocabulary');
  const json = route.slice(route.indexOf('res.json(', at), route.indexOf('});', route.indexOf('res.json(', at)));
  assert.match(json, /facets:\s*\{/, 'and send it to the client');
  assert.match(json, /ready: facets\.ready/, 'including whether it is trustworthy yet');
});
