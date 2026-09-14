// The DJ's latest "thinking": the most recent voice or dj turn. Tap to open
// the full booth transcript.

import { useMemo } from 'react';
import { Pressable, Text, useWindowDimensions } from 'react-native';
import { selectThinkingTurn, turnClass, turnText } from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

const MARKER: Record<string, string> = { voice: '♪', dj: '◇' };

export interface DjThinkingLineProps {
  feed: SessionTurn[] | undefined;
  enabled: boolean;
  // Subsonic id of the on-air track. A pick turn's `meta.trackId` is the NEXT
  // song, so pick reasoning for another track is skipped (#546).
  currentTrackId?: string | null;
  onOpenBooth: () => void;
}

export default function DjThinkingLine({ feed, enabled, currentTrackId = null, onOpenBooth }: DjThinkingLineProps) {
  const { colors } = useTheme();
  // Clamp the teaser (#576): this column has no overflow clip, so a long
  // script spills over the waveform below. 6 lines on tall screens, 3 on
  // short; the full text is one tap away in the Booth.
  const { height } = useWindowDimensions();
  const maxLines = height >= 760 ? 6 : 3;
  const latest = useMemo<SessionTurn | null>(
    () => selectThinkingTurn(feed, currentTrackId),
    [feed, currentTrackId],
  );

  if (!enabled || !latest) return null;

  const cls = turnClass(latest);
  const text = turnText(latest);
  const display = cls === 'voice' ? `"${text}"` : text;

  return (
    <Pressable onPress={onOpenBooth} accessibilityRole="button" accessibilityLabel="Open booth feed" className="flex-row mt-5" style={{ gap: 8, maxWidth: '92%' }}>
      <Text className="font-mono text-muted" style={{ fontSize: 14, opacity: 0.7 }}>
        {MARKER[cls] || '·'}
      </Text>
      <Text
        className="font-mono text-muted flex-1"
        style={{ fontSize: 14, lineHeight: 22 }}
        numberOfLines={maxLines}
        ellipsizeMode="tail"
      >
        {display}
        <Text style={{ color: colors.accent }}> ▍</Text>
      </Text>
    </Pressable>
  );
}
