'use client';

// Drift's lyrics: while a track has synced lines they become the centre of
// the page, and DriftSkin shrinks the cover, title and DJ line around them.
//
// Three lines on one axis: the one just sung fading above, the one being sung
// large, the next waiting faintly below. Opacity only, as everything in Drift
// moves (a transform or filter here would cost the iPad repaints #2062 took
// out), and slower than Classic's: lines dissolve rather than travel. Words
// brighten as they are sung (lyricMoment() paces them; LRC times lines, not
// words). Intros and breaks breathe, with Drift's own `breathe`. Under lite
// mode or reduced motion lines cut and whole lines light at once.

import { memo, useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { cn } from '@/lib/cn';
import { lyricMoment, useCurrentLyrics, useLingeringPresence } from '../lyrics';
import { useSkinCalm } from '../sharedHooks';
import LyricsTiming from '../LyricsTiming';
import styles from './Drift.module.css';

const TICK_MS = 250;

export interface DriftLyricsProps {
  songId?: string | null;
  trackStartedAt: number | null;
  /** Whether lyrics are showing, so the page can shrink everything else. */
  onPresenceChange: (shown: boolean) => void;
}

function Words({ text, lit }: { text: string; lit: number }) {
  const parts: Array<{ part: string; index: number }> = [];
  let words = 0;
  for (const part of text.split(/(\s+)/)) parts.push({ part, index: part.trim() ? words++ : -1 });
  return (
    <>
      {parts.map(({ part, index }, i) =>
        index < 0 ? part : (
          <span
            key={i}
            className={cn('transition-opacity duration-700 ease-out', index < lit ? 'opacity-100' : 'opacity-30')}
          >
            {part}
          </span>
        ),
      )}
    </>
  );
}

export default memo(function DriftLyrics({ songId, trackStartedAt, onPresenceChange }: DriftLyricsProps) {
  const calm = useSkinCalm();
  const { status, lyrics, positionMs, deviceOffsetMs, setDeviceOffsetMs, station } =
    useCurrentLyrics({ songId, trackStartedAt, tickMs: TICK_MS });
  const [timingOpen, setTimingOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);

  const shown = status === 'ready' && !!lyrics?.synced && lyrics.lines.length > 0;
  const present = useLingeringPresence(shown);
  useEffect(() => {
    onPresenceChange(present);
  }, [present, onPresenceChange]);
  useEffect(() => () => onPresenceChange(false), [onPresenceChange]);

  useEffect(() => {
    if (!timingOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setTimingOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTimingOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [timingOpen]);

  if (!shown || !lyrics) return null;

  const moment = lyricMoment(lyrics, positionMs);
  const line = moment.current >= 0 ? lyrics.lines[moment.current] : null;
  const before = moment.current > 0 ? lyrics.lines[moment.current - 1] : null;
  const next = moment.next >= 0 ? lyrics.lines[moment.next] : null;
  const wordCount = line ? line.text.split(/\s+/).filter(Boolean).length : 0;
  const lit = calm ? wordCount : Math.max(1, Math.ceil(moment.progress * wordCount));

  // Dissolves in Drift's pace; a cut under lite or reduced motion. With no
  // movement to tell two lines apart, the outgoing one is gone before the
  // incoming one starts: its slot changes at once (popLayout), its ink waits.
  const OUT_S = 0.3;
  const fade = (to: number, inS: number) => (calm
    ? { initial: false as const, animate: { opacity: to }, exit: { opacity: 0, transition: { duration: 0 } } }
    : {
        initial: { opacity: 0 },
        animate: { opacity: to, transition: { duration: inS, delay: OUT_S, ease: 'easeOut' as const } },
        exit: { opacity: 0, transition: { duration: OUT_S, ease: 'easeIn' as const } },
      });

  return (
    <section
      ref={rootRef}
      aria-label="Lyrics"
      className="pointer-events-auto relative flex w-[min(880px,92vw)] flex-col items-center"
    >
      {/* A fixed height, so the page around the lyrics never moves with them. */}
      <div className="flex h-[5.6em] w-full flex-col items-center justify-center font-display text-[clamp(26px,5.2vw,60px)] text-ink">
        <AnimatePresence mode="popLayout" initial={false}>
          {before && (
            <m.p
              key={`${songId}:before:${moment.current - 1}`}
              {...fade(0.22, 0.6)}
              className="m-0 mb-[0.45em] line-clamp-1 text-[max(0.4em,12px)] leading-snug font-medium"
            >
              {before.text}
            </m.p>
          )}
        </AnimatePresence>
        <AnimatePresence mode="popLayout" initial={false}>
          {line ? (
            <m.p
              key={`${songId}:${moment.current}`}
              {...fade(1, 0.8)}
              className="m-0 line-clamp-3 leading-[1.12] font-semibold text-balance"
            >
              <Words text={line.text} lit={lit} />
            </m.p>
          ) : moment.resting ? (
            <m.p
              key={`${songId}:rest`}
              {...fade(0.5, 0.8)}
              aria-hidden="true"
              className="m-0 text-[0.7em] leading-none tracking-[0.4em]"
            >
              {/* The breath is its own layer: a keyframe on the line itself
                  would override the dissolve. */}
              <span className={cn(!calm && styles.breathe)}>· · ·</span>
            </m.p>
          ) : null}
        </AnimatePresence>
        <AnimatePresence mode="popLayout" initial={false}>
          {next && (
            <m.p
              key={`${songId}:next:${moment.next}`}
              {...fade(0.32, 0.8)}
              className="m-0 mt-[0.45em] line-clamp-2 text-[max(0.4em,12px)] leading-snug font-medium"
            >
              {next.text}
            </m.p>
          )}
        </AnimatePresence>
      </div>

      <div className="relative mt-3 flex items-baseline gap-2 font-mono text-[9px] tracking-[0.3em] text-muted uppercase">
        <span>
          ♪ lyrics
          {lyrics.source === 'lrclib' && (
            <>
              {' · via '}
              <a className="v3-focus underline hover:text-ink" href="https://lrclib.net" target="_blank" rel="noreferrer">lrclib</a>
            </>
          )}
        </span>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={() => setTimingOpen((open) => !open)}
          aria-expanded={timingOpen}
          className="v3-focus cursor-pointer border-0 bg-transparent p-0 font-mono text-[9px] tracking-[0.3em] text-muted uppercase hover:text-ink"
        >
          timing
        </button>
        {timingOpen && (
          <div className="absolute bottom-full left-1/2 z-10 mb-3 w-[min(320px,calc(100vw-2rem))] -translate-x-1/2 border border-soft-border bg-[var(--bg)]/95 p-4 text-left tracking-normal normal-case">
            <LyricsTiming deviceOffsetMs={deviceOffsetMs} setDeviceOffsetMs={setDeviceOffsetMs} station={station} />
          </div>
        )}
      </div>
    </section>
  );
});
