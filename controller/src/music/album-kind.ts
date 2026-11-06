// What an era-suspect album IS (Library → Era). A policy module: the walk
// pre-fills a kind from the album title when the operator has not set one, and
// the admin tab offers the decision that usually fits each kind. The kind list
// itself lives in schemas/show.ts (ALBUM_KINDS), because a show can leave whole
// kinds out and schema modules import only zod.
//
// The suggestion reads the TITLE first and the detector's reason only as a
// tie-break: the detector says why an album looked suspect (a compilation tag,
// several artists), which every kind can share, so it is no answer to "what is
// it". A wrong guess costs one click in the dropdown; a missing guess leaves
// the album "unclassified". The kind steers the air only through a show's
// `excludedAlbumKinds`, so a guess never hides a track on its own.

import { ALBUM_KINDS, type AlbumKind } from '../schemas/show.js';

export { ALBUM_KINDS, type AlbumKind };

/** The three ways out of the Era list (era_override.verdict). */
export type EraDecision = 'trusted' | 'year' | 'suspect';

export function isAlbumKind(v: unknown): v is AlbumKind {
  return typeof v === 'string' && (ALBUM_KINDS as readonly string[]).includes(v);
}

// First match wins, in this order: the specific shapes before the broad ones
// ("Live at the Soundtrack Festival" is live; "DJ-Kicks: The Best Of" a mix).
const RULES: Array<[AlbumKind, RegExp]> = [
  ['dj-mix', /\b(?:dj[- ]?kicks|dj[- ]mix(?:ed)?|mixed by|continuous mix|mix compilation|fabric(?:live)? ?\d+|global underground|back to mine|late night tales|balance \d+|essential mix|the mix|in the mix)\b/i],
  ['soundtrack', /\b(?:soundtrack|o\.?s\.?t\.?|original (?:motion picture|score|cast|television)|music from (?:and inspired by )?(?:the )?(?:motion picture|film|series|game)|(?:film|movie|game) music)\b/i],
  ['tribute', /\b(?:tribute|covers?|salutes?|sings|plays the music of|in the style of|reimagined)\b/i],
  ['sampler', /\b(?:sampler|promo(?:tional)?|cover ?(?:cd|mount)|uncut presents|mojo presents|free cd)\b/i],
  ['reissue', /\b(?:remaster(?:ed)?|deluxe|reissue|expanded|anniversary|legacy edition|special edition|collector'?s edition|bonus tracks?)\b/i],
  ['box-set', /\b(?:box ?set|the complete (?:recordings|works|albums|collection)|\d+ ?cd)\b/i],
  ['live', /\b(?:live (?:at|in|from|on)|festival|unplugged|in concert)\b/i],
  ['dj-choice', /\b(?:selected by|compiled by|curated by|chosen by|selections? by|'s choice|dj choice|playlist)\b/i],
  ['chart', /\b(?:now that'?s what i call|top \d+|hits? (?:of )?(?:19|20)\d\d|(?:19|20)\d\d hits|chart|hit ?parade)\b/i],
  ['label', /\b(?:records|recordings) (?:presents|sampler|selection|collection)\b|\b\d+ releases\b/i],
  ['best-of', /\b(?:best of|greatest hits|the very best|anthology|the collection|singles|essential|retrospective|rarities|b-sides|gold|definitive)\b/i],
];

// One year in the title, not a range: "Techno 2019", "Ibiza 2004", "Summer 1998".
const SINGLE_YEAR = /\b(?:19|20)\d\d\b/;
const YEAR_RANGE = /\b(?:19|20)\d\d\s*[-–—/]\s*(?:(?:19|20)?\d\d)\b/;

export interface KindInput {
  album?: string | null;
  /** era-suspect.ts's marker for this album, when it flagged it. */
  reason?: string | null;
  /** labelOwner()'s answer for the album: the label it was filed under. */
  label?: string | null;
}

// Album-artist and folder names that say "several artists", never who.
const GENERIC_OWNER = /^(?:various(?: artists)?|va|v\.a\.?|divers|artistes? divers|compilations?|soundtracks?|unknown(?: artist)?|\[?unknown\]?|misc(?:ellaneous)?|\d{4})$/i;

const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface OwnerInput {
  /** The album's album artist (Navidrome's album `artist`). */
  albumArtist?: string | null;
  /** The real file path of one of its tracks (Navidrome's `path`, or the
   *  stored file_path): the folder above the album's folder names who filed it. */
  path?: string | null;
  /** Every track's artist credit. */
  trackArtists: ReadonlyArray<string | null | undefined>;
}

/** The folder above the album's own folder ("…/All Day I Dream/A Winter Sampler (2019)/01.flac"). */
export function ownerFolderOf(path: string | null | undefined): string | null {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 3] : null;
}

/**
 * The label a several-artist album is filed under, or null. A library kept as
 * <owner>/<album>/ files a label's compilations under the label, and tags
 * them with the label as album artist; an artist's own compilation (a DJ's
 * selection, a remix collection) is filed under that artist. So the owner is
 * the folder above the album (with a real path) or the album artist, whichever
 * is a name, is no "Various Artists", is credited on none of the album's
 * tracks, and, when the caller can say (`isArtist`, the library's own artist
 * credits), is no artist anywhere in the library: Andrew Weatherall and Bob
 * Sinclar have records of their own, Kamai Music and All Day I Dream do not.
 * A folder that sorts many owners' albums is skipped as a candidate.
 */
export interface OwnerContext {
  /** The library's own artist credits (era-review.libraryOwnerContext). */
  isArtist?: (name: string) => boolean;
  /** A folder that holds many owners' albums (the library's own sorting
   *  folders: "Discothèque", "NEW", "Compilations"), never an owner itself. */
  isContainerFolder?: (name: string) => boolean;
}

export function labelOwner(
  { albumArtist, path, trackArtists }: OwnerInput,
  ctx: OwnerContext = {},
): string | null {
  const credits = trackArtists.map(a => fold(String(a ?? ''))).filter(Boolean);
  if (new Set(credits).size < 2) return null;
  const folder = ownerFolderOf(path);
  const candidates = [folder && !ctx.isContainerFolder?.(folder) ? folder : null, albumArtist];
  for (const raw of candidates) {
    const name = String(raw ?? '').trim();
    if (!name || GENERIC_OWNER.test(name)) continue;
    const key = fold(name);
    if (!key || credits.some(c => c.includes(key))) continue;
    if (ctx.isArtist?.(name)) continue;
    return name;
  }
  return null;
}

// A title rule this weak gives way to the album being filed under a label:
// "A Winter Sampler" in an All Day I Dream folder is the label's compilation.
const YIELDS_TO_LABEL = new Set<AlbumKind>(['sampler']);

/** The kind to pre-fill for a flagged album, or null for "unclassified". */
export function suggestAlbumKind({ album, reason, label }: KindInput): AlbumKind | null {
  const title = String(album ?? '');
  for (const [kind, re] of RULES) {
    if (!re.test(title)) continue;
    return label && YIELDS_TO_LABEL.has(kind) ? 'label' : kind;
  }
  if (label) return 'label';
  const multi = reason === 'various-artists' || reason === 'many-artists';
  // A dated various-artists record ("Techno 2019"): one known year by design.
  if (multi && SINGLE_YEAR.test(title) && !YEAR_RANGE.test(title)) return 'chart';
  // One artist, a span of years in the title ("Singles 1968-1974").
  if (reason === 'title-year-range' || reason === 'title-compilation') return 'best-of';
  // Several artists and nothing more specific: a themed compilation is the
  // common case ("Années 80", "Cowabunga! The Surf Box").
  if (multi) return 'themed';
  return null;
}

/** The decision that usually fits a kind, which the tab highlights. */
export function suggestedDecision(kind: AlbumKind | null): EraDecision | null {
  switch (kind) {
    case 'original-album':
    case 'tribute':
    case 'chart':
    case 'label':
    case 'sampler':
    case 'dj-mix':
    case 'live':
      return 'trusted';
    case 'reissue':
      return 'year';
    case 'best-of':
    case 'themed':
    case 'dj-choice':
    case 'soundtrack':
    case 'box-set':
      return 'suspect';
    default:
      return null;
  }
}
