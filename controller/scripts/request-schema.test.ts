// schemas/request.ts runs on both sides: validateBody on POST /request and a
// pre-flight in PlayerCore's submitRequest. Pins the schema contract and the
// guard's name cap staying an alias of the schema's.
import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePublicBody } from '../src/middleware/validate.js';
import {
  listenerRequestSchema,
  REQUEST_NAME_MAX,
  REQUEST_TEXT_MAX,
} from '../src/schemas/request.js';
import { cleanRequesterName } from '../src/util/request-guard.js';
import { firstMessage } from '../src/util/zod-error.js';

test('accepts a bare text and defaults name to empty', () => {
  const r = listenerRequestSchema.parse({ text: 'play something for late-night driving' });
  assert.equal(r.text, 'play something for late-night driving');
  assert.equal(r.name, '');
});

test('trims both fields', () => {
  const r = listenerRequestSchema.parse({ text: '  rainy day vibes  ', name: '  Par  ' });
  assert.equal(r.text, 'rainy day vibes');
  assert.equal(r.name, 'Par');
});

test('explicit null name reads as absent, as the old typeof reader did', () => {
  assert.equal(listenerRequestSchema.parse({ text: 'surprise me', name: null }).name, '');
});

test('caps apply to the trimmed value, not the raw one', () => {
  const padded = `   ${'x'.repeat(REQUEST_TEXT_MAX)}   `;
  assert.equal(listenerRequestSchema.safeParse({ text: padded }).success, true);
});

test('refuses a missing, empty, whitespace-only or non-string text', () => {
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }, { text: null }]) {
    const r = listenerRequestSchema.safeParse(body);
    assert.equal(r.success, false, JSON.stringify(body));
    // 'Empty request' is the historical wire message API callers handle.
    assert.match(firstMessage(r.error!), /Empty request/);
  }
});

test('refuses over-cap text (the old path silently sliced to 280)', () => {
  // Deliberate tightening: truncation cut a request mid-thought.
  assert.equal(
    listenerRequestSchema.safeParse({ text: 'x'.repeat(REQUEST_TEXT_MAX) }).success,
    true,
  );
  const r = listenerRequestSchema.safeParse({ text: 'x'.repeat(REQUEST_TEXT_MAX + 1) });
  assert.equal(r.success, false);
  assert.match(r.error!.issues[0].message, /280/);
});

test('refuses an over-cap or non-string name (the old path sliced / coerced)', () => {
  assert.equal(
    listenerRequestSchema.safeParse({ text: 'ok text', name: 'x'.repeat(REQUEST_NAME_MAX) })
      .success,
    true,
  );
  assert.equal(
    listenerRequestSchema.safeParse({ text: 'ok text', name: 'x'.repeat(REQUEST_NAME_MAX + 1) })
      .success,
    false,
  );
  assert.equal(listenerRequestSchema.safeParse({ text: 'ok text', name: 7 }).success, false);
});

test('every refusal message stands alone without a field prefix', () => {
  // The player surfaces issues[0].message verbatim, so zod's default wording
  // must never ship.
  const cases = [
    { text: 'x'.repeat(REQUEST_TEXT_MAX + 1) },
    { text: 'ok text', name: 'x'.repeat(REQUEST_NAME_MAX + 1) },
    { text: 'ok text', name: 7 },
  ];
  for (const body of cases) {
    const r = listenerRequestSchema.safeParse(body);
    assert.equal(r.success, false);
    assert.doesNotMatch(r.error!.issues[0].message, /expected|invalid_/i, JSON.stringify(body));
  }
});

// Driven through the real middleware: the 400 payload must carry both the flat
// `error` string existing clients read and fieldErrors keyed by field.

interface FakeRes {
  code: number;
  body: {
    error?: string;
    message?: string;
    success?: boolean;
    fieldErrors?: Record<string, string>;
  };
}

function runValidate(body: unknown) {
  const res: FakeRes = { code: 0, body: {} };
  const req = { body } as { body: unknown };
  let nexted = false;
  // validatePublicBody is what POST /request mounts.
  validatePublicBody(listenerRequestSchema)(
    req as never,
    {
      status(c: number) {
        res.code = c;
        return this;
      },
      json(b: FakeRes['body']) {
        res.body = b;
        return this;
      },
    } as never,
    () => {
      nexted = true;
    },
  );
  return { res, nexted, req };
}

test('route: over-cap text 400s with fieldErrors keyed "text"', () => {
  const { res, nexted } = runValidate({ text: 'x'.repeat(REQUEST_TEXT_MAX + 1) });
  assert.equal(nexted, false);
  assert.equal(res.code, 400);
  assert.deepEqual(Object.keys(res.body.fieldErrors ?? {}), ['text']);
});

test('route: the listener-facing message carries NO dotted-path prefix', () => {
  // Why POST /request does not use the ordinary validateBody: firstMessage
  // prefixes the path unconditionally, so the wire and the browser would show
  // two different strings from one schema.
  const { res } = runValidate({ text: 'x'.repeat(REQUEST_TEXT_MAX + 1) });
  assert.doesNotMatch(String(res.body.error), /^text: /);
  assert.equal(res.body.error, `Keep it under ${REQUEST_TEXT_MAX} characters.`);
  // And it must equal what the schema hands the player's pre-flight.
  const issue = listenerRequestSchema.safeParse({ text: 'x'.repeat(REQUEST_TEXT_MAX + 1) });
  assert.equal(res.body.error, issue.error!.issues[0]!.message);
});

test('route: the 400 also carries success/message for already-shipped clients', () => {
  // The native app posts /request directly and renders `data.message` when
  // `!data.success`; it ships through the app stores, so old builds persist.
  const { res } = runValidate({ text: 'x'.repeat(REQUEST_TEXT_MAX + 1) });
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, res.body.error);
});

test('route: an empty request keeps its historical bare wire message', () => {
  const { res } = runValidate({ text: '   ' });
  assert.equal(res.body.error, 'Empty request');
});

test('route: a valid body calls next() with the PARSED value on req.body', () => {
  const { nexted, req } = runValidate({ text: '  rainy day vibes  ' });
  assert.equal(nexted, true);
  // The handler's guard pipeline must see the schema's output, not the raw body.
  assert.deepEqual(req.body, { text: 'rainy day vibes', name: '' });
});

test('cleanRequesterName still bounds at the schema cap (alias, not a copy)', () => {
  // The guard repairs rather than refuses, but its bound must be the same
  // figure the schema refuses over.
  const cleaned = cleanRequesterName('x'.repeat(REQUEST_NAME_MAX + 25));
  assert.equal(cleaned.length, REQUEST_NAME_MAX);
});
