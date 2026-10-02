// Persona Musical Leanings are private soft editorial context shared by every
// picker implementation. This pins the agentic path now; the optional native
// shortlist path consumes the same settings.personaMusicLeanings() helper.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-musical-leanings-'));

const settings = await import('../src/settings.js');
await settings.load();
const { PICK_SCHEMA, agentReasonForLeanings, musicalLeaningsPickReminder, pickSystem, pickerMusicLeanings, resolveEditorialLeanings, resolvedMusicalLeaningsFlag } = await import('../src/broadcast/dj-agent/schemas.js');

const persona = { ...settings.get().personas[0], musicLean: 'Favour patient dub, deep electronic cuts, and melodic post-punk.' };
await settings.update({ personas: [persona], activePersonaId: persona.id });

assert.equal(
  settings.personaMusicLeanings(settings.getEffectivePersona()),
  'Favour patient dub, deep electronic cuts, and melodic post-punk.',
);

const prompt = pickSystem();
assert.match(prompt, /Musical Leanings — Favour patient dub, deep electronic cuts, and melodic post-punk\./);
assert.match(prompt, /soft editorial preference/i);
assert.match(prompt, /may guide an otherwise sound selection/i);
assert.match(prompt, /never overrides show rules, rotation, safety, or the musical flow/i);
assert.equal(PICK_SCHEMA.safeParse({ id: 'candidate', reason: 'fresh texture', usedMusicalLeanings: true, leaningsTieBreak: 'warm vocal and melody', transition: null }).success, true);
assert.equal(PICK_SCHEMA.safeParse({ id: 'candidate', reason: 'fresh texture', usedMusicalLeanings: true, transition: null }).success, false, 'the tie-break evidence must be explicit');
assert.match(PICK_SCHEMA.shape.reason.description ?? '', /Default to actual flow/i);
assert.match(PICK_SCHEMA.shape.usedMusicalLeanings.description ?? '', /Default false/i);
const reminder = musicalLeaningsPickReminder(resolveEditorialLeanings());
assert.match(reminder, /soft tie-breaker/i);
assert.match(reminder, /two or more eligible tracks/i);
assert.match(reminder, /leaningsTieBreak/i);
assert.match(reminder, /directly match the supplied Musical Leanings/i);
assert.match(reminder, /club feel are not Leanings evidence/i);
assert.equal(resolvedMusicalLeaningsFlag(resolveEditorialLeanings(), true, 'warm vocal and melody'), true);
assert.equal(resolvedMusicalLeaningsFlag(resolveEditorialLeanings(), true, null), false);
assert.equal(resolvedMusicalLeaningsFlag(resolveEditorialLeanings(), false, 'warm vocal and melody'), false);
assert.equal(resolvedMusicalLeaningsFlag(resolveEditorialLeanings(), undefined, 'warm vocal and melody'), false);
assert.equal(
  agentReasonForLeanings('warm voices and strong melodies from Musical Leanings', false),
  'flow fit after the current track',
  'an Agentic omission must not leave a Leanings claim in queue or session metadata',
);
assert.equal(
  agentReasonForLeanings('ordinary flow note', true, 'warm vocal and melody'),
  'Leanings: warm vocal and melody',
);

const guest = settings.guestEditorialNudgeFromGuests([
  { id: 'p_f023a4', name: 'Carrie Marshall', musicLean: 'Favour great guitar work and unexpected rock records.' },
], () => 0);
assert.deepEqual(guest, {
  guest: { id: 'p_f023a4', name: 'Carrie Marshall' },
  musicalLeanings: 'Favour great guitar work and unexpected rock records.',
});
assert.equal(
  settings.guestEditorialNudge(new Date(), () => 0),
  null,
  'guest influence is disabled by default',
);
await settings.update({ llm: { guestMusicalLeanings: true } });
assert.equal(settings.get().llm.guestMusicalLeanings, true, 'the station-wide opt-in persists');
assert.equal(
  settings.guestEditorialNudgeFromGuests([
    { id: 'p_f023a4', name: 'Carrie Marshall', musicLean: 'Favour great guitar work and unexpected rock records.' },
  ], () => 0.25),
  null,
  'guest influence stays occasional and secondary',
);
const guestPrompt = pickerMusicLeanings('Favour patient dub.', guest);
assert.match(guestPrompt, /Musical Leanings — Favour patient dub\./);
assert.match(guestPrompt, /Guest Musical Leanings — Carrie Marshall: Favour great guitar work and unexpected rock records\./);
assert.match(guestPrompt, /weaker than the host/i);

console.log('musical leanings: shared agentic picker context verified');
