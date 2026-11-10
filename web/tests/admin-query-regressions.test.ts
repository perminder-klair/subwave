import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { fetchDashStatus } from '../components/admin/dash/queries';
import { patchSettingsAudio, settingsKeys } from '../components/admin/settings/queries';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('dash status keeps healthy endpoint data when one response is degraded', async () => {
  const fetcher = async (path: string) => {
    if (path === '/now-playing') return jsonResponse({ nowPlaying: { title: 'Still live' } });
    if (path === '/state') return jsonResponse({ error: 'state rolling' }, 503);
    if (path === '/session') return jsonResponse({ messages: [{ role: 'assistant', content: 'On air' }] });
    throw new Error(`unexpected path: ${path}`);
  };

  const result = await fetchDashStatus(fetcher, new AbortController().signal);

  assert.equal(result.nowPlaying?.title, 'Still live');
  assert.deepEqual(result.queue, { error: 'state rolling' });
  assert.equal(result.sessionMessages?.length, 1);
});

test('library audio writes update the shared settings resource', () => {
  const client = new QueryClient();
  client.setQueryData(settingsKeys.detail(), {
    values: { audio: { embeddings: false, vocalActivity: false } },
  });

  patchSettingsAudio(client, { embeddings: true });

  assert.deepEqual(client.getQueryData(settingsKeys.detail()), {
    values: { audio: { embeddings: true, vocalActivity: false } },
  });
});
