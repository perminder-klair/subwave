// The roster-wide public-read disclosure rule (util/public-persona.ts +
// settings.privacy.publishPersonaSouls). Three properties: souls are OPT-IN
// (a non-boolean reads as off), `soul` is ABSENT rather than empty when off,
// and only identity fields ever ride along.
//
// STATE_DIR is redirected before the first import, hence the dynamic imports.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-public-persona-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { publicPersonaShape, publicGuestIds, soulsArePublic } = await import(
  '../src/util/public-persona.js'
);

// Every field the admin UI can set; only four survive the reduction.
const PERSONA = {
  id: 'p_nyx',
  name: 'Nyx',
  tagline: 'after-dark selector',
  soul: 'warm, unhurried, knows the deep cuts',
  frequency: 'moderate',
  djMode: true,
  humour: 7,
  localColour: 3,
  warmth: 8,
  language: 'en',
  avatar: 'p_nyx.png',
  tts: { engine: 'piper', cloudProvider: 'openai', voice: 'am_onyx', gainDb: 2, speed: 1.1 },
  skills: ['weather'],
};

// An explicit allow-list, so a field added to the persona schema and spread
// into the shape trips this test.
const ALLOWED = new Set(['id', 'name', 'tagline', 'avatar', 'soul']);

try {
  await settings.load();
  assert.equal(
    soulsArePublic(settings.get()),
    false,
    'a fresh install must not publish persona souls',
  );

  // Every shape an older or hand-edited settings.json can present: all OFF.
  for (const privacy of [
    undefined,
    {},
    { publishPersonaSouls: undefined },
    { publishPersonaSouls: null },
    { publishPersonaSouls: 0 },
    { publishPersonaSouls: '' },
    // The string 'true' would flip disclosure on under a loose check.
    { publishPersonaSouls: 'true' },
    { publishPersonaSouls: 1 },
  ]) {
    assert.equal(
      soulsArePublic({ privacy } as never),
      false,
      `privacy=${JSON.stringify(privacy)} must read as souls-private`,
    );
  }
  assert.equal(
    soulsArePublic({ privacy: { publishPersonaSouls: true } }),
    true,
    'an explicit boolean true is the only way in',
  );

  const closed = publicPersonaShape(PERSONA, false, '/persona-avatar/p_nyx');
  assert.deepEqual(
    closed,
    {
      id: 'p_nyx',
      name: 'Nyx',
      tagline: 'after-dark selector',
      avatar: '/persona-avatar/p_nyx',
    },
    'souls-off publishes exactly id/name/tagline/avatar',
  );
  assert.equal('soul' in closed, false, 'soul must be ABSENT when off, not empty-string');

  const open = publicPersonaShape(PERSONA, true, '/persona-avatar/p_nyx');
  assert.equal(open.soul, PERSONA.soul, 'souls-on publishes the stored soul verbatim');
  assert.equal(open.tagline, PERSONA.tagline, 'tagline rides either way');

  // Operator configuration must never leak, at any setting.
  for (const shape of [closed, open]) {
    for (const key of Object.keys(shape)) {
      assert.ok(ALLOWED.has(key), `public persona read leaked "${key}"`);
    }
  }

  // The wire shape stays stable for a half-filled persona, so clients never
  // render "undefined" in a bio slot.
  assert.deepEqual(
    publicPersonaShape({ id: 'p_x' }, true, ''),
    { id: 'p_x', name: '', tagline: '', avatar: '', soul: '' },
    'absent strings become empty strings, and soul is present-but-blank when ON',
  );

  // Guest ids resolve against the LIVE roster.
  const roster = [{ id: 'p_nyx' }, { id: 'p_frequency' }];
  assert.deepEqual(
    publicGuestIds(['p_frequency'], roster),
    ['p_frequency'],
    'a guest still on the roster survives',
  );
  assert.deepEqual(
    publicGuestIds(['p_deleted'], roster),
    [],
    'a guest deleted after the show was saved vanishes rather than dangling',
  );
  assert.deepEqual(
    publicGuestIds(['p_nyx', 'p_deleted', 'p_frequency'], roster),
    ['p_nyx', 'p_frequency'],
    'surviving guests keep their order with a dead one removed',
  );
  // Solo shows and pre-guest settings.json files both land here.
  for (const bad of [undefined, null, '', 'p_nyx', 42, {}]) {
    assert.deepEqual(
      publicGuestIds(bad, roster),
      [],
      `non-array guestPersonaIds (${JSON.stringify(bad)}) yields []`,
    );
  }
  assert.deepEqual(
    publicGuestIds([null, 7, { id: 'p_nyx' }], roster),
    [],
    'non-string entries are dropped, never coerced',
  );

  await settings.update({ privacy: { publishPersonaSouls: true } });
  assert.equal(soulsArePublic(settings.get()), true, 'update() turns disclosure on');

  // A DISCLOSURE flag, not a lock: unlike privatePlayer/listenerAuth it must
  // save with no station password set.
  assert.equal(
    settings.get().privacy.password,
    '',
    'precondition: no station password is set in this test',
  );

  await settings.update({ privacy: { publishPersonaSouls: false } });
  assert.equal(soulsArePublic(settings.get()), false, 'update() turns disclosure back off');

  // And it must not have dragged the locks along with it.
  assert.equal(settings.get().privacy.privatePlayer, false, 'privatePlayer untouched');
  assert.equal(settings.get().privacy.listenerAuth, false, 'listenerAuth untouched');

  console.log('public-persona: OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
