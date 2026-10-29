import * as Haptics from 'expo-haptics';
import { Captions, CaptionsOff, Coins, Heart } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import CoverArt from './CoverArt';
import DjThinkingLine from './DjThinkingLine';
import type { TrackLike } from '@/hooks/useTrackLike';
import { fmtTime } from '@/lib/format';
import { isDjTurn } from '@/lib/sessionFeed';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

function buildMetaTokens(t: NowPlayingTrack | null): string[] {
  if (!t) return [];
  const tokens: string[] = [];
  if (t.genre) tokens.push(t.genre.toUpperCase());
  if (typeof t.bpm === 'number' && t.bpm > 0) tokens.push(`${Math.round(t.bpm)} BPM`);
  if (t.musicalKey) tokens.push(t.musicalKey);
  return tokens;
}

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
  /** The Station login for the cover (StationApi.imageHeaders). */
  coverHeaders?: Record<string, string>;
  elapsed: number;
  /** Cumulative since-boot LLM token total (#449); null hides the ticker. */
  llmTokens: number | null;
  trackLike: TrackLike;
  feed: SessionTurn[];
  djLineOn: boolean;
  live: boolean;
  onOpenBooth: () => void;
  onOpenTimeline: () => void;
  /** This device's lyrics choice, for the button beside the heart: shown
   *  whenever the station offers lyrics, so they can be turned back on from
   *  where they were. Absent while the station has lyrics off. */
  lyrics?: { shown: boolean; onOpen: () => void } | null;
  /** Lyrics are showing below (StageLyrics), so the track info shrinks to one
   *  row: a 64px cover beside the clock, a one-line title and the artist. It
   *  drops the album, year, tags, token count, "Now playing" label and DJ
   *  line, as the Classic skin does on a phone. */
  compact?: boolean;
}

export default function CenterStage({
  nowPlaying,
  coverSrc,
  coverHeaders,
  elapsed,
  llmTokens,
  trackLike,
  feed,
  djLineOn,
  live,
  onOpenBooth,
  onOpenTimeline,
  lyrics = null,
  compact = false,
}: CenterStageProps) {
  const { colors } = useTheme();
  const has = !!nowPlaying?.title;
  const duration = nowPlaying?.duration ?? 0;
  const subsonicId = nowPlaying?.subsonic_id ?? null;
  const metaTokens = buildMetaTokens(nowPlaying);
  const moodPhrase = buildMoodPhrase(nowPlaying);
  const hasMeta = metaTokens.length > 0 || moodPhrase.length > 0;

  // SessionTurn.t is a change key; the feed index suffices when it is absent.
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

  const clock = has ? (duration ? `${fmtTime(elapsed)} / ${fmtTime(duration)}` : fmtTime(elapsed)) : '';
  // The compact row is plainly the track on air, and the label would push the
  // clock off a narrow phone.
  const caption = compact ? clock : `NOW PLAYING${clock ? ` — ${clock}` : ''}`;
  const LyricsIcon = lyrics?.shown ? Captions : CaptionsOff;

  const metaRow = (
    <View className="flex-row items-center" style={{ marginBottom: compact ? 4 : 12, gap: 5 }}>
      <Text className="font-mono text-muted" style={{ fontSize: 11, letterSpacing: 2 }}>
        {caption}
      </Text>
      {llmTokens != null && !compact ? (
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
      {lyrics && has ? (
        <Pressable
          onPress={() => {
            Haptics.selectionAsync().catch(() => {});
            lyrics.onOpen();
          }}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={lyrics.shown ? 'Lyrics settings' : 'Lyrics settings, lyrics hidden'}
          className="flex-row items-center"
          style={{ gap: 3 }}
        >
          <Text className="font-mono text-muted" style={{ fontSize: 11 }}>·</Text>
          <LyricsIcon size={14} color={lyrics.shown ? colors.ink : colors.muted} strokeWidth={1.75} />
        </Pressable>
      ) : null}
    </View>
  );

  if (compact && has) {
    return (
      <View className="flex-row items-center px-5" style={{ gap: 14, paddingTop: 12 }}>
        {coverSrc ? (
          <CoverArt uri={coverSrc} headers={coverHeaders} live={live} burst={burst} size={64} onPress={onOpenTimeline} />
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          {metaRow}
          <Text
            className="font-display text-ink"
            style={{ fontSize: 20, lineHeight: 24 }}
            numberOfLines={1}
          >
            {nowPlaying?.title}
          </Text>
          <Text className="font-body-medium text-ink" style={{ fontSize: 14, marginTop: 2 }} numberOfLines={1}>
            {nowPlaying?.artist || 'Unknown artist'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 justify-center px-5">
      {coverSrc ? (
        <View style={{ alignItems: 'flex-start', marginBottom: 14 }}>
          <CoverArt uri={coverSrc} headers={coverHeaders} live={live} burst={burst} size={120} onPress={onOpenTimeline} />
        </View>
      ) : null}

      {metaRow}

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
