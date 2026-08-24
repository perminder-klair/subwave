// Regression coverage for the play-frequency fields returned by picker tools.
// Uses the real SQLite play history and the real slim() projection so a field
// wired to track metadata instead of the plays table cannot pass unnoticed.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('picker candidates carry song and artist play frequency from station history', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-picker-frequency-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  const library = await import('../src/music/library.js');
  const { slim } = await import('../src/llm/internal/tools/picker/slim.js');

  await library.load();
  db.upsertTrackMeta('played-song', {
    title: 'Played Song', artist: 'Known Artist', album: 'Record', duration: 180,
  });
  db.upsertTrackMeta('fresh-song', {
    title: 'Fresh Song', artist: 'Known Artist', album: 'Record', duration: 180,
  });

  const now = Date.now();
  const play = (trackId: string, title: string, daysAgo: number) => db.recordPlay({
    trackId,
    title,
    artist: 'Known Artist',
    album: 'Record',
    playedAt: new Date(now - daysAgo * 86400000).toISOString(),
    source: 'ai',
    requestedBy: null,
    showId: null,
    showName: null,
  });
  play('played-song', 'Played Song', 8);
  play('played-song', 'Played Song', 2);
  play('another-song', 'Another Song', 1);

  const played = slim({ id: 'played-song', title: 'Played Song', artist: 'Known Artist' });
  assert.equal(played.play_count, 2);
  assert.equal(played.last_played_days_ago, 2);
  assert.equal(played.artist_play_count, 3);
  assert.equal(played.artist_last_played_days_ago, 1);

  const fresh = slim({ id: 'fresh-song', title: 'Fresh Song', artist: 'Known Artist' });
  assert.equal(fresh.play_count, undefined);
  assert.equal(fresh.last_played_days_ago, undefined);
  assert.equal(fresh.unaired, true);
  assert.equal(fresh.artist_play_count, 3);

  library.shutdown();
});
