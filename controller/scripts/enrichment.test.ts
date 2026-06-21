// Offline tests for the provider-independent enrichers (Last.fm tags/similar +
// LRCLIB lyrics). Mocks fetch with canned responses — no network.
// Run: tsx scripts/enrichment.test.ts
process.env.LASTFM_API_KEY = 'test-key';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Route mocked responses by URL substring.
const routes: Array<{ match: string; body: any; status?: number }> = [];
let lastUrls: string[] = [];
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  lastUrls.push(u);
  const r = routes.find((x) => u.includes(x.match));
  if (!r) return { ok: false, status: 404, json: async () => ({}) } as any;
  return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as any;
};

const lastfm = await import('../src/music/enrichment/lastfm.js');
const lyrics = await import('../src/music/enrichment/lyrics.js');

console.log('lastfm enricher:');
check('isAvailable true when key present', lastfm.isAvailable());

routes.push({ match: 'method=artist.gettoptags', body: {
  toptags: { tag: [{ name: 'Hip-Hop', count: 100 }, { name: 'Conscious', count: 50 }, { name: 'underground', count: 10 }] },
} });
const tags = await lastfm.getArtistTags('Some Artist', { count: 2 });
check('getArtistTags lowercases + caps to count', JSON.stringify(tags) === JSON.stringify(['hip-hop', 'conscious']), JSON.stringify(tags));
check('sends api_key + autocorrect', lastUrls.some((u) => u.includes('api_key=test-key') && u.includes('autocorrect=1')));

routes.push({ match: 'method=track.getsimilar', body: {
  similartracks: { track: [
    { name: 'Track A', artist: { name: 'Artist A' } },
    { name: 'Track B', artist: { name: 'Artist B' } },
    { name: '', artist: { name: 'No Title' } },
  ] },
} });
const sim = await lastfm.getSimilarTracks('X', 'Y', { limit: 5 });
check('getSimilarTracks maps {artist,title} + drops empties', sim.length === 2 && sim[0].artist === 'Artist A' && sim[0].title === 'Track A', JSON.stringify(sim));

console.log('lyrics enricher:');
// /api/get returns plainLyrics directly.
routes.length = 0;
routes.push({ match: '/api/get', body: { plainLyrics: 'line one\nline two' } });
const lyr = await lyrics.getLyrics('Artist', 'Title', { durationSec: 200 });
check('getLyrics returns plain lyrics from /get', lyr === 'line one\nline two', JSON.stringify(lyr));
check('/get carries duration', lastUrls.some((u) => u.includes('/api/get') && u.includes('duration=200')));

// /api/get 404 → falls back to /api/search; synced lyrics get stripped.
routes.length = 0;
lastUrls = [];
routes.push({ match: '/api/search', body: [
  { plainLyrics: '', syncedLyrics: '[00:10.00] hello\n[00:12.50] world' },
] });
const lyr2 = await lyrics.getLyrics('Artist', 'Title');
check('falls back to /search and strips synced timestamps', lyr2 === 'hello\nworld', JSON.stringify(lyr2));

// No artist/title → '' without any network call.
lastUrls = [];
const empty = await lyrics.getLyrics('', 'Title');
check('empty artist → no request, returns ""', empty === '' && lastUrls.length === 0);

if (failures) { console.error(`\n${failures} enrichment test(s) failed.`); process.exit(1); }
console.log('\nAll enrichment tests passed.');
