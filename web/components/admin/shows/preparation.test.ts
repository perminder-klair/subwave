import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateShow, showPayload } from './lib';
import { showSkillsOf } from './queries';

test('preparation persists independently of programme feature speech and keeps missing references', () => {
  const show = hydrateShow({ name: 'Artist hour', personaId: 'host', preparationSkill: 'missing-artist-skill', programme: false, segmentSkill: 'news' });
  assert.equal(showPayload(show).preparationSkill, 'missing-artist-skill');
  assert.equal(showPayload(show).segmentSkill, '');
  assert.equal(hydrateShow({}).preparationSkill, '');
});

test('shared installed-skill projection preserves tool readiness for the preparation selector', () => {
  const skills = showSkillsOf([{ name: 'pick', kind: 'pick', enabled: true, hasTool: true, ready: false }, { name: 'disabled', enabled: false, hasTool: true }]);
  assert.deepEqual(skills, [{ name: 'pick', kind: 'pick', enabled: true, hasTool: true, ready: false }]);
});
