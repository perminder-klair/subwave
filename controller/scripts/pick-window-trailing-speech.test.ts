// A segment that airs between the pick event's append and the agent's read of
// the window lands after the ask. The pick window must still end on a user
// turn: current Claude models reject a trailing assistant turn as prefill, and
// the done-tool retry re-sends the same messages, so the whole pick was lost to
// the pool (seen live: a co-host ident aired inside that gap).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-pick-window-'));
process.env.STATE_DIR = root;
const session = await import('../src/broadcast/session.js');
after(() => rmSync(root, { recursive: true, force: true }));

function context() {
  return {
    at: new Date().toISOString(),
    time: { period: 'morning', vibe: 'morning', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm', date: {}, clock: {}, listeners: 1,
    activeShow: { id: 's_wake', name: 'Wake Up Call', topic: '', moods: ['calm'] },
  } as any;
}

const ASK = 'Now playing "Rollin Loud" by Prem Dhillon. Pick the track to play next.';

test('a line aired after the pick ask is followed by a user turn handing the ask back', () => {
  session.start(context());
  session.appendTurn({ role: 'segment', kind: 'link', text: 'Six guests on this one.' });
  session.appendTurn({ role: 'event', kind: 'pick', text: ASK });
  session.appendTurn({ role: 'segment', kind: 'ident', text: 'Klair Radio, still dark out.', meta: { personaId: 'p_guest', personaName: 'Jazz' } });

  const plain = session.windowMessages();
  assert.equal(plain.at(-1)?.role, 'assistant', 'the race this guards: the shared window ends on the aired line');

  const pick = session.pickWindowMessages();
  assert.equal(pick.at(-1)?.role, 'user');
  assert.equal(pick.at(-1)?.content, session.PICK_STILL_OPEN);
  assert.equal(pick.length, plain.length + 1, 'nothing else changes');
  for (let i = 1; i < pick.length; i++) assert.notEqual(pick[i].role, pick[i - 1].role, 'turns still alternate');
});

test('a window that already ends on the ask is untouched', () => {
  session.start(context());
  session.appendTurn({ role: 'segment', kind: 'link', text: 'Six guests on this one.' });
  session.appendTurn({ role: 'event', kind: 'pick', text: ASK });
  assert.deepEqual(session.pickWindowMessages(), session.windowMessages());
});

test('the shared window is not changed, so the request run can still append its own tail', () => {
  session.start(context());
  session.appendTurn({ role: 'event', kind: 'pick', text: ASK });
  session.appendTurn({ role: 'segment', kind: 'ident', text: 'Klair Radio.' });
  assert.ok(!session.windowMessages().some(m => m.content === session.PICK_STILL_OPEN));
});
