// Regression coverage for the Verified Facts play-history packet.
// Uses the real library facade and a temporary SQLite plays table so the
// prompt is checked against the same lifetime play-count projection used on air.
// Run: npm test -- verified-facts-history

import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-verified-facts-history-'));

const library = await import('../src/music/library.js');
const { linkPrompt } = await import('../src/llm/internal/prompts/scripts.js');

after(() => library.shutdown());

test('station-history facts distinguish an unaired release from a twice-played track', async () => {
  const track = { id: 'same-day-replay', title: 'Second Spin', artist: 'The Fixtures', year: 2026 };
  const context = { date: { iso: '2026-09-10' } };

  await library.load();
  library.set(track.id, track);
  await library.recordPlay({
    trackId: 'unrelated-play', title: 'Earlier', artist: 'Other Artist', album: null,
    playedAt: '2026-09-09T17:00:00.000Z', source: 'ai', requestedBy: null,
    showId: null, showName: null,
  });
  assert.match(linkPrompt({ current: track, context }), /Sleeve Notes:\n- First station play\./,
    'an unaired current-year release supplies the real station-history line');
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

  // Reopen the facade so its five-minute airing-index memo reads the new plays.
  library.shutdown();
  await library.load();
  assert.equal(library.trackPlayStatsFor(track)?.count, 2, 'the production projection is lifetime plays');

  const prompt = linkPrompt({ current: track, context });
  assert.doesNotMatch(prompt, /^- First station play\.$/m,
    'a played track must not receive the unaired station-history fact');
  assert.match(prompt, /Track on air:\n- Second Spin by The Fixtures\./);
  assert.match(prompt, /Sleeve Notes:\n- Release year: 2026\./);
});
