import assert from 'node:assert/strict';
import test from 'node:test';
import { icecastDebugSnapshot } from '../src/routes/debug-icecast.js';

const mp3 = {
  listenurl: 'http://icecast:8000/stream.mp3',
  title: 'MP3 title', bitrate: 192,
  listeners: 1, listener_peak: 10,
  stream_start_iso8601: '2026-09-22T10:00:00Z',
};
const flac = {
  listenurl: 'http://icecast:8000/stream.flac',
  title: 'FLAC title', bitrate: 900,
  listeners: '2', listener_peak: '20',
};

test('totals cover every source while metadata follows MP3 in either source order', () => {
  for (const source of [[flac, mp3], [mp3, flac]]) {
    const before = structuredClone(source);
    const snapshot = icecastDebugSnapshot({ source, server_start_iso8601: 'server-start' });
    assert.deepEqual(snapshot.status, {
      title: mp3.title, bitrate: mp3.bitrate,
      listeners: 3, listener_peak: 30,
      activeMounts: source.map(s => s.listenurl),
      stream_start: mp3.stream_start_iso8601, server_start: 'server-start',
    });
    assert.deepEqual(snapshot.sources, source, 'the per-mount table gets the same sources');
    assert.deepEqual(source, before, 'projection does not mutate the Icecast response');
    assert.ok(!('mount' in snapshot.status), 'activeMounts replaces the old single-mount field');
  }
});

test('a singleton source normalizes to an array and supplies fallback metadata', () => {
  const snapshot = icecastDebugSnapshot({ source: flac });
  assert.deepEqual(snapshot.sources, [flac]);
  assert.equal(snapshot.status.title, 'FLAC title');
  assert.equal(snapshot.status.bitrate, 900);
  assert.equal(snapshot.status.listeners, 2);
  assert.equal(snapshot.status.listener_peak, 20);
  assert.deepEqual(snapshot.status.activeMounts, [flac.listenurl]);
});

test('absent, null and empty sources report no connected encoder', () => {
  for (const source of [undefined, null, []]) {
    assert.deepEqual(icecastDebugSnapshot({ source }), {
      sources: [], status: { error: 'no source connected' },
    });
  }
});

test('zero and missing counters stay zero and missing URLs do not enter the mount list', () => {
  const source = [{ ...mp3, listeners: 0, listener_peak: 0 }, {}, { listenurl: '' }];
  const { status } = icecastDebugSnapshot({ source });
  assert.equal(status.listeners, 0);
  assert.equal(status.listener_peak, 0);
  assert.deepEqual(status.activeMounts, [mp3.listenurl]);
});

test('raw totals and active mounts include optional codecs and unfamiliar connected mounts', () => {
  const source = [mp3, flac, ...['opus', 'aac', 'custom'].map((codec, i) => ({
    listenurl: `http://icecast:8000/stream.${codec}`,
    listeners: i + 3, listener_peak: i + 30,
  }))];
  const { status } = icecastDebugSnapshot({ source });
  assert.equal(status.listeners, 15, 'raw sockets are not limited to MP3 or deduplicated');
  assert.equal(status.listener_peak, 123, 'independent mount peaks are summed');
  assert.deepEqual(status.activeMounts, source.map(s => s.listenurl));
  assert.deepEqual(icecastDebugSnapshot({ source: mp3 }).status.activeMounts, [mp3.listenurl],
    'a disconnected encoder is absent from the next snapshot');
});
