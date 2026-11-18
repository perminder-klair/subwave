// Show editor side of per-show jingle and bed allowlists (#1875, #1188).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AllowlistSkipNotice, IMAGING_PICKER_COPY, JingleMixerNotice, PlaylistPicker } from './ShowPickers';
import { allowlistSkipNotice, hydrateShow, jingleListIgnored, showPayload } from './lib';

const jingles = [
  { id: 'jingle_a.wav', name: 'Station A', songCount: null },
  { id: 'jingle_b.wav', name: 'Station B', songCount: null },
];
const beds = [
  { id: 'bed-x', name: 'bed-x', songCount: null },
  { id: 'bed-y', name: 'bed-y', songCount: null },
];
const picker = (playlists: typeof jingles, selected: string[], status: 'ready' | 'loading' | 'error' = 'ready') =>
  renderToStaticMarkup(createElement(PlaylistPicker, {
    playlists, status, selected, max: 64, onChange: () => {}, searchLabel: 'Search', copy: IMAGING_PICKER_COPY,
  }));

test('picker lists library jingles and beds unchecked', () => {
  for (const [list, names] of [[jingles, ['Station A', 'Station B']], [beds, ['bed-x', 'bed-y']]] as const) {
    const html = picker([...list], []);
    for (const name of names) assert.match(html, new RegExp(`>${name}<`));
    assert.doesNotMatch(html, /checked/);
    assert.doesNotMatch(html, /Navidrome/);
  }
});

test('picker marks a deleted bed "(deleted)"', () => {
  const html = picker(beds, ['bed-gone']);
  assert.match(html, /\(deleted\) bed-gone/);
  assert.match(html, /deleted from the library/);
  assert.match(html, /checked/);
  assert.doesNotMatch(html, /\(missing\)/);
});

test('hydrate then payload keeps both lists', () => {
  const show = hydrateShow({ id: 's_lunch', name: 'The lunch show', personaId: 'p', allowedJingles: ['jingle_a.wav'], allowedBeds: ['bed-x'] });
  const payload = showPayload(show);
  assert.deepEqual(payload.allowedJingles, ['jingle_a.wav']);
  assert.deepEqual(payload.allowedBeds, ['bed-x']);
  const bare = hydrateShow({ id: 's_bare', name: 'Bare', personaId: 'p' });
  assert.deepEqual(showPayload(bare).allowedJingles, []);
  assert.deepEqual(showPayload(bare).allowedBeds, []);
});

test('jingle list notice shows under mixer counting', () => {
  assert.equal(jingleListIgnored({}), true);
  assert.equal(jingleListIgnored({ jingleRotate: 'mixer', jinglePlacement: 'between' }), true);
  assert.equal(jingleListIgnored({ jingleRotate: 'controller' }), false);
  assert.equal(jingleListIgnored({ jingleRotate: 'mixer', jinglePlacement: 'over' }), false);
  assert.equal(jingleListIgnored({ jinglePlacement: 'both' }), false);
  const notice = (ignored: boolean, listed: string[]) =>
    renderToStaticMarkup(createElement(JingleMixerNotice, { ignored, listed }));
  assert.match(notice(true, ['jingle_a.wav']), /role="status"[^>]*>The mixer counts the jingle rotate/);
  assert.equal(notice(true, []), '');
  assert.equal(notice(false, ['jingle_a.wav']), '');
});

test('notice when no listed jingle exists', () => {
  const text = allowlistSkipNotice('jingle', ['gone.wav'], ['jingle_a.wav'], 'ready');
  assert.match(text ?? '', /automatic jingle slots are skipped/);
  assert.match(text ?? '', /none of its listed jingles exist/);
  assert.equal(allowlistSkipNotice('jingle', ['gone.wav', 'jingle_a.wav'], ['jingle_a.wav'], 'ready'), null);
  assert.equal(allowlistSkipNotice('jingle', [], ['jingle_a.wav'], 'ready'), null);
  const html = renderToStaticMarkup(createElement(AllowlistSkipNotice, {
    kind: 'jingle', listed: ['gone.wav'], libraryIds: ['jingle_a.wav'], status: 'ready',
  }));
  assert.match(html, /role="status"/);
  assert.match(html, /automatic jingle slots are skipped/);
});

test('notice when no listed bed exists', () => {
  const text = allowlistSkipNotice('bed', ['gone'], ['bed-x'], 'ready');
  assert.match(text ?? '', /links air without a bed/);
  assert.match(text ?? '', /none of its listed beds exist/);
});

test('no deleted mark or notice unless the library is ready', () => {
  for (const status of ['loading', 'error'] as const) {
    assert.equal(allowlistSkipNotice('bed', ['gone'], [], status), null);
    assert.equal(renderToStaticMarkup(createElement(AllowlistSkipNotice, {
      kind: 'bed', listed: ['gone'], libraryIds: [], status,
    })), '');
    assert.doesNotMatch(picker(beds, ['gone'], status), /\(deleted\)/);
  }
});
