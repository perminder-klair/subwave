// Pure decisions behind the persona bundle (#1620) — the parts worth pinning
// without a state dir, a zip or a running station.
//
// Three of them are load-bearing:
//
//   `uniqueFilename` is the "suffix, never overwrite" rule. A persona's voice
//   is referenced BY FILENAME (`tts.voice` is a basename in the shared voice
//   folder), so writing an imported sample over an existing one would silently
//   swap the voice of whatever persona already pointed at that name — the same
//   reason voice-library.importVoice refuses a clash outright. An import cannot
//   refuse (the operator has no way to rename inside a zip), so it suffixes and
//   re-points the incoming persona at the name it actually got.
//
//   `jinglesNamingPersona` decides what "a jingle naming this persona" means.
//   Nothing links a jingle to a persona on disk — the sidecar carries only the
//   spoken text — so the name has to be matched IN that text, and it has to be
//   matched on a word boundary: a substring test hands every jingle to a DJ
//   called "Al". Builtin idents are excluded because they are station furniture
//   that every install already has and cannot delete.
//
//   `JINGLE_FILENAME_RE` pins what an adopted filename may CONTAIN, not just
//   what it ends in. A jingle filename is emitted as a line of `jingles.m3u`,
//   which Liquidsoap watches, so a newline inside one is an extra rotation
//   entry the operator never added. The bundle is a file from another operator;
//   an extension test is not a filename check.

/** Manifest `format` — the thing that distinguishes a persona bundle from a station backup. */
export const PERSONA_BUNDLE_FORMAT = 'subwave-persona';
export const PERSONA_BUNDLE_VERSION = 1;

/** Zip member names. Mirrors the state-dir layout so a bundle reads like a backup. */
export const BUNDLE_PERSONA_ENTRY = 'persona.json';
export const BUNDLE_MANIFEST_ENTRY = 'manifest.json';
export const BUNDLE_VOICE_DIR = 'voices';
export const BUNDLE_JINGLE_DIR = 'jingles';

// TTS_CHATTERBOX_VOICE_RE caps a reference-WAV name at 80 chars, and that regex
// is what personaSchema validates `tts.voice` against — so a suffixed name that
// overflowed it would be written to disk and then refused by the save.
export const VOICE_NAME_MAX = 80;
/** Jingle filenames are only ever a sidecar key, so the cap is just sanity. */
export const JINGLE_NAME_MAX = 120;

/**
 * The character class an ADOPTED jingle filename must sit inside.
 *
 * Same class as TTS_CHATTERBOX_VOICE_RE, and it is not cosmetic. A jingle
 * filename becomes a line in `jingles.m3u` — `rewritePlaylist` joins the folder
 * and the name with '\n' — and Liquidsoap reads that playlist with
 * reload_mode="watch". So a member named "one.wav\n<anything>\ntwo.wav" would
 * write ITS OWN extra line into the station's jingle rotation, no restart
 * needed. A bundle is a file the operator was handed by someone else, which
 * makes that untrusted input by design; checking only the extension (which is
 * all isAcceptedAudio does) leaves every other byte of the name free.
 *
 * The bound is JINGLE_NAME_MAX minus the room `uniqueFilename` needs for a
 * `-999` suffix, so a name that passes here still passes after a collision.
 */
export const JINGLE_FILENAME_RE = /^[A-Za-z0-9_.-]{1,116}$/;

/**
 * How many jingles one bundle may carry.
 *
 * Each member becomes a file, a sidecar row AND a line in the watched playlist,
 * and the admin UI deletes them one at a time — so an uncapped bundle is a
 * one-click way to load a station's rotation with more stingers than an
 * operator can plausibly remove. A DJ with two dozen idents is already an
 * unusual DJ; the 50 MB request cap alone would allow thousands of tiny WAVs.
 */
export const MAX_BUNDLE_JINGLES = 24;

/**
 * Cap on the spoken text a bundle may claim for a jingle.
 *
 * It is written verbatim into jingles.json and shown in the admin list, and it
 * is the one field in the manifest an importer copies to disk without the
 * persona schema ever seeing it. A stinger script is a sentence; every other
 * operator-visible text field in the codebase is bounded, and this one was not.
 */
export const JINGLE_TEXT_MAX = 300;

/** The engines that read `tts.voice` as a reference-WAV basename (#213). */
export const CLONE_VOICE_ENGINES = ['chatterbox', 'pocket-tts'] as const;

/**
 * Does this persona's voice slot name a reference WAV we should carry?
 *
 * Reads the RAW slot, deliberately NOT the one resolved against the station
 * default. A persona on the `inherit` sentinel has no voice of its own —
 * resolvePersonaVoiceSlot drops the field for every engine outside the
 * piper/kokoro id-space — so an inherit persona on a chatterbox station is
 * speaking with the STATION's reference wav, which is not this persona's to
 * export.
 */
export function personaCloneVoice(tts: { engine?: unknown; voice?: unknown } | null | undefined): string | null {
  const engine = String(tts?.engine ?? '');
  if (!(CLONE_VOICE_ENGINES as readonly string[]).includes(engine)) return null;
  const voice = String(tts?.voice ?? '').trim();
  if (!voice.toLowerCase().endsWith('.wav')) return null;
  return voice;
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * A filename in `taken` gets `-2`, `-3`, … before its extension until it is free.
 *
 * Comparison is case-INSENSITIVE: on a case-folding filesystem (macOS's
 * default, and every Docker Desktop bind mount on one) "Morgan.wav" and
 * "morgan.wav" are the same file, so a case-sensitive check would hand back a
 * "free" name that overwrites on write — the one outcome this function exists
 * to make impossible.
 *
 * The stem is trimmed, never the suffix, so the result always stays under
 * `maxLength`; a name that cannot be made unique throws rather than returning
 * a colliding one.
 */
export function uniqueFilename(
  desired: string,
  taken: Iterable<string>,
  maxLength: number = VOICE_NAME_MAX,
): string {
  const used = new Set<string>();
  for (const t of taken) used.add(String(t).toLowerCase());
  const { stem, ext } = splitName(desired);
  const fit = (s: string, suffix: string) => {
    const room = maxLength - ext.length - suffix.length;
    if (room < 1) throw new Error(`cannot fit "${desired}" under ${maxLength} characters`);
    return `${s.slice(0, room)}${suffix}${ext}`;
  };
  const first = fit(stem, '');
  if (!used.has(first.toLowerCase())) return first;
  for (let n = 2; n <= 999; n += 1) {
    const candidate = fit(stem, `-${n}`);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`too many files already named like "${desired}"`);
}

// Word-ish characters for the boundary test. Deliberately ASCII-narrow: the
// point is only that "Al" must not match "Alan", not that every script's
// notion of a word is honoured.
const WORDISH = /[A-Za-z0-9]/;

/**
 * Does `text` mention `name` as a whole word (case-insensitive)?
 *
 * Scanned rather than regexed because a persona name is free operator text and
 * may hold regex metacharacters ("DJ (K)", "R.E.M."); escaping is one more
 * thing to get wrong, and the boundary rule is two character tests.
 */
export function textNamesPersona(text: string, name: string): boolean {
  const hay = String(text ?? '').toLowerCase();
  const needle = String(name ?? '').trim().toLowerCase();
  // A single character matches far too much to be evidence of anything.
  if (needle.length < 2 || !hay) return false;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at > 0 ? hay[at - 1] : '';
    const after = hay[at + needle.length] ?? '';
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true;
    from = at + 1;
  }
}

/**
 * The jingles a persona bundle carries: the operator's own stingers whose text
 * names this DJ. Builtins are station furniture — every install already has the
 * default ident and cannot delete it — so they never travel.
 */
export function jinglesNamingPersona<T extends { text?: unknown; builtin?: unknown }>(
  jingles: readonly T[],
  personaName: string,
): T[] {
  return jingles.filter(j => !j.builtin && textNamesPersona(String(j.text ?? ''), personaName));
}

/** Reject absolute paths and `..` traversal — same guard as routes/backup.ts's isSafeEntry. */
export function isSafeBundleEntry(entryName: string): boolean {
  const n = String(entryName).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split('/').includes('..');
}

/**
 * The basename of a zip member that must sit directly inside `dir`, or null.
 *
 * One-level-deep on purpose: `voices/a/b.wav` is not something the exporter can
 * produce, and accepting it would mean deciding what to do with the directory
 * part on the way back out to a flat state folder.
 */
export function bundleMemberName(entryName: string, dir: string): string | null {
  if (!isSafeBundleEntry(entryName)) return null;
  const parts = String(entryName).replace(/\\/g, '/').split('/');
  if (parts.length !== 2 || parts[0] !== dir) return null;
  return parts[1] || null;
}

/** Download filename for a persona bundle: `subwave-persona-<slug>.zip`. */
export function bundleFilename(personaName: string): string {
  const slug = String(personaName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `subwave-persona-${slug || 'dj'}.zip`;
}
