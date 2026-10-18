import { trackLengthSeconds } from './track-floor.js';

export const DEFAULT_TRACK_RECENCY_HOURS = 12;
export const DEFAULT_ARTIST_RECENCY_HOURS = 2;
const DIVERSE_LIBRARY_ARTISTS = 48;
const MIN_TRACK_RECENCY_HOURS = 1;
const MIN_ARTIST_RECENCY_HOURS = 0.25;

// Count-based hard no-repeat guard tuning (effectiveNoRepeatWindow below).
// Never hard-block more than this fraction of the tagged library; below
// MIN_EFFECTIVE distinct tracks the guard switches off entirely and the
// relaxable time-window guard carries on alone.
const NO_REPEAT_MAX_LIBRARY_FRACTION = 0.375;
const NO_REPEAT_MIN_EFFECTIVE = 15;

export interface RecencyWindows {
  trackHours: number;
  artistHours: number;
}

export interface CandidateLike {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  // Subsonic songs carry `duration`, library-db rows `durationSec`. Both
  // optional — unknown length is never grounds to drop.
  duration?: number | null;
  durationSec?: number | null;
  // Album surface for the cooldown (albumKey below). All optional: each source
  // carries a different subset, and absent reads as "no evidence", never as a
  // repeat.
  album?: string | null;
  albumArtist?: string | null;
  isCompilation?: boolean | null;
  yearUntrusted?: boolean | null;
}

interface CandidateFilterState {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;
  recentArtists?: Set<string>;
  // Configured slot spacing, using the SAME lead-artist keys and queue snapshot
  // as the agent guard. Separate from raw recentArtists so identity/dedup keys
  // and discovery-tool callers keep their existing semantics. Relaxable.
  recentArtistRoots?: Set<string>;
  // Album cooldown (#1485 FR 3) — albumKey()s heard inside picker.albumHours,
  // from queue.recentAlbumKeys(). Relaxable, and the FIRST guard the cascade
  // drops (longest memory, so its loss costs least on a starved pool). Empty =
  // off (the default), and an empty set removes its cascade stage entirely.
  recentAlbums?: Set<string>;
  // How a candidate's album key is resolved. Defaults to the pure `albumKey`,
  // right for a candidate already carrying its compilation flags. Real pick
  // paths inject `music/album-facts.albumKeyFor`, which fills those flags in
  // from the library — without it the exemption is dead on a raw Subsonic
  // candidate. Injected rather than imported so this module stays pure.
  albumKeyOf?: (song: CandidateLike) => string;
  // Count-based hard no-repeat guard, from show-recency.hardRecentFor (the
  // last N distinct plays, or a full rotation's own airings). Checked OUTSIDE
  // the relaxation cascade, so the last N distinct plays can't re-air even
  // once the relaxable track guard is dropped. Empty = off.
  hardRecentIds?: Set<string>;
  hardRecentKeys?: Set<string>;
  seenIds?: Set<string>;
  artistCounts?: Map<string, number>;
  maxPerArtist?: number;
  cap?: number;
  // Whether a starved result may relax the recent-ARTIST guard. Default true
  // preserves the pool picker's "never return empty" behaviour. Only the pool
  // picker passes recentArtists, so it is inert on the agent path, whose
  // artist variety is enforced at the point of choice instead (#618, #1124).
  allowArtistRelaxation?: boolean;
  // Artists that may NEVER be returned, checked outside the mode loop like
  // hardRecentIds — unlike recentArtists, which the cascade may drop (#1187).
  // Empty on every pick but the agent's artist-guard rescue. Keys are
  // artistRootKey()-normalised and matched against a candidate's raw AND lead
  // key, so blocking an artist also blocks the collaborations they front.
  blockedArtists?: Set<string>;
}

// Track length in seconds from whichever field the source carries, or null when
// unknown (zero/negative/non-finite all read as unknown). Delegates to
// music/track-floor.ts so the length CAP and the length FLOOR can't disagree
// about how long a track is (#1573).
export function durationSeconds(song: CandidateLike): number | null {
  return trackLengthSeconds(song);
}

export function artistKey(song: CandidateLike): string {
  return (song.artist || '').toLowerCase().trim();
}

// A "featuring" marker — always a credit on someone else's track, never part
// of an artist's own name. `(feat.` / `[ft` shapes included.
const FEATURE_SPLIT = /\s*[([]?\s*\b(?:feat|ft|featuring)\b\.?\s+/i;
// A join between two credited acts. Deliberately NOT "with" or "x" — "Sleeping
// with Sirens" and "Chase x Status" would lose their tail.
const JOIN_SPLIT = /\s+(?:&|\+|and)\s+/i;

// Curly-vs-straight apostrophes carry no identity ("Guns N’ Roses"). Folded
// BEFORE the splits above so a curly apostrophe can't hide a join marker.
const APOSTROPHES = /[‘’ʼ´`]/g;

// "The Clash" and "Clash" are one act. Only stripped when something survives
// it, so "The The" keys as "the".
const LEADING_ARTICLE = /^the\s+/;

// A hyphen or dash BETWEEN two letters/digits spells the same act as a space
// does: one server credits "SCSI-9", another "SCSI 9" (seen back to back on
// air), "Jay-Z"/"Jay Z", "A-ha"/"A ha", "The-Dream"/"The Dream". Only inside a
// word: " - " joining two credits is untouched, and so are dots (initialisms
// like "M.I.A." and "Booker T. & the M.G.'s" keep their keys) and "/"
// ("AC/DC"). Nothing feeding the never-play blocklist (nameKey,
// artistParticipantKeys) folds this way. It DOES reach `blockedArtists`, the
// guard-rescue set filterPickerCandidates hard-drops: two different acts
// named apart only by a hyphen would both leave that one rescue pool call.
// Accepted because that pair is vanishingly rare, the drop lasts one call,
// and it over-matches, which every caller reads as "pick someone else".
const IN_NAME_SEPARATOR = /(?<=[\p{L}\p{N}])[-‐‑‒–](?=[\p{L}\p{N}])/gu;

// Exact full-name aliases for acts whose tags alternate between a named lead
// and their ensemble credit. Never make this a generic suffix strip: "The Beta
// Band" and "Kronos Quartet" are complete act names, and a false equivalence
// here reaches `blockedArtists`, which is a HARD filter. Verified aliases only.
// Looked up after the separator fold and the article strip, so write a key in
// that folded form: no leading "the", a space for an in-word hyphen. A key
// with a hyphen in it would never match.
const ARTIST_ROOT_ALIASES = new Map<string, string>([
  ['jimi hendrix experience', 'jimi hendrix'],
  ['glenn miller orchestra', 'glenn miller'],
  ['dave matthews band', 'dave matthews'],
  ['bill evans trio', 'bill evans'],
]);

// The one fold under every free-text NAME comparison (artist credit, album
// title, operator-typed text): case, apostrophes, whitespace. Nothing here
// changes which thing a string names, which is what makes it safe in front of
// the ABSOLUTE blocklist, whose artist (#1603) and album (#1611) tiers key both
// sides through it. Deliberately NOT artistRootKey's further folding, which
// widens a MATCHING key — wrong for a hard drop with no never-starve behind it.
// `schemas/blocklist.ts` normText RESTATES this fold (a mirrored schema module
// may import only zod); scripts/blocklist-name-fold.test.ts pins them in step.
export function nameKey(raw: unknown): string {
  return String(raw ?? '').toLowerCase().replace(APOSTROPHES, "'").replace(/\s+/g, ' ').trim();
}

// Artist-facing alias for the same fold — one function, two names, so neither
// call site is tempted into a local copy.
export const artistNameKey = nameKey;

// The LEAD artist of a credit — `artistKey` collapsed onto its primary act, so
// a collaboration shares a key with the artist who leads it (#1251):
//
//   "Marvin Gaye & Tammi Terrell"  → "marvin gaye"
//   "The Jimi Hendrix Experience"  → "jimi hendrix"
//   "Sly & the Family Stone"       → "sly & the family stone"   (unchanged)
//
// Also folds the variants one act picks up across multi-source tagging (#1406):
// leading article, exact full-name aliases, apostrophes, and a hyphen or dash
// inside a word spelled as a space ("SCSI-9" = "SCSI 9"). The `the …` exception
// on the join keeps band names whole ("X & the Y" is one act); everything else
// after a join is a second credited act — imperfect on "Hall & Oates"-shaped
// duos, but a wrong key here can only over-match, which every caller reads as
// "pick someone else". Only the LEAD is normalised, so "Tammi Terrell" and
// "Marvin Gaye & Tammi Terrell" still key apart.
//
// Key a RAW credit, never a key: the hyphen fold runs after the splits, so a
// key can re-split ("Jay-and-Silent-Bob" → "jay and silent bob" → "jay").
//
// NOT a replacement for `artistKey`, which is an IDENTITY key feeding
// `trackKey` and must stay byte-identical to the `title|artist` keys
// queue.recentlyPlayed builds from raw tag text. This is a MATCHING key.
export function artistRootKey(song: CandidateLike | string): string {
  const raw = typeof song === 'string' ? song : (song?.artist || '');
  const base = artistNameKey(raw);
  if (!base) return '';

  let root = base;
  const featAt = root.search(FEATURE_SPLIT);
  if (featAt > 0) root = root.slice(0, featAt).trim();

  const join = JOIN_SPLIT.exec(root);
  if (join && join.index > 0) {
    const tail = root.slice(join.index + join[0].length).trim();
    if (tail && !/^the\b/.test(tail)) root = root.slice(0, join.index).trim();
  }

  // Separator fold, article and alias come AFTER the splits, so a hyphen never
  // changes where a credit splits, the join's `the …` exception still sees the
  // tail it protects, and the alias is judged against the LEAD. The fold runs
  // before the article strip so "The-Dream" loses its article as "The Dream"
  // does.
  root = root.replace(IN_NAME_SEPARATOR, ' ');
  const unarticled = root.replace(LEADING_ARTICLE, '').trim();
  if (unarticled) root = unarticled;
  root = ARTIST_ROOT_ALIASES.get(root) ?? root;

  return root || base.replace(IN_NAME_SEPARATOR, ' ');
}

// Do two artist MATCHING keys (artistRootKey) name the same act, or does one
// credit contain the other as a delimited act? Separator-agnostic on purpose:
// music servers join several credited artists with whatever their scanner or
// tagger chose (Navidrome " • ", " / ", "; ", ", " …), so no list of
// separators can be complete. Instead any character that cannot be part of a
// name counts as a boundary between acts: everything except letters, digits,
// whitespace and the marks names carry: apostrophe, period, hyphen, and the
// "&"/"+" that sit inside band names ("Sly & the Family Stone", "Florence +
// the Machine") and that artistRootKey's lead split already handles.
//
//   "pixies"  vs "pixies • black francis"  → true   (delimited by "•")
//   "pixies"  vs "black francis / pixies"  → true   (delimited by "/")
//   "air"     vs "air supply"              → false  (only a space: one name)
//   "sly"     vs "sly & the family stone"  → false  ("&" is part of the name)
//   "simon"   vs "paul simon"              → false
//
// A spacing key, never an identity or block key: a wrong answer can only
// over-match, which every caller reads as "pick someone else". Not for the
// blocklist, which is a HARD filter with no never-starve behind it.
const NAME_CHAR = /[\p{L}\p{N}\s'.\-&+]/u;

function delimitedAt(text: string, from: number, step: 1 | -1): boolean {
  // Walk away from the match over spaces; the first other character decides.
  for (let i = from; i >= 0 && i < text.length; i += step) {
    const ch = text[i]!;
    if (/\s/u.test(ch)) continue;
    return !NAME_CHAR.test(ch);
  }
  return true; // reached the edge of the credit
}

export function artistCreditsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = long.indexOf(short); i !== -1; i = long.indexOf(short, i + 1)) {
    if (delimitedAt(long, i - 1, -1) && delimitedAt(long, i + short.length, 1)) return true;
  }
  return false;
}

// Every act a credit names that the SPACING guards should see, not only its
// lead (#1251 keys on the lead alone). artistRootKey drops everything after the
// first join, so "Daljit Chahal & Karan Aujla" keyed as "daljit chahal" and
// walked past a window holding "karan aujla" — seen live: three Karan Aujla
// credits in 13 minutes, two back to back. Comma-joined acts were already
// reachable through artistCreditsOverlap's delimiters; "&", "+", "and" and
// "x" sit inside real act names, so they were not.
//
// A tail act counts only when the LIBRARY knows it as an act of its own: some
// credit there leads with it. That is the guard against band names — "Earth,
// Wind & Fire" offers "fire", which counts only if an act called Fire leads a
// credit in this library. "X & the Y" never splits (artistRootKey's rule).
// Without a provider (tests, a library not loaded yet) only the lead counts,
// which is exactly the old behaviour: the failure direction is the status quo.
//
// SPACING only. Never a blocklist key: that list is absolute, and these keys
// are deliberately allowed to over-match.
const ACT_JOIN = /\s+(?:&|\+|and|x)\s+(?!the\b)|\s*,\s*/i;

let knownActs: (() => ReadonlySet<string>) | null = null;

// library.ts registers its act index here; recency stays free of a library import.
export function setKnownActsProvider(fn: (() => ReadonlySet<string>) | null): void {
  knownActs = fn;
}

export function creditedActKeys(song: CandidateLike | string): string[] {
  const root = artistRootKey(song);
  if (!root) return [];
  const known = knownActs?.();
  if (!known?.size) return [root];
  const raw = typeof song === 'string' ? song : (song?.artist || '');
  const out = [root];
  for (const segment of artistNameKey(raw).split(FEATURE_SPLIT)) {
    for (const part of segment.split(ACT_JOIN)) {
      const key = artistRootKey(dropOrphanCloser(part).trim());
      if (key && !out.includes(key) && known.has(key)) out.push(key);
    }
  }
  return out;
}

// The same acts as display names, for prompts: the Agentic pick event lists
// them so the model can step around what the guard will refuse. A whole
// credit there read as one act ("Amantej Hundal & Karan Aujla"), and the
// model proposed Karan Aujla twice more for the guard to catch. The lead group
// stays whole, commas and all (the guard's lead key covers each comma-joined
// name by delimiter); a tail act is named only when the library knows it,
// exactly as creditedActKeys counts it. With no act index: the whole credit.
const ACT_JOIN_NAMED = /\s+(?:&|\+|and|x)\s+(?!the\b)/i;

export function creditedActNames(song: CandidateLike | string): string[] {
  const raw = String(typeof song === 'string' ? song : (song?.artist || '')).replace(/\s+/g, ' ').trim();
  if (!artistRootKey(raw)) return [];
  const known = knownActs?.();
  if (!known?.size) return [raw];
  const out = new Map<string, string>();
  raw.split(FEATURE_SPLIT).forEach((segment, si) => {
    segment.split(ACT_JOIN_NAMED).forEach((part, pi) => {
      const lead = si === 0 && pi === 0;
      const pieces = lead ? [part] : part.split(/\s*,\s*/);
      for (const piece of pieces) {
        const name = dropOrphanCloser(piece).trim();
        const key = artistRootKey(name);
        if (key && !out.has(key) && (lead || known.has(key))) out.set(key, name);
      }
    });
  });
  return out.size ? [...out.values()] : [raw];
}

// Does any act this credit names fall in a spacing window? The window side is
// built from creditedActKeys too (queue.neighbourArtistRoots), so a shared
// tail act meets from either direction.
export function creditInRoots(song: CandidateLike | string, roots: Iterable<string>): boolean {
  return creditedActKeys(song).some(act => artistRootIn(act, roots));
}

// artistCreditsOverlap against a set of keys (queue.neighbourArtistRoots): an
// exact hit first, the scan only when there is none.
export function artistRootIn(root: string, roots: Iterable<string>): boolean {
  if (!root) return false;
  if (roots instanceof Set && roots.has(root)) return true;
  for (const r of roots) if (artistCreditsOverlap(root, r)) return true;
  return false;
}

// Every act CREDITED on a track, in credit order — the opposite question to
// artistRootKey, which asks who LEADS the credit:
//
//   "Kanye West (feat. Jay-Z)"  → ["kanye west", "jay-z"]
//   "Simon & Garfunkel"         → ["simon & garfunkel"]
//
// Written for the blocklist (#1603): a block has to reach tracks the artist
// only GUESTS on, and the id tiers can't — a Subsonic song carries one
// `artistId` (the lead), and there is no participant list in the library.
//
// FEATURE_SPLIT is the WHOLE of what gets split, deliberately. `&`, `+`, `,`
// and `x` sit inside act names far more often than they join two credits, and
// the caller is absolute — no never-starve, requests included — so a wrong key
// silently removes music the operator never blocked. The cost is honest
// under-matching: "Y feat. A & B" keys as ["y", "a & b"]. A marker at index 0
// is not a marker ("Ft. Lauderdale"), same guard as artistRootKey, whose
// further folding is also deliberately not applied here.

// The split eats the OPENING bracket of a "(feat. …)" credit, orphaning its
// closer on the tail. Drops ONE closer, and only when the segment has more
// closers than openers — a greedy run ate real names ("Sunn O)))"). The lead
// segment is never touched. Nested brackets are not balanced here; nothing
// downstream needs them to be.
function dropOrphanCloser(part: string): string {
  const closes = (part.match(/[)\]]/g) || []).length;
  if (!closes || closes <= (part.match(/[([]/g) || []).length) return part;
  return part.replace(/[)\]](\s*)$/, '$1');
}

export function artistParticipantKeys(song: CandidateLike | string): string[] {
  const raw = typeof song === 'string' ? song : (song?.artist || '');
  const base = artistNameKey(raw);
  if (!base) return [];
  if (base.search(FEATURE_SPLIT) <= 0) return [base];

  const out: string[] = [];
  const parts = base.split(FEATURE_SPLIT);
  for (let i = 0; i < parts.length; i++) {
    const key = (i > 0 ? dropOrphanCloser(parts[i]!) : parts[i]!).trim();
    if (key && !out.includes(key)) out.push(key);
  }
  return out.length ? out : [base];
}

export function trackKey(song: CandidateLike): string {
  return `${(song.title || '').toLowerCase().trim()}|${artistKey(song)}`;
}

// The names a tagger writes on a multi-artist release. Lives here beside
// artistRootKey because it is a fact about artist NAMES; era-suspect.ts imports
// it that way round so recency acquires no era policy.
const VARIOUS_ARTIST_NAMES = new Set([
  'variousartists', 'various', 'va', 'verschiedene', 'diversos', 'divers',
]);

export function isVariousArtistsName(raw: unknown): boolean {
  return VARIOUS_ARTIST_NAMES.has(String(raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
}

// Is a cooldown on this track's ALBUM the wrong question? (#1485 FR 3)
// On a compilation it always is — a sampler is a container, not a record an
// artist made. Reuses the era pipeline's composed signals, never a second
// heuristic (#1418): `yearUntrusted` is the OR of Navidrome's `isCompilation`
// and the walk's derived `era_untrusted`, so it also catches anthologies with
// no COMPILATION tag. `isCompilation` is read beside it because a
// Subsonic-sourced candidate can carry the raw flag with no walked row behind
// it.
export function albumCooldownExempt(song: CandidateLike): boolean {
  if (song?.isCompilation === true || song?.yearUntrusted === true) return true;
  return isVariousArtistsName(song?.albumArtist);
}

// The album cooldown's key: the record, and who made it. Name-folded through
// the same normalisers as artistRootKey, and paired with the LEAD of the ALBUM
// artist when the source carries one, the track's own artist otherwise. The
// ARTIST half stops an untagged compilation blocking a whole evening — without
// a lead in the key, twelve artists on one sampler would share it.
//
// '' means NO KEY, never a match — an exempt album, an untitled one, an
// untagged artist. Absence of a name is not evidence of a repeat. Deliberately
// NOT edition-stripping: "Kid A" and "Kid A (Remastered)" stay apart rather
// than guessing which parenthetical is an edition.
export function albumKey(song: CandidateLike): string {
  if (!song || albumCooldownExempt(song)) return '';
  const album = nameKey(song.album);
  if (!album) return '';
  const artist = artistRootKey({ artist: song.albumArtist || song.artist });
  if (!artist) return '';
  return `${album}|${artist}`;
}

// Large-library boost on the relaxable windows: the 12h/2h defaults are tuned
// for small-to-mid libraries and block under 2% of a 10k-50k catalogue. Keys on
// TRACK COUNT, never distinct artists (a 500-track library clears any artist
// threshold and would be over-blocked), and steps so even the largest blocks
// under ~5% of the library at radio pace.
function librarySizeBoost(totalTracks: number): number {
  if (totalTracks >= 20000) return 3;   // 36h track / 6h artist
  if (totalTracks >= 8000) return 2;    // 24h / 4h
  if (totalTracks >= 3000) return 1.5;  // 18h / 3h
  return 1;
}

export function recencyWindowsForLibrary(
  distinctArtists: number | null | undefined,
  totalTracks: number | null | undefined = 0,
): RecencyWindows {
  const boost = librarySizeBoost(Math.floor(Number(totalTracks) || 0));
  if (!distinctArtists || distinctArtists <= 0) {
    return {
      trackHours: DEFAULT_TRACK_RECENCY_HOURS * boost,
      artistHours: DEFAULT_ARTIST_RECENCY_HOURS * boost,
    };
  }

  const scale = Math.min(1, Math.max(distinctArtists / DIVERSE_LIBRARY_ARTISTS, 1 / 12)) * boost;
  const roundToQuarterHour = (hours: number) => Math.round(hours * 4) / 4;

  return {
    trackHours: Math.max(
      MIN_TRACK_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_TRACK_RECENCY_HOURS * scale),
    ),
    artistHours: Math.max(
      MIN_ARTIST_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_ARTIST_RECENCY_HOURS * scale),
    ),
  };
}

// Clamp a configured count-based no-repeat window to what the tagged library
// can support. 0 = guard off (configuredN <= 0, unknown/empty library, or a
// result below NO_REPEAT_MIN_EFFECTIVE); otherwise capped at
// NO_REPEAT_MAX_LIBRARY_FRACTION of the library.
// Examples: (100,1000)→100, (100,40)→15, (100,20)→0, (0,*)→0, (100,null)→0.
export function effectiveNoRepeatWindow(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
): number {
  const n = Math.floor(Number(configuredN) || 0);
  const total = Math.floor(Number(libraryTotal) || 0);
  if (n <= 0 || total <= 0) return 0;
  const ceiling = Math.floor(total * NO_REPEAT_MAX_LIBRARY_FRACTION);
  const eff = Math.min(n, ceiling);
  return eff < NO_REPEAT_MIN_EFFECTIVE ? 0 : eff;
}

// Headroom the EXHAUSTIVE window leaves under the rotation it governs; both
// slots are load-bearing. queue.recentlyPlayedByCount(n) also blocks the ON-AIR
// track, so a window of n withholds n+1 identities; and one identity must
// survive, since the guard sits outside the starvation cascade and an empty
// pool is a skipped pick. A rotation of S therefore takes S-2.
const EXHAUSTIVE_WINDOW_HEADROOM = 2;

// The window that makes a rotation exhaust ITSELF: every identity airs once
// before any airs again (#1612). Deliberately free of effectiveNoRepeatWindow's
// ceiling and floor — those bound a number the operator TYPED, while this one
// is derived from the universe it governs. A universe too small for the
// headroom returns 0, and the relaxable cascade carries the rotation instead.
export function exhaustiveNoRepeatWindow(universeSize: number | null | undefined): number {
  const total = Math.floor(Number(universeSize) || 0);
  return Math.max(0, total - EXHAUSTIVE_WINDOW_HEADROOM);
}

export function filterPickerCandidates<T extends CandidateLike>(
  list: T[],
  {
    recentIds = new Set<string>(),
    recentKeys = new Set<string>(),
    recentArtists = new Set<string>(),
    recentArtistRoots = new Set<string>(),
    recentAlbums = new Set<string>(),
    albumKeyOf = albumKey,
    hardRecentIds = new Set<string>(),
    hardRecentKeys = new Set<string>(),
    seenIds = new Set<string>(),
    artistCounts = new Map<string, number>(),
    maxPerArtist = Infinity,
    cap = Infinity,
    allowArtistRelaxation = true,
    blockedArtists = new Set<string>(),
  }: CandidateFilterState = {},
): T[] {
  // Duration policy is applied BEFORE this relaxation cascade: the legacy
  // cut mode does not filter; exclude's hard ceiling must never be rescued.
  // The floor's posture differs per path and remains in track-floor.ts.
  const pool = list || [];

  // Relaxation cascade: each mode drops a guard so a starved pool still yields
  // something. With artist relaxation disabled the artist guard stays ON in
  // every mode, so the agent is never handed an artist it just played.
  //
  // The album stage is PREPENDED, and only when there is an album set to
  // enforce, so with the cooldown off the mode list is exactly what it was.
  const base = allowArtistRelaxation
    ? [
        { recentTracks: true, recentArtists: true, recentAlbums: false },
        { recentTracks: true, recentArtists: false, recentAlbums: false },
        { recentTracks: false, recentArtists: false, recentAlbums: false },
      ]
    : [
        { recentTracks: true, recentArtists: true, recentAlbums: false },
        { recentTracks: false, recentArtists: true, recentAlbums: false },
      ];
  const modes = recentAlbums.size
    ? [{ recentTracks: true, recentArtists: true, recentAlbums: true }, ...base]
    : base;

  for (const mode of modes) {
    const nextSeen = new Set(seenIds);
    const nextArtistCounts = new Map(artistCounts);
    const out: T[] = [];

    for (const song of pool) {
      if (!song?.id || nextSeen.has(song.id)) continue;
      // Hard no-repeat guard — no mode gate, so it holds through every
      // relaxation stage. effectiveNoRepeatWindow keeps the set well under the
      // library size, so it can't starve the pool to nothing.
      if (hardRecentIds.has(song.id)) continue;
      if (hardRecentKeys.has(trackKey(song))) continue;
      if (mode.recentTracks && recentIds.has(song.id)) continue;
      if (mode.recentTracks && recentKeys.has(trackKey(song))) continue;

      // Album cooldown. An exempt or untitled album keys as '', which matches
      // nothing, so a compilation never blocks and never gets blocked.
      if (mode.recentAlbums) {
        const ak = albumKeyOf(song);
        if (ak && recentAlbums.has(ak)) continue;
      }

      const key = artistKey(song);
      // Hard artist block — no mode gate, so it survives every relaxation
      // stage (#1187); an empty set makes it a no-op. Matched on BOTH the raw
      // and the lead-artist key (#1251), or "Marvin Gaye & Tammi Terrell" would
      // answer a block on "Marvin Gaye".
      if (key && (blockedArtists.has(key) || artistRootIn(artistRootKey(song), blockedArtists))) continue;
      if (mode.recentArtists && key && recentArtists.has(key)) continue;
      if (mode.recentArtists && creditInRoots(song, recentArtistRoots)) continue;
      if (key) {
        const count = nextArtistCounts.get(key) || 0;
        if (count >= maxPerArtist) continue;
        nextArtistCounts.set(key, count + 1);
      }

      nextSeen.add(song.id);
      out.push(song);
      if (out.length >= cap) break;
    }

    if (out.length === 0) continue;

    for (const id of nextSeen) seenIds.add(id);
    artistCounts.clear();
    for (const [key, count] of nextArtistCounts) artistCounts.set(key, count);
    return out;
  }

  return [];
}
