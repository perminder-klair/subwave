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
const { pickSystem, pickerMusicLeanings } = await import('../src/broadcast/dj-agent/schemas.js');

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

const guest = settings.guestEditorialNudgeFromGuests([
  { id: 'p_f023a4', name: 'Carrie Marshall', musicLean: 'Favour great guitar work and unexpected rock records.' },
], () => 0);
assert.deepEqual(guest, {
  guest: { id: 'p_f023a4', name: 'Carrie Marshall' },
  musicalLeanings: 'Favour great guitar work and unexpected rock records.',
});
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
