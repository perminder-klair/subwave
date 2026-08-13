// Unit tests for music/never-play-ignore.ts — the /music/.ndignore writer
// behind "Never Play Again"'s Navidrome-side exclusion. Covers path-traversal
// rejection, gitignore-pattern escaping for real library names, duplicate-safe
// add/remove, atomic whole-file persistence round-trips, and a failed write
// that must neither corrupt in-memory state nor block a genuine retry.
//
// Plain-script shape (top-level await + try/finally), matching
// scripts/blocklist.test.ts — deliberate here rather than node:test's
// per-assertion style: several sections mutate the shared library-root
// directory out from under later assertions (deleting it, then recreating
// it to prove a retry works), so this file needs guaranteed top-to-bottom
// sequential execution rather than relying on the runner's default
// test-ordering behaviour.
//
// Run: `tsx scripts/never-play-ignore.test.ts` or via `npm test`.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Both must be set before config.js resolves them at import time.
const stateDir = mkdtempSync(join(tmpdir(), 'never-play-state-'));
const libRoot = mkdtempSync(join(tmpdir(), 'never-play-lib-'));
process.env.STATE_DIR = stateDir;
process.env.NEVER_PLAY_LIBRARY_PATH = libRoot;

const npi = await import('../src/music/never-play-ignore.js');

const ndignorePath = join(libRoot, '.ndignore');

try {
  // ── enabled / root resolution ─────────────────────────────────────────────
  assert.equal(npi.isEnabled(), true);
  assert.equal(npi.libraryRoot(), libRoot, 'resolves to the configured root (mkdtempSync already returns a clean absolute path)');
  assert.deepEqual(npi.list(), []);

  // ── toIgnorePattern(): gitignore metacharacter escaping ───────────────────
  // Plain paths with nothing special are returned unchanged.
  assert.equal(npi.toIgnorePattern('Artist/Album/01 Track.flac'), 'Artist/Album/01 Track.flac');

  // The realistic case this fix exists for: a box-set / deluxe-edition album
  // name with bracket pairs. Unescaped, `[Deluxe Edition]` and `[Live]` would
  // each read as a gitignore CHARACTER CLASS (matching one char from the set
  // D/e/l/u/x/.../space) rather than the literal substring — silently
  // broadening the match to other files. `/` stays a literal path separator
  // (segments are escaped independently, not the joined string).
  assert.equal(
    npi.toIgnorePattern('A-Ha - Cast In Steel [Deluxe Edition]/03 Track [Live].flac'),
    'A-Ha - Cast In Steel \\[Deluxe Edition\\]/03 Track \\[Live\\].flac',
  );

  // `*` and `?` are glob wildcards anywhere in a pattern, not just at the
  // start — a track literally named with one must not become a wildcard.
  assert.equal(npi.toIgnorePattern('Weird Al/Foo?.mp3'), 'Weird Al/Foo\\?.mp3');
  assert.equal(npi.toIgnorePattern('DJ Shadow/Endtroducing*.mp3'), 'DJ Shadow/Endtroducing\\*.mp3');

  // A LEADING `#` starts a comment (the whole line would be ignored by
  // Navidrome's parser, i.e. the exclusion would silently do nothing) and a
  // LEADING `!` negates (inverting the entry into an ALLOW rule) — both must
  // be escaped when they're the first character of the pattern.
  assert.equal(npi.toIgnorePattern('#1 Hits/Track.mp3'), '\\#1 Hits/Track.mp3');
  assert.equal(npi.toIgnorePattern('!!! (band)/Track.mp3'), '\\!!! (band)/Track.mp3');
  // A `#`/`!` NOT at the start of the line is already literal in gitignore
  // syntax and must NOT be escaped (escaping it would still match correctly,
  // but asserting the minimal-diff behaviour keeps the output predictable).
  assert.equal(npi.toIgnorePattern('Artist/Track #2 (feat. Someone!).mp3'), 'Artist/Track #2 (feat. Someone!).mp3');

  // A literal backslash in a filename (unusual, but the task calls it out
  // explicitly) must itself be escaped — otherwise it would be read as
  // escaping whatever follows it.
  assert.equal(npi.toIgnorePattern('Artist\\Weird/Track.mp3'), 'Artist\\\\Weird/Track.mp3');

  // An INTERIOR space — "01 Track.flac" is the ordinary shape of most real
  // filenames — is already literal to gitignore and is deliberately left
  // untouched: escaping every space would turn every plain track name in a
  // library into unreadable backslash noise for no matching benefit.
  assert.equal(npi.toIgnorePattern('Artist/Track Name.mp3'), 'Artist/Track Name.mp3');

  // TRAILING whitespace, in contrast, IS significant to gitignore (stripped
  // unless escaped) — a filename that genuinely ends in a space (unusual,
  // but filesystem-legal) must have that space escaped or the exclusion
  // would silently degrade to a prefix match rather than an exact one.
  assert.equal(npi.toIgnorePattern('Artist/Track '), 'Artist/Track\\ ');
  assert.equal(npi.toIgnorePattern('Artist/Track  '), 'Artist/Track\\ \\ ', 'every trailing space is escaped individually');
  // A space right before a metacharacter that itself needs escaping (bracket)
  // is still interior (nothing trails it) and stays unescaped.
  assert.equal(npi.toIgnorePattern('Artist [Live]'), 'Artist \\[Live\\]');

  // A path combining several of the above at once, to prove the segment
  // escaping composes correctly rather than only handling one metacharacter
  // class at a time. Parentheses are NOT gitignore metacharacters (unlike
  // brackets) and are deliberately left unescaped; interior spaces stay
  // unescaped too — only `\ * ? [ ]` anywhere, a leading `#`/`!`, and
  // trailing whitespace are in the escaped set.
  assert.equal(
    npi.toIgnorePattern('Artist [Live] & Friends/03 - Track? (feat. A-B*C).mp3'),
    'Artist \\[Live\\] & Friends/03 - Track\\? (feat. A-B\\*C).mp3',
  );

  // ── path validation (resolveWithinRoot) ───────────────────────────────────
  // resolveWithinRoot() is unaffected by the escaping fix — it still returns
  // the ORIGINAL, unescaped path (this is what music/blocklist.ts persists as
  // BlockEntry.libraryPath; escaping is applied separately, only at the
  // add()/remove() boundary — see toIgnorePattern above).
  assert.equal(
    npi.resolveWithinRoot('A-Ha - Cast In Steel [Deluxe Edition]/03 Track [Live].flac'),
    'A-Ha - Cast In Steel [Deluxe Edition]/03 Track [Live].flac',
  );

  // Rejected: absolute POSIX path.
  assert.throws(() => npi.resolveWithinRoot('/etc/passwd'), /library-relative/);
  // Rejected: absolute Windows path.
  assert.throws(() => npi.resolveWithinRoot('C:\\Windows\\system.ini'), /library-relative/);
  // Rejected: traversal that escapes the root.
  assert.throws(() => npi.resolveWithinRoot('../../../etc/passwd'), /escapes/);
  assert.throws(() => npi.resolveWithinRoot('Artist/../../../../etc/passwd'), /escapes/);
  // A traversal that stays net-inside the root is fine — resolve() collapses
  // it and the result is still a real file under ROOT.
  assert.equal(npi.resolveWithinRoot('Artist/../Artist2/Track.flac'), 'Artist/../Artist2/Track.flac');
  // Rejected: empty / missing / non-string / too long.
  assert.throws(() => npi.resolveWithinRoot(''), /missing or malformed/);
  assert.throws(() => npi.resolveWithinRoot('   '), /missing or malformed/);
  assert.throws(() => npi.resolveWithinRoot(null), /missing or malformed/);
  assert.throws(() => npi.resolveWithinRoot('a'.repeat(1025)), /missing or malformed/);
  // Rejected: resolves to the root itself, not a file within it.
  assert.throws(() => npi.resolveWithinRoot('.'), /escapes/);

  // ── add(): first write, persistence, trailing newline ────────────────────
  assert.equal(await npi.add('Artist/Album/01 Track.flac'), true);
  assert.deepEqual(npi.list(), ['Artist/Album/01 Track.flac']);
  assert.ok(existsSync(ndignorePath), '.ndignore created at the library root');
  assert.equal(readFileSync(ndignorePath, 'utf8'), 'Artist/Album/01 Track.flac\n');

  // ── duplicate-safe add ─────────────────────────────────────────────────────
  assert.equal(await npi.add('Artist/Album/01 Track.flac'), false, 'second add of the same path is a no-op, not an error');
  assert.deepEqual(npi.list(), ['Artist/Album/01 Track.flac'], 'no duplicate line written');
  assert.equal(readFileSync(ndignorePath, 'utf8'), 'Artist/Album/01 Track.flac\n', 'file content unchanged by the no-op');

  // ── a second, distinct entry appends cleanly ──────────────────────────────
  assert.equal(await npi.add('Other Artist/Other Album/02 Track.mp3'), true);
  assert.deepEqual(npi.list(), ['Artist/Album/01 Track.flac', 'Other Artist/Other Album/02 Track.mp3']);
  assert.equal(
    readFileSync(ndignorePath, 'utf8'),
    'Artist/Album/01 Track.flac\nOther Artist/Other Album/02 Track.mp3\n',
  );

  // ── an invalid path is rejected before any write happens ─────────────────
  await assert.rejects(() => npi.add('/etc/passwd'), /library-relative/);
  assert.deepEqual(npi.list(), ['Artist/Album/01 Track.flac', 'Other Artist/Other Album/02 Track.mp3'], 'rejected add left the list untouched');

  // ── atomic persistence: no leftover temp file after a successful write ───
  const filesAfterWrites = readdirSync(libRoot);
  assert.ok(!filesAfterWrites.some((f) => f.includes('.tmp')), 'writeFileAtomic leaves no temp file behind on success');
  assert.deepEqual(filesAfterWrites.sort(), ['.ndignore'].sort());

  console.log('never-play-ignore.test.ts: basic add/duplicate/persistence assertions passed');

  // ── realistic bracket-laden path: add + remove symmetry ──────────────────
  // The public add()/remove() contract takes the ORIGINAL path (the same
  // string BlockEntry.libraryPath stores) — never the escaped pattern — and
  // both derive the SAME line via toIgnorePattern() deterministically, so an
  // unblock always finds exactly what its matching block wrote.
  const realistic = 'A-Ha - Cast In Steel [Deluxe Edition]/03 Track [Live].flac';
  const realisticPattern = npi.toIgnorePattern(realistic);
  assert.equal(await npi.add(realistic), true);
  assert.ok(npi.list().includes(realisticPattern), 'the PERSISTED form is the escaped pattern, not the raw path');
  assert.ok(!npi.list().includes(realistic), 'the raw, unescaped path never appears in the persisted list');
  const onDiskRealistic = readFileSync(ndignorePath, 'utf8');
  assert.ok(onDiskRealistic.includes(realisticPattern), 'the escaped line is really on disk');
  assert.ok(!onDiskRealistic.includes('[Deluxe Edition]'), 'the unescaped bracket form never hits disk');

  // remove() called with the SAME ORIGINAL path (as routes/library.ts's
  // unblock does, reading BlockEntry.libraryPath) removes exactly this line.
  assert.equal(await npi.remove(realistic), true);
  assert.ok(!npi.list().includes(realisticPattern), 'removed');
  assert.ok(!readFileSync(ndignorePath, 'utf8').includes('Deluxe Edition'), 'gone from disk too');
  // Back to the two plain entries from before.
  assert.deepEqual(npi.list(), ['Artist/Album/01 Track.flac', 'Other Artist/Other Album/02 Track.mp3']);

  console.log('never-play-ignore.test.ts: realistic-path escaping round-trip passed');

  // ── remove(): exact match, duplicate-safe, rewrites atomically ───────────
  assert.equal(await npi.remove('Artist/Album/01 Track.flac'), true);
  assert.deepEqual(npi.list(), ['Other Artist/Other Album/02 Track.mp3']);
  assert.equal(readFileSync(ndignorePath, 'utf8'), 'Other Artist/Other Album/02 Track.mp3\n');

  assert.equal(await npi.remove('Artist/Album/01 Track.flac'), false, 'second remove of the same path is a miss, not an error');
  assert.equal(await npi.remove('never added this one'), false);
  assert.deepEqual(npi.list(), ['Other Artist/Other Album/02 Track.mp3'], 'unaffected by the two no-op removes');

  // Removing the last entry leaves an empty (not absent) file.
  assert.equal(await npi.remove('Other Artist/Other Album/02 Track.mp3'), true);
  assert.deepEqual(npi.list(), []);
  assert.equal(readFileSync(ndignorePath, 'utf8'), '');

  console.log('never-play-ignore.test.ts: remove() assertions passed');

  // ── failed persist must not corrupt in-memory state, and a retry must
  //    genuinely re-attempt the disk write ──────────────────────────────────
  // Simulate the operator's bind mount not actually being there despite
  // NEVER_PLAY_LIBRARY_PATH being set (config points somewhere real that
  // later stops being real) by deleting ROOT out from under the module —
  // the practical, cross-platform-reliable proxy for "unwritable" (a genuine
  // POSIX permission-denied simulation via chmod is not reliably enforced by
  // every host OS this suite runs on; this repo's dev machine is Windows,
  // where a missing parent directory fails a write the same way it does
  // everywhere else).
  rmSync(libRoot, { recursive: true, force: true });

  const beforeFailedAdd = npi.list();
  await assert.rejects(
    () => npi.add('Should/Not/Persist.flac'),
    (err: unknown) => err instanceof Error && /ENOENT|no such file/i.test(err.message),
    'add() propagates the write failure rather than silently succeeding',
  );
  assert.deepEqual(npi.list(), beforeFailedAdd, 'a failed persist leaves in-memory state EXACTLY as it was — no phantom entry');

  // A second failed attempt for the SAME path must fail again for the SAME
  // reason — not silently report "already ignored" (which would be exactly
  // the corruption this fix closes: the failed write never actually landed).
  await assert.rejects(
    () => npi.add('Should/Not/Persist.flac'),
    /ENOENT|no such file/i,
    'a retry against the still-broken root genuinely re-attempts the write, not a false duplicate',
  );

  // Recreate the root — the operator fixes the mount — and retry the SAME
  // call again. This time it must actually succeed and land on disk.
  mkdirSync(libRoot, { recursive: true });
  assert.equal(await npi.add('Should/Not/Persist.flac'), true, 'once the root is writable again, the SAME retried call succeeds');
  assert.deepEqual(npi.list(), ['Should/Not/Persist.flac']);
  assert.equal(readFileSync(ndignorePath, 'utf8'), 'Should/Not/Persist.flac\n');

  console.log('never-play-ignore.test.ts: failed-persist / genuine-retry assertions passed');
  console.log('never-play-ignore.test.ts: all assertions passed');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(libRoot, { recursive: true, force: true });
}
