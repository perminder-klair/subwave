// The now-playing card: cover art (tap → timeline), track meta, elapsed /
// duration, and the DJ thinking ticker. Ported from web CenterStage for a
// phone column. The cover glitches + shows corner ticks during a ~3s `burst`
// opened by a track change or a new DJ turn (the web's `.v3-cover-live`).

import * as Haptics from 'expo-haptics';
import { Coins, Heart } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import CoverArt from './CoverArt';
import DjThinkingLine from './DjThinkingLine';
import type { TrackLike } from '@/hooks/useTrackLike';
import { fmtTime } from '@/lib/format';
import { isDjTurn } from '@/lib/sessionFeed';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

/** The quiet "music nerd" tokens shown under artist/album: genre · BPM · key.
 *  Each token is omitted when its field is absent, so an untagged track yields
 *  an empty array and the strip doesn't render. Mirrors web CenterStage. */
function buildMetaTokens(t: NowPlayingTrack | null): string[] {
  if (!t) return [];
  const tokens: string[] = [];
  if (t.genre) tokens.push(t.genre.toUpperCase());
  if (typeof t.bpm === 'number' && t.bpm > 0) tokens.push(`${Math.round(t.bpm)} BPM`);
  if (t.musicalKey) tokens.push(t.musicalKey);
  return tokens;
}

/** The mood/energy phrase, e.g. "MELLOW · LOW ENERGY". Up to two moods plus the
 *  energy level; empty string when the track carries neither. */
function buildMoodPhrase(t: NowPlayingTrack | null): string {
  if (!t) return '';
  const parts: string[] = [];
  if (Array.isArray(t.moods)) parts.push(...t.moods.slice(0, 2));
  if (t.energy) parts.push(`${t.energy} energy`);
  return parts.join(' · ').toUpperCase();
}

export interface CenterStageProps {
  nowPlaying: NowPlayingTrack | null;
  coverSrc: string | null;
  elapsed: number;
  /** Cumulative since-boot LLM token total — the quiet "cost of the DJ" ticker
   *  by the now-playing time (web #449). null hides it. */
  llmTokens: number | null;
  /** Listener like state for the on-air track (#991) — the heart lives in the
   *  same caption row as on the web classic skin, and hides itself when likes
   *  are off or nothing likeable is on air. */
  trackLike: TrackLike;
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
  llmTokens,
  trackLike,
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
  const metaTokens = buildMetaTokens(nowPlaying);
  const moodPhrase = buildMoodPhrase(nowPlaying);
  const hasMeta = metaTokens.length > 0 || moodPhrase.length > 0;

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
        <View style={{ alignItems: 'flex-start', marginBottom: 14 }}>
          <CoverArt uri={coverSrc} live={live} burst={burst} size={120} onPress={onOpenTimeline} />
        </View>
      ) : null}

      <View className="flex-row items-center" style={{ marginBottom: 12, gap: 5 }}>
        <Text className="font-mono text-muted" style={{ fontSize: 11, letterSpacing: 2 }}>
          NOW PLAYING{elapsedLabel}
        </Text>
        {llmTokens != null ? (
          <View
            className="flex-row items-center"
            style={{ gap: 3 }}
            accessible
            accessibilityLabel={`${llmTokens.toLocaleString('en-US')} AI tokens generated`}
          >
            <Text className="font-mono text-muted" style={{ fontSize: 11 }}>·</Text>
            <Coins size={11} color={colors.muted} strokeWidth={1.75} />
            <Text className="font-mono text-muted" style={{ fontSize: 11 }}>
              {llmTokens.toLocaleString('en-US')}
            </Text>
          </View>
        ) : null}
        {trackLike.available ? (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              void trackLike.like();
            }}
            disabled={trackLike.pending || trackLike.liked}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityState={{ disabled: trackLike.pending || trackLike.liked, selected: trackLike.liked }}
            accessibilityLabel={trackLike.liked ? 'Liked' : 'Like this track'}
            className="flex-row items-center"
            style={{ gap: 3, opacity: trackLike.pending ? 0.6 : 1 }}
          >
            <Text className="font-mono text-muted" style={{ fontSize: 11 }}>·</Text>
            <Heart
              size={13}
              color={trackLike.liked ? colors.accent : colors.muted}
              fill={trackLike.liked ? colors.accent : 'none'}
              strokeWidth={1.75}
            />
            {trackLike.count > 0 ? (
              <Text
                className="font-mono"
                style={{ fontSize: 11, color: trackLike.liked ? colors.accent : colors.muted }}
              >
                {trackLike.count}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
      </View>

      {has ? (
        <>
          <Text className="font-display text-ink" style={{ fontSize: 26, lineHeight: 30 }}>
            {nowPlaying?.title}
          </Text>
          <Text className="font-body-medium mt-1" style={{ fontSize: 15, color: colors.muted }}>
            <Text style={{ color: colors.ink }}>{nowPlaying?.artist || 'Unknown artist'}</Text>
            {nowPlaying?.album ? `  ·  ${nowPlaying.album}` : ''}
            {nowPlaying?.year ? `  ·  ${nowPlaying.year}` : ''}
          </Text>
          {hasMeta ? (
            <Text
              className="font-mono mt-2"
              style={{ fontSize: 11, letterSpacing: 1.5, color: colors.muted }}
            >
              {metaTokens.join(' · ')}
              {moodPhrase ? (
                <Text style={{ color: colors.accent }}>
                  {metaTokens.length > 0 ? ' · ' : ''}↳ {moodPhrase}
                </Text>
              ) : null}
            </Text>
          ) : null}
        </>
      ) : (
        <Text className="font-display text-muted" style={{ fontSize: 26, lineHeight: 30 }}>
          scanning the dial_
        </Text>
      )}

      {has ? (
        <DjThinkingLine feed={feed} enabled={djLineOn} currentTrackId={subsonicId} onOpenBooth={onOpenBooth} />
      ) : null}
    </View>
  );
}
