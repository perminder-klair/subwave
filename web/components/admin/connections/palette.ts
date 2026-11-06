import { mix, type Rgb, type ThemeRgb } from '../../../lib/theme-rgb';

const HUES: Record<string, Rgb> = {
  artist: [255, 129, 85], recording: [100, 216, 202], release: [238, 203, 129],
  contributor: [182, 152, 238], series: [141, 168, 238], 'external-recording': [115, 131, 153],
  'coverage-incomplete': [238, 138, 138],
};
function luminance(rgb: Rgb): number {
  const linear = rgb.map(byte => { const v = byte / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const LIGHT_MAP_LINK_OPACITY = 0.7;
export function lightBrainTheme(theme: ThemeRgb): boolean {
  return luminance(theme.bg) > luminance(theme.ink);
}
/** Check light-theme contrast after ordinary connection transparency is applied. */
export function brainPalette(theme: ThemeRgb): Record<string, string> {
  const colours: Record<string, string> = {};
  const opacity = lightBrainTheme(theme) ? LIGHT_MAP_LINK_OPACITY : 1;
  const visibleContrast = (rgb: Rgb) => contrast(rgb.map((channel, index) =>
    Math.round(channel * opacity + theme.bg[index]! * (1 - opacity))) as unknown as Rgb, theme.bg);
  for (const [name, seed] of Object.entries(HUES)) {
    let rgb = mix(seed, theme.ink, 0.15);
    // Darken light-map hues neutrally: coloured theme ink would pull every
    // relationship towards the same colour as contrast increases.
    const target: Rgb = lightBrainTheme(theme) ? [0, 0, 0]
      : contrast(theme.ink, theme.bg) >= 3 ? theme.ink : [255, 255, 255];
    for (let step = 1; visibleContrast(rgb) < 3 && step <= 20; step++) rgb = mix(seed, target, step / 20);
    colours[`brain-${name}`] = `rgb(${rgb.join(',')})`;
  }
  for (const [state, kind] of Object.entries({ ready: 'recording', empty: 'release', queued: 'series', researching: 'series' })) {
    colours[`brain-coverage-${state}`] = colours[`brain-${kind}`]!;
  }
  colours['brain-coverage-unexplored'] = `rgb(${theme.muted.join(',')})`;
  return colours;
}
