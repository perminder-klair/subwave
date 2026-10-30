// Admin → Music sources: the one server resource every tab reads
// (GET /settings/music-source) and the Monitor's live feed under it.

import type { RouterStatus } from '../../../lib/schemas.generated';
import type { SavedSelectionView } from '../music/sourceDraft';

export const MUSIC_SOURCE_KEY = ['music-source'] as const;
/** The Signal path feed, polled only while the Monitor tab is open. */
export const ROUTER_ACTIVITY_KEY = [...MUSIC_SOURCE_KEY, 'activity'] as const;

/** The station's own Navidrome connection. The password never leaves the controller. */
export interface StationNavidromeView {
  url: string;
  user: string;
  passSet: boolean;
  env: { url: boolean; user: boolean; pass: boolean };
}

/** The router is down and the station plays its Navidrome directly (music/source-failover.ts). */
export interface FailoverView {
  active: boolean;
  since: string | null;
  reason: string | null;
  /** The selection has a direct stand-in: the station's Navidrome alone. */
  eligible: boolean;
}

export interface MusicSourceView extends SavedSelectionView {
  routerUrl: string;
  router: RouterStatus | null;
  routerError: string | null;
  navidrome: StationNavidromeView;
  failover: FailoverView;
}

export interface SaveResponse {
  ok: boolean;
  error?: string;
  switched?: boolean;
  reconcile?: 'started' | 'pending' | null;
}

export const navidromeReady = (nv: StationNavidromeView | undefined) =>
  Boolean(nv && (nv.url || nv.env.url) && (nv.user || nv.env.user) && (nv.passSet || nv.env.pass));
