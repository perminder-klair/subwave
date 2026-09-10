// Regression coverage for the Verified Facts play-history packet.
// Uses the real library facade and a temporary SQLite plays table so the
// prompt is checked against the same lifetime play-count projection used on air.
// Run: npm test -- verified-facts-history

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-verified-facts-history-'));

const library = await import('../src/music/library.js');
const { linkPrompt } = await import('../src/llm/internal/prompts/scripts.js');

test('Verified Facts labels the real lifetime play count truthfully when a prior play was today', async () => {
  const track = { id: 'same-day-replay', title: 'Second Spin', artist: 'The Fixtures' };

  await library.load();
  library.set(track.id, track);
  await library.recordPlay({
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    album: null,
    playedAt: '2026-09-09T18:00:00.000Z',
    source: 'ai',
    requestedBy: null,
    showId: null,
    showName: null,
  });
  await library.recordPlay({
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    album: null,
    playedAt: '2026-09-10T08:00:00.000Z',
    source: 'request',
    requestedBy: 'listener',
    showId: null,
    showName: null,
  });

  assert.equal(library.trackPlayStatsFor(track)?.count, 2, 'the production projection is lifetime plays');

  const prompt = linkPrompt({ current: track, context: {} });
  assert.match(prompt, /Lifetime station plays: 2\./,
    'a lifetime count must not be described as plays before today');
  assert.doesNotMatch(prompt, /Station plays before today:/);
});
