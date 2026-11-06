import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { STATE_DIR } from '../src/config.js';
import { isCoreReleaseGroup, latestCoreReleaseGroup, type MbReleaseGroup } from '../src/music/musicbrainz.js';
import { dateIsNotFuture, lookupLatestRelease } from '../src/music/request-release.js';
import * as settings from '../src/settings.js';
import { seedDailyUsageFromLog } from '../src/llm/log.js';

const now = new Date('2026-10-24T12:00:00Z');

test('core release filtering excludes non-core release types and future dates', () => {
  assert.equal(isCoreReleaseGroup({ 'primary-type': 'Single' }, 'single'), true);
  assert.equal(isCoreReleaseGroup({ 'primary-type': 'Album', 'secondary-types': ['Compilation'] }, 'album'), false);
  assert.equal(isCoreReleaseGroup({ 'primary-type': 'Single', 'secondary-types': ['Live'] }, 'single'), false);
  assert.equal(latestCoreReleaseGroup([
    { id: 'future', title: 'Future', 'primary-type': 'Single', 'first-release-date': '2026-11-01' },
    { id: 'live', title: 'Live', 'primary-type': 'Single', 'secondary-types': ['Live'], 'first-release-date': '2026-10-01' },
  ], 'single', now), null);
});

test('latest core release uses date, precision, title, then id as deterministic ties', () => {
  const groups: MbReleaseGroup[] = [
    { id: 'b', title: 'Zeta', 'primary-type': 'Single', 'first-release-date': '2026-10' },
    { id: 'a', title: 'Alpha', 'primary-type': 'Single', 'first-release-date': '2026-10-24' },
    { id: 'c', title: 'Alpha', 'primary-type': 'Single', 'first-release-date': '2026-10-24' },
  ];
  assert.equal(latestCoreReleaseGroup(groups, 'single', now)?.id, 'a');
});

test('partial release dates are compared at their declared precision and invalid dates are rejected', () => {
  assert.equal(dateIsNotFuture('2026', now), true);
  assert.equal(dateIsNotFuture('2027', now), false);
  assert.equal(dateIsNotFuture('2026-10', now), true);
  assert.equal(dateIsNotFuture('2026-11', now), false);
  assert.equal(dateIsNotFuture('2026-10-24', now), true);
  assert.equal(dateIsNotFuture('2026-10-25', now), false);
  assert.equal(dateIsNotFuture('2026-02-31', now), false);
});

test('ambiguous web evidence stops before the latest-release model call', async (t) => {
  await settings.load();
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  let modelCalls = 0;
  try {
    await settings.update({
      llm: {
        provider: 'openai-compatible', model: 'fixture-model', compatibleMode: 'local',
        baseUrl: 'http://llm.latest-ambiguous.fixture/v1', fallback: { enabled: false },
      },
      search: { provider: 'searxng', baseUrl: 'http://search.latest-ambiguous.fixture' },
    } as never);
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'musicbrainz.org') return Response.json({ artists: [] });
      if (url.hostname === 'search.latest-ambiguous.fixture') {
        return Response.json({ results: [{
          title: 'Ambiguous Artist latest single',
          content: 'Ambiguous Artist released a new single in 2026.',
          url: 'https://one-source.example/ambiguous-artist',
        }] });
      }
      if (url.hostname === 'llm.latest-ambiguous.fixture') {
        modelCalls++;
        return Response.json({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await lookupLatestRelease('Ambiguous Artist', 'single');
    assert.deepEqual(result, { status: 'unavailable', reason: 'ambiguous', provider: 'searxng' });
    assert.equal(modelCalls, 0, 'ambiguous evidence must not spend a model call');
  } finally {
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('latest-release model evidence is gated at the hard request budget', async (t) => {
  await settings.load();
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  let modelCalls = 0;
  try {
    await settings.update({
      llm: {
        provider: 'openai-compatible', model: 'fixture-model', compatibleMode: 'local',
        baseUrl: 'http://llm.latest-budget.fixture/v1', fallback: { enabled: false },
        dailyTokenCap: 1, exemptRequests: false,
      },
      search: { provider: 'searxng', baseUrl: 'http://search.latest-budget.fixture' },
    } as never);
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(`${STATE_DIR}/logs`, { recursive: true });
    await writeFile(`${STATE_DIR}/logs/events-${day}.jsonl`, `${JSON.stringify({ type: 'llm', usage: { total: 2 } })}\n`);
    await seedDailyUsageFromLog();
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'musicbrainz.org') return Response.json({ artists: [] });
      if (url.hostname === 'search.latest-budget.fixture') {
        return Response.json({ results: [
          {
            title: 'Budget Artist latest single',
            content: 'Budget Artist released Budget Single in 2026.',
            url: 'https://first-source.example/budget-artist',
          },
          {
            title: 'Budget Single by Budget Artist',
            content: 'Budget Artist latest official single, Budget Single, arrived in 2026.',
            url: 'https://second-source.example/budget-single',
          },
        ] });
      }
      if (url.hostname === 'llm.latest-budget.fixture') {
        modelCalls++;
        return Response.json({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await lookupLatestRelease('Budget Artist', 'single');
    assert.deepEqual(result, { status: 'unavailable', reason: 'provider-error', provider: 'budget' });
    assert.equal(modelCalls, 0, 'the hard budget must block latest-release model evidence');
  } finally {
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});
