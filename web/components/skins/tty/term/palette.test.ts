// Drawings name ramps, not colours, so the ramps' promises are what keep a
// scene readable in every theme: they start near the background, end on the
// token, and the cold one never collapses onto the hot one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COOL, CUBE, HOT, INK, PALETTE_SIZE, buildPalette, coldLight, cool, cube, glows, hot, ink,
  isDarkTheme, lightness, mix, toOklab, type Rgb, type ThemeRgb,
} from './palette';

const DARK: ThemeRgb = {
  bg: [16, 14, 12], ink: [236, 230, 220], muted: [193, 192, 189], accent: [217, 75, 42], accent2: [217, 75, 42],
};
const LIGHT: ThemeRgb = { ...DARK, bg: [243, 239, 230], ink: [22, 20, 18], muted: [109, 103, 94] };

const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const dist = (a: Rgb, b: Rgb) => {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

test('the table has an entry for every index', () => {
  const p = buildPalette(DARK);
  assert.equal(p.length, PALETTE_SIZE);
  for (const c of p) assert.match(c, /^#[0-9a-f]{6}$/);
});

test('mixing in OKLab keeps its endpoints', () => {
  assert.deepEqual(mix(DARK.bg, DARK.ink, 0), DARK.bg);
  assert.deepEqual(mix(DARK.bg, DARK.ink, 1), DARK.ink);
});

test('ink rises from near the background to the ink token, on dark and light alike', () => {
  for (const theme of [DARK, LIGHT]) {
    const p = buildPalette(theme);
    const first = hexRgb(p[ink(0)]!);
    const last = hexRgb(p[ink(1)]!);
    assert.ok(dist(first, theme.bg) < dist(first, theme.ink), 'the faintest step sits by the background');
    assert.ok(dist(last, theme.ink) < 0.01, 'the top step is the ink');
  }
});

test('the hot ramp passes through the accent itself', () => {
  const p = buildPalette(DARK);
  assert.ok(dist(hexRgb(p[HOT + 8]!), DARK.accent) < 0.01);
});

test('with no accent-2 of its own, the cold light turns away from the accent', () => {
  assert.ok(dist(coldLight(DARK), DARK.accent) > 0.1);
  const teal: Rgb = [40, 180, 170];
  assert.deepEqual(coldLight({ ...DARK, accent2: teal }), teal);
});

test('only the upper reaches of the light ramps bloom', () => {
  assert.equal(glows(ink(1)), false);
  assert.equal(glows(hot(0.2)), false);
  assert.equal(glows(hot(1)), true);
  assert.equal(glows(cool(1)), true);
  assert.equal(glows(CUBE), false);
  assert.ok(cool(1) < CUBE && hot(1) < COOL && ink(1) < HOT && INK === 0);
});

test('a colour lands on its nearest xterm cube entry', () => {
  assert.equal(cube(0, 0, 0), CUBE);
  assert.equal(cube(255, 255, 255), CUBE + 215);
  assert.equal(cube(255, 0, 0), CUBE + 5 * 36);
  assert.equal(cube(100, 140, 210), CUBE + 1 * 36 + 2 * 6 + 4);
});

test('dark and light are told apart by the background', () => {
  assert.equal(isDarkTheme(DARK), true);
  assert.equal(isDarkTheme(LIGHT), false);
  assert.ok(lightness(DARK.bg) < lightness(LIGHT.bg));
});
