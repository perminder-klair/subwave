// Focus mode's scenes: which one the station's hour and weather choose, and
// that every one draws at any size the stage hands it — a phone's narrow
// grid, a wide monitor's, a still frame — without throwing or going blank.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Grid, SPACE } from '../term/grid';
import { STILL_SIGNAL, createSignal } from '../term/signal';
import { SCENES, autoSceneId, drawWeather, isScenePick, periodForHour, sceneById, weatherOf, type Weather } from '.';

const WEATHERS: Weather[] = ['clear', 'cloudy', 'rain', 'snow', 'fog', 'storm'];
const SIZES: Array<[number, number]> = [[213, 50], [154, 41], [62, 38], [24, 8]];

test('the day periods match the controller table', () => {
  const cases: Array<[number, string]> = [
    [0, 'late-evening'], [1, 'after-hours'], [4, 'after-hours'], [5, 'early-morning'], [9, 'morning'],
    [12, 'midday'], [14, 'afternoon'], [17, 'drive-time'], [19, 'evening'], [22, 'late-evening'],
  ];
  for (const [h, period] of cases) assert.equal(periodForHour(h), period, `${h}:00`);
});

test('the station picks a scene for its hour, and a snowy night goes to the cabin', () => {
  assert.equal(autoSceneId('early-morning', 'clear'), 'sunrise');
  assert.equal(autoSceneId('afternoon', 'rain'), 'coast');
  assert.equal(autoSceneId('drive-time', 'clear'), 'sunrise');
  assert.equal(autoSceneId('evening', 'clear'), 'campfire');
  assert.equal(autoSceneId('evening', 'snow'), 'aurora');
  assert.equal(autoSceneId('after-hours', 'clear'), 'aurora');
  assert.equal(autoSceneId('midday', 'snow'), 'coast');
  assert.equal(autoSceneId(undefined, 'clear'), 'campfire');
});

test("the controller's conditions map onto overlays, unknown ones to clear", () => {
  assert.equal(weatherOf('rainy'), 'rain');
  assert.equal(weatherOf('stormy'), 'storm');
  assert.equal(weatherOf('snowy'), 'snow');
  assert.equal(weatherOf('foggy'), 'fog');
  assert.equal(weatherOf('cloudy'), 'cloudy');
  assert.equal(weatherOf('unknown'), 'clear');
  assert.equal(weatherOf(undefined), 'clear');
});

test('a stored pick is only honoured when it names a scene', () => {
  assert.equal(isScenePick('auto'), true);
  for (const s of SCENES) assert.equal(isScenePick(s.id), true);
  assert.equal(isScenePick('volcano'), false);
  assert.equal(isScenePick(null), false);
});

test('every scene draws at every size, in every weather, playing or not', () => {
  const quiet = createSignal();
  for (const scene of SCENES) {
    for (const [cols, rows] of SIZES) {
      const draw = scene.build(cols, rows, 0.5);
      for (const weather of WEATHERS) {
        for (const sig of [STILL_SIGNAL, quiet]) {
          const g = new Grid(cols, rows);
          for (const t of [0, 7.3, 1234.5]) {
            g.clear();
            const frame = { t, sig, weather };
            draw(g, frame);
            drawWeather(g, frame, scene.ownWeather);
          }
          const inked = g.chars.reduce((n, cp) => n + (cp === SPACE ? 0 : 1), 0);
          assert.ok(inked > cols * rows * 0.05, `${scene.id} ${cols}×${rows} ${weather} is nearly blank`);
        }
      }
    }
  }
});

test('a scene is a place: the same moment draws the same picture', () => {
  for (const scene of SCENES) {
    const a = new Grid(120, 40);
    const b = new Grid(120, 40);
    scene.build(120, 40, 0.5)(a, { t: 12.5, sig: STILL_SIGNAL, weather: 'clear' });
    scene.build(120, 40, 0.5)(b, { t: 12.5, sig: STILL_SIGNAL, weather: 'clear' });
    assert.deepEqual(a.chars, b.chars, scene.id);
  }
});

test('an unknown id falls back to a real scene', () => {
  assert.ok(SCENES.includes(sceneById('volcano' as never)));
});
