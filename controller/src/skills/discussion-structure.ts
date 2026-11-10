// Numbered speaker steps define structure; generated words remain unconstrained by a script.
import { promptInstructionLines } from './special-guest.js';

export interface DiscussionTurn { speaker: string; instruction: string }

export function discussionTurnPlan(brief: string, cast: Array<{ id: string; name?: string }>, hostId: string, specialGuestId: string | null) {
  const steps = promptInstructionLines(brief).flatMap(line => {
    const match = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    return match ? [{ number: Number(match[1]), instruction: match[2].trim() }] : [];
  });
  const aliases: Array<{ name: string; id: string }> = [];
  for (const persona of cast) {
    const name = persona.name?.trim() || '';
    const names = [persona.id, name, ...name.split(/\s+/)];
    if (persona.id === hostId) names.push('host', 'current host', 'on-air host');
    if (persona.id === specialGuestId) names.push('guest', 'special guest');
    for (const alias of names.filter(Boolean)) aliases.push({ name: alias.toLowerCase(), id: persona.id });
  }
  const turns = steps.map(step => {
    const text = step.instruction.toLowerCase().replace(/^the\s+/, '');
    const matches = aliases.filter(alias => text.startsWith(alias.name) && (!text[alias.name.length] || /[\s:.,—–-]/.test(text[alias.name.length])))
      .sort((a, b) => b.name.length - a.name.length);
    const longest = matches[0]?.name.length;
    const ids = new Set(matches.filter(alias => alias.name.length === longest).map(alias => alias.id));
    return { speaker: ids.size === 1 ? [...ids][0] : null, instruction: step.instruction };
  });
  // A numbered list without speaker labels is ordinary briefing prose.
  if (!turns.some(turn => turn.speaker)) return { turns: null, reason: null };
  if (turns.some(turn => !turn.speaker) || steps.some((step, index) => step.number !== index + 1)) {
    return { turns: null, reason: 'number each discussion turn from 1 and start it with Host, Special guest or an unambiguous participant name' };
  }
  if (cast.some(persona => !turns.some(turn => turn.speaker === persona.id))) {
    return { turns: null, reason: 'the numbered discussion steps must include every selected participant' };
  }
  return { turns: turns as DiscussionTurn[], reason: null };
}
