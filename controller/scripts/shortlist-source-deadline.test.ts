// Exercise the real registry wrapper and signal-aware server client. A hung
// source must release its pass, cancel I/O and allow the next source to finish.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'subwave-shortlist-deadline-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://deadline-library.invalid';
const library = await import('../src/music/library.js');
const { buildPickerTools } = await import('../src/llm/tools.js');
const { clearPickerSourceCache } = await import('../src/llm/internal/tools/picker/source-pool-cache.js');
const { executeShortlistPlan } = await import('../src/music/shortlist.js');
await library.load();
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; library.shutdown(); rmSync(root, { recursive: true, force: true }); });

test('Shortlist supplies the registry deadline signal and continues after a timed-out source', async () => {
  let searchCalls = 0;
  let received: AbortSignal | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'deadline-library.invalid');
    if (url.pathname.endsWith('/search3')) {
      searchCalls++;
      received = init?.signal as AbortSignal;
      assert.ok(received);
      return new Promise<Response>((_resolve, reject) => {
        received!.addEventListener('abort', () => reject(new Error('cancelled search')), { once: true });
      });
    }
    assert.ok(url.pathname.endsWith('/getRandomSongs'));
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', randomSongs: { song: [
      { id: 'finished', title: 'Finished', artist: 'Available Artist', duration: 240 },
    ] } } });
  };
  const { tools, seen } = buildPickerTools();
  const keepAlive = setInterval(() => {}, 100);
  try {
    const result = await executeShortlistPlan(tools as any, seen, [
      { source: 'searchLibrary', args: { query: 'slow search' }, family: 'context' },
      { source: 'randomSongs', args: {}, family: 'diversity' },
    ], { sourceTimeoutMs: 30 });
    assert.equal(result.sourceRuns[0].status, 'error');
    assert.match(result.sourceRuns[0].error!, /ran out of time/);
    assert.equal(received?.aborted, true, 'the same source deadline reaches fetch');
    assert.equal(searchCalls, 1, 'abort cannot retry the source');
    assert.equal(result.sourceRuns[1].status, 'ok');
    assert.deepEqual(result.candidates.map(track => track.id), ['finished']);
    assert.ok(result.elapsedMs < 1000, `discovery hung for ${result.elapsedMs}ms`);
  } finally { clearInterval(keepAlive); }
});

test('a request discovery read survives the concurrent live pick deadline', async () => {
  clearPickerSourceCache();
  const reads: Array<{ signal: AbortSignal; finish: (response: Response) => void }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'deadline-library.invalid');
    if (url.pathname.endsWith('/getAlbumList2')) {
      const signal = init!.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        reads.push({ signal, finish: resolve });
        signal.addEventListener('abort', () => reject(new Error('cancelled pick read')), { once: true });
      });
    }
    assert.ok(url.pathname.endsWith('/getAlbum'));
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', album: { song: [
      { id: 'request-survives', title: 'Request Survives', artist: 'Available Artist', duration: 240 },
    ] } } });
  };
  const pick = new AbortController();
  const request = new AbortController();
  const options = { toolCallId: 'shared', messages: [], context: undefined };
  const pickRead = buildPickerTools().tools.recentlyAdded.execute!({}, { ...options, abortSignal: pick.signal });
  const requestRead = buildPickerTools().tools.recentlyAdded.execute!({}, { ...options, abortSignal: request.signal });
  for (let wait = 0; wait < 100 && reads.length < 2; wait++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(reads.length, 2, 'the registry must forward independent caller lifetimes to the source cache');
  pick.abort(new Error('pick deadline'));
  const pickResult = await pickRead as any;
  assert.ok(pickResult.error);
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(reads[1].signal.aborted, false);
  reads[1].finish(Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', albumList2: { album: [{ id: 'available' }] } } }));
  const requestResult = await requestRead as any[];
  assert.deepEqual(requestResult.map(track => track.id), ['request-survives']);
});
