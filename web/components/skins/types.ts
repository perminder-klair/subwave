// The skin contract — what a player skin is and what it may touch.
//
// A skin is the presentation layer of the player: one React component that
// renders everything between the shell's root <div> and the shared services.
// The shell (components/player/PlayerShell.tsx) owns the headless core
// (PlayerCoreProvider), the <audio> element, and the toaster; a skin renders
// visuals and consumes:
//
//   • usePlayerFeed / usePlayerAudio / usePlayerActions — the core contexts.
//   • useStationClient — for cover/avatar URLs.
//   • useTuneInGate — the first-paint tap-to-tune gate. Every skin MUST
//     render some tune-in affordance through it: the tap is the browser's
//     audio-unblock gesture, not decoration.
//   • The theme tokens (--bg, --ink, --muted, --accent, --overlay,
//     --soft-border, --field) — honor them so operator themes keep working.
//
// Skin styles are co-located (Tailwind classes / scoped CSS) — never added
// to globals.css. Keyboard shortcuts are skin-owned; register them with
// useKeyboardShortcuts if wanted.

import type { ComponentType } from 'react';

/** Bumped when the props below or the core-context shapes change
 *  incompatibly. Community skins declare the version they were written
 *  against so review can catch stale ones. */
export const SKIN_API_VERSION = 1;

export interface SkinProps {
  /** True when rendered inside a showcase frame (landing page) rather than
   *  full-page. Skins rarely need this — sizing comes from the shell root. */
  contained: boolean;
  /** Portal target for drawers/dialogs while contained, so overlays stay
   *  inside the frame. null = portal to the document body as usual. */
  portalNode: HTMLElement | null;
}

export type SkinComponent = ComponentType<SkinProps>;

export interface SkinManifest {
  /** Stable slug — what settings.ui.skin and the listener override store. */
  id: string;
  name: string;
  description: string;
  skinApiVersion: typeof SKIN_API_VERSION;
  /** Dynamic import of the skin component — inactive skins cost no bundle. */
  load: () => Promise<{ default: SkinComponent }>;
}
