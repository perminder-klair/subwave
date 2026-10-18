// A persona Delete persists immediately (#1950), through DELETE /personas/:id,
// the way the Shows panel's delete already did. Before, it was a local form
// edit that reached the station only when some editor's Save persona was
// pressed, and a reload silently undid it.
//
// Two pure halves of the panel's success path are pinned here: where the local
// "default" lands, and which caches the controller's receipt reaches. The
// route itself (404 / 409 / the cascade / persistence) is pinned controller-side
// by scripts/persona-delete.test.ts. The panel wiring (the row leaves only after
// the write, the baseline moves with it so other unsaved edits stay unsaved)
// needs a DOM, which web/ has no test environment for.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { activeAfterDelete } from './helpers';
import { patchPersonaDelete } from './queries';
import { settingsKeys } from '../settings/queries';
import { dashKeys } from '../dash/queries';
import { scheduleKeys } from '../schedule/queries';
import type { SettingsResponse } from './types';

const remainingIds = ['p_a', 'p_b'];

test('deleting the default follows the controller re-point', () => {
  assert.equal(activeAfterDelete({
    current: 'p_gone', deletedId: 'p_gone', baselineActive: 'p_gone', serverActive: 'p_b', remainingIds,
  }), 'p_b');
});

test('an untouched default that survives the delete stays', () => {
  assert.equal(activeAfterDelete({
    current: 'p_b', deletedId: 'p_gone', baselineActive: 'p_b', serverActive: 'p_b', remainingIds,
  }), 'p_b');
});

test('an unsaved "Set as default" survives a delete of some other persona', () => {
  // The operator picked p_a locally (unsaved); the stored default is p_b.
  // Deleting a third persona must neither save nor lose that choice.
  assert.equal(activeAfterDelete({
    current: 'p_a', deletedId: 'p_gone', baselineActive: 'p_b', serverActive: 'p_b', remainingIds,
  }), 'p_a');
  // Even when the delete removed the STORED default (p_gone) and the controller
  // re-pointed it to p_b, the unsaved local choice p_a still wins locally.
  assert.equal(activeAfterDelete({
    current: 'p_a', deletedId: 'p_gone', baselineActive: 'p_gone', serverActive: 'p_b', remainingIds,
  }), 'p_a');
});

test('an unsaved default that named the deleted persona falls back to the stored one', () => {
  assert.equal(activeAfterDelete({
    current: 'p_gone', deletedId: 'p_gone', baselineActive: 'p_a', serverActive: 'p_a', remainingIds,
  }), 'p_a');
});

test('a never-saved persona (404, no receipt) falls back to the baseline, then the first row', () => {
  assert.equal(activeAfterDelete({
    current: 'p_new', deletedId: 'p_new', baselineActive: 'p_b', serverActive: null, remainingIds,
  }), 'p_b');
  assert.equal(activeAfterDelete({
    current: 'p_new', deletedId: 'p_new', baselineActive: null, serverActive: null, remainingIds,
  }), 'p_a');
});

function seededClient() {
  const client = new QueryClient();
  client.setQueryData<SettingsResponse>(settingsKeys.detail(), {
    onAir: { personaId: 'p_gone', show: { id: 's_late', name: 'Late Night' } },
    values: {
      personas: [{ id: 'p_a', name: 'A' }, { id: 'p_gone', name: 'Gone' }],
      activePersonaId: 'p_gone',
      shows: [{ id: 's_late', name: 'Late Night', personaId: 'p_gone' }],
      djHouseRules: 'keep it short',
    },
  } as SettingsResponse);
  client.setQueryData(dashKeys.takeover(), {
    shows: [{ id: 's_late', name: 'Late Night' }],
    override: { showId: 's_late', startedAt: 1, expiresAt: 2 },
  });
  client.setQueryData(scheduleKeys.override(), { override: { showId: 's_late', startedAt: 1, expiresAt: 2 } });
  return client;
}

test('the receipt patches the settings envelope, the shows reconciler and both takeover views', () => {
  const client = seededClient();
  patchPersonaDelete(client, {
    personas: [{ id: 'p_a', name: 'A' }],
    activePersonaId: 'p_a',
    shows: [],
    schedule: { 0: Array.from({ length: 24 }, () => null) } as never,
    scheduleOverride: null,
  });

  const settings = client.getQueryData<SettingsResponse>(settingsKeys.detail())!;
  assert.deepEqual(settings.values?.personas?.map(p => p.id), ['p_a']);
  assert.equal(settings.values?.activePersonaId, 'p_a');
  assert.deepEqual(settings.values?.shows, []);
  // Untouched keys ride along.
  assert.equal(settings.values?.djHouseRules, 'keep it short');
  // The deleted persona was on air through its own show, which is gone.
  assert.deepEqual(settings.onAir, { personaId: 'p_a', show: null });

  // patchShowSettings fed the Dashboard picker the surviving shows.
  assert.deepEqual((client.getQueryData(dashKeys.takeover()) as { shows: unknown[] }).shows, []);
  // Both takeover views are stale now, so they re-read rather than trust a pin
  // the sweep may have cleared.
  assert.equal(client.getQueryState(dashKeys.takeover())?.isInvalidated, true);
  assert.equal(client.getQueryState(scheduleKeys.override())?.isInvalidated, true);
});

test('an on-air persona that survives the delete keeps its onAir entry', () => {
  const client = seededClient();
  client.setQueryData<SettingsResponse>(settingsKeys.detail(), prev => ({
    ...prev!, onAir: { personaId: 'p_a', show: null },
  }));
  patchPersonaDelete(client, { personas: [{ id: 'p_a', name: 'A' }], activePersonaId: 'p_a', shows: [] });
  assert.deepEqual(client.getQueryData<SettingsResponse>(settingsKeys.detail())!.onAir, { personaId: 'p_a', show: null });
});

test('takeover views that were never cached are not seeded', () => {
  // writeTakeoverOverride would create a Dashboard entry with an empty picker.
  const client = new QueryClient();
  patchPersonaDelete(client, { personas: [{ id: 'p_a' }], activePersonaId: 'p_a', shows: [], scheduleOverride: null });
  assert.equal(client.getQueryData(dashKeys.takeover()), undefined);
  assert.equal(client.getQueryData(scheduleKeys.override()), undefined);
  assert.equal(client.getQueryData(settingsKeys.detail()), undefined);
});
