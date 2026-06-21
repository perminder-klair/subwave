// Unit test for the music-source accessor + id helpers (no network).
// Run: tsx scripts/source.test.ts

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const { parseId, namespaceId, getSource, getSourceByKey } = await import('../src/music/source.js');

console.log('id helpers:');
check('namespaceId prefixes by provider', namespaceId('jamendo', '123') === 'jam:123');
check('namespaceId unknown provider → bare', namespaceId('???', '123') === '123');
check('parseId reads a known prefix', JSON.stringify(parseId('jam:123')) === JSON.stringify({ provider: 'jamendo', raw: '123' }));
check('parseId nd: → navidrome', parseId('nd:abc').provider === 'navidrome');
check('parseId bare id → provider null, raw passthrough',
  parseId('0c5e1a').provider === null && parseId('0c5e1a').raw === '0c5e1a');
check('parseId unknown prefix → treated as bare',
  parseId('zz:foo').provider === null && parseId('zz:foo').raw === 'zz:foo');
check('parseId tolerates a colon in a bare id',
  parseId('weird:id:here').provider === null);

console.log('accessor / registry:');
// Default provider (no env, settings unloaded → DEFAULTS.source.provider).
check('getSource() defaults to navidrome', getSource().key === 'navidrome');
check('getSourceByKey(navidrome) → navidrome', getSourceByKey('navidrome').key === 'navidrome');
check('getSourceByKey(subsonic) alias → navidrome', getSourceByKey('subsonic').key === 'navidrome');
check('getSourceByKey(jamendo) → jamendo', getSourceByKey('jamendo').key === 'jamendo');
check('getSourceByKey(bogus) → active source fallback', getSourceByKey('bogus').key === 'navidrome');

// Every provider implements the full interface surface (the capability-gated
// methods come from emptyDiscovery when not overridden).
const REQUIRED = [
  'search', 'getRandomSongs', 'getAnnotatedUri', 'getCoverArtUrl', 'isStationArchive',
  'getSongsByGenre', 'getSimilarSongs', 'getStarred', 'getPlaylists', 'getAlbum',
  'getArtist', 'searchArtists', 'getTopSongs', 'iterateAllSongs', 'getLyrics',
  'getArtistLastfmTags', 'getRawStreamUrl', 'supportsSonicSimilarity',
];
for (const key of ['navidrome', 'jamendo']) {
  const src: any = getSourceByKey(key);
  const missing = REQUIRED.filter((m) => typeof src[m] !== 'function');
  check(`${key} implements the full method surface`, missing.length === 0, `missing: ${missing.join(', ')}`);
}

if (failures) { console.error(`\n${failures} source test(s) failed.`); process.exit(1); }
console.log('\nAll source tests passed.');
