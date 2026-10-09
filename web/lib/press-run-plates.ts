// Plate list for the landing page's "Press Run" interlude: one source of truth
// for the gallery strip, captions, lightbox and scripts/capture-gallery.mjs.
// Eight skins, eight themes: each appears exactly once.
// Plain data, no React, because the capture script imports it from node.

export type PressRunSkinId =
  | 'classic' | 'unit' | 'drift' | 'subamp' | 'tty' | 'platter' | 'axo' | 'cipher';

export type PressRunThemeId =
  | 'classic-light' | 'classic-dark' | 'blueprint' | 'cyberpunk'
  | 'flare' | 'recon' | 'signal' | 'vinyl';

export interface PressRunPlate {
  /** `${skinId}-${themeId}` — also the image basename under public/. */
  id: string;
  /** 1-based plate number, printed in the caption. */
  no: number;
  skinId: PressRunSkinId;
  skinName: string;
  /** Copied verbatim from the skin registry, as plain strings so this module
   *  never drags the registry's next/dynamic wrappers into the capture script. */
  skinDescription: string;
  themeId: PressRunThemeId;
  themeName: string;
  /** Path under public/, produced by scripts/capture-gallery.mjs. */
  src: string;
  alt: string;
}

function plate(
  no: number,
  skinId: PressRunSkinId,
  skinName: string,
  skinDescription: string,
  themeId: PressRunThemeId,
  themeName: string,
): PressRunPlate {
  return {
    id: `${skinId}-${themeId}`,
    no,
    skinId,
    skinName,
    skinDescription,
    themeId,
    themeName,
    src: `/screenshots/gallery/${skinId}-${themeId}.webp`,
    alt: `SUB/WAVE player — ${skinName} skin in the ${themeName} theme`,
  };
}

export const PRESS_RUN_PLATES: readonly PressRunPlate[] = [
  plate(1, 'classic', 'Classic',
    'The original SUB/WAVE face — masthead, centre stage, waveform, transport deck.',
    'classic-light', 'Classic Light'),
  plate(2, 'platter', 'Platter',
    'The flagship vinyl face — a reference turntable is the interface, needle and all.',
    'vinyl', 'Vinyl'),
  plate(3, 'tty', 'TTY',
    'The station as a live process — panes and a status line, everything tails.',
    'cyberpunk', 'Cyberpunk'),
  plate(4, 'unit', 'Unit SW-9',
    'A tabletop receiver — milled aluminium, weighted knobs, one glowing dot-matrix window.',
    'flare', 'Flare'),
  plate(5, 'drift', 'Drift',
    'Ninety percent weather, ten percent type — the cover art becomes the room.',
    'classic-dark', 'Classic Dark'),
  plate(6, 'subamp', 'Subamp',
    "A compact modular player — deck, booth and log stacked like it's 1998.",
    'blueprint', 'Blueprint'),
  plate(7, 'cipher', 'Cipher-3',
    'A rotor cipher machine — the lampboard spells the song, and your request is typed on its keys.',
    'signal', 'Signal'),
  plate(8, 'axo', 'AXO-1',
    'A hi-fi stack drawn at 30° — the switch, knob and keys in the drawing are the controls.',
    'recon', 'Recon'),
];

/** Row split for the two marquee bands: plates 1–4 drift left, 5–8 drift right. */
export const PRESS_RUN_ROWS: readonly [PressRunPlate[], PressRunPlate[]] = [
  PRESS_RUN_PLATES.slice(0, 4),
  PRESS_RUN_PLATES.slice(4, 8),
];
