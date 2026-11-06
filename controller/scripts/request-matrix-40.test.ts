import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyListenerRequest,
  directRequestUnsupported,
  modelFreeRequest,
  requestArtistMatches,
  resolveDirectRequest,
  type RequestCatalog,
  type RequestMatch,
  type RequestSong,
} from '../src/music/request-match.js';

// A deterministic catalogue matrix for the listener resolver. These are
// deliberately ordinary spoken requests, not unit-test-shaped inputs. The
// matrix exercises the public parser and resolver together without touching a
// station queue or depending on a remote provider.
const tracks: RequestSong[] = [
  { id: 'sadi-gali', title: 'Sadi Gali', artist: 'Lehmber Hussainpuri', album: 'Tanu Weds Manu', genre: 'Punjabi', language: 'Punjabi', moods: ['celebratory'], energy: 'high' },
  { id: 'tum-hi-ho', title: 'Tum Hi Ho', artist: 'Arijit Singh', album: 'Aashiqui 2', genre: 'Bollywood', language: 'Hindi', moods: ['romantic'], energy: 'medium' },
  { id: 'agar-tum', title: 'Agar Tum Saath Ho', artist: 'Alka Yagnik / Arijit Singh', album: 'Tamasha', genre: 'Bollywood', language: 'Hindi', moods: ['romantic'], energy: 'medium' },
  { id: 'letter-america', title: 'Letter from America', artist: 'The Proclaimers', album: 'Sunshine on Leith', genre: 'Rock', language: 'English' },
  { id: 'horse-name', title: 'A Horse with No Name', artist: 'America', album: 'America', genre: 'Rock', language: 'English' },
  { id: 'bohemian', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock', language: 'English', moods: ['dramatic'], energy: 'high' },
  { id: 'patient-zero', title: 'Patient Zero', artist: 'Taylor Swift', album: 'The Life of a Showgirl', genre: 'Pop', language: 'English' },
  { id: 'libaas', title: 'Libaas', artist: 'Kaka', album: 'Libaas', genre: 'Punjabi', language: 'Punjabi', moods: ['romantic'], energy: 'medium' },
  { id: 'mere-wala-sardar', title: 'Mere Wala Sardar', artist: 'Jugraj Sandhu', album: 'Mere Wala Sardar', genre: 'Punjabi', language: 'Punjabi', moods: ['celebratory'], energy: 'high', year: 2018 },
  { id: 'kesariya', title: 'Kesariya', artist: 'Arijit Singh', album: 'Brahmastra', genre: 'Bollywood', language: 'Hindi', moods: ['romantic'], energy: 'medium' },
  { id: 'challa', title: 'Challa', artist: 'Gurdas Maan', album: 'Punjabi Folk', genre: 'Punjabi', language: 'Punjabi', moods: ['reflective'], energy: 'low' },
  { id: 'despacito', title: 'Despacito', artist: 'Luis Fonsi', album: 'Vida', genre: 'Latin Pop', language: 'Spanish', moods: ['party'], energy: 'high' },
  { id: 'naatu', title: 'Naatu Naatu', artist: 'Rahul Sipligunj / Kaala Bhairava', album: 'RRR', genre: 'Indian Pop', language: 'Telugu', moods: ['party'], energy: 'high' },
  { id: 'shape', title: 'Shape of You', artist: 'Ed Sheeran', album: 'Divide', genre: 'Pop', language: 'English', moods: ['party'], energy: 'high' },
  { id: 'calm-jazz', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', language: 'Instrumental', moods: ['calm'], energy: 'low' },
  { id: 'similar-tum', title: 'Pee Loon', artist: 'Mohit Chauhan', album: 'Once Upon a Time in Mumbaai', genre: 'Bollywood', language: 'Hindi', moods: ['romantic'], energy: 'medium', _similarity: 0.92 },
  { id: 'hindi-title', title: 'चन्ना मेरेया', artist: 'Arijit Singh', album: 'Ae Dil Hai Mushkil', genre: 'Bollywood', language: 'Hindi', moods: ['sad'], energy: 'medium' },
];

const byId = new Map(tracks.map(track => [track.id, track]));
const ambiguousSadiGali: RequestSong = { id: 'sadi-gali-alt', title: 'Sadi Gali', artist: 'Cover Artist', album: 'Teno Weds Manu', genre: 'Punjabi', language: 'Punjabi' };
const artistIds = new Map<string, string>();
for (const track of tracks) {
  if (track.artist && !artistIds.has(track.artist)) artistIds.set(track.artist, `artist:${artistIds.size}`);
}

const catalog: RequestCatalog = {
  searchPage: async () => ({ songs: tracks, rawCount: tracks.length }),
  fuzzySearch: async () => tracks,
  resolveArtist: async name => {
    const track = tracks.find(candidate => requestArtistMatches(name, candidate));
    return track?.artist ? { id: artistIds.get(track.artist)!, name: track.artist } : null;
  },
  getArtist: async id => {
    const artist = [...artistIds.entries()].find(([, artistId]) => artistId === id)?.[0];
    const albums = tracks.filter(track => track.artist === artist).map(track => ({ id: `album:${track.id}`, name: track.album, year: track.year }));
    return { album: albums };
  },
  getAlbum: async id => {
    const track = tracks.find(candidate => `album:${candidate.id}` === id);
    return track ? [track] : [];
  },
  getTopSongs: async name => tracks.filter(track => requestArtistMatches(name, track)),
  resolveGenreName: async name => name,
  getGenres: async () => [...new Set(tracks.map(track => track.genre).filter((value): value is string => !!value))].map(value => ({ value })),
  getSongsByGenreSampled: async genre => tracks.filter(track => track.genre?.toLowerCase() === genre.toLowerCase()),
};

const deps = {
  catalog,
  recentIds: new Set<string>(),
  queuedIds: new Set<string>(),
  currentId: null as string | null,
  moodSongs: async (mood: string) => tracks.filter(track => track.moods?.includes(mood)),
  energySongs: async (energy: string) => tracks.filter(track => track.energy === energy),
  fallbackSongs: async () => [byId.get('calm-jazz')!],
  similarSongs: async () => [byId.get('similar-tum')!],
  similarSeedSongs: async (seedId: string) => seedId === 'tum-hi-ho' ? [byId.get('similar-tum')!] : [],
  exactOnly: true,
  random: () => 0,
};

type SelectionCase = { name: string; text: string; id?: string; outcome?: string; match?: RequestMatch };

const selectionCases: SelectionCase[] = [
  { name: 'exact title and artist', text: 'play Bohemian Rhapsody by Queen', id: 'bohemian' },
  { name: 'quoted title', text: 'queue "Shape of You" by Ed Sheeran', id: 'shape' },
  { name: 'one-edit title typo', text: 'play Bohemian Rhapsdy by Queen', id: 'bohemian' },
  { name: 'spoken number title', text: 'play Patient Zero by Taylor Swift', id: 'patient-zero' },
  { name: 'title containing from', text: 'play Letter from America by The Proclaimers', id: 'letter-america' },
  { name: 'horse title with stop words', text: 'play A Horse with No Name by America', id: 'horse-name' },
  { name: 'artist-only request', text: 'play something by Queen', id: 'bohemian' },
  { name: 'title-only request', text: 'play Kesariya', id: 'kesariya' },
  { name: 'credit-separated artist', text: 'play Agar Tum Saath Ho by Arijit Singh', id: 'agar-tum' },
  { name: 'exact movie context', text: 'play Tum Hi Ho from Aashiqui 2', id: 'tum-hi-ho' },
  { name: 'misspelled movie context', text: 'play Sadi Gali from Tenu Weds Manu', id: 'sadi-gali' },
  { name: 'misspelled album context', text: 'play Libaas from Libas', id: 'libaas' },
  { name: 'soundtrack wrapper context', text: 'play Agar Tum Saath Ho from the movie Tamasha', id: 'agar-tum' },
  { name: 'native-script title', text: 'play चन्ना मेरेया by Arijit Singh', id: 'hindi-title' },
  { name: 'Hindi language request', text: 'play Hindi music', id: 'tum-hi-ho' },
  { name: 'Punjabi language request', text: 'play Punjabi music', id: 'sadi-gali' },
  { name: 'genre request', text: 'play some jazz', id: 'calm-jazz' },
  { name: 'mood request', text: 'play romantic music', id: 'tum-hi-ho' },
  { name: 'combined language and mood', text: 'play romantic Hindi music', id: 'tum-hi-ho' },
  { name: 'named similarity', text: 'play something like Tum Hi Ho', id: 'similar-tum' },
  { name: 'generic similarity fallback', text: 'play something like this', id: 'similar-tum' },
  { name: 'latest artist request', text: 'play the latest song by Jugraj Sandhu', id: 'mere-wala-sardar', match: { title: null, artist: 'Jugraj Sandhu', sort: 'latest', scope: 'song' } },
  { name: 'Spanish language request', text: 'play Spanish music', id: 'despacito' },
  { name: 'Telugu language request', text: 'play Telugu music', id: 'naatu' },
  { name: 'music with punctuation', text: 'play "Naatu Naatu"', id: 'naatu' },
  { name: 'title and album exact', text: 'play Blue in Green from Kind of Blue', id: 'calm-jazz' },
  { name: 'title with artist spelling case', text: 'play mere wala sardar by JUGRAJ SANDHU', id: 'mere-wala-sardar' },
  { name: 'Latin title and artist', text: 'request Despacito by Luis Fonsi', id: 'despacito' },
  { name: 'folk artist title', text: 'play Challa by Gurdas Maan', id: 'challa' },
];

for (const item of selectionCases) {
  test(`40-case request matrix: ${item.name}`, async () => {
    const match = item.match || modelFreeRequest(item.text);
    const result = await resolveDirectRequest(match, { ...deps, text: item.text });
    assert.equal(result.track?.id, item.id, `${item.text} parsed as ${JSON.stringify(match)} and resolved ${JSON.stringify(result)}`);
    if (item.outcome) assert.equal(result.outcome, item.outcome);
    assert.notEqual(result.outcome, 'unsupported');
  });
}

const safetyCases = [
  ['sequel context must not widen', 'play Tum Hi Ho from Aashiqui 3', 'no-match'],
  ['ambiguous fuzzy context must refuse', 'play Sadi Gali from Tenu Weds Manu', 'no-match'],
  ['wrong named title must not substitute', 'play Impossible Song 918273 by Queen', 'no-match'],
  ['unknown artist must not substitute', 'play a song by Artist That Does Not Exist', 'no-match'],
  ['standalone album typo remains bounded', 'play the album Libas', 'no-match'],
] as const;

for (const [name, text, expected] of safetyCases) {
  test(`40-case request matrix safety: ${name}`, async () => {
    const safetyDeps = name === 'ambiguous fuzzy context must refuse'
      ? { ...deps, catalog: { ...catalog, searchPage: async () => ({ songs: [...tracks, ambiguousSadiGali], rawCount: tracks.length + 1 }) } }
      : name === 'standalone album typo remains bounded' ? { ...deps, similarSongs: undefined } : deps;
    const result = await resolveDirectRequest(modelFreeRequest(text), { ...safetyDeps, text });
    assert.equal(result.outcome, expected, `${text} resolved as ${JSON.stringify(result)}`);
    assert.equal(result.track, null);
  });
}

const parserCases = [
  ['lyrics classification', 'tell me the words to Tum Hi Ho', 'lyrics-or-description'],
  ['film identification classification', 'play the song from the new Dune movie', 'lyrics-or-description'],
  ['attribute classification', 'play energetic Punjabi music', 'attributes'],
  ['ambiguous classification', 'surprise me', 'ambiguous-music'],
  ['chat classification', 'how are you today', 'non-music-chat'],
] as const;

for (const [name, text, expected] of parserCases) {
  test(`40-case request matrix parser: ${name}`, () => {
    assert.equal(classifyListenerRequest(text), expected);
  });
}

test('40-case request matrix: explicit unsupported conditions remain honest', () => {
  for (const text of [
    'play music from the 1990s',
    'play only acoustic songs',
    'play a song from a movie',
    'play a song with the words dancing in the rain',
  ]) assert.ok(directRequestUnsupported(text).length, text);
});
