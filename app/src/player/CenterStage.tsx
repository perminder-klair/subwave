// The now-playing card: cover art (tap → timeline), track meta, elapsed /
// duration, and the DJ thinking ticker. Ported from web CenterStage for a
// phone column. The cover glitches + shows corner ticks during a ~3s `burst`
// opened by a track change or a new DJ turn (the web's `.v3-cover-live`).

import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import CoverArt from './CoverArt';
import DjThinkingLine from './DjThinkingLine';
import { fmtTime } from '@/lib/format';
import { isDjTurn } from '@/lib/sessionFeed';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

export interface CenterStageProps {
  nowPlaying: NowPlayingTrack | null;
  coverSrc: string | null;
  elapsed: number;
  feed: SessionTurn[];
  djLineOn: boolean;
  live: boolean;
  onOpenBooth: () => void;
  onOpenTimeline: () => void;
}

export default function CenterStage({
  nowPlaying,
  coverSrc,
  elapsed,
  feed,
  djLineOn,
  live,
  onOpenBooth,
  onOpenTimeline,
}: CenterStageProps) {
  const { colors } = useTheme();
  const has = !!nowPlaying?.title;
  const duration = nowPlaying?.duration ?? 0;
  const subsonicId = nowPlaying?.subsonic_id ?? null;

  // Glitch bursts for ~3s on two signals: every track change (subsonic_id flip)
  // and every new DJ turn (voice/dj) landing in the feed — the native analog of
  // web CenterStage's trackBurst/djBurst. SessionTurn.t is only used for change
  // detection, so any stable identifier works (falls back to the feed index).
  const latestDjTurnT = useMemo<string | number | null>(() => {
    if (!feed?.length) return null;
    for (let i = feed.length - 1; i >= 0; i--) {
      const turn = feed[i];
      if (turn && isDjTurn(turn) && turn.text) return turn.t ?? i;
    }
    return null;
  }, [feed]);

  const [trackBurst, setTrackBurst] = useState(false);
  useEffect(() => {
    if (!subsonicId) return;
    setTrackBurst(true);
    const t = setTimeout(() => setTrackBurst(false), 3000);
    return () => clearTimeout(t);
  }, [subsonicId]);

  const [djBurst, setDjBurst] = useState(false);
  useEffect(() => {
    if (latestDjTurnT == null) return;
    setDjBurst(true);
    const t = setTimeout(() => setDjBurst(false), 3000);
    return () => clearTimeout(t);
  }, [latestDjTurnT]);

  const burst = trackBurst || djBurst;

  const elapsedLabel = has
    ? duration
      ? ` — ${fmtTime(elapsed)} / ${fmtTime(duration)}`
      : ` — ${fmtTime(elapsed)}`
    : '';

  return (
    <View className="flex-1 justify-center px-5">
      {coverSrc ? (
        <View className="mb-8" style={{ alignItems: 'flex-start' }}>
          <CoverArt uri={coverSrc} live={live} burst={burst} size={160} onPress={onOpenTimeline} />
        </View>
      ) : null}

      <Text
        className="font-mono text-muted"
        style={{ fontSize: 11, letterSpacing: 2, marginBottom: 12 }}
      >
        NOW PLAYING{elapsedLabel}
      </Text>

      {has ? (
        <>
          <Text className="font-display text-ink" style={{ fontSize: 34, lineHeight: 38 }}>
            {nowPlaying?.title}
          </Text>
          <Text className="font-body-medium mt-3" style={{ fontSize: 15, color: colors.muted }}>
            <Text style={{ color: colors.ink }}>{nowPlaying?.artist || 'Unknown artist'}</Text>
            {nowPlaying?.album ? `  ·  ${nowPlaying.album}` : ''}
            {nowPlaying?.year ? `  ·  ${nowPlaying.year}` : ''}
          </Text>
        </>
      ) : (
        <Text className="font-display text-muted" style={{ fontSize: 32, lineHeight: 36 }}>
          scanning the dial_
        </Text>
      )}

      {has ? (
        <DjThinkingLine feed={feed} enabled={djLineOn} onOpenBooth={onOpenBooth} />
      ) : null}
    </View>
  );
}
