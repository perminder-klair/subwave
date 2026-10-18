// Issue #1911: after a show change, the pick window no longer opens by saying
// the station is "Continuing on air from" the previous show.
//
// The hard-roll handoff is identity only (#1479) and it still is. What changed
// is its framing in windowMessages(): every pick prompt of an incoming show
// opened with "[Continuing on air from the show X — hosted as Y — mood Z]",
// while that show's own "begins" scenario turn is filtered out of the window
// as infra noise — so the one show the window named was the one that had
// ended. A genuine show change now says the earlier run ENDED and names what
// is on air; a 4h cap within one show, and a session persisted before the
// flag existed, keep the continuation wording.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-handoff-ended-'));
process.env.STATE_DIR = root;

const session = await import('../src/broadcast/session.js');

after(() => rmSync(root, { recursive: true, force: true }));

function context(show: { id: string; name: string } | null, period = 'evening', mood = 'energetic') {
  return {
    at: new Date().toISOString(),
    time: { period, vibe: period, mood },
    weather: null,
    festival: null,
    dominantMood: mood,
    date: {},
    clock: {},
    listeners: 1,
    activeShow: show ? { ...show, topic: '', moods: [] } : null,
  } as any;
}

const opener = () => session.windowMessages()[0]?.content ?? '';

test('a show change frames the outgoing show as ended and names the incoming one', async () => {
  session.start(context({ id: 'neon', name: 'Neon Nights' }));
  await session.maybeRoll(context({ id: 'quiet', name: 'Quiet Hours' }, 'late-evening', 'calm'));
  const line = opener();
  assert.match(line, /^\[Earlier on air: the show "Neon Nights"/);
  assert.match(line, /mood energetic\. That has ended — now on air: the show "Quiet Hours"/);
  assert.doesNotMatch(line, /Continuing on air/);
  assert.doesNotMatch(line, /now on air: [^\]]*mood/, 'the incoming identity carries no mood; the brief steers that');
  assert.equal(session.getSession()?.handoffEnded, true, 'persisted with the session');
});

test('a show ending into an autonomous block is a show change too', async () => {
  session.start(context({ id: 'neon', name: 'Neon Nights' }));
  await session.maybeRoll(context(null, 'late-evening', 'calm'));
  assert.match(opener(), /^\[Earlier on air: the show "Neon Nights".*That has ended — now on air: a late-evening block/);
});

test('an autonomous block giving way to a show is a show change too', async () => {
  session.start(context(null, 'evening'));
  await session.maybeRoll(context({ id: 'quiet', name: 'Quiet Hours' }));
  assert.match(opener(), /^\[Earlier on air: a evening block.*That has ended — now on air: the show "Quiet Hours"/);
});

test('the 4h cap within one show is a continuation and keeps its wording', async () => {
  const show = { id: 'marathon', name: 'Marathon' };
  session.start(context(show));
  session.getSession()!.startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  await session.maybeRoll(context(show));
  assert.match(opener(), /^\[Continuing on air from the show "Marathon"/);
  assert.equal(session.getSession()?.handoffEnded, undefined);
});

test('a session written before the flag existed keeps the continuation wording', async () => {
  session.start(context({ id: 'neon', name: 'Neon Nights' }));
  await session.maybeRoll(context({ id: 'quiet', name: 'Quiet Hours' }));
  delete session.getSession()!.handoffEnded;
  assert.match(opener(), /^\[Continuing on air from the show "Neon Nights"/);
});

test('an autonomous soft shift carries no handoff line at all', async () => {
  session.start(context(null, 'afternoon'));
  await session.maybeRoll(context(null, 'evening'));
  assert.doesNotMatch(opener(), /on air/);
});
