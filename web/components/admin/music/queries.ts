// Admin → Music source: the shared read of GET /settings/music-source (the
// saved selection, the router's status and plugins) and its cache key, used by
// the Source tab and the router views. Nests the activity feed beneath it.

import type { RouterStatus } from '../../../lib/schemas.generated';
import type { SavedSelectionView } from './sourceDraft';

export interface MusicSourceView extends SavedSelectionView {
  routerUrl: string;
  router: RouterStatus | null;
  routerError: string | null;
}

export interface MusicSaveResponse {
  ok: boolean;
  error?: string;
  switched?: boolean;
  reconcile?: 'started' | 'pending' | null;
}

export const MUSIC_SOURCE_KEY = ['music-source'] as const;
/** The tagger snapshot, read here for the re-link progress after a switch. */
export const MUSIC_RELINK_KEY = [...MUSIC_SOURCE_KEY, 'relink'] as const;
