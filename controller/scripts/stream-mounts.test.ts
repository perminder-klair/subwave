// The listener buffer the station advertises is the burst the running mounts
// were rendered with (#2142), and the bitrate each burst is sized for is the one
// liquidsoap encodes at (#2143 item 3).
//
// Icecast's <burst-size> is rendered when the broadcast pair starts, while
// stream.bufferSeconds saves at once. /now-playing used to advertise the
// setting, so between a save and the next mixer restart every listener surface
// added the wrong offset to live-edge timestamps, and a RAISED value told the
// web idle skip to shed more silence than the burst held, fast-forwarding into
// the resumed music. The renderers now record what they rendered in
// stream-mounts.json, and the controller advertises that.
//
// The bitrate had a race of its own: the renderer read
// liquidsoap_stream_bitrate.txt to size the burst and liquidsoap read the same
// file seconds later, so a save in between sized the burst for the old
// encoder (320 → 64 kbps at 60 s is a ~300 s burst). The renderer now reads it
// once and hands the value to radio.liq as SUBWAVE_*_BITRATE.
//
// Both renderers (docker/broadcast-entrypoint.sh, the AIO's supervisor.sh) are
// driven here from ONE table, under `set -eu`, like the other lockstep tests.
//
// Run: `npm test -- stream-mounts`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-stream-mounts-'));
process.env.STATE_DIR = stateDir;

const { renderedBufferSeconds, listenerBufferSeconds } = await import('../src/broadcast/stream-mounts-pure.js');
const { advertisedBufferSeconds } = await import('../src/broadcast/stream-mounts.js');
const { config } = await import('../src/config.js');
const { setCache } = await import('../src/settings/store.js');

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const RADIO_LIQ = join(repo, 'liquidsoap', 'radio.liq');

const shellTmp = createTempDir(join(tmpdir(), 'subwave-stream-mounts-sh-'));
after(async () => {
  setCache(null);
  await removeTempDir(shellTmp);
  await removeTempDir(stateDir);
});

const mp3 = (over: Record<string, unknown> = {}) => ({
  mounts: { '/stream.mp3': { kbps: 192, burstSeconds: 22, burstBytes: 22 * 192 * 125, ...over } },
  at: 1,
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

test('the MP3 mount\'s rendered burst is the advertised one', () => {
  assert.equal(renderedBufferSeconds(mp3()), 22);
  assert.equal(renderedBufferSeconds(mp3({ burstSeconds: 40, burstBytes: 40 * 192 * 125 })), 40);
  // 0 is a real value: the connect burst is off, and listeners sit at the edge.
  assert.equal(renderedBufferSeconds(mp3({ burstSeconds: 0, burstBytes: 0 })), 0);
  assert.equal(listenerBufferSeconds(40, 22), 40, 'the rendered burst beats the setting');
});

test('no usable marker falls back to the setting, as before the marker existed', () => {
  // The upgrade path: a controller ahead of its broadcast image finds no file.
  for (const junk of [null, undefined, 'nope', 42, [], {}, { mounts: null }, { mounts: {} }, { mounts: { '/stream.opus': {} } }]) {
    assert.equal(renderedBufferSeconds(junk), null, `${JSON.stringify(junk)} should be unknown`);
  }
  assert.equal(listenerBufferSeconds(null, 30), 30);
  assert.equal(listenerBufferSeconds(null, undefined), 22, 'an absent setting is the shipped default');
  assert.equal(listenerBufferSeconds(null, Number.NaN), 22);
});

test('a marker that contradicts itself, or holds an impossible burst, is unknown', () => {
  // The bytes are what icecast was given; seconds that disagree with them come
  // from a writer this reader does not understand.
  assert.equal(renderedBufferSeconds(mp3({ burstBytes: 1 })), null);
  assert.equal(renderedBufferSeconds(mp3({ burstSeconds: 61, burstBytes: 61 * 192 * 125 })), null, 'past the setting\'s bound');
  assert.equal(renderedBufferSeconds(mp3({ burstSeconds: 22.5, burstBytes: 22.5 * 192 * 125 })), null);
  assert.equal(renderedBufferSeconds(mp3({ burstSeconds: '22' })), null);
  assert.equal(renderedBufferSeconds(mp3({ kbps: 0, burstBytes: 0 })), null);
  assert.equal(renderedBufferSeconds(mp3({ kbps: -192 })), null);
});

test('advertisedBufferSeconds reads the file the renderers write, and falls back without it', () => {
  setCache({ stream: { bufferSeconds: 40 } });
  const file = config.liquidsoap.streamMountsFile;
  assert.equal(file, join(stateDir, 'stream-mounts.json'));
  // The operator raised the setting to 40, but the running mounts burst 22.
  writeFileSync(file, JSON.stringify(mp3()));
  assert.equal(advertisedBufferSeconds(1_000_000), 22);
  // A torn or foreign file is unknown, so the setting is the answer.
  writeFileSync(file, '{ half-writ');
  assert.equal(advertisedBufferSeconds(2_000_000), 40);
  writeFileSync(file, JSON.stringify(mp3({ burstSeconds: 40, burstBytes: 40 * 192 * 125 })));
  assert.equal(advertisedBufferSeconds(3_000_000), 40);
  // Memoised briefly: /now-playing is every listener's 5 s poll.
  writeFileSync(file, JSON.stringify(mp3()));
  assert.equal(advertisedBufferSeconds(3_001_000), 40);
  assert.equal(advertisedBufferSeconds(3_002_000), 22);
});

// ---------------------------------------------------------------------------
// The two renderers
// ---------------------------------------------------------------------------

const SUPERVISORS = [
  { name: 'broadcast-entrypoint.sh', path: join(repo, 'docker', 'broadcast-entrypoint.sh'), lib: 'SUBWAVE_BROADCAST_LIB' },
  { name: 'aio/supervisor.sh', path: join(repo, 'docker', 'aio', 'supervisor.sh'), lib: 'SUBWAVE_SUPERVISOR_LIB' },
] as const;

// The functions both copies must carry. Compared as `declare -f` prints them,
// so indentation and comments may differ but the code may not.
const SHARED = [
  'read_state_uint', 'read_state_kbps', 'opus_encoding', 'emit_stream_mount',
  'write_stream_mounts_marker', 'render_stream_mounts',
];

let caseNo = 0;
const newDir = () => {
  const d = join(shellTmp, `case-${caseNo++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

type Marker = {
  mounts: Record<string, { kbps: number; burstSeconds: number; burstBytes: number; encoding?: string }>;
  at: number;
};

type Render = {
  status: number;
  out: string;
  xml: string;
  marker: Marker | null;
  handed: Record<string, string>;
};

// Drive render_stream_mounts() against a scratch state dir. STATE_DIR is set
// after the source, as in trusted-proxies.test.ts: the AIO supervisor assigns
// it at module scope, so an env var would be clobbered by loading the script.
function render(
  script: string, lib: string, dir: string,
  opts: { files?: Record<string, string>; env?: Record<string, string>; authUrl?: string; radioLiq?: string } = {},
): Render {
  for (const [name, body] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, name), body);
  const xmlPath = join(shellTmp, `xml-${caseNo++}.xml`);
  const cmd = `set -eu; ${lib}=1 source "$1"; STATE_DIR="$2"; ` +
    'render_stream_mounts "$3" "$4" "$5" 2>&1; ' +
    'echo "HANDED mp3=$SUBWAVE_STREAM_BITRATE opus=$SUBWAVE_OPUS_BITRATE aac=$SUBWAVE_AAC_BITRATE"';
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', ...opts.env };
  let status = 0;
  let out = '';
  try {
    out = execFileSync(
      'bash',
      ['-c', cmd, 'bash', script, dir, xmlPath, opts.authUrl ?? '', opts.radioLiq ?? RADIO_LIQ],
      { encoding: 'utf8', env },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const markerPath = join(dir, 'stream-mounts.json');
  const handedLine = /^HANDED (.*)$/m.exec(out)?.[1] ?? '';
  return {
    status,
    out,
    xml: existsSync(xmlPath) ? readFileSync(xmlPath, 'utf8') : '',
    marker: existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null,
    handed: Object.fromEntries(handedLine.split(' ').filter(Boolean).map(kv => kv.split('=') as [string, string])),
  };
}

// Each <mount> block's burst-size, keyed by mount name.
function xmlBursts(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of xml.matchAll(/<mount-name>([^<]+)<\/mount-name>\s*<burst-size>(\d+)<\/burst-size>/g)) {
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

const OPUS_CBR = `
opus_enc =
  if obr <= 96 then
    %opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="none")
  else
    %opus(
      bitrate=320,
      vbr = "none"
    )
  end
`;

test('both renderers carry the same shared functions', () => {
  const dump = (s: (typeof SUPERVISORS)[number]) => execFileSync(
    'bash', ['-c', `${s.lib}=1 source "$1"; declare -f ${SHARED.join(' ')}`, 'bash', s.path],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
  );
  const [entrypoint, aio] = SUPERVISORS.map(dump);
  for (const fn of SHARED) assert.match(entrypoint!, new RegExp(`^${fn} \\(\\)`, 'm'), `${fn} missing`);
  assert.equal(aio, entrypoint, 'the AIO copy has drifted from the entrypoint\'s');
});

test('radio.liq takes the handed bitrates under the names the renderers export', () => {
  // A rename on either side makes radio.liq fall back to its own file read,
  // which is the race this handoff closes, with nothing failing.
  const liq = readFileSync(RADIO_LIQ, 'utf8');
  const calls = [...liq.matchAll(/burst_bitrate\("([A-Z_]+)", "([a-z_]+\.txt)", (\d+)\)/g)]
    .map(m => ({ env: m[1]!, file: m[2]!, fallback: m[3]! }));
  assert.deepEqual(calls, [
    { env: 'SUBWAVE_STREAM_BITRATE', file: 'liquidsoap_stream_bitrate.txt', fallback: '192' },
    { env: 'SUBWAVE_OPUS_BITRATE', file: 'liquidsoap_opus_bitrate.txt', fallback: '96' },
    { env: 'SUBWAVE_AAC_BITRATE', file: 'liquidsoap_aac_bitrate.txt', fallback: '192' },
  ]);
  // Every bitrate read goes through it, so none can read the file a second time.
  for (const { file } of calls) {
    assert.equal(liq.split(file).length - 1, 1, `${file} is read outside burst_bitrate`);
  }
});

for (const s of SUPERVISORS) {
  assert.ok(existsSync(s.path), `${s.name} not found at ${s.path}`);

  test(`${s.name}: the marker records every mount's burst exactly as rendered`, () => {
    const dir = newDir();
    const r = render(s.path, s.lib, dir, {
      files: {
        'liquidsoap_stream_buffer_seconds.txt': '40',
        'liquidsoap_stream_bitrate.txt': '128',
        'liquidsoap_opus_bitrate.txt': '192',
        'liquidsoap_aac_bitrate.txt': '256',
      },
    });
    assert.equal(r.status, 0, r.out);
    const bursts = xmlBursts(r.xml);
    assert.deepEqual(Object.keys(bursts), ['/stream.mp3', '/stream.opus', '/stream.flac', '/stream.aac']);
    assert.deepEqual(Object.keys(r.marker!.mounts), Object.keys(bursts));
    const kbps = { '/stream.mp3': 128, '/stream.opus': 192, '/stream.flac': 900, '/stream.aac': 256 };
    for (const [mount, bytes] of Object.entries(bursts)) {
      const m = r.marker!.mounts[mount];
      assert.equal(m.burstBytes, bytes, `${mount}: the marker disagrees with icecast.xml`);
      assert.equal(m.kbps, kbps[mount as keyof typeof kbps]);
      assert.equal(m.burstSeconds, 40);
    }
    assert.equal(typeof r.marker!.at, 'number');
    // Through the controller's own reader, not field by field.
    assert.equal(renderedBufferSeconds(r.marker), 40);
    // World-readable for the controller's uid, writable only by this one.
    const mode = statSync(join(dir, 'stream-mounts.json')).mode & 0o777;
    assert.equal(mode & 0o004, 0o004, `mode ${mode.toString(8)}`);
    assert.equal(mode & 0o022, 0, `mode ${mode.toString(8)}`);
    assert.equal(existsSync(join(dir, 'stream-mounts.json.tmp')), false);
  });

  test(`${s.name}: liquidsoap is handed the bitrate each burst was sized for`, () => {
    const r = render(s.path, s.lib, newDir(), {
      files: {
        'liquidsoap_stream_bitrate.txt': '64',
        'liquidsoap_opus_bitrate.txt': '128',
        'liquidsoap_aac_bitrate.txt': '128',
      },
    });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.handed, { mp3: '64', opus: '128', aac: '128' });
    assert.equal(r.marker!.mounts['/stream.mp3'].kbps, 64);
    assert.equal(r.marker!.mounts['/stream.opus'].kbps, 128);
    assert.equal(r.marker!.mounts['/stream.aac'].kbps, 128);
  });

  test(`${s.name}: absent state renders today's defaults`, () => {
    const r = render(s.path, s.lib, newDir());
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.handed, { mp3: '192', opus: '96', aac: '192' });
    assert.deepEqual(xmlBursts(r.xml), {
      '/stream.mp3': 22 * 192 * 125,
      '/stream.opus': 22 * 96 * 125,
      '/stream.flac': 22 * 900 * 125,
      '/stream.aac': 22 * 192 * 125,
    });
    assert.equal(renderedBufferSeconds(r.marker), 22);
  });

  test(`${s.name}: a bitrate radio.liq would refuse sizes no burst either`, () => {
    // radio.liq keeps its default for 0 (`v > 0`), so a burst sized for 0 kbps
    // would hold nothing behind an advertised 22 s. A leading zero is decimal,
    // as radio.liq reads it, not bash's octal (`0128` was an arithmetic error).
    const r = render(s.path, s.lib, newDir(), {
      files: {
        'liquidsoap_stream_bitrate.txt': '0',
        'liquidsoap_opus_bitrate.txt': '0128',
        'liquidsoap_aac_bitrate.txt': '1234567',
        'liquidsoap_stream_buffer_seconds.txt': '022',
      },
    });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.handed, { mp3: '192', opus: '128', aac: '192' });
    assert.equal(r.marker!.mounts['/stream.mp3'].burstBytes, 22 * 192 * 125);
    assert.equal(r.marker!.mounts['/stream.opus'].burstBytes, 22 * 128 * 125);
    assert.equal(renderedBufferSeconds(r.marker), 22);
  });

  test(`${s.name}: a padded or CRLF handoff hands liquidsoap what radio.liq would have read`, () => {
    // radio.liq string.trims these files. Read untrimmed, '128\r\n' was the
    // fallback here, and handing that on would move the encoder off the
    // operator's 128 to 192, where before only the burst was wrong.
    const r = render(s.path, s.lib, newDir(), {
      files: {
        'liquidsoap_stream_bitrate.txt': '128 \r\n',
        'liquidsoap_opus_bitrate.txt': ' 192\n',
        'liquidsoap_stream_buffer_seconds.txt': '\t40 \r\n',
      },
    });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.handed.mp3, '128');
    assert.equal(r.handed.opus, '192');
    assert.equal(xmlBursts(r.xml)['/stream.mp3'], 40 * 128 * 125);
    assert.equal(renderedBufferSeconds(r.marker), 40);
  });

  test(`${s.name}: the buffer is clamped to 60 s and the marker says so`, () => {
    const r = render(s.path, s.lib, newDir(), { files: { 'liquidsoap_stream_buffer_seconds.txt': '90' } });
    assert.equal(r.status, 0, r.out);
    assert.equal(xmlBursts(r.xml)['/stream.mp3'], 60 * 192 * 125);
    assert.equal(renderedBufferSeconds(r.marker), 60);
  });

  test(`${s.name}: ICECAST_STREAM_BITRATE re-sizes the burst, never the encoder`, () => {
    // The env override has only ever sized the burst; liquidsoap encodes at the
    // setting. Handing it the override would change a configured station's
    // audio on upgrade.
    const r = render(s.path, s.lib, newDir(), {
      files: { 'liquidsoap_stream_bitrate.txt': '128' },
      env: { ICECAST_STREAM_BITRATE: '320' },
    });
    assert.equal(r.status, 0, r.out);
    assert.equal(xmlBursts(r.xml)['/stream.mp3'], 22 * 320 * 125);
    assert.equal(r.marker!.mounts['/stream.mp3'].kbps, 320);
    assert.equal(r.handed.mp3, '128');
  });

  test(`${s.name}: listener auth still reaches every mount`, () => {
    const r = render(s.path, s.lib, newDir(), { authUrl: 'http://controller:7701/listener-auth?a=1&amp;b=2' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.xml.split('<authentication type="url">').length - 1, 4);
    assert.match(r.xml, /value="http:\/\/controller:7701\/listener-auth\?a=1&amp;b=2"/);
    assert.equal(render(s.path, s.lib, newDir()).xml.includes('<authentication'), false);
  });

  test(`${s.name}: the Opus encoding is read from the encoder lines`, () => {
    const liq = join(shellTmp, `radio-${caseNo++}.liq`);
    const enc = (body: string) => {
      writeFileSync(liq, body);
      return render(s.path, s.lib, newDir(), { radioLiq: liq }).marker!.mounts['/stream.opus'].encoding;
    };
    // Every %opus says vbr="none", even split across lines: hard CBR.
    assert.equal(enc(OPUS_CBR), 'cbr');
    // One VBR branch is enough to make the burst untrustworthy as seconds.
    assert.equal(enc(`${OPUS_CBR}\n%opus(bitrate=128, vbr="constrained")\n`), 'vbr');
    // No vbr argument is the encoder's default, which is not a CBR promise.
    assert.equal(enc('%opus(bitrate=96, samplerate=48000)\n'), 'vbr');
    // Nor is DTX, which can stop sending silent frames under vbr="none" too.
    assert.equal(enc(OPUS_CBR.replace('vbr="none")', 'vbr="none", dtx=true)')), 'vbr');
    assert.equal(enc(OPUS_CBR.replace('vbr="none")', 'vbr="none", dtx=false)')), 'cbr');
    // A comment is not an encoder.
    assert.equal(enc(`${OPUS_CBR}\n# %opus(bitrate=128, vbr="constrained")\n`), 'cbr');
    // Nothing to read: the field is absent, never a guess.
    assert.equal(enc('output.dummy(blank())\n'), undefined);
    const missing = render(s.path, s.lib, newDir(), { radioLiq: join(shellTmp, 'no-such.liq') });
    assert.equal(missing.status, 0, missing.out);
    assert.equal('encoding' in missing.marker!.mounts['/stream.opus'], false);
    // Only the Opus mount carries one.
    assert.equal('encoding' in missing.marker!.mounts['/stream.mp3'], false);
  });

  test(`${s.name}: the real radio.liq's Opus encoders are readable`, () => {
    // Whatever the encoder is today (#2138 changes it), the classifier must
    // still find it: an unreadable radio.liq would silently drop the field.
    const r = render(s.path, s.lib, newDir());
    assert.equal(r.status, 0, r.out);
    assert.ok(['cbr', 'vbr'].includes(r.marker!.mounts['/stream.opus']?.encoding ?? ''), JSON.stringify(r.marker));
  });

  test(`${s.name}: an unwritable state dir warns and still renders the mounts`, () => {
    // Never fatal, same rule as the state bootstrap: the station must still boot.
    const bad = join(shellTmp, `not-a-dir-${caseNo++}`);
    writeFileSync(bad, 'not a directory');
    const r = render(s.path, s.lib, bad);
    assert.equal(r.status, 0, `render aborted over the marker: ${r.out}`);
    assert.equal(Object.keys(xmlBursts(r.xml)).length, 4);
    assert.match(r.out, /WARNING could not write .*stream-mounts\.json/);
    assert.deepEqual(r.handed, { mp3: '192', opus: '96', aac: '192' });
  });

  test(`${s.name}: a failed write removes the last render's marker rather than keep it`, () => {
    // A marker left from an earlier render would advertise a burst these
    // mounts no longer hold; with none, the controller falls back to the setting.
    const dir = newDir();
    render(s.path, s.lib, dir, { files: { 'liquidsoap_stream_buffer_seconds.txt': '40' } });
    assert.ok(existsSync(join(dir, 'stream-mounts.json')));
    mkdirSync(join(dir, 'stream-mounts.json.tmp')); // the temp write now fails
    const r = render(s.path, s.lib, dir, { files: { 'liquidsoap_stream_buffer_seconds.txt': '10' } });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.marker, null, 'a stale marker survived a failed write');
    assert.match(r.out, /WARNING could not write/);
  });

  test(`${s.name}: no state dir at all is silent, and still renders`, () => {
    const r = render(s.path, s.lib, '');
    assert.equal(r.status, 0, r.out);
    assert.equal(Object.keys(xmlBursts(r.xml)).length, 4);
    assert.doesNotMatch(r.out, /WARNING/);
  });
}

test('aio/supervisor.sh: a multi-station render lands in the active station\'s dir', () => {
  // The AIO re-resolves the station on every pair launch; the marker must
  // follow it, because the controller reads the active station's dir.
  const root = newDir();
  const station = join(root, 'stations', 'night');
  mkdirSync(station, { recursive: true });
  writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"night"}');
  writeFileSync(join(station, 'liquidsoap_stream_buffer_seconds.txt'), '12');
  const aio = SUPERVISORS[1];
  const xml = join(shellTmp, `xml-${caseNo++}.xml`);
  execFileSync('bash', [
    '-c', `set -eu; ${aio.lib}=1 source "$1"; resolve_state_dir 2>/dev/null; render_stream_mounts "$2" '' "$3" 2>/dev/null`,
    'bash', aio.path, xml, RADIO_LIQ,
  ], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', SUBWAVE_STATE_ROOT: root } });
  assert.equal(existsSync(join(root, 'stream-mounts.json')), false, 'written to the root, not the station');
  const marker = JSON.parse(readFileSync(join(station, 'stream-mounts.json'), 'utf8'));
  assert.equal(renderedBufferSeconds(marker), 12);
});

// ---------------------------------------------------------------------------
// The listener surfaces
// ---------------------------------------------------------------------------

test('/now-playing and the voice webhooks advertise the rendered burst, not the setting', async () => {
  // The bug as reported: the operator raised the setting to 40 and has not
  // restarted the mixer, so the mounts still burst 22. Here the reverse — the
  // setting says 22 while the marker says 40 — so a route still reading the
  // setting answers 22 and fails. Run last: the reader's 2 s memo has only
  // seen the fake clock above, so the real one reads the file fresh.
  const express = (await import('express')).default;
  const settings = await import('../src/settings.js');
  const { router } = await import('../src/routes/public.js');
  const { notifyQueued, notifySpoken } = await import('../src/broadcast/voice-events.js');
  const { listen } = await import('./test-utils/http.js');

  // Loopback only: the weather lookup must fail fast rather than reach out.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    throw new Error('offline');
  }) as typeof fetch;

  const received: Array<Record<string, unknown>> = [];
  const hooks = await listen((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { received.push(JSON.parse(raw)); } catch { /* not ours */ }
      res.writeHead(200).end('ok');
    });
  });
  const app = await listen(express().use(router));
  try {
    await settings.load();
    const loaded = settings.get();
    setCache({
      ...loaded,
      stream: { ...loaded.stream, bufferSeconds: 22 },
      webhooks: [{
        id: 'test_hook', url: `${hooks.url}/hook`, events: ['voice.queued', 'voice.start'], enabled: true, authHeader: '',
      }],
    });
    writeFileSync(config.liquidsoap.streamMountsFile, JSON.stringify(mp3({ burstSeconds: 40, burstBytes: 40 * 192 * 125 })));

    const np = await (await fetch(`${app.url}/now-playing`)).json() as { stream: { bufferSeconds: number } };
    assert.equal(np.stream.bufferSeconds, 40);

    notifyQueued({ voiceId: 'v1', kind: 'link', channel: 'intro', text: 'deeper', durationMs: 900, estimatedAirInMs: 500 });
    notifySpoken({ voiceId: 'v1', kind: 'link', channel: 'intro', text: 'deeper', durationMs: 900, airedAt: Date.now(), legacy: false });
    const deadline = Date.now() + 3_000;
    while (received.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    const byEvent = Object.fromEntries(received.map(b => [b.event, b]));
    assert.equal(byEvent['voice.queued']?.streamBufferSeconds, 40);
    assert.equal(byEvent['voice.start']?.streamBufferSeconds, 40);
  } finally {
    globalThis.fetch = realFetch;
    hooks.server.closeAllConnections();
    app.server.closeAllConnections();
    await hooks.close();
    await app.close();
  }
});
