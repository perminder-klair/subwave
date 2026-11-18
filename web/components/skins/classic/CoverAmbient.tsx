'use client';

// The art-derived ambient wash behind the player (globals.css
// `.v3-cover-ambient`). A new cover's tint crossfades in on the hidden one of
// two stacked layers (../crossfade.ts) rather than transitioning the tint
// colours, which repainted both viewport-sized gradients every frame of the
// fade. Its own component, so a colour read or a fade settling re-renders
// this and not the skin.

import { memo, useRef } from 'react';
import { useReducedMotion } from 'motion/react';
import { useCoverColors, type CoverColors } from '@/hooks/useCoverColors';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { cn } from '@/lib/cn';
import { useCrossfade } from '@/components/skins/sharedHooks';

/** Keep in step with `.v3-cover-ambient-layer`'s opacity transition. */
const FADE_MS = 1100;

export default memo(function CoverAmbient({ coverSrc }: { coverSrc: string | null }) {
  const colors = useCoverColors(coverSrc);
  // Reduced motion snaps the tint in CSS, so a swap there needn't wait for a
  // fade. Lite keeps it: lite stills animation, not transitions.
  const reduced = useReducedMotion();
  const { layers, front } = useCrossfade(colors, reduced ? 0 : FADE_MS);
  return (
    <div aria-hidden="true" className={cn('v3-cover-ambient', colors.vibrant && 'v3-cover-ambient-on')}>
      <TintLayer colors={layers[0]} front={front === 0} />
      <TintLayer colors={layers[1]} front={front === 1} />
    </div>
  );
});

function TintLayer({ colors, front }: { colors: CoverColors; front: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(ref, {
    '--cover-tint': colors.vibrant,
    '--cover-tint-2': colors.average ?? colors.vibrant,
  });
  return <div ref={ref} className={cn('v3-cover-ambient-layer', front && 'v3-cover-ambient-front')} />;
}
