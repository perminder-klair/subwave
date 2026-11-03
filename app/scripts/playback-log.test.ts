// The playback log a listener can share (#2140): the in-memory buffer that
// keeps the last few hundred plog lines in Release builds, the redaction each
// line goes through before it is stored, and the shared text's header.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAYBACK_LINE_MAX,
  PLAYBACK_LOG_LIMIT,
  PlaybackLog,
  playbackEventLine,
  playbackLog,
  playbackLogReport,
  redactPlaybackLine,
} from '../src/lib/playback-log.ts';
import { credentialedBase } from '../src/lib/station-credentials.ts';
import { withStreamAuth } from '../src/lib/station-password.ts';
import { StreamRecovery, type ReloadReason } from '../src/lib/stream-recovery.ts';

const T0 = Date.UTC(2026, 9, 30, 21, 4, 5, 678);
const BASIC = 'Basic c2FtOmh1bnRlcjI=';

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
    'event playback-error code=android-io-bad-http-status msg=Source error',
    'event playback-error msg=The server is not correctly configured.',
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

test("a station password with a ' ( ) ! * or ~, which encodeURIComponent keeps, goes whole", () => {
  for (const password of ["it's-mine", 'pa(ss)word!', "a'b*c~d"]) {
    const url = `${withStreamAuth('https://radio.example.com/stream.mp3', password)}&t=1730322245`;
    assert.equal(
      redactPlaybackLine(`event playback-error msg=Unable to connect to ${url}`),
      'event playback-error msg=Unable to connect to https://radio.example.com/stream.mp3',
    );
    assert.equal(
      redactPlaybackLine(`GET stream.mp3${url.slice(url.indexOf('?'))} failed`),
      'GET stream.mp3?auth=[redacted]&t=1730322245 failed',
    );
  }
});

test('an auth= outside a URL, and an x-station-auth header, are redacted', () => {
  assert.equal(
    redactPlaybackLine('msg=bad request (stream.mp3?auth=hunter2&t=1)'),
    'msg=bad request (stream.mp3?auth=[redacted]&t=1)',
  );
  assert.equal(redactPlaybackLine('headers x-station-auth: hunter2'), 'headers x-station-auth: [redacted]');
  assert.equal(redactPlaybackLine('{x-station-auth=hunter2}'), '{x-station-auth=[redacted]');
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

test('the Station login never reaches the log: what wraps an Authorization value hides nothing', () => {
  for (const [line, want] of [
    [`{Authorization=[${BASIC}], Icy-MetaData=[1]}`, '{Authorization=[Basic [redacted]], Icy-MetaData=[1]}'],
    [`{"Authorization":["${BASIC}"]}`, '{"Authorization":["Basic [redacted]"]}'],
    [`{'Authorization': ['${BASIC}']}`, "{'Authorization': ['Basic [redacted]']}"],
    [`Authorization: Optional("${BASIC}")`, 'Authorization: Optional("Basic [redacted]")'],
    [`Authorization: Optional(Optional("${BASIC}"))`, 'Authorization: Optional(Optional("Basic [redacted]"))'],
    [`Authorization: Optional[${BASIC}]`, 'Authorization: Optional[Basic [redacted]]'],
    [`{Proxy-Authorization=[${BASIC}]}`, '{Proxy-Authorization=[Basic [redacted]]}'],
    // A closing backslash goes with the value, which only loses an escape.
    [
      JSON.stringify({ error: JSON.stringify({ Authorization: BASIC }) }),
      '{"error":"{\\"Authorization\\":\\"Basic [redacted]"}"}',
    ],
    [
      JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ Authorization: BASIC }) }) }),
      '{"a":"{\\"b\\":\\"{\\\\\\"Authorization\\\\\\":\\\\\\"Basic [redacted]"}\\"}"}',
    ],
    // The header rule alone: too short for the bare credential rule to catch.
    ['{Authorization=[Basic YTpi]}', '{Authorization=[Basic [redacted]]}'],
    ['Authorization: Optional("Basic YTpi")', 'Authorization: Optional("Basic [redacted]")'],
  ]) {
    assert.equal(redactPlaybackLine(line), want);
  }
});

test('the Station login never reaches the log: a wrapper no rule names hides nothing', () => {
  for (const [line, want] of [
    [`Authorization: <${BASIC}>`, 'Authorization: Basic [redacted]'],
    [`Authorization: {${BASIC}}`, 'Authorization: Basic [redacted]}'],
    [`Authorization: Some(${BASIC})`, 'Authorization: Basic [redacted])'],
    [`Authorization=SecretString(${BASIC})`, 'Authorization=Basic [redacted])'],
    [`Authorization: Optional<String>.some(${BASIC})`, 'Authorization: Basic [redacted])'],
    ['Authorization: `' + BASIC + '`', 'Authorization: Basic [redacted]'],
    [`Proxy-Authorization: *Bearer abc.def-ghi*`, 'Proxy-Authorization: Bearer [redacted]'],
    // Too short for the bare credential rule, so only the header rule can catch it.
    ['Authorization: <Basic YTpi>', 'Authorization: Basic [redacted]'],
  ]) {
    assert.equal(redactPlaybackLine(line), want);
  }
});

test('the station password never reaches the log: what wraps an x-station-auth value hides nothing', () => {
  for (const line of [
    '{"x-station-auth":["hunter2"]}',
    '{x-station-auth=[hunter2]}',
    'x-station-auth: Optional("hunter2")',
    "X-Station-Auth: ['hunter2']",
    JSON.stringify({ h: JSON.stringify({ 'x-station-auth': 'hunter2' }) }),
  ]) {
    const out = redactPlaybackLine(line);
    assert.ok(!out.includes('hunter2'), out);
    assert.ok(out.includes('[redacted]'), out);
  }
});

test('the station password never reaches the log: no character in it ends an x-station-auth value', () => {
  for (const stop of [' ', "'", '"', ',', ';', ')', '}', ']', '\n', '\r', '\u2028', '\u2029']) {
    const password = `hunter${stop}second`;
    for (const line of [
      `x-station-auth: ${password}`,
      `{x-station-auth=${password}, accept=json}`,
      `{x-station-auth=[${password}]}`,
      `x-station-auth: Optional("${password}")`,
      JSON.stringify({ 'x-station-auth': password, accept: 'json' }),
      JSON.stringify({ h: JSON.stringify({ 'x-station-auth': password }) }),
    ]) {
      const out = redactPlaybackLine(line);
      assert.ok(!out.includes('hunter') && !out.includes('second'), out);
      assert.ok(out.includes('[redacted]'), out);
    }
  }
});

test('the Station login never reaches the log: a credential with no header name goes', () => {
  for (const [line, want] of [
    [`sent ${BASIC}`, 'sent Basic [redacted]'],
    [`Authorization ${BASIC}`, 'Authorization Basic [redacted]'],
    [`(Authorization, ${BASIC})`, '(Authorization, Basic [redacted])'],
    [`Authorization -> ${BASIC}`, 'Authorization -> Basic [redacted]'],
    [`["${BASIC}","${BASIC}"]`, '["Basic [redacted]","Basic [redacted]"]'],
    [`{Authorization=[${BASIC}, Bearer abc.def-ghi]}`, '{Authorization=[Basic [redacted], Bearer [redacted]]}'],
    ['bearer eyJhbGciOi.eyJzdWIi.Zm9v-_~+/', 'bearer [redacted]'],
    // Padding counts toward the length, so these 4- and 5-byte logins go too.
    ['Basic YTpiYw==', 'Basic [redacted]'],
    ['Basic YWI6Y2Q=', 'Basic [redacted]'],
  ]) {
    assert.equal(redactPlaybackLine(line), want);
  }
});

test('a line about auth stays readable, at the costs the rule states', () => {
  for (const line of [
    'HTTP Basic authentication failed',
    'Basic Authentication required.',
    'bearer authorization failed',
    'basic credentials rejected',
    'WWW-Authenticate: Basic realm="station"',
    'Basic realm=station',
    'Bearer error="invalid_token"',
    'bearer token expired',
    // The cost in coverage: a bare credential shorter than the floor stays.
    'Basic YTpi',
  ]) {
    assert.equal(redactPlaybackLine(line), line);
  }
  // The cost in readability: any other long word goes.
  assert.equal(redactPlaybackLine('basic connectivity check'), 'basic [redacted] check');
  // The kept words are whole and exact, so a token built on one still goes.
  assert.equal(redactPlaybackLine('Bearer authentication-abc'), 'Bearer [redacted]');
  assert.equal(redactPlaybackLine('Bearer authentication.abc'), 'Bearer [redacted]');
  assert.equal(redactPlaybackLine('Basic credentials='), 'Basic [redacted]');
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

test('a URL is found whatever sits before its ://', () => {
  for (const before of [
    '1https',
    'uri_https',
    '',
    'a.b+c-d',
    // A stray ://, or another URL's path, must not swallow this URL whole.
    '://https',
    ':// (https',
    '://[://https',
    'https://proxy.example.com/fetch/https',
  ]) {
    assert.equal(
      redactPlaybackLine(`${before}://sam:hunter2@radio.example.com/stream.mp3?auth=hunter3#live`),
      `${before}://radio.example.com/stream.mp3`,
    );
  }
});

test('a URL in JSON that backslashes its slashes loses its userinfo and query too', () => {
  const url = 'https://sam:hunter2@radio.example.com/stream.mp3?auth=hunter3';
  const escaped = url.replaceAll('/', '\\/');
  assert.equal(
    redactPlaybackLine(`{"url":"${escaped}"}`),
    '{"url":"https:\\/\\/radio.example.com\\/stream.mp3"}',
  );
  // Nested once more, each backslash is escaped in its turn.
  const nested = JSON.stringify({ a: `{"url":"${escaped}"}` });
  const out = redactPlaybackLine(nested);
  assert.ok(!out.includes('sam') && !out.includes('hunter'), out);
});

test("a URL's query never takes a header's name and leaves its value behind", () => {
  for (const [line, want] of [
    ['https://radio.example.com/stream.mp3?x-station-auth: hunter2', 'https://radio.example.com/stream.mp3 [redacted]'],
    ['https://radio.example.com/stream.mp3?a=1,Authorization: hunter2', 'https://radio.example.com/stream.mp3 [redacted]'],
    ['://#x-station-auth: hunter2', ':// [redacted]'],
  ]) {
    assert.equal(redactPlaybackLine(line), want);
  }
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

test('a line terminator in a device name never hides it from the route rule', () => {
  for (const eol of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const routes = [
      [`BluetoothA2DPOutput:Sam${eol}AirPods`, 'BluetoothA2DPOutput'],
      [`BluetoothA2DPOutput:Sam's AirPods${eol}`, 'BluetoothA2DPOutput'],
      [`AirPlay:Sam${eol}Kitchen,Speaker:iPhone${eol}Speaker`, 'AirPlay,Speaker'],
      [`AirPlay:Kitchen,${eol}Sam:Office,Speaker:iPhone Speaker`, 'AirPlay,Speaker'],
    ];
    for (const [outputs, want] of routes) {
      assert.equal(redactPlaybackLine(`route change reason=2 outputs=${outputs}`), `route change reason=2 outputs=${want}`);
    }
  }
});

// Typed out rather than imported, so dropping one from the rule fails here.
const AV_AUDIO_SESSION_PORTS = [
  'AirPlay', 'AVB', 'BluetoothA2DPOutput', 'BluetoothHFP', 'BluetoothLE', 'CarAudio',
  'ContinuityMicrophone', 'DisplayPort', 'FireWire', 'HDMIOutput', 'Headphones', 'LineIn',
  'LineOut', 'MediaDeviceExtension', 'MicrophoneBuiltIn', 'MicrophoneContinuity',
  'MicrophoneWired', 'PCI', 'Receiver', 'Speaker', 'Thunderbolt', 'USBAudio', 'Virtual',
];

test('every AVAudioSession.Port keeps its own name in a route line', () => {
  for (const port of AV_AUDIO_SESSION_PORTS) {
    for (const [outputs, want] of [
      [`${port}:Sam's Device`, port],
      // The native module writes the colon even for a port with no name.
      [`${port}:`, port],
      [`${port}:Kitchen, upstairs`, port],
      [`${port}:Sam: office`, port],
      [`${port}:Sam,Speaker:iPhone Speaker`, `${port},Speaker`],
      [`Speaker:iPhone Speaker,${port}:Sam's Device`, `Speaker,${port}`],
    ]) {
      assert.equal(redactPlaybackLine(`route change reason=1 outputs=${outputs}`), `route change reason=1 outputs=${want}`);
    }
  }
});

test('a word no port is called reads Other, and never reaches the line', () => {
  for (const [outputs, want] of [
    // A device called "Sam,Dave:x", and the words of a longer name.
    ['BluetoothA2DPOutput:Sam,Dave:x', 'BluetoothA2DPOutput,Other'],
    ['BluetoothA2DPOutput:Sam,Dave:x,Jo:y', 'BluetoothA2DPOutput,Other,Other'],
    ['AirPlay:Kitchen,Sam:Office,Speaker:iPhone Speaker', 'AirPlay,Other,Speaker'],
    // A port Apple adds holds its place in the route, so the count stays right.
    ['SomePortAppleAdds:Sam', 'Other'],
    ['SomePortAppleAdds:Sam,Speaker:iPhone Speaker', 'Other,Speaker'],
    ['Speaker:iPhone Speaker,SomePortAppleAdds:Sam', 'Speaker,Other'],
    // The match is whole and exact.
    ['speaker:Sam', 'Other'],
    ['SPEAKER:Sam', 'Other'],
    ['Speakers:Sam', 'Other'],
    ['Speaker2:Sam', 'Other'],
    ['AirPlayDave:Sam', 'Other'],
    // An inherited name isn't a port, as it could be in a plain object.
    ['constructor:Sam', 'Other'],
    ['toString:Sam', 'Other'],
    ['hasOwnProperty:Sam', 'Other'],
    // The fallback word is no way through either.
    ['Other:Sam', 'Other'],
  ]) {
    assert.equal(redactPlaybackLine(`route change reason=2 outputs=${outputs}`), `route change reason=2 outputs=${want}`);
  }
});

test('a piece with no port word before a colon still goes, and is not counted', () => {
  for (const [outputs, want] of [
    ['AirPlay:Kitchen, upstairs,Speaker:iPhone Speaker', 'AirPlay,Speaker'],
    ['AirPlay:Kitchen, Dave:x,Speaker:iPhone Speaker', 'AirPlay,Speaker'],
    ['AirPlay:Kitchen,Dave Smith:x', 'AirPlay'],
    ['AirPlay:Kitchen,Zoë:x', 'AirPlay'],
    ['AirPlay:Kitchen,:x', 'AirPlay'],
    ['AirPlay:Kitchen,', 'AirPlay'],
    ['AirPlay:Kitchen,Dave', 'AirPlay'],
    ['Dave', ''],
    ['', ''],
  ]) {
    assert.equal(redactPlaybackLine(`route change reason=2 outputs=${outputs}`), `route change reason=2 outputs=${want}`);
  }
});

test('no character in a device name lets any of it through the route rule', () => {
  const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));
  const terminators = ['\n', '\r', ' ', ' '];
  const beyondAscii = ['\t', ' ', '​', '’', '，', '：', 'é', '🎧'];
  const type = `(?:${AV_AUDIO_SESSION_PORTS.join('|')}|Other)`;
  const onlyTypes = new RegExp(`^route change reason=2 outputs=BluetoothA2DPOutput(?:,${type})*$`);
  const placements = (c: string) => [
    `Sam${c}Dave`,
    `Sam${c}`,
    `${c}Sam`,
    `Sam,Dave${c}:x`,
    `Sam,${c}Dave:x`,
    `Sam${c},Dave:x`,
    `Sam,Dave:${c}`,
    `Sam,Dave:x${c}`,
    `Sam,Dave:x${c}Jo:y`,
    `Sam,Dave:x,Jo${c}:y`,
    `${c},Sam:${c},Dave:${c}`,
  ];
  for (const c of [...printable, ...terminators, ...beyondAscii]) {
    for (const name of placements(c)) {
      for (const outputs of [`BluetoothA2DPOutput:${name}`, `BluetoothA2DPOutput:${name},Speaker:iPhone Speaker`]) {
        const line = `route change reason=2 outputs=${outputs}`;
        const out = redactPlaybackLine(line);
        assert.match(out, onlyTypes, JSON.stringify(line));
        assert.ok(!/Sam|Dave|Jo/.test(out), JSON.stringify(line));
      }
    }
  }
});

test("the event line carries Android's code and message, and iOS's error text", () => {
  assert.equal(
    playbackEventLine({ type: 'playback-error', code: 'android-io-bad-http-status', message: 'Source error' }),
    'event playback-error code=android-io-bad-http-status msg=Source error',
  );
  // Android leaves out either field when it has no value.
  assert.equal(
    playbackEventLine({ type: 'playback-error', code: 'android-unknown' }),
    'event playback-error code=android-unknown',
  );
  assert.equal(playbackEventLine({ type: 'playback-error', message: 'Source error' }), 'event playback-error msg=Source error');
  assert.equal(
    playbackEventLine({ type: 'playback-error', error: 'The server is not correctly configured.' }),
    'event playback-error msg=The server is not correctly configured.',
  );
  // iOS's error is optional, which reaches JS as null.
  assert.equal(playbackEventLine({ type: 'playback-error', error: null }), 'event playback-error');
});

test('the other event lines read as they did, and an error state keeps its object out', () => {
  assert.equal(playbackEventLine({ type: 'playback-state', state: 'playing' }), 'event playback-state state=playing');
  assert.equal(playbackEventLine({ type: 'remote-pause' }), 'event remote-pause');
  assert.equal(playbackEventLine({ type: 'remote-duck', paused: true, permanent: false } as never), 'event remote-duck');
  assert.equal(
    playbackEventLine({
      type: 'playback-state',
      state: 'error',
      error: { code: 'ios_playback_failed', message: 'Playback of the track failed' },
    }),
    'event playback-state state=error',
  );
});

test("a playback error's code and text go through the same redaction before they're stored", () => {
  const stream = `${withStreamAuth('https://radio.example.com/stream.mp3', "it's hunter2")}&t=1730322245`;
  const login = credentialedBase('https://radio.example.com', { username: 'sam', password: 'p@ss:w/rd?#' });
  const log = new PlaybackLog(10, () => T0);
  log.add(playbackEventLine({ type: 'playback-error', code: `android-${stream}`, message: `Unable to open ${stream}` }));
  log.add(playbackEventLine({ type: 'playback-error', error: `Unable to open ${login}/stream.mp3 (Authorization: ${BASIC})` }));
  log.add(playbackEventLine({ type: 'playback-error', error: `sent ${BASIC}, x-station-auth: hunter2` }));
  assert.deepEqual(log.lines().map((l) => l.split(' ').slice(1).join(' ')), [
    'event playback-error code=android-https://radio.example.com/stream.mp3 msg=Unable to open https://radio.example.com/stream.mp3',
    'event playback-error msg=Unable to open https://radio.example.com/stream.mp3 (Authorization: Basic [redacted])',
    'event playback-error msg=sent Basic [redacted], x-station-auth: [redacted]',
  ]);
});

test('a throw from the log never costs a reload, and its line is lost rather than kept raw', async (t) => {
  // The recovery's checks stay parked, so a failure here can't leave one running.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // What Hermes raises past its regex limits, thrown from inside redaction.
  const overflow = new RangeError('Maximum regex stack depth reached');
  const replace = t.mock.method(String.prototype, 'replace', () => { throw overflow; });
  const log = new PlaybackLog(10, () => T0);
  const reloads: ReloadReason[] = [];
  const recovery = new StreamRecovery({
    position: async () => 0,
    reload: async (reason) => { reloads.push(reason); },
    onAdvancing: () => {},
    log: (msg) => log.add(msg),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  recovery.tuneIn();
  await settle();
  assert.deepEqual(reloads, ['tune']);
  assert.ok(replace.mock.callCount() > 0);
  assert.deepEqual(log.lines(), []);

  // Not left reloading forever: the next tune-in loads, and the log works again.
  replace.mock.restore();
  recovery.tuneOut();
  recovery.tuneIn();
  await settle();
  recovery.tuneOut();
  assert.deepEqual(reloads, ['tune', 'tune']);
  assert.match(log.lines()[0], /reload \[tune\] #2/);
});

test('no rule slows down on a long line built to make it rescan', () => {
  const size = 100_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length));
  for (const line of [
    fill('a.'),
    fill('a-'),
    fill('a+'),
    fill('a://'),
    fill('://'),
    fill('x://a@'),
    fill('x://a?'),
    fill(':\\/\\/'),
    fill(':\\/\\/a@'),
    `:${fill('\\')}`,
    fill(`:${'\\'.repeat(997)}`),
    fill('proxy-'),
    fill('x-station-'),
    fill('x-station-auth '),
    fill('x-station-auth\\'),
    fill('x-station-auth: '),
    `x://${fill('a')}`,
    `${fill('outputs=a ')}\n`,
    fill('outputs=a\n'),
    `outputs=${fill('A:b,')}`,
    `outputs=${fill(' ,')}`,
    `outputs=${fill('Dave:x,')}`,
    `outputs=${fill('Speaker:x,')}`,
    `outputs=${fill('a')}:b`,
    `outputs=${fill('a')}`,
    `outputs=${fill(':')}`,
    `outputs=${fill(',')}`,
    fill('authorization '),
    `authorization${fill(' ')}`,
    `authorization${fill('\\')}`,
    `authorization=${fill('[')}`,
    `authorization=${fill('\\"')}`,
    `authorization=${fill('optional(')}`,
    `authorization=${fill('-basic')}`,
    `authorization=${fill('(basic')}`,
    fill('authorization=optional'),
    `basic${fill(' ')}`,
    fill(`basic${' '.repeat(997)}`),
    fill('basic '),
    fill('basic abcdefg '),
    fill('basic authentication '),
    `bearer ${fill('a')}${fill('=')}`,
    fill(' auth='),
  ]) {
    // The best of three, so a stall on a busy machine can't read as a slow rule.
    const ms = Math.min(...[1, 2, 3].map(() => {
      const start = performance.now();
      redactPlaybackLine(line);
      return performance.now() - start;
    }));
    assert.ok(ms < 300, `${ms.toFixed(0)} ms on ${JSON.stringify(line.slice(0, 40))}…`);
  }
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
