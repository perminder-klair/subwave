// Offline test for the local-folder provider. Builds a temp directory of dummy
// files (tags unreadable → title falls back to filename), then exercises the
// walk / search / annotate / archive-exclusion. No network.
// Run: tsx scripts/local-source.test.ts
//
// MUSIC_LOCAL_DIR is read from config at import, so create the dir + set env
// BEFORE importing the provider.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const base = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : tmpdir();
const dir = mkdtempSync(join(base, 'local-src-'));
writeFileSync(join(dir, 'Cool Song.mp3'), 'not really audio');
mkdirSync(join(dir, 'sub'));
writeFileSync(join(dir, 'sub', 'Another Track.flac'), 'nope');
mkdirSync(join(dir, 'archive', '2024-01-01'), { recursive: true });
writeFileSync(join(dir, 'archive', '2024-01-01', '02-00.mp3'), 'x'); // station mixdown — must be excluded
writeFileSync(join(dir, 'notes.txt'), 'ignore me'); // non-audio — must be skipped
process.env.MUSIC_LOCAL_DIR = dir;

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const { localSource } = await import('../src/music/sources/local.js');
const { parseId } = await import('../src/music/source-kit.js');

console.log('local provider:');

const all: any[] = [];
for await (const s of localSource.iterateAllSongs()) all.push(s);
check('walks audio files, excludes archive + non-audio', all.length === 2, `got ${all.length}: ${all.map(s => s.title).join(', ')}`);

const titles = all.map((s) => s.title).sort();
check('title falls back to filename when tags unreadable', JSON.stringify(titles) === JSON.stringify(['Another Track', 'Cool Song']), JSON.stringify(titles));
check('ids namespaced local:', all.every((s) => s.id.startsWith('local:')));
check('absolute file path carried', all.every((s) => s.path && s.path.startsWith(dir)));

const cool = all.find((s) => s.title === 'Cool Song');
const found = await localSource.search('cool', { songCount: 5 });
check('search matches by filename/title', found.length === 1 && found[0].title === 'Cool Song', String(found.length));
const found2 = await localSource.search('track', { songCount: 5 });
check('search matches the nested track', found2.length === 1 && found2[0].title === 'Another Track');

const rand = await localSource.getRandomSongs({ size: 10 });
check('getRandomSongs returns the pool', rand.length === 2, String(rand.length));

const uri = localSource.getAnnotatedUri({ ...cool, crossSec: 4 });
check('annotate plays the bare file path (no subhttp)', uri.includes(`:${cool.path}`) && !uri.includes('subhttp:'), uri);
check('annotate carries namespaced id', uri.includes(`subsonic_id="${cool.id}"`));
check('annotate carries crossfade', uri.includes('liq_cross_duration="4"'));

check('getCoverArtUrl is null (no embedded-art serving in v1)', localSource.getCoverArtUrl(parseId(cool.id).raw) === null);
check('getRawStreamUrl is empty (analysis skips local)', localSource.getRawStreamUrl(parseId(cool.id).raw) === '');

check('capabilities: pool/genre/recentlyAdded/artistGraph/walk on; similar/starred/playlists/lyrics off',
  localSource.capabilities.pool && localSource.capabilities.genre &&
  localSource.capabilities.recentlyAdded && localSource.capabilities.artistGraph &&
  localSource.capabilities.libraryWalk && !localSource.capabilities.similar &&
  !localSource.capabilities.starred && !localSource.capabilities.playlists &&
  !localSource.capabilities.lyrics && !localSource.capabilities.frequent);

check('isStationArchive matches the archive path', localSource.isStationArchive({ path: join(dir, 'archive', '2024-01-01', '02-00.mp3') }) === true);
check('isStationArchive false for a normal track', localSource.isStationArchive({ path: cool.path }) === false);

if (failures) { console.error(`\n${failures} local test(s) failed.`); process.exit(1); }
console.log('\nAll local provider tests passed.');
