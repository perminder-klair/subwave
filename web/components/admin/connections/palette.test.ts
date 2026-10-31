import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { brainPalette, contrast, lightBrainTheme, LIGHT_MAP_LINK_OPACITY } from './palette';
import type { Rgb, ThemeRgb } from '../../../lib/theme-rgb';
const hex = (s: string): Rgb => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)) as unknown as Rgb;
const directory = new URL('../../../../controller/src/themes/builtin/', import.meta.url);
for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
  test(`${file}: map hues remain visible and coverage agrees with the key`, () => {
    const { tokens } = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    const theme = Object.fromEntries(['bg', 'ink', 'muted', 'accent', 'accent2'].map(key => [key, hex(tokens[`--${key === 'accent2' ? 'accent-2' : key}`] ?? tokens['--accent'])])) as unknown as ThemeRgb;
    const colours = brainPalette(theme);
    for (const [name, css] of Object.entries(colours)) {
      if (name === 'brain-coverage-unexplored') continue;
      const rgb = css.match(/\d+/g)!.map(Number) as unknown as Rgb;
      assert.ok(contrast(rgb, theme.bg) >= 3, `${name}: ${css}`);
      if (lightBrainTheme(theme)) {
        const painted = rgb.map((channel, index) => Math.round(channel * LIGHT_MAP_LINK_OPACITY
          + theme.bg[index]! * (1 - LIGHT_MAP_LINK_OPACITY))) as unknown as Rgb;
        assert.ok(contrast(painted, theme.bg) >= 3, `${name} after link transparency: ${css}`);
      }
    }
    assert.equal(colours['brain-coverage-ready'], colours['brain-recording']);
    assert.equal(colours['brain-coverage-queued'], colours['brain-series']);
    assert.equal(new Set(['artist', 'recording', 'release', 'contributor', 'series'].map(kind => colours[`brain-${kind}`])).size, 5);
  });
}
