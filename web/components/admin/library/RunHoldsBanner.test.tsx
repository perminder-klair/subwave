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
