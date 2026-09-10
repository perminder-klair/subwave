// Pins the programme-outro timing dial. Persona handoffs use the final-track
// boundary model instead; they do not require a closing spacer track.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-handover-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { handoverOffsetMinutes, handoverStatus } = await import('../src/broadcast/handover-policy.js');
const { beatWindow } = await import('../src/broadcast/programme-pure.js');
const { TALK_SLOTS, talkSlot } = await import('../src/broadcast/talk-scheduler.js');
const { HANDOVER_OFFSET_BOUNDS, HANDOVER_OFFSET_STEP_MINUTES } =
  await import('../src/schemas/settings.js');
const { setCache } = await import('../src/settings/store.js');

test('the offset defaults to the established :55 programme-outro window', async () => {
  await settings.load();
  assert.equal(handoverOffsetMinutes(), 5);
  assert.equal(beatWindow(55, handoverOffsetMinutes(), HANDOVER_OFFSET_STEP_MINUTES), 'outro');
  assert.equal(beatWindow(54, handoverOffsetMinutes(), HANDOVER_OFFSET_STEP_MINUTES), null);
  assert.equal(handoverStatus().offsetMinutes, 5);
});

test('the offset moves the programme-outro window without widening it', async () => {
  await settings.update({ handover: { offsetMinutes: 15 } } as never);
  assert.equal(beatWindow(45, 15, HANDOVER_OFFSET_STEP_MINUTES), 'outro');
  assert.equal(beatWindow(55, 15, HANDOVER_OFFSET_STEP_MINUTES), null);
  await settings.update({ handover: { offsetMinutes: 5 } } as never);
});

test('the save path rejects offsets the sparse programme row cannot sample', async () => {
  await assert.rejects(() => settings.update({ handover: { offsetMinutes: 7 } } as never), /multiple of 5/);
  await assert.rejects(() => settings.update({ handover: { offsetMinutes: 0 } } as never), /handover\.offsetMinutes must be int/);
  await assert.rejects(() => settings.update({ handover: { offsetMinutes: 25 } } as never), /handover\.offsetMinutes must be int/);
});

test('missing or malformed persisted values repair to the safe default', async () => {
  const path = join(root, 'settings.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  for (const raw of [undefined, 7, 0, 45, '10', null]) {
    if (raw === undefined) delete stored.handover;
    else stored.handover = { offsetMinutes: raw };
    writeFileSync(path, JSON.stringify(stored));
    setCache(null);
    await settings.load();
    assert.equal(handoverOffsetMinutes(), 5, `stored ${String(raw)} repairs to 5`);
  }
});

test('every permitted offset is sampled exactly once in every station-zone offset', () => {
  const row = talkSlot('programme', TALK_SLOTS);
  assert.equal(row.stride, HANDOVER_OFFSET_STEP_MINUTES);
  for (let off = HANDOVER_OFFSET_BOUNDS.min; off <= HANDOVER_OFFSET_BOUNDS.max; off += HANDOVER_OFFSET_STEP_MINUTES) {
    for (let zone = 0; zone < 60; zone += 15) {
      let hits = 0;
      for (let processMin = 0; processMin < 60; processMin += row.stride) {
        if (beatWindow((processMin + zone) % 60, off, HANDOVER_OFFSET_STEP_MINUTES) === 'outro') hits++;
      }
      assert.equal(hits, 1, `offset ${off}, zone +${zone}`);
    }
  }
});

test('the largest permitted offset leaves the programme feature window intact', () => {
  for (let off = HANDOVER_OFFSET_BOUNDS.min; off <= HANDOVER_OFFSET_BOUNDS.max; off += HANDOVER_OFFSET_STEP_MINUTES) {
    for (let minute = 35; minute < 40; minute++) {
      assert.equal(beatWindow(minute, off, HANDOVER_OFFSET_STEP_MINUTES), 'feature');
    }
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
