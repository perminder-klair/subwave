import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compatDetectedNote, effectiveCompatMode } from '../components/admin/settings/compat-mode';
import { settingsForm } from '../components/admin/settings/form-state';

const hosted = { mode: 'hosted' as const, server: 'hosted-api', evidence: 'model "claude-x" is a cloud model' };
const undecided = { mode: null, server: null, evidence: 'server unreachable' };

test('auto shows the fields of the detected mode, and local until detected', () => {
  assert.equal(effectiveCompatMode('auto', hosted), 'hosted');
  assert.equal(effectiveCompatMode('auto', undecided), 'local');
  assert.equal(effectiveCompatMode('auto', null), 'local');
  assert.equal(effectiveCompatMode('hosted', { ...hosted, mode: 'local' }), 'hosted', 'an explicit choice ignores detection');
  assert.equal(effectiveCompatMode('local', hosted), 'local');
});

test('the detection note names the result only for auto', () => {
  assert.equal(compatDetectedNote('local', hosted), '');
  assert.match(compatDetectedNote('auto', hosted), /Detected: hosted service/);
  assert.match(compatDetectedNote('auto', undecided), /nothing conclusive.*local model/);
  assert.match(compatDetectedNote('auto', null), /Detecting on save/);
});

test('the form keeps auto, and reads anything unknown as local like the controller', () => {
  assert.equal(settingsForm({ llm: { compatibleMode: 'auto', fallback: { compatibleMode: 'auto' } } }).llm.compatibleMode, 'auto');
  assert.equal(settingsForm({ llm: { compatibleMode: 'auto', fallback: { compatibleMode: 'auto' } } }).llm.fallback.compatibleMode, 'auto');
  assert.equal(settingsForm({ llm: { compatibleMode: 'bogus' as never } }).llm.compatibleMode, 'local');
});
