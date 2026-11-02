// Why the Last.fm track tags control can't be used right now, or null when it
// can. Track tags read Last.fm directly, so unlike the Last.fm tags control they
// have no keyless path. `lastfmTagsOn` is the form's value, not the controller's
// auto default, because it is what the next save will write: a track-tag opt-in
// saved beside an explicit off would do nothing.
export function lastfmTrackTagsBlocker(keySet: boolean, lastfmTagsOn: boolean): string | null {
  if (!keySet) return 'Needs an API key';
  if (!lastfmTagsOn) return 'Needs Last.fm tags on';
  return null;
}
