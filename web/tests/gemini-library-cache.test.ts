import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import {
  fetchLibraryPage,
  flattenLibraryPages,
  geminiLibraryKeys,
  resetGeminiLibraryDefaults,
  type LibraryInput,
  type LibraryPage,
} from '../components/admin/tts/geminiLibraryQueries';
import type { AdminFetch } from '../lib/admin-query';

function options(fetcher: AdminFetch, input: LibraryInput = {}) {
  return {
    queryKey: geminiLibraryKeys.catalogue(input),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      fetchLibraryPage(fetcher, input, pageParam, signal),
    getNextPageParam: (last: LibraryPage) => last.nextPageToken,
    staleTime: 5 * 60_000,
  };
}

test('a failed next page keeps rows and its cursor, exposes the error, and can retry', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: Array<string | null> = [];
  const fetcher: AdminFetch = async path => {
    const token = new URL(path, 'http://station.test').searchParams.get('pageToken');
    requests.push(token);
    if (!token) {
      return Response.json({ ok: true, voices: [{ id: 'en-us-varo', label: 'Varo' }], nextPageToken: 'page2' });
    }
    if (requests.length === 2) {
      return Response.json({ ok: false, voices: [], error: 'Voice library HTTP 503: unavailable' });
    }
    return Response.json({ ok: true, voices: [{ id: 'en-au-advisor-1', label: 'Advisor' }] });
  };
  const observer = new InfiniteQueryObserver(client, options(fetcher));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    await observer.fetchNextPage();
    const failed = observer.getCurrentResult();
    assert.equal(failed.isFetchNextPageError, true);
    assert.match(failed.error?.message ?? '', /503: unavailable/);
    assert.equal(failed.hasNextPage, true, 'the failed page must not consume the cursor');
    assert.equal(failed.data?.pages.length, 1);
    assert.deepEqual(flattenLibraryPages(failed.data?.pages).voices.map(v => v.id), ['en-us-varo']);

    await observer.fetchNextPage();
    const retried = observer.getCurrentResult();
    assert.equal(retried.isError, false);
    assert.equal(retried.hasNextPage, false);
    assert.deepEqual(requests, [null, 'page2', 'page2']);
    assert.deepEqual(flattenLibraryPages(retried.data?.pages).voices.map(v => v.id),
      ['en-us-varo', 'en-au-advisor-1']);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('a saved language change clears default pages and cursors while preserving explicit filters', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let savedLanguage = 'en-US';
  const requests: Array<{ language: string; token: string | null }> = [];
  const fetcher: AdminFetch = async path => {
    const query = new URL(path, 'http://station.test').searchParams;
    const language = query.get('language') ?? savedLanguage;
    const token = query.get('pageToken');
    requests.push({ language, token });
    assert.ok(!token || token === `${language}-page2`, 'a cursor must stay with its language');
    return Response.json({
      ok: true,
      voices: [{ id: `${language}-voice`, label: language }],
      ...(!token ? { nextPageToken: `${language}-page2` } : {}),
    });
  };
  const defaultOptions = options(fetcher);
  const explicitOptions = options(fetcher, { language: 'en-GB' });
  const everyOptions = options(fetcher, { language: 'any' });
  try {
    await client.fetchInfiniteQuery(defaultOptions);
    const explicit = await client.fetchInfiniteQuery(explicitOptions);
    const every = await client.fetchInfiniteQuery(everyOptions);

    savedLanguage = 'en-AU';
    await resetGeminiLibraryDefaults(client);
    assert.equal(client.getQueryData(defaultOptions.queryKey), undefined);
    assert.equal(client.getQueryData(explicitOptions.queryKey), explicit);
    assert.equal(client.getQueryData(everyOptions.queryKey), every);

    const reopened = await client.fetchInfiniteQuery(defaultOptions);
    assert.equal(reopened.pages[0]?.voices[0]?.label, 'en-AU');
    const observer = new InfiniteQueryObserver(client, defaultOptions);
    await observer.fetchNextPage();
    assert.deepEqual(requests.slice(-2), [
      { language: 'en-AU', token: null },
      { language: 'en-AU', token: 'en-AU-page2' },
    ]);

    savedLanguage = '';
    await resetGeminiLibraryDefaults(client);
    const cleared = await client.fetchInfiniteQuery(defaultOptions);
    assert.equal(cleared.pages[0]?.voices[0]?.label, '', 'clearing the default also clears cached pages');
  } finally {
    client.clear();
  }
});

test('a default reset cancels an old page in flight and restarts mounted queries at page one', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let savedLanguage = 'en-US';
  let pendingSignal: AbortSignal | undefined;
  let releasePage: (() => void) | undefined;
  let pageStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { pageStarted = resolve; });
  const requests: Array<{ language: string; token: string | null }> = [];
  const fetcher: AdminFetch = async (path, init) => {
    const token = new URL(path, 'http://station.test').searchParams.get('pageToken');
    const language = savedLanguage;
    requests.push({ language, token });
    if (token) {
      pendingSignal = init?.signal ?? undefined;
      await new Promise<void>(resolve => { releasePage = resolve; pageStarted?.(); });
    }
    return Response.json({
      ok: true, voices: [{ id: `${language}-voice`, label: language }],
      ...(!token ? { nextPageToken: `${language}-page2` } : {}),
    });
  };
  const observer = new InfiniteQueryObserver(client, options(fetcher));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    const oldPage = observer.fetchNextPage();
    await started;
    savedLanguage = 'en-AU';
    await resetGeminiLibraryDefaults(client);
    assert.equal(pendingSignal?.aborted, true);
    releasePage?.();
    await oldPage;

    const current = observer.getCurrentResult();
    assert.equal(current.data?.pages.length, 1);
    assert.equal(current.data?.pages[0]?.voices[0]?.label, 'en-AU');
    assert.equal(current.data?.pages[0]?.nextPageToken, 'en-AU-page2');
    assert.deepEqual(requests, [
      { language: 'en-US', token: null },
      { language: 'en-US', token: 'en-US-page2' },
      { language: 'en-AU', token: null },
    ]);
  } finally {
    releasePage?.();
    unsubscribe();
    client.clear();
  }
});
