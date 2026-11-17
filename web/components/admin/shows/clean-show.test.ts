import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateShow, showFacets, showPayload } from './lib';
import { showSchema } from '@/lib/schemas.generated';

// The Clean show switch from the stored show to the wire and back. A field left
// out of hydrateShow reads as off in the editor; left out of showPayload, a save
// quietly turns it off. The controller side is pinned by a cold-load round trip
// in controller/scripts/explicit-show-setting.test.ts.

const schema = showSchema({ personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null });
const stored = { id: 's_clean', name: 'Clean Hour', personaId: 'host' };

test('a show from before the switch hydrates and saves as off', () => {
  const show = hydrateShow(stored);
  assert.equal(show.excludeExplicit, false);
  assert.equal(showPayload(show).excludeExplicit, false);
});

test('the switch survives the editor, the payload and the shared schema', () => {
  const show = hydrateShow({ ...stored, excludeExplicit: true });
  assert.equal(show.excludeExplicit, true);
  const parsed = schema.parse(showPayload(show));
  assert.equal(parsed.excludeExplicit, true);
  assert.equal(hydrateShow(parsed).excludeExplicit, true);
});

test('it needs no music filter set, unlike Strict', () => {
  const show = hydrateShow({ ...stored, excludeExplicit: true, filtersStrict: true });
  const payload = showPayload(show);
  assert.equal(payload.filtersStrict, false, 'no filter for Strict to harden');
  assert.equal(payload.excludeExplicit, true);
});

test('a clean show says so on its card, and only then', () => {
  assert.ok(showFacets(hydrateShow({ ...stored, excludeExplicit: true })).some(f => f.key === 'clean'));
  assert.ok(!showFacets(hydrateShow(stored)).some(f => f.key === 'clean'));
});
