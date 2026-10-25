// The Live page's lyrics, the app's port of the Classic skin's
// (web/components/skins/classic/AmbientLyrics.tsx) in its phone layout: the
// track info shrinks to one row (CenterStage's compact form) and the lyrics
// fill everything between it and the waveform.
//
// Synced lines are one column that glides so the line being sung holds the
// centre, a fifth larger, while the lines around it fade, those already sung
// more than those to come. Words light up as they are sung, the newest in the
// accent, paced by lyricMoment() (LRC times lines, not words). An intro or an
// instrumental break centres the line to come, at rest. Untimed lyrics take
// the same place, every line at rest, to scroll by hand. Motion is transform
// and opacity on the native driver, so no line ever reflows; under Reduce
// Motion both cut.
//
// RN has no mask-image, and a colour overlay would not match the cover tint
// behind the page, so the column's top and bottom fade is each line's own
// opacity, falling off with its distance from the centre.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useLyricClock, type TrackLyrics } from '@/hooks/useTrackLyrics';
import { lyricFocusLine, lyricMoment, syncedLyricsReady } from '@/lib/lyrics';
import type { PublicLyricsPayload } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

const EASE = Easing.bezier(0.3, 0.7, 0.2, 1);

// The sung line grows by GROW from its left edge, so every line wraps at
// 1/GROW of the column and the grown one still fits.
const GROW = 1.2;
const LINE_WIDTH = `${Math.floor(100 / GROW)}%` as const;

// The display face by name: className is not wired through Animated.Text.
const FONT_FAMILY = 'Fraunces_600SemiBold';
const FONT_SIZE = 19;
// A little looser than the web's 1.05, to leave the display face's ascenders
// room in RN's exact line box. Check on a device before tightening it.
const LINE_HEIGHT = 23;
// Synced lines stand apart, one moment each; untimed ones sit closer, read
// as a page.
const SYNCED_GAP = 8;
const PLAIN_GAP = 4;

// Lines already sung fade further than those to come.
const PAST = 0.28;
const AHEAD = 0.45;
// The share of the column's half-height, either side of the centre, that is
// fully opaque before lines fade out toward the edge (the web's 22%/78% mask).
const CLEAR = 0.56;

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (!cancelled) setReduce(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return reduce;
}

function Words({ text, lit, front }: { text: string; lit: number; front: boolean }) {
  const { colors } = useTheme();
  // Split on spaces but keep them, so wrapping sees the real text; each word
  // part carries its place among the words. Nested Text takes no opacity, and
  // a theme colour may be rgb(), so unsung words wear the muted ink.
  const parts: { part: string; index: number }[] = [];
  let words = 0;
  for (const part of text.split(/(\s+)/)) parts.push({ part, index: part.trim() ? words++ : -1 });
  return (
    <>
      {parts.map(({ part, index }, i) => {
        if (index < 0) return part;
        const newest = front && index === lit - 1;
        const color = newest ? colors.accent : index < lit ? colors.ink : colors.muted;
        return (
          <Text key={i} style={{ color }}>
            {part}
          </Text>
        );
      })}
    </>
  );
}

type Tone = 'past' | 'sung' | 'ahead';

/** One line of the column. Memoized: on each tick only the sung line changes. */
const Line = memo(function Line({
  index,
  text,
  tone,
  lit,
  front,
  fade,
  calm,
  onMeasure,
}: {
  index: number;
  text: string;
  tone: Tone;
  lit: number;
  front: boolean;
  /** 0 to 1: how far inside the column's clear middle the line sits. */
  fade: number;
  calm: boolean;
  onMeasure: (index: number, centre: number) => void;
}) {
  const { colors } = useTheme();
  const opacityTo = (tone === 'past' ? PAST : tone === 'ahead' ? AHEAD : 1) * fade;
  const scaleTo = tone === 'sung' ? GROW : 1;
  const [opacity] = useState(() => new Animated.Value(opacityTo));
  const [scale] = useState(() => new Animated.Value(scaleTo));

  useEffect(() => {
    if (calm) {
      opacity.setValue(opacityTo);
      scale.setValue(scaleTo);
      return;
    }
    const run = Animated.parallel([
      Animated.timing(opacity, { toValue: opacityTo, duration: 500, easing: EASE, useNativeDriver: true }),
      Animated.timing(scale, { toValue: scaleTo, duration: 500, easing: EASE, useNativeDriver: true }),
    ]);
    run.start();
    return () => run.stop();
  }, [calm, opacity, opacityTo, scale, scaleTo]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    onMeasure(index, y + height / 2);
  };

  return (
    <View onLayout={onLayout} style={{ paddingVertical: SYNCED_GAP }}>
      <Animated.Text
        style={{
          width: LINE_WIDTH,
          fontFamily: FONT_FAMILY,
          fontSize: FONT_SIZE,
          lineHeight: LINE_HEIGHT,
          color: colors.ink,
          opacity,
          transform: [{ scale }],
          transformOrigin: 'left center',
        }}
      >
        {tone === 'sung' ? <Words text={text} lit={lit} front={front} /> : text}
      </Animated.Text>
    </View>
  );
});

/** Synced lyrics: the column glides to keep the line in focus at its centre. */
function SyncedColumn({
  lyrics,
  positionMs,
  calm,
}: {
  lyrics: PublicLyricsPayload;
  positionMs: number;
  calm: boolean;
}) {
  const { lines } = lyrics;
  const moment = lyricMoment(lyrics, positionMs);
  const focus = lyricFocusLine(lyrics, moment, positionMs);
  const sung = moment.current >= 0 ? lines[moment.current] : null;
  const wordCount = sung ? sung.text.split(/\s+/).filter(Boolean).length : 0;
  const lit = calm ? wordCount : Math.max(1, Math.ceil(moment.progress * wordCount));

  const [height, setHeight] = useState(0);
  const onContainerLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setHeight((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
  };

  // Each line's centre within the column, measured, so a line of any length
  // can take the centre. Scale never changes layout, so these hold until the
  // column's width changes; new lines remount the column (StageLyrics keys
  // it).
  const [centres, setCentres] = useState<number[]>([]);
  const pending = useRef<number[]>([]);
  const onMeasure = useCallback((index: number, centre: number) => {
    pending.current[index] = centre;
    setCentres((prev) => (prev[index] === centre ? prev : [...pending.current]));
  }, []);
  const measured = centres.length === lines.length && centres.every((c) => typeof c === 'number');

  const [y] = useState(() => new Animated.Value(0));
  const [shown] = useState(() => new Animated.Value(0));
  const placed = useRef(false);
  const target = -(centres[focus] ?? 0);
  useEffect(() => {
    if (!measured) return;
    // The first placement is a cut, not a glide in from the top.
    if (!placed.current || calm) {
      placed.current = true;
      y.setValue(target);
      if (calm) shown.setValue(1);
      else Animated.timing(shown, { toValue: 1, duration: 500, easing: EASE, useNativeDriver: true }).start();
      return;
    }
    const run = Animated.timing(y, { toValue: target, duration: 600, easing: EASE, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [measured, target, calm, y, shown]);

  const half = height / 2;
  const focusCentre = centres[focus] ?? 0;
  const fadeFor = (i: number) => {
    if (!measured || half <= 0) return 1;
    const dist = Math.abs((centres[i] ?? 0) - focusCentre);
    return Math.min(1, Math.max(0, (half - dist) / ((1 - CLEAR) * half)));
  };

  return (
    <View
      style={{ flex: 1, overflow: 'hidden' }}
      onLayout={onContainerLayout}
      pointerEvents="none"
      accessible
      accessibilityLabel={sung ? `Lyrics: ${sung.text}` : 'Lyrics'}
    >
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: half,
          opacity: shown,
          transform: [{ translateY: y }],
        }}
      >
        {lines.map((line, i) => {
          const tone: Tone = i === moment.current ? 'sung' : i < focus ? 'past' : 'ahead';
          return (
            <Line
              key={i}
              index={i}
              text={line.text}
              tone={tone}
              lit={tone === 'sung' ? lit : 0}
              front={tone === 'sung' && !calm && moment.progress < 1}
              fade={fadeFor(i)}
              calm={calm}
              onMeasure={onMeasure}
            />
          );
        })}
      </Animated.View>
    </View>
  );
}

/** Untimed lyrics: every line, closer set and readable, to scroll by hand. */
function PlainColumn({ lines }: { lines: { text: string }[] }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingVertical: 24 }}
      showsVerticalScrollIndicator={false}
      accessibilityLabel="Lyrics"
    >
      {lines.map((line, i) =>
        line.text.trim() ? (
          <Text
            key={i}
            style={{
              width: LINE_WIDTH,
              fontFamily: FONT_FAMILY,
              fontSize: FONT_SIZE,
              lineHeight: LINE_HEIGHT,
              paddingVertical: PLAIN_GAP,
              color: colors.ink,
              opacity: 0.7,
            }}
          >
            {line.text}
          </Text>
        ) : (
          <View key={i} style={{ height: 15 }} />
        ),
      )}
    </ScrollView>
  );
}

export interface StageLyricsProps {
  /** PlayerScreen's one answer for this track (useTrackLyrics). */
  track: TrackLyrics;
  trackStartedAt: number | null;
  /** The Live page is on screen and the app in the foreground. */
  running: boolean;
}

export default memo(function StageLyrics({ track, trackStartedAt, running }: StageLyricsProps) {
  const calm = useReduceMotion();
  const positionMs = useLyricClock(track, trackStartedAt, running);
  const { lyrics } = track;
  const synced = syncedLyricsReady(track);
  const lines = useMemo(() => lyrics?.lines ?? [], [lyrics]);

  return (
    <View style={{ flex: 1, paddingHorizontal: 20, marginTop: 8, marginBottom: 12 }}>
      {lyrics && lines.length > 0 ? (
        synced ? (
          // Keyed by track and its lines: a new song fades in, placed at its
          // own start, and is measured afresh.
          <SyncedColumn
            key={`${lyrics.songId ?? ''}:${lines.length}`}
            lyrics={lyrics}
            positionMs={positionMs}
            calm={calm}
          />
        ) : (
          <PlainColumn key={lyrics.songId ?? ''} lines={lines} />
        )
      ) : null}
    </View>
  );
});
