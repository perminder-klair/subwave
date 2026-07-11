'use client';

// The player entry point, kept as a stable import for the routes and the
// landing showcase. Renders the shell (headless core + chrome) with the
// classic skin; the skin registry (stage 4) makes this selectable.
//
// Install-level page effects (first-run redirect, audience beacon) live in
// player/PlayerPageEffects, mounted by the full-page routes — never by
// showcase embeds.

import PlayerShell from './player/PlayerShell';
import ClassicSkin from './skins/classic/ClassicSkin';

export interface PlayerAppProps {
  contained?: boolean;
}

export default function PlayerApp({ contained = false }: PlayerAppProps) {
  return <PlayerShell skin={ClassicSkin} contained={contained} />;
}
