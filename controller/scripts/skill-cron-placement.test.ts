// Pins how a per-skill `cron:` fire speaks once its gates pass
// (scheduler.speakSkillCron, #2259).
//
// Two directions, and the OFF one is the one that matters most:
//
//  - SWITCH OFF IS THE PRE-#2259 STATION. djTalkOnlyBetweenTracks defaults off,
//    so this is every default install. The fire takes no claim and enters NO
//    talk-air scope. A scope is what suppressScheduledSpeechDuringHandoff and
//    the queue's one-boundary rule key on, so wrapping the immediate path would
//    start dropping cron speech during a show handoff on stations that never
//    touched the switch.
//  - SWITCH ON, the fire claims the boundary, speaks inside the 'next-track'
//    scope, and stands down before generating while a clip waits.
//
// STATE_DIR is redirected before the first import, like skill-cron-gates.test.ts.
//
// Run: `npm test -- skill-cron-placement`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-skill-cron-placement-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { speakSkillCron } = await import('../src/broadcast/scheduler.js');
const { currentTalkAir, inTalkAirScope, scheduledTalkAir, suppressScheduledSpeechDuringHandoff } =
  await import('../src/broadcast/talk-air.js');

const clip = (text: string) => [{ text, wavPath: join(root, `${text}.wav`), persona: null, meta: {} }];

// What the skill's speech would see from inside the fire.
async function fire(kind = 'news') {
  let seen: { air: string; scoped: boolean; droppedDuringHandoff: boolean } | null = null;
  await speakSkillCron(kind, scheduledTalkAir(), async () => {
    seen = {
      air: currentTalkAir(),
      scoped: inTalkAirScope(),
      droppedDuringHandoff: suppressScheduledSpeechDuringHandoff(kind, true),
    };
  });
  return seen;
}

test('with the switch off a cron fire speaks outside any scope, as before #2259', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: false } as never);
  queue._pendingVoice = null;
  assert.deepEqual(await fire(), { air: 'immediate', scoped: false, droppedDuringHandoff: false },
    'a default station keeps airing cron speech during a show handoff');
});

test('with the switch off a waiting clip does not stand the fire down', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: false } as never);
  queue._pendingVoice = null;
  queue.holdForNextTrack('station-id', clip('ident'));
  assert.notEqual(await fire(), null, 'no claim and no stand-down with the switch off');
  queue._pendingVoice = null;
});

test('with the switch on a cron fire speaks inside the next-track scope', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  queue._pendingVoice = null;
  assert.deepEqual(await fire(), { air: 'next-track', scoped: true, droppedDuringHandoff: true });
});

test('with the switch on a cron fire stands down before generating while a clip waits', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  queue._pendingVoice = null;
  queue.holdForNextTrack('station-id', clip('ident'));
  assert.equal(await fire(), null, 'the skill never ran');
  assert.equal(queue.pendingVoiceTalk()?.kind, 'station-id', 'and the ident keeps the boundary');
  queue._pendingVoice = null;
});

test.after(async () => {
  queue._pendingVoice = null;
  await settings.update({ djTalkOnlyBetweenTracks: false } as never);
  await removeTempDir(root);
});
