'use client';

// The player chrome every skin gets for free: the headless core provider
// (feed poll, audio engine, signal probe, OS media session), the <audio>
// element skins tap for the Web Audio visualiser, the contained-embedding
// portal plumbing, and the toaster. A skin renders everything else.

import { useEffect, useRef, useState } from 'react';
import { Toaster } from '@/components/ui/toaster';
import { cn } from '@/lib/cn';
import type { SkinComponent } from '@/components/skins/types';
import { PlayerCoreProvider, usePlayerAudio } from './PlayerCore';

export interface PlayerShellProps {
  skin: SkinComponent;
  /** Rendered inside a showcase frame (landing page) rather than full-page:
   *  absolute instead of fixed positioning, dialogs portal into the frame,
   *  no toaster. */
  contained?: boolean;
}

export default function PlayerShell({ skin, contained = false }: PlayerShellProps) {
  return (
    <PlayerCoreProvider>
      <ShellChrome skin={skin} contained={contained} />
    </PlayerCoreProvider>
  );
}

function ShellChrome({ skin: Skin, contained }: { skin: SkinComponent; contained: boolean }) {
  const { audioRef } = usePlayerAudio();
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Drawers/dialogs portal here when contained so they stay inside the frame.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => { if (contained) setPortalNode(rootRef.current); }, [contained]);

  return (
    <div
      ref={rootRef}
      className={cn(contained ? 'absolute' : 'fixed', 'inset-0 overflow-hidden bg-bg text-ink')}
    >
      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />
      <Skin contained={contained} portalNode={portalNode} />
      {!contained && <Toaster />}
    </div>
  );
}
