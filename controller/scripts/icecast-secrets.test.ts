// Icecast password resolution in the two supervisors
// (docker/broadcast-entrypoint.sh and docker/aio/supervisor.sh:
// resolve_icecast_secrets / write_icecast_secrets / xml_escape).
//
// state/icecast-secrets.env used to be SOURCED as shell on every boot, then
// rewritten with an unquoted heredoc. A password override holding a space or a
// `;` was persisted on the first boot and run as a command on the second, so
// the station crash-looped off air, and removing the override did not help,
// because the file was sourced before the override applied. The same values
// went into icecast.xml through `sed s|…|$VALUE|` with no escaping: a `|` broke
// the sed, a `&` silently changed the password (source refused, dead air), and
// a `<` made the XML invalid.
//
// The load-bearing properties, in order:
//   1. The file is DATA. Only the three known keys are read; nothing in it is
//      ever executed.
//   2. Every value, from env or file, is checked against one safe character
//      set before it is used. A refused value WARNS, naming the variable (never
//      the value), and resolution falls through to the next source. It never
//      aborts: a station that will not boot is worse than one on a regenerated
//      password.
//   3. The file is trusted only as a regular file, not a symlink, owned by the
//      uid that writes it, and the write goes through a fresh temp file plus a
//      rename, so it never writes through whatever sits at the path.
//   4. The listener-auth URL is XML-escaped into its attribute.
//
// Both supervisors are driven from ONE table, because the two copies drifting
// apart is how this class comes back.
//
// Run: `npm test -- icecast-secrets`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir } from './test-utils/temp-dir.js';

const here = dirname(fileURLToPath(import.meta.url));
const docker = join(here, '..', '..', 'docker');

const SUPERVISORS = [
  { name: 'broadcast-entrypoint.sh', path: join(docker, 'broadcast-entrypoint.sh'), lib: 'SUBWAVE_BROADCAST_LIB' },
  { name: 'aio/supervisor.sh', path: join(docker, 'aio', 'supervisor.sh'), lib: 'SUBWAVE_SUPERVISOR_LIB' },
] as const;

const KEYS = ['ICECAST_SOURCE_PASSWORD', 'ICECAST_ADMIN_PASSWORD', 'ICECAST_RELAY_PASSWORD'] as const;
type Secrets = Record<(typeof KEYS)[number], string>;

const tmp = createTempDir(join(tmpdir(), 'subwave-icecast-secrets-'));
let caseNo = 0;
function scratch(): string {
  const d = join(tmp, `case-${caseNo++}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// The host's own ICECAST_* must not leak into a run.
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of KEYS) delete env[k];
  return env;
}

type Run = { status: number; out: string; err: string; secrets: Secrets };

// Resolve (and, unless told not to, write) against `file` under `set -eu`, the
// strictest options either supervisor runs under, then print what was
// exported, as a child process would see it.
function resolve(
  s: (typeof SUPERVISORS)[number], file: string,
  env: Record<string, string> = {}, opts: { write?: boolean } = {},
): Run {
  const write = opts.write === false ? '' : 'write_icecast_secrets "$2";';
  const cmd = `set -eu; ${s.lib}=1 source "$1"; resolve_icecast_secrets "$2"; ${write}
    env | grep '^ICECAST_[A-Z]*_PASSWORD=' | sort`;
  const r = spawnSync('bash', ['-c', cmd, 'bash', s.path, file], {
    encoding: 'utf8', env: { ...baseEnv(), ...env },
  });
  const secrets = {} as Secrets;
  for (const line of (r.stdout ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) secrets[line.slice(0, i) as keyof Secrets] = line.slice(i + 1);
  }
  return { status: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '', secrets };
}

function call(s: (typeof SUPERVISORS)[number], fn: string, ...args: string[]): string {
  const r = spawnSync('bash', ['-c', `set -eu; ${s.lib}=1 source "$1"; shift; ${fn} "$@"`, 'bash', s.path, ...args], {
    encoding: 'utf8', env: baseEnv(),
  });
  assert.equal(r.status, 0, `${fn} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// Accepted: everything a generated password is, plus the punctuation that
// already survived the old pipeline, so a working override keeps working.
const VALID = [
  '0123456789abcdef0123456789abcdef',
  'Pa55-word.with_tilde~',
  'a@b!c%d^e*f,g:h/i?j#k+l=m',
];
// Refused: what the file format, sed, XML or the controller's reader would
// reinterpret.
const INVALID = [
  '', 'has space', 'semi;colon', 'pi|pe', 'amp&ersand', 'back\\slash', 'lt<', 'gt>',
  'dq"', "sq'", 'dollar$HOME', 'back`tick`', 'paren(', 'tab\there',
];

const hex32 = /^[0-9a-f]{32}$/;

for (const s of SUPERVISORS) {
  test(`${s.name}: the character set accepts working passwords and refuses the rest`, () => {
    for (const v of VALID) call(s, 'icecast_secret_valid', v);
    for (const v of INVALID) {
      const r = spawnSync('bash', ['-c', `${s.lib}=1 source "$1"; icecast_secret_valid "$2"`, 'bash', s.path, v], {
        encoding: 'utf8', env: baseEnv(),
      });
      assert.notEqual(r.status, 0, `${JSON.stringify(v)} was accepted`);
    }
  });

  test(`${s.name}: a fresh install generates, persists 0600, and reads back the same`, () => {
    const file = join(scratch(), 'icecast-secrets.env');
    const first = resolve(s, file);
    assert.equal(first.status, 0, first.err);
    assert.equal(first.err.trim(), '', `expected silence, got: ${first.err}`);
    for (const k of KEYS) assert.match(first.secrets[k] ?? '', hex32, `${k} not generated`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(file, 'utf8'),
      KEYS.map(k => `${k}=${first.secrets[k]}\n`).join(''),
    );
    const second = resolve(s, file);
    assert.equal(second.err.trim(), '', `second boot not silent: ${second.err}`);
    assert.deepEqual(second.secrets, first.secrets, 'passwords changed across a restart');
  });

  test(`${s.name}: a valid env override wins and is persisted`, () => {
    const file = join(scratch(), 'icecast-secrets.env');
    resolve(s, file);
    const r = resolve(s, file, { ICECAST_ADMIN_PASSWORD: 'Relay-Pass.2026' });
    assert.equal(r.status, 0, r.err);
    assert.equal(r.secrets.ICECAST_ADMIN_PASSWORD, 'Relay-Pass.2026');
    assert.match(readFileSync(file, 'utf8'), /^ICECAST_ADMIN_PASSWORD=Relay-Pass\.2026$/m);
  });

  test(`${s.name}: the file is parsed, never executed`, () => {
    const dir = scratch();
    const file = join(dir, 'icecast-secrets.env');
    const marker = join(dir, 'ran');
    writeFileSync(file, [
      'ICECAST_SOURCE_PASSWORD=keepme123',
      `ICECAST_ADMIN_PASSWORD=pass word; touch ${marker}`,
      `touch ${marker}`,
      `ICECAST_RELAY_PASSWORD=$(touch ${marker})`,
      'SOMETHING_ELSE=ignored',
      '',
    ].join('\n'), { mode: 0o600 });
    const r = resolve(s, file);
    assert.equal(r.status, 0, `aborted instead of degrading: ${r.err}`);
    assert.equal(existsSync(marker), false, 'a line of the secrets file was executed');
    assert.equal(r.secrets.ICECAST_SOURCE_PASSWORD, 'keepme123', 'a valid line was not kept');
    for (const k of ['ICECAST_ADMIN_PASSWORD', 'ICECAST_RELAY_PASSWORD'] as const) {
      assert.match(r.secrets[k], hex32, `${k} not regenerated`);
      assert.match(r.err, new RegExp(`WARNING.*${k}`), `refusal of ${k} not named: ${r.err}`);
    }
    assert.doesNotMatch(r.err, /pass word|touch/, 'a refused value was echoed into the log');
    // The rewrite heals the file, so the next boot is silent.
    const again = resolve(s, file);
    assert.equal(again.err.trim(), '', `healed file still warns: ${again.err}`);
    assert.deepEqual(again.secrets, r.secrets);
  });

  test(`${s.name}: an env override sed or XML would reinterpret is refused, not rendered`, () => {
    const file = join(scratch(), 'icecast-secrets.env');
    const persisted = resolve(s, file).secrets;
    for (const bad of ['two words', 'a|b', 'a&b', 'a<b', 'a\\b']) {
      const r = resolve(s, file, { ICECAST_SOURCE_PASSWORD: bad });
      assert.equal(r.status, 0, `${JSON.stringify(bad)} aborted: ${r.err}`);
      assert.match(r.err, /WARNING.*ICECAST_SOURCE_PASSWORD/, `refusal not named: ${r.err}`);
      assert.ok(!r.err.includes(bad), 'the refused value was echoed into the log');
      // Falls through to the persisted value rather than a fresh one, so the
      // controller's cached admin password and any relay keep matching.
      assert.equal(r.secrets.ICECAST_SOURCE_PASSWORD, persisted.ICECAST_SOURCE_PASSWORD);
      assert.ok(!readFileSync(file, 'utf8').includes(bad), 'the refused value was persisted');
    }
  });

  test(`${s.name}: a hand-quoted value reads as the controller reads it`, () => {
    const file = join(scratch(), 'icecast-secrets.env');
    writeFileSync(file, `ICECAST_SOURCE_PASSWORD="dq-value"\nICECAST_ADMIN_PASSWORD='sq-value'\nICECAST_RELAY_PASSWORD=bare\r\n`, { mode: 0o600 });
    const r = resolve(s, file, {}, { write: false });
    assert.equal(r.err.trim(), '', r.err);
    assert.equal(r.secrets.ICECAST_SOURCE_PASSWORD, 'dq-value');
    assert.equal(r.secrets.ICECAST_ADMIN_PASSWORD, 'sq-value');
    assert.equal(r.secrets.ICECAST_RELAY_PASSWORD, 'bare');
  });

  test(`${s.name}: a symlink at the secrets path is ignored and never written through`, () => {
    const dir = scratch();
    const target = join(dir, 'elsewhere');
    writeFileSync(target, 'ICECAST_ADMIN_PASSWORD=fromthelink\n');
    const file = join(dir, 'icecast-secrets.env');
    symlinkSync(target, file);
    const r = resolve(s, file);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /WARNING.*symlink/, `not warned: ${r.err}`);
    assert.notEqual(r.secrets.ICECAST_ADMIN_PASSWORD, 'fromthelink', 'a symlinked file was trusted');
    assert.equal(readFileSync(target, 'utf8'), 'ICECAST_ADMIN_PASSWORD=fromthelink\n', 'the write followed the link');
    assert.ok(lstatSync(file).isFile(), 'the link was not replaced by a regular file');
  });

  test(`${s.name}: a file owned by another uid is ignored`, (t) => {
    // /etc/passwd is a regular file owned by root; as root it is "ours".
    if (process.getuid?.() === 0) return t.skip('running as root');
    const r = resolve(s, '/etc/passwd', {}, { write: false });
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /WARNING.*owned by uid 0/, `not warned: ${r.err}`);
    for (const k of KEYS) assert.match(r.secrets[k], hex32);
  });

  test(`${s.name}: an unwritable state root warns and still exports passwords`, (t) => {
    if (process.getuid?.() === 0) return t.skip('running as root');
    const dir = scratch();
    chmodSync(dir, 0o555);
    try {
      const r = resolve(s, join(dir, 'icecast-secrets.env'));
      assert.equal(r.status, 0, `aborted on a read-only mount: ${r.err}`);
      assert.match(r.err, /WARNING.*could not write/, `not warned: ${r.err}`);
      for (const k of KEYS) assert.match(r.secrets[k], hex32);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test(`${s.name}: the listener-auth URL is XML-escaped`, () => {
    assert.equal(
      call(s, 'xml_escape', 'http://controller:7701/listener-auth?a=1&b="<x>"'),
      'http://controller:7701/listener-auth?a=1&amp;b=&quot;&lt;x&gt;&quot;',
    );
    assert.equal(call(s, 'xml_escape', 'http://controller:7701/listener-auth'), 'http://controller:7701/listener-auth');
  });
}

// The tables above would catch most drift, but not a character only one copy
// added, so the pattern and the set the warning prints are compared outright.
test('both supervisors carry the same character set', () => {
  const patterns = SUPERVISORS.map(s =>
    readFileSync(s.path, 'utf8').match(/^\s*''\|\*\[!([^\]]+)\]\*\) return 1 ;;$/m)?.[1]);
  assert.ok(patterns[0], 'validator pattern not found in the entrypoint');
  assert.equal(patterns[0], patterns[1], 'the two validators drifted apart');
  const printed = SUPERVISORS.map(s =>
    readFileSync(s.path, 'utf8').match(/^ICECAST_SECRET_CHARS='([^']*)'$/m)?.[1]);
  assert.ok(printed[0], 'ICECAST_SECRET_CHARS not found in the entrypoint');
  assert.equal(printed[0], printed[1], 'the two warning texts drifted apart');
});
