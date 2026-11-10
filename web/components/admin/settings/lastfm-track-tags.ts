// The Library → Enrichment Last.fm controls' rules.
//
// Last.fm tags is tri-state, like `embedding.enrichment.lastfmTags`: true always
// fetches, false never does, and null is auto, on when a Last.fm key is set. The
// form keeps null as its own Auto choice. Loading it as off made every Library
// save write false, which stopped enrichment on a keyed install (#2233).
export type LastfmTagsChoice = 'auto' | 'off' | 'on';

export const lastfmTagsChoice = (value: boolean | null): LastfmTagsChoice =>
  value === null ? 'auto' : value ? 'on' : 'off';

export const lastfmTagsFromChoice = (choice: string): boolean | null =>
  choice === 'auto' ? null : choice === 'on';

// What the setting does with the key the form can see: the twin of the
// controller's lastfm.lastfmEnrichEnabled.
export function lastfmTagsEnabled(value: boolean | null, keySet: boolean): boolean {
  return value === true || (value !== false && keySet);
}

// Why the Last.fm track tags control can't be used right now, or null when it
// can. Track tags read Last.fm directly, so unlike the Last.fm tags control they
// have no keyless path. `lastfmTags` is the form's value, because it is what the
// next save will write: a track-tag opt-in saved beside an explicit off would do
// nothing. Auto passes, since the key it turns on with is checked first.
export function lastfmTrackTagsBlocker(keySet: boolean, lastfmTags: boolean | null): string | null {
  if (!keySet) return 'Needs an API key';
  if (lastfmTags === false) return 'Needs Last.fm tags on';
  return null;
}
