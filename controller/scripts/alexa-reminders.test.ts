import assert from 'node:assert/strict';
import test from 'node:test';

const { reminderOffsetSeconds, reminderEtaAllowed } = await import('../src/alexa/reminders.js');

test('reminder ETA policy accepts only the bounded queue forecast', () => {
  assert.equal(reminderEtaAllowed(120), true);
  assert.equal(reminderEtaAllowed(1800), true);
  assert.equal(reminderEtaAllowed(119), false);
  assert.equal(reminderEtaAllowed(1801), false);
  assert.equal(reminderEtaAllowed(null), false);
  assert.equal(reminderEtaAllowed(Number.NaN), false);
});

test('reminder is scheduled one minute before the forecast', () => {
  assert.equal(reminderOffsetSeconds(120), 60);
  assert.equal(reminderOffsetSeconds(181), 121);
});
