import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RunHoldsBanner from './RunHoldsBanner';

const render = (holds?: string[] | null) =>
  renderToStaticMarkup(createElement(RunHoldsBanner, { holds, onViewLog: () => {} }));

test('every hold the run raised is shown, in its own words, with a way to the log', () => {
  const html = render(['210 tracks look replaced at the same path.', '300 of 900 library tracks are missing.']);
  assert.match(html, /role="status"/);
  assert.match(html, /210 tracks look replaced at the same path\./);
  assert.match(html, /300 of 900 library tracks are missing\./);
  assert.match(html, /View log/);
});

test('a run that held nothing shows nothing', () => {
  assert.equal(render([]), '');
  assert.equal(render(null), '');
  assert.equal(render(undefined), '', 'a controller from before this field');
});

const renderHeld = (heldRows: number, onConfirmPrune?: () => void, holds: string[] = []) =>
  renderToStaticMarkup(createElement(RunHoldsBanner, { holds, heldRows, onViewLog: () => {}, onConfirmPrune }));

test('rows a walk kept but could not see are named, with a way to remove them, after a restart too', () => {
  // No hold text: the controller restarted since the run, but held-rows.json remains.
  const html = renderHeld(11_794, () => {});
  assert.match(html, /Kept out of picks\./);
  assert.match(html, /11,794 library tracks are not on the music/);
  assert.match(html, /Remove them/);
});

test('the run’s own words win over the generic line, and the action stays', () => {
  const html = renderHeld(300, () => {}, ['300 of 900 library tracks are missing from the music source.']);
  assert.match(html, /On hold\./);
  assert.doesNotMatch(html, /Kept out of picks/);
  assert.match(html, /Remove them/);
});

test('no action while a run holds the slot, and nothing at all when nothing is held', () => {
  assert.doesNotMatch(renderHeld(300, undefined), /Remove them/, 'the panel passes no handler while a run is going');
  assert.equal(renderHeld(0, () => {}), '');
});
