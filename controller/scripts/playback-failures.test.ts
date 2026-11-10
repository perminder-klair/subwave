import assert from 'node:assert/strict';
import test from 'node:test';
import { recordPlaybackFailure } from '../src/observability/playback-failures.js';

test('records only bounded scalar identity and never interrupts recovery', () => {
  const calls: unknown[] = [];
  recordPlaybackFailure({ attemptId: 'probe-1', sourceTrackId: 'abc', title: 'Song', artist: null, album: null, source: 'request' }, (type, data) => calls.push({ type, data }));
  assert.deepEqual(calls, [{ type: 'track.failed', data: {
    attemptId: 'probe-1', sourceTrackId: 'abc', title: 'Song', artist: null, album: null,
    source: 'request', stage: 'fetch', reason: 'source-resolution-failed',
  } }]);
  assert.doesNotThrow(() => recordPlaybackFailure({ attemptId: 'probe-2', source: 'ai' }, () => { throw new Error('disk unavailable'); }));
});

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPlaybackFailures } from '../src/observability/playback-failures.js';

test('retained history is bounded, deduplicated, safe and station-local', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'failures-'));
  try {
    await mkdir(join(dir, 'logs'));
    const row = (attemptId: string, t: string) => JSON.stringify({ type: 'track.failed', attemptId, t,
      stage: 'fetch', reason: 'source-resolution-failed', source: 'ai', sourceTrackId: 'same-track',
      title: 'Song', streamUrl: 'https://host?password=secret', album: '/private/music/song' });
    await writeFile(join(dir, 'logs/events-2026-10-04.jsonl'), [
      row('a', '2026-10-04T10:00:00Z'), row('a', '2026-10-04T10:00:00Z'),
      'broken', 'x'.repeat(100000), row('b', '2026-10-04T11:00:00Z'),
      row('c', '2026-10-04T12:00:00Z'),
      JSON.stringify({ type: 'track.failed', t: '2026-10-04T12:00:00Z', attemptId: 'bad-source', source: ['ai'], stage: 'fetch', reason: 'source-resolution-failed' }),
    ].join('\n'));
    await writeFile(join(dir, 'logs/events-2026-09-20.jsonl'), row('cutoff', '2026-09-20T00:00:00Z'));
    await writeFile(join(dir, 'logs/events-2026-09-19.jsonl'), row('expired', '2026-09-19T23:59:59Z'));
    await writeFile(join(dir, 'logs/events-2026-09-99.jsonl'), 'broken');
    const options = { stationDir: dir, now: new Date('2026-10-04T12:00:00Z') };
    const all = await readPlaybackFailures(options);
    assert.deepEqual(all.failures.map(r => r.attemptId), ['c', 'b', 'a', 'cutoff']);
    assert.equal(all.retentionDays, 14);
    assert.equal(all.truncated, false);
    assert.equal(JSON.stringify(all).includes('secret'), false);
    assert.equal(all.failures[0].album, null);
    const limited = await readPlaybackFailures({ ...options, limit: 2 });
    assert.deepEqual(limited.failures.map(r => r.attemptId), ['c', 'b']);
    assert.equal(limited.truncated, true);
    assert.deepEqual((await readPlaybackFailures({ ...options, stationDir: join(dir, 'missing') })).failures, []);
    await mkdir(join(dir, 'other/logs'), { recursive: true });
    await writeFile(join(dir, 'other/logs/events-2026-10-04.jsonl'), row('other-station', '2026-10-04T10:00:00Z'));
    assert.deepEqual((await readPlaybackFailures({ ...options, stationDir: join(dir, 'other') })).failures.map(r => r.attemptId), ['other-station']);
    assert.deepEqual(await readPlaybackFailures(options), all, 'fresh read survives without in-memory records');
    await rm(join(dir, 'logs'), { recursive: true });
    await writeFile(join(dir, 'logs'), 'not a directory');
    assert.equal((await readPlaybackFailures(options)).warnings.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('display metadata is capped both on emission and historical reads', async () => {
  let payload: Record<string, unknown> = {};
  const input = { attemptId: 'cap-probe', source: 'operator' as const, title: 'T'.repeat(600), artist: 'A'.repeat(600), album: 'B'.repeat(600), streamUrl: 'https://secret.example/?token=secret' };
  recordPlaybackFailure(input, (_type, data) => { payload = data; });
  assert.deepEqual([payload.title, payload.artist, payload.album], ['T'.repeat(500), 'A'.repeat(500), 'B'.repeat(500)]);
  assert.equal('streamUrl' in payload, false);
  const dir = await mkdtemp(join(tmpdir(), 'failure-caps-'));
  try {
    await mkdir(join(dir, 'logs'));
    await writeFile(join(dir, 'logs/events-2026-10-04.jsonl'), JSON.stringify({
      ...input, type: 'track.failed', t: '2026-10-04T00:00:00Z', stage: 'fetch', reason: 'source-resolution-failed',
    }) + '\n');
    const history = await readPlaybackFailures({ stationDir: dir, now: new Date('2026-10-04T12:00:00Z') });
    assert.deepEqual([history.failures[0].title, history.failures[0].artist, history.failures[0].album], ['T'.repeat(500), 'A'.repeat(500), 'B'.repeat(500)]);
    assert.equal(JSON.stringify(history).includes('secret'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an unreadable retained event file warns while readable failure rows survive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'failure-unreadable-'));
  try {
    await mkdir(join(dir, 'logs/events-2026-10-03.jsonl'), { recursive: true });
    await writeFile(join(dir, 'logs/events-2026-10-04.jsonl'), JSON.stringify({
      type: 'track.failed', t: '2026-10-04T00:00:00Z', attemptId: 'readable', source: 'ai', stage: 'fetch', reason: 'source-resolution-failed',
    }) + '\n');
    const history = await readPlaybackFailures({ stationDir: dir, now: new Date('2026-10-04T12:00:00Z') });
    assert.deepEqual(history.failures.map(row => row.attemptId), ['readable']);
    assert.deepEqual(history.warnings, ['A retained event file could not be read; results may be incomplete.']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized lines spanning stream chunks do not swallow the next valid line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'failure-oversized-'));
  try {
    await mkdir(join(dir, 'logs'));
    await writeFile(join(dir, 'logs/events-2026-10-04.jsonl'), 'x'.repeat(100000) + '\n' + JSON.stringify({
      type: 'track.failed', t: '2026-10-04T00:00:00Z', attemptId: 'after-oversized', source: 'request', stage: 'fetch', reason: 'source-resolution-failed',
    }) + '\n' + '{partial');
    const history = await readPlaybackFailures({ stationDir: dir, now: new Date('2026-10-04T12:00:00Z') });
    assert.deepEqual(history.failures.map(row => row.attemptId), ['after-oversized']);
    assert.deepEqual(history.warnings, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('history keeps the newest 1000 unique attempts even when a larger limit is requested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'failure-limit-'));
  try {
    await mkdir(join(dir, 'logs'));
    const rows = Array.from({ length: 1002 }, (_, i) => ({
      type: 'track.failed', t: new Date(Date.UTC(2026, 9, 4, 0, 0, i)).toISOString(),
      attemptId: `attempt-${i}`, source: 'ai', stage: 'fetch', reason: 'source-resolution-failed',
    }));
    // A retry of the same diagnostic row is not another failed attempt.
    rows.push({ ...rows[1001] });
    await writeFile(join(dir, 'logs/events-2026-10-04.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    const history = await readPlaybackFailures({ stationDir: dir, now: new Date('2026-10-04T12:00:00Z'), limit: 2000 });
    assert.equal(history.failures.length, 1000);
    assert.equal(history.failures[0].attemptId, 'attempt-1001');
    assert.equal(history.failures[999].attemptId, 'attempt-2');
    assert.equal(history.truncated, true);
    assert.equal(new Set(history.failures.map(row => row.attemptId)).size, 1000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
