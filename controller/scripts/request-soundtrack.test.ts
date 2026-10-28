import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSoundtrackResolutionCache,
  resolveSoundtrackCandidates,
  type SoundtrackProvider,
  type SoundtrackProviderTracklist,
} from '../src/music/request-soundtrack.js';

const context = { name: 'The Devil Wears Prada 2', kind: 'movie' as const, explicit: true };

function tracklist(source: 'musicbrainz' | 'lastfm', rows: Array<[string, string | string[]]>): SoundtrackProviderTracklist[] {
  return [{
    source,
    releaseName: 'The Devil Wears Prada 2 (Music from the Motion Picture)',
    tracks: rows.map(([title, artist], index) => ({
      title,
      artists: Array.isArray(artist) ? artist : [artist],
      order: index + 1,
      source,
    })),
  }];
}

function provider(primary: SoundtrackProviderTracklist[], secondary?: SoundtrackProviderTracklist[]): SoundtrackProvider {
  return {
    musicbrainz: async () => primary,
    lastfm: async () => secondary || [],
  };
}

test('matches the one local soundtrack track among a larger external tracklist', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local-shape', title: 'Shape of Woman', artist: 'Lady Gaga' },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `other-${index}`, title: `Other Track ${index}`, artist: 'Other Artist' })),
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [
      ['Shape of a Woman', 'Lady Gaga'],
      ['Other Track 0', 'Not in Library'],
    ])),
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'local-shape');
});

test('never turns a same-artist title collision into a soundtrack match', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'wrong', title: 'One', artist: 'U2' },
    { id: 'right', title: 'Someone Like Me', artist: 'U2' },
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [['Someone Like Me', 'U2']])),
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'right');
});

test('matches soundtrack credits stored as a combined local artist string', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local', title: 'Khaabon Ke Parinday', artist: 'Alyssa Mendonsa & Mohit Chauhan' },
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [[
      'Khaabon Ke Parinday', ['Alyssa Mendonsa', 'Mohit Chauhan'],
    ]])),
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'local');
});

test('matches comma and and soundtrack credits in local metadata', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local', title: 'Sooraj Ki Baahon Mein', artist: 'Dominique Cerejo, Clinton Cerejo and Loy Mendonsa' },
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [[
      'Sooraj Ki Baahon Mein', ['Dominique Cerejo', 'Clinton Cerejo', 'Loy Mendonsa'],
    ]])),
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'local');
});

test('allows provider credits that include omitted featured artists', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local', title: 'Dildaara (Stand by Me)', artist: 'Shafqat Amanat Ali' },
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [[
      'Dildaara (Stand by Me)', ['Shafqat Amanat Ali', 'Vishal Dadlani', 'Shekhar Ravjiani', 'Clinton Cerejo'],
    ]])),
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'local');
});

test('matches soundtrack credits independently of local join formatting and keeps alternates in the pool', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'subha', title: 'Subha Hone Na De', artist: 'Mika Singh & Shefali Alvares' },
    { id: 'allah', title: 'Allah Maaf Kare', artist: 'Sonu Nigam & Shilpa Rao' },
    { id: 'let', title: 'Let It Be', artist: 'Shaan' },
    { id: 'jhak', title: 'Jhak Maar Ke', artist: 'Neeraj Shridhar | Harshdeep Kaur' },
    { id: 'jhak-extra', title: 'Jhak Maar Ke', artist: 'Pritam / Neeraj Shridhar / Harshdeep Kaur / Irshad Kamil' },
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [
      ['Subha Hone Na De', ['Mika Singh', 'Shefali Alvares']],
      ['Jhak Maar Ke', ['Neeraj Shridhar', 'Harshdeep Kaur']],
      ['Allah Maaf Kare', ['Sonu Nigam', 'Shilpa Rao']],
      ['Let It Be', 'Shaan'],
    ])),
  });
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.status === 'matched' ? result.candidates.map(candidate => candidate.id).sort() : [], ['allah', 'jhak', 'let', 'subha']);
});

test('does not match a soundtrack credit that is only part of a local combined credit', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local', title: 'Khaabon Ke Parinday', artist: 'Earth, Wind & Fire' },
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [[
      'Khaabon Ke Parinday', 'Fire',
    ]])),
  });
  assert.deepEqual(result, { status: 'no-match', reason: 'no-local-match' });
});

test('does not accept Last.fm-only evidence as a local identity', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local', title: 'Shape of Woman', artist: 'Lady Gaga' },
  ], {
    enabled: true,
    provider: provider([], tracklist('lastfm', [['Shape of a Woman', 'Lady Gaga']])),
  });
  assert.deepEqual(result, { status: 'no-match', reason: 'no-soundtrack' });
});

test('uses Last.fm as a bounded provider recovery only with matching local album evidence', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local', title: 'Shape of Woman', artist: 'Lady Gaga', album: 'The Devil Wears Prada 2' },
  ], {
    enabled: true,
    provider: {
      musicbrainz: async () => { throw Error('MusicBrainz unavailable'); },
      lastfm: async () => tracklist('lastfm', [['Shape of Woman', 'Lady Gaga']]),
    },
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.source, 'lastfm');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'local');
});

test('marks agreeing MusicBrainz and Last.fm evidence as corroborated', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'local', title: 'Shape of Woman', artist: 'Lady Gaga' },
  ], {
    enabled: true,
    provider: provider(
      tracklist('musicbrainz', [['Shape of a Woman', 'Lady Gaga']]),
      tracklist('lastfm', [['Shape of a Woman', 'Lady Gaga']]),
    ),
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.source, 'musicbrainz+lastfm');
  assert.equal(result.status === 'matched' && result.candidates[0]?.soundtrackSource, 'musicbrainz+lastfm');
});

test('network-disabled lookup makes no provider call', async () => {
  clearSoundtrackResolutionCache();
  let calls = 0;
  const result = await resolveSoundtrackCandidates(context, [], {
    enabled: false,
    provider: { musicbrainz: async () => { calls++; return []; } },
  });
  assert.deepEqual(result, { status: 'disabled', reason: 'network-disabled' });
  assert.equal(calls, 0);
});

test('a numeric sequel remains distinct from the unnumbered soundtrack', async () => {
  clearSoundtrackResolutionCache();
  const result = await resolveSoundtrackCandidates(context, [
    { id: 'old', title: 'Shape of Woman', artist: 'Lady Gaga' },
  ], {
    enabled: true,
    provider: provider(tracklist('musicbrainz', [['Shape of a Woman', 'Lady Gaga']])),
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'old');
});

test('tries compact punctuation when a release group joins spoken title words', async t => {
  clearSoundtrackResolutionCache();
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    if (url.pathname === '/ws/2/release-group/') {
      const query = url.searchParams.get('query') || '';
      if (!query.toLocaleLowerCase().includes('ra.one')) return Response.json({ 'release-groups': [] });
      return Response.json({
        'release-groups': [{
          id: 'group-ra-one', title: 'Ra.One', score: 100, 'secondary-types': ['Soundtrack'],
        }],
      });
    }
    if (url.pathname === '/ws/2/release-group/group-ra-one') {
      return Response.json({ releases: [{ id: 'release-ra-one', title: 'Ra.One', status: 'Official', 'track-count': 1 }] });
    }
    if (url.pathname === '/ws/2/release/release-ra-one') {
      return Response.json({
        title: 'Ra.One',
        media: [{ tracks: [{ position: 1, recording: {
          title: 'Criminal',
          'artist-credit': [
            { name: 'Akon', artist: { name: 'Akon' } },
            { name: 'Vishal Dadlani', artist: { name: 'Vishal Dadlani' } },
            { name: 'Shruti Pathak', artist: { name: 'Shruti Pathak' } },
          ],
        } }] }],
      });
    }
    throw new Error(`unexpected MusicBrainz URL: ${url}`);
  });
  const result = await resolveSoundtrackCandidates(
    { name: 'Ra One', kind: 'movie', explicit: true },
    [{ id: 'criminal', title: 'Criminal', artist: 'Akon, Vishal Dadlani, Shruti Pathak' }],
    { enabled: true },
  );
  assert.equal(result.status, 'matched');
  assert.equal(result.status === 'matched' && result.candidates[0]?.id, 'criminal');
});
