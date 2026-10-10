// The DJ Doc rig drawing reads its state from these rules; the drawing itself
// only paints what they decide.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPECTED_SECTIONS,
  RIG_PARTS,
  fixFirstPart,
  partOfSection,
  rigStates,
  sectionAnchor,
  worstStatus,
} from './doctor-rig';
import type { DoctorReport, DoctorReview, DoctorSection, DoctorStatus } from './doctor-queries';

const sec = (name: string, ...statuses: DoctorStatus[]): DoctorSection => ({
  name,
  findings: statuses.map((status, i) => ({ label: `${name} ${i}`, status })),
});
const rep = (...sections: DoctorSection[]): DoctorReport => ({
  t: '2026-10-08T12:00:00.000Z',
  sections,
  counts: { ok: 0, warn: 0, fail: 0, skip: 0 },
});
const allOk = () => rep(...EXPECTED_SECTIONS.map(n => sec(n, 'ok')));

test('every expected section belongs to exactly one part', () => {
  for (const name of EXPECTED_SECTIONS) {
    assert.equal(RIG_PARTS.filter(p => p.sections.includes(name)).length, 1, name);
  }
  assert.equal(RIG_PARTS.flatMap(p => p.sections).length, EXPECTED_SECTIONS.length);
});

test('a section the rig does not know files under the extras', () => {
  assert.equal(partOfSection('Something newer'), 'extras');
});

test('the worst finding wins, and nothing-but-skips is a skip', () => {
  assert.equal(worstStatus(['ok', 'warn', 'ok']), 'warn');
  assert.equal(worstStatus(['skip', 'fail', 'warn']), 'fail');
  assert.equal(worstStatus(['skip', 'skip']), 'skip');
  assert.equal(worstStatus([]), 'skip');
});

test('no report: every part is idle', () => {
  const s = rigStates(null, false);
  assert.deepEqual(Object.values(s), ['idle', 'idle', 'idle', 'idle', 'idle']);
});

test('a live run: arrived parts get verdicts, the next one is on the meter', () => {
  // LLM and Navidrome are back; Broadcast is next, so the mix is measuring.
  // The brain still waits on Tuning, which comes later.
  const s = rigStates(rep(sec('LLM', 'ok'), sec('Navidrome & library', 'warn')), true);
  assert.equal(s.mix, 'measuring');
  assert.equal(s.brain, 'pending');
  assert.equal(s.crate, 'pending');
  assert.equal(s.voice, 'pending');
});

test('a finished run reads each part from all of its sections', () => {
  const r = allOk();
  r.sections[r.sections.findIndex(x => x.name === 'Tuning')] = sec('Tuning', 'ok', 'fail');
  const s = rigStates(r, false);
  assert.equal(s.brain, 'fail');
  assert.equal(s.crate, 'ok');
});

test('the circled part follows DJ Doc\'s top priority when its fix is in the report', () => {
  const r = allOk();
  r.sections[r.sections.findIndex(x => x.name === 'Broadcast')] = sec('Broadcast', 'fail');
  r.sections[r.sections.findIndex(x => x.name === 'Content')] = {
    name: 'Content',
    findings: [{ label: 'jingles', status: 'warn', fix: { id: 'generate-jingles', label: 'Generate jingles' } }],
  };
  const review: DoctorReview = {
    available: true,
    priorities: [{ title: 'Jingles', severity: 'med', why: '', suggestedFix: '', fixId: 'generate-jingles' }],
  };
  const states = rigStates(r, false);
  assert.equal(fixFirstPart(r, review, states), 'crate');
  // Without a review it falls back to the worst part: the failing mix.
  assert.equal(fixFirstPart(r, null, states), 'mix');
});

test('nothing is circled while a run is still coming in, or when all is clean', () => {
  const partial = rep(sec('LLM', 'fail'));
  assert.equal(fixFirstPart(partial, null, rigStates(partial, true)), null);
  const clean = allOk();
  assert.equal(fixFirstPart(clean, null, rigStates(clean, false)), null);
});

test('section anchors are stable slugs', () => {
  assert.equal(sectionAnchor('Navidrome & library'), 'doctor-navidrome-library');
  assert.equal(sectionAnchor('Voice (TTS)'), 'doctor-voice-tts');
});
