// Persona Musical Leanings are private soft editorial context shared by every
// picker implementation. Agentic discovery deliberately excludes them; its
// constrained final selection receives the same context as native Shortlist.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-musical-leanings-'));

const settings = await import('../src/settings.js');
await settings.load();
const { PICK_SCHEMA, agentReasonForLeanings, agenticDiscoverySchema, agenticLeaningsReviewPrompt, agenticLeaningsReviewSchema, musicalLeaningsPickReminder, NO_AGENTIC_LEANINGS_INFLUENCE, pickSystem, pickerMusicLeanings, resolveEditorialLeanings, resolvedMusicalLeaningsFlag } = await import('../src/broadcast/dj-agent/schemas.js');
const { agenticLeaningsPhrases, agenticLeaningsSources } = await import('../src/broadcast/dj-agent/leanings-review.js');

const persona = { ...settings.get().personas[0], musicLean: 'Favour patient dub, deep electronic cuts, and melodic post-punk.' };
await settings.update({ personas: [persona], activePersonaId: persona.id });

assert.equal(
  settings.personaMusicLeanings(settings.getEffectivePersona()),
  'Favour patient dub, deep electronic cuts, and melodic post-punk.',
);

const prompt = pickSystem();
assert.match(prompt, /Musical Leanings — Favour patient dub, deep electronic cuts, and melodic post-punk\./);
assert.match(prompt, /soft editorial preference when choosing between eligible tracks/i);
assert.match(prompt, /may guide an otherwise sound selection/i);
assert.match(prompt, /never overrides show rules, rotation, safety, or the musical flow/i);
const discovery = agenticDiscoverySchema();
assert.equal(discovery.safeParse({ id: 'candidate', reason: 'fresh texture', transition: null }).success, true);
assert.equal(discovery.safeParse({ id: 'candidate', reason: 'fresh texture', usedMusicalLeanings: false, leaningsTieBreak: null, transition: null }).success, true, 'diagnostic extras are tolerated but not required by Agentic discovery');
assert.equal(PICK_SCHEMA.safeParse({ id: 'candidate', reason: 'fresh texture', usedMusicalLeanings: true, leaningsTieBreak: 'warm vocal and melody', transition: null }).success, true);
assert.equal(PICK_SCHEMA.safeParse({ id: 'candidate', reason: 'fresh texture', usedMusicalLeanings: true, transition: null }).success, false, 'the tie-break evidence must be explicit');
assert.match(PICK_SCHEMA.shape.reason.description ?? '', /Default to actual flow/i);
assert.match(PICK_SCHEMA.shape.usedMusicalLeanings.description ?? '', /Default false/i);
const editorialLeanings = resolveEditorialLeanings();
const leaningsOptions = agenticLeaningsPhrases(editorialLeanings);
assert.deepEqual(leaningsOptions, ['patient dub', 'deep electronic cuts', 'melodic post-punk']);
assert.deepEqual(agenticLeaningsSources(editorialLeanings, 'Mara Vex'), [
  { phrase: 'patient dub', source: 'host', ownerName: 'Mara Vex' },
  { phrase: 'deep electronic cuts', source: 'host', ownerName: 'Mara Vex' },
  { phrase: 'melodic post-punk', source: 'host', ownerName: 'Mara Vex' },
]);
assert.equal(resolvedMusicalLeaningsFlag(editorialLeanings, true, 'patient dub'), true);
assert.equal(resolvedMusicalLeaningsFlag(editorialLeanings, true, null), false);
const reminder = musicalLeaningsPickReminder(editorialLeanings);
assert.match(reminder, /soft tie-breaker/i);
assert.match(reminder, /two or more eligible tracks/i);
assert.match(reminder, /leaningsTieBreak/i);
assert.match(reminder, /directly match the supplied Musical Leanings/i);
assert.match(reminder, /club feel are not Leanings evidence/i);
assert.equal(resolvedMusicalLeaningsFlag(editorialLeanings, false, 'warm vocal and melody'), false);
assert.equal(resolvedMusicalLeaningsFlag(editorialLeanings, undefined, 'warm vocal and melody'), false);
assert.equal(agentReasonForLeanings('Mara Vex chose a track reflecting her taste for patient dub.', false), 'flow fit after the current track');
assert.equal(agentReasonForLeanings('a warm vocal and melodic hook', true, 'warm vocal and melodic hook'), 'Leanings: warm vocal and melodic hook');
const reviewSchema = agenticLeaningsReviewSchema(['alternative', 'candidate'], leaningsOptions, 'candidate');
assert.equal(reviewSchema.safeParse({ selectedId: 'candidate', leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: 'its patient rhythm keeps the reflective flow moving naturally', transition: null }).success, true);
assert.equal(
  reviewSchema.parse({ selectedId: 'candidate', leaningsBasis: null, musicalReason: null, transition: null }).musicalReason,
  '[musical reason unavailable]',
  'a weak-model null is repaired so the controller can supply its safe Agentic fallback',
);
assert.equal(reviewSchema.safeParse({ selectedId: 'alternative', leaningsBasis: 'patient dub', musicalReason: 'its spacious rhythm provides a patient continuation of the reflective flow', transition: null }).success, true);
assert.equal(reviewSchema.parse({ selectedId: 'alternative', leaningsBasis: 'invented mood', musicalReason: 'its spacious rhythm provides a patient continuation of the reflective flow', transition: null }).leaningsBasis, 'invented mood', 'free strings avoid enum ordering bias; controller validation still rejects invented evidence');
assert.equal(reviewSchema.safeParse({ selectedId: null, leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: 'its patient rhythm keeps the reflective flow moving naturally', transition: null }).success, false, 'the final review cannot take a null shortcut');
const reviewPrompt = agenticLeaningsReviewPrompt({
  baseline: { id: 'candidate', artist: 'Artist', title: 'Track' },
  challengers: [{ id: 'alternative', artist: 'Other Artist', title: 'Other Track' }],
  leaningsOptions,
});
assert.match(reviewPrompt, /Use this decision order/i);
assert.match(reviewPrompt, /leaningsBasis=NO_LEANINGS_INFLUENCE/i);
assert.match(reviewPrompt, /flowCloseness="close"/i);
assert.match(reviewPrompt, /leaningsMatches/i);
assert.match(reviewPrompt, /Do not independently rerank/i);
assert.match(reviewPrompt, /controller adds the verified names and exact evidence/i);
assert.match(reviewPrompt, /beginning with "its" or "it"/i);
assert.match(reviewPrompt, /Do not mention preferences, Leanings, baseline, challenger, preliminary choice, current flow/i);
assert.match(reviewPrompt, /leaningsSources identifies the owner/i);

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

console.log('musical leanings: Agentic replacement review verified');
