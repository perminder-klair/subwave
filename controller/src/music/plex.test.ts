import assert from 'node:assert/strict';
import { normalizePlexTrack } from './plex.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  FAIL ${name}\n      ${err?.message || err}`);
  }
}

const SAMPLE_PLEX_TRACK = {
  ratingKey: '3',
  title: 'Girls Like You',
  grandparentTitle: 'Maroon 5',
  parentTitle: 'Red Pill Blues',
  parentYear: 2017,
  duration: 235568,
  thumb: '/library/metadata/2/thumb/1782812114',
  Genre: [{ tag: 'Pop/Rock' }],
  Media: [{
    Part: [{ file: '/media/music/09 - Girls Like You.opus', key: '/library/parts/1/1782811927/file.opus' }]
  }]
};

test('normalizePlexTrack maps Plex track to SubWave Song shape', () => {
  const song = normalizePlexTrack(SAMPLE_PLEX_TRACK);
  assert.equal(song.id, 'plex:3');
  assert.equal(song.title, 'Girls Like You');
  assert.equal(song.artist, 'Maroon 5');
  assert.equal(song.album, 'Red Pill Blues');
  assert.equal(song.year, 2017);
  assert.equal(song.genre, 'Pop/Rock');
  assert.equal(song.duration, 235);
  assert.equal(song.path, '/media/music/09 - Girls Like You.opus');
});

test('normalizePlexTrack handles missing optional fields', () => {
  const minimal = {
    ratingKey: '99',
    title: 'Test',
    grandparentTitle: 'Artist',
    parentTitle: 'Album',
    Part: [{ file: '/music/test.mp3', key: '/library/parts/99/0/file.mp3' }],
  };
  const song = normalizePlexTrack(minimal);
  assert.equal(song.id, 'plex:99');
  assert.equal(song.year, undefined);
  assert.equal(song.genre, undefined);
  assert.equal(song.duration, undefined);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll tests passed');
}
