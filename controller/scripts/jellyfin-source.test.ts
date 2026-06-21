// Offline test for the Jellyfin provider's mapping + auth + URL building. Mocks
// fetch with a canned Jellyfin /Items response — no network.
// Run: tsx scripts/jellyfin-source.test.ts
//
// Connection config is read from config at import, so set env first.
process.env.JELLYFIN_URL = 'http://jf.test';
process.env.JELLYFIN_API_KEY = 'jf-key';
process.env.JELLYFIN_USER_ID = 'user-1';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const CANNED = {
  Items: [
    {
      Id: 'abc123', Name: 'Song One', Artists: ['The Artist'], AlbumArtist: 'The Artist',
      Album: 'The Album', AlbumId: 'alb1', ProductionYear: 2021, Genres: ['Rock'],
      RunTimeTicks: 2150000000, Path: '/music/the-artist/x.mp3', ImageTags: { Primary: 't' },
    },
  ],
  TotalRecordCount: 1,
};

let lastUrl = '';
let lastHeaders: any = {};
(globalThis as any).fetch = async (url: string, opts: any) => {
  lastUrl = String(url);
  lastHeaders = opts?.headers || {};
  return { ok: true, status: 200, json: async () => CANNED } as any;
};

const { jellyfinSource } = await import('../src/music/sources/jellyfin.js');
const { parseId } = await import('../src/music/source-kit.js');

console.log('jellyfin provider:');

const songs = await jellyfinSource.search('song', { songCount: 5 });
check('search returns mapped songs', songs.length === 1, `got ${songs.length}`);
check('sends X-Emby-Token header', lastHeaders['X-Emby-Token'] === 'jf-key');
check('request includes userId param', lastUrl.includes('userId=user-1'));
check('request asks for Audio items recursively', lastUrl.includes('IncludeItemTypes=Audio') && lastUrl.includes('Recursive=true'));

const s = songs[0];
check('id namespaced jf:', s.id === 'jf:abc123', s.id);
check('title mapped', s.title === 'Song One', s.title || '');
check('artist from Artists[0]', s.artist === 'The Artist', s.artist || '');
check('album mapped', s.album === 'The Album', s.album || '');
check('albumId namespaced', s.albumId === 'jf:alb1', s.albumId || '');
check('year mapped', s.year === 2021, String(s.year));
check('genre from Genres[0]', s.genre === 'Rock', s.genre || '');
check('duration ticks → seconds', s.duration === 215, String(s.duration));
check('path carried', s.path === '/music/the-artist/x.mp3');

const raw = parseId(s.id).raw;
const cover = jellyfinSource.getCoverArtUrl(raw, 256);
check('getCoverArtUrl builds Images/Primary with key', !!cover && cover.includes('/Items/abc123/Images/Primary') && cover.includes('api_key=jf-key') && cover.includes('maxWidth=256'), cover || '');
const stream = jellyfinSource.getRawStreamUrl(raw);
check('getRawStreamUrl builds /Audio/.../stream static=true', stream.includes('/Audio/abc123/stream') && stream.includes('static=true') && stream.includes('api_key=jf-key'));

const uri = jellyfinSource.getAnnotatedUri({ ...s, crossSec: 6 });
check('annotate wraps stream in subhttp:', uri.includes(':subhttp:http://jf.test/Audio/abc123/stream'));
check('annotate carries namespaced id', uri.includes('subsonic_id="jf:abc123"'));
check('annotate carries crossfade', uri.includes('liq_cross_duration="6"'));

check('capabilities: similar/genre/playlists/starred/lyrics/walk on, sonic off',
  jellyfinSource.capabilities.similar && jellyfinSource.capabilities.genre &&
  jellyfinSource.capabilities.playlists && jellyfinSource.capabilities.starred &&
  jellyfinSource.capabilities.lyrics && jellyfinSource.capabilities.libraryWalk &&
  !jellyfinSource.capabilities.sonicSimilarity);

check('isStationArchive matches the archive path pattern',
  jellyfinSource.isStationArchive({ Path: '/music/archive/2024-01-01/02-00.mp3' }) === true);
check('isStationArchive false for a normal track', jellyfinSource.isStationArchive({ Path: '/music/x.mp3', Name: 'Song One' }) === false);

if (failures) { console.error(`\n${failures} jellyfin test(s) failed.`); process.exit(1); }
console.log('\nAll jellyfin provider tests passed.');
