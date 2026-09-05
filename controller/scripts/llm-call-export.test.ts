// Exporting the LLM recent-calls ring (#1485, FR 15).
//
// The debug panel already renders these; the export exists so one can leave the
// browser and be attached to an issue. Which makes the properties worth pinning
// the ones a well-meaning refactor would break:
//
//  - VERBATIM. Every call goes out exactly as record() stored it. This is not a
//    second, laxer reader of the log — the whole reason the export is safe is
//    that it shows nothing /debug does not already show to the same admin
//    credential. A field added or dropped HERE is a surface that has drifted
//    from the one that was reviewed.
//  - NDJSON IS ONE CALL PER LINE, with no header record. A consumer piping this
//    into `jq -c` must not have to special-case a first line that isn't a call.
//  - ONE BAD ENTRY DOES NOT COST THE FILE. A cycle or a BigInt an SDK left in
//    `usage` throws inside JSON.stringify; in a line-delimited format that must
//    drop the one line, not the export.
//  - THE FILENAME IS UNIQUE PER EXPORT. An operator chasing one bad pick pulls
//    this several times in a session, and same-day names overwriting each other
//    in the downloads folder is how the "before" copy is lost.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  llmCallExportFormat,
  llmCallExportFilename,
  serializeLlmCalls,
  LLM_CALL_EXPORT_CONTENT_TYPE,
} from '../src/llm/internal/telemetry/export.js';

// Shaped like what record() actually stores, including the parts that make this
// worth exporting at all: the prompt, the tool trail and the response.
const CALLS = [
  {
    t: '2026-09-05T10:00:00.000Z',
    kind: 'djAgentPick',
    ok: true,
    ms: 4120,
    model: 'qwen3:14b',
    via: 'ollama',
    system: 'You are the DJ…',
    user: 'Track finished: Aphex Twin — Xtal',
    response: '{"id":"abc"}',
    steps: 2,
    usage: { input: 3120, output: 88, total: 3208 },
    toolCalls: [{ name: 'similarSongs', args: { id: 'abc' }, result: [{ id: 'def' }] }],
  },
  {
    t: '2026-09-05T09:58:00.000Z',
    kind: 'link',
    ok: false,
    ms: 45000,
    model: 'qwen3:14b',
    via: 'ollama',
    error: 'deadline exceeded',
  },
];

test('format defaults to json and only ndjson opts out', () => {
  assert.equal(llmCallExportFormat(undefined), 'json');
  assert.equal(llmCallExportFormat(''), 'json');
  assert.equal(llmCallExportFormat('json'), 'json');
  assert.equal(llmCallExportFormat('csv'), 'json', 'an unknown format is not an error');
  assert.equal(llmCallExportFormat('NDJSON'), 'ndjson');
  assert.equal(llmCallExportFormat(' ndjson '), 'ndjson');
  // A repeated query param arrives as an array; it must not crash the download.
  assert.equal(llmCallExportFormat(['ndjson', 'json']), 'json');
});

test('the JSON export carries the ring verbatim', () => {
  const parsed = JSON.parse(serializeLlmCalls(CALLS, 'json'));
  assert.equal(parsed.count, 2);
  assert.ok(Date.parse(parsed.exportedAt) > 0, 'the envelope says when it was taken');
  // The calls themselves are untouched — no added field, no dropped one, and
  // in particular no second redaction pass that would make this file disagree
  // with what the panel showed.
  assert.deepEqual(parsed.calls, CALLS);
  assert.deepEqual(Object.keys(parsed).sort(), ['calls', 'count', 'exportedAt']);
});

test('the NDJSON export is one call per line and nothing else', () => {
  const out = serializeLlmCalls(CALLS, 'ndjson');
  assert.ok(out.endsWith('\n'), 'a line-delimited file ends with a newline');
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 2, 'no envelope, no header record');
  assert.deepEqual(lines.map(l => JSON.parse(l)), CALLS);
});

test('an empty ring exports cleanly in both shapes', () => {
  const json = JSON.parse(serializeLlmCalls([], 'json'));
  assert.deepEqual(json.calls, []);
  assert.equal(json.count, 0);
  assert.equal(serializeLlmCalls([], 'ndjson'), '');
  // A ring that is somehow not an array must not throw on the way to a browser.
  assert.equal(JSON.parse(serializeLlmCalls(undefined as any, 'json')).count, 0);
  assert.equal(serializeLlmCalls(null as any, 'ndjson'), '');
});

test('one unserialisable call does not cost the other lines', () => {
  const cyclic: any = { kind: 'djAgentPick', ok: true };
  cyclic.self = cyclic;
  const out = serializeLlmCalls([CALLS[0], cyclic, CALLS[1]], 'ndjson');
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 2, 'the cycle is dropped, the real calls survive');
  assert.deepEqual(lines.map(l => JSON.parse(l)), CALLS);
});

test('the filename is stamped to the second, with no colons', () => {
  const at = new Date('2026-09-05T10:07:31.512Z');
  assert.equal(llmCallExportFilename('json', at), 'subwave-llm-calls-2026-09-05T10-07-31.json');
  assert.equal(llmCallExportFilename('ndjson', at), 'subwave-llm-calls-2026-09-05T10-07-31.ndjson');
  // Colons are refused in a filename by Windows and Android, and two exports a
  // minute apart must not land on the same name.
  assert.doesNotMatch(llmCallExportFilename('json', at), /:/);
  assert.notEqual(
    llmCallExportFilename('json', at),
    llmCallExportFilename('json', new Date('2026-09-05T10:08:31.512Z')),
  );
});

test('each format declares its own registered content type', () => {
  assert.match(LLM_CALL_EXPORT_CONTENT_TYPE.json, /^application\/json;/);
  assert.match(LLM_CALL_EXPORT_CONTENT_TYPE.ndjson, /^application\/x-ndjson;/);
  // The prompts routinely hold non-ASCII — persona names, track titles, the
  // DJ's own script — so the charset is not optional.
  for (const type of Object.values(LLM_CALL_EXPORT_CONTENT_TYPE)) {
    assert.match(type, /charset=utf-8/);
  }
});

test('non-ASCII survives the round trip in both shapes', () => {
  const call = { kind: 'link', response: 'Så var det Björk — “Jóga”. 東京の夜。' };
  assert.equal(JSON.parse(serializeLlmCalls([call], 'json')).calls[0].response, call.response);
  assert.equal(
    JSON.parse(serializeLlmCalls([call], 'ndjson').trimEnd()).response,
    call.response,
  );
});
