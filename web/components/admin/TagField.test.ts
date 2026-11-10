import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tagDraftBlocksSave } from './TagField';

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

test('a malformed pending tag blocks the editor save gate', () => {
  assert.equal(tagDraftBlocksSave('bad tag', TAG_RE), true);
  assert.equal(tagDraftBlocksSave('late-night', TAG_RE), false);
  assert.equal(tagDraftBlocksSave('   ', TAG_RE), false);
});
