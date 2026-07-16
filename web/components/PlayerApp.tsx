'use client';

// The player entry point, kept as a stable import for the routes and the
// landing showcase. Renders the shell, which resolves the active skin from
// the registry (operator default on /state, listener localStorage override).
//
// Install-level page effects (first-run redirect, audience beacon) live in
// player/PlayerPageEffects, mounted by the full-page routes — never by
// showcase embeds.

import PlayerShell from './player/PlayerShell';

export interface PlayerAppProps {
  contained?: boolean;
}

export default function PlayerApp({ contained = false }: PlayerAppProps) {
  return <PlayerShell contained={contained} />;
}
