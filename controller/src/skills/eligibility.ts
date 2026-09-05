// Per-skill eligibility — the rules that answer "may this skill air right
// now" about the SKILL itself (rather than about the station's mood, budget or
// listener count, which broadcast/ owns).
//
// Two callers, and they must never drift: the autonomous segment director
// (availableCapabilities() in _agent.ts) and the per-skill cron timer
// (syncSkillCrons() in broadcast/scheduler.ts). Both are AUTONOMOUS — neither
// is an explicit operator action — so both owe the same answers.
//
// This module exists because the rules used to live ONLY inside
// availableCapabilities(), which the cron path bypasses entirely by calling
// runCapability() directly. A cron therefore aired a DISABLED skill: a
// zip-imported skill arrives disabled-pending-review (routes/dj.ts logs it as
// such) and its `cron:` line registered a timer regardless, which reopens the
// exact posture loader.ts states — "dropping a folder never auto-airs
// unreviewed content/code". The persona rule went the same way: a skill
// assigned to one DJ fired under whoever happened to be on air.
//
// The operator's own "Run now" override (POST /dj/skill → runCapability) is
// deliberately NOT a caller. An explicit operator action fires exactly what it
// names, the same carve-out the frequency gate and the LLM hard cap already
// make for the manual /dj/segment routes.
//
// Pure: every input is passed in, nothing is read from settings here, so the
// rule can be pinned without faking live state (scripts/skill-eligibility.test.ts).

export interface SkillEligibilityInput {
  // Seeded built-ins are enabled unless explicitly turned off; operator skills
  // are DISCOVERED-BUT-DISABLED and must be explicitly enabled before they can
  // air. The asymmetry is the review gate, not a default-value convenience.
  seeded: boolean;
  // The skill's slug — the key `settings.skills.enabled` and a persona's
  // `skills[]` allowlist are both written in terms of.
  skill: string;
  enabled: Record<string, boolean | undefined>;
  // The on-air persona's skill allowlist. Absent/null means "this persona runs
  // every skill", which is the default and NOT the same as an empty array.
  personaSkills?: string[] | null;
  // Co-hosted skills additionally require the active show to have at least one
  // resolved guest. Ordinary skills leave requiresCohosts false/absent.
  requiresCohosts?: boolean;
  hasCohosts?: boolean;
}

export function skillEnabled({ seeded, skill, enabled }: SkillEligibilityInput): boolean {
  return seeded ? enabled[skill] !== false : enabled[skill] === true;
}

export function personaRunsSkill({ skill, personaSkills }: SkillEligibilityInput): boolean {
  return !personaSkills || personaSkills.includes(skill);
}

// All skill-level rules at once. `reason` is for the booth log — the cron path is silent
// by nature, so an operator wondering why their 8am skill never spoke needs the
// answer written down somewhere.
export function skillEligible(input: SkillEligibilityInput): { allowed: boolean; reason?: string } {
  if (!skillEnabled(input)) return { allowed: false, reason: 'skill is disabled' };
  if (!personaRunsSkill(input)) return { allowed: false, reason: 'the on-air persona does not run this skill' };
  if (input.requiresCohosts && !input.hasCohosts) return { allowed: false, reason: 'requires a co-hosted show' };
  return { allowed: true };
}
