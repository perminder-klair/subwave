// Pinned behaviour for the Google key pool's two admin-UI decisions.
//
// Both exist because the obvious version of the code was wrong in a way no other
// test could see: there is no component rendering in this suite, so the logic the
// component depends on is extracted and tested directly.
//
//   • the single-key field is inert while a POOL exists — on the fallback leg as
//     well as the primary, which is where it was missed;
//   • a refetch that FAILED must not unlock the rows, and React Query reports
//     failure by resolving rather than throwing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { googleKeyFieldInert, refetchReconciled, GOOGLE_KEY_VAR } from '../components/admin/settings/googlePoolUi';

const OTHER_VAR = 'OPENAI_API_KEY';

// ─── the single-key field while a pool exists ─────────────────────────────────

test('a configured pool makes the Google key field inert', () => {
  assert.equal(googleKeyFieldInert(GOOGLE_KEY_VAR, 1), true);
  assert.equal(googleKeyFieldInert(GOOGLE_KEY_VAR, 8), true);
});

test('no pool leaves the field editable', () => {
  assert.equal(googleKeyFieldInert(GOOGLE_KEY_VAR, 0), false);
});

test('another provider is never affected by the Google pool', () => {
  assert.equal(googleKeyFieldInert(OTHER_VAR, 5), false);
  assert.equal(googleKeyFieldInert(undefined, 5), false);
});

test('the FALLBACK leg is guarded, which is where it was missed', () => {
  // googleKeyFetch is installed on every `google` client the registry builds and
  // consults one process-wide pool, so a pool is the fallback leg's only
  // credential too. The primary field was greyed out saying so while this one
  // still accepted a save that nothing would ever read.
  assert.equal(googleKeyFieldInert(GOOGLE_KEY_VAR, 1), true);

  // And the component must actually route BOTH fields through it — the predicate
  // existing proves nothing on its own, which is exactly how the first version of
  // this passed while the fallback field stayed editable. Two call sites, one in
  // each leg.
  const src = readFileSync(new URL('../components/admin/settings/LlmSection.tsx', import.meta.url), 'utf8');
  const uses = src.match(/googleKeyFieldInert\(/g) ?? [];
  assert.equal(uses.length, 2, `expected one call site per leg, found ${uses.length}`);

  // Anchored on the fallback field specifically. A bare `indexOf` for the hint
  // text finds the PRIMARY field's copy — it is the earlier of the two — and the
  // assertion then passes against a fallback field that says nothing.
  const labelAt = src.indexOf('llmProviderLabel(form.llm.fallback.provider)} API key');
  const fallbackBlock = src.slice(labelAt, src.indexOf('Backup model', labelAt));
  assert.ok(labelAt > 0 && fallbackBlock.length > 0, 'the fallback key field must be locatable');
  assert.match(fallbackBlock, /disabled=\{poolActive\}/, 'the fallback key input must be disabled while a pool exists');
  assert.match(fallbackBlock, /Not used while a key pool/, 'and must say why, like the primary field does');
  assert.match(fallbackBlock, /on this leg as well as the primary/, 'and must be honest that the pool covers this leg too');
});

// ─── a failed refetch must not unlock the rows ────────────────────────────────

test('a refetch that failed keeps the rows locked', () => {
  // The whole finding. `postAndRefresh` treated "did not throw" as success, and
  // React Query resolves with isError rather than throwing, so a failed refresh
  // cleared `desynced` and re-enabled every control against a list the screen no
  // longer matched.
  assert.equal(refetchReconciled({ isError: true, error: new Error('boom') }), false);
  assert.equal(refetchReconciled({ status: 'error', error: new Error('boom') }), false);
});

test('a refetch that succeeded unlocks the rows', () => {
  assert.equal(refetchReconciled({ isError: false, data: {} }), true);
  assert.equal(refetchReconciled({ status: 'success', data: {} }), true);
});

test('a missing refetch is not treated as a failure', () => {
  // `onChanged` is optional, and several callers pass nothing. Absence of a
  // refetch is not a failed refetch — locking the rows for it would be a
  // regression in the other direction.
  assert.equal(refetchReconciled(undefined), true);
  assert.equal(refetchReconciled(null), true);
});

test('the editor inspects the refetch outcome rather than only its absence of a throw', () => {
  const src = readFileSync(new URL('../components/admin/settings/GoogleKeyPoolEditor.tsx', import.meta.url), 'utf8');
  assert.match(src, /refetchReconciled\(/, 'the editor must consult the predicate');
  assert.match(
    src,
    /const result = await onChanged\?\.\(\);[\s\S]{0,120}refetchReconciled\(result\)/,
    'it must capture the refetch RESULT and pass it in — `await onChanged?.()` alone discards it',
  );
  // The prop type has to permit a return value or the signal is erased by the type
  // while still looking correct at every call site.
  assert.match(src, /onChanged\?: \(\) => unknown/, 'the prop must be able to return the outcome');
});