// A small built-in family map for the genre-run guard. Two genre labels count
// as one genre when they match (after the operator's scene aliases) or when
// both sit in the same family below. A label in no family only ever matches
// itself.
//
// Keep this list SMALL and obviously correct. A family groups labels that a
// listener hears as one genre family in a run of tracks. It does not try to
// be a taxonomy. When a label is arguable (trip hop, jazz fusion, blues rock,
// post-punk, country rock), leave it out: an unlisted label simply falls back
// to exact label overlap. Entries are matched through `sceneKey`, so case and
// repeated spaces do not matter.
import { aliasValue, sceneKey, type SceneAliasMap } from '../../music/scene-vocab.js';

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
  'drum and bass': ['drum and bass', 'drum & bass', 'jungle', 'liquid funk', 'neurofunk'],
};

// Family tokens ride in the same Set as label keys, so the run logic
// (intersection, overlap) needs no second code path. The prefix marks them.
export const FAMILY_PREFIX = 'family:';

const FAMILY_OF: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [family, labels] of Object.entries(GENRE_FAMILIES)) {
    for (const label of labels) map.set(sceneKey(label), family);
  }
  return map;
})();

/** The family a normalized label key belongs to, or null. */
export function genreFamilyOf(labelKey: string): string | null {
  return FAMILY_OF.get(sceneKey(labelKey)) ?? null;
}

/**
 * Label keys (alias-resolved, normalized) plus one `family:<name>` token for
 * each label that sits in a family. Unknown labels contribute only their key.
 */
export function genreKeysWithFamilies(labels: readonly unknown[], aliases: SceneAliasMap): Set<string> {
  const out = new Set<string>();
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const key = sceneKey(aliasValue(label, aliases));
    if (!key) continue;
    out.add(key);
    const family = FAMILY_OF.get(key);
    if (family) out.add(FAMILY_PREFIX + family);
  }
  return out;
}

/** A run key for prompts and logs: `family:reggae` reads as `reggae family`. */
export function describeRunKey(key: string): string {
  return key.startsWith(FAMILY_PREFIX) ? `${key.slice(FAMILY_PREFIX.length)} family` : key;
}
