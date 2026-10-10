import { useMemo } from 'react';
import { Pressable, Text, useWindowDimensions } from 'react-native';
import { selectThinkingTurn, turnClass, turnText } from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

const MARKER: Record<string, string> = { voice: '♪', dj: '◇' };

export interface DjThinkingLineProps {
  feed: SessionTurn[] | undefined;
  enabled: boolean;
  // Pick turns refer to the NEXT song; filter other track ids (#546).
  currentTrackId?: string | null;
  onOpenBooth: () => void;
}

export default function DjThinkingLine({ feed, enabled, currentTrackId = null, onOpenBooth }: DjThinkingLineProps) {
  const { colors } = useTheme();
  // This column has no overflow clip; limit the teaser to protect the waveform (#576).
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
