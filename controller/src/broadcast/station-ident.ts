import { normalizeForDisplay } from '../audio/speech-text.js';

type IdentPersona = { id: string; identMode?: string; identLines?: string[] };

// Verbatim idents keep their rotation per persona, across show changes.
// Compare the once-cleaned queue text, but hand the queue the raw authored line.
export function createStationIdPicker(random = Math.random) {
  const previous = new Map<string, string>();
  const inFlight = new Map<string, string>();
  const linesFor = (persona?: IdentPersona | null) => {
    const lines = new Map<string, string>();
    if (persona?.identMode !== 'verbatim' || !Array.isArray(persona.identLines)) return lines;
    for (const line of persona.identLines) {
      if (typeof line !== 'string') continue;
      const raw = line.trim();
      const text = normalizeForDisplay(raw);
      if (text && !lines.has(text)) lines.set(text, raw);
    }
    return lines;
  };
  const pick = (persona?: IdentPersona | null): string | null => {
    const lines = linesFor(persona);
    if (!lines.size || !persona) return null;
    const texts = [...lines.keys()];
    const eligible = lines.size > 1
      ? texts.filter(text => text !== previous.get(persona.id))
      : texts;
    const unreserved = eligible.filter(text => text !== inFlight.get(persona.id));
    // With two lines both can be excluded. Prefer avoiding the last accepted
    // line, without waiting for a render that may never finish.
    const candidates = unreserved.length ? unreserved : eligible;
    const text = candidates.length === 1
      ? candidates[0]
      : candidates[Math.floor(random() * candidates.length)];
    inFlight.set(persona.id, text);
    return lines.get(text)!;
  };
  pick.hasLines = (persona?: IdentPersona | null) => linesFor(persona).size > 0;
  pick.commit = (personaId: string, line: string) => {
    const text = normalizeForDisplay(line);
    previous.set(personaId, text);
    if (inFlight.get(personaId) === text) inFlight.delete(personaId);
  };
  return pick;
}
