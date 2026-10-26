import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSoundtrackResolutionCache,
  resolveSoundtrackCandidates,
  type SoundtrackProvider,
  type SoundtrackProviderTracklist,
} from '../src/music/request-soundtrack.js';

const context = { name: 'The Devil Wears Prada 2', kind: 'movie' as const, explicit: true };

function tracklist(source: 'musicbrainz' | 'lastfm', rows: Array<[string, string]>): SoundtrackProviderTracklist[] {
  return [{
    source,
    releaseName: 'The Devil Wears Prada 2 (Music from the Motion Picture)',
    tracks: rows.map(([title, artist], index) => ({ title, artists: [artist], order: index + 1, source })),
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
