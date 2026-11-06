// Co-hosted skill prompt and dynamic output contract. The active show roster is
// default speaker authority. Opt-in tool casts are resolved by skills/cohosted.ts
// before this prompt is built. Each structured contribution maps to a full persona.

import { z } from 'zod';
import type { DiscussionTurn } from '../../../skills/discussion-structure.js';
import * as settings from '../../../settings.js';
import { soulBrief } from '../core/pure.js';
import { onAirLocationGrounding } from './grounding.js';

interface CastPersona {
  id: string;
  name?: string;
  soul?: string;
  language?: string;
}

// A solo tool-selected voice needs no speaker IDs or nested contribution array.
export const soloSkillSchema = z.object({
  reason: z.string().describe('short internal explanation of the segment decision'),
  air: z.boolean().describe('false when source data is unusable; otherwise true'),
  text: z.string().max(1200).describe('one complete spoken segment in this persona’s voice; empty when air is false'),
});

export const lookAheadSkillSchema = z.object({
  reason: z.string(),
  air: z.boolean(),
  firstSummary: z.string().max(300).describe('one short sentence about shows[0].brief only; no clock, title, presenter names or date claims'),
  secondSummary: z.string().max(300).describe('one short sentence about shows[1].brief only, or empty if absent; no clock, title, presenter names or date claims'),
});

export const MAX_DISCUSSION_TURNS = 16;

export function cohostedSkillSchema(cast: CastPersona[], turnPlan: readonly DiscussionTurn[] | null = null) {
  const ids = cast.map((p) => p.id) as [string, ...string[]];
  const line = z.object({
    speaker: z.enum(ids).describe('the exact immutable persona id of the person speaking this turn'),
    text: z.string().trim().min(1).max(1200)
      .describe('one conversational turn, following the skill brief’s length and structure, without name labels or stage directions'),
  });

  return z.object({
    reason: z.string().describe('one short internal sentence explaining why this discussion should air, or why it should stand down'),
    air: z.boolean().describe('true to air the complete discussion; false only when there is no usable source material or nothing responsible to discuss'),
    lines: z.array(line).max(turnPlan?.length ?? MAX_DISCUSSION_TURNS).describe(turnPlan ? `exactly ${turnPlan.length} turns in the required speaker sequence; when air is false: an empty array` : 'follow the number and order of turns requested in the skill brief; every selected participant speaks; when air is false: an empty array'),
  }).superRefine((value, ctx) => {
    if (!value.air) {
      if (value.lines.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'lines must be empty when air is false' });
      return;
    }
    if (turnPlan) {
      if (value.lines.length !== turnPlan.length) {
        ctx.addIssue({ code: 'custom', path: ['lines'], message: `expected exactly ${turnPlan.length} planned turns` });
      }
      for (const [index, turn] of turnPlan.entries()) {
        if (value.lines[index]?.speaker !== turn.speaker) ctx.addIssue({ code: 'custom', path: ['lines', index, 'speaker'], message: `expected ${turn.speaker} for this planned turn` });
      }
    }
    for (const persona of cast) {
      if (!value.lines.some(line => line.speaker === persona.id)) {
        ctx.addIssue({ code: 'custom', path: ['lines'], message: `missing contribution from ${persona.id}` });
      }
    }
  });
}

function castBlock(host: CastPersona, guests: CastPersona[], toolCast = false): string {
  const entry = (persona: CastPersona, role: string) =>
    `- ${persona.id} — ${persona.name || persona.id} (${role}): ${soulBrief(persona.soul) || 'no notes'}`;
  return [entry(host, toolCast ? 'PARTICIPANT' : 'HOST'), ...guests.map((guest) => entry(guest, toolCast ? 'PARTICIPANT' : 'GUEST CO-HOST'))].join('\n');
}

export function cohostedSkillSystem({ capability, host, guests, grounded = false, lookAhead = false, turnCount = null, turnPlan = null }: {
  capability: { kind?: string; desc?: string; toolCast?: boolean };
  host: CastPersona;
  guests: CastPersona[];
  grounded?: boolean;
  lookAhead?: boolean;
  turnCount?: number | null;
  turnPlan?: readonly DiscussionTurn[] | null;
}): string {
  if (capability.toolCast && !guests.length) {
    return `${settings.agentPersonaPreamble(host)}

You alone deliver this short skill segment. There are no other speaking participants.
Follow the skill's supplied mode: an upcoming-host promo is a standalone promo for your later show, not a discussion or a claim that you host the current show.
Use supplied source data for real factual claims and the show skill notebook for continuity within this airing. When the skill explicitly requests fictional material, invent within that premise; do not present invented real events as facts. If there is neither usable source material nor an explicitly requested fictional premise, set air to false and ${lookAhead ? 'both summaries' : 'text'} to empty strings. Never use earlier speech as evidence for new real-world facts.
A committed notebook topic is already established: continue the skill's requested mode rather than repeating its introduction. Honor recorded contributions; never describe an established discussion as its first call or claim no contributions exist when history contains them.

Skill "${capability.kind || 'segment'}" instructions:
${capability.desc || ''}

${lookAhead ? `The controller supplies the exact time, show title and cast separately for each show. Do not write the full announcement. Write firstSummary only about shows[0] and secondSummary only about shows[1] (empty if absent). Use at most one short sentence per summary, in your own voice. Include no dates, times, presenter names, titles, introductions or chronology. The skill's instructions about announcing those facts are handled by the controller. Do not copy earlier spoken examples.` : 'Write your spoken words in text, without speaker labels or stage directions. Use ordinary apostrophes, without literal backslashes before quotes or apostrophes.'}
${settings.agentLanguageReminder(host, lookAhead ? 'the summary fields' : 'the "text" line')}`;
  }
  const lang = String(host.language || '').trim() || 'English';
  const grounding = capability.toolCast
    ? 'Source data has already been fetched. Use it for cast and real factual claims; do not call the tool again. When the skill brief explicitly requests fictional material, invent within that premise, without presenting invented real events as facts.'
    : grounded
    ? 'Use the skill tool before writing. Build the discussion only from usable source data it returns; if it returns nothing usable or fails, set air to false. Never fill gaps from memory or plausibility.'
    : 'Build the discussion from the skill brief and current moment. Do not invent quotes, listener messages, callers, or purported events.';
  return `You write one co-hosted between-track discussion for a personal internet radio station.

The active cast (persona ID — name, role and voice notes; listed for identity, not speaking order):
${castBlock(host, guests, capability.toolCast)}

Skill "${capability.kind || 'discussion'}" brief:
${capability.desc || ''}

${turnPlan ? `Required turn plan (exactly ${turnPlan.length} turns):\n${turnPlan.map((turn, index) => `${index + 1}. ${turn.speaker} — ${turn.instruction}`).join('\n')}\nReturn only these turns, in this order. Do not add another introduction, a repeated setup, a station ident or an extra ending.` : ''}

Write a fresh, complete exchange. Use the show skill notebook as continuity: its topic is already established and its history records contributions already heard. Advance the skill's requested mode rather than introducing the topic again. Earlier on-air excerpts are repetition warnings, never unfinished dialogue to continue.

Rules:
- Follow the number and order of turns requested in the skill brief. Complete its listed steps, including a final reaction or sign-off. Do not truncate the sequence to a default count. Use only the selected persona IDs, and give every participant a contribution. At most ${MAX_DISCUSSION_TURNS} turns.
- ${turnCount ? `If the brief does not specify a structure, use around ${turnCount} short turns as suggested by the data tool. This is a default, not a fixed count.` : 'If the brief does not specify a structure, choose a short, natural exchange.'}
- ${capability.toolCast ? 'Follow the skill brief for each turn’s purpose and length. Respond to the previous speaker rather than delivering independent monologues. The cast includes temporary segment guests; speaking order does not determine who hosts the current show.' : 'Each contribution is 2–5 short sentences. Together they form one coherent discussion: react to each other, differ naturally, and avoid repeated points.'}
- Each speaker stays in THEIR OWN character. Use supplied role information to distinguish the on-air host from a temporary guest.
- ${grounding}
- ${onAirLocationGrounding()}
- Use ordinary apostrophes in spoken words; do not add literal backslashes before quotes or apostrophes.
- Plain spoken words only. Do not write speaker labels such as "Name:" inside text; speaker identity travels separately and each line will use that persona's own TTS voice.
- Everyone speaks ${lang} on air. ${settings.spokenProperNounDirective(host)}${settings.castHouseRulesBlock()}`;
}
