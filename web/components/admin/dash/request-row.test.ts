// What a Dash Requests row shows (request-row.ts).
//
// Run: npm test -- request-row

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtRequestWhen, fmtTook, requestHow } from './request-row';

test('the route shows once when the choice repeats it', () => {
  assert.deepEqual(requestHow('agent', 'agent'), { route: 'DJ agent', detail: null });
  assert.deepEqual(requestHow('chat', 'chat'), { route: 'chat', detail: null });
  assert.deepEqual(requestHow('more-like-this', 'more-like-this'), { route: 'more like this', detail: null });
});

test('the choice shows when it adds something, without the route repeated', () => {
  assert.deepEqual(requestHow('cascade', 'artist-sort'), { route: 'rules', detail: 'artist-sort' });
  assert.deepEqual(requestHow('cascade', 'library-mood:calm'), { route: 'rules', detail: 'library-mood:calm' });
  assert.deepEqual(requestHow('agent', 'agent:off-topic'), { route: 'DJ agent', detail: 'off-topic' });
  assert.deepEqual(requestHow('more-like-this', 'more-like-this:similar'), { route: 'more like this', detail: 'similar' });
  assert.deepEqual(requestHow('chat', 'agent-chat'), { route: 'chat', detail: 'answered by the agent' });
});

test('an unknown route reads as written, and a lone choice stands in for it', () => {
  assert.deepEqual(requestHow('new-route', 'x'), { route: 'new-route', detail: 'x' });
  assert.deepEqual(requestHow(null, 'search'), { route: 'search', detail: null });
  assert.deepEqual(requestHow(null, null), { route: null, detail: null });
});

test('the time taken reads in ms, seconds or minutes', () => {
  assert.equal(fmtTook(640), '640 ms');
  assert.equal(fmtTook(34942), '34.9 s');
  assert.equal(fmtTook(137413), '2 min 17 s');
  assert.equal(fmtTook(null), null);
  assert.equal(fmtTook(-1), null);
});

test('the date and time follow the station zone', () => {
  assert.equal(fmtRequestWhen('2026-11-19T06:30:17.226Z', 'Europe/Athens', 'en-GB'), 'Thu 19 Nov · 08:30');
  assert.equal(fmtRequestWhen('2026-11-19T23:30:00Z', 'Europe/Athens', 'en-GB'), 'Fri 20 Nov · 01:30');
  assert.equal(fmtRequestWhen(null), '');
  assert.equal(fmtRequestWhen('not a date'), '');
});
