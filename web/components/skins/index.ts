'use client';

// Adding a skin is one entry here plus a directory under components/skins/<id>/
// (contract in types.ts). Components are wrapped in next/dynamic so only the
// active skin's chunk is fetched; SSR stays on, so first paint doesn't wait on
// a client roundtrip.

import dynamic from 'next/dynamic';
import { DEFAULT_SKIN_ID, canonicalSkinId } from '@/lib/skin';
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
    id: 'unit',
    name: 'Unit SW-9',
    description:
      'A tabletop receiver — milled aluminium, weighted knobs, one glowing dot-matrix window.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./unit/UnitSkin'),
  },
  {
    id: 'drift',
    name: 'Drift',
    description:
      'Ninety percent weather, ten percent type — the cover art becomes the room.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./drift/DriftSkin'),
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
  {
    id: 'platter',
    name: 'Platter',
    description:
      'The flagship vinyl face — a reference turntable is the interface, needle and all.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./platter/PlatterSkin'),
  },
  {
    id: 'axo',
    name: 'AXO-1',
    description:
      'A hi-fi stack drawn at 30° — the switch, knob and keys in the drawing are the controls.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./axo/AxoSkin'),
  },
  {
    id: 'cipher',
    name: 'Cipher-3',
    description:
      'A rotor cipher machine — the lampboard spells the song, and your request is typed on its keys.',
    skinApiVersion: SKIN_API_VERSION,
    load: () => import('./cipher/CipherSkin'),
  },
];

// Id facts (default id, legacy aliases) live in lib/skin.ts so the server
// layout's SKIN_INIT_SCRIPT derives from the same data without importing this
// registry's next/dynamic wrappers.
export { DEFAULT_SKIN_ID };

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
 *  a string-keyed record, so TS can't prove a hit). The bundler dedupes this
 *  against the classic entry's chunk. */
export const DEFAULT_SKIN_COMPONENT: SkinComponent = dynamic(
  () => import('./classic/ClassicSkin'),
) as SkinComponent;
