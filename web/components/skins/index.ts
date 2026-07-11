'use client';

// The skin registry — every player face this build ships. Adding a skin is
// one entry here plus a directory under components/skins/<id>/; community
// submissions follow the same shape (see types.ts for the contract).
//
// Components are wrapped in next/dynamic so only the active skin's chunk is
// fetched; SSR stays on (the server renders the resolved skin into the
// initial HTML, so first paint doesn't wait on a client roundtrip).

import dynamic from 'next/dynamic';
import { SKIN_API_VERSION, type SkinComponent, type SkinManifest } from './types';

export const SKINS: SkinManifest[] = [
  {
    id: 'classic',
    name: 'Classic',
    description:
      'The original SUB/WAVE face — masthead, centre stage, waveform, transport deck.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./classic/ClassicSkin'),
  },
  {
    id: 'spool',
    name: 'Spool',
    description:
      'A walkman deck — the whole station fits on one cassette.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./spool/SpoolSkin'),
  },
  {
    id: 'subamp',
    name: 'Subamp',
    description:
      "A compact modular player — deck, booth and log stacked like it's 1998.",
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./subamp/SubampSkin'),
  },
  {
    id: 'tty',
    name: 'TTY',
    description:
      'The station as a live process — panes and a status line, everything tails.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./tty/TtySkin'),
  },
];

/** Renamed/retired skin ids — resolved to their successor so an operator's
 *  saved setting keeps working across upgrades. */
const LEGACY_SKIN_ALIASES: Record<string, string> = {
  terminal: 'tty',
};

function canonicalSkinId(id: string | null | undefined): string | null {
  if (!id) return null;
  return LEGACY_SKIN_ALIASES[id] ?? id;
}

export const DEFAULT_SKIN_ID = 'classic';

export function isKnownSkin(id: string | null | undefined): id is string {
  return !!id && SKINS.some(s => s.id === id);
}

/** Listener override beats station default beats built-in fallback; legacy
 *  ids map to their successor, and unknown ids (a skin removed from the
 *  build, a typo in settings) fall through so the player always renders. */
export function resolveSkinId(
  stationId: string | null | undefined,
  overrideId: string | null,
): string {
  const override = canonicalSkinId(overrideId);
  if (isKnownSkin(override)) return override;
  const station = canonicalSkinId(stationId);
  if (isKnownSkin(station)) return station;
  return DEFAULT_SKIN_ID;
}

/** Module-level dynamic wrappers, one per registered skin — referenced by
 *  plain property access so render code never looks like it's creating a
 *  component (react-hooks/static-components). */
export const SKIN_COMPONENTS: Record<string, SkinComponent> = Object.fromEntries(
  SKINS.map(m => [m.id, dynamic(m.load) as SkinComponent]),
);

/** Concretely-typed last-resort fallback for indexed lookups (the registry is
 *  a string-keyed record, so TS can't prove a hit). Points at the same module
 *  as the classic entry — the bundler dedupes the chunk. */
export const DEFAULT_SKIN_COMPONENT: SkinComponent = dynamic(
  () => import('./classic/ClassicSkin'),
) as SkinComponent;
