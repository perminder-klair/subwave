// Share autonomous skill eligibility between the director and skill crons.
// Both enforce enablement/persona rules; explicit Run now bypasses this policy.
// Imported skills remain disabled pending review. See scripts/skill-eligibility.test.ts.

export interface SkillEligibilityInput {
  // Built-ins default enabled; operator skills require explicit enablement after review.
  seeded: boolean;
  // Use the same slug for settings.skills.enabled and persona skills allowlists.
  skill: string;
  enabled: Record<string, boolean | undefined>;
  // Absent/null allows all skills; an empty array allows none.
  personaSkills?: string[] | null;
  // Co-hosted skills need at least one resolved guest.
  requiresCohosts?: boolean;
  hasCohosts?: boolean;
  use?: 'speech' | 'preparation';
  preparationSkill?: string | null;
}

export function skillEnabled({ seeded, skill, enabled }: SkillEligibilityInput): boolean {
  return seeded ? enabled[skill] !== false : enabled[skill] === true;
}

export function personaRunsSkill({ skill, personaSkills }: SkillEligibilityInput): boolean {
  return !personaSkills || personaSkills.includes(skill);
}

// Return a booth-log reason so silent cron skips remain diagnosable.
export function skillEligible(input: SkillEligibilityInput): { allowed: boolean; reason?: string } {
  if (!skillEnabled(input)) return { allowed: false, reason: 'skill is disabled' };
  if (!personaRunsSkill(input)) return { allowed: false, reason: 'the on-air persona does not run this skill' };
  if (input.use !== 'preparation' && input.preparationSkill === input.skill) return { allowed: false, reason: 'reserved for show preparation' };
  if (input.use !== 'preparation' && input.requiresCohosts && !input.hasCohosts) return { allowed: false, reason: 'requires a co-hosted show' };
  return { allowed: true };
}
