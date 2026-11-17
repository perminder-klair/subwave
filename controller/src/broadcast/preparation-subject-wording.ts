// The words a model is given for an episode preparation that has no grounding
// (#2321). One wording, shared by the plan brief (show-preparation.ts) and the
// greeting and intro prompts, so the plan can't be told one thing and the
// opening another. Pure: the prompt modules import it without pulling in the
// preparation store.

// The skill chose a subject, but the catalogue never loaded: the music is not
// restricted to it and nothing verified backs it, so it is named and nothing
// more. "Episode", never "hour": a show can run several.
export function namedSubjectLine(subject: string): string {
  return `This episode's subject is ${JSON.stringify(subject)}: name it, but state no facts about it or about what will play.`;
}

// The preparation tool failed for good: no subject was chosen, so a model given
// only the show's name must not pick one for it.
export const NO_SUBJECT_LINE = "This episode's preparation chose no subject: name no specific artist, record or person as its subject, and state no facts about what will play.";
