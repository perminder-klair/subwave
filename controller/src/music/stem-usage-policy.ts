// The stem cache's usage journal: what it says and what a reader, a walk and a
// writer may conclude from it. Pure (scripts/stem-usage-policy.test.ts); the
// file I/O is music/stem-usage-journal.ts, the snapshot it vouches for is
// music/stem-cache.ts's (#2317).
//
// The stored cache size (stem-cache-usage.json) is kept true without a walk by
// the writers that change stem dirs outside the analysis pass and the sweep:
// a pick-time separation, a replaced file's stems dropped (forgetStems, in the
// tagger's process), the orphan purge's moves, an id rotation's renames. A
// walk takes many minutes on a share, and one of those writers can change a
// dir under it, so the walk may have counted that dir before, during or after
// the change. A single change token could only say "something changed", which
// left the walk nothing to store but a stale figure: with pick-time stems on,
// about 4.5 separations an hour against a 16-minute walk made most hours
// stale, in runs, each a full walk.
//
// So each writer brackets each dir it changes in the journal, one session per
// writer:
//   `+ <session> <dir> <ms>`  before its first change to the dir (it then
//                             measures the dir: its base);
//   `= <session> <dir>`       after its last change (it then measures again:
//                             its final, and settles);
//   `* <session>`             a change of unknown size (a delete refused
//                             part-way, a separation that timed out);
//   `+ <session> * <ms> <pid>` an analysis pass writing dirs nobody names
//                             (closed by `= <session> *` when it settles):
//                             no walk stores a trusted figure while one is
//                             open or across one that opened or closed.
// Every opening carries its writer's pid: one whose process is gone is a
// writer that died, and nothing waits on it.
// A snapshot records the journal position it accounts for (`journal`: the
// file's id and a byte offset) and, for each bracket still open there, what it
// counted for that dir (`inFlight`). Then:
// - a reader trusts the snapshot only while every entry past that position
//   opens a bracket (journalAccounts): a change the snapshot does not hold
//   leaves an `=` or `*` past it, so it is never trusted and wrong;
// - a walk, at its end, re-measures every dir a bracket names after the
//   position it started from, and every dir still open, and stores its figure
//   at the journal's end (walkReconcile); only a `*`, a journal that was
//   replaced or lost, or two writers in one dir leave it stale;
// - a writer counts its own dirs against what the snapshot holds for each
//   (settleDecision): its final against its base when the snapshot predates
//   the bracket, against `inFlight` when the snapshot was stored with it open,
//   nothing when the snapshot already holds its end. It moves the position
//   past its own entries only when nothing but other writers' openings lies
//   between, so of two writers settling on the same snapshot at once, one
//   always sees the other and stands down (the stem-cache.ts header has the
//   orderings).
// Any doubt refuses, and a refusal changes nothing: the writer's own `=` stays
// past the snapshot's position, which is what makes the snapshot untrusted.

export const JOURNAL_FORMAT = 'subwave-stem-journal';
export const JOURNAL_VERSION = 1;

// An opening older than this is a writer that died (a controller restart
// mid-separation): a walk counts its dir as it finds it and keeps no in-flight
// figure for it, and a trim drops it. A writer that settles later than this is
// refused, which leaves the snapshot untrusted, never wrong. A separation's
// request deadline is minutes.
export const OPEN_MAX_AGE_MS = 6 * 3600_000;
// An analysis pass runs for hours; its pending mark is trusted for as long
// (stem-cache.ts PENDING_MAX_AGE_MS), and its journal opening the same.
export const PASS_OPEN_MAX_AGE_MS = 48 * 3600_000;
/** The dir name a pass's opening carries: it writes dirs it does not name. */
export const UNNAMED_DIRS = '*';

export type JournalEntry =
  | { kind: '+'; session: string; dir: string; atMs: number; pid: number; offset: number; end: number; line: string }
  | { kind: '='; session: string; dir: string; offset: number; end: number; line: string }
  | { kind: '*'; session: string; offset: number; end: number; line: string };

export interface Journal {
  id: string;
  /** When the file was created: a snapshot written before it predates the journal (an upgrade). */
  createdMs: number;
  /** Byte offset just past the header line. */
  headerEnd: number;
  /** Byte offset just past the last complete line. */
  end: number;
  entries: JournalEntry[];
}

/** Where a snapshot stands in the journal: everything before `upTo` in the file `id` is in its totals. */
export interface JournalMark {
  id: string;
  upTo: number;
}

// What the snapshot counted for a dir whose bracket was open at its position,
// keyed `${session} ${dir}`: the bytes it counted, null for counted as absent,
// or 'base' for counted as the dir was before the bracket opened (a writer
// moved the position past someone else's opening).
export type InFlightValue = number | null | 'base';
export type InFlight = Record<string, InFlightValue>;

/** A dir's contribution to the totals as a walk counts it: its bytes, or null when the walk would not count it. */
export type DirMeasure = number | null;

export function inFlightKey(session: string, dir: string): string {
  return `${session} ${dir}`;
}

export function headerLine(id: string, createdMs: number): string {
  return `${JOURNAL_FORMAT} ${JOURNAL_VERSION} ${id} ${Math.round(createdMs)}\n`;
}

export function openLine(session: string, dir: string, atMs: number, pid: number): string {
  return `+ ${session} ${encodeURIComponent(dir)} ${Math.round(atMs)} ${pid}\n`;
}

/** An analysis pass starting to write dirs it does not name. */
export function passOpenLine(session: string, atMs: number, pid: number): string {
  return `+ ${session} ${UNNAMED_DIRS} ${Math.round(atMs)} ${pid}\n`;
}

export function closeLine(session: string, dir: string): string {
  return `= ${session} ${encodeURIComponent(dir)}\n`;
}

export function unknownLine(session: string): string {
  return `* ${session}\n`;
}

const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

function decodeDir(s: string | undefined): string | null {
  if (!s) return null;
  try {
    if (s === UNNAMED_DIRS) return UNNAMED_DIRS;
    const d = decodeURIComponent(s);
    return d && d !== UNNAMED_DIRS && !d.includes('/') && !d.includes('\0') ? d : null;
  } catch {
    return null;
  }
}

// Null for a file that is not a journal (no header, another format or
// version): its entries mean nothing, so nothing it holds is trusted. A line
// that does not parse reads as `*`, a change of unknown size. A last line
// without its newline is a write still landing, and is left past `end`.
export function parseJournal(text: string): Journal | null {
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const head = text.slice(0, nl).split(' ');
  const createdMs = Number(head[3]);
  if (head.length !== 4 || head[0] !== JOURNAL_FORMAT || head[1] !== String(JOURNAL_VERSION) || !SESSION.test(head[2])
    || !Number.isFinite(createdMs)) {
    return null;
  }
  const headerEnd = Buffer.byteLength(text.slice(0, nl + 1));
  const entries: JournalEntry[] = [];
  let offset = headerEnd;
  let rest = text.slice(nl + 1);
  for (;;) {
    const i = rest.indexOf('\n');
    if (i < 0) break;
    const raw = rest.slice(0, i);
    const line = raw + '\n';
    const end = offset + Buffer.byteLength(line);
    rest = rest.slice(i + 1);
    const f = raw.split(' ');
    const session = f[1] && SESSION.test(f[1]) ? f[1] : '?';
    const dir = decodeDir(f[2]);
    const atMs = Number(f[3]);
    const pid = Number(f[4]);
    if (f[0] === '+' && f.length === 5 && session !== '?' && dir && Number.isFinite(atMs) && Number.isInteger(pid) && pid > 0) {
      entries.push({ kind: '+', session, dir, atMs, pid, offset, end, line });
    } else if (f[0] === '=' && f.length === 3 && session !== '?' && dir) {
      entries.push({ kind: '=', session, dir, offset, end, line });
    } else {
      entries.push({ kind: '*', session, offset, end, line });
    }
    offset = end;
  }
  return { id: head[2], createdMs, headerEnd, end: offset, entries };
}

/** Does a snapshot at `mark` hold every change the journal records? Openings past it are writes still running. */
export function journalAccounts(mark: JournalMark | undefined, j: Journal | null): boolean {
  if (!mark || !j || mark.id !== j.id) return false;
  if (!Number.isInteger(mark.upTo) || mark.upTo < j.headerEnd || mark.upTo > j.end) return false;
  return j.entries.every(e => e.offset < mark.upTo || e.kind === '+');
}

export interface OpenWrite {
  session: string;
  dir: string;
  /** The opening line, carried into a trimmed journal. */
  line: string;
}

/** Whether a pid names a running process; the I/O side passes the real check. */
export type PidAlive = (pid: number) => boolean;

// Brackets opened and not closed anywhere in the journal (a trim may copy a
// close ahead of its opening, so order is not used), whose writer is still
// running and young enough to settle (OPEN_MAX_AGE_MS; a pass's,
// PASS_OPEN_MAX_AGE_MS).
export function openWrites(j: Journal, nowMs: number, alive: PidAlive): OpenWrite[] {
  const closed = new Set<string>();
  for (const e of j.entries) if (e.kind === '=') closed.add(inFlightKey(e.session, e.dir));
  const seen = new Set<string>();
  const out: OpenWrite[] = [];
  for (const e of j.entries) {
    if (e.kind !== '+') continue;
    const key = inFlightKey(e.session, e.dir);
    if (closed.has(key) || seen.has(key)) continue;
    seen.add(key);
    const maxAge = e.dir === UNNAMED_DIRS ? PASS_OPEN_MAX_AGE_MS : OPEN_MAX_AGE_MS;
    if (nowMs - e.atMs > maxAge || !alive(e.pid)) continue;
    out.push({ session: e.session, dir: e.dir, line: e.line });
  }
  return out;
}

export type WalkReconcile =
  | { ok: true; remeasure: string[]; open: OpenWrite[] }
  | { ok: false; reason: string };

// What a walk that started at journal position `from` (file `startId`) must do
// before it can store its figure at `now`'s end: re-measure every dir a
// bracket names since it started (it may have counted that dir before, during
// or after the change) and every dir still open (whatever it counted, the
// snapshot records it, and that writer settles against it). Refused, the walk
// does what it did before the journal: a sweep stores its figure flagged
// stale, a read stores nothing.
export function walkReconcile(
  startId: string | null,
  from: number,
  now: Journal | null,
  nowMs: number,
  alive: PidAlive,
): WalkReconcile {
  if (startId === null || !now) return { ok: false, reason: 'the usage journal could not be read' };
  if (now.id !== startId) return { ok: false, reason: 'the usage journal was replaced during the walk' };
  const since = now.entries.filter(e => e.offset >= from);
  if (since.some(e => e.kind === '*')) return { ok: false, reason: 'a change of unknown size landed during the walk' };
  if (since.some(e => e.kind !== '*' && e.dir === UNNAMED_DIRS)) {
    return { ok: false, reason: 'an analysis pass started or settled during the walk' };
  }
  const open = openWrites(now, nowMs, alive);
  if (open.some(o => o.dir === UNNAMED_DIRS)) return { ok: false, reason: 'an analysis pass is writing stems' };
  const openDirs = new Set<string>();
  for (const o of open) {
    if (openDirs.has(o.dir)) return { ok: false, reason: 'two writers are changing one stem folder' };
    openDirs.add(o.dir);
  }
  const remeasure = new Set<string>(openDirs);
  for (const e of since) if (e.kind !== '*') remeasure.add(e.dir);
  return { ok: true, remeasure: [...remeasure].sort(), open };
}

export interface SessionDir {
  dir: string;
  base: DirMeasure;
  final: DirMeasure;
}

export type SettleDecision =
  | { kind: 'apply'; bytes: number; dirs: number; mark: JournalMark; inFlight: InFlight }
  // Nothing of this writer is left in the journal: a walk read its close,
  // re-measured its dirs, stored that, and trimmed the lines away.
  | { kind: 'accounted' }
  | { kind: 'refuse'; reason: string };

function contribution(m: DirMeasure): { bytes: number; dirs: number } {
  return m === null ? { bytes: 0, dirs: 0 } : { bytes: m, dirs: 1 };
}

// A writer that has closed every bracket of `session`: what it does to a
// snapshot at `mark` holding `inFlight`, read from the journal `j` after its
// closes landed. See the header for the rules; every doubt refuses.
export function settleDecision(opts: {
  mark: JournalMark | undefined;
  inFlight: InFlight | undefined;
  journal: Journal | null;
  session: string;
  dirs: readonly SessionDir[];
}): SettleDecision {
  const { mark, journal: j, session } = opts;
  const inFlight = opts.inFlight ?? {};
  if (!mark || !j) return { kind: 'refuse', reason: 'no journal position to settle against' };
  if (mark.id !== j.id || !Number.isInteger(mark.upTo) || mark.upTo < j.headerEnd || mark.upTo > j.end) {
    return { kind: 'refuse', reason: 'the snapshot is not at a position in this journal' };
  }
  const mine = new Set(opts.dirs.map(d => d.dir));
  const own = j.entries.filter(e => e.session === session);
  // A trim keeps every opening still running and every line that reached the
  // old file after the walk's last read, so a writer whose lines are all gone
  // closed before that read: the walk measured its dirs after the close.
  if (own.length === 0 && opts.dirs.length > 0) return { kind: 'accounted' };
  if (own.some(e => e.kind === '*')) return { kind: 'refuse', reason: 'a change of unknown size' };
  const lastOwnEnd = own.reduce((n, e) => Math.max(n, e.end), 0);
  // Every other writer's entry between the position and this writer's last:
  // an opening of another dir is passed (its writer settles against 'base'),
  // anything else stands this writer down, since the snapshot may or may not
  // be about to hold it.
  const passed: OpenWrite[] = [];
  for (const e of j.entries) {
    if (e.offset < mark.upTo || e.offset >= lastOwnEnd || e.session === session) continue;
    if (e.kind !== '+' || mine.has(e.dir) || e.dir === UNNAMED_DIRS) {
      return { kind: 'refuse', reason: 'another writer changed the cache in between' };
    }
    // A copy of an opening the snapshot already holds open (a trim carries
    // the tail it did not read), or a second copy of one passed here.
    const key = inFlightKey(e.session, e.dir);
    if (key in inFlight || passed.some(p => inFlightKey(p.session, p.dir) === key)) continue;
    passed.push({ session: e.session, dir: e.dir, line: e.line });
  }
  // One writer per dir in what the snapshot holds open: two would each count
  // their growth against the same figure.
  const heldOpen = new Set<string>();
  for (const key of Object.keys(inFlight)) {
    const [s, d] = key.split(' ');
    if (s !== session && mine.has(d)) return { kind: 'refuse', reason: 'another writer is changing the same stem folder' };
    if (s !== session) heldOpen.add(d);
  }
  for (const p of passed) {
    if (heldOpen.has(p.dir)) return { kind: 'refuse', reason: 'two writers are changing one stem folder' };
    heldOpen.add(p.dir);
  }
  let bytes = 0;
  let dirs = 0;
  const next: InFlight = { ...inFlight };
  for (const d of opts.dirs) {
    const opens = own.filter(e => e.kind === '+' && e.dir === d.dir);
    const closes = own.filter(e => e.kind === '=' && e.dir === d.dir);
    if (opens.length === 0 || closes.length === 0) return { kind: 'refuse', reason: 'this writer\'s own entries are not in the journal' };
    const opened = Math.min(...opens.map(e => e.offset));
    const closedAt = Math.min(...closes.map(e => e.offset));
    const key = inFlightKey(session, d.dir);
    let counted: DirMeasure;
    if (closedAt < mark.upTo) {
      // The snapshot was measured after the close: it holds the final already.
      delete next[key];
      continue;
    } else if (opened < mark.upTo) {
      if (!(key in inFlight)) return { kind: 'refuse', reason: 'the snapshot holds the write open but not what it counted' };
      const v = inFlight[key];
      counted = v === 'base' ? d.base : v;
    } else {
      counted = d.base;
    }
    delete next[key];
    const f = contribution(d.final);
    const c = contribution(counted);
    bytes += f.bytes - c.bytes;
    dirs += f.dirs - c.dirs;
  }
  for (const p of passed) {
    const key = inFlightKey(p.session, p.dir);
    if (!(key in next)) next[key] = 'base';
  }
  // Openings this writer passed that are already closed further on stay
  // 'base' too: the snapshot holds them as they were before they opened.
  return { kind: 'apply', bytes, dirs, mark: { id: j.id, upTo: Math.max(mark.upTo, lastOwnEnd) }, inFlight: next };
}

// What a trimmed journal starts with: the openings still running, which the
// new snapshot holds in `inFlight` (so they sit before its position), in the
// order they were written.
export function trimmedBody(open: readonly OpenWrite[]): string {
  return open.map(o => o.line).join('');
}
