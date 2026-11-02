import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// embeddingFormatStale is raised for any format older than the controller's, and an
// index that skipped a version shows the same banner. So its copy can't describe one
// bump: a format 3 index already carries the measured sound the first version added.
const panel = readFileSync(new URL('./LibraryTaggingPanel.tsx', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ');

test('the stale-format banner claims nothing that only one older format made true', () => {
  for (const claim of ['sound descriptors', 'label-heavy', 'wasn&rsquo;t part of the text']) {
    assert.ok(!panel.includes(claim), `the banner still says "${claim}"`);
  }
  assert.ok(panel.includes('Your similarity vectors use an older track description.'));
  assert.ok(panel.includes('Your vectors also use an older track description'));
});
