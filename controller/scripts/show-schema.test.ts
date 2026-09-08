// The show schema's three callers: validateShowsStrict (the update()
// chokepoint), normalizeShows (lenient load) and the POST /shows middleware.
// Accept-vs-reject and the returned shape are the contract; wording is not.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'subwave-show-schema-'));

const { validateShowsStrict } = await import('../src/settings/validate.js');
const { normalizeShows } = await import('../src/settings/normalize.js');
const {
  SHOWS_LIMIT,
  SHOW_FILTER_VALUES_MAX,
  SHOW_NAME_MAX,
  SHOW_TAG_MAX,
  SHOW_TOPIC_MAX,
  TAGS_PER_SHOW_LIMIT,
  migrateLegacyShowFields,
  showSchema,
} = await import('../src/schemas/show.js');

const personas = [{ id: 'p_host' }, { id: 'p_guest' }, { id: 'p_third' }];
const personaIds = personas.map((p) => p.id);
const themes = new Set(['classic-light', 'vinyl']);
const moodNames = ['chill', 'upbeat', 'reflective'];

const show = (over: Record<string, unknown> = {}) => ({
  name: 'Breakfast', personaId: 'p_host', ...over,
});
const strict = (over: Record<string, unknown> = {}) =>
  validateShowsStrict([show(over)], personas, themes, moodNames)[0];

const ctx = { personaIds, moodNames, themeIds: [...themes], minTrackSeconds: 40 };

test('a minimal show validates and every optional field defaults', () => {
  const s = strict();
  assert.equal(s.name, 'Breakfast');
  assert.equal(s.personaId, 'p_host');
  assert.equal(s.topic, '');
  assert.equal(s.themeId, '');
  assert.equal(s.vocals, '');
  assert.equal(s.maxTrackSeconds, null);
  assert.equal(s.banter, false);
  assert.equal(s.programme, false);
  assert.equal(s.filtersStrict, false);
  assert.deepEqual(s.moods, []);
  assert.deepEqual(s.genres, []);
  assert.deepEqual(s.eras, []);
  assert.deepEqual(s.energies, []);
  assert.deepEqual(s.guestPersonaIds, []);
  assert.deepEqual(s.tags, []);
  assert.match(s.id, /^s_[a-z0-9]+$/);
});

test('name and brief are trimmed, and their limits enforced', () => {
  assert.equal(strict({ name: '  Breakfast  ' }).name, 'Breakfast');
  assert.throws(() => strict({ name: '   ' }), /name/);
  assert.throws(() => strict({ name: 'x'.repeat(SHOW_NAME_MAX + 1) }), /name/);
  assert.throws(() => strict({ topic: 'x'.repeat(SHOW_TOPIC_MAX + 1) }), /topic/);
});

test('the host must exist, and a guest may be neither the host nor a stranger', () => {
  assert.throws(() => strict({ personaId: 'p_nope' }), /personaId/);
  assert.deepEqual(strict({ guestPersonaIds: ['p_guest'] }).guestPersonaIds, ['p_guest']);
  assert.throws(() => strict({ guestPersonaIds: ['p_nope'] }), /guestPersonaIds/);
  assert.throws(() => strict({ guestPersonaIds: ['p_host'] }), /guestPersonaIds/);
});

test('list filters de-duplicate; genres do so case-insensitively', () => {
  assert.deepEqual(strict({ moods: ['chill', 'chill', 'upbeat'] }).moods, ['chill', 'upbeat']);
  assert.deepEqual(strict({ genres: ['Funk', 'funk', 'Soul'] }).genres, ['Funk', 'Soul']);
  assert.deepEqual(strict({ energies: ['low', 'low'] }).energies, ['low']);
});

test('moods must come from the live vocabulary', () => {
  assert.deepEqual(strict({ moods: ['chill'] }).moods, ['chill']);
  assert.throws(() => strict({ moods: ['not-a-mood'] }), /moods/);
});

test('era windows: open ends allowed, empty dropped, backwards rejected', () => {
  assert.deepEqual(strict({ eras: [{ fromYear: 1990, toYear: null }] }).eras,
    [{ fromYear: 1990, toYear: null }]);
  assert.deepEqual(strict({ eras: [{ fromYear: null, toYear: null }] }).eras, []);
  assert.deepEqual(
    strict({ eras: [{ fromYear: 1990, toYear: 1999 }, { fromYear: 1990, toYear: 1999 }] }).eras,
    [{ fromYear: 1990, toYear: 1999 }],
  );
  assert.throws(() => strict({ eras: [{ fromYear: 2000, toYear: 1990 }] }), /eras/);
  assert.throws(() => strict({ eras: [{ fromYear: 1800, toYear: null }] }), /eras/);
});

test('an unknown themeId is dropped to "", a known one preserved', () => {
  // #917: throwing here bricked every save on an install carrying a retired
  // palette id.
  assert.equal(strict({ themeId: 'vinyl' }).themeId, 'vinyl');
  assert.equal(strict({ themeId: 'sunset' }).themeId, '');
});

test('maxTrackSeconds honours the crossfade-derived floor, and 0 always passes', () => {
  // minTrackSeconds() here comes from the station default crossfade.
  assert.equal(strict({ maxTrackSeconds: 0 }).maxTrackSeconds, 0);
  assert.equal(strict({ maxTrackSeconds: 600 }).maxTrackSeconds, 600);
  assert.equal(strict({ maxTrackSeconds: '' }).maxTrackSeconds, null);
  assert.throws(() => strict({ maxTrackSeconds: 5 }), /maxTrackSeconds/);
  assert.throws(() => strict({ maxTrackSeconds: 1_000_000 }), /maxTrackSeconds/);
});

test('minTrackLengthSeconds is the cap\'s twin, not the cap', () => {
  // The FLOOR (#1573): null = inherit, 0 = no floor, >0 = this show's own,
  // sharing the cap's crossfade-derived lower bound.
  assert.equal(strict().minTrackLengthSeconds, null, 'absent = inherit = today');
  assert.equal(strict({ minTrackLengthSeconds: 0 }).minTrackLengthSeconds, 0);
  assert.equal(strict({ minTrackLengthSeconds: 120 }).minTrackLengthSeconds, 120);
  assert.equal(strict({ minTrackLengthSeconds: '' }).minTrackLengthSeconds, null);
  assert.equal(strict({ minTrackLengthSeconds: null }).minTrackLengthSeconds, null);
  assert.throws(() => strict({ minTrackLengthSeconds: 5 }), /minTrackLengthSeconds/);
  // Ceiling far below the cap's: a ten-hour floor picks nothing.
  assert.throws(() => strict({ minTrackLengthSeconds: 36000 }), /minTrackLengthSeconds/);
  assert.throws(() => strict({ minTrackLengthSeconds: 90.5 }), /minTrackLengthSeconds/);
});

test('a show may set a floor and a cap independently', () => {
  const s = strict({ minTrackLengthSeconds: 120, maxTrackSeconds: 600 });
  assert.equal(s.minTrackLengthSeconds, 120);
  assert.equal(s.maxTrackSeconds, 600);
});

test('booleans read as `=== true`, matching both paths before the schema', () => {
  // Deliberately not z.boolean(): load and save both treat a non-boolean as off.
  assert.equal(strict({ banter: true }).banter, true);
  assert.equal(strict({ banter: 'yes' }).banter, false);
  assert.equal(strict({ programme: 1 }).programme, false);
});

test('the array cap is enforced', () => {
  const many = Array.from({ length: SHOWS_LIMIT + 1 }, (_, i) => show({ name: `S${i}` }));
  assert.throws(() => validateShowsStrict(many, personas, themes, moodNames), /shows/);
});

test('a malformed id is re-minted, not rejected', () => {
  // Unlike webhooks: refusing would turn one bad id in a backup into a failed
  // restore.
  const s = strict({ id: 'NOT VALID' });
  assert.match(s.id, /^s_[a-z0-9]+$/);
  // A well-formed id survives untouched, so grid slots keep pointing at it.
  assert.equal(strict({ id: 's_abc123' }).id, 's_abc123');
});

test('duplicate ids across rows are re-minted', () => {
  const out = validateShowsStrict(
    [show({ id: 's_dupe01' }), show({ id: 's_dupe01' })], personas, themes, moodNames,
  );
  assert.equal(out[0].id, 's_dupe01');
  assert.notEqual(out[1].id, 's_dupe01');
});

test('the strict path MIGRATES a legacy singular field, as it always did', () => {
  // A pre-#929 backup restores through settings.update(), so refusing the
  // legacy singular fields would fail the restore.
  const s = strict({
    mood: 'chill', genre: 'funk, soul', energy: 'low',
    fromYear: 1990, toYear: 1999, maxTrackMinutes: 10,
  });
  assert.deepEqual(s.moods, ['chill']);
  assert.deepEqual(s.genres, ['funk', 'soul']);
  assert.deepEqual(s.energies, ['low']);
  assert.deepEqual(s.eras, [{ fromYear: 1990, toYear: 1999 }]);
  assert.equal(s.maxTrackSeconds, 600);
});

test('a migrated legacy value is judged by the same rules as a native one', () => {
  // Migration is not a free pass: a legacy value is judged by the plural rules.
  assert.throws(() => strict({ energy: 'bogus' }), /energies/);
  assert.throws(() => strict({ mood: 'not-a-mood' }), /moods/);
});

test('the migration lives in the SCHEMA, so POST /shows migrates too', () => {
  // The in-schema preprocess folds the legacy key into the plural list before
  // z.object strips it, so the route migrates too.
  const r = showSchema(ctx).safeParse(show({ mood: 'chill' }));
  assert.equal(r.success, true);
  assert.deepEqual(r.data!.moods, ['chill']);
});

test('the lenient path MIGRATES the same fields', () => {
  const [s] = normalizeShows([{
    name: 'Old', personaId: 'p_host',
    mood: 'chill', genre: 'funk, soul', energy: 'low',
    fromYear: 1990, toYear: 1999, maxTrackMinutes: 10,
  }], personaIds);
  assert.deepEqual(s.moods, ['chill']);
  // The comma-crammed legacy genre field splits into resolvable tags.
  assert.deepEqual(s.genres, ['funk', 'soul']);
  assert.deepEqual(s.energies, ['low']);
  assert.deepEqual(s.eras, [{ fromYear: 1990, toYear: 1999 }]);
  assert.equal(s.maxTrackSeconds, 600);
});

test('migrateLegacyShowFields leaves an already-plural show alone', () => {
  const out = migrateLegacyShowFields({ name: 'X', moods: ['chill'], mood: 'upbeat' });
  assert.deepEqual(out.moods, ['chill']);
  assert.equal('mood' in out, false);
});

test('load never throws, whatever settings.json holds', () => {
  for (const raw of [null, 'nope', 42, {}, [null], ['x'], [{}], [{ name: 7 }]]) {
    assert.doesNotThrow(() => normalizeShows(raw as unknown, personaIds));
  }
});

test('load drops a show with no identity or no owner', () => {
  assert.deepEqual(normalizeShows([{ personaId: 'p_host' }], personaIds), []);
  assert.deepEqual(normalizeShows([{ name: 'X', personaId: 'p_gone' }], personaIds), []);
});

test('load repairs what a working show can survive; strict rejects the same input', () => {
  const cases: Array<[Record<string, unknown>, (s: Record<string, any>) => void]> = [
    [{ name: 'x'.repeat(SHOW_NAME_MAX + 20) }, (s) => assert.equal(s.name.length, SHOW_NAME_MAX)],
    [{ vocals: 'nonsense' }, (s) => assert.equal(s.vocals, '')],
    [{ energies: ['low', 'bogus'] }, (s) => assert.deepEqual(s.energies, ['low'])],
    [{ maxTrackSeconds: 9_999_999 }, (s) => assert.ok(s.maxTrackSeconds <= 36000)],
    [{ minTrackLengthSeconds: 9_999_999 }, (s) => assert.ok(s.minTrackLengthSeconds <= 3600)],
    [{ eras: [{ fromYear: 2000, toYear: 1990 }] }, (s) => assert.deepEqual(s.eras, [])],
    [{ guestPersonaIds: ['p_host', 'p_gone', 'p_guest'] },
      (s) => assert.deepEqual(s.guestPersonaIds, ['p_guest'])],
  ];
  for (const [over, check] of cases) {
    const [s] = normalizeShows([show(over)], personaIds);
    assert.ok(s, `row dropped instead of repaired: ${JSON.stringify(over)}`);
    check(s as Record<string, any>);
    assert.throws(() => strict(over), JSON.stringify(over));
  }
});

test('load keeps an unknown mood; the strict path rejects it', () => {
  // Divergence expressed as CONTEXT (moodNames: null), not a second
  // implementation: load runs before the mood cache exists, so filtering
  // against seed defaults would strip the operator's own moods.
  const [s] = normalizeShows([show({ moods: ['operator-custom'] })], personaIds);
  assert.deepEqual(s.moods, ['operator-custom']);
  assert.throws(() => strict({ moods: ['operator-custom'] }), /moods/);
});

test('load keeps an unknown themeId; the strict path drops it', () => {
  const [s] = normalizeShows([show({ themeId: 'sunset' })], personaIds);
  assert.equal(s.themeId, 'sunset');
  assert.equal(strict({ themeId: 'sunset' }).themeId, '');
});

test('load caps the list at SHOWS_LIMIT', () => {
  const many = Array.from({ length: SHOWS_LIMIT + 9 }, (_, i) => show({ name: `S${i}` }));
  assert.equal(normalizeShows(many, personaIds).length, SHOWS_LIMIT);
});

test('load and save agree on which ids are valid', () => {
  // An id load keeps must be one save keeps, or the show changes identity and
  // empties its schedule slots.
  const [kept] = normalizeShows([show({ id: 's_abc123' })], personaIds);
  assert.equal(kept.id, 's_abc123');
  assert.equal(strict({ id: 's_abc123' }).id, 's_abc123');
});

test('a null context field means "unchecked", not "reject everything"', () => {
  const unchecked = showSchema({
    personaIds, moodNames: null, themeIds: null, minTrackSeconds: null,
  });
  const r = unchecked.safeParse(show({
    moods: ['whatever'], themeId: 'long-gone', maxTrackSeconds: 5,
  }));
  assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  assert.deepEqual(r.data!.moods, ['whatever']);
  assert.equal(r.data!.themeId, 'long-gone');
  assert.equal(r.data!.maxTrackSeconds, 5);
});

test('personaIds is never optional — both paths always check the host', () => {
  const s = showSchema({ personaIds: [], moodNames: null, themeIds: null, minTrackSeconds: null });
  assert.equal(s.safeParse(show()).success, false);
});

test('the same over-cap input fails on both paths, one by throwing and one by capping', () => {
  const tooMany = { genres: Array.from({ length: SHOW_FILTER_VALUES_MAX + 1 }, (_, i) => `G${i}`) };
  assert.throws(() => strict(tooMany), /genres/);
  const [s] = normalizeShows([show(tooMany)], personaIds);
  assert.equal(s.genres.length, SHOW_FILTER_VALUES_MAX);
});

test('a field error is keyed by the schema field name', () => {
  const r = showSchema(ctx).safeParse(show({ personaId: 'p_nope' }));
  assert.equal(r.success, false);
  assert.deepEqual(r.error!.issues[0].path, ['personaId']);
});

test('a nested field error keeps its full path', () => {
  const r = showSchema(ctx).safeParse(show({ eras: [{ fromYear: 1234567, toYear: null }] }));
  assert.equal(r.success, false);
  // flattenIssues emits 'eras.0.fromYear', which react-hook-form's setError wants.
  assert.deepEqual(r.error!.issues[0].path.slice(0, 2), ['eras', 0]);
});

test('explicit null reads as absent on every optional field', () => {
  // zod's .default() fires only on undefined, and update() re-validates the
  // whole array, so one null field would fail the entire shows/schedule save.
  const s = strict({
    topic: null, segmentSkill: null, themeId: null, vocals: null,
    moods: null, genres: null, energies: null, eras: null,
    guestPersonaIds: null, playlistIds: null, excludedPlaylistIds: null,
    tags: null,
  });
  assert.deepEqual(s.tags, []);
  assert.equal(s.topic, '');
  assert.equal(s.vocals, '');
  assert.equal(s.themeId, '');
  assert.deepEqual(s.moods, []);
  assert.deepEqual(s.eras, []);
  assert.deepEqual(s.guestPersonaIds, []);
  assert.deepEqual(s.playlistIds, []);
});

test('load survives one malformed entry in any list field', () => {
  // One non-string entry must not fail the schema and delete the whole show
  // on boot.
  const cases: Array<[Record<string, unknown>, (s: Record<string, any>) => void]> = [
    [{ moods: [null, 'chill'] }, (s) => assert.deepEqual(s.moods, ['chill'])],
    [{ playlistIds: [42, 'pl-ok'] }, (s) => assert.deepEqual(s.playlistIds, ['pl-ok'])],
    [{ excludedPlaylistIds: [{}, 'pl-x'] }, (s) => assert.deepEqual(s.excludedPlaylistIds, ['pl-x'])],
    [{ genres: [7, 'Funk'] }, (s) => assert.deepEqual(s.genres, ['Funk'])],
  ];
  for (const [over, check] of cases) {
    const rows = normalizeShows([show(over)], personaIds);
    assert.equal(rows.length, 1, `show dropped for ${JSON.stringify(over)}`);
    check(rows[0]);
  }
});

test('load survives an over-cap energies list full of duplicates', () => {
  // The schema's .max() runs BEFORE its dedup transform, so the lenient path
  // must cap pre-parse or duplicates drop the show.
  const energies = Array.from({ length: SHOW_FILTER_VALUES_MAX + 1 }, () => 'low');
  const rows = normalizeShows([show({ energies })], personaIds);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].energies, ['low']);
});

test('tags lowercase, trim, de-duplicate and keep first-seen order', () => {
  // The comma-string arm is the wire shape other tag surfaces send.
  assert.deepEqual(strict({ tags: ['  Late-Night ', 'FACTUAL', 'late-night'] }).tags,
    ['late-night', 'factual']);
  assert.deepEqual(strict({ tags: 'weekend, Archive' }).tags, ['weekend', 'archive']);
});

test('a malformed tag is REFUSED on save, unlike every other list on a show', () => {
  // Unlike moods/genres/skills, which drop a bad entry: a tag is typed by hand
  // and silently vanishing on save is the operator losing their own input.
  assert.throws(() => strict({ tags: ['-nope'] }), /tag/);
  assert.throws(() => strict({ tags: ['Has Space'] }), /tag/);
  assert.throws(() => strict({ tags: ['x'.repeat(SHOW_TAG_MAX + 1)] }), /tag/);
  assert.throws(
    () => strict({ tags: Array.from({ length: TAGS_PER_SHOW_LIMIT + 1 }, (_, i) => `t${i}`) }),
    /at most/,
  );
});

test('load DROPS a bad tag where save refuses it, and the cap survives junk', () => {
  const [s] = normalizeShows([{
    name: 'Breakfast',
    personaId: 'p_host',
    // Two valid, one invalid, one non-string, one duplicate.
    tags: ['late-night', '-nope', 42, 'LATE-NIGHT', 'factual'],
  }], personaIds);
  assert.deepEqual(s.tags, ['late-night', 'factual'], 'the show keeps its real tags');

  // The cap applies AFTER the validity filter, so junk cannot spend the budget.
  const junk = Array.from({ length: TAGS_PER_SHOW_LIMIT }, () => 'NOT A TAG');
  const [t] = normalizeShows([{
    name: 'Breakfast', personaId: 'p_host', tags: [...junk, 'kept'],
  }], personaIds);
  assert.deepEqual(t.tags, ['kept']);
});

test('a show with no tags round-trips byte-identically apart from the empty list', () => {
  // Absent must coerce to the pre-existing behaviour on both paths.
  const [loaded] = normalizeShows([{ name: 'Breakfast', personaId: 'p_host' }], personaIds);
  assert.deepEqual(loaded.tags, []);
  assert.deepEqual(strict().tags, loaded.tags);
});
