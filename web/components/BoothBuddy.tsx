'use client';

import { memo } from 'react';
import { cn } from '@/lib/cn';
import styles from './BoothBuddy.module.css';

// DJ Doc: the booth's mascot, a little box with a face. Drawn as one SVG so it
// stays crisp from the 16px top-bar badge up to the doctor page, and given real
// depth: a shaded top and side in the theme's own tones, the same way the
// isometric kit shades a box, where it used to cast a flat ink shadow.

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

// Geometry in head units (the face is 64 wide); `size` scales the lot.
const MOODS: Record<BuddyMood, MoodGeom> = {
  content: { eyeW: 8, eyeH: 8, pupil: 0, mouthW: 18, mouthH: 3, open: false, tilt: 0, antTilt: 0, z: false, blink: true },
  onair: { eyeW: 8, eyeH: 8, pupil: 0, mouthW: 22, mouthH: 11, open: true, tilt: 0, antTilt: 0, z: false, blink: true },
  curious: { eyeW: 10, eyeH: 10, pupil: 4, mouthW: 6, mouthH: 6, open: false, tilt: -9, antTilt: -14, z: false, blink: true },
  sleepy: { eyeW: 12, eyeH: 3, pupil: 0, mouthW: 6, mouthH: 5, open: false, tilt: 6, antTilt: 18, z: true, blink: false },
  spooked: { eyeW: 13, eyeH: 13, pupil: 5, mouthW: 11, mouthH: 11, open: false, tilt: 0, antTilt: 0, z: false, blink: false },
};

const W = 64;
const H = 58;
/** The box's depth, drawn up and to the right. */
const DX = 7;
const DY = 5;
const BORDER = 3;
/** Where the antenna stands: the middle of the top face. */
const AX = W / 2 + DX / 2;
const AY = -DY / 2;

const VIEW = { x: -2, y: -26, w: W + DX + 4, h: 94 };

export interface BoothBuddyProps {
  mood?: BuddyMood;
  /** Face width in px; the whole sprite scales from it. */
  size?: number;
  className?: string;
}

export default memo(function BoothBuddy({ mood = 'content', size = 20, className }: BoothBuddyProps) {
  const c = MOODS[mood] ?? MOODS.content;
  const s = size / W;

  // The face sits centred in the head's inner area, eyes over mouth.
  const content = c.eyeH + 8 + c.mouthH;
  const eyeY = H / 2 - content / 2;
  const mouthY = eyeY + c.eyeH + 8;
  const eyesLeft = W / 2 - (c.eyeW * 2 + 14) / 2;
  const eyes = [eyesLeft, eyesLeft + c.eyeW + 14];
  const look = mood === 'curious' ? { x: 2, y: -1 } : { x: 0, y: 0 };

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      width={Number((VIEW.w * s).toFixed(2))}
      height={Number((VIEW.h * s).toFixed(2))}
      className={cn('v3-buddy', styles.root, className)}
    >
      <g transform={`rotate(${c.tilt} ${W / 2} ${H + 8})`}>
        {/* Legs */}
        <rect x={W / 2 - 11} y={H - 1} width="3" height="9" className={styles.ink} />
        <rect x={W / 2 + 8} y={H - 1} width="3" height="9" className={styles.ink} />

        {/* Antenna: tilts with the mood, pulses while on air */}
        <g transform={`rotate(${c.antTilt * 0.7} ${AX} ${AY})`}>
          <rect x={AX - 1.25} y={AY - 13} width="2.5" height="13" className={styles.ink} />
          {mood === 'onair' && <rect x={AX - 4.5} y={AY - 21} width="9" height="9" className={cn(styles.accent, styles.pulse)} />}
          <rect x={AX - 4.5} y={AY - 21} width="9" height="9" strokeWidth={1} className={cn(styles.accent, styles.edge)} />
        </g>

        {/* The box: top and side shaded, front face the face */}
        <path d={`M0 0L${DX} ${-DY}H${W + DX}L${W} 0Z`} strokeWidth={2} className={cn(styles.top, styles.edge)} />
        <path d={`M${W} 0L${W + DX} ${-DY}V${H - DY}L${W} ${H}Z`} strokeWidth={2} className={cn(styles.side, styles.edge)} />
        <rect
          x={BORDER / 2}
          y={BORDER / 2}
          width={W - BORDER}
          height={H - BORDER}
          strokeWidth={BORDER}
          className={cn(styles.face, styles.edge)}
        />

        {eyes.map((x, i) => (
          <g key={i} className={c.blink ? styles.blink : undefined}>
            <rect x={x} y={eyeY} width={c.eyeW} height={c.eyeH} className={styles.ink} />
            {c.pupil > 0 && (
              <rect
                x={x + (c.eyeW - c.pupil) / 2 + look.x}
                y={eyeY + (c.eyeH - c.pupil) / 2 + look.y}
                width={c.pupil}
                height={c.pupil}
                className={styles.face}
              />
            )}
          </g>
        ))}

        <rect x={W / 2 - c.mouthW / 2} y={mouthY} width={c.mouthW} height={c.mouthH} className={styles.ink} />
        {c.open && <rect x={W / 2 - (c.mouthW - 8) / 2} y={mouthY} width={c.mouthW - 8} height="4" className={styles.face} />}

        {c.z && (
          <>
            <text x={W - 6} y="2" fontSize={11} fontWeight={800} className={cn(styles.zz, styles.z1)}>z</text>
            <text x={W - 2} y="-4" fontSize={14} fontWeight={800} className={cn(styles.zz, styles.z2)}>z</text>
          </>
        )}
      </g>
    </svg>
  );
});
