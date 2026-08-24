import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QueueHeldBadge from './QueueHeldBadge';

test('an unsent queue row says it is held before mixer handoff', () => {
  const html = renderToStaticMarkup(createElement(QueueHeldBadge, { sent: false }));
  assert.match(html, />Held</);
  assert.match(html, /title="[^"]*not handed to the mixer yet[^"]*"/);
});

test('a handed-off queue row has no held badge', () => {
  assert.equal(renderToStaticMarkup(createElement(QueueHeldBadge, { sent: true })), '');
});

test('an omitted sent flag degrades to held instead of implying handoff', () => {
  const html = renderToStaticMarkup(createElement(QueueHeldBadge));
  assert.match(html, />Held</);
});
