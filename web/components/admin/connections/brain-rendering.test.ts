import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBrainKeySetting } from './key-preferences';

test('detailed rendering defaults off without requiring browser storage during rendering', () => {
  function Preference() {
    const [enabled] = useBrainKeySetting('detailedRendering');
    return createElement('button', { 'aria-pressed': enabled }, 'Glow & detail');
  }
  assert.match(renderToStaticMarkup(createElement(Preference)), /aria-pressed="false"/);
});

test('large-map simplified drawing is optional and retains selected and close-up detail', () => {
  const source = readFileSync(new URL('./BrainCanvas.tsx', import.meta.url), 'utf8');
  assert.match(source, /const \[detailedRendering, setDetailedRendering\] = useBrainKeySetting\('detailedRendering'\)/);
  assert.match(source, /if \(largeMap && !detailedRendering && !active && node.local && node.kind === 'artist' && scale < LABEL_POPULATION_MIN_ZOOM\)/);
  assert.match(source, /aria-label="Detailed rendering" aria-pressed=\{detailedRendering\}/);
  assert.match(source, /onClick=\{\(\) => setDetailedRendering\(value => !value\)\}/);
});
