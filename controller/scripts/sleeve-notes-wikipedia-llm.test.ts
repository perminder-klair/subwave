import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, type TestContext } from 'node:test';
import type { ResearchJob } from '../src/sleeve-notes/researcher.js';

const previousStateDir = process.env.STATE_DIR;
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-wikipedia-llm-'));
process.env.STATE_DIR = stateRoot;

const store = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { recentCalls } = await import('../src/llm/log.js');
const { LlmResearcher } = await import('../src/sleeve-notes/llm-researcher.js');
const { wikipediaCandidatesFromSparks } = await import('../src/sleeve-notes/wikipedia-extract.js');
const { screenResearchCandidates } = await import('../src/sleeve-notes/researcher.js');
const previousCache = store.peek();

after(async () => {
  store.setCache(previousCache);
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
  await removeTempDir(stateRoot);
});

const artistClaim = {
  wording: 'Example Band recorded the album Bright Days in a converted barn.',
  category: 'release-stories', airtimeScope: 'matching-release-only',
  matchingReleaseTitle: 'Bright Days'};
const job: ResearchJob = {
  id: 'wiki-extract-test', subjectKind: 'artist',
  document: {
    id: 'source-test', entityId: 'artist-test', entityName: 'Example Band',
    provider: 'wikipedia', sourceUrl: 'https://en.wikipedia.org/wiki/Example_Band',
    revisionId: '1', text: artistClaim.wording},
  categories: ['artist-stories', 'release-stories', 'track-stories', 'musical-connections', 'milestones', 'recognition'],
  maxCandidates: 20, wikiNumber: 2};

type Options = { tools?: Array<{ name: string }> };
function configure(t: TestContext, provider: string, answer: unknown, recovery = false, inspect: (options: Options)=>void = ()=>{}) {
  const defaults = settings.getDefaults();
  store.setCache({ ...defaults, llm: {
    ...defaults.llm, provider, model: 'wikipedia-test', baseUrl: 'http://wikipedia-test.invalid/v1',
    fallback: { ...defaults.llm.fallback, enabled: false }} });
  recentCalls.length = 0;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected provider traffic'); });
  const leg = primaryLeg();
  let calls = 0;
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model, 'doGenerate', async (options: Options) => {
      inspect(options);
      const declined = recovery && calls === 0;
      calls++;
      const emit = !declined && options.tools?.some((tool) => tool.name === 'emit');
      return {
        content: emit
          ? [{ type: 'tool-call', toolCallId: 'wiki-claims', toolName: 'emit', input: JSON.stringify(answer) }]
          : [{ type: 'text', text: declined ? 'Here are the facts, without their metadata.' : JSON.stringify(answer) }],
        finishReason: { unified: emit ? 'tool-calls' : 'stop', raw: emit ? 'tool_calls' : 'stop' },
        usage: {
          inputTokens: { total: 2400, noCache: 2400, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100, text: 100, reasoning: 0 }},
        warnings: []};
    });
  }
  return () => calls;
}

for (const provider of ['openai', 'openai-compatible', 'ollama']) {
  test(`Wikipedia artist extraction reads the decoded ${provider} object and reports context usage`, async (t) => {
    const calls = configure(t, provider, { claims: [artistClaim] });
    const usage: Array<{ input: number; output: number }> = [];
    const result = await new LlmResearcher().extractWikipediaSparks(job, 'Recording',
      new AbortController().signal, 'Choose up to {wikiNumber} music stories.', (value) => usage.push(value));
    assert.deepEqual(result.claims, [artistClaim]);
    const candidates = wikipediaCandidatesFromSparks(result.claims, job.document.text, 'artist');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].airtimeScope, 'matching-release-only');
    assert.equal(candidates[0].matchingReleaseTitle, 'Bright Days');
    assert.equal(screenResearchCandidates(job, candidates).accepted.length, 1);
    assert.match(result.rawResponse, /Category: release-stories\nScope: matching-release-only\nMatching release title: Bright Days/);
    assert.deepEqual(usage, [{ input: 2400, output: 100 }]);
    assert.equal(calls(), 1);
  });
}

test('Wikipedia object recovery preserves claims and uses one prompt context for adaptive calibration', async (t) => {
  const calls = configure(t, 'openai-compatible', { claims: [artistClaim] }, true);
  const usage: Array<{ input: number; output: number }> = [];
  const result = await new LlmResearcher().extractWikipediaSparks(job, 'Recording',
    new AbortController().signal, 'Choose music stories.', (value) => usage.push(value));
  assert.deepEqual(result.claims, [artistClaim]);
  assert.equal(calls(), 2);
  assert.deepEqual(usage, [{ input: 2400, output: 200 }]);
  assert.equal(recentCalls[0]?.usage?.input, 4800, 'billing still records both attempts');
});

test('Wikipedia album extraction keeps the claim limit and readable preview', async (t) => {
  const claim = { wording: artistClaim.wording };
  configure(t, 'openai-compatible', { claims: [claim, claim] });
  const result = await new LlmResearcher().extractWikipediaSparks({ ...job, subjectKind: 'album', wikiNumber: 1 },
    'Recording', new AbortController().signal, 'Choose music stories.');
  assert.deepEqual(result.claims, [claim]);
  assert.equal(result.rawResponse, `1. ${claim.wording}`);
});

test('Wikipedia extraction rejects missing artist classification instead of treating it as an empty refresh', async (t) => {
  const calls = configure(t, 'openai-compatible', { claims: [{ wording: artistClaim.wording }] });
  await assert.rejects(new LlmResearcher().extractWikipediaSparks(job, 'Recording',
    new AbortController().signal, 'Choose music stories.'));
  assert.equal(calls(), 2);
});

test('Wikipedia usage observers cannot fail a valid extraction', async (t) => {
  configure(t, 'openai-compatible', { claims: [artistClaim] });
  const result = await new LlmResearcher().extractWikipediaSparks(job, 'Recording',
    new AbortController().signal, 'Choose music stories.', () => { throw new Error('observer failed'); });
  assert.deepEqual(result.claims, [artistClaim]);
});

test('standalone time context is required even with custom Wikipedia instructions', async t=>{
  const source="In January 2010, the band announced a new tour. The following month, it was confirmed that the band would be playing Open’er Festival in Poland as well as Reading and Leeds in the UK.";
  const claim={wording:"In February 2010, the band was confirmed for Open’er Festival in Poland and Reading and Leeds in the UK.",category:'artist-stories',airtimeScope:'general'};
  configure(t,'openai',{claims:[claim]},false,options=>{
    const sent=JSON.stringify(options);
    assert.match(sent,/Resolve relative time references/);
    assert.match(sent,/Do not use the current date or guess a missing date/);
    assert.ok(sent.includes(source));
  });
  const result=await new LlmResearcher().extractWikipediaSparks({...job,document:{...job.document,text:source}},'Touring',new AbortController().signal,'Keep wording close to the source.');
  const candidates=wikipediaCandidatesFromSparks(result.claims,source,'artist');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].wording,claim.wording);
  assert.match(candidates[0].evidence,/January 2010/,'retained evidence includes the preceding time anchor');
  assert.match(candidates[0].evidence,/following month/);
});
