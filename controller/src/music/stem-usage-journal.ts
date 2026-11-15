// The stem cache's usage journal on disk: <stateDir>/stem-cache-usage.journal,
// beside the snapshot it vouches for (stem-cache-usage.json). What its lines
// mean is music/stem-usage-policy.ts; who writes them is music/stem-cache.ts.
// Two processes append to it (the controller's pick-time separations, purge
// and sweep; the tagger child's forgetStems and id rotation), so:
// - it is created whole or not at all: the header goes in a temp file that is
//   hard-linked into place, which fails if another process got there first
//   (where hard links fail, it is renamed into place under the trim lock);
// - an append opens the file without O_CREAT, so a lost journal is never
//   recreated without its header, and writes each batch of lines in one
//   O_APPEND write. If the path no longer names the inode it wrote to, a trim
//   replaced the file, and the lines go again into the new one: a duplicate
//   means nothing to a reader, a lost line would;
// - only a walk that has just stored a trusted figure trims it (trimJournal),
//   and only one at a time across processes (an exclusive lock file). The
//   trim carries the openings still running into the new file, and after the
//   rename copies whatever reached the old file since its last read. It knows
//   each file by its id, not only its inode number, which a file created
//   after another is gone can be given: the other process can lose the
//   journal and create it again at any moment;
// - anything that fails here returns null or false, and the caller treats the
//   stored size as untrusted: a missing or unreadable journal never vouches
//   for a figure (#2317);
// - a file there that is not a journal (empty or cut short by a crash, or
//   another version's) is replaced by the next ensureJournal, dated 0, so it
//   costs one walk rather than every read walking for good.
// The old single-UUID change token (stem-cache-usage.changes, before #2317)
// is removed when the journal is first created; nothing reads it any more.

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rename, rm, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { headerLine, parseJournal, trimmedBody, type Journal, type OpenWrite } from './stem-usage-policy.js';

export interface JournalRead extends Journal {
  /** The inode read, so a trim can tell the file it read is still the one in place. */
  ino: number;
}

export function journalPath(): string {
  return path.join(config.stateDir, 'stem-cache-usage.journal');
}

function lockPath(): string {
  return `${journalPath()}.lock`;
}

function legacyTokenPath(): string {
  return path.join(config.stateDir, 'stem-cache-usage.changes');
}

export function newSessionId(): string {
  return randomBytes(9).toString('base64url');
}

// Test seam (scripts/stem-usage-orderings.test.ts): named points inside an
// append (between its open and its write, where a trim can move the path from
// under the open file; and between its write and its check that the path
// still names that file) and a trim (between its rename and its copy of the old file's tail),
// where a test running two writers at once decides which goes next.
let journalStep: ((step: string) => Promise<void>) | null = null;
export function _journalStepsForTests(fn: ((step: string) => Promise<void>) | null): void {
  journalStep = fn;
}

/** The journal as it is now; null when it is absent or not a journal. */
export async function readJournal(): Promise<JournalRead | null> {
  const r = await inspectJournal();
  return r.kind === 'ok' ? r.journal : null;
}

// What sits at the journal's path: a journal, nothing (or nothing this process
// can read), or a file read whole that is not a journal (`bad`, with its inode).
type Inspected = { kind: 'ok'; journal: JournalRead } | { kind: 'absent' } | { kind: 'bad'; ino: number };
async function inspectJournal(): Promise<Inspected> {
  let fh;
  try {
    fh = await open(journalPath(), 'r');
  } catch {
    return { kind: 'absent' };
  }
  try {
    const st = await fh.stat();
    const j = parseJournal(await fh.readFile('utf8'));
    return j ? { kind: 'ok', journal: { ...j, ino: st.ino } } : { kind: 'bad', ino: st.ino };
  } catch {
    return { kind: 'absent' };
  } finally {
    await fh.close().catch(() => {});
  }
}

// A file at the journal's path that is not a journal: one a crash left empty
// or cut short (it is only ever put in place whole, by a link or a rename), or
// another version's. Nothing it holds vouches for a figure, and left there it
// never would again: every read would walk, forever. So it is replaced, under
// the trim lock (one replacer at a time, and never across a trim), with a new
// journal dated 0, so no snapshot is stamped as predating it (that is only
// for an upgrade): every snapshot is untrusted until the next walk stores one.
async function replaceBadJournal(ino: number): Promise<void> {
  if (!(await takeTrimLock())) return;
  const target = journalPath();
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const now = await inspectJournal();
    if (now.kind !== 'bad' || now.ino !== ino) return;
    await writeFile(tmp, headerLine(newSessionId(), 0), { flag: 'wx' });
    await rename(tmp, target);
  } catch {
    /* left as it is: nothing is trusted, as before */
  } finally {
    await unlink(tmp).catch(() => {});
    await rm(lockPath(), { force: true }).catch(() => {});
  }
}

// Creates the journal when there is none, dated now (a snapshot written
// before that predates it: stem-cache.ts stamps one from an upgrade), and
// replaces a file there that is not a journal. Null when it can neither be
// read nor created.
export async function ensureJournal(): Promise<JournalRead | null> {
  const there = await inspectJournal();
  if (there.kind === 'ok') return there.journal;
  if (there.kind === 'bad') {
    await replaceBadJournal(there.ino);
    return readJournal();
  }
  const target = journalPath();
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  let created = false;
  try {
    await writeFile(tmp, headerLine(newSessionId(), Date.now()), { flag: 'wx' });
    try {
      await linkFile(tmp, target);
      created = true;
    } catch (err) {
      // EEXIST: another process created it first, or a file that is not a
      // journal sits there; either way it is read below. Anything else is a
      // filesystem without hard links (FAT/exFAT, some FUSE and SMB mounts).
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') created = await renameIntoPlace(tmp, target);
    }
  } catch {
    /* unwritable: read below, and null if nothing is there */
  } finally {
    await unlink(tmp).catch(() => {});
  }
  if (created) await rm(legacyTokenPath(), { force: true }).catch(() => {});
  return readJournal();
}

// Where hard links fail, the journal is renamed into place instead, which
// replaces whatever is there, so only while nothing is, and under the trim
// lock: of two processes creating it at once, the second finds the first's.
// Every holder of that lock checks what is at the path before replacing it,
// so no journal in use is replaced this way. Waits a moment for a holder
// (a trim takes milliseconds) rather than leave its caller with none.
async function renameIntoPlace(tmp: string, target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await takeTrimLock()) {
      try {
        if ((await inspectJournal()).kind !== 'absent') return false;
        await rename(tmp, target);
        return true;
      } catch {
        return false;
      } finally {
        await rm(lockPath(), { force: true }).catch(() => {});
      }
    }
    await new Promise(r => setTimeout(r, 20));
    if ((await inspectJournal()).kind !== 'absent') return false;
  }
  return false;
}

// Test seam: a filesystem without hard links.
let linkFile: (from: string, to: string) => Promise<void> = link;
export function _linkForTests(fn: ((from: string, to: string) => Promise<void>) | null): void {
  linkFile = fn ?? link;
}

// Appends whole lines, creating the journal first if there is none. False
// when they could not be written: the caller must then make the stored size
// untrusted (dropJournal).
export async function appendLines(lines: readonly string[]): Promise<boolean> {
  if (lines.length === 0) return true;
  const text = lines.join('');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let fh;
    try {
      fh = await open(journalPath(), constants.O_WRONLY | constants.O_APPEND);
    } catch {
      // None yet (or gone): create it with its header, then append.
      if (!(await ensureJournal())) return false;
      continue;
    }
    let written: number;
    try {
      await journalStep?.('append:opened');
      await fh.write(text);
      written = (await fh.stat()).ino;
    } catch {
      await fh.close().catch(() => {});
      return false;
    }
    // Checked with the file still open: until it is closed its inode number
    // cannot pass to a new file at the path.
    let now: number | null;
    try {
      await journalStep?.('append:written');
      now = await stat(journalPath()).then(s => s.ino, () => null);
    } finally {
      await fh.close().catch(() => {});
    }
    if (now === written) return true;
    // Replaced after this write (a trim): the trim copies what reached the
    // old file before it read its tail, but not what landed after; go again.
  }
  return false;
}

// For a writer that could not record its change: remove the journal, so no
// snapshot that names it is trusted again until a walk (a new journal has a
// new id). The caller marks the snapshot stale as well (stem-cache.ts
// journalLost), so a snapshot from before the journal is not stamped into
// trust by the next one. False when it could not be removed.
export async function dropJournal(): Promise<boolean> {
  return rm(journalPath(), { force: true }).then(() => true, () => false);
}

// Above this size a walk that stored a trusted figure trims the journal.
// Below it, the journal is left to grow: a trim changes the file's id, which
// a walk running elsewhere at that moment reads as stale.
let trimAboveBytes = 16 * 1024;
export function _trimAboveBytesForTests(n: number | null): void {
  trimAboveBytes = n ?? 16 * 1024;
}

// A lock left by a process that died mid-trim. A trim takes milliseconds, so
// a lock this old has no holder; until it is this old, nobody trims (the
// journal just grows).
const LOCK_MAX_AGE_MS = 24 * 3600_000;

async function takeTrimLock(): Promise<boolean> {
  try {
    await writeFile(lockPath(), `${process.pid} ${Date.now()}\n`, { flag: 'wx' });
    return true;
  } catch {
    const st = await stat(lockPath()).catch(() => null);
    if (st && Date.now() - st.mtimeMs > LOCK_MAX_AGE_MS) await rm(lockPath(), { force: true }).catch(() => {});
    return false;
  }
}

// Replace the journal read as `read` with a new one holding only `carried` (the
// openings the snapshot about to be stored keeps in flight), then whatever
// reached the old file after `read`. Returns the new journal and the position
// the snapshot should stand at, or null when no trim was made (another trim
// holds the lock, the file changed, or a step failed), in which case the
// caller stores its figure at `read`'s own position.
export async function trimJournal(
  read: JournalRead,
  carried: readonly OpenWrite[],
): Promise<{ journal: JournalRead; upTo: number } | null> {
  if (read.end < trimAboveBytes) return null;
  if (!(await takeTrimLock())) return null;
  const target = journalPath();
  const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
  let old;
  let mine;
  try {
    old = await openForTail(target, read);
    if (!old) return null;
    const id = newSessionId();
    const head = headerLine(id, read.createdMs) + trimmedBody(carried);
    await writeFile(tmp, head, { flag: 'wx' });
    // Held open across the rename: the tail goes into this file whatever the
    // path names by then.
    mine = await open(tmp, constants.O_WRONLY | constants.O_APPEND);
    if ((await stat(target)).ino !== read.ino) return null;
    await rename(tmp, target);
    await journalStep?.('trim:renamed');
    // Lines that reached the old file after `read`, read after the rename: a
    // writer whose line landed later sees the path moved and appends again.
    const after = completeLinesAfter(await readWhole(old), read.end);
    if (after) await mine.write(after);
    // The position returned is in the file renamed here, so the path must
    // still name it (by its id: an inode number is reused once a file is
    // gone). The other process may have lost the journal since (an append
    // that failed drops it) and created a new one, whose lines this position
    // knows nothing of. Then no trim was made, and the caller's figure, stored
    // at the old file's position, vouches for nothing.
    const now = await readJournal();
    if (!now || now.id !== id) return null;
    return { journal: now, upTo: Buffer.byteLength(head) };
  } catch {
    return null;
  } finally {
    await mine?.close().catch(() => {});
    await old?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    await rm(lockPath(), { force: true }).catch(() => {});
  }
}

// The journal `read` came from, opened (held open, so its inode number stays
// its own while the trim compares it): the same inode and the same id, since
// a journal lost and created again can be given the number of the one gone.
async function openForTail(file: string, read: JournalRead) {
  const fh = await open(file, 'r');
  try {
    if ((await fh.stat()).ino === read.ino && parseJournal((await readWhole(fh)).toString('utf8'))?.id === read.id) return fh;
  } catch {
    /* not it */
  }
  await fh.close().catch(() => {});
  return null;
}

// The whole file from its start, whatever the handle has read before.
async function readWhole(fh: FileHandle): Promise<Buffer> {
  const { size } = await fh.stat();
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const { bytesRead } = await fh.read(buf, got, size - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

function completeLinesAfter(whole: Buffer, from: number): string {
  const rest = whole.subarray(from).toString('utf8');
  const last = rest.lastIndexOf('\n');
  return last < 0 ? '' : rest.slice(0, last + 1);
}
