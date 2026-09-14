// The route-boundary body validator. The error payload is deliberately
// ADDITIVE: `error` stays a flat human-readable string (every existing
// client reads exactly that from a 400), and `fieldErrors` is new.
//
// firstMessage/flattenIssues now live in util/zod-error.ts — neutral ground
// shared with settings/validate.ts, which must not import middleware/.
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

const { firstMessage, flattenIssues } = await import('../src/util/zod-error.js');

const schema = z.object({
  webhooks: z
    .array(z.object({ url: z.string().regex(/^https?:\/\//, 'URL must start with http:// or https://') }))
    .optional(),
});

test('flattenIssues keys errors by dotted field path', () => {
  const r = schema.safeParse({ webhooks: [{ url: 'https://ok.com' }, { url: 'nope' }] });
  assert.equal(r.success, false);
  assert.deepEqual({ ...flattenIssues(r.error) }, {
    'webhooks.1.url': 'URL must start with http:// or https://',
  });
});

test('firstMessage returns a flat human-readable string', () => {
  const r = schema.safeParse({ webhooks: [{ url: 'nope' }] });
  assert.equal(r.success, false);
  assert.equal(
    firstMessage(r.error),
    'webhooks.0.url: URL must start with http:// or https://',
  );
});

test('firstMessage prefixes the path when the message alone is ambiguous', () => {
  const r = schema.safeParse({ webhooks: 'notanarray' });
  assert.equal(r.success, false);
  // Path-prefixed: the bare zod message names no field.
  assert.match(firstMessage(r.error), /^webhooks: /);
});

// The path is prefixed for EVERY issue code, not just invalid_type: a
// code-based heuristic stops applying the moment a schema uses .regex()/.max()
// without a custom message.

test('firstMessage names the row, so two rows failing the same rule differ', () => {
  // Without the prefix both messages are the bare rule text, identical, with
  // nothing saying which row to fix.
  const first = schema.safeParse({ webhooks: [{ url: 'nope' }, { url: 'https://ok.com' }] });
  const second = schema.safeParse({ webhooks: [{ url: 'https://ok.com' }, { url: 'nope' }] });
  assert.equal(first.success, false);
  assert.equal(second.success, false);
  assert.notEqual(firstMessage(first.error), firstMessage(second.error));
  assert.match(firstMessage(first.error), /^webhooks\.0\.url: /);
  assert.match(firstMessage(second.error), /^webhooks\.1\.url: /);
});

test('firstMessage prefixes codes whose built-in message names no field', () => {
  // Neither zod message carries a field name: 'invalid_format' reports the
  // pattern, 'too_big' the limit.
  const codes = z.object({
    slug: z.string().regex(/^[a-z]+$/),
    token: z.string().max(3),
  });
  const bad = codes.safeParse({ slug: 'NOPE!', token: 'far too long' });
  assert.equal(bad.success, false);
  assert.match(firstMessage(bad.error), /^slug: /);

  const long = codes.safeParse({ slug: 'ok', token: 'far too long' });
  assert.equal(long.success, false);
  assert.match(firstMessage(long.error), /^token: /);
});

test('firstMessage splices `root` in FRONT of the path, not as a bare prefix', () => {
  // The bare array's paths start at the index, so the root joins the dotted
  // path ('webhooks.0.url'), not a separate label ('webhooks: 0.url').
  const bare = z.array(z.object({ url: z.string().regex(/^https?:\/\//, 'bad scheme') }));
  const r = bare.safeParse([{ url: 'https://ok.com' }, { url: 'nope' }]);
  assert.equal(r.success, false);
  assert.equal(firstMessage(r.error, 'webhooks'), 'webhooks.1.url: bad scheme');
});

test('a root-level issue under `root` reads as just the root name', () => {
  const bare = z.array(z.object({ url: z.string() }));
  const r = bare.safeParse('notanarray');
  assert.equal(r.success, false);
  // Path is empty, so there is no index to splice — 'webhooks: <message>'.
  assert.match(firstMessage(r.error, 'webhooks'), /^webhooks: /);
  assert.ok(!firstMessage(r.error, 'webhooks').startsWith('webhooks.'));
});

test('firstMessage without a path or a root returns the bare message', () => {
  // Nothing to name, so nothing is spliced on — the message stands alone.
  const r = z.string().safeParse(1);
  assert.equal(r.success, false);
  assert.equal(firstMessage(r.error), r.error.issues[0].message);
});

test('flattenIssues keeps only the first error per field', () => {
  const two = z.object({ url: z.string().min(5, 'too short').regex(/^https/, 'bad scheme') });
  const r = two.safeParse({ url: 'ftp' });
  assert.equal(r.success, false);
  assert.equal(Object.keys(flattenIssues(r.error)).length, 1);
  assert.equal(flattenIssues(r.error)['url'], 'too short');
});

// The accumulator is Object.create(null): field names come from user data, and
// on a {} literal 'toString' is inherited-true and '__proto__' assignment sets
// the prototype rather than creating an own property.

test('flattenIssues surfaces an error on a field named like an Object.prototype member', () => {
  const proto = z.object({
    toString: z.string({ error: 'toString must be a string' }),
    valueOf: z.string({ error: 'valueOf must be a string' }),
    constructor: z.string({ error: 'constructor must be a string' }),
  });
  const r = proto.safeParse({ toString: 1, valueOf: 1, constructor: 1 });
  assert.equal(r.success, false);
  const out = flattenIssues(r.error);
  assert.equal(out['toString'], 'toString must be a string');
  assert.equal(out['valueOf'], 'valueOf must be a string');
  assert.equal(out['constructor'], 'constructor must be a string');
});

test('flattenIssues surfaces an error on a field literally named __proto__', () => {
  // An object literal can't carry a real own '__proto__' key, so both the
  // schema shape and the input are built null-prototype.
  const shape: Record<string, z.ZodTypeAny> = Object.create(null);
  shape['__proto__'] = z.string({ error: 'proto must be a string' });
  const input: Record<string, unknown> = Object.create(null);
  input['__proto__'] = 1;
  const r = z.object(shape).safeParse(input);
  assert.equal(r.success, false);
  const out = flattenIssues(r.error);
  assert.equal(out['__proto__'], 'proto must be a string');
  // And the accumulator must not have been mutated into a prototype set.
  assert.equal(Object.getPrototypeOf(out), null);
  assert.deepEqual(Object.keys(out), ['__proto__']);
});

test('a null-prototype accumulator still serialises and enumerates normally', () => {
  // res.json() is JSON.stringify and the browser does Object.entries(), so
  // both must behave as with a plain object.
  const r = schema.safeParse({ webhooks: [{ url: 'nope' }] });
  assert.equal(r.success, false);
  const out = flattenIssues(r.error);
  assert.equal(JSON.stringify(out), '{"webhooks.0.url":"URL must start with http:// or https://"}');
  assert.deepEqual(Object.entries(out), [
    ['webhooks.0.url', 'URL must start with http:// or https://'],
  ]);
  assert.deepEqual(Object.entries(JSON.parse(JSON.stringify(out))), [
    ['webhooks.0.url', 'URL must start with http:// or https://'],
  ]);
});
