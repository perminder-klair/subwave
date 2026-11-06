// Prompt and tool guest selection using a synthetic roster and injected model output.
import assert from 'node:assert/strict';
import test, { beforeEach, afterEach, after } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-special-guest-test-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const { findSkillPersona, specialGuestNames } = await import('../src/skills/special-guest.js');
const { runCohostedCapability } = await import('../src/skills/cohosted.js');
const original = settings.get().personas;
const host = { ...original[0], id: 'p_host', name: 'Alex Vale' };
const guest = { ...original[0], id: 'p_guest', name: 'Sam North' };
const other = { ...original[0], id: 'p_other', name: 'Morgan Reed' };
const fourth = { ...original[0], id: 'p_fourth', name: 'Robin West' };
const fifth = { ...original[0], id: 'p_fifth', name: 'Taylor Lake' };
beforeEach(() => { settings.get().personas = [host, guest, other, fourth, fifth]; });
afterEach(() => { settings.get().personas = original; });
after(() => removeTempDir(root));

function args(names = [guest.name]) {
  return { capability: { kind: 'guest-fixture', cohosts: true, desc: 'A brief fictional discussion.', specialGuestNames: names },
    host, guests: [] as typeof host[], context: {}, situation: 'Current show.', segmentState: {},
    runAgent: async () => { assert.fail('Explicit guest selection must not use the agent loop'); },
    runObject: async () => { assert.fail('An invalid cast must stand down before generation'); } };
}
function speech(ids: string[]) {
  return { air: true, reason: 'A brief exchange.', lines: ids.map(speaker => ({ speaker, text: 'Here is one perspective on the musical question.' })) };
}

test('only explicit unfenced directive lines select a special guest', () => {
  const brief = [
    'Ask Sam North about the song.',
    'For example: Special guest: Morgan Reed',
    '> Special guest: Morgan Reed',
    '```markdown', 'Special guest: Morgan Reed', '```',
    '~~~', 'Special guest: Morgan Reed', '~~~',
    '  Special GUEST: Sam North  ',
  ].join('\n');
  assert.deepEqual(specialGuestNames(brief), ['Sam North']);
  assert.deepEqual(specialGuestNames('Special guest: Alex Vale\r\nSpecial guest: Sam North'), ['Alex Vale', 'Sam North']);
});

test('persona lookup supports exact IDs and case-insensitive full names, rejecting missing or ambiguous names', () => {
  assert.deepEqual(findSkillPersona('p_guest'), { id: guest.id, name: guest.name });
  assert.deepEqual(findSkillPersona('  sam NORTH  '), { id: guest.id, name: guest.name });
  assert.equal(findSkillPersona('Sam'), null);
  assert.equal(findSkillPersona('Missing Persona'), null);
  settings.get().personas.push({ ...guest, id: 'p_duplicate' });
  assert.equal(findSkillPersona('Sam North'), null);
  assert.deepEqual(findSkillPersona('p_guest'), { id: guest.id, name: guest.name });
});

test('a prompt guest can join a solo host without changing the station roster or show assignment', async () => {
  const before = structuredClone(settings.get().personas);
  let calls = 0;
  const result = await runCohostedCapability({ ...args(), runObject: async input => {
    calls++;
    assert.match(String(input.system), /Alex Vale/);
    assert.match(String(input.system), /Sam North/);
    assert.match(String(input.prompt), /specialGuest/);
    return speech([host.id, guest.id]);
  } });
  assert.equal(result.aired, true);
  assert.deepEqual(result.lines?.map(line => line.persona.id), [host.id, guest.id]);
  assert.equal(calls, 1);
  assert.deepEqual(settings.get().personas, before);
});

test('a special guest already assigned to the show is included once', async () => {
  const result = await runCohostedCapability({ ...args(), guests: [guest], runObject: async () => speech([host.id, guest.id]) });
  assert.deepEqual(result.lines?.map(line => line.persona.id), [host.id, guest.id]);
});

test('missing, ambiguous, self and multiple prompt guests stand down before any model call', async () => {
  for (const names of [['Missing Persona'], [host.name], [guest.name, other.name], ['']]) {
    const result = await runCohostedCapability(args(names));
    assert.equal(result.aired, false);
    assert.equal(result.lines, null);
    assert.ok(result.reason);
  }
  settings.get().personas.push({ ...guest, id: 'p_duplicate' });
  const result = await runCohostedCapability(args());
  assert.equal(result.aired, false);
  assert.match(result.reason!, /missing or ambiguous/);
});

test('adding a fifth participant stands down instead of silently dropping someone', async () => {
  const result = await runCohostedCapability({ ...args([fifth.name]), guests: [guest, other, fourth] });
  assert.equal(result.aired, false);
  assert.match(result.reason!, /at most four participants/);
});

test('explicit tool speaker IDs take precedence over the prompt directive', async () => {
  const result = await runCohostedCapability({ ...args(['Missing Persona']),
    capability: { ...args().capability, specialGuestNames: ['Missing Persona'], toolCast: true,
      toolFn: async () => ({ available: true, speakerIds: [other.id, host.id] }) },
    runObject: async () => speech([other.id, host.id]),
  });
  assert.equal(result.aired, true);
  assert.deepEqual(result.lines?.map(line => line.persona.id), [other.id, host.id]);
});

test('tool casts reject duplicate, empty, missing, non-string or oversized IDs before generation', async () => {
  for (const speakerIds of [[], [host.id, host.id], ['p_deleted'], [42], [host.id, guest.id, other.id, fourth.id, fifth.id]]) {
    const result = await runCohostedCapability({ ...args(), capability: { ...args().capability,
      toolCast: true, toolFn: async () => ({ available: true, speakerIds }) } });
    assert.equal(result.aired, false);
    assert.equal(result.lines, null);
    assert.ok(result.reason);
  }
});

test('unavailable tool data stands down before selecting or generating a cast', async () => {
  const result = await runCohostedCapability({ ...args(), capability: { ...args().capability, toolCast: true,
    requiresData: true, toolFn: async () => ({ available: false, reason: 'No suitable guest today.' }) } });
  assert.equal(result.aired, false);
  assert.equal(result.lines, null);
});

test('an injected speaker in model output cannot expand the resolved cast', async () => {
  await assert.rejects(runCohostedCapability({ ...args(),
    runObject: async () => speech([host.id, other.id]),
  }));
});

test('a five-turn host/guest structure follows the skill brief, including the final host reaction', async () => {
  const desc = ['Special guest: Sam North', '1. Host introduces the question.', '2. Special guest gives an opinion.',
    '3. Host asks a follow-up.', '4. Special guest replies.', '5. Host reacts.'].join('\n');
  const ids = [host.id, guest.id, host.id, guest.id, host.id];
  const result = await runCohostedCapability({ ...args(), capability: { ...args().capability, desc },
    runObject: async () => speech(ids) });
  assert.equal(result.aired, true);
  assert.deepEqual(result.lines?.map(line => line.persona.id), ids);
  await assert.rejects(runCohostedCapability({ ...args(), capability: { ...args().capability, desc },
    runObject: async () => speech(ids.slice(0, 4)) }));
});
