// Trusted reverse proxies (#1613) — the marker the icecast render writes, and
// the reader that turns it into an admin-visible reason.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  trustedProxyState,
  needsTrustedProxyHint,
} from '../src/broadcast/trusted-proxies-pure.js';

const here = dirname(fileURLToPath(import.meta.url));
const docker = join(here, '..', '..', 'docker');


test('an absent or unparseable marker is UNKNOWN, not a miss', () => {
  // This is the upgrade path: a controller running ahead of its broadcast
  // image finds no file at all. Reading that as "no proxy trusted" would put a
  for (const junk of [null, undefined, 'nope', 42, [], {}]) {
    const s = trustedProxyState(junk);
    assert.equal(s.known, false, `${JSON.stringify(junk)} should be unknown`);
    assert.equal(needsTrustedProxyHint(s), false, 'unknown must render nothing');
  }
});

test('a rendered proxy list is read back whole', () => {
  const s = trustedProxyState({
    count: 2, source: 'ICECAST_TRUSTED_PROXY_IPS',
    proxies: ['172.20.0.100', '::1'], dropped: [], at: 1,
  });
  assert.equal(s.known, true);
  assert.equal(s.count, 2);
  assert.equal(s.source, 'ICECAST_TRUSTED_PROXY_IPS');
  assert.deepEqual(s.proxies, ['172.20.0.100', '::1']);
  // Nothing to explain: the table is already showing real client addresses.
  assert.equal(needsTrustedProxyHint(s), false);
});

test('a miss is known, counted at zero, and names the source that was tried', () => {
  const s = trustedProxyState({
    count: 0, source: 'ICECAST_TRUSTED_PROXY_HOSTS', proxies: [], dropped: [], at: 1,
  });
  assert.equal(s.known, true);
  assert.equal(s.source, 'ICECAST_TRUSTED_PROXY_HOSTS');
  assert.equal(needsTrustedProxyHint(s), true);
});

test('a dropped entry earns a hint even when something else resolved', () => {
  // The quiet half of the bug: the operator set the var, one entry took, and
  // the subnet they actually meant was thrown away without them seeing it.
  const s = trustedProxyState({
    count: 1, source: 'ICECAST_TRUSTED_PROXY_IPS',
    proxies: ['172.20.0.100'], dropped: ['10.0.0.0/8'], at: 1,
  });
  assert.equal(needsTrustedProxyHint(s), true);
  assert.deepEqual(s.dropped, ['10.0.0.0/8']);
});

test('a marker that contradicts itself is UNKNOWN', () => {
  // A count that disagrees with the list it summarises comes from a writer
  // this reader does not understand. Believing either half would put a hint on
  const s = trustedProxyState({
    count: 3, source: 'ICECAST_TRUSTED_PROXY_IPS', proxies: ['1.2.3.4'], dropped: [],
  });
  assert.equal(s.known, false);
});

test('marker fields are filtered, not trusted — this is a file on disk', () => {
  const s = trustedProxyState({
    count: 1, source: 'ICECAST_TRUSTED_PROXY_IPS',
    proxies: ['1.2.3.4'],
    dropped: ['10.0.0.0/8', '<script>', 42, null, 'x'.repeat(200)],
  });
  assert.deepEqual(s.dropped, ['10.0.0.0/8']);
  // A source that is not a plain label is a marker to distrust entirely.
  assert.equal(trustedProxyState({ count: 0, source: '</x>', proxies: [] }).known, false);
});


const SUPERVISORS = [
  { name: 'broadcast-entrypoint.sh', path: join(docker, 'broadcast-entrypoint.sh'), lib: 'SUBWAVE_BROADCAST_LIB' },
  { name: 'aio/supervisor.sh', path: join(docker, 'aio', 'supervisor.sh'), lib: 'SUBWAVE_SUPERVISOR_LIB' },
] as const;

const shellTmp = mkdtempSync(join(tmpdir(), 'subwave-trusted-proxies-'));
let caseNo = 0;

type Render = { status: number; out: string; xml: string; marker: unknown; dir: string };

// Drive render_trusted_proxies() against a scratch state dir, under the same
// `set -eu` the real entrypoint runs with — an unset-variable slip or a
function render(
  script: string, lib: string, source: string, candidates: string,
  opts: { stateDir?: string | null } = {},
): Render {
  const dir = opts.stateDir === undefined ? join(shellTmp, `case-${caseNo++}`) : opts.stateDir;
  if (opts.stateDir === undefined) mkdirSync(dir as string, { recursive: true });
  const xmlPath = join(shellTmp, `xml-${caseNo++}.xml`);
  // STATE_DIR is assigned AFTER the source and as a call prefix, not through
  // the environment: the AIO supervisor sets STATE_DIR at module scope, so an
  // env var would be clobbered by the very act of loading it (the same reason
  const cmd = `set -eu; ${lib}=1 source "$1"; STATE_DIR="$2" render_trusted_proxies "$3" "$4" $5 2>&1`;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: process.env.PATH ?? '' };

  let status = 0;
  let out = '';
  try {
    out = execFileSync(
      'bash',
      ['-c', cmd, 'bash', script, dir ?? '', xmlPath, source, candidates],
      { encoding: 'utf8', env },
    );
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const markerPath = dir === null ? null : join(dir, 'trusted-proxies.json');
  let marker: unknown = null;
  if (markerPath && existsSync(markerPath)) marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  return {
    status, out,
    xml: existsSync(xmlPath) ? readFileSync(xmlPath, 'utf8') : '',
    marker,
    dir: dir ?? '',
  };
}

// Every address the shape test must accept or refuse. The hex-only words are
// the ones a character class silently KEPT: `''|*[!0-9a-fA-F.:]*` accepts
// `cafe`, `beef`, `ace`, `ff` and a bare `a` while correctly dropping `caddy`
const SHAPES: [addr: string, valid: boolean, why: string][] = [
  ['172.20.0.100', true, 'the documented bundled-Caddy pin'],
  ['127.0.0.1', true, 'the AIO default'],
  ['0.0.0.0', true, 'edges of the octet range are addresses'],
  ['255.255.255.255', true, 'edges of the octet range are addresses'],
  ['::1', true, 'the AIO default, v6 half'],
  ['fd00::1', true, 'an ordinary ULA'],
  ['2001:db8::1', true, 'an ordinary global v6'],
  ['::ffff:1.2.3.4', true, 'the v4-mapped form carries dots and a colon'],
  ['cafe', false, 'a hex-only HOSTNAME — the measured miss'],
  ['beef', false, 'a hex-only hostname'],
  ['ace', false, 'a hex-only hostname'],
  ['ff', false, 'a hex-only hostname'],
  ['a', false, 'one hex digit is not an address'],
  ['caddy', false, 'a hostname the old test already dropped — keep dropping it'],
  ['localhost', false, 'a hostname the old test already dropped'],
  ['10.0.0.0/8', false, 'icecast matches an exact IP; a CIDR never matches'],
  ['1.2.3', false, 'three octets is not a quad'],
  ['1.2.3.4.5', false, 'five octets is not a quad'],
  ['256.1.1.1', false, 'an octet above 255'],
  ['1..3.4', false, 'an empty octet'],
  ['1.2.3.4a', false, 'trailing junk on a real address'],
  ['99999999999999999999.1.1.1', false, 'too long to be an octet — and never an arithmetic error'],
  [':::::', false, 'colons with no hex digit is not an address'],
  ['', false, 'empty'],
];

for (const s of SUPERVISORS) {
  assert.ok(existsSync(s.path), `${s.name} not found at ${s.path}`);

  test(`${s.name}: the address test checks SHAPE, not characters`, () => {
    // Driven as one bash run: a process per row is 24 spawns per supervisor.
    const rows = SHAPES.map(([addr]) => addr);
    const script = `set -eu; ${s.lib}=1 source "$1"; shift; ` +
      'for a in "$@"; do if trusted_proxy_valid "$a"; then echo keep; else echo drop; fi; done';
    const out = execFileSync('bash', ['-c', script, 'bash', s.path, ...rows], {
      encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH ?? '' },
    }).trim().split('\n');
    assert.equal(out.length, SHAPES.length, `expected one verdict per row: ${out.join(',')}`);
    SHAPES.forEach(([addr, valid, why], i) => {
      assert.equal(
        out[i], valid ? 'keep' : 'drop',
        `${JSON.stringify(addr)} should ${valid ? 'keep' : 'drop'} — ${why}`,
      );
    });
  });

  test(`${s.name}: a hex-only hostname is dropped, not written into icecast.xml`, () => {
    // End to end, because the shape test only matters if the render uses it:
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', 'cafe 172.20.0.100');
    assert.equal(r.status, 0, r.out);
    assert.equal(r.xml, '        <x-forwarded-for>172.20.0.100</x-forwarded-for>\n');
    assert.match(r.out, /WARNING ignoring malformed trusted proxy 'cafe'/);
    const state = trustedProxyState(r.marker);
    assert.equal(state.count, 1, 'the count the dash shows must not include an unmatchable entry');
    assert.deepEqual(state.proxies, ['172.20.0.100']);
    assert.deepEqual(state.dropped, ['cafe']);
  });

  test(`${s.name}: a resolved list reaches both the XML and the marker`, () => {
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', '172.20.0.100 ::1');
    assert.equal(r.status, 0, r.out);
    assert.equal(
      r.xml,
      '        <x-forwarded-for>172.20.0.100</x-forwarded-for>\n' +
      '        <x-forwarded-for>::1</x-forwarded-for>\n',
    );
    // The marker is read by the controller, so it is asserted through the same
    // parser the controller uses rather than field by field.
    const state = trustedProxyState(r.marker);
    assert.equal(state.known, true);
    assert.equal(state.count, 2);
    assert.equal(state.source, 'ICECAST_TRUSTED_PROXY_IPS');
    assert.deepEqual(state.proxies, ['172.20.0.100', '::1']);
    assert.equal(needsTrustedProxyHint(state), false);
  });

  test(`${s.name}: a resolved-nothing source is recorded as a miss, by name`, () => {
    // The BYO case: no `caddy` to resolve, so the candidate list is empty. The
    // XML must stay empty (a miss degrades to the peer address, never to a
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_HOSTS', '');
    assert.equal(r.status, 0, r.out);
    assert.equal(r.xml, '', 'a miss must render no <x-forwarded-for> at all');
    assert.match(r.out, /no trusted proxy resolved/i, `the log line is still the first signal: ${r.out}`);
    const state = trustedProxyState(r.marker);
    assert.equal(state.known, true);
    assert.equal(state.count, 0);
    assert.equal(state.source, 'ICECAST_TRUSTED_PROXY_HOSTS');
    assert.equal(needsTrustedProxyHint(state), true);
  });

  test(`${s.name}: a CIDR is dropped, named and recorded — never interpolated`, () => {
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', '10.0.0.0/8 172.20.0.100');
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.xml, /10\.0\.0\.0/, 'a subnet reached icecast.xml');
    assert.equal(r.xml, '        <x-forwarded-for>172.20.0.100</x-forwarded-for>\n');
    assert.match(r.out, /WARNING ignoring malformed trusted proxy '10\.0\.0\.0\/8'/);
    const state = trustedProxyState(r.marker);
    assert.deepEqual(state.dropped, ['10.0.0.0/8']);
    assert.equal(state.count, 1);
    // Something resolved, but the operator still needs telling.
    assert.equal(needsTrustedProxyHint(state), true);
  });

  test(`${s.name}: a hostile entry cannot break the marker it is recorded in`, () => {
    // Dropped entries are operator input on their way into JSON. A quote or a
    // backslash would produce a marker the controller cannot parse — which
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', '"},{"x 172.20.0.100');
    assert.equal(r.status, 0, r.out);
    assert.equal(r.xml, '        <x-forwarded-for>172.20.0.100</x-forwarded-for>\n');
    const state = trustedProxyState(r.marker); // throws on unparseable JSON above
    assert.equal(state.known, true);
    assert.equal(state.count, 1);
    assert.equal(state.dropped.length, 1);
    assert.doesNotMatch(state.dropped[0]!, /["\\]/, 'a quote survived into the marker');
  });

  test(`${s.name}: an unwritable state dir warns and still renders the XML`, () => {
    // Same never-fatal contract as bootstrap_state_dirs. A plain file where the
    // state dir belongs makes the marker path unusable through the same branch
    const bad = join(shellTmp, `not-a-dir-${caseNo++}`);
    writeFileSync(bad, 'not a directory');
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', '172.20.0.100', { stateDir: bad });
    assert.equal(r.status, 0, `render aborted (exit ${r.status}) over the marker: ${r.out}`);
    assert.equal(r.xml, '        <x-forwarded-for>172.20.0.100</x-forwarded-for>\n');
    assert.match(r.out, /WARNING/i, `not surfaced as a warning: ${r.out}`);
    assert.match(r.out, /trusted-proxies\.json/, `the warning does not name the path: ${r.out}`);
  });

  test(`${s.name}: no state dir at all is silent, and still renders`, () => {
    // Multi-station resolution runs before the render, so this should not
    // happen — but a marker is a diagnostic, and a missing one must cost
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', '172.20.0.100', { stateDir: null });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.xml, '        <x-forwarded-for>172.20.0.100</x-forwarded-for>\n');
    assert.doesNotMatch(r.out, /WARNING/i, `expected no warning, got: ${r.out}`);
  });

  test(`${s.name}: the marker is rewritten on every render`, () => {
    // It describes the config icecast was just started with, so a marker left
    // over from the boot BEFORE the operator removed the var would explain a
    const dir = join(shellTmp, `case-${caseNo++}`);
    mkdirSync(dir, { recursive: true });
    render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', '172.20.0.100', { stateDir: dir });
    const after = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_HOSTS', '', { stateDir: dir });
    const state = trustedProxyState(after.marker);
    assert.equal(state.count, 0);
    assert.deepEqual(state.proxies, []);
    assert.equal(state.source, 'ICECAST_TRUSTED_PROXY_HOSTS');
    // …and it leaves no temp behind for the state-dir sweep to trip over.
    assert.equal(existsSync(join(dir, 'trusted-proxies.json.tmp')), false);
  });

  test(`${s.name}: the marker is world-READABLE, not world-writable`, () => {
    // The controller reads it as another uid, and nothing else writes it. 666
    // would put a second writer's permission on a single-writer file for no
    const r = render(s.path, s.lib, 'ICECAST_TRUSTED_PROXY_IPS', '172.20.0.100');
    assert.equal(r.status, 0, r.out);
    const mode = statSync(join(r.dir, 'trusted-proxies.json')).mode & 0o777;
    assert.equal(mode & 0o004, 0o004, `not readable by the controller (mode ${mode.toString(8)})`);
    assert.equal(mode & 0o022, 0, `writable by others (mode ${mode.toString(8)})`);
  });

  test(`${s.name}: the resolution has exactly one caller`, () => {
    // Both files used to carry the block inline, which is how the two copies
    // drift. A second call site here means the duplicate came back.
    const src = readFileSync(s.path, 'utf8');
    const calls = src.split('\n').filter(l => /^\s*render_trusted_proxies /.test(l));
    assert.equal(calls.length, 1, `expected one call site, found ${calls.length}`);
    // Comments discuss the tag; only a second line that WRITES one is the bug.
    const code = src
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .filter(l => !/^\s*echo\s+".*x-forwarded-for/.test(l))
      .join('\n');
    assert.doesNotMatch(
      code,
      /<x-forwarded-for>/,
      'an inline <x-forwarded-for> writer outside render_trusted_proxies',
    );
  });
}

test('the AIO still trusts loopback by default — Caddy is in that container', () => {
  // The bundled paths must be byte-identical on upgrade: the AIO's candidate
  // list with no env override is the same "127.0.0.1 ::1" it always was.
  const src = readFileSync(join(docker, 'aio', 'supervisor.sh'), 'utf8');
  assert.match(src, /TRUSTED_LIST="127\.0\.0\.1 ::1"/);
});

test('the split stack still defaults to DNS for the bundled caddy', () => {
  const src = readFileSync(join(docker, 'broadcast-entrypoint.sh'), 'utf8');
  assert.match(src, /ICECAST_TRUSTED_PROXY_HOSTS:-caddy/);
});
