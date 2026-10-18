import assert from 'node:assert/strict';
import test from 'node:test';
import { GENRE_FAMILIES, genreFamilyOf, genreKeysWithFamilies } from '../src/broadcast/dj-agent/genre-families.js';
import { aliasMapOf, sceneKey } from '../src/music/scene-vocab.js';

const none = new Map<string, string>();

test('the family map is small, normalized, and puts each label in one family', () => {
  const seen = new Map<string, string>();
  for (const [family, labels] of Object.entries(GENRE_FAMILIES)) {
    assert.ok(labels.length >= 2, `${family} has a reason to exist`);
    for (const label of labels) {
      assert.equal(label, sceneKey(label), `${label} is written in its normalized form`);
      assert.equal(seen.get(label), undefined, `${label} appears in ${seen.get(label)} and ${family}`);
      seen.set(label, family);
    }
  }
  assert.ok(Object.keys(GENRE_FAMILIES).length <= 15, 'a signal to look again if this grows');
});

test('family lookup is case and space insensitive', () => {
  assert.equal(genreFamilyOf('Roots   Reggae'), 'reggae');
  assert.equal(genreFamilyOf(' DUB '), 'reggae');
  assert.equal(genreFamilyOf('Rocksteady'), 'reggae');
  assert.equal(genreFamilyOf('Boom Bap'), 'hip hop');
  assert.equal(genreFamilyOf('Hard Bop'), 'jazz');
});

test('arguable labels stay out of every family', () => {
  for (const label of ['trip hop', 'jazz fusion', 'blues rock', 'post-punk', 'country rock', 'dubstep', 'soul', 'funk', 'pop']) {
    assert.equal(genreFamilyOf(label), null, label);
  }
});

test('keys keep the label and add one family token per labelled family', () => {
  assert.deepEqual([...genreKeysWithFamilies(['Roots Reggae', 'Dub'], none)].sort(), ['dub', 'family:reggae', 'roots reggae']);
  assert.deepEqual([...genreKeysWithFamilies(['Soul'], none)], ['soul'], 'unknown label: label overlap only');
  assert.deepEqual([...genreKeysWithFamilies([null, 42, '', '  '], none)], []);
});

test('scene aliases resolve first, then the family applies', () => {
  const aliases = aliasMapOf([{ from: 'jamaican roots', to: 'Roots Reggae', at: '' }]);
  assert.deepEqual([...genreKeysWithFamilies(['Jamaican Roots'], aliases)].sort(), ['family:reggae', 'roots reggae']);
});
