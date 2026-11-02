import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMockDetail, buildMockLibrary, type TrackDetail } from './data';
import { Dossier } from './panels';

const track = buildMockLibrary(40).tracks.find((t) => t.analysed)!;

function dossier(overrides: Partial<TrackDetail['track']>): string {
  const detail = buildMockDetail(track);
  return renderToStaticMarkup(createElement(Dossier, {
    track,
    detail: { ...detail, track: { ...detail.track, ...overrides } },
    loading: false,
    mixNodes: [],
    onSelect: () => {},
    onClose: () => {},
  }));
}

test('the dossier shows sound descriptors beside the audio moods, marked as guesses', () => {
  const html = dossier({
    audioDescriptors: ['tabla', 'female vocals'],
    audioDescriptorScores: { tabla: 0.241, 'female vocals': 0.198, sitar: 0.02 },
  });
  assert.match(html, />HEARD</);
  assert.match(html, /title="CLAP guess, cosine 0\.241"[^>]*>tabla</);
  assert.match(html, />female vocals</);
  assert.doesNotMatch(html, /sitar/, 'only selected labels show, never the full score map');
});

test('a track with no descriptors renders no empty section', () => {
  assert.doesNotMatch(dossier({ audioDescriptors: [], audioDescriptorScores: null }), />HEARD</);
});

test('a label with no stored score still reads as a guess', () => {
  const html = dossier({ audioDescriptors: ['piano'], audioDescriptorScores: null });
  assert.match(html, /title="CLAP guess"[^>]*>piano</);
});
