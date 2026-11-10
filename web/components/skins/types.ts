// Skins consume PlayerCore contexts, StationClient, and shared helpers. Use useTuneInGate for the
// browser audio gesture and theme tokens for colours. Co-locate styles. Lite mode requires JS
// animation loops to stop, long transitions to be disabled, and animation-only content to remain
// visible. See web/CLAUDE.md for the full contract.

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
