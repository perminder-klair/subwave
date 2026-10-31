// Explicit prompt directives only; prose mentions and fenced examples do not invite speakers.
import * as settings from '../settings.js';

export type PersonaIdentity = { id: string; name: string };

export function findSkillPersona(query: string): PersonaIdentity | null {
  const roster = settings.get().personas || [];
  const exact = roster.find(persona => persona.id === query);
  const matches = exact ? [exact] : roster.filter(persona => persona.name.trim().toLowerCase() === query.trim().toLowerCase());
  return matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null;
}

export function promptInstructionLines(brief: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of brief.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    lines.push(line);
  }
  return lines;
}

export function specialGuestNames(brief: string): string[] {
  return promptInstructionLines(brief).flatMap(line => {
    const match = line.match(/^[ \t]*Special guest:[ \t]*(.*?)[ \t]*$/i);
    return match ? [match[1]] : [];
  });
}
