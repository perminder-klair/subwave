// Co-hosted skill prompt and dynamic output contract. The active show roster is
// the only speaker authority: one structured run writes one contribution for the
// host and every guest, then skills/cohosted.ts maps ids back to full personas.

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { soulBrief } from '../core/pure.js';

interface CastPersona {
  id: string;
  name?: string;
  soul?: string;
  language?: string;
}

export function cohostedSkillSchema(cast: CastPersona[]) {
  const ids = cast.map((p) => p.id) as [string, ...string[]];
  const line = z.object({
    speaker: z.enum(ids).describe('the exact immutable persona id for this contribution, in the cast order'),
    text: z.string().trim().min(1).max(1200)
      .describe('this persona’s spoken contribution — 2–5 short sentences, plain speech, with no name label or stage direction'),
  });

  return z.object({
    reason: z.string().describe('one short internal sentence explaining why this discussion should air, or why it should stand down'),
    air: z.boolean().describe('true to air the complete discussion; false only when there is no usable source material or nothing responsible to discuss'),
    lines: z.array(line).describe('when air is true: exactly one contribution per cast member, in the cast order; when false: an empty array'),
  }).superRefine((value, ctx) => {
    if (!value.air) {
      if (value.lines.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'lines must be empty when air is false' });
      return;
    }
    if (value.lines.length !== cast.length) {
      ctx.addIssue({ code: 'custom', path: ['lines'], message: `expected exactly ${cast.length} cast contributions` });
      return;
    }
    for (let i = 0; i < cast.length; i += 1) {
      if (value.lines[i]?.speaker !== cast[i].id) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'speaker'], message: `expected ${cast[i].id} in cast order` });
      }
    }
  });
}

function castBlock(host: CastPersona, guests: CastPersona[]): string {
  const entry = (persona: CastPersona, role: string) =>
    `- ${persona.id} — ${persona.name || persona.id} (${role}): ${soulBrief(persona.soul) || 'no notes'}`;
  return [entry(host, 'HOST'), ...guests.map((guest) => entry(guest, 'GUEST CO-HOST'))].join('\n');
}

export function cohostedSkillSystem({ capability, host, guests, grounded = false }: {
  capability: { kind?: string; desc?: string };
  host: CastPersona;
  guests: CastPersona[];
  grounded?: boolean;
}): string {
  const lang = String(host.language || '').trim() || 'English';
  const grounding = grounded
    ? 'Use the skill tool before writing. Build the discussion only from usable source data it returns; if it returns nothing usable or fails, set air to false. Never fill gaps from memory or plausibility.'
    : 'Build the discussion from the skill brief and current moment. Do not invent quotes, listener messages, callers, or purported events.';
  return `You write one co-hosted between-track discussion for a personal internet radio station.

The active cast (persona id — name (role): voice notes), in required speaking order:
${castBlock(host, guests)}

Skill "${capability.kind || 'discussion'}" brief:
${capability.desc || ''}

Rules:
- Return exactly one contribution for every cast member, in the cast order above. Use each immutable persona id exactly once; never invent a speaker.
- Each contribution is 2–5 short sentences. Together they form one coherent discussion: react to each other, differ naturally, and avoid repeated points.
- Each speaker stays in THEIR OWN character. The host carries the room and the guest co-hosts speak as themselves.
- ${grounding}
- Plain spoken words only. Do not write speaker labels such as "Name:" inside text; speaker identity travels separately and each line will use that persona's own TTS voice.
- Everyone speaks ${lang} on air. ${settings.spokenProperNounDirective(host)}${settings.castHouseRulesBlock()}`;
}
