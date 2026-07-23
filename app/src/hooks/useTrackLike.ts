// The heart button's state machine (#991) — native port of the web
// useTrackLike (web/components/skins/sharedHooks.ts): refresh liked-state when
// the on-air track changes, fill on tap, settle on the controller's answer.
// The web hook reads its client from context; the native app threads the
// runtime StationApi through props, so it arrives as an argument here.

import { useCallback, useEffect, useState } from 'react';
import type { StationApi } from '@/lib/api';

export interface TrackLike {
  /** Likes are enabled on this station AND a likeable track is on air (jingles
   *  and spoken segments carry no id). The UI hides the heart when false. */
  available: boolean;
  /** This listener already liked the current airing (server-side dedup — no
   *  account, keyed on a hash of the connection). */
  liked: boolean;
  /** Total likes for the current song, all airings. */
  count: number;
  pending: boolean;
  /** Like the current track. No-op while unavailable, pending, or liked. */
  like: () => Promise<void>;
}

export function useTrackLike(api: StationApi | null, songId: string | null): TrackLike {
  // enabled starts false ("unknown") so stations with likes off never flash a
  // heart; the first status fetch flips it on.
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<{ songId: string | null; liked: boolean; count: number }>({
    songId: null,
    liked: false,
    count: 0,
  });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ songId, liked: false, count: 0 });
    if (!api || !songId) return;
    api.likeStatus().then((st) => {
      if (cancelled || !st) return;
      setEnabled(st.enabled !== false);
      // Only apply if the answer is about the track we asked for — a status
      // that raced a track change would paint the wrong liked-state.
      if (st.songId && st.songId !== songId) return;
      setState({ songId, liked: !!st.liked, count: st.count ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [api, songId]);

  const like = useCallback(async () => {
    if (!api || !songId || pending || (state.liked && state.songId === songId)) return;
    setPending(true);
    try {
      const res = await api.likeCurrent(songId);
      if (res && (res.ok || res.alreadyLiked)) {
        setState({ songId, liked: true, count: res.count ?? 0 });
      }
    } finally {
      setPending(false);
    }
  }, [api, songId, pending, state.liked, state.songId]);

  return {
    available: enabled && !!songId,
    liked: state.liked && state.songId === songId,
    count: state.songId === songId ? state.count : 0,
    pending,
    like,
  };
}
