// Pins skills/eligibility.ts — the two per-skill rules shared by the
// autonomous segment director (availableCapabilities()) and the per-skill cron
// timer (syncSkillCrons()).
//
// The bug: both rules lived only inside availableCapabilities(), and the cron
// timer reaches runCapability() without passing through it. So a cron aired a
// DISABLED skill — POST /dj/skills/import writes SKILL.md verbatim (cron line
// included), logs the install as "(disabled)" pending review, and the timer
// registered anyway. That reopens the posture loader.ts states outright:
// "dropping a folder never auto-airs unreviewed content/code". The persona
// allowlist went the same way — a skill assigned to one DJ fired under whoever
// happened to be on air.
//
// Run: `tsx scripts/skill-eligibility.test.ts`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { skillEnabled, personaRunsSkill, skillEligible } from '../src/skills/eligibility.js';

test('a seeded built-in is enabled unless explicitly turned off', () => {
  assert.equal(skillEnabled({ seeded: true, skill: 'weather', enabled: {} }), true);
  assert.equal(skillEnabled({ seeded: true, skill: 'weather', enabled: { weather: true } }), true);
  assert.equal(skillEnabled({ seeded: true, skill: 'weather', enabled: { weather: false } }), false);
});

test('an operator skill is discovered-but-disabled — it must be turned ON', () => {
  // The review gate. A dropped folder (or a zip import, which arrives disabled)
  // must not air until the operator has looked at it.
  assert.equal(skillEnabled({ seeded: false, skill: 'dabbers', enabled: {} }), false);
  assert.equal(skillEnabled({ seeded: false, skill: 'dabbers', enabled: { dabbers: true } }), true);
  assert.equal(skillEnabled({ seeded: false, skill: 'dabbers', enabled: { dabbers: false } }), false);
});

test('no persona allowlist means the persona runs every skill', () => {
  const base = { seeded: true, skill: 'weather', enabled: {} };
  assert.equal(personaRunsSkill({ ...base, personaSkills: undefined }), true);
  assert.equal(personaRunsSkill({ ...base, personaSkills: null }), true);
});

test('an empty allowlist is not "no allowlist" — it runs nothing', () => {
  // An operator who set the list and then cleared it means "none", which is a
  // different statement from never having set one.
  assert.equal(personaRunsSkill({ seeded: true, skill: 'weather', enabled: {}, personaSkills: [] }), false);
});

test('an allowlist admits only its own members', () => {
  const base = { seeded: true, enabled: {} };
  assert.equal(personaRunsSkill({ ...base, skill: 'weather', personaSkills: ['weather', 'news'] }), true);
  assert.equal(personaRunsSkill({ ...base, skill: 'dabbers', personaSkills: ['weather', 'news'] }), false);
});

test('skillEligible is a strict AND and names which rule closed it', () => {
  assert.deepEqual(
    skillEligible({ seeded: true, skill: 'weather', enabled: {}, personaSkills: ['weather'] }),
    { allowed: true },
  );

  const disabled = skillEligible({ seeded: false, skill: 'dabbers', enabled: {}, personaSkills: ['dabbers'] });
  assert.equal(disabled.allowed, false);
  assert.match(disabled.reason || '', /disabled/);

  const notOwned = skillEligible({ seeded: true, skill: 'weather', enabled: {}, personaSkills: ['news'] });
  assert.equal(notOwned.allowed, false);
  assert.match(notOwned.reason || '', /persona/);
});

test('the disabled rule is reported first when both rules are closed', () => {
  // Not cosmetic: the reason goes to the booth log, and "enable it" is the
  // step the operator has to take before the persona question even applies.
  const both = skillEligible({ seeded: false, skill: 'dabbers', enabled: {}, personaSkills: ['news'] });
  assert.equal(both.allowed, false);
  assert.match(both.reason || '', /disabled/);
});


test('a co-hosted skill requires an active guest roster after enable and persona checks', () => {
  const base = {
    seeded: true, skill: 'case-discussion', enabled: {}, personaSkills: ['case-discussion'],
    requiresCohosts: true,
  };
  assert.deepEqual(skillEligible({ ...base, hasCohosts: true }), { allowed: true });
  const solo = skillEligible({ ...base, hasCohosts: false });
  assert.equal(solo.allowed, false);
  assert.equal(solo.reason, 'requires a co-hosted show');

  assert.deepEqual(
    skillEligible({ ...base, requiresCohosts: false, hasCohosts: false }),
    { allowed: true },
    'ordinary one-persona skills are unchanged on solo shows',
  );
});

test('co-host roster is checked after enable and persona ownership', () => {
  const disabled = skillEligible({
    seeded: false, skill: 'case-discussion', enabled: {}, personaSkills: ['case-discussion'],
    requiresCohosts: true, hasCohosts: false,
  });
  assert.match(disabled.reason || '', /disabled/);

  const notOwned = skillEligible({
    seeded: true, skill: 'case-discussion', enabled: {}, personaSkills: ['weather'],
    requiresCohosts: true, hasCohosts: false,
  });
  assert.match(notOwned.reason || '', /persona/);
});
