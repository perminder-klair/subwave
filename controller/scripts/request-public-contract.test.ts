// Public request compatibility: REST receipt/polling, the received webhook,
// and MCP's thin wrapper must remain stable while the internal resolver moves
// away from agent tools. Run: npm test -- request-public-contract

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerSubwaveTools } from '../src/mcp/tools.js';

const routeSource = readFileSync(new URL('../src/routes/request.ts', import.meta.url), 'utf8');

// The receipt is deliberately sent after the ledger and request.received event,
// then resolution begins in the background. Connect clients rely on this exact
// ordering: the id must be pollable as soon as their POST completes, and a
// webhook consumer may receive the event immediately.
const received = routeSource.indexOf("webhooks.notify('request.received', { requestedBy: requester, text });");
const receipt = routeSource.indexOf("res.status(202).json({ success: true, requestId: id, status: 'pending' });");
const background = routeSource.indexOf('resolveRequest(entry).catch(err => {');
assert.ok(received >= 0, 'accepted requests keep the request.received webhook payload');
assert.ok(receipt > received, 'the webhook continues to precede the POST receipt');
assert.ok(background > receipt, 'resolution remains background work after the receipt');
assert.match(routeSource, /router\.get\('\/request\/:id'/);
assert.match(routeSource, /res\.status\(404\)\.json\(\{ status: 'unknown' \}\)/);
assert.match(routeSource, /status: entry\.status,[\s\S]*success: entry\.status === 'resolved',[\s\S]*ack: entry\.ack,[\s\S]*track: entry\.track,[\s\S]*queuePosition: entry\.queuePosition,[\s\S]*message: entry\.message,/);

// Register the real MCP tools against a captured server, then call their
// handlers with a fake client. This proves they still use the same POST receipt
// and GET status model rather than reaching into request resolution directly.
const handlers = new Map<string, Function>();
const server = {
  registerTool(name: string, _definition: unknown, handler: Function) {
    handlers.set(name, handler);
  },
};
const calls: string[] = [];
const client: any = {
  async requestSong(text: string, requester?: string) {
    calls.push(`POST:${text}:${requester || ''}`);
    return { success: true, requestId: 'request-123', status: 'resolved' };
  },
  async requestStatus(id: string) {
    calls.push(`GET:${id}`);
    return {
      status: 'resolved', success: true, ack: 'Coming up.',
      track: { title: 'Example', artist: 'Artist' }, queuePosition: 2, message: null,
    };
  },
};
registerSubwaveTools(server as any, client, { requestPollBudgetMs: 0 });

const submit = await handlers.get('subwave_request_song')!({ request: 'Example', requester: 'A listener' });
assert.deepEqual(calls, ['POST:Example:A listener']);
assert.deepEqual(submit.structuredContent, { requestId: 'request-123', status: 'resolved' });

const status = await handlers.get('subwave_request_status')!({ requestId: 'request-123' });
assert.deepEqual(calls, ['POST:Example:A listener', 'GET:request-123']);
assert.deepEqual(status.structuredContent, {
  requestId: 'request-123', status: 'resolved', success: true, ack: 'Coming up.',
  track: { title: 'Example', artist: 'Artist' }, queuePosition: 2, message: null,
});

console.log('request public contract: all assertions passed');
