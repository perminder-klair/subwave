// The Listeners → Last.fm card's status lines: the subtitle and the tags banner.
//
// Both describe what is SAVED, never the draft in the form. A typed replacement
// key, or Enabled flipped without saving, changes nothing until Save, so it must
// change neither line (#2316). And both come from this one reading, so the
// subtitle can never say one thing about Last.fm tags while the banner under it
// says another.
//
// Tags need only the API key (settings or LASTFM_API_KEY); scrobbling needs
// Enabled plus the key, secret and session key. The tagger's own switch
// (Library tagger → Advanced → Enrichment, `embedding.enrichment.lastfmTags`) can
// veto the key: false is off, true is on, and null is Auto, which follows the key.
import type { ScrobbleLastfmForm } from './shared';
import { lastfmTagsEnabled } from './lastfm-track-tags';

/** What Last.fm tags do with the saved key: no key, fetching, or vetoed off. */
export type LastfmTagsStatus = 'no-key' | 'on' | 'off';

export interface LastfmCardStatus {
  tags: LastfmTagsStatus;
  /** The card subtitle. */
  subtitle: string;
  /** The tags banner's label, after "Last.fm tags · ". */
  bannerLabel: string;
}

export function lastfmCardStatus(
  savedLf: Partial<ScrobbleLastfmForm>,
  env: Record<string, unknown>,
  savedLastfmTags: boolean | null | undefined,
): LastfmCardStatus {
  const keySet = savedLf.apiKey === 'set' || !!env.LASTFM_API_KEY;
  const secretSet = savedLf.apiSecret === 'set' || !!env.LASTFM_API_SECRET;
  const sessionSet = savedLf.sessionKey === 'set' || !!env.LASTFM_SESSION_KEY;
  const enabled = !!savedLf.enabled;
  const scrobbling = enabled && keySet && secretSet && sessionSet;

  // Without a key nothing reaches Last.fm, whatever the setting says (On then
  // falls back to Navidrome's getArtistInfo2, which is not Last.fm's API).
  const tags: LastfmTagsStatus = !keySet
    ? 'no-key'
    : lastfmTagsEnabled(savedLastfmTags ?? null, true) ? 'on' : 'off';

  let subtitle: string;
  if (scrobbling) {
    subtitle = `scrobbling as ${savedLf.username || '(unknown)'}`;
    if (tags === 'off') subtitle += ', but Last.fm tags is off';
  } else if (tags === 'no-key') {
    subtitle = enabled ? 'enabled, but missing credentials' : 'not set up';
  } else if (tags === 'off') {
    subtitle = enabled
      ? 'key set, but Last.fm tags is off and scrobbling is missing credentials'
      : 'key set, but Last.fm tags is off';
  } else {
    subtitle = enabled
      ? 'key set, tags only, scrobbling is missing credentials'
      : 'key set, tags only, not scrobbling';
  }

  const bannerLabel = tags === 'off' ? 'off' : tags === 'on' ? 'key set' : 'no key';
  return { tags, subtitle, bannerLabel };
}
