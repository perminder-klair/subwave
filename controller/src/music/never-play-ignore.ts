// Navidrome-side "never play again" exclusion — maintains ONE ignore file,
// <NEVER_PLAY_LIBRARY_PATH>/.ndignore, one gitignore-syntax pattern per line,
// each pattern deterministically derived from a library-relative song.path.
// This is the Navidrome-external half of "Never Play Again"
// (broadcast/never-play-again.ts, POST /dj/never-play-again): the in-process
// blocklist (music/blocklist.ts) is what stops SUB/WAVE itself from ever
// selecting the track again, immediately; this module is what asks Navidrome
// to drop the exact file from ITS OWN catalog too — eventually consistent,
// once Navidrome's next scan (triggered by subsonic.startScan(), best-effort)
// picks the change up. This assumes Navidrome's `.ndignore` accepts one
// gitignore-syntax pattern per line — live-verified against a real Navidrome
// instance with a bracket-containing path (see toIgnorePattern below).
//
// Disabled by default: NEVER_PLAY_LIBRARY_PATH is empty unless the operator
// bind-mounts the Navidrome music-library root into the CONTROLLER container
// and sets it. Deliberately separate from MUSIC_LIBRARY_PATH (subsonic.ts's
// playback-routing knob, consumed by the BROADCAST container via
// Liquidsoap) — this module never touches playback and only the controller
// needs this mount.
//
// State/persistence shape:
//   - `ignoredPaths` holds the escaped, gitignore-PATTERN form of every
//     ignored path — i.e. exactly what's written to / read from disk. A
//     caller's ORIGINAL song.path (the identity kept as BlockEntry.libraryPath
//     in music/blocklist.ts) is converted to its pattern via toIgnorePattern()
//     right at the add()/remove() boundary, so add(x) and remove(x) — called
//     with the SAME original x, e.g. by the block and later unblock routes —
//     always derive and compare the identical line.
//   - Mutations are compute-next → persist → publish: `ignoredPaths` is only
//     reassigned AFTER writeFileAtomic() resolves. A failed persist (a
//     missing/unwritable ROOT, disk full, …) therefore leaves the in-memory
//     list untouched, so a retried add()/remove() genuinely re-attempts the
//     disk write rather than short-circuiting on a duplicate check against
//     state that was never actually persisted.
//   - `load()` is single-flighted through one shared promise rather than a
//     boolean flag, so two callers racing on the very first add()/remove()
//     both await the SAME completed read instead of the second one
//     proceeding against a still-empty `ignoredPaths`. It populates the
//     in-memory VIEW only (list()); it is not what a mutation trusts.
//   - Every mutation RE-READS the file from disk inside the lock and computes
//     from that, never from `ignoredPaths`. `.ndignore` lives in the
//     OPERATOR's music tree, not in state/, and Navidrome documents it as
//     hand-editable — so this process is not its only writer, and a
//     whole-file rewrite computed from a snapshot taken minutes ago would
//     silently delete lines the operator added by hand in between.
//   - Every mutation (after its own load()) additionally serialises through
//     `withLock()`, a plain promise chain — compute-then-persist-then-publish
//     needs it: two concurrent add()/remove() calls targeting DIFFERENT paths
//     could otherwise both compute `next` from the same pre-mutation
//     snapshot and the second persist to land would silently discard the
//     first's change. music/blocklist.ts avoids this by mutating its
//     in-memory array BEFORE persisting (see its own `removeMany` comment on
//     the same race class); this module can't use that trick because the
//     whole point of the compute→persist→publish order is to never mutate
//     ahead of a persist that might fail.

import { readFile, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

// Resolved once at module load, like every other path in config.ts. A
// trailing separator in the env value would otherwise make the containment
// check in resolveWithinRoot() below inconsistent (`resolve()` strips it,
// ROOT wouldn't have it) — resolve() up front so ROOT and every abs path
// compared against it went through the same normalisation.
const ROOT = config.neverPlay.libraryPath ? resolve(config.neverPlay.libraryPath) : null;
const IGNORE_FILE = ROOT ? join(ROOT, '.ndignore') : null;

/** True when NEVER_PLAY_LIBRARY_PATH is configured. False is the safe
 *  default — every caller checks this before treating a missing exclusion as
 *  a failure rather than "feature not enabled". */
export function isEnabled(): boolean {
  return ROOT !== null;
}

/** The resolved, absolute library root, or null when disabled. Exposed for
 *  callers/tests that want to assert against it without re-deriving it. */
export function libraryRoot(): string | null {
  return ROOT;
}

// ── gitignore-pattern escaping ───────────────────────────────────────────
//
// .ndignore is gitignore syntax, so a raw song.path written verbatim is
// interpreted as a PATTERN, not a literal filename: `*`, `?`, `[`, `]` are
// glob metacharacters usable anywhere in a pattern; a LEADING `!` negates the
// pattern; a LEADING `#` starts a comment (the whole line is ignored); `\` is
// the escape character itself; and TRAILING whitespace is stripped unless
// backslash-escaped (interior whitespace — "01 Track.flac", the ordinary
// shape of most real filenames — is already literal to gitignore and is
// deliberately left untouched, or every plain track name in a library would
// come out of this module as unreadable backslash noise). A real library
// routinely has the metacharacter cases too — box-set / deluxe-edition album
// names in particular ("Cast In Steel [Deluxe Edition]") — so writing
// song.path unescaped would silently broaden the match (a `[Live]` bracket
// pair reads as a character class, matching one character from the set
// L/i/v/e rather than the literal substring) or, for a leading `!`/`#`,
// invert or void the entry entirely.

/** Escape one path SEGMENT (a single directory/file name, no `/`) for
 *  literal matching: backslash-escape every gitignore glob metacharacter
 *  that is special ANYWHERE in a pattern (`\`, `*`, `?`, `[`, `]`).
 *  Whitespace is handled separately, once, on the fully-joined line — see
 *  toIgnorePattern — because only a TRAILING run at the very end of the
 *  whole pattern is significant; an interior space is already literal.
 *  `String.prototype.replace` with a global pattern scans the ORIGINAL
 *  string, so one pass here can't double-escape a character it already
 *  inserted a backslash before. */
function escapeGitignoreSegment(segment: string): string {
  return segment.replace(/[\\*?[\]]/g, (ch) => `\\${ch}`);
}

/**
 * Deterministically derive the exact `.ndignore` line for a validated,
 * library-relative path (the return value of resolveWithinRoot()). `/` is
 * preserved as a literal path separator (each segment between slashes is
 * glob-escaped independently, whitespace untouched at this stage); `!`/`#`
 * are only special as the FIRST character of the whole line (gitignore's
 * negation/comment markers — elsewhere in a pattern they are already literal
 * and need no escaping), so that check runs once against the fully-joined
 * pattern; and any TRAILING whitespace on the joined line — the only
 * whitespace gitignore treats specially (stripped unless escaped) — is
 * escaped last, per character, so it survives the parser rather than
 * silently widening the match to "starts with this name" instead of "is
 * exactly this name".
 *
 * Exported so add()/remove() are provably deriving the SAME line from the
 * SAME original path (music/blocklist.ts's BlockEntry.libraryPath), and so
 * the escaping rules are directly unit-testable against real library names.
 */
export function toIgnorePattern(rel: string): string {
  const glob = rel.split('/').map(escapeGitignoreSegment).join('/');
  const leading = glob.startsWith('#') || glob.startsWith('!') ? `\\${glob}` : glob;
  return leading.replace(/ +$/, (trailing) => trailing.replace(/ /g, '\\ '));
}

// `ignoredPaths` holds PATTERN-form strings (the output of toIgnorePattern) —
// i.e. exactly the lines this module reads from and writes to disk. See the
// module doc comment above for why the original, unescaped path never lives
// here.
let ignoredPaths: string[] = [];
let loadPromise: Promise<void> | null = null;

/**
 * Read and parse `.ndignore` from disk. ENOENT is the normal first-use case
 * (no track ever blocked yet, or the mount was only just added) and yields an
 * empty list; any OTHER read error THROWS, because the callers that matter
 * are the mutators, and there "assume empty" is the destructive answer: this
 * module rewrites the file WHOLE, so one transient EIO / stale NFS handle on
 * a network-mounted library would turn a file full of exclusions into a
 * single line. A mutation that refuses is recoverable; one that silently
 * truncates the operator's file is not.
 *
 * Lines are NOT `.trim()`ed. toIgnorePattern() deliberately backslash-escapes
 * TRAILING whitespace so gitignore keeps it, and trimming on the way back in
 * would strip the escaped space and leave a dangling `\` — the pattern would
 * then no longer match the one remove() re-derives, so the entry could never
 * be unblocked again. Only a trailing `\r` is stripped (CRLF-written files),
 * and blank/whitespace-only lines are dropped as before.
 */
async function readList(): Promise<string[]> {
  if (!IGNORE_FILE) return [];
  try {
    const raw = await readFile(IGNORE_FILE, 'utf8');
    return raw.split('\n').map((l) => l.replace(/\r+$/, '')).filter((l) => l.trim() !== '');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

// Single-flighted: the FIRST caller kicks off the read; every caller —
// including ones that arrive while it's still in flight — awaits that same
// promise, so nobody ever proceeds against a not-yet-populated
// `ignoredPaths`. This only populates the in-memory VIEW (list()); mutations
// re-read from disk under the lock and never trust this snapshot. A FAILED
// load clears `loadPromise` so the next caller genuinely retries — caching a
// failure for the process lifetime would leave list() permanently lying about
// a file the module can read fine a second later.
function load(): Promise<void> {
  if (!IGNORE_FILE) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        ignoredPaths = await readList();
      } catch (err: any) {
        // Never fatal here: the VIEW starts empty rather than the module
        // refusing to serve at all. The mutators are the strict half.
        console.error('[never-play-ignore] .ndignore load failed:', err?.message ?? err);
        ignoredPaths = [];
        loadPromise = null;
      }
    })();
  }
  return loadPromise;
}

// Serialises the compute→persist→publish critical section in add()/remove()
// — see the module doc comment for why this is needed once mutation is no
// longer allowed to happen ahead of a persist that might fail. A failure
// resolves (not rejects) the shared chain so one caller's error can't wedge
// every subsequent mutation; only that call's own caller sees the rejection.
let mutationChain: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutationChain.then(fn, fn);
  mutationChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Validate a Subsonic `song.path` against ROOT: must be a non-empty,
 * library-relative (never absolute), bounded-length string whose resolution
 * stays strictly inside ROOT. Pure — no filesystem access — so a rejection
 * can be judged (and unit-tested) before any write is attempted. Throws a
 * plain Error on rejection; callers decide how to report it (the
 * never-play-again orchestrator degrades to a warning rather than failing
 * the whole request — see broadcast/never-play-again.ts).
 *
 * Returns the path UNCHANGED (not the eventual .ndignore pattern) — this is
 * the value music/blocklist.ts persists as BlockEntry.libraryPath, so it must
 * stay the plain, human-readable identity; toIgnorePattern() derives the
 * escaped file line from it separately, at the add()/remove() boundary.
 *
 * Symlink escape (a library entry pointing outside ROOT via a symlink) is a
 * known residual risk this check does not cover — it is a purely syntactic
 * path check, matching broadcast/archives.ts's resolveEntry(), which this is
 * modelled on. Reject-by-construction here is the cheap, always-available
 * defence; closing the symlink case needs a stat/realpath the caller can add
 * if the operator's library is known to contain symlinks into other trees.
 */
export function resolveWithinRoot(rel: unknown): string {
  if (!ROOT) throw new Error('NEVER_PLAY_LIBRARY_PATH is not configured');
  if (typeof rel !== 'string') throw new Error('song.path missing or malformed');
  const trimmed = rel.trim();
  if (!trimmed || trimmed.length > 1024) throw new Error('song.path missing or malformed');
  // Reject an absolute path outright (POSIX or a Windows drive letter) —
  // Subsonic's `path` is documented as library-relative; an absolute value
  // is either a server convention this module doesn't support, or a sign
  // something upstream is wrong, and either way must not be silently
  // re-rooted under ROOT by resolve() below.
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error('song.path must be library-relative');
  }
  const abs = resolve(ROOT, trimmed);
  // resolve() collapses any `..` segments, so a path that tries to escape
  // ROOT resolves OUTSIDE it and fails this prefix test — the exact
  // containment check broadcast/archives.ts's resolveEntry() already relies
  // on, for the same reason. Strict prefix (never equal to ROOT itself): a
  // legitimate track path never resolves to the library root directory.
  if (!abs.startsWith(ROOT + sep)) {
    throw new Error('song.path escapes NEVER_PLAY_LIBRARY_PATH');
  }
  return trimmed;
}

/**
 * Add `rel` (a validated, library-relative path) to the ignore list and
 * persist. Returns `false` (not an error) when its derived pattern is
 * already present — mirrors music/blocklist.ts's `add()` returning `null` on
 * a duplicate. Throws when disabled, when `rel` fails validation, or when
 * the write itself fails (a missing/unwritable ROOT — e.g. the bind mount
 * isn't actually there despite config); callers decide how to degrade — see
 * broadcast/never-play-again.ts's Failure semantics. On a write failure the
 * in-memory list is left exactly as it was before this call, so a retry
 * genuinely re-attempts the disk write rather than seeing a phantom
 * duplicate.
 */
export async function add(rel: string): Promise<boolean> {
  const safe = resolveWithinRoot(rel);
  const pattern = toIgnorePattern(safe);
  await load();
  return withLock(async () => {
    const current = await readList();
    ignoredPaths = current;
    if (current.includes(pattern)) return false;
    const next = [...current, pattern];
    await persistList(next);
    ignoredPaths = next; // only published once the write actually succeeded
    return true;
  });
}

/**
 * Remove `rel` — the SAME original path add() was called with; the exact
 * pattern line to remove is re-derived via toIgnorePattern() rather than
 * matched loosely, so an unblock always targets precisely the line its
 * matching add() wrote. Returns `false` when disabled or when the derived
 * pattern was never present (a miss, not an error — mirrors
 * music/blocklist.ts's remove()). Same failed-write guarantee as add(): the
 * in-memory list is untouched on a persist failure, so a retry re-attempts
 * the disk write.
 */
export async function remove(rel: string): Promise<boolean> {
  if (!ROOT || typeof rel !== 'string' || !rel) return false;
  // Normalise EXACTLY as add() does before deriving the pattern. add() goes
  // through resolveWithinRoot() (which trims and validates) and remove() used
  // to skip it, so the two agreed only because every current caller happens
  // to pass a value resolveWithinRoot() already produced. One hand-edited
  // blocklist.json entry — or one new call site — and the asymmetry becomes a
  // remove() that reports "not present" and leaves the line on disk forever.
  // A rejection here is a miss, not an error, per this function's contract.
  let pattern: string;
  try {
    pattern = toIgnorePattern(resolveWithinRoot(rel));
  } catch {
    return false;
  }
  await load();
  return withLock(async () => {
    const current = await readList();
    ignoredPaths = current;
    if (!current.includes(pattern)) return false;
    const next = current.filter((p) => p !== pattern);
    await persistList(next);
    ignoredPaths = next;
    return true;
  });
}

/** Current ignore list, in its persisted PATTERN form (i.e. exactly the
 *  `.ndignore` file's lines — already gitignore-escaped, not the original
 *  song.path values; those live on BlockEntry.libraryPath in
 *  music/blocklist.ts). For admin surfaces / tests; not consulted by the
 *  block/skip path itself. */
export function list(): string[] {
  return ignoredPaths.slice();
}

async function persistList(list: string[]): Promise<void> {
  if (!IGNORE_FILE) return;
  // An EMPTY list must DELETE the file, never write a zero-byte one: to
  // Navidrome an empty `.ndignore` means "skip this ENTIRE directory", which
  // at the library ROOT would hide the operator's whole catalog. That is not
  // a guess about Navidrome's semantics — it is the behaviour this repo
  // relies on deliberately elsewhere (`docker/broadcast-entrypoint.sh` and
  // the AIO supervisor `touch` an empty `state/archive/.ndignore` precisely
  // to hide the archive dir from a co-located Navidrome). Unblocking the last
  // remaining track is the ordinary path into this branch, and the unblock
  // route then triggers a scan, so getting it wrong wipes the library one
  // scan later. ENOENT is a success: the file is already absent (nothing was
  // ever persisted, or the operator removed it by hand).
  if (!list.length) {
    try {
      await unlink(IGNORE_FILE);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    return;
  }
  // Whole-file rewrite via the repo's existing atomic-write primitive —
  // there is no atomic *append*, so every mutation recomputes the full
  // contents and writeFileAtomic()s it, the same pattern music/blocklist.ts
  // uses for blocklist.json. A trailing newline is the conventional POSIX
  // text-file ending.
  await writeFileAtomic(IGNORE_FILE, list.join('\n') + '\n');
}
