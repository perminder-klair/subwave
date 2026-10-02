// Run from web/: ../controller/node_modules/.bin/tsx --test scripts/debug-icecast.test.tsx
// Server rendering exercises the real table without a controller or station.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KvTable } from '../components/admin/debug/bits';
import { fmtListenerPeak } from '../components/admin/debug/format';

test('the peak label names the sum of mount peaks, including zero', () => {
  assert.equal(fmtListenerPeak({ listener_peak: 30 }), 'sum of mount peaks 30');
  assert.equal(fmtListenerPeak({ listener_peak: 0 }), 'sum of mount peaks 0');
  assert.equal(fmtListenerPeak(undefined), '—');
  assert.equal(fmtListenerPeak({}), '—');
  assert.equal(fmtListenerPeak({ error: 'no source connected', listener_peak: 30 }), '—');
});

const render = (value: unknown) => renderToStaticMarkup(createElement(KvTable, { obj: { activeMounts: value } }));

test('active mount URLs render as comma-separated text instead of JSON', () => {
  const html = render(['https://station.invalid/stream.mp3', 'https://station.invalid/stream.flac']);
  assert.match(html, />https:\/\/station\.invalid\/stream\.mp3, https:\/\/station\.invalid\/stream\.flac<\/span>/);
  assert.ok(!html.includes('<pre'));
  assert.match(render([]), />none<\/span>/);
});

test('nested data retains JSON rendering and mount text is escaped', () => {
  assert.match(render([{ listeners: 2 }]), /<pre/);
  assert.match(render([['nested']]), /<pre/);
  assert.match(render(['<script>alert(1)</script>']), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!render(['<script>alert(1)</script>']).includes('<script>'));
});
