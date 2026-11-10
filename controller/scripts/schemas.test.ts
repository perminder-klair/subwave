// Webhook validation moved onto a shared zod schema (controller/src/schemas/).
// These tests pin the PUBLIC contract — validateWebhooksStrict's accept/reject
// decisions and returned shape — not the schema in isolation, because
// settings.update() is the caller that must not change behaviour.
//
// Thrown message WORDING is deliberately not asserted: zod's phrasing differs
// from the old hand-rolled strings. Only accept-vs-reject and the returned
// object are contractual — plus the message SHAPE (one readable line, never a
// ZodError JSON blob), which is pinned at the bottom of this file.
import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = createTempDir(path.join(tmpdir(), 'subwave-schemas-'));

const { validateWebhooksStrict } = await import('../src/settings/validate.js');
const { normalizeWebhooks } = await import('../src/settings/normalize.js');
const { WEBHOOK_EVENTS, WEBHOOKS_LIMIT, webhooksPatchSchema } = await import(
  '../src/schemas/webhook.js'
);

const hook = (over = {}) => ({
  id: 'wh_aaa111',
  url: 'https://example.com/hook',
  events: ['track.play'] satisfies Array<(typeof WEBHOOK_EVENTS)[number]>,
  enabled: true,
  authHeader: '',
  ...over,
});

test('accepts a well-formed hook and returns the normalised shape', () => {
  const [h] = validateWebhooksStrict([hook()]);
  assert.equal(h.id, 'wh_aaa111');
  assert.equal(h.url, 'https://example.com/hook');
  assert.deepEqual(h.events, ['track.play']);
  assert.equal(h.enabled, true);
  assert.equal(h.authHeader, '');
});

test('rejects the inputs the hand-rolled validator rejected', () => {
  assert.throws(() => validateWebhooksStrict('nope' as unknown));
  assert.throws(() => validateWebhooksStrict([hook({ url: 'ftp://x.com' })]));
  assert.throws(() => validateWebhooksStrict([hook({ url: 'https://e.com/' + 'x'.repeat(500) })]));
  assert.throws(() => validateWebhooksStrict([hook({ events: [] })]));
  assert.throws(() => validateWebhooksStrict([hook({ events: ['not.a.real.event'] })]));
  assert.throws(() =>
    validateWebhooksStrict(Array.from({ length: WEBHOOKS_LIMIT + 1 }, () => hook({ id: undefined }))),
  );
});

test('trims the url and defaults enabled to true', () => {
  const [h] = validateWebhooksStrict([{ url: '  https://e.com/h  ', events: ['dj.say'] }]);
  assert.equal(h.url, 'https://e.com/h');
  assert.equal(h.enabled, true);
});

test('authHeader sentinel: "set" keeps the prior value', () => {
  const existing = [hook({ authHeader: 'Bearer real-secret' })];
  const [h] = validateWebhooksStrict([hook({ authHeader: 'set' })], existing);
  assert.equal(h.authHeader, 'Bearer real-secret');
});

test('authHeader sentinel: "set" with no prior value yields empty', () => {
  const [h] = validateWebhooksStrict([hook({ authHeader: 'set' })], []);
  assert.equal(h.authHeader, '');
});

test('authHeader: any other string replaces', () => {
  const existing = [hook({ authHeader: 'Bearer old' })];
  const [h] = validateWebhooksStrict([hook({ authHeader: 'Bearer new' })], existing);
  assert.equal(h.authHeader, 'Bearer new');
});

test('mints an id when absent and re-mints on collision', () => {
  const [a, b] = validateWebhooksStrict([
    hook({ id: undefined }),
    hook({ id: undefined }),
  ]);
  assert.match(a.id, /^wh_[a-z0-9]+$/);
  assert.notEqual(a.id, b.id);

  const [c, d] = validateWebhooksStrict([hook({ id: 'wh_dupe1' }), hook({ id: 'wh_dupe1' })]);
  assert.equal(c.id, 'wh_dupe1');
  assert.notEqual(d.id, 'wh_dupe1');
});

test('de-duplicates events, preserving first-seen order', () => {
  const [h] = validateWebhooksStrict([
    hook({ events: ['dj.link', 'track.play', 'dj.link'] }),
  ]);
  assert.deepEqual(h.events, ['dj.link', 'track.play']);
});

test('WEBHOOK_EVENTS holds exactly the fan-out events', () => {
  // Order is the operator-facing order in the admin UI's checkbox list, so this
  // pins the sequence and not just the set. Adding one here is deliberate;
  // RETIRING one costs every hook subscribed to it that subscription (see the
  // lenient filter in settings/normalize.ts), so it is not a free rename.
  assert.deepEqual([...WEBHOOK_EVENTS], [
    'track.play',
    'dj.say',
    'dj.link',
    'request.received',
    'voice.queued',
    'voice.start',
    'voice.end',
  ]);
});

test('patch schema accepts each field independently', () => {
  // The route lets the listener gate save without re-submitting the hook list,
  // and vice versa. Both must stay optional.
  assert.equal(webhooksPatchSchema.safeParse({ webhooks: [hook()] }).success, true);
  assert.equal(webhooksPatchSchema.safeParse({ trackPlayListenerGated: true }).success, true);
  assert.equal(webhooksPatchSchema.safeParse({}).success, true);
});

// Deliberate tightenings over the hand-rolled validator these replaced. Each
// case previously succeeded by silent coercion; the schema now rejects it, so
// a malformed value fails loudly at save time rather than producing a broken
// webhook that only fails later at fire time. Ruled acceptable 2026-08-04:
// settings.json is only ever written by this validator, so stored data is
// always well-formed.
test('rejects a non-boolean enabled (old validator coerced via !== false)', () => {
  assert.throws(() => validateWebhooksStrict([hook({ enabled: 'true' })]));
});

test('rejects an authHeader over 500 chars (old validator silently truncated)', () => {
  assert.throws(() => validateWebhooksStrict([hook({ authHeader: 'x'.repeat(600) })]));
});

test('rejects a non-string authHeader (old validator silently emptied it)', () => {
  assert.throws(() => validateWebhooksStrict([hook({ authHeader: 42 })]));
});

test('rejects a malformed id (old validator silently re-minted a fresh one)', () => {
  assert.throws(() => validateWebhooksStrict([hook({ id: 'BAD-ID!' })]));
});

// --- The thrown MESSAGE, not just the throw. update() is reached by callers
// that never touch POST /webhooks — backup restore (routes/backup.ts) and
// PUT /settings (routes/settings/core.ts) — and both answer with
// res.status(400).json({ error: err.message }). A raw ZodError's .message is a
// pretty-printed JSON array of issue objects, ~15 lines for one bad URL, which
// would land verbatim in the operator's toast. ---

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail('expected a throw');
};

test('throws a readable single line, not a ZodError JSON blob', () => {
  const msg = messageOf(() => validateWebhooksStrict([hook({ url: 'ftp://x.com' })]));
  assert.ok(!msg.includes('\n'), `expected one line, got:\n${msg}`);
  assert.doesNotThrow(() => {
    // A ZodError message parses as a JSON array of issues. A readable message
    // must not.
    assert.throws(() => JSON.parse(msg), 'message parsed as JSON — it is still a ZodError blob');
  });
  assert.match(msg, /http:\/\/ or https:\/\//);
  // Named down to the ROW, so an operator restoring a backup knows which
  // setting is at fault AND which entry in it — a list of sixteen hooks with
  // one bad url is otherwise unsearchable from the message alone.
  assert.match(msg, /^webhooks\.0\.url: /);
});

test('the thrown message distinguishes one bad row from another', () => {
  const bad = (i: number) =>
    messageOf(() =>
      validateWebhooksStrict(
        Array.from({ length: 3 }, (_, n) => hook({ url: n === i ? 'ftp://x.com' : 'https://ok.com' })),
      ),
    );
  assert.notEqual(bad(0), bad(2));
  assert.match(bad(2), /^webhooks\.2\.url: /);
});

test('a plain Error, not a ZodError instance', () => {
  // Callers do `err.message`; anything relying on `.issues` would be reaching
  // through the persistence chokepoint into zod's shape.
  try {
    validateWebhooksStrict([hook({ url: 'ftp://x.com' })]);
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.equal((e as Error & { issues?: unknown }).issues, undefined);
  }
});

test('a top-level type error names the field too', () => {
  const msg = messageOf(() => validateWebhooksStrict('nope' as unknown));
  assert.ok(!msg.includes('\n'), `expected one line, got:\n${msg}`);
  assert.match(msg, /^webhooks: /);
});

// --- The LENIENT load path (settings/normalize.ts).
//
// normalizeWebhooks used to hand-roll the url regex, the 500-char caps, the
// event vocabulary and the id pattern a second time, so load and save could
// drift apart silently — the id pattern in particular, since the id is what
// carries a stored authHeader forward across a save. It now runs the same
// schema. These tests pin the LENIENCY that is still deliberately its own:
// unlike update()'s strict path, load repairs or drops a row and NEVER throws,
// because a hand-edited settings.json must not be able to wedge boot.

const loadHook = (over = {}) => ({
  url: 'https://example.com/hook',
  events: ['track.play'],
  ...over,
});

test('load never throws, whatever settings.json holds', () => {
  for (const raw of [null, 'nope', 42, {}, [null], ['x'], [{}], [{ url: 7 }]]) {
    assert.doesNotThrow(() => normalizeWebhooks(raw as unknown));
  }
});

test('load drops the rows the strict path would reject outright', () => {
  // Same verdict as update(), reached by dropping rather than throwing.
  for (const bad of [
    loadHook({ url: 'ftp://x.com' }),
    loadHook({ url: 42 }),
    loadHook({ url: `https://x.com/${'x'.repeat(600)}` }),
    loadHook({ events: [] }),
    loadHook({ events: ['nope.event'] }),
    loadHook({ events: 'dj.say' }),
  ]) {
    assert.deepEqual(normalizeWebhooks([bad]), [], JSON.stringify(bad));
  }
});

test('load repairs, rather than drops, what a working hook can survive', () => {
  // These three are where load and save deliberately DISAGREE. Dropping the row
  // would lose the operator a functioning webhook over a field it can fire
  // without, so load fixes it and the next save reports it.
  const [reMinted] = normalizeWebhooks([loadHook({ id: 'WH-BAD!' })]);
  assert.match(reMinted.id, /^wh_[a-z0-9]+$/);
  assert.throws(() => validateWebhooksStrict([loadHook({ id: 'WH-BAD!' })]));

  const [enabled] = normalizeWebhooks([loadHook({ enabled: 'yes' })]);
  assert.equal(enabled.enabled, true);
  assert.throws(() => validateWebhooksStrict([loadHook({ enabled: 'yes' })]));

  const [clamped] = normalizeWebhooks([loadHook({ authHeader: 'x'.repeat(600) })]);
  assert.equal(clamped.authHeader.length, 500);
  assert.throws(() => validateWebhooksStrict([loadHook({ authHeader: 'x'.repeat(600) })]));
});

test('load filters an unknown event instead of failing the whole row', () => {
  // Retiring a name from WEBHOOK_EVENTS must cost a hook that one subscription,
  // not the operator's webhook. The strict path rejects the same input.
  const [row] = normalizeWebhooks([loadHook({ events: ['nope.event', 'dj.say'] })]);
  assert.deepEqual(row.events, ['dj.say']);
  assert.throws(() => validateWebhooksStrict([loadHook({ events: ['nope.event', 'dj.say'] })]));
});

test('load and save agree on which ids are valid', () => {
  // The pattern lives in ONE place now. A stored id the load path keeps must be
  // one the next save also accepts, or the row silently changes identity — and
  // identity is what resolves the redacted authHeader sentinel.
  const [kept] = normalizeWebhooks([loadHook({ id: 'wh_aaa111' })]);
  assert.equal(kept.id, 'wh_aaa111');
  assert.equal(validateWebhooksStrict([loadHook({ id: 'wh_aaa111' })])[0].id, 'wh_aaa111');
});

test('load mints missing ids, de-duplicates collisions, and caps the list', () => {
  const minted = normalizeWebhooks([loadHook(), loadHook()]);
  assert.equal(minted.length, 2);
  assert.equal(new Set(minted.map((h) => h.id)).size, 2);

  const collided = normalizeWebhooks([loadHook({ id: 'wh_aaa111' }), loadHook({ id: 'wh_aaa111' })]);
  assert.equal(new Set(collided.map((h) => h.id)).size, 2);

  const over = normalizeWebhooks(Array.from({ length: WEBHOOKS_LIMIT + 9 }, () => loadHook()));
  assert.equal(over.length, WEBHOOKS_LIMIT);
});

test('load leaves a stored authHeader alone, sentinel-looking or not', () => {
  // No prior list exists at load, so the 'set' sentinel must NOT be resolved
  // here — doing so would blank a stored header instead of leaving it.
  assert.equal(normalizeWebhooks([loadHook({ authHeader: 'Bearer real' })])[0].authHeader, 'Bearer real');
  assert.equal(normalizeWebhooks([loadHook({ authHeader: 'set' })])[0].authHeader, 'set');
  assert.equal(normalizeWebhooks([loadHook({ authHeader: 7 })])[0].authHeader, '');
});

test('load strips unknown keys, as the strict path does', () => {
  const [row] = normalizeWebhooks([loadHook({ id: 'wh_aaa111', bogus: 'x' })]);
  assert.deepEqual(Object.keys(row).sort(), ['authHeader', 'enabled', 'events', 'id', 'url']);
});
