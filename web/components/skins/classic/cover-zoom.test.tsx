// The classic skin's cover zoom: what a press on the stage cover does, the
// transform the large cover grows out of and shrinks back into, and what the
// enlarged view renders.
//
// Run: npm test -- cover-zoom

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoverZoom from './CoverZoom';
import { coverPressAction, zoomFrom, zoomTransform } from './coverZoom';

test('a press on the cover enlarges it when there is art, and opens the timeline when there is none', () => {
  assert.equal(coverPressAction(true), 'zoom');
  assert.equal(coverPressAction(false), 'timeline');
});

test('the large cover starts exactly over the thumbnail: centre on centre, scaled to its width', () => {
  const thumb = { left: 32, top: 100, width: 200, height: 200 };
  const large = { left: 400, top: 150, width: 500, height: 500 };
  const t = zoomFrom(thumb, large);
  assert.ok(t);
  assert.equal(t.x, (32 + 100) - (400 + 250));
  assert.equal(t.y, (100 + 100) - (150 + 250));
  assert.equal(t.scale, 0.4);
  // Applied to the large box, the transform lands its centre on the thumbnail's.
  assert.equal(400 + 250 + t.x, 32 + 100);
  assert.equal(150 + 250 + t.y, 100 + 100);
  assert.equal(zoomTransform(t), `translate(${t.x}px, ${t.y}px) scale(0.4)`);
});

test('an unusable box means a plain fade, never a transform to nowhere', () => {
  const ok = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(zoomFrom(null, ok), null);
  assert.equal(zoomFrom(ok, undefined), null);
  assert.equal(zoomFrom({ left: 0, top: 0, width: 0, height: 0 }, ok), null, 'a hidden thumbnail');
  assert.equal(zoomFrom(ok, { left: 0, top: 0, width: 0, height: 100 }), null);
  assert.equal(zoomFrom({ left: Number.NaN, top: 0, width: 100, height: 100 }, ok), null);
});

test('the enlarged view is a labelled dialog with the cover, the title and the artist · album, closed from the cover itself', () => {
  const html = renderToStaticMarkup(createElement(CoverZoom, {
    src: '/api/cover/abc', title: 'Ready', artist: 'Charles Webster', album: 'Ready EP', origin: null, onClosed: () => {},
  }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="Cover of Ready"/);
  assert.match(html, /<img[^>]*src="\/api\/cover\/abc"/);
  assert.match(html, /aria-label="Close the cover"/);
  assert.match(html, />Ready</);
  assert.match(html, />Charles Webster · Ready EP</);
});

test('with no title or album the caption shows only what it has', () => {
  const html = renderToStaticMarkup(createElement(CoverZoom, {
    src: '/api/cover/x', artist: 'Someone', origin: null, onClosed: () => {},
  }));
  assert.match(html, /aria-label="Album cover"/);
  assert.match(html, />Someone</);
  assert.doesNotMatch(html, /·/);
});
