// The galaxy draws in the theme's colours, so its promises are what keep the
// map readable in every theme: Classic stays the picture it was hand-picked
// as, the sky is always night, and a pale or dim token is held to bounds.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lightness, toOklab, type Rgb, type ThemeRgb } from '@/lib/theme-rgb';
import { galaxyPalette, rampGradient, samePalette, toneRgb } from './palette';
import { LLM_TONE, nodeTone, sourceStyle, vocalStyle, type ObsTrack } from './data';

const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const dist = (a: Rgb, b: Rgb) => {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

const VERMILION = hexRgb('#d94b2a');
const CLASSIC_LIGHT: ThemeRgb = {
  bg: hexRgb('#f3efe6'), ink: hexRgb('#161412'), muted: hexRgb('#6d675e'), accent: VERMILION, accent2: VERMILION,
};
const CLASSIC_DARK: ThemeRgb = {
  bg: hexRgb('#100e0c'), ink: hexRgb('#ece6dc'), muted: hexRgb('#c1c0bd'), accent: VERMILION, accent2: VERMILION,
};
const PHOSPHOR: ThemeRgb = {
  bg: hexRgb('#04110a'), ink: hexRgb('#8cffb2'), muted: hexRgb('#4fae74'), accent: hexRgb('#ffb02e'), accent2: hexRgb('#6fd3ff'),
};
const BLUEPRINT: ThemeRgb = {
  bg: hexRgb('#0a3a92'), ink: hexRgb('#f4f7ff'), muted: hexRgb('#b7c6ec'), accent: hexRgb('#3fa9ff'), accent2: hexRgb('#8fd4ff'),
};
const RISO: ThemeRgb = {
  bg: hexRgb('#f3eee1'), ink: hexRgb('#1f45c2'), muted: hexRgb('#4f62a8'), accent: hexRgb('#f02d84'), accent2: hexRgb('#00838a'),
};

test('Classic Light keeps the palette the galaxy was drawn in', () => {
  const p = galaxyPalette(CLASSIC_LIGHT);
  // The hand-picked night, quiet star, unmeasured ring and label inks.
  assert.ok(dist(p.night, hexRgb('#0d0b09')) < 0.02, `night ${p.night}`);
  assert.ok(dist(p.quiet, hexRgb('#665f57')) < 0.03, `quiet ${p.quiet}`);
  assert.ok(dist(p.faint, hexRgb('#9b948a')) < 0.03, `faint ${p.faint}`);
  assert.ok(dist(p.sceneLabel, hexRgb('#8d867b')) < 0.03, `scene ${p.sceneLabel}`);
  assert.ok(dist(p.trackLabel, hexRgb('#cfc8bb')) < 0.03, `track ${p.trackLabel}`);
  assert.ok(dist(p.hot, VERMILION) < 0.01, `hot ${p.hot}`);
});

test('a light theme draws its night from the ink, a dark one from the background', () => {
  const light = galaxyPalette(RISO);
  const dark = galaxyPalette(PHOSPHOR);
  // Riso's sky is a deep version of its blue ink; its stars are mixed from the paper.
  assert.ok(toOklab(light.night)[2] < -0.03, `riso night should stay blue: ${light.night}`);
  assert.deepEqual(light.light, RISO.bg);
  assert.ok(dist(dark.night, PHOSPHOR.bg) < 0.02, `phosphor night ${dark.night}`);
  assert.deepEqual(dark.light, PHOSPHOR.ink);
});

test('every sky is night, however bright the theme background', () => {
  for (const t of [CLASSIC_LIGHT, CLASSIC_DARK, PHOSPHOR, BLUEPRINT, RISO]) {
    assert.ok(lightness(galaxyPalette(t).night) <= 0.155, `${t.bg} → ${galaxyPalette(t).night}`);
  }
});

test('a pale accent is held down, a dark one lifted, so every theme glows alike', () => {
  const pale = galaxyPalette(PHOSPHOR).hot;
  assert.ok(lightness(pale) <= 0.665, `phosphor hot ${pale}`);
  assert.ok(toOklab(pale)[2] > 0.08, 'the amber stays amber');
  const dim = galaxyPalette({ ...CLASSIC_DARK, accent: [60, 10, 10] }).hot;
  assert.ok(lightness(dim) >= 0.575, `dark accent ${dim}`);
  // A dim paper still makes visible starlight.
  const murky = galaxyPalette({ ...CLASSIC_DARK, ink: [90, 90, 90] });
  assert.ok(lightness(murky.light) >= 0.795);
});

test('tones run quiet → hot, and null is the faint ring', () => {
  const p = galaxyPalette(CLASSIC_DARK);
  assert.ok(dist(toneRgb(p, 0), p.quiet) < 0.005);
  assert.ok(dist(toneRgb(p, 1), p.hot) < 0.005);
  assert.ok(dist(toneRgb(p, 2), p.hot) < 0.005, 'clamped above');
  assert.ok(dist(toneRgb(p, -1), p.quiet) < 0.005, 'clamped below');
  assert.deepEqual(toneRgb(p, null), p.faint);
  const mid = toneRgb(p, 0.5);
  assert.ok(dist(mid, p.quiet) > 0.05 && dist(mid, p.hot) > 0.05);
  assert.match(rampGradient(p), /^linear-gradient\(90deg(, rgb\(\d+,\d+,\d+\)){5}\)$/);
});

test('samePalette compares by value', () => {
  assert.ok(samePalette(galaxyPalette(RISO), galaxyPalette(RISO)));
  assert.ok(!samePalette(galaxyPalette(RISO), galaxyPalette(PHOSPHOR)));
});

test('node tones keep the legend\'s keys', () => {
  assert.equal(sourceStyle('manual').tone, 1);
  assert.equal(sourceStyle('llm').tone, LLM_TONE);
  assert.equal(sourceStyle('uncertain-llm').filled, false);
  assert.equal(sourceStyle('propagated').tone, 0);
  assert.equal(sourceStyle('legacy-v1').tone, null);
  assert.equal(vocalStyle('vocal').tone, 1);
  assert.equal(vocalStyle(null).tone, null);
  const t = { energyVal: 0.3, analysed: false, loudnessLufs: null, paceMean: 0.5, confidence: null } as unknown as ObsTrack;
  assert.equal(nodeTone(t, 'energy'), 0.3);
  assert.equal(nodeTone(t, 'analysis'), null);
  assert.equal(nodeTone(t, 'loudness'), null);
  assert.equal(nodeTone(t, 'pace'), 0.55);
  assert.equal(nodeTone(t, 'confidence'), 0.15 + 0.5 * 0.85);
});
