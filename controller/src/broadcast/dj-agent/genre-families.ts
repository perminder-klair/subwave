// A small built-in family map for the genre-run guard. Two genre labels count
// as one genre when they match or when both sit in the same family below.
// Labels arrive already consolidated by the operator's scene aliases (the
// ingest normaliser, `subsonic.songGenres`, applied them). A label in no family only ever matches
// itself.
//
// Keep this list SMALL and obviously correct. A family groups labels that a
// listener hears as one genre family in a run of tracks. It does not try to
// be a taxonomy. When a label is arguable (trip hop, jazz fusion, blues rock,
// post-punk, country rock), leave it out: an unlisted label simply falls back
// to exact label overlap. Entries are matched through `genreKey`, so case,
// spacing and separators do not matter.
import { sceneKey } from '../../music/scene-vocab.js';

export const GENRE_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  reggae: ['reggae', 'roots reggae', 'dub', 'ska', 'rocksteady', 'dancehall', 'lovers rock', 'ragga', 'reggae fusion'],
  'hip hop': ['hip hop', 'rap', 'boom bap', 'gangsta rap', 'conscious hip hop', 'east coast hip hop', 'west coast hip hop', 'southern hip hop', 'old school hip hop', 'hardcore hip hop'],
  jazz: ['jazz', 'bebop', 'hard bop', 'cool jazz', 'modal jazz', 'free jazz', 'post bop', 'soul jazz', 'latin jazz', 'vocal jazz', 'smooth jazz', 'swing', 'big band', 'dixieland', 'spiritual jazz', 'avant-garde jazz'],
  blues: ['blues', 'delta blues', 'chicago blues', 'electric blues', 'country blues', 'piedmont blues', 'texas blues'],
  country: ['country', 'outlaw country', 'honky tonk', 'bluegrass', 'alt-country', 'traditional country', 'country pop'],
  metal: ['metal', 'heavy metal', 'thrash metal', 'death metal', 'black metal', 'doom metal', 'power metal', 'speed metal', 'sludge metal', 'progressive metal'],
  punk: ['punk', 'punk rock', 'hardcore punk', 'pop punk', 'oi!'],
  classical: ['classical', 'baroque', 'opera', 'chamber music', 'early music', 'choral', 'contemporary classical', 'orchestral'],
  gospel: ['gospel', 'southern gospel', 'traditional gospel', 'contemporary gospel'],
  house: ['house', 'deep house', 'tech house', 'progressive house', 'acid house', 'funky house', 'chicago house'],
  techno: ['techno', 'minimal techno', 'detroit techno', 'acid techno', 'dub techno'],
  'drum and bass': ['drum and bass', 'jungle', 'liquid funk', 'neurofunk'],
};

// A label's match key. Case, spacing and separators fold away and `&` reads
// as "and", so "Hip-Hop" and "hip hop", "Neo-Soul" and "Neo Soul", "R&B" and
// "R & B", "Synth-Pop" and "Synthpop" each share one key. Only separators
// fold, never spellings: "drum n bass" is not "drum and bass".
function genreKey(label: string): string {
  return sceneKey(label).replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
}

// Family tokens ride in the same map as label keys, so the run logic
// (intersection, overlap) needs no second code path. A label key never holds
// the prefix's colon, so the two cannot collide.
const FAMILY_PREFIX = 'family:';

const FAMILY_OF: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [family, labels] of Object.entries(GENRE_FAMILIES)) {
    for (const label of labels) map.set(genreKey(label), family);
  }
  return map;
})();

/**
 * A track's genre keys, each mapped to the name a prompt or log shows for it:
 * the label as the track spells it, or "<family> family" for a family token.
 */
export type GenreKeys = ReadonlyMap<string, string>;

/**
 * Label keys (separator-folded) plus one `family:<name>` token for each label
 * that sits in a family. Unknown labels contribute only their key. The first
 * spelling of a key names it.
 */
export function genreKeysWithFamilies(labels: readonly unknown[]): GenreKeys {
  const out = new Map<string, string>();
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const name = label.trim().replace(/\s+/g, ' ');
    const key = genreKey(name);
    if (!key) continue;
    if (!out.has(key)) out.set(key, name);
    const family = FAMILY_OF.get(key);
    if (family) out.set(FAMILY_PREFIX + family, `${family} family`);
  }
  return out;
}
