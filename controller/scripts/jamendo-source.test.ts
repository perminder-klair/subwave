// Offline test for the Jamendo provider's mapping + annotate logic. Mocks fetch
// with a canned Jamendo v3.0 response so it never touches the network — verifies
// toSong mapping, entity decode, id namespacing, cover/stream caching, and the
// subhttp: annotate URI. Run: tsx scripts/jamendo-source.test.ts
//
// The client_id must be set BEFORE importing config (read at import), so set env
// first, then dynamic-import the provider.
process.env.JAMENDO_CLIENT_ID = 'test-client-id';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const CANNED = {
  headers: { status: 'success', results_count: 2 },
  results: [
    {
      id: '1886710',
      name: 'Sun &amp; Moon',
      artist_name: 'Beyonc&eacute;',
      album_name: 'Caf&eacute; Days',
      album_id: '500',
      releasedate: '2019-04-01',
      duration: 215,
      album_image: 'https://usercontent.jamendo.com/album/500/cover.jpg',
      audio: 'https://prod-1.storage.jamendo.com/?trackid=1886710&format=mp31',
      musinfo: { tags: { genres: ['pop', 'electronic'], vartags: ['chill'] } },
    },
    {
      id: '1886711',
      name: 'Second Track',
      artist_name: 'Another Artist',
      album_name: 'Some Album',
      album_id: '501',
      releasedate: '2020',
      duration: 180,
      image: 'https://usercontent.jamendo.com/album/501/cover.jpg',
      audio: 'https://prod-1.storage.jamendo.com/?trackid=1886711&format=mp31',
      musinfo: { tags: { genres: ['rock'] } },
    },
  ],
};

let lastUrl = '';
(globalThis as any).fetch = async (url: string) => {
  lastUrl = String(url);
  return { ok: true, status: 200, json: async () => CANNED } as any;
};

const { jamendoSource } = await import('../src/music/sources/jamendo.js');
const { parseId } = await import('../src/music/source-kit.js');

console.log('jamendo provider:');

const songs = await jamendoSource.search('sun', { songCount: 5 });
check('search returns mapped songs', songs.length === 2, `got ${songs.length}`);
check('client_id + format on the request', lastUrl.includes('client_id=test-client-id') && lastUrl.includes('format=json'));

const s = songs[0];
check('id is namespaced jam:', s.id === 'jam:1886710', s.id);
check('entities decoded in title', s.title === 'Sun & Moon', s.title || '');
check('entities decoded in artist', s.artist === 'Beyoncé', s.artist || '');
check('entities decoded in album', s.album === 'Café Days', s.album || '');
check('albumId namespaced', s.albumId === 'jam:500', s.albumId || '');
check('year parsed', s.year === 2019, String(s.year));
check('duration carried', s.duration === 215, String(s.duration));
check('genre from tags', s.genre === 'pop', s.genre || '');
check('cover url carried', s.coverArt === 'https://usercontent.jamendo.com/album/500/cover.jpg');
check('stream url stashed', s._streamUrl?.includes('trackid=1886710'));

// Cover lookup uses the RAW id (as /cover/:id would after parseId).
const coverRaw = parseId(s.id).raw;
check('getCoverArtUrl resolves cached cover by raw id',
  jamendoSource.getCoverArtUrl(coverRaw) === 'https://usercontent.jamendo.com/album/500/cover.jpg');
check('getRawStreamUrl resolves cached stream by raw id',
  jamendoSource.getRawStreamUrl(coverRaw).includes('trackid=1886710'));

// Annotate URI: subhttp-wrapped audio, namespaced subsonic_id, decoded metadata.
const uri = jamendoSource.getAnnotatedUri({ ...s, crossSec: 8, gainDb: -2 });
check('annotate wraps audio in subhttp:', uri.includes(':subhttp:https://prod-1.storage.jamendo.com'));
check('annotate carries namespaced id', uri.includes('subsonic_id="jam:1886710"'));
check('annotate carries decoded title', uri.includes('title="Sun & Moon"'));
check('annotate carries crossfade', uri.includes('liq_cross_duration="8"'));
check('annotate carries gain', uri.includes('liq_amplify="-2 dB"'));

// Capability honesty: no starred/playlists/walk; has pool/similar/genre.
check('capabilities: pool+similar+genre on, starred/playlists/walk off',
  jamendoSource.capabilities.pool && jamendoSource.capabilities.similar &&
  jamendoSource.capabilities.genre && !jamendoSource.capabilities.starred &&
  !jamendoSource.capabilities.playlists && !jamendoSource.capabilities.libraryWalk);
check('isStationArchive always false', jamendoSource.isStationArchive(s) === false);

// Empty client_id → graceful empty (no throw). Re-import with a fresh module is
// overkill; instead verify the no-op discovery methods return empties.
check('getStarred → [] (capability off)', (await jamendoSource.getStarred()).length === 0);
check('getPlaylists → [] (capability off)', (await jamendoSource.getPlaylists()).length === 0);

if (failures) { console.error(`\n${failures} jamendo test(s) failed.`); process.exit(1); }
console.log('\nAll jamendo provider tests passed.');
