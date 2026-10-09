// Pins the read-only state-dir tree behind GET /debug/state-tree.
//
// Two properties are load-bearing:
//
//  - resolveStatePath() is the ONLY thing between an operator-supplied ?path=
//    and a filesystem read over the whole host. It must refuse traversal and
//    symlink escapes, while still ALLOWING a path that merely contains '..'
//    and normalises back inside ('a/../b' is just 'b').
//  - listStateDir() never recurses and always caps. state/stems holds tens of
//    thousands of dirs, so a listing that stats everything before slicing would
//    hang the admin page — hence stat runs on the CAPPED slice only, and `total`
//    reports the real size so truncation is never silent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { MAX_ENTRIES, resolveStatePath } from '../src/util/state-path.js';
import { BadStatePathError, listStateDir } from '../src/util/state-tree.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-statetree-'));
const outside = mkdtempSync(join(tmpdir(), 'subwave-outside-'));

// root/
//   voice/            one WAV
//   sessions/         empty
//   settings.json
//   escape -> outside (symlink out of the tree)
//   big/              MAX_ENTRIES + 20 files
mkdirSync(join(root, 'voice'));
mkdirSync(join(root, 'sessions'));
writeFileSync(join(root, 'voice', 'line-1.wav'), 'RIFF');
writeFileSync(join(root, 'settings.json'), '{}');
writeFileSync(join(outside, 'secret.txt'), 'do not read me');
symlinkSync(outside, join(root, 'escape'));
mkdirSync(join(root, 'big'));
const BIG = MAX_ENTRIES + 20;
for (let i = 0; i < BIG; i++) {
  writeFileSync(join(root, 'big', `f${String(i).padStart(5, '0')}.bin`), 'x');
}

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('resolveStatePath allows the root itself', () => {
  for (const rel of ['', '.', '/']) {
    assert.equal(resolveStatePath(root, rel), resolve(root), `rel=${JSON.stringify(rel)}`);
  }
});

test('resolveStatePath allows a normal nested path', () => {
  assert.equal(resolveStatePath(root, 'voice'), join(resolve(root), 'voice'));
  assert.equal(resolveStatePath(root, 'voice/line-1.wav'), join(resolve(root), 'voice', 'line-1.wav'));
});

test('resolveStatePath allows a path that normalises back inside', () => {
  // The whole reason the rule is "normalise, THEN refuse a leftover '..'" and
  // not "refuse any '..'": this is a legitimate path.
  assert.equal(resolveStatePath(root, 'voice/../sessions'), join(resolve(root), 'sessions'));
  assert.equal(resolveStatePath(root, './voice'), join(resolve(root), 'voice'));
});

test('resolveStatePath refuses traversal', () => {
  for (const rel of ['..', '../', '../etc', 'voice/../../etc', 'a/../../b', '../../../../etc/passwd']) {
    assert.equal(resolveStatePath(root, rel), null, `rel=${JSON.stringify(rel)}`);
  }
});

test('resolveStatePath refuses an absolute path', () => {
  // Note the leading-slash strip means '/etc/passwd' arrives as 'etc/passwd',
  // which is contained and therefore allowed — it just will not exist. What
  // must never happen is escaping the root.
  const r = resolveStatePath(root, '/etc/passwd');
  assert.ok(r === null || r.startsWith(resolve(root) + sep), `got ${r}`);
});

test('resolveStatePath refuses a NUL byte', () => {
  assert.equal(resolveStatePath(root, 'voice\0.wav'), null);
});

test('listStateDir lists the root, directories first then by name', async () => {
  const out = await listStateDir(root, '');
  const names = out.entries.map((e) => e.name);
  const dirCount = out.entries.filter((e) => e.isDir).length;
  assert.ok(out.entries.slice(0, dirCount).every((e) => e.isDir), 'dirs must lead');
  assert.ok(out.entries.slice(dirCount).every((e) => !e.isDir), 'files must follow');
  assert.deepEqual(names.slice(0, dirCount), [...names.slice(0, dirCount)].sort((a, b) => a.localeCompare(b, 'en')));
  assert.ok(names.includes('voice') && names.includes('settings.json'));
  assert.equal(out.root, root);
});

test('listStateDir reports size and mtime for a file', async () => {
  const out = await listStateDir(root, 'voice');
  const wav = out.entries.find((e) => e.name === 'line-1.wav');
  assert.ok(wav, 'expected the WAV');
  assert.equal(wav.isDir, false);
  assert.equal(wav.size, 4);
  assert.ok(wav.mtime && !Number.isNaN(Date.parse(wav.mtime)));
});

test('listStateDir caps a large directory and reports the real total', async () => {
  const out = await listStateDir(root, 'big');
  assert.equal(out.entries.length, MAX_ENTRIES);
  assert.equal(out.shown, MAX_ENTRIES);
  assert.equal(out.total, BIG, 'total must be the pre-cap size, so truncation is visible');
});

test('an escaping symlink is listed but cannot be expanded', async () => {
  const out = await listStateDir(root, '');
  const link = out.entries.find((e) => e.name === 'escape');
  // It must be VISIBLE — hiding it would misrepresent what is on disk.
  assert.ok(link, 'the symlink should appear in the listing');
  assert.equal(link.isSymlink, true);
  // ...and it must not be traversable.
  await assert.rejects(() => listStateDir(root, 'escape'), BadStatePathError);
  await assert.rejects(() => listStateDir(root, 'escape/secret.txt'), BadStatePathError);
});

test('listStateDir throws BadStatePathError on traversal', async () => {
  await assert.rejects(() => listStateDir(root, '../'), BadStatePathError);
});

test('a missing directory fails as a plain error, not a path refusal', async () => {
  // The route turns BadStatePathError into a 400 and everything else into an
  // inline { error } — a typo must not read as an attempted traversal.
  await assert.rejects(
    () => listStateDir(root, 'no-such-dir'),
    (err: Error) => !(err instanceof BadStatePathError),
  );
});

test('listStateDir never recurses', async () => {
  const out = await listStateDir(root, '');
  assert.ok(
    out.entries.every((e) => !e.name.includes('/')),
    'entries are one level only',
  );
});
