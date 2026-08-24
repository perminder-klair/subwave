import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { refreshDiscoveryQuery } from './discovery-queries';

test('manual discovery refresh aborts and supersedes an in-flight same-key probe', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ['discovery', 'models', { provider: 'ollama' }] as const;
  let firstAborted = false;
  let requests = 0;
  const queryFn = ({ signal }: { signal: AbortSignal }) => {
    requests++;
    if (requests === 1) {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          firstAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
    return Promise.resolve('fresh');
  };

  const first = client.fetchQuery({ queryKey: key, queryFn }).catch(() => undefined);
  const result = await refreshDiscoveryQuery(client, key, queryFn);
  await first;

  assert.equal(firstAborted, true);
  assert.equal(requests, 2);
  assert.equal(result, 'fresh');
});
