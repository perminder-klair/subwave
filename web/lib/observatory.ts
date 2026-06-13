'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  layoutTracks,
  buildMockLibrary,
  type LibraryData,
  type RawTrack,
  type ObservatoryStats,
  type TrackDetail,
} from '../components/observatory/data';

type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface ObservatoryResult {
  data: LibraryData | null;
  loading: boolean;
  error: string | null;
}

interface BulkResponse {
  tracks: RawTrack[];
  truncated: boolean;
  max: number;
  moodVocab: string[];
  stats: ObservatoryStats;
}

// Loads the whole tagged library once, lays it out by genre cluster, and falls
// back to a seeded mock when the library is empty (fresh install) so the view
// is never blank. `enabled` gates the fetch on admin auth being ready.
export function useObservatory(adminFetch: AdminFetch, enabled: boolean): ObservatoryResult {
  const [data, setData] = useState<LibraryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await adminFetch('/library/observatory');
        if (!res.ok) throw new Error(`controller error (${res.status})`);
        const body = (await res.json()) as BulkResponse;
        if (cancelled) return;
        if (!body.tracks || body.tracks.length === 0) {
          setData(buildMockLibrary());
        } else {
          const { tracks, genres, centers } = layoutTracks(body.tracks);
          setData({
            tracks,
            genres,
            centers,
            stats: body.stats,
            moodVocab: body.moodVocab || [],
            truncated: !!body.truncated,
            mock: false,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load library');
        // Still render something useful rather than a dead screen.
        setData(buildMockLibrary());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adminFetch, enabled]);

  return { data, loading, error };
}

// Lazily fetches the rich per-track dossier (full record + embeddings +
// mix-next). Cached in-memory for the session so re-opening a node is instant.
export function useTrackDetail(adminFetch: AdminFetch) {
  const cache = useRef<Map<string, TrackDetail>>(new Map());
  const [detail, setDetail] = useState<TrackDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const fetchDetail = useCallback(
    async (id: string | null) => {
      if (!id) {
        setDetail(null);
        setLoadingId(null);
        return;
      }
      const cached = cache.current.get(id);
      if (cached) {
        setDetail(cached);
        setLoadingId(null);
        return;
      }
      setDetail(null);
      setLoadingId(id);
      try {
        const res = await adminFetch(`/library/observatory/track/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as TrackDetail;
        cache.current.set(id, body);
        // Only commit if the user hasn't moved on to another node meanwhile.
        setLoadingId((cur) => {
          if (cur === id) setDetail(body);
          return cur === id ? null : cur;
        });
      } catch {
        setLoadingId((cur) => (cur === id ? null : cur));
      }
    },
    [adminFetch],
  );

  return { detail, loadingId, fetchDetail };
}
