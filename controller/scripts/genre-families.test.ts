import assert from 'node:assert/strict';
import test from 'node:test';
import { GENRE_FAMILIES, genreKeysWithFamilies } from '../src/broadcast/dj-agent/genre-families.js';
import { sceneKey } from '../src/music/scene-vocab.js';

const keysOf = (labels: readonly unknown[]) => [...genreKeysWithFamilies(labels).keys()].sort();
const familyOf = (label: string) => keysOf([label]).find(key => key.startsWith('family:'))?.slice('family:'.length) ?? null;

test('the family map is small, normalized, and puts each label in one family', () => {
  const seen = new Map<string, string>();
  for (const [family, labels] of Object.entries(GENRE_FAMILIES)) {
    assert.ok(labels.length >= 2, `${family} has a reason to exist`);
    for (const label of labels) {
      assert.equal(label, sceneKey(label), `${label} is written lower case`);
      const [key] = keysOf([label]).filter(k => !k.startsWith('family:'));
      assert.equal(seen.get(key), undefined, `${label} appears in ${seen.get(key)} and ${family}`);
      seen.set(key, family);
    }
  }
  assert.ok(Object.keys(GENRE_FAMILIES).length <= 15, 'a signal to look again if this grows');
});

test('family lookup is case and space insensitive', () => {
  assert.equal(familyOf('Roots   Reggae'), 'reggae');
  assert.equal(familyOf(' DUB '), 'reggae');
  assert.equal(familyOf('Rocksteady'), 'reggae');
  assert.equal(familyOf('Boom Bap'), 'hip hop');
  assert.equal(familyOf('Hard Bop'), 'jazz');
});

test('arguable labels stay out of every family', () => {
  for (const label of ['trip hop', 'jazz fusion', 'blues rock', 'post-punk', 'country rock', 'dubstep', 'soul', 'funk', 'pop']) {
    assert.equal(familyOf(label), null, label);
  }
});

test('keys keep the label and add one family token per labelled family', () => {
  assert.deepEqual(keysOf(['Roots Reggae', 'Dub']), ['dub', 'family:reggae', 'rootsreggae']);
  assert.deepEqual(keysOf(['Soul']), ['soul'], 'unknown label: label overlap only');
  assert.deepEqual(keysOf([null, 42, '', '  ', '-/-']), []);
});

test('each key is named as the track first spells it, a family token as its family', () => {
  const keys = genreKeysWithFamilies(['  Roots   Reggae ', 'roots-reggae', 'Neo-Soul']);
  assert.deepEqual([...keys], [['rootsreggae', 'Roots Reggae'], ['family:reggae', 'reggae family'], ['neosoul', 'Neo-Soul']]);
});

test('separators and ampersands fold for every label, in a family or not', () => {
  for (const label of ['Hip-Hop', 'hip/hop', 'Hip  Hop', 'HIP_HOP', 'Hip Hop.', 'HipHop']) assert.equal(familyOf(label), 'hip hop', label);
  assert.equal(familyOf('Drum & Bass'), 'drum and bass');
  assert.equal(familyOf('drum-n-bass'), null, 'only separators fold, not spellings');
  assert.equal(familyOf('Alt Country'), 'country');
  assert.equal(familyOf('Avant Garde Jazz'), 'jazz');
  assert.equal(familyOf('Oi!'), 'punk');
  assert.equal(familyOf('Lovers-Rock'), 'reggae');
  // Labels in no family fold the same way, so one genre spelled two ways is one run.
  for (const [a, b] of [['Neo-Soul', 'Neo Soul'], ['R&B', 'R & B'], ['Synth-Pop', 'Synthpop'], ['Lo-Fi', 'lo fi']]) {
    assert.deepEqual(keysOf([a]), keysOf([b]), `${a} / ${b}`);
  }
  assert.notDeepEqual(keysOf(['Soul']), keysOf(['Neo Soul']), 'a different genre keeps its own key');
});
