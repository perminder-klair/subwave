import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BoothDrawer from './BoothDrawer';
import type { SessionTurn } from '@/lib/types';

const voice: SessionTurn = {
  t: '2026-10-07T22:45:00Z', role: 'segment', kind: 'link', text: 'An outgoing line.',
  meta: { carried: true, personaName: 'Outgoing Bob' },
};

const render = (items: SessionTurn[]) => renderToStaticMarkup(createElement(BoothDrawer, {
  items, timezone: 'UTC', locale: 'en-GB',
}));

test('carried speech shows its outgoing speaker and stays dimmed', () => {
  const html = render([voice]);
  assert.match(html, /Outgoing Bob/);
  assert.match(html, /An outgoing line/);
  assert.match(html, /opacity:0\.6/);
});

test('ordinary speech and carried tracks keep their existing presentation', () => {
  assert.doesNotMatch(render([{ ...voice, meta: { personaName: 'Live Mae' } }]), /Live Mae/);
  assert.doesNotMatch(render([{ ...voice, role: 'track' }]), /Outgoing Bob/);
});
