// The now-playing card: cover art (tap → timeline), track meta, elapsed /
// duration, and the DJ thinking ticker. Ported from web CenterStage for a
// phone column; the cover "glitch" CSS effects are dropped in favour of a
// clean cross-fade (expo-image handles the fade on src change).

import { Image } from 'expo-image';
import { Pressable, Text, View } from 'react-native';
import DjThinkingLine from './DjThinkingLine';
import { fmtTime } from '@/lib/format';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

export interface CenterStageProps {
  nowPlaying: NowPlayingTrack | null;
  coverSrc: string | null;
  elapsed: number;
  feed: SessionTurn[];
  djLineOn: boolean;
  onOpenBooth: () => void;
  onOpenTimeline: () => void;
}

export default function CenterStage({
  nowPlaying,
  coverSrc,
  elapsed,
  feed,
  djLineOn,
  onOpenBooth,
  onOpenTimeline,
}: CenterStageProps) {
  const { colors } = useTheme();
  const has = !!nowPlaying?.title;
  const duration = nowPlaying?.duration ?? 0;

  const elapsedLabel = has
    ? duration
      ? ` — ${fmtTime(elapsed)} / ${fmtTime(duration)}`
      : ` — ${fmtTime(elapsed)}`
    : '';

  return (
    <View className="flex-1 justify-center px-5">
      {coverSrc ? (
        <Pressable onPress={onOpenTimeline} className="mb-7">
          <Image
            source={{ uri: coverSrc }}
            style={{
              width: 168,
              height: 168,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: colors.softBorder,
            }}
            contentFit="cover"
            transition={280}
          />
        </Pressable>
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
