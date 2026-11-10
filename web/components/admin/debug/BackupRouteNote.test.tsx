import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BackupRouteNote, { backupRouteTitle } from './BackupRouteNote';

const T0 = 1_000_000_000;
const routing = {
  reason: 'primary cannot serve (5xx after retries)',
  since: T0,
  lastAt: T0 + 2 * 60_000,
  calls: 7,
  lastOk: true,
  provider: 'locca',
  model: 'locca:qwythos-9b',
  retryPrimaryAt: T0 + 5 * 60_000,
};

test('while routed, the note names the backup in the subtitle form "provider / model"', () => {
  const html = renderToStaticMarkup(createElement(BackupRouteNote, { routing }));
  assert.match(html, /routed to backup locca \/ locca:qwythos-9b/);
});

test('the dot uses the theme accent, the colour of the Dash "On Air" LIVE lamp', () => {
  const html = renderToStaticMarkup(createElement(BackupRouteNote, { routing }));
  assert.match(html, /bg-\[var\(--accent\)\]/);
  assert.match(html, /aria-hidden="true"/, 'the dot is decoration; the words carry the meaning');
});

test('normal routing renders nothing, so the subtitle returns to its plain form', () => {
  assert.equal(renderToStaticMarkup(createElement(BackupRouteNote, { routing: null })), '');
  assert.equal(renderToStaticMarkup(createElement(BackupRouteNote, {})), '');
});

test('the tooltip says why, how much, and when the primary is tried again (sticky window)', () => {
  assert.equal(
    backupRouteTitle(routing, T0 + 3 * 60_000),
    'primary cannot serve (5xx after retries) · 7 calls to the backup in the last 3 min · last one 1 min ago · primary tried again in about 2 min',
  );
});

test('a one-off failover says the next call tries the primary first', () => {
  const r = { ...routing, reason: 'primary model unavailable', calls: 1, lastAt: T0, retryPrimaryAt: undefined };
  assert.equal(
    backupRouteTitle(r, T0 + 10_000),
    'primary model unavailable · 1 call to the backup in the last minute · last one under a minute ago · the next call tries the primary first',
  );
});

test('a backup that failed too is called out', () => {
  assert.match(backupRouteTitle({ ...routing, lastOk: false }, T0), /the backup failed too on the last call/);
});

test('the tooltip copes with a partial payload', () => {
  assert.equal(backupRouteTitle({ provider: 'locca' }), 'primary not used · the next call tries the primary first');
});
