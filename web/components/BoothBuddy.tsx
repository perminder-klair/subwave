'use client';

import { memo } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';

// The "Booth Sprite" — a small pure-CSS mascot that leads the DJ thinking line.
// Ported 1:1 from the field-guide prototype (docs/Booth-Sprite.html): an
// antenna, a square head with two eyes + a mouth, and two legs, all assembled
// from <span>s and animated with CSS keyframes (globals.css `buddy-*`).
//
// Colours come from the theme tokens, never hardcoded hex, so the buddy travels
// across every listener theme (light / dark / custom). The head fill is the
// surface (`--bg`) and the features are the foreground (`--ink`), so the creature
// reads as line-art defined by its border + solid eyes/mouth + accent antenna —
// the ink-on-bg pairing is legible on any palette by construction.
//
// Decorative only: the whole sprite is aria-hidden (the DJ line carries the
// readable text + aria-label). Inline styles are intentional — the geometry is
// computed per-mood and per-size and can't be static Tailwind utilities, so this
// file is exempt from `react/forbid-dom-props` (see web/eslint.config.mjs).

export type BuddyMood = 'content' | 'onair' | 'curious' | 'sleepy' | 'spooked';

interface MoodGeom {
  eyeW: number;
  eyeH: number;
  pupil: number;
  mouthW: number;
  mouthH: number;
  open: boolean;
  tilt: number;
  antTilt: number;
  z: boolean;
  blink: boolean;
}

// Geometry at scale 1 (head = 64px wide); every value is multiplied by
// `size / 64`. Numbers are lifted verbatim from the prototype's mood table.
const MOODS: Record<BuddyMood, MoodGeom> = {
  content: { eyeW: 8, eyeH: 8, pupil: 0, mouthW: 18, mouthH: 3, open: false, tilt: 0, antTilt: 0, z: false, blink: true },
  onair: { eyeW: 8, eyeH: 8, pupil: 0, mouthW: 22, mouthH: 11, open: true, tilt: 0, antTilt: 0, z: false, blink: true },
  curious: { eyeW: 10, eyeH: 10, pupil: 4, mouthW: 6, mouthH: 6, open: false, tilt: -9, antTilt: -14, z: false, blink: true },
  sleepy: { eyeW: 12, eyeH: 3, pupil: 0, mouthW: 6, mouthH: 5, open: false, tilt: 6, antTilt: 18, z: true, blink: false },
  spooked: { eyeW: 13, eyeH: 13, pupil: 5, mouthW: 11, mouthH: 11, open: false, tilt: 0, antTilt: 0, z: false, blink: false },
};

const INK = 'var(--ink)';
const FILL = 'var(--bg)';
const ACCENT = 'var(--accent)';
const HEAD_W = 64;

export interface BoothBuddyProps {
  /** Drives the face/antenna geometry. Defaults to the resting state. */
  mood?: BuddyMood;
  /** Head width in px; the whole sprite scales from it. Default 20 (≈28px tall). */
  size?: number;
  className?: string;
}

export default memo(function BoothBuddy({ mood = 'content', size = 20, className }: BoothBuddyProps) {
  const c = MOODS[mood] ?? MOODS.content;
  const s = size / HEAD_W;
  const px = (n: number) => `${(n * s).toFixed(2)}px`;
  const playing = mood === 'onair';

  // Outer wrapper owns the always-on "breathe"; the inner root owns the static
  // per-mood tilt — separated so the tilt survives (a CSS animation overrides
  // an inline transform on the same element for the property it animates).
  const breatheWrap: CSSProperties = {
    display: 'inline-flex',
    transformOrigin: 'center bottom',
    animation: 'buddy-breathe 2.8s ease-in-out infinite',
    lineHeight: 1,
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  };
  const root: CSSProperties = {
    position: 'relative',
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    transform: `rotate(${c.tilt}deg)`,
    transformOrigin: 'center bottom',
  };
  const tip: CSSProperties = {
    position: 'relative',
    width: px(9),
    height: px(9),
    background: ACCENT,
    border: `${px(1)} solid ${INK}`,
    boxSizing: 'border-box',
    transform: `rotate(${c.antTilt}deg)`,
    transformOrigin: 'bottom center',
    zIndex: 2,
  };
  const pulse: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: px(9),
    height: px(9),
    background: ACCENT,
    animation: 'buddy-pulse 1.6s ease-out infinite',
    zIndex: -1,
  };
  const stalk: CSSProperties = {
    width: px(2.5),
    height: px(13),
    background: INK,
    transform: `rotate(${c.antTilt * 0.5}deg)`,
    transformOrigin: 'bottom center',
    marginBottom: px(-1),
  };
  const head: CSSProperties = {
    position: 'relative',
    width: px(HEAD_W),
    height: px(58),
    background: FILL,
    border: `${px(3)} solid ${INK}`,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: px(8),
    boxShadow: `${px(3)} ${px(3)} 0 ${INK}`,
  };
  const eyesRow: CSSProperties = { display: 'flex', gap: px(14), alignItems: 'center' };
  const eye: CSSProperties = {
    position: 'relative',
    width: px(c.eyeW),
    height: px(c.eyeH),
    background: INK,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: c.blink ? 'buddy-blink 4.5s steps(1,end) infinite' : 'none',
    transformOrigin: 'center',
  };
  const pupil: CSSProperties = {
    width: px(c.pupil),
    height: px(c.pupil),
    background: FILL,
    transform: mood === 'curious' ? `translate(${px(2)}, ${px(-1)})` : 'none',
  };
  const mouth: CSSProperties = {
    position: 'relative',
    width: px(c.mouthW),
    height: px(c.mouthH),
    background: INK,
    display: 'flex',
    justifyContent: 'center',
    overflow: 'hidden',
  };
  const mouthInner: CSSProperties = { width: px(c.mouthW - 8), height: px(4), background: FILL };
  const legsRow: CSSProperties = { display: 'flex', gap: px(16), marginTop: px(-1) };
  const leg: CSSProperties = { width: px(3), height: px(8), background: INK };
  const zWrap: CSSProperties = { position: 'absolute', top: px(-6), right: px(-10), width: px(20), height: px(20) };
  const zBase: CSSProperties = { position: 'absolute', fontWeight: 800, color: INK, lineHeight: 1 };

  return (
    <span aria-hidden="true" className={cn('v3-buddy', className)} style={breatheWrap}>
      <span style={root}>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={tip}>{playing && <span style={pulse} />}</span>
          <span style={stalk} />
        </span>
        <span style={head}>
          {c.z && (
            <span style={zWrap}>
              <span style={{ ...zBase, left: 0, top: px(6), fontSize: px(11), animation: 'buddy-z 2.4s ease-out infinite' }}>z</span>
              <span style={{ ...zBase, left: px(2), top: px(6), fontSize: px(14), animation: 'buddy-z 2.4s ease-out infinite 1.2s' }}>z</span>
            </span>
          )}
          <span style={eyesRow}>
            <span style={eye}>{c.pupil > 0 && <span style={pupil} />}</span>
            <span style={eye}>{c.pupil > 0 && <span style={pupil} />}</span>
          </span>
          <span style={mouth}>{c.open && <span style={mouthInner} />}</span>
        </span>
        <span style={legsRow}>
          <span style={leg} />
          <span style={leg} />
        </span>
      </span>
    </span>
  );
});
