// The playback log a listener can share (#2140): the in-memory buffer that
// keeps the last few hundred plog lines in Release builds, the redaction each
// line goes through before it is stored, and the shared text's header.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAYBACK_LINE_MAX,
  PLAYBACK_LOG_LIMIT,
  PlaybackLog,
  playbackLog,
  playbackLogReport,
  redactPlaybackLine,
} from '../src/lib/playback-log.ts';
import { credentialedBase } from '../src/lib/station-credentials.ts';
import { withStreamAuth } from '../src/lib/station-password.ts';

const T0 = Date.UTC(2026, 9, 30, 21, 4, 5, 678);

function clockAt(ms: number) {
  let now = ms;
  return { now: () => now, advance: (by: number) => { now += by; } };
}

test('the buffer keeps each line with its UTC time, oldest first', () => {
  const clock = clockAt(T0);
  const log = new PlaybackLog(10, clock.now);
  log.add('reload [tune] #1 state=none');
  clock.advance(1500);
  log.add('event playback-state state=playing');
  assert.deepEqual(log.lines(), [
    '2026-10-30T21:04:05.678Z reload [tune] #1 state=none',
    '2026-10-30T21:04:07.178Z event playback-state state=playing',
  ]);
});

test('the buffer drops the oldest lines past its limit', () => {
  const log = new PlaybackLog(3, () => T0);
  for (let i = 1; i <= 5; i++) log.add(`line ${i}`);
  assert.deepEqual(
    log.lines().map((l) => l.split(' ').slice(1).join(' ')),
    ['line 3', 'line 4', 'line 5'],
  );
});

test("the app's log holds a few hundred lines, and a read can't change it", () => {
  assert.ok(PLAYBACK_LOG_LIMIT >= 200 && PLAYBACK_LOG_LIMIT <= 1000);
  const log = new PlaybackLog();
  for (let i = 0; i < PLAYBACK_LOG_LIMIT + 50; i++) log.add(`line ${i}`);
  const lines = log.lines();
  assert.equal(lines.length, PLAYBACK_LOG_LIMIT);
  assert.match(lines[0], / line 50$/);
  lines.length = 0;
  assert.equal(log.lines().length, PLAYBACK_LOG_LIMIT);
  assert.ok(playbackLog instanceof PlaybackLog);
});

test("recovery and event lines, which carry no secret, are stored as they're written", () => {
  for (const line of [
    'hold [watchdog] state=ready: pos 12.0→18.1s over 6.0s, pace 1.02 — playing, not reloading',
    'reload [churn] #3 state=buffering: 5 flaps in 60s, pos 1.0→2.0s over 40.0s, pace 0.03',
    'reload [error] skipped: one in flight, queued after it',
    'interruption over, resumed: checking the clock',
    'event playback-state state=buffering',
    'event playback-error msg=Response code: 503',
    'route change reason=2 outputs=',
  ]) {
    assert.equal(redactPlaybackLine(line), line);
  }
});

test('the station password never reaches the log: ?auth= on the stream URL goes', () => {
  const url = withStreamAuth('https://radio.example.com/stream.mp3', 's3cret pass&x=1');
  const log = new PlaybackLog(10, () => T0);
  log.add(`event playback-error msg=Unable to connect to ${url}`);
  assert.deepEqual(log.lines(), [
    '2026-10-30T21:04:05.678Z event playback-error msg=Unable to connect to https://radio.example.com/stream.mp3',
  ]);
});

test('an auth= outside a URL, and an x-station-auth header, are redacted', () => {
  assert.equal(
    redactPlaybackLine('msg=bad request (stream.mp3?auth=hunter2&t=1)'),
    'msg=bad request (stream.mp3?auth=[redacted]&t=1)',
  );
  assert.equal(redactPlaybackLine('headers x-station-auth: hunter2'), 'headers x-station-auth: [redacted]');
  assert.equal(redactPlaybackLine('{x-station-auth=hunter2}'), '{x-station-auth=[redacted]}');
});

test('the Station login never reaches the log: URL userinfo goes', () => {
  const base = credentialedBase('https://radio.example.com:8443', { username: 'sam', password: 'p@ss:w/rd?#' });
  assert.equal(
    redactPlaybackLine(`artwork ${base}/api/cover/abc failed`),
    'artwork https://radio.example.com:8443/api/cover/abc failed',
  );
  assert.equal(redactPlaybackLine('http://sam@10.0.0.2:8000/stream.aac'), 'http://10.0.0.2:8000/stream.aac');
});

test('the Station login never reaches the log: an Authorization header keeps only its scheme', () => {
  const basic = 'Basic c2FtOmh1bnRlcjI=';
  assert.equal(redactPlaybackLine(`Authorization: ${basic}`), 'Authorization: Basic [redacted]');
  assert.equal(
    redactPlaybackLine(`headers={Authorization=${basic}, Icy-MetaData=1}`),
    'headers={Authorization=Basic [redacted], Icy-MetaData=1}',
  );
  assert.equal(
    redactPlaybackLine(`{"authorization":"${basic}","accept":"*/*"}`),
    '{"authorization":"Basic [redacted]","accept":"*/*"}',
  );
  assert.equal(redactPlaybackLine('Proxy-Authorization: Bearer abc.def'), 'Proxy-Authorization: Bearer [redacted]');
  assert.equal(redactPlaybackLine('Authorization=c2FtOmh1bnRlcjI='), 'Authorization=[redacted]');
  assert.equal(redactPlaybackLine('HTTP 401: Authorization required'), 'HTTP 401: Authorization required');
});

test('a station URL keeps only its scheme, host and path', () => {
  assert.equal(
    redactPlaybackLine('load https://radio.example.com/stream.opus?t=1730322245&auth=x#live then retry'),
    'load https://radio.example.com/stream.opus then retry',
  );
  assert.equal(
    redactPlaybackLine('src="https://radio.example.com/api/avatars/dj.png?v=2"'),
    'src="https://radio.example.com/api/avatars/dj.png"',
  );
  assert.equal(redactPlaybackLine('https://radio.example.com'), 'https://radio.example.com');
});

test('an iOS route keeps its port types and drops the device names', () => {
  assert.equal(
    redactPlaybackLine("route change reason=2 outputs=BluetoothA2DPOutput:Sam's AirPods Pro"),
    'route change reason=2 outputs=BluetoothA2DPOutput',
  );
  assert.equal(
    redactPlaybackLine('route change reason=3 outputs=AirPlay:Kitchen, upstairs,Speaker:iPhone Speaker'),
    'route change reason=3 outputs=AirPlay,Speaker',
  );
});

test('a long line is cut after redaction, so the cut never splits a secret from its rule', () => {
  // Cut first, this would end " https://sam:hun", which reads as a host.
  const pad = 'x'.repeat(PLAYBACK_LINE_MAX - ' https://sam:hun'.length);
  const log = new PlaybackLog(10, () => T0);
  log.add(`${pad} https://sam:hunter2@radio.example.com/stream.mp3`);
  const [line] = log.lines();
  assert.ok(!line.includes('sam') && !line.includes('hun'), line);
  log.add('y'.repeat(PLAYBACK_LINE_MAX + 100));
  assert.equal(log.lines()[1], `2026-10-30T21:04:05.678Z ${'y'.repeat(PLAYBACK_LINE_MAX)}…`);
});

test('the shared text starts with the app version, its bundle, the platform and the OS version', () => {
  const lines = ['2026-10-30T21:04:05.678Z reload [tune] #1 state=none'];
  assert.equal(
    playbackLogReport({ version: '1.6.1', bundle: 'OTA 1a2b3c4d, production', platform: 'iOS', osVersion: '18.2' }, lines),
    [
      'SUB/WAVE app 1.6.1 (OTA 1a2b3c4d, production) · iOS 18.2',
      'Playback log: 1 line, oldest first, times in UTC.',
      '',
      '2026-10-30T21:04:05.678Z reload [tune] #1 state=none',
    ].join('\n'),
  );
  assert.equal(
    playbackLogReport({ version: '1.6.1', bundle: null, platform: 'Android', osVersion: '15 (API 35)' }, []),
    'SUB/WAVE app 1.6.1 · Android 15 (API 35)\nPlayback log: 0 lines, oldest first, times in UTC.\n',
  );
});
