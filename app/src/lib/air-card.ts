// What the now-playing strip says, for surfaces OUTSIDE the app's own UI.
//
// The lock screen / CarPlay / Android Auto (useNowPlayingInfo) and the Live
// Activity (useLiveActivity) must show the same thing — a listener glancing at
// a watch and then at a car dash should not see two different answers. The one
// non-obvious rule they share: while the DJ is talking the ARTIST slot and the
// artwork swap to the persona, but the TITLE keeps the track. The song has not
// changed, and blanking its name mid-link is how you lose the track someone was
// about to look up.

import type { StationApi } from './api';
import type { ActiveShow, NowPlayingTrack } from './types';

export interface AirCard {
  title: string;
  artist: string;
  album: string;
  /** Absolute URL of the cover, or of the persona avatar while talking. */
  artworkUrl: string | undefined;
  /** Stable cache key for that artwork — the subsonic id, or the avatar path.
   *  Only surfaces that cache artwork to disk (the Live Activity) need it. */
  artworkKey: string | null;
  /** Scheduled show name, when one is on. */
  show: string | null;
  /** The artwork above is the persona's, not the track's. */
  showingPersona: boolean;
}

export function resolveAirCard(params: {
  api: StationApi;
  nowPlaying: NowPlayingTrack | null | undefined;
  activeShow: ActiveShow | null | undefined;
  talking: boolean;
}): AirCard {
  const { api, nowPlaying, activeShow, talking } = params;
  const personaName = activeShow?.persona?.name ?? null;
  const personaAvatar = activeShow?.persona?.avatar ?? null;

  const coverUrl = nowPlaying?.subsonic_id ? api.cover(nowPlaying.subsonic_id) : undefined;
  const avatarUrl = personaAvatar ? api.avatar(personaAvatar) : undefined;
  const showingPersona = talking && !!avatarUrl;

  return {
    title: nowPlaying?.title || 'SUB/WAVE',
    artist: showingPersona
      ? personaName || nowPlaying?.artist || 'Live broadcast'
      : nowPlaying?.artist || 'Live broadcast',
    album: nowPlaying?.album || 'SUB/WAVE',
    artworkUrl: showingPersona ? avatarUrl : coverUrl,
    artworkKey: showingPersona ? personaAvatar : nowPlaying?.subsonic_id ?? null,
    show: activeShow?.name ?? null,
    showingPersona,
  };
}
