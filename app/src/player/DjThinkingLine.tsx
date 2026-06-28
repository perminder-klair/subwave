// The DJ's latest "thinking" — the most recent voice (spoken on-air) or dj
// (pick/request reasoning) turn. Tap to open the full booth transcript.
// Ported from web DjThinkingLine (without the per-character typing animation).

import { useMemo } from 'react';
import { Pressable, Text, useWindowDimensions } from 'react-native';
import { selectThinkingTurn, turnClass, turnText } from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

const MARKER: Record<string, string> = { voice: '♪', dj: '◇' };

export interface DjThinkingLineProps {
  feed: SessionTurn[] | undefined;
  enabled: boolean;
  // Subsonic id of the track on air. A `dj`/pick turn's `meta.trackId` is the
  // *picked* (next) song, so we skip pick reasoning that isn't about the
  // current track — otherwise the line shows the upcoming pick (#546).
  currentTrackId?: string | null;
  onOpenBooth: () => void;
}

export default function DjThinkingLine({ feed, enabled, currentTrackId = null, onOpenBooth }: DjThinkingLineProps) {
  const { colors } = useTheme();
  // Clamp the inline teaser so long "extended" scripts can't grow the column and
  // spill down over the waveform (web issue #576 — there it's line-clamp-2 →
  // line-clamp-6 on tall viewports). RN has no overflow clip in this column, so an
  // unclamped script overflows CenterStage's centred flex-1 onto the Waveform
  // below. Mirror the web breakpoint: 6 lines on tall screens, 3 on short ones.
  // The full text stays one tap away in the Booth.
  const { height } = useWindowDimensions();
  const maxLines = height >= 760 ? 6 : 3;
  // The DJ turn relevant to what's ON AIR now — see selectThinkingTurn (#546).
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
