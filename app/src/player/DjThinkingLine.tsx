// The DJ's latest "thinking" — the most recent voice (spoken on-air) or dj
// (pick/request reasoning) turn. Tap to open the full booth transcript.
// Ported from web DjThinkingLine (without the per-character typing animation).

import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import { turnClass, turnText, type TurnDisplayClass } from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

const THINKING_CLASSES = new Set<TurnDisplayClass>(['voice', 'dj']);
const MARKER: Record<string, string> = { voice: '♪', dj: '◇' };

export interface DjThinkingLineProps {
  feed: SessionTurn[] | undefined;
  enabled: boolean;
  onOpenBooth: () => void;
}

export default function DjThinkingLine({ feed, enabled, onOpenBooth }: DjThinkingLineProps) {
  const { colors } = useTheme();
  const latest = useMemo<SessionTurn | null>(() => {
    if (!feed?.length) return null;
    for (let i = feed.length - 1; i >= 0; i--) {
      const turn = feed[i];
      if (turn && THINKING_CLASSES.has(turnClass(turn)) && turn.text) return turn;
    }
    return null;
  }, [feed]);

  if (!enabled || !latest) return null;

  const cls = turnClass(latest);
  const text = turnText(latest);
  const display = cls === 'voice' ? `"${text}"` : text;

  return (
    <Pressable onPress={onOpenBooth} accessibilityRole="button" accessibilityLabel="Open booth feed" className="flex-row mt-5" style={{ gap: 8, maxWidth: '92%' }}>
      <Text className="font-mono text-muted" style={{ fontSize: 14, opacity: 0.7 }}>
        {MARKER[cls] || '·'}
      </Text>
      <Text className="font-mono text-muted flex-1" style={{ fontSize: 14, lineHeight: 22 }}>
        {display}
        <Text style={{ color: colors.accent }}> ▍</Text>
      </Text>
    </Pressable>
  );
}
