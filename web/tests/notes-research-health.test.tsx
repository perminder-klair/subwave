import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NotesResearchProgress,
  researchLooksStalled,
  type ResearchProgress,
} from '../components/admin/NotesResearchHealth';
const now = Date.parse('2026-10-22T18:00:00Z');
const old = '2026-10-22T09:00:00Z';
const progress: ResearchProgress = {
  lastCompletedAt: old,
  lastSourceAt: old,
  nextRetryAt: null,
  oldestPendingAt: old,
};
test('long unexplained stalls are visible but ordinary pauses and new work do not raise warnings', () => {
  assert.equal(researchLooksStalled(progress, 'broadcast', true, now), true);
  for (const reason of ['disabled', 'operator-paused', 'token-budget', 'listeners'])
    assert.equal(researchLooksStalled(progress, reason, true, now), false);
  assert.equal(researchLooksStalled(progress, null, false, now), false);
  assert.equal(
    researchLooksStalled({ ...progress, lastSourceAt: '2026-10-22T17:00:00Z' }, null, true, now),
    false,
  );
  assert.equal(
    researchLooksStalled(
      { ...progress, lastCompletedAt: null, lastSourceAt: null, oldestPendingAt: null },
      null,
      true,
      now,
    ),
    false,
  );
});
test('operator explanations name the real broadcast gate and distinguish source collection from extraction', () => {
  const html = renderToStaticMarkup(
    <NotesResearchProgress progress={progress} reason="broadcast" ready now={now} />,
  );
  assert.match(html, /broadcast-critical work/);
  assert.match(html, /Last source collected/);
  assert.match(html, /Last research completed/);
  assert.match(html, /No research progress/);
});
