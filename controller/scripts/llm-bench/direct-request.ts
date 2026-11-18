// First-attempt interpretation + selection against a synthetic catalogue.
// Excludes route-level literal recovery, queue admission and intro generation;
// schema/transport failures are benchmark failures, not recovered-route results.
// Never queues music or contacts a station/library.
import { matchRequest } from '../../src/llm/dj.js';
import { directRequestUnsupported, requestName, resolveDirectRequest,
  type RequestMatch, type RequestSong, type RequestSelection, type RequestCatalog } from '../../src/music/request-match.js';
import type { KindSpec } from './kinds/types.js';

const songs: RequestSong[] = [
  { id: 'queen-rock', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock', language: 'English', moods: ['energetic'] },
  { id: 'queen-calm', title: 'Quiet Example', artist: 'Queen', album: 'Example Album', genre: 'Rock', language: 'English', moods: ['calm'] },
  { id: 'queen-french', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'Language Fixture', genre: 'Rock', language: 'French', moods: ['energetic'] },
  { id: 'something', title: 'Something', artist: 'The Beatles', album: 'Abbey Road', genre: 'Rock', language: 'English', moods: ['calm'] },
  { id: 'jazz', title: 'Jazz Example', artist: 'Fixture Trio', album: 'Fixture Jazz', genre: 'Jazz', language: 'English', moods: ['calm'] },
  { id: 'hiphop', title: 'Rhythm Example', artist: 'Fixture Duo', album: 'Fixture Beats', genre: 'Hip Hop', language: 'English' },
  { id: 'energetic', title: 'Fast Example', artist: 'Fixture Band', album: 'Fixture Energy', genre: 'Rock', language: 'English', moods: ['energetic'] },
  { id: 'named-live', title: 'Example Song (Live)', artist: 'Fixture Band', album: 'Fixture Energy', genre: 'Rock', language: 'English', moods: ['energetic'] },
];

export interface DirectRequestCase {
  name: string;
  text: string;
  ids?: string[];
  outcome: RequestSelection['outcome'];
  fields?: Partial<RequestMatch>;
}

export const directRequestCases: DirectRequestCase[] = [
  { name: 'named-song', text: 'Queen, Bohemian Rhapsody', ids: ['queen-rock', 'queen-french'], outcome: 'matched', fields: { title: 'Bohemian Rhapsody', artist: 'Queen', genre: null, language: null } },
  { name: 'polite-song', text: 'Could you play Bohemian Rhapsody by Queen please?', ids: ['queen-rock', 'queen-french'], outcome: 'matched', fields: { title: 'Bohemian Rhapsody', artist: 'Queen' } },
  { name: 'artist-only', text: 'Play something by Queen', ids: ['queen-rock', 'queen-calm', 'queen-french'], outcome: 'matched', fields: { artist: 'Queen', title: null } },
  { name: 'quoted-something', text: 'Play "Something" by The Beatles', ids: ['something'], outcome: 'matched', fields: { title: 'Something', artist: 'The Beatles' } },
  { name: 'named-album', text: 'Play a track from Abbey Road by The Beatles', ids: ['something'], outcome: 'matched', fields: { album: 'Abbey Road', title: null } },
  { name: 'genre', text: 'Play some jazz', ids: ['jazz'], outcome: 'matched', fields: { genre: 'Jazz', title: null } },
  { name: 'artist-mood', text: 'Play something calm by Queen', ids: ['queen-calm'], outcome: 'matched', fields: { artist: 'Queen', mood: 'calm', title: null } },
  { name: 'mood-compromise', text: 'Play something calm by Fixture Band', ids: ['energetic', 'named-live'], outcome: 'matched', fields: { artist: 'Fixture Band', mood: 'calm', title: null } },
  { name: 'named-song-language', text: 'Play Bohemian Rhapsody by Queen in French', ids: ['queen-french'], outcome: 'matched', fields: { title: 'Bohemian Rhapsody', language: 'French' } },
  { name: 'translated-language', text: 'Joue Bohemian Rhapsody de Queen en français', ids: ['queen-french'], outcome: 'matched', fields: { title: 'Bohemian Rhapsody', language: 'French' } },
  { name: 'canonical-genre', text: 'Play some hiphop', ids: ['hiphop'], outcome: 'matched', fields: { genre: 'Hip Hop', title: null } },
  { name: 'unavailable-language', text: 'Play Bohemian Rhapsody by Queen in German', outcome: 'no-match', fields: { title: 'Bohemian Rhapsody', language: 'German' } },
  { name: 'named-version', text: 'Play "Example Song (Live)" by Fixture Band', ids: ['named-live'], outcome: 'matched', fields: { title: 'Example Song (Live)' } },
  { name: 'exclusion', text: 'Play anything except Queen', outcome: 'unsupported' },
  { name: 'negative-condition', text: 'Play something by Queen but not live', outcome: 'unsupported' },
  { name: 'era-and-vocal', text: 'Play instrumental music from the 1990s', outcome: 'unsupported' },
  { name: 'film-identification', text: 'Play the song from that film I saw last week', outcome: 'unsupported' },
  { name: 'lyric-identification', text: 'Play the song with the lyrics "a fictional line I half remember"', outcome: 'unsupported' },
  { name: 'conversation-reference', text: 'Play the one we discussed earlier', outcome: 'unsupported' },
];

const catalog: RequestCatalog = {
  searchPage: async (query, { songOffset, songCount }) => {
    const hits = songs.filter(song => [song.title, song.artist, song.album].some(name => requestName(name).includes(requestName(query))));
    const page = hits.slice(songOffset, songOffset + songCount);
    return { songs: page, rawCount: page.length };
  },
  resolveArtist: async name => {
    const song = songs.find(song => requestName(song.artist) === requestName(name));
    return song ? { id: song.artist!, name: song.artist } : null;
  },
  getArtist: async id => ({ album: [...new Set(songs.filter(song => song.artist === id).map(song => song.album!))].map(name => ({ id: name, name })) }),
  getAlbum: async id => songs.filter(song => song.album === id),
  getTopSongs: async name => songs.filter(song => requestName(song.artist) === requestName(name)),
  resolveGenreName: async name => songs.find(song => requestName(song.genre) === requestName(name))?.genre || null,
  getGenres: async () => [...new Set(songs.map(song => song.genre!))].map(value => ({ value })),
  getSongsByGenreSampled: async genre => songs.filter(song => requestName(song.genre) === requestName(genre)),
};

export async function runDirectRequestCase(c: DirectRequestCase, interpret: (text: string) => Promise<RequestMatch> = matchRequest) {
  const plan = await interpret(c.text);
  const unsupported = directRequestUnsupported(c.text, plan);
  if (plan.kind === 'chat' && !unsupported.length) {
    return { plan, selection: { track: null, source: 'chat', outcome: 'no-match' as const, errors: [] } };
  }
  const selection = await resolveDirectRequest({ ...plan, unsupported }, {
    catalog, text: c.text, recentIds: new Set(), queuedIds: new Set(), random: () => 0,
    moodSongs: async mood => songs.filter(song => song.moods?.includes(mood)),
    fallbackSongs: async () => songs,
  });
  return { plan, selection };
}

export function checkDirectRequestCase(c: DirectRequestCase, out: Awaited<ReturnType<typeof runDirectRequestCase>>): string[] {
  const violations: string[] = [];
  if (out.selection.outcome !== c.outcome) violations.push(`selection:outcome:${out.selection.outcome}`);
  if (c.ids ? !c.ids.includes(out.selection.track?.id || '') : out.selection.track !== null) violations.push('selection:wrong-track');
  for (const [field, expected] of Object.entries(c.fields || {})) {
    if (requestName(out.plan[field as keyof RequestMatch]) !== requestName(expected)) violations.push(`interpretation:${field}`);
  }
  if (out.plan.kind === 'chat') violations.push('interpretation:music-classified-as-chat');
  return violations;
}

export const directRequestSpec: KindSpec = {
  kind: 'directRequestResolution', group: 'request', mode: 'any',
  scenarios: directRequestCases.map(c => ({
    name: c.name, run: () => runDirectRequestCase(c),
    check: out => checkDirectRequestCase(c, out as Awaited<ReturnType<typeof runDirectRequestCase>>),
  })),
};
