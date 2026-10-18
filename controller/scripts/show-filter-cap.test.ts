// Pins SHOW_FILTER_VALUES_MAX — the per-attribute cap on a show's multi-select
// music filters (moods / genres / eras) — and the two places that have to agree
// with it.
//
// Why this needs a test rather than "it's just a number": the cap is enforced in
// THREE independent layers that each hardcoded it at some point. The validator
// throws above it, the loader (coerceShowList) silently truncates at it, and the
// admin UI disables the Add button at its own copy. A UI copy ABOVE the
// controller's turns a legal-looking save into a 400; one BELOW hides entries the
// operator is allowed to add; and a community-catalog import that caps lower
// truncates a published show on the way in. Nothing else catches those — the
// symptom is silent, not a crash.
//
// NOTE on the regexes below: the field name now arrives as a dotted PREFIX
// ('shows.0.genres: must have at most 15 entries') rather than inline in the
// message, because the shared schema's errors go through firstMessage(). The
// patterns pin the FIELD and the RULE without pinning the separator between
// them — wording was never the contract here, accept-vs-reject is.
// Playlist anchors and exclusions obey the same save/load/UI cap contract.
// Run: npm test -- show-filter-cap

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SHOW_FILTER_VALUES_MAX, SHOW_MOODS } from '../src/settings.js';
import { PLAYLISTS_PER_SHOW, EXCLUDED_PLAYLISTS_PER_SHOW, coerceShowGenres, coerceShowMoods } from '../src/settings/vocab.js';
import { validateShowsStrict } from '../src/settings/validate.js';
import { normalizeShows } from '../src/settings/normalize.js';

import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const personas = [{ id: 'p1' }];
const themes = new Set<string>();
const ids = (n: number) => Array.from({ length: n }, (_, i) => `pl-${i + 1}`);
const genreList = (n: number) => Array.from({ length: n }, (_, i) => `Genre ${i + 1}`);
const showWith = (extra: Record<string, unknown>) => ([{
  id: 's1', name: 'Test Show', personaId: 'p1', topic: '', ...extra,
}]);

test('the cap leaves room for a real sub-genre spread', () => {
  // The reported case: a strict alt/punk show naming every library tag it
  // wants. Genre matching only REFINES (a "Punk" show admits "Punk Rock" but a
  // "Pop Punk" show rejects plain "Pop"), so the operator has to list each tag
  // explicitly — the cap is what decides whether that's possible.
  const altPunk = ['Rock', 'Alternative Rock', 'Punk Rock', 'Emo', 'Pop Punk',
    'Post-Hardcore', 'Emo Pop', 'Alternative Punk', 'Metalcore'];
  assert.ok(
    SHOW_FILTER_VALUES_MAX >= altPunk.length,
    `cap ${SHOW_FILTER_VALUES_MAX} cannot express a ${altPunk.length}-tag show`,
  );
});

test('validator accepts exactly the cap and rejects one over — genres', () => {
  const ok = validateShowsStrict(showWith({ genres: genreList(SHOW_FILTER_VALUES_MAX) }), personas, themes);
  assert.equal(ok[0].genres.length, SHOW_FILTER_VALUES_MAX);
  assert.throws(
    () => validateShowsStrict(showWith({ genres: genreList(SHOW_FILTER_VALUES_MAX + 1) }), personas, themes),
    /genres.*must have at most/,
  );
});

test('validator accepts exactly the cap and rejects one over — eras', () => {
  const eras = Array.from({ length: SHOW_FILTER_VALUES_MAX + 1 }, (_, i) => ({
    fromYear: 1900 + i * 2, toYear: 1901 + i * 2,
  }));
  const ok = validateShowsStrict(showWith({ eras: eras.slice(0, SHOW_FILTER_VALUES_MAX) }), personas, themes);
  assert.equal(ok[0].eras.length, SHOW_FILTER_VALUES_MAX);
  assert.throws(
    () => validateShowsStrict(showWith({ eras }), personas, themes),
    /eras.*must have at most/,
  );
});

test('validator rejects one over the cap — moods', () => {
  // Moods must come from the live vocabulary, so this only runs a real
  // over-cap case when the vocab is big enough to build one.
  if (SHOW_MOODS.length <= SHOW_FILTER_VALUES_MAX) {
    console.log(`    (skipped: mood vocab is ${SHOW_MOODS.length}, cap is ${SHOW_FILTER_VALUES_MAX})`);
    return;
  }
  assert.throws(
    () => validateShowsStrict(showWith({ moods: SHOW_MOODS.slice(0, SHOW_FILTER_VALUES_MAX + 1) }), personas, themes),
    /moods.*must have at most/,
  );
});

test('the loader truncates at the same cap it validates against', () => {
  // coerceShowGenres/coerceShowMoods are the LOAD path (settings.json written by
  // an older build, or by hand). They truncate silently, so a cap here that is
  // lower than the validator's would quietly delete a legally-saved show's tags
  // on the next boot.
  const genres = coerceShowGenres({ genres: genreList(SHOW_FILTER_VALUES_MAX + 5) });
  assert.equal(genres.length, SHOW_FILTER_VALUES_MAX);
  const moods = coerceShowMoods({ moods: genreList(SHOW_FILTER_VALUES_MAX + 5) });
  assert.equal(moods.length, SHOW_FILTER_VALUES_MAX);
});

test('the admin UI derives the cap from the schema mirror, not a copy', () => {
  // This used to scrape a hardcoded number out of the web file and compare it.
  // The cap now comes from the shared show schema, mirrored into
  // web/lib/schemas.generated.ts and drift-checked by CI, so equality is
  // structural and there is nothing left to compare. What IS still worth
  // pinning is that nobody reintroduces a literal — the failure mode the
  // original test existed for.
  const src = readFileSync(resolve(here, '../../web/components/admin/shows/types.ts'), 'utf8');
  const m = src.match(/export const FILTER_VALUES_MAX = (.+);/);
  assert.ok(m, 'FILTER_VALUES_MAX not found in web/components/admin/shows/types.ts');
  assert.equal(
    m![1], 'SHOW_FILTER_VALUES_MAX',
    `FILTER_VALUES_MAX is "${m![1]}" — it must be the schema mirror's constant, not a copy`,
  );
  assert.match(src, /from '@\/lib\/schemas\.generated'/);
});

test('community-catalog import does not truncate below the cap', () => {
  // registry.normalizeShow caps each imported filter list. It used to hardcode
  // 6, so raising the controller cap without touching it would have silently
  // trimmed published shows on import.
  const src = readFileSync(resolve(here, '../src/community/registry.ts'), 'utf8');
  for (const key of ['moods', 'genres', 'energies']) {
    const m = src.match(new RegExp(`strList\\(raw\\?\\.${key}, ([A-Za-z_0-9]+)\\)`));
    assert.ok(m, `strList(raw?.${key}, …) not found in community/registry.ts`);
    assert.equal(m![1], 'SHOW_FILTER_VALUES_MAX', `${key} import cap is hardcoded (${m![1]})`);
  }
});


test('validator accepts exactly the cap and rejects one over — playlistIds', () => {
  const ok = validateShowsStrict(showWith({ playlistIds: ids(PLAYLISTS_PER_SHOW) }), personas, themes);
  assert.equal(ok[0].playlistIds.length, PLAYLISTS_PER_SHOW);
  assert.throws(
    () => validateShowsStrict(showWith({ playlistIds: ids(PLAYLISTS_PER_SHOW + 1) }), personas, themes),
    /playlistIds.*must have at most/,
  );
});

test('validator accepts exactly the cap and rejects one over — excludedPlaylistIds', () => {
  const ok = validateShowsStrict(
    showWith({ excludedPlaylistIds: ids(EXCLUDED_PLAYLISTS_PER_SHOW) }), personas, themes,
  );
  assert.equal(ok[0].excludedPlaylistIds.length, EXCLUDED_PLAYLISTS_PER_SHOW);
  assert.throws(
    () => validateShowsStrict(
      showWith({ excludedPlaylistIds: ids(EXCLUDED_PLAYLISTS_PER_SHOW + 1) }), personas, themes,
    ),
    /excludedPlaylistIds.*must have at most/,
  );
});

test('the loader truncates playlist anchors and exclusions at their caps', () => {
  // The LOAD path (settings.json written by an older build, or by hand). It
  // truncates silently, so a cap here below the validator's would quietly drop a
  // legally-saved show's anchors on the next boot — and an over-cap list must
  // cost the extra anchors, never the show.
  const [s] = normalizeShows(
    showWith({
      playlistIds: ids(PLAYLISTS_PER_SHOW + 5),
      excludedPlaylistIds: ids(EXCLUDED_PLAYLISTS_PER_SHOW + 5),
    }),
    ['p1'],
  );
  assert.ok(s, 'over-cap playlist lists must not drop the show on load');
  assert.equal(s.playlistIds.length, PLAYLISTS_PER_SHOW);
  assert.equal(s.excludedPlaylistIds.length, EXCLUDED_PLAYLISTS_PER_SHOW);
});

test('a stale id still counts against the cap', () => {
  // The admin picker counts ids it cannot resolve against the live Navidrome
  // index toward its own cap. That only matches the controller because nothing
  // here filters unresolvable ids out before counting — resolveShowPlaylistPool
  // drops them at pick time, never at save time.
  const ok = validateShowsStrict(
    showWith({ playlistIds: ids(PLAYLISTS_PER_SHOW - 1).concat('deleted-in-navidrome') }),
    personas, themes,
  );
  assert.equal(ok[0].playlistIds.length, PLAYLISTS_PER_SHOW);
});

test('the admin UI derives both caps from the schema mirror, not a copy', () => {
  // Previously this scraped one hardcoded PLAYLISTS_MAX and compared it to both
  // controller caps, with a note that the UI would need two constants if they
  // ever diverged. Both now come from the shared schema — and they are two
  // separate constants on the UI side as well, so a future divergence is a
  // no-op here instead of a silent mis-cap on the exclusions picker.
  const src = readFileSync(resolve(here, '../../web/components/admin/shows/types.ts'), 'utf8');
  for (const [local, schemaName] of [
    ['PLAYLISTS_MAX', 'PLAYLISTS_PER_SHOW'],
    ['EXCLUDED_PLAYLISTS_MAX', 'EXCLUDED_PLAYLISTS_PER_SHOW'],
  ]) {
    const m = src.match(new RegExp(`export const ${local} = (.+);`));
    assert.ok(m, `${local} not found in web/components/admin/shows/types.ts`);
    assert.equal(
      m![1], schemaName,
      `${local} is "${m![1]}" — it must be the schema mirror's ${schemaName}, not a copy`,
    );
  }
});
